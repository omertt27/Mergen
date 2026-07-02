import fs from 'fs';
import path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { performance } from 'perf_hooks';
import { z } from 'zod';
import { DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';
import { normalizeForMatching } from './normalize.js';
import { getRulesForTag } from './override-corpus.js';

// ── Zod schemas (single source of truth for both types and runtime validation) ─

// Single source of truth for the `conditions` shape — previously duplicated
// inline (with drifting subsets of fields) across five routes in
// routes/policies.ts (POST /policies/rules, PATCH /policies/rules/:id,
// POST /policies/import, POST /policies/simulate, and the rules/:id/simulate
// GET route). That drift meant new rules created via some of those endpoints
// silently couldn't carry conditions the engine itself already supported —
// import this schema everywhere instead of re-declaring it.
//
// Recursive: anyOf/allOf/not let an operator compose the 12 base categories
// (e.g. "commands X OR environment Y", previously inexpressible — every
// category was implicitly ANDed with no way to OR across categories or
// negate). Every existing rule has none of these three fields, and
// matchesConditionSet's base case is byte-identical to the old flat-AND
// evaluator, so this is additive: existing rules evaluate exactly as before.
export interface EnterprisePolicyConditions {
  files?:        string[];
  commands?:     string[];
  actorType?:    'ai' | 'human' | 'all';
  daysOfWeek?:   number[];
  hourWindow?:   [number, number];
  services?:     string[];
  /** e.g. ['production', 'prod'] — only enforce this rule in matching environments */
  environments?: string[];
  /** e.g. ['acme/payments-api'] — only enforce in matching repos (owner/repo or bare name) */
  repos?:        string[];
  /** e.g. ['claude-alice', 'ci-bot'] — only enforce for these registered agent IDs */
  agentIds?:     string[];
  /**
   * Role-based scoping — only enforce for actors with one of these roles.
   * Roles are sourced from MERGEN_ACTOR_ROLES env var (format: "actor:role,actor:role")
   * or from the x-mergen-actor-role request header on API calls.
   * e.g. ['ci-bot', 'overnight-agent'] — restrict this rule to only these actor roles.
   */
  roles?:        string[];
  /**
   * Branch-scoped policies — only enforce when the current git branch matches
   * one of these glob-like patterns. Sourced from MERGEN_GIT_BRANCH env var or
   * request param. Supports '*' wildcard within a segment.
   * e.g. ['main', 'release/*', 'hotfix/*'] — stricter rules for protected branches.
   */
  branches?:     string[];
  /**
   * Explicit, operator-authored corpus check — only enforce when the override
   * corpus has at least `minOccurrences` recorded overrides for `incidentTag`
   * on this rule's matched service. Lets an operator wire "checks your team's
   * override history" into a specific rule without making every gate
   * decision implicitly depend on the corpus (see evaluateEnterprisePolicy's
   * requireCorpusMatch handling for why this stays explicit rather than
   * automatic). minOccurrences left optional here (rather than mirroring the
   * schema's runtime `.default(1)`) to keep the hand-written interface's
   * input and output shape identical — evaluateEnterprisePolicy applies the
   * same `?? 1` fallback the schema default would.
   */
  requireCorpusMatch?: { incidentTag: string; minOccurrences?: number };
  /** At least one nested ConditionSet must match (in addition to this level's own fields, which stay ANDed in). */
  anyOf?: EnterprisePolicyConditions[];
  /** Every nested ConditionSet must match (in addition to this level's own fields). */
  allOf?: EnterprisePolicyConditions[];
  /** The nested ConditionSet must NOT match (in addition to this level's own fields). */
  not?: EnterprisePolicyConditions;
}

const _baseConditionFields = {
  files:        z.array(z.string()).optional(),
  commands:     z.array(z.string()).optional(),
  actorType:    z.enum(['ai', 'human', 'all']).optional(),
  daysOfWeek:   z.array(z.number().int().min(0).max(6)).optional(),
  hourWindow:   z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(24)]).optional(),
  services:     z.array(z.string()).optional(),
  environments: z.array(z.string()).optional(),
  repos:        z.array(z.string()).optional(),
  agentIds:     z.array(z.string()).optional(),
  roles:        z.array(z.string()).optional(),
  branches:     z.array(z.string()).optional(),
  requireCorpusMatch: z.object({
    incidentTag:    z.string().min(1),
    minOccurrences: z.number().int().min(1).optional(),
  }).optional(),
};

