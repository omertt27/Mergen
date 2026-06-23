/**
 * hitl.ts — Human-in-the-Loop approval endpoints.
 *
 * When the tool-guard holds a pending MCP tool call, it fires an outbound
 * webhook containing approve/deny URLs pointing here. The operator clicks
 * the link (or POSTs programmatically) to release or cancel the hold.
 *
 * Endpoints:
 *   POST /hitl/approve?token=<uuid>  — release the held tool call (returns tool result)
 *   POST /hitl/deny?token=<uuid>     — cancel the held tool call (returns MCP error)
 *   GET  /hitl/pending               — list all currently held tool calls
 */

import { Router } from 'express';
import { approveToolCall, denyToolCall, getPendingHolds } from '../intelligence/tool-guard.js';

export function createHitlRouter(): Router {
  const router = Router();

  router.post('/hitl/approve', (req, res) => {
    const token = ((req.query.token ?? req.body?.token) as string | undefined)?.trim();
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    const released = approveToolCall(token);
    if (!released) { res.status(404).json({ error: 'token not found or already expired' }); return; }
    res.json({ ok: true, action: 'approved', token });
  });

  router.post('/hitl/deny', (req, res) => {
    const token = ((req.query.token ?? req.body?.token) as string | undefined)?.trim();
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    const denied = denyToolCall(token);
    if (!denied) { res.status(404).json({ error: 'token not found or already expired' }); return; }
    res.json({ ok: true, action: 'denied', token });
  });

  router.get('/hitl/pending', (_req, res) => {
    res.json({ ok: true, pending: getPendingHolds() });
  });

  return router;
}