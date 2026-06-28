import fs from 'fs';
import path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

// ── Zod schemas (single source of truth for both types and runtime validation) ─

const EnterprisePolicyRuleSchema = z.object({
  id:          z.string().min(1),
  name:        z.string(),
  description: z.string(),
  action:      z.enum(['block', 'warn', 'pass']),
  reason:      z.string(),
  conditions:  z.object({
    files:        z.array(z.string()).optional(),
    commands:     z.array(z.string()).optional(),
    actorType:    z.enum(['ai', 'human', 'all']).optional(),
    daysOfWeek:   z.array(z.number().int().min(0).max(6)).optional(),
    hourWindow:   z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(24)]).optional(),
    services:     z.array(z.string()).optional(),
    /** e.g. ['production', 'prod'] — only enforce this rule in matching environments */
    environments: z.array(z.string()).optional(),
    /** e.g. ['acme/payments-api'] — only enforce in matching repos (owner/repo or bare name) */
    repos:        z.array(z.string()).optional(),
    /** e.g. ['claude-alice', 'ci-bot'] — only enforce for these registered agent IDs */
    agentIds:     z.array(z.string()).optional(),
  }),
});

const EnterprisePolicyConfigSchema = z.object({
  enabled: z.boolean(),
  rules:   z.array(EnterprisePolicyRuleSchema),
});

export type EnterprisePolicyRule   = z.infer<typeof EnterprisePolicyRuleSchema>;
export type EnterprisePolicyConfig = z.infer<typeof EnterprisePolicyConfigSchema>;

export const ENTERPRISE_POLICY_FILE = path.join(DATA_DIR, 'enterprise-policy.json');
export const ENTERPRISE_POLICY_SIG_FILE = ENTERPRISE_POLICY_FILE + '.sig';

// ── Policy file integrity (HMAC-SHA256 sidecar, same model as bypass file) ────
// Set from index.ts alongside setBypassSecret so both files share the same key.
let _policySigningSecret = '';
export function setPolicySigningSecret(secret: string): void {
  _policySigningSecret = secret;
}
function _signPolicyPayload(content: string): string {
  return createHmac('sha256', _policySigningSecret).update(content).digest('hex');
}

export const DEFAULT_ENTERPRISE_POLICY: EnterprisePolicyConfig = {
  enabled: true,
  rules: [
    // ── Local gate: destructive command patterns (block immediately) ───────────
    {
      id: 'block_destructive_commands',
      name: 'Block destructive terminal commands',
      description: 'Synchronously block tool calls containing known destructive patterns before they reach the handler',
      action: 'block',
      reason: 'Local Gate: Destructive command pattern matched. This action was blocked before execution.',
      conditions: {
        commands: [
          'rm -rf', 'rmdir /s', 'format c:',
          'drop table', 'drop database', 'truncate table',
          'delete from',
          'terraform destroy', 'kubectl delete', 'aws s3 rm', 's3 rm',
          'destroy', 'nuke', 'wipe',
        ],
      },
    },
    // ── Local gate: schema / migration mutations (hold for HITL) ─────────────
    {
      id: 'hold_schema_mutations',
      name: 'Hold schema migration commands for HITL review',
      description: 'Pause tool calls that propose schema changes and wait for operator approval',
      action: 'warn',
      reason: 'Local Gate: Schema mutation detected. Waiting for operator approval via HITL webhook.',
      conditions: {
        commands: [
          'alter table', 'add column', 'drop column', 'rename column',
          'create index', 'drop index',
          'db:migrate', 'prisma migrate', 'knex migrate',
        ],
        actorType: 'ai',
      },
    },
    // ── Enterprise: auth changes during Friday settlement window ──────────────
    {
      id: 'policy_auth_batch_window',
      name: 'Block AI Auth changes during Friday batch window',
      description: 'Block all rollouts touching auth during batch windows only if caller is an AI',
      action: 'block',
      reason: 'Enterprise Custom Policy: Authentication changes are restricted during the Friday batch settlement window (12:00 - 24:00 UTC) for autonomous agents.',
      conditions: {
        files: ['auth', 'login', 'jwt', 'middleware'],
        actorType: 'ai',
        daysOfWeek: [5], // Friday
        hourWindow: [12, 24],
      },
    },
    // ── Enterprise: database migrations by humans ─────────────────────────────
    {
      id: 'policy_prod_database_warn',
      name: 'Warn on database migrations by humans',
      description: 'Warn when humans deploy database migrations directly',
      action: 'warn',
      reason: 'Enterprise Custom Policy: Direct database migrations should ideally be run via automated pipelines rather than individual developer scripts.',
      conditions: {
        files: ['migration', 'schema.sql'],
        actorType: 'human',
      },
    },
  ],
};

