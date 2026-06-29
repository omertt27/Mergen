/**
 * shadow-log.ts — Records what Mergen would have done but didn't.
 *
 * Shadow mode is the trust-building path to autonomous execution. When an
 * engineer sees 30 days of "Mergen would have run X, and that would have been
 * correct 89% of the time", flipping MERGEN_AUTOPILOT_LEVEL=restarts is a
 * data-driven decision rather than a leap of faith.
 *
 * A shadow entry is written whenever Mergen completes a causal analysis but
 * does not execute: because autopilot is disabled, because remediation
 * confidence is below threshold, or because the override corpus blocked it.
 *
 * Engineers can annotate shadow entries via POST /shadow-report/:id/verdict:
 *   would-approve  → "I would have let this run"
 *   would-override → "I would have stopped it" → creates an override corpus entry
 *
 * The approval rate across annotated entries is the track record number.
 * GET /shadow-report surfaces it with a recommendation to enable autopilot.
 * GET /shadow-report/slack-digest returns a pre-formatted Slack block for
 * weekly digest posting — lives where SREs already are.
 *
 * Storage: ~/.mergen/shadow-log.json (bounded ring, 500 entries)
 */

import fs from 'fs';
import { lockAndExecute } from '../sensor/file-lock.js';
import { randomUUID } from 'crypto';
import { SHADOW_LOG_FILE, DATA_DIR } from '../sensor/paths.js';
import { recordOverride } from './override-corpus.js';
import logger from '../sensor/logger.js';
import type { OverrideReason } from './override-corpus.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ShadowSkipReason =
  | 'autopilot-disabled'         // MERGEN_AUTOPILOT not set
  | 'confidence-below-threshold' // overall confidence < 85%
  | 'remediation-below-threshold' // diagnosisScore ok but remediationConfidence < 85%
  | 'override-corpus'            // override corpus found a matching prior override
  | 'no-command'                 // no executable command in fixHint
  | 'level-restricted'           // command tier exceeds MERGEN_AUTOPILOT_LEVEL
  | 'planning-gate'              // deterministic planning gate denied execution
  | 'track-record-pause'        // too many recent wrong verdicts
  | 'executed'                   // Autopilot successfully executed
  | 'executed-failure'           // Autopilot executed but command failed
  | 'blocked-by-safety-filter'   // Autopilot command blocked by safety filters
  | 'denied';                    // Execution denied by human via Slack gate

export type HumanVerdict = 'would-approve' | 'would-override';

export interface ShadowEntry {
  id: string;
  /** Links to the calibration PredictionRecord — same pid. */
  pid: string;
  incidentTag: string;
  service: string;
  /** The command that would have been executed. Null when skipped for no-command. */
  command: string | null;
  diagnosisConfidence: number;
  /** The confidence value that was actually gated against the 85% threshold. */
  remediationConfidence: number;
  /** True when confidence met threshold — blocked only by corpus or track record. */
  wouldHaveExecuted: boolean;
  skipReason: ShadowSkipReason;
  /** When the originating PagerDuty alert fired — used to compute autonomous MTTR. */
  firedAt?: number;
  recordedAt: number;
  // Filled in after human review via POST /shadow-report/:id/verdict
  humanVerdict?: HumanVerdict;
  humanNote?: string;
  verdictAt?: number;
  /** Set when humanVerdict is 'would-override' — links to the created corpus entry. */
  overrideId?: string;
  /** ID of the pre-approved runbook used instead of an LLM-generated command, if any. */
  runbookId?: string;
}

interface ShadowFile {
  version: 1;
  entries: ShadowEntry[];
}

// ── Storage ──────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;

let _entries: ShadowEntry[] = [];
let _loaded = false;

function load(force = false): void {
  if (_loaded && !force) return;
  if (!fs.existsSync(SHADOW_LOG_FILE)) { _entries = []; _loaded = true; return; }
  try {
    const raw = fs.readFileSync(SHADOW_LOG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as ShadowFile;
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      _entries = parsed.entries.slice(-MAX_ENTRIES);
    } else {
      _entries = [];
    }
    _loaded = true;
  } catch (err) {
    logger.warn({ err }, 'shadow-log: failed to load — starting fresh');
    _entries = [];
    _loaded = true;
  }
}

