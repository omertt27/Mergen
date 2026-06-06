/**
 * routes/slack-routing.ts — HTTP API for managing service-to-Slack routing rules.
 *
 * GET  /slack/routing          — list all rules
 * POST /slack/routing          — create or update a rule (upserts by service name)
 * DELETE /slack/routing/:id    — remove a rule by id
 */

import { Router } from 'express';
import { getRules, upsertRule, deleteRule, type SlackRoutingRule } from '../intelligence/slack-routing.js';

export function createSlackRoutingRouter(): Router {
  const router = Router();

  router.get('/slack/routing', (_req, res) => {
    res.json({ ok: true, rules: getRules() });
  });

  router.post('/slack/routing', (req, res) => {
    const body = (req.body ?? {}) as Partial<SlackRoutingRule>;

    if (!body.service || typeof body.service !== 'string') {
      res.status(400).json({ ok: false, error: 'service (string) is required' });
      return;
    }
    if (!body.webhook || typeof body.webhook !== 'string') {
      res.status(400).json({ ok: false, error: 'webhook (string) is required' });
      return;
    }
    try { new URL(body.webhook); } catch {
      res.status(400).json({ ok: false, error: 'webhook must be a valid URL' });
      return;
    }
    if (body.minConfidence !== undefined) {
      const v = Number(body.minConfidence);
      if (isNaN(v) || v < 0 || v > 1) {
        res.status(400).json({ ok: false, error: 'minConfidence must be a number between 0 and 1' });
        return;
      }
    }

    const rule = upsertRule({
      id:              typeof body.id === 'string' ? body.id : undefined,
      service:         body.service,
      webhook:         body.webhook,
      channel:         typeof body.channel === 'string' ? body.channel : undefined,
      minConfidence:   typeof body.minConfidence === 'number' ? body.minConfidence : undefined,
      escalateAt:      typeof body.escalateAt === 'number' ? body.escalateAt : undefined,
      oncallMention:   typeof body.oncallMention === 'string' ? body.oncallMention : undefined,
    });
    res.status(201).json({ ok: true, rule });
  });

  router.delete('/slack/routing/:id', (req, res) => {
    const { id } = req.params;
    if (!id) { res.status(400).json({ ok: false, error: 'id is required' }); return; }
    const deleted = deleteRule(id);
    if (!deleted) { res.status(404).json({ ok: false, error: `no rule with id: ${id}` }); return; }
    res.json({ ok: true });
  });

  return router;
}
