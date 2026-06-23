import fs from 'fs';
import path from 'path';
import { DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

export interface EnterprisePolicyRule {
  id: string;
  name: string;
  description: string;
  action: 'block' | 'warn' | 'pass';
  reason: string;
  conditions: {
    files?: string[];                  // substring match on filenames / tool names
    commands?: string[];               // substring match on tool name + command args
    actorType?: 'ai' | 'human' | 'all';
    daysOfWeek?: number[];             // e.g. [5] for Friday
    hourWindow?: [number, number];     // e.g. [12, 18] UTC
    services?: string[];               // e.g. ["api-service"]
  };
}

export interface EnterprisePolicyConfig {
  enabled: boolean;
  rules: EnterprisePolicyRule[];
}

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
    return _cachedConfig;
  }

  try {
    const raw = fs.readFileSync(ENTERPRISE_POLICY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as EnterprisePolicyConfig;
    if (parsed && Array.isArray(parsed.rules)) {
      _cachedConfig = parsed;
    } else {
      _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
    }
  } catch (err) {
    logger.warn({ err }, 'policy-engine: failed to load enterprise policy — using defaults');
    _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
  }
  return _cachedConfig;
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

    // 2. Commands Condition — substring match against tool name + serialized args
    if (cond.commands && cond.commands.length > 0) {
      const haystack = commands.map(s => s.toLowerCase()).join(' ');
      commandMatched = cond.commands.some(pattern => haystack.includes(pattern.toLowerCase()));
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