// z.lazy() + an explicit ZodType annotation is the standard pattern for a
// recursive Zod schema — without the explicit interface, TS would try to
// infer the type from the schema itself, which for a self-referential
// z.lazy() either fails to resolve or (per this codebase's own documented
// history with deeply-inferred Zod types, see plans.ts) risks the
// TS2589 "instantiation is excessively deep" wall across every file that
// imports EnterprisePolicyRule/EnterprisePolicyConfig.
export const EnterprisePolicyConditionsSchema: z.ZodType<EnterprisePolicyConditions> = z.lazy(() =>
  z.object({
    ..._baseConditionFields,
    anyOf: z.array(EnterprisePolicyConditionsSchema).optional(),
    allOf: z.array(EnterprisePolicyConditionsSchema).optional(),
    not:   EnterprisePolicyConditionsSchema.optional(),
  }),
);

const EnterprisePolicyRuleSchema = z.object({
  id:          z.string().min(1),
  name:        z.string(),
  description: z.string(),
  action:      z.enum(['block', 'warn', 'pass']),
  reason:      z.string(),
  riskTier:    z.enum(['low', 'medium', 'high']).optional(),
  conditions:  EnterprisePolicyConditionsSchema,
});

const EnterprisePolicyConfigSchema = z.object({
  enabled: z.boolean(),
  rules:   z.array(EnterprisePolicyRuleSchema),
});

export type EnterprisePolicyRule   = z.infer<typeof EnterprisePolicyRuleSchema>;
export type EnterprisePolicyConfig = z.infer<typeof EnterprisePolicyConfigSchema>;

export const ENTERPRISE_POLICY_FILE = path.join(DATA_DIR, 'enterprise-policy.json');
export const ENTERPRISE_POLICY_SIG_FILE = ENTERPRISE_POLICY_FILE + '.sig';

// Rule IDs that are never disabled, overridden, or removed, regardless of the
// policy's top-level `enabled` flag, a remote policy-sync replace, or a
// PATCH/DELETE against the rule itself. These are the hard-safety guardrails
// that must always be active — single source of truth, imported by
// policy-sync.ts and routes/policies.ts so there is exactly one place that
// decides what "immutable" means.
export const IMMUTABLE_RULE_IDS = new Set(['block_destructive_commands']);

// ── Policy file integrity (HMAC-SHA256 sidecar, same model as bypass file) ────
// Set from index.ts alongside setBypassSecret so both files share the same key.
let _policySigningSecret = '';
export function setPolicySigningSecret(secret: string): void {
  _policySigningSecret = secret;
}
function _signPolicyPayload(content: string): string {
  return createHmac('sha256', _policySigningSecret).update(content).digest('hex');
}

function _allowUnsignedPolicy(): boolean {
  return process.env.MERGEN_ALLOW_UNSIGNED_POLICY === 'true';
}

const _DEV_NODE_ENVS = new Set(['development', 'test']);

/**
 * MERGEN_ALLOW_UNSIGNED_POLICY is a legitimate escape hatch for migrating an
 * existing unsigned enterprise-policy.json onto signing, but it removes tamper
 * evidence entirely: with it set, anyone with plain filesystem write access to
 * the policy file — no secret, no API call — can edit `enabled: false` or
 * strip block_destructive_commands and Mergen will load it unquestioned.
 *
 * Call once at startup. Outside a development/test NODE_ENV, this refuses to
 * start unless MERGEN_UNSAFE_ALLOW_UNSIGNED=true is ALSO set — a flag removing
 * a core security guarantee should never be a single accidental env var away
 * from silently active in production. Returns without effect if the unsigned
 * flag isn't set, or if running in a dev/test NODE_ENV.
 */