let _cachedConfig: EnterprisePolicyConfig | null = null;

export function loadEnterprisePolicy(force = false): EnterprisePolicyConfig {
  if (_cachedConfig && !force) return _cachedConfig;

  if (!fs.existsSync(ENTERPRISE_POLICY_FILE)) {
    if (!zeroRetentionMode()) {
      try {
        fs.mkdirSync(path.dirname(ENTERPRISE_POLICY_FILE), { recursive: true });
        fs.writeFileSync(ENTERPRISE_POLICY_FILE, JSON.stringify(DEFAULT_ENTERPRISE_POLICY, null, 2), 'utf8');
        logger.info({ path: ENTERPRISE_POLICY_FILE }, 'policy-engine: created default enterprise-policy.json');
      } catch (err) {
        logger.warn({ err }, 'policy-engine: failed to write default enterprise policy');
      }
    }
    _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
    _watchPolicyFile();
    return _cachedConfig;
  }

  try {
    const raw  = fs.readFileSync(ENTERPRISE_POLICY_FILE, 'utf8');

    // Verify HMAC signature when the signing secret is set and a sig file exists.
    if (_policySigningSecret && fs.existsSync(ENTERPRISE_POLICY_SIG_FILE)) {
      const storedSig  = fs.readFileSync(ENTERPRISE_POLICY_SIG_FILE, 'utf8').trim();
      const expected   = _signPolicyPayload(raw);
      const storedBuf  = Buffer.from(storedSig,  'hex');
      const expectBuf  = Buffer.from(expected,   'hex');
      const valid = storedBuf.length === expectBuf.length && timingSafeEqual(storedBuf, expectBuf);
      if (!valid) {
        logger.error(
          { path: ENTERPRISE_POLICY_FILE },
          'policy-engine: enterprise-policy.json HMAC mismatch — file may have been tampered with. Using defaults.',
        );
        _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
        _watchPolicyFile();
        return _cachedConfig;
      }
    }

    const json = JSON.parse(raw);
    const result = EnterprisePolicyConfigSchema.safeParse(json);
    if (result.success) {
      _cachedConfig = result.data;
    } else {
      logger.warn({ issues: result.error.issues }, 'policy-engine: enterprise-policy.json failed schema validation — using defaults');
      _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
    }
  } catch (err) {
    logger.warn({ err }, 'policy-engine: failed to load enterprise policy — using defaults');
    _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
  }
  _watchPolicyFile();
  return _cachedConfig;
}

