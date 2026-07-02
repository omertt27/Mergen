/**
 * routes/overrides.ts — Override corpus HTTP API.
 *
 *   POST   /overrides                 record an engineer override
 *   PATCH  /overrides/:id/outcome     update the outcome after resolution
 *   POST   /overrides/import          import a mergen-pack policy pack
 *   GET    /override-corpus           aggregated summary per detector tag
 *   GET    /override-corpus/export    export team overrides as a shareable pack
 *   GET    /overrides/:tag            raw override history for a specific tag
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  OVERRIDE_REASONS,
  buildOverridePack,
  type OverrideReason,
  type OverrideOutcome,
} from '../intelligence/override-corpus.js';
import { autoActivateReviewedRules } from '../intelligence/corpus-to-policy.js';
import { getStores } from '../storage/store-registry.js';
import logger from '../sensor/logger.js';

const OVERRIDE_OUTCOMES: OverrideOutcome[] = ['resolved', 'escalated', 'unresolved'];

const OverrideSchema = z.object({
  incidentTag:     z.string().min(1).max(200),
  proposedCommand: z.string().min(1).max(500),
  overrideReason:  z.enum(OVERRIDE_REASONS as [OverrideReason, ...OverrideReason[]]),
  note:            z.string().max(200).optional(),
  rationale:       z.string().max(300).optional(),
  service:         z.string().min(1).max(100),
  environment:     z.string().max(50).default('production'),
  manualAction:    z.string().max(500).optional(),
  actor:           z.string().max(200).default('unknown'),
});

const OutcomeSchema = z.object({
  outcome: z.enum(OVERRIDE_OUTCOMES as [OverrideOutcome, ...OverrideOutcome[]]),
});

const PackEntrySchema = z.object({
  incidentTag:     z.string().min(1).max(200),
  proposedCommand: z.string().min(1).max(500),
  overrideReason:  z.enum(OVERRIDE_REASONS as [OverrideReason, ...OverrideReason[]]),
  note:            z.string().max(200).optional(),
  rationale:       z.string().max(300).optional(),
  service:         z.string().min(1).max(100),
  environment:     z.string().max(50).default('production'),
  dayOfWeek:       z.number().int().min(0).max(6),
  hourOfDay:       z.number().int().min(0).max(23),
  manualAction:    z.string().max(500).optional(),
  outcome:         z.enum(OVERRIDE_OUTCOMES as [OverrideOutcome, ...OverrideOutcome[]]).optional(),
  expiresInDays:   z.number().int().min(1).max(3650).optional(),
}).refine((e) => e.overrideReason !== 'other' || !!e.note, {
  message: 'note is required when overrideReason is "other"',
});

const PackSchema = z.object({
  format:  z.literal('mergen-pack'),
  version: z.literal(1),
  name:    z.string().max(200).optional(),
  entries: z.array(PackEntrySchema).min(1).max(500),
});

export function createOverridesRouter(): Router {
  const router = Router();

  // ── Record override ────────────────────────────────────────────────────────
  router.post('/overrides', async (req, res) => {
    const parsed = OverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    if (parsed.data.overrideReason === 'other' && !parsed.data.note) {
      res.status(400).json({ error: 'note is required when overrideReason is "other"' });
      return;
    }
    const event = await getStores().overrides.recordOverride(parsed.data, req.tenantId);
    logger.info({ id: event.id, tag: event.incidentTag, conflicts: (event as {conflictsWith?: string[]}).conflictsWith }, 'override recorded via API');
    const { conflictsWith, ...overrideData } = event as typeof event & { conflictsWith?: string[] };
    res.status(201).json({
      ok: true,
      override: overrideData,
      ...(conflictsWith && conflictsWith.length > 0 ? {
        warning: `This entry may conflict with ${conflictsWith.length} existing corpus entry/entries. Review IDs: ${conflictsWith.join(', ')}`,
        conflictsWith,
      } : {}),
    });
  });

  // ── Update outcome ─────────────────────────────────────────────────────────
  router.patch('/overrides/:id/outcome', async (req, res) => {
    const parsed = OutcomeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    const found = await getStores().overrides.updateOutcome(req.params.id, parsed.data.outcome, req.tenantId);
    if (!found) {
      res.status(404).json({ error: 'override not found' });
      return;
    }
    res.json({ ok: true });
  });

  // ── Aggregated corpus summary ──────────────────────────────────────────────
  router.get('/override-corpus', async (req, res) => {
    const corpus = await getStores().overrides.getOverrideSummary(req.tenantId);
    if (corpus.length > 0) {
      res.json({ ok: true, corpus });
      return;
    }
    // Return illustrative demo entries so visitors understand what a mature corpus looks like.
    // Clearly labelled as demo — not real operational data from this install.
    res.json({
      ok: true,
      corpus: [],
      demo: true,
      demoNote: 'No overrides recorded yet. The entries below show what your corpus will look like after 4-6 weeks of shadow mode.',
      demoEntries: [
        {
          incidentTag: 'infra_db_connection_pool',
          service: 'api',
          environment: 'production',
          overrideReason: 'batch-window',
          note: 'Friday 20-24 UTC — settlement window. Pool resize causes lock contention on the batch job.',
          proposedCommand: 'kubectl set env deployment/api DB_POOL_MAX=50',
          manualAction: 'kubectl rollout restart deployment/api',
          appliedCount: 4,
          lastApplied: 'Friday 2026-06-14 21:30 UTC',
        },
        {
          incidentTag: 'infra_oom_kill',
          service: 'worker',
          environment: 'production',
          overrideReason: 'compliance-hold',
          note: 'Memory limit change requires change advisory board sign-off. Cannot increase in-place.',
          proposedCommand: 'kubectl set resources deployment/worker --limits=memory=4Gi',
          manualAction: 'Opened CAB ticket #4421. Restarted worker with heap profiling enabled.',
          appliedCount: 2,
          lastApplied: 'Wednesday 2026-06-10 03:17 UTC',
        },
        {
          incidentTag: 'infra_rate_limit_cascade',
          service: 'auth',
          environment: 'production',
          overrideReason: 'wrong-fix',
          note: 'Circuit breaker was the symptom, not the cause. Root cause was upstream API key rotation.',
          proposedCommand: 'enable_circuit_breaker(auth-service)',
          manualAction: 'Rotated upstream API credentials. Verified with ops team before action.',
          appliedCount: 1,
          lastApplied: 'Monday 2026-06-08 14:02 UTC',
        },
      ],
    });
  });

  // ── Stale corpus entries ───────────────────────────────────────────────────
  // Returns override entries that have not been operator-reviewed within N days
  // (default 60). An entry is stale when its reviewedAt (or recordedAt if never
  // reviewed) is older than the threshold. Use POST /overrides/:id/review to
  // re-affirm or call DELETE /overrides/:id to remove entries that no longer apply.
  router.get('/override-corpus/stale', async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 60)));
    const stale = await getStores().overrides.getStaleOverrides(days, req.tenantId);
    res.json({
      ok: true,
      staleCount: stale.length,
      thresholdDays: days,
      stale: stale.map((e) => ({
        id: e.id,
        incidentTag: e.incidentTag,
        service: e.service,
        overrideReason: e.overrideReason,
        note: e.note,
        recordedAt: e.recordedAt,
        reviewedAt: e.reviewedAt ?? null,
        daysSinceReview: Math.floor((Date.now() - (e.reviewedAt ?? e.recordedAt)) / 86_400_000),
      })),
    });
  });

  // ── Mark override as reviewed ──────────────────────────────────────────────
  // Operator re-affirms that this entry still reflects team policy.
  // Resets the staleness clock without modifying the entry content.
  router.post('/overrides/:id/review', async (req, res) => {
    const found = await getStores().overrides.markOverrideReviewed(req.params.id, req.tenantId);
    if (!found) {
      res.status(404).json({ error: 'override not found' });
      return;
    }

    // A human review is the HITL signal that this pattern still reflects real
    // policy — promote any corpus rule for this (tag, service) that has already
    // cleared the occurrence threshold straight into the live enforcement gate.
    let activatedRules: Array<{ id: string; name: string; action: string }> = [];
    const event = await getStores().overrides.getOverrideById(req.params.id, req.tenantId);
    if (event) {
      try {
        const activated = autoActivateReviewedRules(event.incidentTag, event.service);
        activatedRules = activated.map((a) => ({ id: a.rule.id, name: a.rule.name, action: a.rule.action }));
      } catch (err) {
        logger.warn({ err, id: req.params.id }, 'overrides: failed to auto-activate corpus rules after review');
      }
    }

    res.json({ ok: true, reviewedAt: Date.now(), activatedRules });
  });

  // ── Export corpus as a shareable policy pack ────────────────────────────────
  // The pack strips team-local provenance (ids, actors, timestamps) and keeps
  // only the pattern fields, so it can be shared outside the team. Community-
  // sourced entries are excluded unless ?includeCommunity=true, so re-exports
  // don't echo imported packs back into circulation.
  router.get('/override-corpus/export', async (req, res) => {
    const events = await getStores().overrides.getAllOverrides(req.tenantId);
    const pack = buildOverridePack(events, {
      name: typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : undefined,
      includeCommunity: req.query.includeCommunity === 'true',
    });
    res.json(pack);
  });

  // ── Import a policy pack ─────────────────────────────────────────────────────
  // Idempotent: entries whose pattern key (tag/reason/day/hour/service) already
  // exists are skipped, so team overrides always take precedence. Imported
  // entries are tagged source: 'community' and dayOfWeek/hourOfDay are preserved
  // from the pack — the time window is part of the pattern.
  // Mutating route: covered by the x-mergen-secret guard on /overrides.
  router.post('/overrides/import', async (req, res) => {
    const parsed = PackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    const { imported, skipped } = await getStores().overrides.importOverrides(
      parsed.data.entries,
      { source: 'community' },
      req.tenantId,
    );
    logger.info({ pack: parsed.data.name, imported, skipped }, 'override pack imported via API');
    res.status(201).json({ ok: true, pack: parsed.data.name ?? null, imported, skipped });
  });

  // ── Expiring-soon corpus entries + Slack renewal prompts ─────────────────────
  // Returns override entries expiring within the next N days (default: 14).
  // Used to surface renewal prompts: "Is 'never touch payments DB during settlement
  // run' still valid?" Prevents stale knowledge from blocking valid actions forever.
  //
  // Also optionally fires a Slack message summarising expiring entries when
  // MERGEN_SLACK_BOT_TOKEN is set and ?notify=true is passed.
  router.get('/overrides/expiring-soon', async (req, res) => {
    const windowDays = Math.min(90, Math.max(1, Number(req.query.windowDays ?? 14)));
    const expiring   = await getStores().overrides.getExpiringSoon(windowDays, req.tenantId);

    // Optionally fire a Slack notification
    if (req.query.notify === 'true') {
      const webhookUrl = process.env.MERGEN_HITL_WEBHOOK_URL;
      if (webhookUrl && expiring.length > 0) {
        const lines = expiring.slice(0, 10).map((e) => {
          const daysLeft = Math.ceil(((e.expiresAt ?? 0) - Date.now()) / 86_400_000);
          return `• \`${e.incidentTag}\` / ${e.service} — expires in ${daysLeft}d (reason: ${e.overrideReason})`;
        });
        void fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🕐 *Override corpus renewal needed*: ${expiring.length} entries expiring in ${windowDays} days.\n${lines.join('\n')}\nReview at \`GET /override-corpus/stale\` or call \`POST /overrides/:id/review\` to re-affirm.`,
            mergen: { type: 'corpus_renewal_prompt', count: expiring.length },
          }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => { /* non-fatal */ });
      }
    }

    res.json({
      ok: true,
      windowDays,
      expiringCount: expiring.length,
      expiring: expiring.map((e) => ({
        id:            e.id,
        incidentTag:   e.incidentTag,
        service:       e.service,
        overrideReason: e.overrideReason,
        note:          e.note ?? null,
        recordedAt:    e.recordedAt,
        expiresAt:     e.expiresAt ?? null,
        daysLeft:      e.expiresAt ? Math.ceil((e.expiresAt - Date.now()) / 86_400_000) : null,
        reviewUrl:     `/overrides/${e.id}/review`,
      })),
      note: expiring.length > 0
        ? `${expiring.length} corpus entries expire within ${windowDays} days. Review and re-affirm or they will stop influencing gate decisions.`
        : `No corpus entries expiring within ${windowDays} days.`,
    });
  });

  // ── Raw history for a tag ──────────────────────────────────────────────────
  // Registered last: the `:tag` param is a catch-all under /overrides, so it must
  // come after the specific /overrides/* routes (import, expiring-soon, :id/*).
  router.get('/overrides/:tag', async (req, res) => {
    const events = await getStores().overrides.getOverridesForTag(req.params.tag, req.tenantId);
    res.json({ ok: true, tag: req.params.tag, overrides: events });
  });

  return router;
}
