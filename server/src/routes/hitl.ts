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
 *   GET  /hitl/pending               — list all currently held tool calls (requires secret)
 *
 * Rate limiting: 10 token-resolution attempts per IP per minute to prevent
 * UUID brute-force. Failed lookups are logged for audit.
 */

import { Router } from 'express';
import logger from '../sensor/logger.js';
import { approveToolCall, denyToolCall, getPendingHolds } from '../intelligence/tool-guard.js';

// Simple in-process rate limiter: 10 resolution attempts per IP per 60 s.
// Deliberately kept lightweight — HITL endpoints are low-volume by design
// (one call per queued tool approval), so a Map is sufficient.
const HITL_RATE_LIMIT = 10;
const HITL_RATE_WINDOW_MS = 60_000;
const _hitlBuckets = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of _hitlBuckets) {
    if (now > b.resetAt) _hitlBuckets.delete(ip);
  }
}, 5 * 60_000).unref();

function hitlRateLimited(ip: string): boolean {
  const now = Date.now();
  let b = _hitlBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + HITL_RATE_WINDOW_MS };
    _hitlBuckets.set(ip, b);
  }
  return ++b.count > HITL_RATE_LIMIT;
}

export function createHitlRouter(): Router {
  const router = Router();

  router.post('/hitl/approve', (req, res) => {
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    if (hitlRateLimited(ip)) {
      logger.warn({ ip }, 'hitl: rate limit exceeded on /hitl/approve');
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const token = ((req.query.token ?? req.body?.token) as string | undefined)?.trim();
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    const released = approveToolCall(token);
    if (!released) {
      logger.warn({ ip, token }, 'hitl: approve attempted with unknown or expired token');
      res.status(404).json({ error: 'token not found or already expired' });
      return;
    }
    res.json({ ok: true, action: 'approved', token });
  });

  router.post('/hitl/deny', (req, res) => {
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    if (hitlRateLimited(ip)) {
      logger.warn({ ip }, 'hitl: rate limit exceeded on /hitl/deny');
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const token = ((req.query.token ?? req.body?.token) as string | undefined)?.trim();
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    const denied = denyToolCall(token);
    if (!denied) {
      logger.warn({ ip, token }, 'hitl: deny attempted with unknown or expired token');
      res.status(404).json({ error: 'token not found or already expired' });
      return;
    }
    res.json({ ok: true, action: 'denied', token });
  });

  // GET /hitl/pending is protected by SENSITIVE_GET_PATHS in app.ts (requires x-mergen-secret).
  router.get('/hitl/pending', (_req, res) => {
    res.json({ ok: true, pending: getPendingHolds() });
  });

  return router;
}