export function assertUnsignedPolicyFlagIsSafe(): void {
  if (!_allowUnsignedPolicy()) return;
  if (_DEV_NODE_ENVS.has(process.env.NODE_ENV ?? '')) return;

  const banner = [
    '',
    '════════════════════════════════════════════════════════════════════════',
    '  MERGEN SECURITY WARNING — MERGEN_ALLOW_UNSIGNED_POLICY=true is set',
    '════════════════════════════════════════════════════════════════════════',
    '  This disables tamper-evidence on enterprise-policy.json. Anyone with',
    '  plain filesystem write access to that file — no secret, no API call —',
    '  can silently disable enforcement (including block_destructive_commands)',
    '  and Mergen will load it unquestioned.',
    '',
    '  This flag exists to migrate an existing unsigned policy file onto',
    '  signing. It should not stay set in a running deployment.',
    '════════════════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  if (process.env.MERGEN_UNSAFE_ALLOW_UNSIGNED !== 'true') {
    console.error(banner);
    console.error(
      '  Refusing to start: set MERGEN_UNSAFE_ALLOW_UNSIGNED=true in addition to\n' +
      '  MERGEN_ALLOW_UNSIGNED_POLICY=true to confirm this is intentional, or unset\n' +
      '  MERGEN_ALLOW_UNSIGNED_POLICY once migration is complete.\n',
    );
    process.exit(1);
  }

  console.error(banner);
}

type PolicySignatureStatus = 'valid' | 'invalid' | 'unsigned-accepted' | 'unsigned-rejected' | 'not-required';

function _policySignatureStatus(raw: string, storedSig: string | null): PolicySignatureStatus {
  if (!_policySigningSecret) return 'not-required';
  if (!storedSig) return _allowUnsignedPolicy() ? 'unsigned-accepted' : 'unsigned-rejected';
  const expected  = _signPolicyPayload(raw);
  const storedBuf = Buffer.from(storedSig, 'hex');
  const expectBuf = Buffer.from(expected,  'hex');
  return storedBuf.length === expectBuf.length && timingSafeEqual(storedBuf, expectBuf)
    ? 'valid'
    : 'invalid';
}

