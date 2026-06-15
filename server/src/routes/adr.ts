/**
 * routes/adr.ts — Architectural Decision Record endpoints.
 *
 *   GET  /adrs        list all ADRs (optional ?q= keyword filter)
 *   GET  /adrs/:id    get one ADR by ID (e.g. ADR-001)
 *   POST /adrs        record a new ADR
 */

import { Router } from 'express';
import { z } from 'zod';
import { adrStore } from '../sensor/adr-store.js';

const NewAdrSchema = z.object({
  title:        z.string().min(1).max(200),
  status:       z.enum(['proposed', 'accepted', 'deprecated', 'superseded']).default('proposed'),
  date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().slice(0, 10)),
  decision:     z.string().min(1).max(2000),
  alternatives: z.array(z.string().max(500)).default([]),
  rationale:    z.string().min(1).max(2000),
  consequences: z.string().max(2000).default(''),
});

export function createAdrRouter(): Router {
  const router = Router();

  router.get('/adrs', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json({ ok: true, adrs: adrStore.list(q) });
  });

  router.get('/adrs/:id', (req, res) => {
    const adr = adrStore.get(req.params.id);
    if (!adr) { res.status(404).json({ error: 'ADR not found' }); return; }
    res.json({ ok: true, adr });
  });

  router.post('/adrs', (req, res) => {
    const parsed = NewAdrSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    const adr = adrStore.add(parsed.data);
    res.status(201).json({ ok: true, adr });
  });

  return router;
}
