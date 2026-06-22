/**
 * git-adr-sync.ts — Git commit → Override Corpus ingestion.
 *
 * Scans the local git history for commit messages that encode operational
 * constraints ("never resize the pool on Fridays", "block: cache key changes
 * during settlement window") and materialises them as Override Corpus entries.
 *
 * Also converts accepted ADR records (from adrStore) that contain constraint
 * language into corpus entries — so a one-time team decision ("ADR-007: never
 * auto-scale the DB pool during batch windows") becomes policy automatically.
 *
 * Two ingestion paths:
 *   1. Git log scanner — reads `git log` from the working directory
 *   2. ADR store scanner — reads ~/.mergen/adrs.json + seed ADRs
 *
 * State: ~/.mergen/git-adr-sync.json (tracks processed SHAs)
 * Activation: MERGEN_GIT_ADR_SYNC=true
 * Cadence: once at startup + every 24h
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '../sensor/paths.js';
import { recordOverride } from './override-corpus.js';
import { adrStore } from '../sensor/adr-store.js';
import logger from '../sensor/logger.js';

const STATE_FILE = path.join(DATA_DIR, 'git-adr-sync.json');
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;

// ── Constraint signal patterns ───────────────────────────────────────────────

const CONSTRAINT_KEYWORDS = [
  'never ', "don't ", 'do not ', 'avoid ', 'block:', 'constraint:', 'decided:',
  'adr:', 'policy:', 'rule:', 'freeze', 'hold off', 'should not', 'must not',
  'compliance', 'settlement window', 'batch window', 'maintenance window',
  'we won\'t', 'not during', 'unsafe during',
];

const INCIDENT_TAG_HINTS: Array<[RegExp, string]> = [
  [/pool|connection.?limit|max.?conn/i,          'infra_db_connection_pool'],
  [/oom|out.of.memory|heap|memory.?leak/i,        'oom_kill'],
  [/rate.?limit|throttl/i,                        'rate_limit_cascade'],
  [/auth|token|session|oauth|jwt/i,               'auth_token_not_persisted'],
  [/cache|redis|memcach/i,                        'cache_invalidation'],
  [/deploy|rollout|release|image/i,               'deploy_config_drift'],
  [/cert|tls|ssl|https/i,                         'cert_expiry'],
  [/disk|storage|volume|space/i,                  'disk_pressure'],
  [/scale|replica|pod.?count|instance/i,          'infra_scaling'],
  [/migration|schema|alter.?table/i,              'db_migration_lock'],
  [/friday|settlement|batch|weekend|end.of.day/i, 'batch_window_conflict'],
];

const OVERRIDE_REASON_HINTS: Array<[RegExp, import('./override-corpus.js').OverrideReason]> = [
  [/friday|settlement|batch|weekend|end.of.day|window/i, 'batch-window'],
  [/cost|budget|billing|expensive/i,                     'cost-constraint'],
  [/cab|freeze|compliance|approval|change.control/i,     'compliance-hold'],
  [/replica|read.only|primary/i,                         'prefer-read-replica'],
  [/maintenance|scheduled|downtime/i,                    'maintenance-window'],
  [/wrong.diag|misidentif|incorrect.root/i,              'wrong-diagnosis'],
  [/wrong.fix|bad.command|revert/i,                      'wrong-fix'],
];

// ── State ────────────────────────────────────────────────────────────────────

interface SyncState {
  processedShas: string[];
  processedAdrIds: string[];
  lastSyncAt: number;
}

function loadState(): SyncState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SyncState;
    }
  } catch { /* start fresh */ }
  return { processedShas: [], processedAdrIds: [], lastSyncAt: 0 };
}

function saveState(state: SyncState): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    state.processedShas = state.processedShas.slice(-2000);
    state.processedAdrIds = state.processedAdrIds.slice(-500);
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    logger.warn({ err }, 'git-adr-sync: failed to persist state');
  }
}

// ── Extraction helpers ───────────────────────────────────────────────────────

function inferTag(text: string): string {
  for (const [pattern, tag] of INCIDENT_TAG_HINTS) {
    if (pattern.test(text)) return tag;
  }
  return 'operational_constraint';
}

function inferReason(text: string): import('./override-corpus.js').OverrideReason {
  for (const [pattern, reason] of OVERRIDE_REASON_HINTS) {
    if (pattern.test(text)) return reason;
  }
  return 'on-call-discretion';
}

