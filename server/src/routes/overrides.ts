/**
 * routes/overrides.ts — Override corpus HTTP API.
 *
 *   POST   /overrides              record an engineer override
 *   PATCH  /overrides/:id/outcome  update the outcome after resolution
 *   GET    /override-corpus        aggregated summary per detector tag
 *   GET    /overrides/:tag         raw override history for a specific tag
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  OVERRIDE_REASONS,
  type OverrideReason,
  type OverrideOutcome,
} from '../intelligence/override-corpus.js';
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
    logger.info({ id: event.id, tag: event.incidentTag }, 'override recorded via API');
    res.status(201).json({ ok: true, override: event });
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
    res.json({ ok: true, reviewedAt: Date.now() });
  });

  // ── Raw history for a tag ──────────────────────────────────────────────────
  router.get('/overrides/:tag', async (req, res) => {
    const events = await getStores().overrides.getOverridesForTag(req.params.tag, req.tenantId);
    res.json({ ok: true, tag: req.params.tag, overrides: events });
  });

  return router;
}