let _tmpCounter = 0;

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: ShadowFile = { version: 1, entries: _entries };
    _tmpCounter = (_tmpCounter + 1) >>> 0;
    const tmp = `${SHADOW_LOG_FILE}.tmp.${process.pid}.${Date.now().toString(36)}.${_tmpCounter.toString(36)}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, SHADOW_LOG_FILE);
  } catch (err) {
    logger.warn({ err }, 'shadow-log: failed to persist');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function recordShadow(input: Omit<ShadowEntry, 'id' | 'recordedAt'> & { id?: string }): ShadowEntry {
  const entry: ShadowEntry = {
    ...input,
    id: input.id ?? randomUUID(),
    recordedAt: Date.now(),
  };

  return lockAndExecute(`${SHADOW_LOG_FILE}.lock`, () => {
    load(true);
    _entries.push(entry);
    if (_entries.length > MAX_ENTRIES) _entries = _entries.slice(-MAX_ENTRIES);
    persist();
    logger.info(
      { id: entry.id, tag: entry.incidentTag, skip: entry.skipReason, wouldRun: entry.wouldHaveExecuted },
      'shadow-log: entry recorded',
    );
    return entry;
  });
}

/**
 * Record a human verdict on a shadow entry.
 * When verdict is 'would-override', also creates an override corpus entry so
 * the corpus learns from the human review without requiring a separate POST /overrides call.
 */
export function recordShadowVerdict(
  id: string,
  verdict: HumanVerdict,
  opts: {
    note?: string;
    overrideReason?: OverrideReason;
    manualAction?: string;
    actor?: string;
  } = {},
): { found: false } | { found: true; entry: ShadowEntry; overrideId?: string } {
  return lockAndExecute(`${SHADOW_LOG_FILE}.lock`, () => {
    load(true);
    const entry = _entries.find((e) => e.id === id);
    if (!entry) return { found: false };

    entry.humanVerdict = verdict;
    entry.verdictAt = Date.now();
    if (opts.note) entry.humanNote = opts.note.slice(0, 200);

    let overrideId: string | undefined;
    if (verdict === 'would-override' && entry.command) {
      const ov = recordOverride({
        incidentTag: entry.incidentTag,
        proposedCommand: entry.command,
        overrideReason: opts.overrideReason ?? 'on-call-discretion',
        note: opts.note,
        service: entry.service,
        environment: 'production',
        manualAction: opts.manualAction,
        actor: opts.actor ?? 'shadow-review',
      });
      overrideId = ov.id;
      entry.overrideId = ov.id;
    }

    persist();
    return { found: true, entry, overrideId };
  });
}

/** Update the skipReason of an existing shadow entry by its PID. */
export function updateShadowReasonByPid(pid: string, skipReason: ShadowSkipReason): void {
  lockAndExecute(`${SHADOW_LOG_FILE}.lock`, () => {
    load(true);
    const entry = _entries.find((e) => e.pid === pid);
    if (entry) {
      entry.skipReason = skipReason;
      persist();
      logger.info({ pid, skipReason }, 'shadow-log: entry updated by pid');
    }
  });
}

/** All shadow entries, oldest first. */
export function getShadowLog(): readonly ShadowEntry[] {
  load(true);
  return _entries;
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface ShadowReport {
  windowDays: number;
  total: number;
  wouldHaveExecuted: number;
  skippedByLowConfidence: number;
  skippedByOverrideCorpus: number;
  skippedNoCommand: number;
  humanReviewed: number;
  humanApproved: number;
  humanOverrode: number;
  /** null when fewer than 3 human-reviewed entries — too noisy. */
  approvalRate: number | null;
  /** Actionable recommendation based on the approval rate. */
  recommendation: string;
}

export function getShadowReport(windowDays = 30): ShadowReport {
  load();
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const window = _entries.filter((e) => e.recordedAt >= cutoff);

  const wouldHaveExecuted = window.filter((e) => e.wouldHaveExecuted).length;
  const skippedByLowConfidence = window.filter(
    (e) => e.skipReason === 'confidence-below-threshold' || e.skipReason === 'remediation-below-threshold',
  ).length;
  const skippedByOverrideCorpus = window.filter((e) => e.skipReason === 'override-corpus').length;
  const skippedNoCommand = window.filter((e) => e.skipReason === 'no-command').length;

  const reviewed = window.filter((e) => e.humanVerdict !== undefined);
  const approved = reviewed.filter((e) => e.humanVerdict === 'would-approve').length;
  const overrode = reviewed.filter((e) => e.humanVerdict === 'would-override').length;

  const approvalRate = reviewed.length >= 3 ? approved / reviewed.length : null;

  let recommendation: string;
  if (window.length === 0) {
    recommendation = 'No shadow entries yet. Enable MERGEN_SHADOW_MODE=true to start collecting recommendations.';
  } else if (approvalRate === null) {
    recommendation = `${reviewed.length} of ${window.length} entries reviewed. Review more shadow entries to get a reliable approval rate.`;
  } else if (approvalRate >= 0.85) {
    recommendation = `${Math.round(approvalRate * 100)}% approval rate over ${windowDays} days. Consider enabling MERGEN_AUTOPILOT_LEVEL=restarts.`;
  } else if (approvalRate >= 0.70) {
    recommendation = `${Math.round(approvalRate * 100)}% approval rate. Review override reasons before enabling autopilot — some patterns may need corpus entries.`;
  } else {
    recommendation = `${Math.round(approvalRate * 100)}% approval rate — below threshold. Review wrong recommendations and add override corpus entries for recurring patterns.`;
  }

  return {
    windowDays,
    total: window.length,
    wouldHaveExecuted,
    skippedByLowConfidence,
    skippedByOverrideCorpus,
    skippedNoCommand,
    humanReviewed: reviewed.length,
    humanApproved: approved,
    humanOverrode: overrode,
    approvalRate,
    recommendation,
  };
}

/** Pre-formatted Slack block for a weekly digest message. */
export function getShadowSlackDigest(windowDays = 7): object {
  load();
  const report = getShadowReport(windowDays);
  const ratePct = report.approvalRate !== null ? `${Math.round(report.approvalRate * 100)}%` : 'n/a';
  const reviewedNote = report.humanReviewed > 0
    ? ` | ${report.humanApproved} approved / ${report.humanOverrode} overrode`
    : '';

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const pending = _entries
    .filter((e) => e.recordedAt >= cutoff && e.wouldHaveExecuted && e.humanVerdict === undefined)
    .slice(-5)
    .reverse();

  const entryBlocks: unknown[] = pending.flatMap((e) => {
    const diagPct = Math.round(e.diagnosisConfidence * 100);
    const remPct  = Math.round(e.remediationConfidence * 100);
    const cmd     = e.command ? `\`${e.command}\`` : '_no command_';
    return [
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${e.service}* · \`${e.incidentTag}\`\nDiagnosis: ${diagPct}% · Remediation: ${remPct}%\nWould have run: ${cmd}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '👍 Would approve', emoji: true },
            action_id: `digest_approve_${e.id}`,
            value: JSON.stringify({ id: e.id }),
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✋ Would override', emoji: true },
            action_id: `digest_override_${e.id}`,
            value: JSON.stringify({ id: e.id }),
            style: 'danger',
          },
        ],
      },
    ];
  });

  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔍 Mergen Shadow Mode — Weekly Summary' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Recommendations (${windowDays}d)*\n${report.total}` },
          { type: 'mrkdwn', text: `*Would-execute (high confidence)*\n${report.wouldHaveExecuted}` },
          { type: 'mrkdwn', text: `*Human approval rate*\n${ratePct}${reviewedNote}` },
          { type: 'mrkdwn', text: `*Override corpus blocks*\n${report.skippedByOverrideCorpus}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Next step:* ${report.recommendation}` },
      },
      ...(pending.length > 0 ? [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${pending.length} pending review${pending.length > 1 ? 's' : ''}* — click below to calibrate:` },
        },
        ...entryBlocks,
      ] : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View full shadow report' },
            url: 'http://127.0.0.1:3000/shadow-report',
          },
        ],
      },
    ],
  };
}

/** CSV export of the full shadow log for fundraising / board decks. */
export function exportShadowCsv(): string {
  load();
  const header = 'id,pid,incidentTag,service,command,diagnosisConfidence,remediationConfidence,wouldHaveExecuted,skipReason,recordedAt,humanVerdict,verdictAt,humanNote';
  const escape = (v: string): string => {
    if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const rows = _entries.map((e) => [
    e.id,
    e.pid,
    e.incidentTag,
    e.service,
    e.command ?? '',
    e.diagnosisConfidence,
    e.remediationConfidence,
    e.wouldHaveExecuted ? 'true' : 'false',
    e.skipReason,
    new Date(e.recordedAt).toISOString(),
    e.humanVerdict ?? '',
    e.verdictAt ? new Date(e.verdictAt).toISOString() : '',
    e.humanNote ?? '',
  ].map((c) => escape(String(c))).join(','));

  return [header, ...rows].join('\n') + (rows.length > 0 ? '\n' : '');
}
