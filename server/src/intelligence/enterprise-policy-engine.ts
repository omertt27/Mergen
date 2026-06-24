import fs from 'fs';
import path from 'path';
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
    files:      z.array(z.string()).optional(),
    commands:   z.array(z.string()).optional(),
    actorType:  z.enum(['ai', 'human', 'all']).optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    hourWindow: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(24)]).optional(),
    services:   z.array(z.string()).optional(),
  }),
});

const EnterprisePolicyConfigSchema = z.object({
  enabled: z.boolean(),
  rules:   z.array(EnterprisePolicyRuleSchema),
});

export type EnterprisePolicyRule   = z.infer<typeof EnterprisePolicyRuleSchema>;
export type EnterprisePolicyConfig = z.infer<typeof EnterprisePolicyConfigSchema>;

export const ENTERPRISE_POLICY_FILE = path.join(DATA_DIR, 'enterprise-policy.json');

const DEFAULT_ENTERPRISE_POLICY: EnterprisePolicyConfig = {
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
          'terraform destroy', 'kubectl delete',
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
  const tmp = ENTERPRISE_POLICY_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(ENTERPRISE_POLICY_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(result.data, null, 2), 'utf8');
    fs.renameSync(tmp, ENTERPRISE_POLICY_FILE);
    _cachedConfig = result.data;
    logger.info({ path: ENTERPRISE_POLICY_FILE }, 'policy-engine: enterprise policy saved');
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
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

export function isAiActor(actorName: string): boolean {
  if (!actorName) return false;
  const name = actorName.toLowerCase();
  return (
    name.includes('bot') ||
    name.includes('claude') ||
    name.includes('cursor') ||
    name.includes('agent') ||
    name.includes('ai') ||
    name.includes('github-actions') ||
    name.includes('windsurf')
  );
}

export interface EvaluationInput {
  files: string[];
  /** Tool name + serialized args — checked against conditions.commands patterns. */
  commands?: string[];
  actor: string;
  service: string;
  timestamp?: number;
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
function matchesCommandPattern(haystack: string, pattern: string): boolean {
  const lower = pattern.toLowerCase();
  if (lower.includes(' ')) {
    return haystack.includes(lower);
  }
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

export function evaluateEnterprisePolicy(input: EvaluationInput): PolicyEvaluationResult {
  const config = loadEnterprisePolicy();
  const result: PolicyEvaluationResult = {
    verdict: 'pass',
    triggeredRules: [],
    reasons: [],
  };

  if (!config.enabled) {
    return result;
  }

  const { files, commands = [], actor, service, timestamp = Date.now() } = input;
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

    // 1. Files Condition
    if (cond.files && cond.files.length > 0) {
      fileMatched = files.some(file =>
        cond.files!.some(pattern => file.toLowerCase().includes(pattern.toLowerCase()))
      );
    }

    // 2. Commands Condition — word-boundary match for single-word patterns,
    //    substring match for multi-word patterns (already precise enough).
    if (cond.commands && cond.commands.length > 0) {
      const haystack = commands.map(s => s.toLowerCase()).join(' ');
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

    if (fileMatched && commandMatched && actorMatched && dayMatched && hourMatched && serviceMatched) {
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