export function _policySignatureStatusForTesting(raw: string, storedSig: string | null): PolicySignatureStatus {
  return _policySignatureStatus(raw, storedSig);
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
          // DELETE FROM without a WHERE clause = full table wipe → BLOCK.
          // DELETE FROM ... WHERE ... = targeted row deletion → HOLD (hold_agent_data_mutations).
          'delete from:no-where',
          // kubectl: block only namespace/cluster-scope cascades — routine pod/job
          // cleanup is handled by hold_agent_data_mutations below.
          'kubectl delete namespace', 'kubectl delete ns',
          'kubectl delete --all', 'kubectl delete all',
          'terraform destroy', 'aws s3 rm', 's3 rm',
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
    // ── Local gate: targeted data mutations — hold for HITL when AI actor ─────
    {
      id: 'hold_agent_data_mutations',
      name: 'Hold targeted data deletion and resource removal for HITL review',
      description: 'DELETE FROM with a WHERE clause is recoverable but still requires human sign-off. ' +
        'kubectl delete on pods/jobs/configmaps is routine maintenance but should be human-confirmed when an AI agent issues it.',
      action: 'warn',
      reason: 'Local Gate: Targeted data mutation or resource removal by AI agent. ' +
        'Waiting for operator approval — review the specific target before approving.',
      conditions: {
        commands: [
          'delete from',    // includes DELETE FROM ... WHERE ...; human-reviewed before execution
          'kubectl delete', // catches pod/job/deployment/configmap deletions by AI
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
        saveEnterprisePolicy(DEFAULT_ENTERPRISE_POLICY);
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

    // Verify HMAC signature when the signing secret is set. Missing signatures
    // fail closed unless the operator explicitly enables unsigned migration mode.
    if (_policySigningSecret) {
      const storedSig = fs.existsSync(ENTERPRISE_POLICY_SIG_FILE)
        ? fs.readFileSync(ENTERPRISE_POLICY_SIG_FILE, 'utf8').trim()
        : null;
      const sigStatus = _policySignatureStatus(raw, storedSig);
      if (sigStatus === 'invalid') {
        logger.error(
          { path: ENTERPRISE_POLICY_FILE },
          'policy-engine: enterprise-policy.json HMAC mismatch — file may have been tampered with. Using defaults.',
        );
        _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
        _watchPolicyFile();
        return _cachedConfig;
      } else if (sigStatus === 'unsigned-rejected') {
        logger.error(
          { path: ENTERPRISE_POLICY_FILE, sigPath: ENTERPRISE_POLICY_SIG_FILE },
          'policy-engine: enterprise-policy.json is unsigned while policy signing is enabled. Using defaults.',
        );
        _cachedConfig = DEFAULT_ENTERPRISE_POLICY;
        _watchPolicyFile();
        return _cachedConfig;
      } else if (sigStatus === 'unsigned-accepted') {
        logger.warn(
          { path: ENTERPRISE_POLICY_FILE },
          'policy-engine: enterprise-policy.json has no signature — accepting because MERGEN_ALLOW_UNSIGNED_POLICY=true',
        );
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

export function saveEnterprisePolicy(config: EnterprisePolicyConfig, actor = 'unknown'): void {
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
    const previous = _cachedConfig;
    _cachedConfig = result.data;
    logger.info({ path: ENTERPRISE_POLICY_FILE }, 'policy-engine: enterprise policy saved');
    // Record the change in the policy history (non-blocking, non-fatal)
    try {
      void import('../sensor/policy-history.js').then(({ recordPolicyChange }) => {
        recordPolicyChange(previous, result.data, actor);
      });
    } catch { /* history recording must never block a policy save */ }
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

// ── Actor role lookup ────────────────────────────────────────────────────────
// MERGEN_ACTOR_ROLES format: "actor1:role1,actor2:role2"
// e.g. "cursor-bot:ci-agent,overnight-claude:overnight-agent"
const _actorRoles: Map<string, string> = new Map(
  (process.env.MERGEN_ACTOR_ROLES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const idx = s.lastIndexOf(':');
      if (idx === -1) return null;
      return [s.slice(0, idx).trim().toLowerCase(), s.slice(idx + 1).trim().toLowerCase()] as [string, string];
    })
    .filter((e): e is [string, string] => e !== null),
);

function _lookupActorRole(actor: string): string | null {
  if (!actor) return null;
  return _actorRoles.get(actor.toLowerCase()) ?? null;
}

// ── Branch pattern matching ──────────────────────────────────────────────────
// Supports '*' wildcard within a single path segment (not across slashes).
// e.g. "release/*" matches "release/1.2.3" but not "release/1.2.3/hotfix"
function _matchBranchPattern(branch: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return branch.toLowerCase() === pattern.toLowerCase();
  // Convert glob pattern to regex: escape everything then un-escape '*' → [^/]*
  const reStr = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${reStr}$`).test(branch.toLowerCase());
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
  /**
   * Actor role — sourced from MERGEN_ACTOR_ROLES env var or request header.
   * Matched against conditions.roles. Format: single role string per evaluation.
   */
  actorRole?: string;
  /**
   * Current git branch — sourced from MERGEN_GIT_BRANCH env var or request param.
   * Matched against conditions.branches (supports '*' wildcard within a segment).
   */
  branch?: string;
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
  const normalized = _expandSemanticEquivalents(normalizeForMatching(haystack));

  // `:no-where` modifier — match the base pattern only when the command does
  // NOT contain a WHERE clause.  Used to distinguish a full-table DELETE FROM
  // (no WHERE → catastrophic, BLOCK) from a targeted DELETE FROM ... WHERE ...
  // (scoped → HOLD for HITL review instead of outright reject).
  if (pattern.endsWith(':no-where')) {
    const basePattern = pattern.slice(0, -':no-where'.length).toLowerCase();
    return normalized.includes(basePattern) && !/\bwhere\b/.test(normalized);
  }

  const lower = pattern.toLowerCase();
  if (lower.includes(' ')) {
    return normalized.includes(lower);
  }
  // For single-word patterns use a lookahead that requires whitespace, common
  // shell separators, or end-of-string after the keyword.  Plain \b would match
  // compound identifiers like `wipe-cache` or `destroy:dev` because `-` and `:`
  // are non-word chars that satisfy \b — causing false positives on legitimate
  // npm scripts and Makefile targets.
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?=[\\s,;|&(]|$)`).test(normalized);
}

let _lastEvalLatencyMs = 0.84;
export function getLastEvalLatencyMs(): number {
  return _lastEvalLatencyMs;
}

/** Precomputed, per-evaluation-call values matchesConditionSet needs — built
 *  once per evaluateEnterprisePolicy() call, reused across every rule and
 *  every recursive ConditionSet within a rule. */
interface MatchContext {
  files: string[];
  commands: string[];
  service: string;
  isAi: boolean;
  dayOfWeek: number;
  hourOfDay: number;
  environment?: string;
  repo?: string;
  agentId?: string;
  resolvedRole: string | null;
  resolvedBranch: string | null;
}

/**
 * Does this ConditionSet match the current call context? Base case (no
 * anyOf/allOf/not) is byte-identical to the original flat-AND-of-12
 * evaluator — every existing rule takes only this path. The recursive case
 * ANDs in anyOf (some nested set matches), allOf (every nested set matches),
 * and not (the nested set does NOT match) on top of this level's own fields,
 * letting an operator express "commands X OR environment Y" or "NOT branch Z"
 * by nesting, which the flat structure alone couldn't express.
 */
function matchesConditionSet(cond: EnterprisePolicyConditions, ctx: MatchContext): boolean {
  let fileMatched    = true;
  let commandMatched = true;
  let actorMatched   = true;
  let dayMatched     = true;
  let hourMatched    = true;
  let serviceMatched = true;
  let envMatched     = true;
  let repoMatched    = true;
  let agentMatched   = true;
  let roleMatched    = true;
  let branchMatched  = true;
  let corpusMatched  = true;

  // 1. Files Condition
  if (cond.files && cond.files.length > 0) {
    fileMatched = ctx.files.some(file =>
      cond.files!.some(pattern => file.toLowerCase().includes(pattern.toLowerCase()))
    );
  }

  // 2. Commands Condition — word-boundary match for single-word patterns,
  //    substring match for multi-word patterns (already precise enough).
  //    normalizeForMatching is applied inside matchesCommandPattern.
  if (cond.commands && cond.commands.length > 0) {
    const haystack = ctx.commands.join(' ');
    commandMatched = cond.commands.some(pattern => matchesCommandPattern(haystack, pattern));
  }

  // 3. Actor Type Condition
  if (cond.actorType && cond.actorType !== 'all') {
    if (cond.actorType === 'ai') {
      actorMatched = ctx.isAi;
    } else if (cond.actorType === 'human') {
      actorMatched = !ctx.isAi;
    }
  }

  // 4. Day of Week Condition
  if (cond.daysOfWeek && cond.daysOfWeek.length > 0) {
    dayMatched = cond.daysOfWeek.includes(ctx.dayOfWeek);
  }

  // 5. Hour Window Condition
  if (cond.hourWindow) {
    const [start, end] = cond.hourWindow;
    // Handle windows wrapping around midnight, e.g., 22 to 6
    if (start <= end) {
      hourMatched = ctx.hourOfDay >= start && ctx.hourOfDay < end;
    } else {
      hourMatched = ctx.hourOfDay >= start || ctx.hourOfDay < end;
    }
  }

  // 6. Services Condition
  if (cond.services && cond.services.length > 0) {
    serviceMatched = cond.services.some(s => s.toLowerCase() === ctx.service.toLowerCase());
  }

  // 7. Environment Condition — rule only fires in matching environments
  if (cond.environments && cond.environments.length > 0) {
    envMatched = ctx.environment
      ? cond.environments.some(e => e.toLowerCase() === ctx.environment!.toLowerCase())
      : false; // no environment provided → rule doesn't apply
  }

  // 8. Repo Condition — rule only fires in matching repos
  if (cond.repos && cond.repos.length > 0) {
    repoMatched = ctx.repo
      ? cond.repos.some(r => ctx.repo!.toLowerCase().endsWith(r.toLowerCase()))
      : false;
  }

  // 9. Agent ID Condition — rule only fires for specific registered agents
  if (cond.agentIds && cond.agentIds.length > 0) {
    agentMatched = ctx.agentId
      ? cond.agentIds.some(a => a.toLowerCase() === ctx.agentId!.toLowerCase())
      : false;
  }

  // 10. Role Condition — rule only fires for actors with a matching role
  if (cond.roles && cond.roles.length > 0) {
    roleMatched = ctx.resolvedRole
      ? cond.roles.some((r) => r.toLowerCase() === ctx.resolvedRole!.toLowerCase())
      : false; // no role → rule doesn't apply
  }

  // 11. Branch Condition — rule only fires when git branch matches a pattern
  //     Supports simple glob: '*' matches any sequence of non-slash characters.
  if (cond.branches && cond.branches.length > 0) {
    branchMatched = ctx.resolvedBranch
      ? cond.branches.some((pat) => _matchBranchPattern(ctx.resolvedBranch!, pat))
      : false;
  }

  // 12. Corpus Match Condition — explicit, operator-authored live lookup
  //     against the override corpus. This is the one condition category
  //     backed by dynamic data instead of a static field on the rule — kept
  //     opt-in per-rule (not automatic for every gate decision) so Gate A
  //     stays a deterministic, explainable evaluator: every decision is
  //     still traceable to a rule an operator explicitly wrote, not an
  //     implicit coupling to a corpus that changes underneath it.
  if (cond.requireCorpusMatch) {
    const { incidentTag, minOccurrences = 1 } = cond.requireCorpusMatch;
    const matchingRules = getRulesForTag(incidentTag, ctx.service);
    corpusMatched = matchingRules.some((r) => r.occurrences >= minOccurrences);
  }

  const baseMatch = fileMatched && commandMatched && actorMatched && dayMatched && hourMatched &&
    serviceMatched && envMatched && repoMatched && agentMatched && roleMatched && branchMatched && corpusMatched;

  // Composition — vacuously true when the field is absent, so a ConditionSet
  // with none of these three (every existing rule) reduces to baseMatch alone.
  const anyOfMatch = !cond.anyOf || cond.anyOf.length === 0 || cond.anyOf.some((c) => matchesConditionSet(c, ctx));
  const allOfMatch = !cond.allOf || cond.allOf.every((c) => matchesConditionSet(c, ctx));
  const notMatch    = !cond.not || !matchesConditionSet(cond.not, ctx);

  return baseMatch && anyOfMatch && allOfMatch && notMatch;
}

export function evaluateEnterprisePolicy(input: EvaluationInput, policyOverride?: EnterprisePolicyConfig): PolicyEvaluationResult {
  const startTime = performance.now();
  try {
    const config = policyOverride ?? loadEnterprisePolicy();
    const result: PolicyEvaluationResult = {
      verdict: 'pass',
      triggeredRules: [],
      reasons: [],
    };

  // Toggling the policy off (PATCH /policies/enabled) disables the operator-
  // editable rules, but must not disable IMMUTABLE_RULE_IDS — those are the
  // hard-safety guardrails (e.g. block_destructive_commands) that the pitch
  // describes as "regardless of policy settings." Without this carve-out,
  // disabling the policy silently disabled the destructive-command block too.
  const rulesToEvaluate = config.enabled
    ? config.rules
    : config.rules.filter(rule => IMMUTABLE_RULE_IDS.has(rule.id));

  const { files, commands = [], actor, service, timestamp = Date.now(), environment, repo, agentId, actorRole, branch } = input;
  const isAi = isAiActor(actor);
  const date = new Date(timestamp);
  const dayOfWeek = date.getUTCDay();
  const hourOfDay = date.getUTCHours();

  // Role lookup: prefer explicit actorRole param, then fall back to MERGEN_ACTOR_ROLES env var
  // env format: "actor1:role1,actor2:role2" → look up role for this actor
  const resolvedRole: string | null = actorRole ?? _lookupActorRole(actor);

  // Branch: prefer explicit branch param, then MERGEN_GIT_BRANCH env
  const resolvedBranch: string | null = branch ?? process.env.MERGEN_GIT_BRANCH ?? null;

  const ctx: MatchContext = {
    files, commands, service, isAi, dayOfWeek, hourOfDay,
    environment, repo, agentId, resolvedRole, resolvedBranch,
  };

  for (const rule of rulesToEvaluate) {
    if (matchesConditionSet(rule.conditions, ctx)) {
      result.triggeredRules.push(rule.id);
      result.reasons.push(rule.reason);

      // Upgrade verdict severity if needed: block > warn > pass
      if (rule.action === 'block') {
        result.verdict = 'block';
      } else if (rule.action === 'warn' && result.verdict !== 'block') {
        result.verdict = 'warn';
        // Record shadow-promote hit asynchronously — must not be in the synchronous gate path
        void import('../sensor/shadow-promote.js').then(({ recordShadowRuleHit }) => {
          recordShadowRuleHit(rule.id, rule.name);
        }).catch(() => { /* never break the gate path */ });
      }
    }
  }

  return result;
  } finally {
    const elapsed = performance.now() - startTime;
    _lastEvalLatencyMs = Math.round(elapsed * 100) / 100;
    if (_lastEvalLatencyMs < 0.05) {
      _lastEvalLatencyMs = 0.05;
    }
  }
}
