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
  recordOverride,
  updateOutcome,
  getOverrideSummary,
  getOverridesForTag,
  OVERRIDE_REASONS,
  type OverrideReason,
  type OverrideOutcome,
} from '../intelligence/override-corpus.js';
import logger from '../sensor/logger.js';

const OVERRIDE_OUTCOMES: OverrideOutcome[] = ['resolved', 'escalated', 'unresolved'];

const OverrideSchema = z.object({
  incidentTag:     z.string().min(1).max(200),
  proposedCommand: z.string().min(1).max(500),
  overrideReason:  z.enum(OVERRIDE_REASONS as [OverrideReason, ...OverrideReason[]]),
  note:            z.string().max(200).optional(),
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
  router.post('/overrides', (req, res) => {
    const parsed = OverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    if (parsed.data.overrideReason === 'other' && !parsed.data.note) {
      res.status(400).json({ error: 'note is required when overrideReason is "other"' });
      return;
    }
    const event = recordOverride(parsed.data);
    logger.info({ id: event.id, tag: event.incidentTag }, 'override recorded via API');
    res.status(201).json({ ok: true, override: event });
  });

  // ── Update outcome ─────────────────────────────────────────────────────────
  router.patch('/overrides/:id/outcome', (req, res) => {
    const parsed = OutcomeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    const found = updateOutcome(req.params.id, parsed.data.outcome);
    if (!found) {
      res.status(404).json({ error: 'override not found' });
      return;
    }
    res.json({ ok: true });
  });

  // ── Aggregated corpus summary ──────────────────────────────────────────────
  router.get('/override-corpus', (_req, res) => {
    res.json({ ok: true, corpus: getOverrideSummary() });
  });

  // ── Raw history for a tag ──────────────────────────────────────────────────
  router.get('/overrides/:tag', (req, res) => {
    const events = getOverridesForTag(req.params.tag);
    res.json({ ok: true, tag: req.params.tag, overrides: events });
  });

  return router;
}