export function saveEnterprisePolicy(config: EnterprisePolicyConfig): void {
  const result = EnterprisePolicyConfigSchema.safeParse(config);
  if (!result.success) throw new Error(`Invalid policy: ${JSON.stringify(result.error.issues)}`);
  const content = JSON.stringify(result.data, null, 2);
  const tmp = ENTERPRISE_POLICY_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(ENTERPRISE_POLICY_FILE), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, ENTERPRISE_POLICY_FILE);
    if (_policySigningSecret) {
      const sig = _signPolicyPayload(content);
      const sigTmp = ENTERPRISE_POLICY_SIG_FILE + '.tmp';
      fs.writeFileSync(sigTmp, sig, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(sigTmp, ENTERPRISE_POLICY_SIG_FILE);
    }
    _cachedConfig = result.data;
    logger.info({ path: ENTERPRISE_POLICY_FILE }, 'policy-engine: enterprise policy saved');
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export interface GateCoverageSummary {
  hardBlocks: string[];
  humanReviewRequired: string[];
  totalPatterns: number;
}

/** Returns a human-readable summary of what the active policy gate will block or hold. */
export function getGateCoverageSummary(): GateCoverageSummary {
  const policy = loadEnterprisePolicy();
  const hardBlocks: string[] = [];
  const humanReviewRequired: string[] = [];
  let totalPatterns = 0;

  for (const rule of policy.rules) {
    const patterns = rule.conditions.commands ?? [];
    totalPatterns += patterns.length;
    if (rule.action === 'block') {
      hardBlocks.push(rule.name);
    } else if (rule.action === 'warn') {
      humanReviewRequired.push(rule.name);
    }
  }

  return { hardBlocks, humanReviewRequired, totalPatterns };
}

/** Test-only: force the default policy into the cache without touching disk. */
export function _resetPolicyCacheForTesting(overrideConfig?: EnterprisePolicyConfig): void {
  _cachedConfig = overrideConfig ?? DEFAULT_ENTERPRISE_POLICY;
}

let _watcherStarted = false;

function _watchPolicyFile(): void {
  if (_watcherStarted || zeroRetentionMode()) return;
  _watcherStarted = true;
  try {
    fs.watchFile(ENTERPRISE_POLICY_FILE, { interval: 5_000, persistent: false }, () => {
      _cachedConfig = null;
      logger.info('policy-engine: enterprise-policy.json changed — reloading on next evaluation');
    });
  } catch {
    // watchFile fails if the path's parent directory doesn't exist yet; safe to ignore
  }
}

// Known AI actor tokens — matched at word boundaries to prevent substring false-positives.
// e.g. "humanbot_ops" would match 'bot' without boundary guards.
const AI_ACTOR_PATTERNS = [/\bbot\b/, /\bclaude\b/, /\bcursor\b/, /\bagent\b/, /\bai\b/, /\bgithub-actions\b/, /\bwindsurf\b/, /\bcopilot\b/];

// Explicitly trusted human actors — loaded once from MERGEN_TRUSTED_HUMANS env var
// (comma-separated list, e.g. "alice,bob,on-call-eng").
// Unknown actors default to AI (fail-secure) so new agent tools don't silently bypass rules.
const _trustedHumans: Set<string> = new Set(
  (process.env.MERGEN_TRUSTED_HUMANS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function isAiActor(actorName: string): boolean {
  if (!actorName) return true; // unknown actor → treat as AI (fail-secure)
  const name = actorName.toLowerCase();
  // Explicitly whitelisted human → not AI
  if (_trustedHumans.has(name)) return false;
  // Name matches a known human pattern → not AI
  if (name === 'human' || name.startsWith('human_') || name.startsWith('human-')) return false;
  // Name matches a known AI pattern → AI
  if (AI_ACTOR_PATTERNS.some((re) => re.test(name))) return true;
  // Unknown → default to AI (fail-secure: unknown callers get AI restrictions applied)
  return true;
}

export interface EvaluationInput {
  files: string[];
  /** Tool name + serialized args — checked against conditions.commands patterns. */
  commands?: string[];
  actor: string;
  service: string;
  timestamp?: number;
  /** e.g. 'production', 'staging', 'dev' — matched against conditions.environments */
  environment?: string;
  /** e.g. 'acme/payments-api' — matched against conditions.repos */
  repo?: string;
  /** Registered agent ID (e.g. 'claude-alice') — matched against conditions.agentIds */
  agentId?: string;
}

export interface PolicyEvaluationResult {
  verdict: 'pass' | 'warn' | 'block';
  triggeredRules: string[];
  reasons: string[];
}

/**
 * Match a single policy pattern against a command haystack.
 *
 * Multi-word patterns (e.g. "terraform destroy", "drop table") are already
 * specific enough to use plain substring matching — collateral matches are
 * extremely unlikely in practice.
 *
 * Single-word patterns (e.g. "destroy", "nuke", "wipe") are matched with word
 * boundaries (\b) so they don't fire on compound identifiers like
 * "destroy_reason", "destroy-session", or JSON keys containing the word.
 *
 * Escaped for regex safety: chars that are special in RegExp (e.g. `*`, `.`,
 * `+`) are escaped before the pattern is compiled.
 */
/**
 * Normalize a command string to defeat common obfuscation techniques before
 * pattern matching:
 *   - NFKC unicode normalization catches lookalike characters (Cyrillic 'о' → 'o')
 *   - Single-quote stripping removes shell no-op quoting (dr'o'p → drop)
 *   - Backslash-escape collapsing removes literal escapes (ta\ble → table)
 *   - Whitespace collapsing catches double-space separators (drop  table → drop table)
 */
function _normalizeForMatching(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/'([^']*)'/g, '$1')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Natural-language synonyms LLMs commonly generate for destructive operations.
// Each entry maps a phrase regex → canonical blocked token so existing rules catch it.
const SEMANTIC_EQUIVALENTS: Array<[pattern: RegExp, canonical: string]> = [
  [/\bblow\s+away\b/,        'terraform destroy'],
  [/\btear\s+down\b/,        'terraform destroy'],
  [/\brip\s+out\b/,          'destroy'],
  [/\bobliterate\b/,         'destroy'],
  [/\bwipe\s+clean\b/,       'truncate table'],
  [/\bzero\s+out\b/,         'truncate table'],
  [/\berase\s+all\b/,        'delete from'],
  [/\bremove\s+all\b/,       'delete from'],
  [/\bclear\s+all\b/,        'delete from'],
  [/\bpurge\s+all\b/,        'truncate table'],
  [/\bwipe\s+the\s+database\b/, 'drop database'],
  [/\bwipe\s+the\s+cluster\b/,  'kubectl delete'],
  [/\bnuke\s+the\b/,         'terraform destroy'],
];

function _expandSemanticEquivalents(normalized: string): string {
  let expanded = normalized;
  for (const [pattern, canonical] of SEMANTIC_EQUIVALENTS) {
    if (pattern.test(normalized)) {
      expanded += ' ' + canonical;
    }
  }
  return expanded;
}

function matchesCommandPattern(haystack: string, pattern: string): boolean {
  const normalized = _expandSemanticEquivalents(_normalizeForMatching(haystack));
  const lower = pattern.toLowerCase();
  if (lower.includes(' ')) {
    return normalized.includes(lower);
  }
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(normalized);
}

export function evaluateEnterprisePolicy(input: EvaluationInput, policyOverride?: EnterprisePolicyConfig): PolicyEvaluationResult {
  const config = policyOverride ?? loadEnterprisePolicy();
  const result: PolicyEvaluationResult = {
    verdict: 'pass',
    triggeredRules: [],
    reasons: [],
  };

  if (!config.enabled) {
    return result;
  }

  const { files, commands = [], actor, service, timestamp = Date.now(), environment, repo, agentId } = input;
  const isAi = isAiActor(actor);
  const date = new Date(timestamp);
  const dayOfWeek = date.getUTCDay();
  const hourOfDay = date.getUTCHours();

  for (const rule of config.rules) {
    const cond = rule.conditions;
    let fileMatched    = true;
    let commandMatched = true;
    let actorMatched   = true;
    let dayMatched     = true;
    let hourMatched    = true;
    let serviceMatched = true;
    let envMatched     = true;
    let repoMatched    = true;
    let agentMatched   = true;

    // 1. Files Condition
    if (cond.files && cond.files.length > 0) {
      fileMatched = files.some(file =>
        cond.files!.some(pattern => file.toLowerCase().includes(pattern.toLowerCase()))
      );
    }

    // 2. Commands Condition — word-boundary match for single-word patterns,
    //    substring match for multi-word patterns (already precise enough).
    //    _normalizeForMatching is applied inside matchesCommandPattern.
    if (cond.commands && cond.commands.length > 0) {
      const haystack = commands.join(' ');
      commandMatched = cond.commands.some(pattern => matchesCommandPattern(haystack, pattern));
    }

    // 3. Actor Type Condition
    if (cond.actorType && cond.actorType !== 'all') {
      if (cond.actorType === 'ai') {
        actorMatched = isAi;
      } else if (cond.actorType === 'human') {
        actorMatched = !isAi;
      }
    }

    // 4. Day of Week Condition
    if (cond.daysOfWeek && cond.daysOfWeek.length > 0) {
      dayMatched = cond.daysOfWeek.includes(dayOfWeek);
    }

    // 5. Hour Window Condition
    if (cond.hourWindow) {
      const [start, end] = cond.hourWindow;
      // Handle windows wrapping around midnight, e.g., 22 to 6
      if (start <= end) {
        hourMatched = hourOfDay >= start && hourOfDay < end;
      } else {
        hourMatched = hourOfDay >= start || hourOfDay < end;
      }
    }

    // 6. Services Condition
    if (cond.services && cond.services.length > 0) {
      serviceMatched = cond.services.some(s => s.toLowerCase() === service.toLowerCase());
    }

    // 7. Environment Condition — rule only fires in matching environments
    if (cond.environments && cond.environments.length > 0) {
      envMatched = environment
        ? cond.environments.some(e => e.toLowerCase() === environment.toLowerCase())
        : false; // no environment provided → rule doesn't apply
    }

    // 8. Repo Condition — rule only fires in matching repos
    if (cond.repos && cond.repos.length > 0) {
      repoMatched = repo
        ? cond.repos.some(r => repo.toLowerCase().endsWith(r.toLowerCase()))
        : false;
    }

    // 9. Agent ID Condition — rule only fires for specific registered agents
    if (cond.agentIds && cond.agentIds.length > 0) {
      agentMatched = agentId
        ? cond.agentIds.some(a => a.toLowerCase() === agentId.toLowerCase())
        : false;
    }

    if (fileMatched && commandMatched && actorMatched && dayMatched && hourMatched && serviceMatched && envMatched && repoMatched && agentMatched) {
      result.triggeredRules.push(rule.id);
      result.reasons.push(rule.reason);
      
      // Upgrade verdict severity if needed: block > warn > pass
      if (rule.action === 'block') {
        result.verdict = 'block';
      } else if (rule.action === 'warn' && result.verdict !== 'block') {
        result.verdict = 'warn';
      }
    }
  }

  return result;
}