function extractCommand(text: string): string {
  // Prefer backtick-quoted commands
  const backtick = text.match(/`([^`]{4,200})`/);
  if (backtick) return backtick[1]!.trim();
  // Fall back to inline shell-style lines
  const shellLine = text.split('\n').find((l) =>
    /^(kubectl|docker|systemctl|service|npm|yarn|make|helm|psql)\s/i.test(l.trim()),
  );
  if (shellLine) return shellLine.trim().slice(0, 500);
  // Generic: return first 100 chars of the constraint sentence as the "proposed command"
  return text.slice(0, 100).trim();
}

function isConstraintText(text: string): boolean {
  const lower = text.toLowerCase();
  return CONSTRAINT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Git log ingestion ────────────────────────────────────────────────────────

function scanGitLog(state: SyncState): number {
  let added = 0;
  const processed = new Set(state.processedShas);

  try {
    // Use %x1F as field separator, %x1E as record separator — safe against newlines in bodies
    const raw = execSync(
      'git log --no-merges --format=%H%x1F%s%x1F%b%x1E -n 500 2>/dev/null',
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const records = raw.split('\x1E').filter(Boolean);
    for (const record of records) {
      const [sha, subject, body = ''] = record.split('\x1F');
      if (!sha) continue;
      const cleanSha = sha.trim();
      if (processed.has(cleanSha)) continue;
      processed.add(cleanSha);

      const fullText = `${subject ?? ''}\n${body}`;
      if (!isConstraintText(fullText)) continue;

      // Find constraint sentences
      const sentences = fullText.split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
      for (const sentence of sentences) {
        if (!isConstraintText(sentence)) continue;
        const tag = inferTag(sentence);
        const reason = inferReason(sentence);
        const command = extractCommand(fullText);

        try {
          recordOverride({
            incidentTag: tag,
            proposedCommand: command,
            overrideReason: reason,
            service: 'unknown',
            environment: 'production',
            note: sentence.slice(0, 200),
            manualAction: `git commit ${cleanSha.slice(0, 8)}: ${(subject ?? '').slice(0, 100)}`,
            actor: 'git-adr-sync',
          });
          added++;
        } catch { /* non-fatal — may already exist with same props */ }
        break; // one override per commit, avoid duplicates from multiple sentences
      }
    }

    state.processedShas = [...processed];
  } catch (err) {
    // Not a git repo or git not installed — degrade gracefully
    logger.debug({ err: (err as Error).message }, 'git-adr-sync: git log unavailable');
  }

  return added;
}

// ── ADR store ingestion ──────────────────────────────────────────────────────

function syncAdrStore(state: SyncState): number {
  let added = 0;
  const processed = new Set(state.processedAdrIds);

  const adrs = adrStore.list().filter((adr) => adr.status === 'accepted');
  for (const adr of adrs) {
    if (processed.has(adr.id)) continue;
    processed.add(adr.id);

    // Combine decision + consequences + rationale into searchable text
    const fullText = [adr.decision, adr.consequences, adr.rationale].join('\n');
    if (!isConstraintText(fullText)) continue;

    const tag = inferTag(fullText);
    const reason = inferReason(fullText);
    const command = extractCommand(fullText);

    try {
      recordOverride({
        incidentTag: tag,
        proposedCommand: command,
        overrideReason: reason,
        service: 'unknown',
        environment: 'production',
        note: `${adr.id}: ${adr.title}`.slice(0, 200),
        manualAction: adr.decision.slice(0, 500),
        actor: 'adr-store-sync',
      });
      added++;
    } catch { /* non-fatal */ }
  }

  state.processedAdrIds = [...processed];
  return added;
}

// ── Main sync ────────────────────────────────────────────────────────────────

function sync(): void {
  const state = loadState();
  const gitAdded = scanGitLog(state);
  const adrAdded = syncAdrStore(state);
  state.lastSyncAt = Date.now();
  saveState(state);

  const total = gitAdded + adrAdded;
  if (total > 0) {
    logger.info({ gitAdded, adrAdded }, 'git-adr-sync: new operational constraints added to corpus');
  } else {
    logger.debug('git-adr-sync: sync complete — no new constraints found');
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export function startGitAdrSync(): void {
  logger.info('git-adr-sync: starting — scanning git history and ADR store for operational constraints');
  sync();
  setInterval(sync, POLL_INTERVAL_MS).unref();
}
