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
import { recordOverride, type OverrideReason } from '../intelligence/override-corpus.js';
import logger from '../sensor/logger.js';

const NewAdrSchema = z.object({
  title:        z.string().min(1).max(200),
  status:       z.enum(['proposed', 'accepted', 'deprecated', 'superseded']).default('proposed'),
  date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().slice(0, 10)),
  decision:     z.string().min(1).max(2000),
  alternatives: z.array(z.string().max(500)).default([]),
  rationale:    z.string().min(1).max(2000),
  consequences: z.string().max(2000).default(''),
});

// Auto-compiles an override corpus entry from an ADR decision
export function compileOverrideFromAdr(adr: { id: string; title: string; decision: string; rationale: string }) {
  const text = `${adr.title} ${adr.decision} ${adr.rationale}`.toLowerCase();
  
  let incidentTag = '';
  let proposedCommand = 'remediation_command'; // default command indicator
  
  // 1. Identify failure mode tag from text
  if (text.includes('oom') || text.includes('memory') || text.includes('limit')) {
    incidentTag = 'infra_oom_kill';
    proposedCommand = 'docker restart web';
  } else if (text.includes('rate') || text.includes('limit') || text.includes('throttl')) {
    incidentTag = 'infra_rate_limit_cascade';
    proposedCommand = 'iptables -A INPUT -p tcp --dport 80 -m limit';
  } else if (text.includes('cert') || text.includes('tls') || text.includes('expiry') || text.includes('ssl')) {
    incidentTag = 'infra_certificate_expiry';
    proposedCommand = 'certbot renew';
  } else if (text.includes('pool') || text.includes('connection') || text.includes('db')) {
    incidentTag = 'infra_db_connection_pool';
    proposedCommand = 'systemctl restart postgresql';
  } else if (text.includes('disk') || text.includes('space') || text.includes('full')) {
    incidentTag = 'infra_disk_pressure';
    proposedCommand = 'rm -rf /tmp/*';
  } else if (text.includes('slow') || text.includes('query') || text.includes('latency')) {
    incidentTag = 'infra_slow_query';
    proposedCommand = 'systemctl reload nginx';
  }

  if (!incidentTag) return null;

  // 2. Identify the OverrideReason
  let reason: OverrideReason = 'on-call-discretion';
  let note = `Auto-compiled from ADR: ${adr.id} (${adr.title})`;

  if (text.includes('window') || text.includes('settlement') || text.includes('friday') || text.includes('batch')) {
    reason = 'batch-window';
  } else if (text.includes('cost') || text.includes('budget') || text.includes('scale') || text.includes('expensive')) {
    reason = 'cost-constraint';
  } else if (text.includes('cab') || text.includes('freeze') || text.includes('compliance') || text.includes('security')) {
    reason = 'compliance-hold';
  } else if (text.includes('replica') || text.includes('read') || text.includes('primary')) {
    reason = 'prefer-read-replica';
  } else if (text.includes('maintenance') || text.includes('scheduled')) {
    reason = 'maintenance-window';
  }

  try {
    const event = recordOverride({
      incidentTag,
      proposedCommand,
      overrideReason: reason,
      note,
      service: 'all',
      environment: 'production',
      actor: `ADR Compiler (${adr.id})`,
    });
    return event;
  } catch (err) {
    logger.warn({ err, adrId: adr.id }, 'adr-compiler: failed to record override from ADR');
    return null;
  }
}

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
    const override = compileOverrideFromAdr(adr);
    res.status(201).json({
      ok: true,
      adr,
      overrideCompiled: override ? true : false,
      overrideId: override?.id,
    });
  });

  // ── POST /ci/adr ───────────────────────────────────────────────────────────
  router.post('/ci/adr', (req, res) => {
    const parsed = NewAdrSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    const adr = adrStore.add(parsed.data);
    const override = compileOverrideFromAdr(adr);
    res.status(201).json({
      ok: true,
      adr,
      overrideCompiled: override ? true : false,
      overrideId: override?.id,
    });
  });

  return router;
}
