import { Router } from 'express';
import { z } from 'zod';
import {
  loadEnterprisePolicy,
  saveEnterprisePolicy,
  EnterprisePolicyRule,
  EnterprisePolicyConfig,
  EnterprisePolicyConditionsSchema,
  IMMUTABLE_RULE_IDS,
} from '../intelligence/enterprise-policy-engine.js';
import { getRuleFirings, getGateEvents } from '../intelligence/gate-analytics.js';
import { evaluateEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';
import { computePolicySuggestions } from '../intelligence/policy-suggester.js';
import { getProposals, getProposal, markProposalDecided } from '../intelligence/policy-proposals.js';
import { activateProposedRule } from '../intelligence/corpus-to-policy.js';
import { recordActivity } from '../intelligence/activity-feed.js';
import { getPolicyHistory } from '../sensor/policy-history.js';
import { getStores } from '../storage/store-registry.js';

export function createPoliciesRouter(localSecret = ''): Router {
  const router = Router();

  // ── GET /policies — HTML UI ──────────────────────────────────────────────────
  // The SENSITIVE_GET_PATHS guard in app.ts validates the secret (header or ?secret=)
  // before this handler runs. We embed the validated secret into the page JS so that
  // fetch calls from the browser can include it in the x-mergen-secret header.
  router.get('/policies', (req, res) => {
    const presentedSecret = (req.headers['x-mergen-secret'] as string | undefined) ??
      (typeof req.query['secret'] === 'string' ? req.query['secret'] as string : '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buildPoliciesHtml(presentedSecret));
  });

  // ── GET /policies/json — machine-readable policy + trigger counts ────────────
  router.get('/policies/json', (_req, res) => {
    const policy = loadEnterprisePolicy();
    const firings = getRuleFirings();
    res.json({
      ok: true,
      enabled: policy.enabled,
      rules: policy.rules.map(r => ({
        ...r,
        triggerCount: firings.get(r.id) ?? 0,
        // Immutable rules are evaluated even when `enabled` is false and cannot
        // be edited/deleted/replaced via this API — see IMMUTABLE_RULE_IDS.
        immutable: IMMUTABLE_RULE_IDS.has(r.id),
      })),
    });
  });

  // ── PATCH /policies/enabled — toggle policy on/off ───────────────────────────
  router.patch('/policies/enabled', (req, res) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'enabled (boolean) required' }); return; }
    const policy = loadEnterprisePolicy();
    try {
      saveEnterprisePolicy({ ...policy, enabled: body.data.enabled });
      res.json({ ok: true, enabled: body.data.enabled });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /policies/rules — create rule ───────────────────────────────────────
  router.post('/policies/rules', (req, res) => {
    const RuleSchema = z.object({
      id:          z.string().min(1).regex(/^[a-z0-9_-]+$/, 'Rule ID must contain only lowercase letters, digits, underscores, or hyphens'),
      name:        z.string().min(1),
      description: z.string(),
      action:      z.enum(['block', 'warn', 'pass']),
      reason:      z.string(),
      conditions:  EnterprisePolicyConditionsSchema,
    });
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
    const policy = loadEnterprisePolicy();
    if (policy.rules.some(r => r.id === parsed.data.id)) {
      res.status(409).json({ error: `Rule id '${parsed.data.id}' already exists` });
      return;
    }
    try {
      saveEnterprisePolicy({ ...policy, rules: [...policy.rules, parsed.data as EnterprisePolicyRule] });
      res.status(201).json({ ok: true, rule: parsed.data });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PATCH /policies/rules/:id — update rule ──────────────────────────────────
  router.patch('/policies/rules/:id', (req, res) => {
    const { id } = req.params;
    const PatchSchema = z.object({
      name:        z.string().min(1).optional(),
      description: z.string().optional(),
      action:      z.enum(['block', 'warn', 'pass']).optional(),
      reason:      z.string().optional(),
      conditions:  EnterprisePolicyConditionsSchema.optional(),
    }).strict();
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
    if (IMMUTABLE_RULE_IDS.has(id)) {
      res.status(403).json({ error: `Rule '${id}' is a hard-safety guardrail and cannot be modified via this API.` });
      return;
    }
    const policy = loadEnterprisePolicy();
    const idx = policy.rules.findIndex(r => r.id === id);
    if (idx === -1) { res.status(404).json({ error: 'Rule not found' }); return; }
    const updated: EnterprisePolicyRule = { ...policy.rules[idx], ...parsed.data, id };
    const rules = [...policy.rules];
    rules[idx] = updated;
    try {
      saveEnterprisePolicy({ ...policy, rules });
      res.json({ ok: true, rule: updated });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE /policies/rules/:id — remove rule ─────────────────────────────────
  router.delete('/policies/rules/:id', (req, res) => {
    const { id } = req.params;
    if (IMMUTABLE_RULE_IDS.has(id)) {
      res.status(403).json({ error: `Rule '${id}' is a hard-safety guardrail and cannot be deleted via this API.` });
      return;
    }
    const policy = loadEnterprisePolicy();
    if (!policy.rules.some(r => r.id === id)) { res.status(404).json({ error: 'Rule not found' }); return; }
    try {
      saveEnterprisePolicy({ ...policy, rules: policy.rules.filter(r => r.id !== id) });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /policies/history — tamper-evident policy changelog ─────────────────
  // Returns the full history of enterprise-policy.json changes: who changed what,
  // when, and a structural diff (rules added/removed/modified). Policy changes are
  // as consequential as code changes — this answers "why was my PR blocked after
  // last Tuesday?" without requiring git access to the policy file.
  router.get('/policies/history', (_req, res) => {
    const history = getPolicyHistory();
    res.json({
      ok: true,
      count:   history.length,
      history,
    });
  });

  // ── GET /policies/shadow-promote/stats — per-rule shadow hit statistics ──────
  // Shows which warn-mode rules are accumulating clean shadow hits and how
  // close they are to automatic promotion eligibility (14 days, ≥5 hits, 0 FPs).
  router.get('/policies/shadow-promote/stats', async (_req, res) => {
    const { getShadowRuleStats } = await import('../sensor/shadow-promote.js');
    const stats = getShadowRuleStats();
    const WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
    const MIN_HITS  = 5;
    const enriched = stats.map((s) => ({
      ...s,
      eligible: s.totalHits >= MIN_HITS && s.falsePositives === 0 && (Date.now() - s.firstHitAt) >= WINDOW_MS,
      daysUntilEligible: Math.max(0, Math.ceil((s.firstHitAt + WINDOW_MS - Date.now()) / 86_400_000)),
      hitsUntilEligible: Math.max(0, MIN_HITS - s.totalHits),
    }));
    res.json({ ok: true, count: enriched.length, stats: enriched });
  });

  // ── POST /policies/shadow-promote/feedback — submit false-positive annotation ─
  router.post('/policies/shadow-promote/feedback', async (req, res) => {
    const schema = z.object({
      ruleId:          z.string().min(1),
      ruleName:        z.string().min(1),
      isFalsePositive: z.boolean(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid body', issues: parsed.error.issues });
      return;
    }
    const { recordShadowRuleFeedback } = await import('../sensor/shadow-promote.js');
    recordShadowRuleFeedback(parsed.data.ruleId, parsed.data.ruleName, parsed.data.isFalsePositive);
    res.json({ ok: true, recorded: true, ruleId: parsed.data.ruleId, isFalsePositive: parsed.data.isFalsePositive });
  });

  // ── DELETE /policies/shadow-promote/stats/:ruleId — reset stats for a rule ──
  router.delete('/policies/shadow-promote/stats/:ruleId', async (req, res) => {
    const { resetShadowRuleStats } = await import('../sensor/shadow-promote.js');
    resetShadowRuleStats(req.params.ruleId);
    res.json({ ok: true, reset: true, ruleId: req.params.ruleId });
  });

  // ── GET /policies/export — full policy JSON for sync ────────────────────────
  router.get('/policies/export', (_req, res) => {
    const policy = loadEnterprisePolicy();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.json(policy);
  });

  // ── POST /policies/import — replace or merge from remote/exported policy ─────
  router.post('/policies/import', (req, res) => {
    const ImportRuleSchema = z.object({
      id:          z.string().min(1).regex(/^[a-z0-9_-]+$/),
      name:        z.string(),
      description: z.string(),
      action:      z.enum(['block', 'warn', 'pass']),
      reason:      z.string(),
      conditions:  EnterprisePolicyConditionsSchema,
    });
    const body = z.object({
      policy: z.object({ enabled: z.boolean(), rules: z.array(ImportRuleSchema) }),
      mode:   z.enum(['replace', 'merge']).optional().default('replace'),
    }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const incoming = body.data.policy as EnterprisePolicyConfig;
    const mode     = body.data.mode;
    let merged: EnterprisePolicyConfig;

    if (mode === 'merge') {
      const local = loadEnterprisePolicy();
      const existingIds = new Set(local.rules.map(r => r.id));
      const newRules = incoming.rules.filter(r => !existingIds.has(r.id));
      merged = { ...local, rules: [...local.rules, ...newRules] };
    } else {
      // Replace mode: incoming fully replaces local — EXCEPT immutable hard-safety
      // rules, which survive any replace the same way they survive remote
      // policy-sync (policy-sync.ts) and per-rule PATCH/DELETE, so a bulk import
      // can't be used as a side door to remove block_destructive_commands.
      const local = loadEnterprisePolicy();
      const immutableRules = local.rules.filter(r => IMMUTABLE_RULE_IDS.has(r.id));
      const incomingWithoutImmutable = incoming.rules.filter(r => !IMMUTABLE_RULE_IDS.has(r.id));
      merged = { ...incoming, rules: [...immutableRules, ...incomingWithoutImmutable] };
    }

    try {
      saveEnterprisePolicy(merged);
      res.json({ ok: true, ruleCount: merged.rules.length, mode });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── GET /policy-suggestions — auto-discovered uncovered blunder patterns ──────
  // Returns command patterns that have been blocked 5+ times in 30 days but have
  // no matching named policy rule. Use this to formalise organic patterns into
  // explicit enforcement policy.
  router.get('/policy-suggestions', async (_req, res) => {
    const suggestions = await computePolicySuggestions();
    const uncovered = suggestions.filter((s) => !s.alreadyCovered);
    // HOLD-only corpus proposals awaiting approval (MERGEN_AUTO_CORPUS_PROPOSE).
    // These are inert until approved — surfaced here for one-click review.
    const proposals = getProposals('proposed');
    res.json({
      ok: true,
      total: suggestions.length,
      uncoveredCount: uncovered.length,
      suggestions,
      proposals,
      pendingProposalCount: proposals.length,
      note: uncovered.length > 0
        ? `${uncovered.length} pattern${uncovered.length !== 1 ? 's' : ''} blocked repeatedly without a named policy rule. POST /policies/rules to formalise them.`
        : 'All frequent blunder patterns are already covered by named rules.',
    });
  });

  // ── Corpus proposal review (MERGEN_AUTO_CORPUS_PROPOSE) ───────────────────────
  // Proposals are HOLD-only rules staged from the override corpus. They are inert
  // until an operator approves one here, at which point the rule is installed into
  // live policy (as a HOLD). Mutation guard: /policies is in app.ts MUTATING_PATHS,
  // so these POSTs require the x-mergen-secret header.

  router.get('/policies/proposals', (_req, res) => {
    res.json({ ok: true, proposals: getProposals('proposed') });
  });

  router.post('/policies/proposals/:id/approve', (req, res) => {
    const proposal = getProposal(req.params.id);
    if (!proposal)                      { res.status(404).json({ error: 'proposal not found' }); return; }
    if (proposal.status !== 'proposed') { res.status(409).json({ error: `proposal already ${proposal.status}` }); return; }
    try {
      // Safety re-check: never install anything but a HOLD from this path.
      if (proposal.rule.action !== 'warn') {
        res.status(422).json({ error: 'proposal is not HOLD-only — refusing to activate' });
        return;
      }
      activateProposedRule(proposal.rule);
      markProposalDecided(proposal.id, 'approved');
      recordActivity({
        toolName: 'policy-proposal', commandArg: proposal.rule.id,
        verdict: 'HOLD', triggeredRules: [proposal.rule.id], ruleNames: [proposal.rule.name],
      });
      res.json({ ok: true, activated: proposal.rule.id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/policies/proposals/:id/reject', (req, res) => {
    const decided = markProposalDecided(req.params.id, 'rejected');
    if (!decided) { res.status(404).json({ error: 'proposal not found or already decided' }); return; }
    res.json({ ok: true, rejected: decided.id });
  });

  // ── POST /policies/simulate — replay a rule against recent gate events ────────
  // Accepts a partial or full rule JSON. Runs it against the in-memory gate event
  // ring (last 500 calls) and returns how many would have been blocked/held/passed,
  // with up to 5 example matches. Use this before activating a new rule to
  // understand its blast radius against your actual traffic.
  router.post('/policies/simulate', (req, res) => {
    const RuleSchema = z.object({
      id:          z.string().default('__simulate__'),
      name:        z.string().default('Simulation'),
      description: z.string().default(''),
      action:      z.enum(['block', 'warn', 'pass']).default('block'),
      reason:      z.string().default('Simulated block'),
      conditions:  EnterprisePolicyConditionsSchema,
    });

    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

    const rule = parsed.data as EnterprisePolicyRule;
    const events = getGateEvents();

    let wouldBlock = 0;
    let wouldHold  = 0;
    let wouldPass  = 0;
    const examples: Array<{ ts: number; toolName: string; command: string | null; verdict: string }> = [];

    // Simulate with a policy that contains only this single rule
    const simulationPolicy = { enabled: true, rules: [rule] };

    for (const ev of events) {
      const result = evaluateEnterprisePolicy({
        files:       [ev.toolName],
        commands:    [ev.toolName, ev.command ?? ''].filter(Boolean),
        actor:       ev.actor,
        service:     ev.service,
        timestamp:   ev.ts,
        environment: ev.environment ?? undefined,
        agentId:     ev.agentId ?? undefined,
      }, simulationPolicy);

      if (result.verdict === 'pass') {
        wouldPass++;
      } else if (result.verdict === 'block') {
        wouldBlock++;
        if (examples.length < 5) examples.push({ ts: ev.ts, toolName: ev.toolName, command: ev.command, verdict: 'block' });
      } else {
        wouldHold++;
        if (examples.length < 5) examples.push({ ts: ev.ts, toolName: ev.toolName, command: ev.command, verdict: 'hold' });
      }
    }

    const total = events.length;
    res.json({
      ok: true,
      rule: { id: rule.id, name: rule.name, action: rule.action },
      eventsInWindow: total,
      wouldBlock,
      wouldHold,
      wouldPass,
      blockRate: total > 0 ? Math.round((wouldBlock / total) * 100) : 0,
      holdRate:  total > 0 ? Math.round((wouldHold  / total) * 100) : 0,
      examples,
      note: total === 0
        ? 'No gate events in memory yet — start using MCP tools to populate the window.'
        : `Simulated against ${total} recent gate events (rolling window, capped at 500).`,
    });
  });

  // ── GET /policies/rules/:id/simulate — replay an existing rule ────────────────
  router.get('/policies/rules/:id/simulate', (req, res) => {
    const policy = loadEnterprisePolicy();
    const rule = policy.rules.find(r => r.id === req.params.id);
    if (!rule) { res.status(404).json({ error: `Rule '${req.params.id}' not found` }); return; }

    const events = getGateEvents();
    const simulationPolicy = { enabled: true, rules: [rule] };
    let wouldBlock = 0, wouldHold = 0, wouldPass = 0;
    const examples: Array<{ ts: number; toolName: string; command: string | null; verdict: string }> = [];

    for (const ev of events) {
      const result = evaluateEnterprisePolicy({
        files:       [ev.toolName],
        commands:    [ev.toolName, ev.command ?? ''].filter(Boolean),
        actor:       ev.actor,
        service:     ev.service,
        timestamp:   ev.ts,
        environment: ev.environment ?? undefined,
        agentId:     ev.agentId ?? undefined,
      }, simulationPolicy);

      if (result.verdict === 'pass') { wouldPass++; }
      else if (result.verdict === 'block') {
        wouldBlock++;
        if (examples.length < 5) examples.push({ ts: ev.ts, toolName: ev.toolName, command: ev.command, verdict: 'block' });
      } else {
        wouldHold++;
        if (examples.length < 5) examples.push({ ts: ev.ts, toolName: ev.toolName, command: ev.command, verdict: 'hold' });
      }
    }

    const total = events.length;
    res.json({
      ok: true,
      rule: { id: rule.id, name: rule.name, action: rule.action, triggerCount: getRuleFirings().get(rule.id) ?? 0 },
      eventsInWindow: total,
      wouldBlock, wouldHold, wouldPass,
      blockRate: total > 0 ? Math.round((wouldBlock / total) * 100) : 0,
      examples,
    });
  });

  // ── POST /policies/preview — validate a rule against blunder history ──────────
  // Accepts a full or partial policy config. Replays the last 90 days of blunder
  // log entries against it (not just the in-memory gate ring) and returns how many
  // would have been blocked/warned/passed. Use this before activating a new rule to
  // understand its real-world impact on historical traffic — not just recent calls.
  //
  // Unlike /policies/simulate (gate ring only), this runs against the full
  // persisted blunder log so the result is meaningful even after a server restart.
  router.post('/policies/preview', async (req, res) => {
    const PolicySchema = z.object({
      enabled: z.boolean().default(true),
      rules:   z.array(z.object({
        id:          z.string().default('__preview__'),
        name:        z.string().default('Preview'),
        description: z.string().default(''),
        action:      z.enum(['block', 'warn', 'pass']).default('block'),
        reason:      z.string().default('Preview block'),
        conditions:  EnterprisePolicyConditionsSchema,
      })),
    });

    const parsed = PolicySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

    const previewPolicy = parsed.data as EnterprisePolicyConfig;
    const windowDays    = Math.min(90, Math.max(1, Number(req.query.windowDays ?? 30)));
    const cutoff        = Date.now() - windowDays * 24 * 60 * 60 * 1_000;

    const store    = getStores().blunders;
    const blunders = await store.list();
    const inWindow = blunders.filter((b) => b.recordedAt >= cutoff);

    let wouldBlock = 0, wouldWarn = 0, wouldPass = 0;
    const changedVerdicts: Array<{
      id: string; command: string | null; original: string; preview: string; service: string | null;
    }> = [];

    for (const b of inWindow) {
      const result = evaluateEnterprisePolicy({
        files:     [],
        commands:  [b.command ?? b.blockReason].filter(Boolean),
        actor:     b.actor ?? 'unknown',
        service:   b.service ?? 'unknown',
        timestamp: b.recordedAt,
      }, previewPolicy);

      if (result.verdict === 'block')      wouldBlock++;
      else if (result.verdict === 'warn')  wouldWarn++;
      else                                  wouldPass++;

      // Track when preview verdict differs from the original block
      if (result.verdict !== 'block' && changedVerdicts.length < 10) {
        changedVerdicts.push({
          id:       b.id,
          command:  b.command,
          original: 'block',
          preview:  result.verdict,
          service:  b.service,
        });
      }
    }

    const total = inWindow.length;
    res.json({
      ok: true,
      windowDays,
      blundersEvaluated: total,
      wouldBlock,
      wouldWarn,
      wouldPass,
      blockRate: total > 0 ? Math.round((wouldBlock / total) * 100) : 0,
      warnRate:  total > 0 ? Math.round((wouldWarn  / total) * 100) : 0,
      passRate:  total > 0 ? Math.round((wouldPass  / total) * 100) : 0,
      changedVerdicts,
      note: total === 0
        ? `No blunders in the last ${windowDays} days to evaluate against.`
        : `Replayed ${total} blunder log entries from the last ${windowDays} days against the preview policy.`,
    });
  });

  // ── POST /policies/counterfactual — "what would have changed?" replay ─────────
  // Given a policy config, replays the last N blunder log entries and returns
  // which ones would have been handled differently (different verdict, different
  // rules fired). Essential for CISO conversations: "if we had this rule, the last
  // 3 incidents would have been caught."
  router.post('/policies/counterfactual', async (req, res) => {
    const body = z.object({
      policy: z.object({
        enabled: z.boolean().default(true),
        rules:   z.array(z.any()),
      }),
      limit: z.number().int().min(1).max(500).default(100),
    }).safeParse(req.body);

    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const { policy: counterPolicy, limit } = body.data;
    const store    = getStores().blunders;
    const blunders = (await store.list()).slice(-limit);
    const current  = loadEnterprisePolicy();

    type VerdictRow = { id: string; command: string | null; service: string | null; recordedAt: number;
                        currentVerdict: string; counterfactualVerdict: string;
                        currentRules: string[]; counterfactualRules: string[] };
    const changed: VerdictRow[]   = [];
    const unchanged: VerdictRow[] = [];

    for (const b of blunders) {
      const input = {
        files:     [],
        commands:  [b.command ?? b.blockReason].filter(Boolean),
        actor:     b.actor ?? 'unknown',
        service:   b.service ?? 'unknown',
        timestamp: b.recordedAt,
      };
      const currentResult = evaluateEnterprisePolicy(input, current);
      const cfResult      = evaluateEnterprisePolicy(input, counterPolicy as EnterprisePolicyConfig);
      const row: VerdictRow = {
        id: b.id, command: b.command, service: b.service, recordedAt: b.recordedAt,
        currentVerdict:          currentResult.verdict,
        counterfactualVerdict:   cfResult.verdict,
        currentRules:            currentResult.triggeredRules,
        counterfactualRules:     cfResult.triggeredRules,
      };
      if (currentResult.verdict !== cfResult.verdict) changed.push(row);
      else unchanged.push(row);
    }

    res.json({
      ok: true,
      evaluated:          blunders.length,
      changedCount:       changed.length,
      unchangedCount:     unchanged.length,
      changed:            changed.slice(0, 50),
      summary: {
        wouldNowBlock: changed.filter((r) => r.counterfactualVerdict === 'block').length,
        wouldNowHold:  changed.filter((r) => r.counterfactualVerdict === 'warn').length,
        wouldNowPass:  changed.filter((r) => r.counterfactualVerdict === 'pass').length,
      },
    });
  });

  return router;
}

// ── HTML UI ──────────────────────────────────────────────────────────────────

function buildPoliciesHtml(localSecret: string): string {
  const escapedSecret = JSON.stringify(localSecret);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Policy Editor · Mergen</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d26;--border:#2a2d3a;--text:#e2e8f0;--muted:#64748b;
    --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;--purple:#a78bfa;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:13px;line-height:1.6;padding:24px;max-width:1100px;margin:0 auto}
  h1{font-size:18px;font-weight:700;margin-bottom:4px}
  .subtitle{color:var(--muted);font-size:12px;margin-bottom:24px}
  .nav{display:flex;gap:16px;margin-bottom:24px;font-size:12px}
  .nav a{color:var(--blue);text-decoration:none}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px}
  .card-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;display:flex;align-items:center;gap:8px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:0 8px 8px;border-bottom:1px solid var(--border)}
  td{padding:10px 8px;border-bottom:1px solid rgba(42,45,58,.6);vertical-align:middle;font-size:12px}
  tr:last-child td{border-bottom:none}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
  .badge-block{background:rgba(239,68,68,.15);color:var(--red)}
  .badge-warn{background:rgba(245,158,11,.15);color:var(--yellow)}
  .badge-pass{background:rgba(34,197,94,.15);color:var(--green)}
  .count{font-size:11px;font-weight:700;color:var(--purple);background:rgba(167,139,250,.12);padding:2px 6px;border-radius:6px}
  input,select,textarea{background:#0d0f18;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:4px 8px;font-size:12px;font-family:inherit;width:100%}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--blue)}
  textarea{resize:vertical;min-height:60px}
  .btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;transition:.15s}
  .btn-save{background:rgba(59,130,246,.2);color:var(--blue)}
  .btn-save:hover{background:rgba(59,130,246,.35)}
  .btn-delete{background:rgba(239,68,68,.15);color:var(--red)}
  .btn-delete:hover{background:rgba(239,68,68,.3)}
  .btn-add{background:rgba(34,197,94,.15);color:var(--green);padding:6px 14px;font-size:12px}
  .btn-add:hover{background:rgba(34,197,94,.25)}
  .toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px}
  .toggle input{width:auto}
  .flash{position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:6px;font-size:12px;font-weight:600;z-index:999;opacity:0;transition:.3s}
  .flash.show{opacity:1}
  .flash.ok{background:#1a3a2a;border:1px solid var(--green);color:var(--green)}
  .flash.err{background:#3a1a1a;border:1px solid var(--red);color:var(--red)}
  .readonly-rule{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(42,45,58,.6)}
  .readonly-rule:last-child{border-bottom:none}
  .readonly-rule .name{font-weight:600;font-size:12px;min-width:220px}
  .readonly-rule .desc{color:var(--muted);font-size:11px}
  .section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
  .form-row.single{grid-template-columns:1fr}
  .form-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
</style>
</head>
<body>
<div class="nav"><a href="/dashboard">← Dashboard</a> <a href="/policies">Policy Editor</a></div>
<h1>Policy Editor</h1>
<p class="subtitle">Manage the rules that govern AI agent tool calls. Changes take effect immediately.</p>

<div id="flash" class="flash"></div>

<div class="card" id="toggle-card">
  <div class="card-title">Policy Status</div>
  <label class="toggle">
    <input type="checkbox" id="policy-enabled" onchange="toggleEnabled(this.checked)">
    <span id="enabled-label">Loading…</span>
  </label>
</div>

<div class="card">
  <div class="card-title">Enterprise Rules <span id="rule-count" style="font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0;font-size:11px"></span></div>
  <table>
    <thead><tr>
      <th style="width:220px">Rule</th>
      <th style="width:80px">Action</th>
      <th style="width:60px">Triggers</th>
      <th>Description</th>
      <th style="width:120px"></th>
    </tr></thead>
    <tbody id="rules-body"><tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px">Loading…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <div class="card-title">Add New Rule</div>
  <div class="form-row">
    <div><div class="form-label">Rule ID</div><input id="new-id" placeholder="e.g. block_prod_deletes" /></div>
    <div><div class="form-label">Name</div><input id="new-name" placeholder="Human-readable name" /></div>
  </div>
  <div class="form-row single"><div class="form-label">Description</div><input id="new-desc" placeholder="What this rule does and why" /></div>
  <div class="form-row">
    <div><div class="form-label">Action</div>
      <select id="new-action"><option value="block">block</option><option value="warn">warn (HITL)</option><option value="pass">pass</option></select>
    </div>
    <div><div class="form-label">Reason (shown in block message)</div><input id="new-reason" placeholder="Why this call is restricted" /></div>
  </div>
  <div class="form-row single"><div class="form-label">Command patterns (comma-separated)</div><textarea id="new-commands" placeholder="terraform destroy, kubectl delete, drop table"></textarea></div>
  <div class="form-row single"><div class="form-label">File patterns (comma-separated, optional)</div><input id="new-files" placeholder="auth, login, migration" /></div>
  <div class="form-row">
    <div><div class="form-label">Actor type</div>
      <select id="new-actor"><option value="">any</option><option value="ai">ai only</option><option value="human">human only</option></select>
    </div>
    <div></div>
  </div>
  <button class="btn btn-add" onclick="addRule()">+ Add Rule</button>
</div>

<div class="card">
  <div class="card-title">Hard Safety Rules <span style="font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0;font-size:11px">(immutable — cannot be disabled, edited, or deleted via this API or the Policy Status toggle above)</span></div>
  <div id="hard-rules">
    <div class="readonly-rule"><div class="name">Blocked keywords</div><div class="desc">rm -rf, drop table, terraform destroy, kubectl delete, truncate, format c:, destroy, nuke, wipe — always evaluated, including while Policy Status above is toggled off. Only this specific rule set (IMMUTABLE_RULE_IDS) carries this guarantee; rules in the Enterprise Rules table below do not.</div></div>
  </div>
</div>

<script>
const SECRET=${escapedSecret};
const authHeaders = SECRET ? {'x-mergen-secret': SECRET, 'Content-Type': 'application/json'} : {'Content-Type': 'application/json'};

function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function flash(msg, ok=true){
  const el=document.getElementById('flash');
  el.textContent=msg; el.className='flash show '+(ok?'ok':'err');
  setTimeout(()=>{el.className='flash';},3000);
}

async function loadPolicy(){
  const d=await fetch('/policies/json', {headers: SECRET ? {'x-mergen-secret': SECRET} : {}}).then(r=>r.json());
  document.getElementById('policy-enabled').checked=d.enabled;
  document.getElementById('enabled-label').textContent=d.enabled?'Policy active — gate is enforcing rules':'Policy disabled — editable Enterprise Rules below are off; Hard Safety Rules stay enforced';
  // Immutable rules render in the read-only "Hard Safety Rules" card above, not
  // in this editable table — they can't be Saved/Deleted, so showing them here
  // with live-looking action buttons would be misleading.
  const editableRules=d.rules.filter(r=>!r.immutable);
  document.getElementById('rule-count').textContent='('+editableRules.length+' rules)';
  const tbody=document.getElementById('rules-body');
  if(!editableRules.length){tbody.innerHTML='<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px">No enterprise rules yet — add one below.</td></tr>';return;}
  tbody.innerHTML=editableRules.map(r=>\`
    <tr id="row-\${escHtml(r.id)}">
      <td><strong>\${escHtml(r.name)}</strong><br><span style="color:var(--muted);font-size:10px">\${escHtml(r.id)}</span></td>
      <td><select id="action-\${escHtml(r.id)}" style="width:auto">
        <option value="block" \${r.action==='block'?'selected':''}>block</option>
        <option value="warn" \${r.action==='warn'?'selected':''}>warn</option>
        <option value="pass" \${r.action==='pass'?'selected':''}>pass</option>
      </select></td>
      <td><span class="count">\${r.triggerCount||0}</span></td>
      <td><input id="desc-\${escHtml(r.id)}" value="\${escHtml(r.description)}" /></td>
      <td style="white-space:nowrap">
        <button class="btn btn-save" onclick="saveRule('\${escHtml(r.id)}')">Save</button>
        <button class="btn btn-delete" onclick="deleteRule('\${escHtml(r.id)}')">Delete</button>
      </td>
    </tr>
  \`).join('');
}

async function toggleEnabled(val){
  document.getElementById('enabled-label').textContent=val?'Policy active — gate is enforcing rules':'Policy disabled — editable Enterprise Rules below are off; Hard Safety Rules stay enforced';
  const r=await fetch('/policies/enabled',{method:'PATCH',headers:authHeaders,body:JSON.stringify({enabled:val})});
  flash(val?'Policy enabled':'Policy disabled — hard safety rules remain active', r.ok);
}

async function saveRule(id){
  const action=document.getElementById('action-'+id).value;
  const description=document.getElementById('desc-'+id).value;
  const r=await fetch('/policies/rules/'+encodeURIComponent(id),{method:'PATCH',headers:authHeaders,body:JSON.stringify({action,description})});
  flash(r.ok?'Rule saved':'Save failed — '+await r.text(), r.ok);
}

async function deleteRule(id){
  if(!confirm('Delete rule "'+id+'"?')) return;
  const r=await fetch('/policies/rules/'+encodeURIComponent(id),{method:'DELETE',headers:SECRET?{'x-mergen-secret':SECRET}:{}});
  if(r.ok){flash('Rule deleted'); await loadPolicy();}
  else flash('Delete failed','err');
}

async function addRule(){
  const id=document.getElementById('new-id').value.trim();
  const name=document.getElementById('new-name').value.trim();
  const desc=document.getElementById('new-desc').value.trim();
  const action=document.getElementById('new-action').value;
  const reason=document.getElementById('new-reason').value.trim();
  const cmds=document.getElementById('new-commands').value.split(',').map(s=>s.trim()).filter(Boolean);
  const files=document.getElementById('new-files').value.split(',').map(s=>s.trim()).filter(Boolean);
  const actor=document.getElementById('new-actor').value;
  if(!id||!name||!reason){flash('ID, name, and reason are required','err');return;}
  if(!/^[a-z0-9_-]+$/.test(id)){flash('Rule ID must be lowercase letters, digits, underscores or hyphens only','err');return;}
  const conditions={};
  if(cmds.length) conditions.commands=cmds;
  if(files.length) conditions.files=files;
  if(actor) conditions.actorType=actor;
  const r=await fetch('/policies/rules',{method:'POST',headers:authHeaders,body:JSON.stringify({id,name,description:desc,action,reason,conditions})});
  if(r.ok){
    flash('Rule added');
    ['new-id','new-name','new-desc','new-reason','new-commands','new-files'].forEach(f=>document.getElementById(f).value='');
    await loadPolicy();
  } else {
    const e=await r.json();
    flash('Error: '+JSON.stringify(e.error),'err');
  }
}

loadPolicy();
setInterval(loadPolicy, 30_000);
</script>
</body>
</html>`;
}
