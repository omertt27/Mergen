/**
 * hitl.ts — Human-in-the-Loop approval endpoints.
 *
 * When the tool-guard holds a pending MCP tool call, it fires an outbound
 * webhook containing approve/deny URLs pointing here. The operator clicks
 * the link (or POSTs programmatically) to release or cancel the hold.
 *
 * Endpoints:
 *   GET  /hitl/approve?token=<uuid>  — confirmation page (Slack url: button → browser GET)
 *   POST /hitl/approve?token=<uuid>  — release the held tool call (requires x-mergen-secret)
 *   GET  /hitl/deny?token=<uuid>     — confirmation page
 *   POST /hitl/deny?token=<uuid>     — cancel the held tool call (requires x-mergen-secret)
 *   GET  /hitl/pending               — list all currently held tool calls (requires secret)
 *
 * Slack `url:` buttons open the GET endpoints in the user's browser. The page
 * renders a minimal confirmation form that POSTs back — so a single click in
 * Slack triggers a two-step: GET shows the confirmation, POST executes the action.
 *
 * Rate limiting: 10 token-resolution attempts per IP per minute to prevent
 * UUID brute-force. Failed lookups are logged for audit.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { Router } from 'express';
import logger from '../sensor/logger.js';
import { approveToolCall, denyToolCall, getPendingHolds, approveBypass, invalidateBypassToken } from '../intelligence/tool-guard.js';
import { getHitlFatigueStatus } from '../intelligence/gate-analytics.js';
import { timingSafeSecretEqualAny } from '../sensor/security-utils.js';

// ── HITL-specific auth helpers ────────────────────────────────────────────────
// Fix #8: Browser form POSTs (from Slack confirmation pages) cannot send custom
// headers, so they cannot carry x-mergen-secret. Instead, the confirmation page
// embeds an HMAC nonce derived from (localSecret, token). The POST handler
// accepts either the header OR the nonce, so both API callers and browser flows
// are authenticated without exposing the localSecret in HTML.

function _generateNonce(token: string, secret: string): string {
  return createHmac('sha256', secret).update(`hitl-csrf:${token}`).digest('hex');
}

function _isHitlAuthorized(req: Request, token: string, localSecret: string): boolean {
  // Accept x-mergen-secret header (programmatic access, CLI, VS Code extension)
  if (timingSafeSecretEqualAny(req.headers['x-mergen-secret'], localSecret)) return true;
  // Accept HMAC nonce embedded in the browser confirmation form
  const nonce = req.body?._nonce;
  if (typeof nonce === 'string' && nonce.length > 0) {
    try {
      const expected = _generateNonce(token, localSecret);
      const a = Buffer.from(nonce,    'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  }
  return false;
}

// Simple in-process rate limiter: 10 resolution attempts per IP per 60 s.
const HITL_RATE_LIMIT = 10;
const HITL_RATE_WINDOW_MS = 60_000;
const _hitlBuckets = new Map<string, { count: number; resetAt: number }>();

// Per-token attempt counter: max 3 failed attempts before the token is invalidated.
const TOKEN_ATTEMPT_LIMIT = 3;
const _tokenAttempts = new Map<string, number>();

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

function recordFailedTokenAttempt(token: string): boolean {
  const attempts = (_tokenAttempts.get(token) ?? 0) + 1;
  _tokenAttempts.set(token, attempts);
  if (attempts >= TOKEN_ATTEMPT_LIMIT) {
    invalidateBypassToken(token);
    _tokenAttempts.delete(token);
    return true;
  }
  return false;
}

function _escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Confirmation page embeds an HMAC nonce so the browser form POST is
// self-authenticated without requiring a custom x-mergen-secret header.
function confirmationPage(action: 'approve' | 'deny', token: string, nonce: string): string {
  const label     = action === 'approve' ? 'Approve' : 'Deny';
  const btnColor  = action === 'approve' ? '#28a745' : '#dc3545';
  const emoji     = action === 'approve' ? '✅' : '❌';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mergen HITL — ${label} tool call</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
    h1   { font-size: 1.4rem; margin-bottom: .5rem; }
    p    { color: #555; margin-bottom: 1.5rem; }
    form { display: inline; }
    button {
      background: ${btnColor}; color: #fff; border: none; border-radius: 6px;
      padding: 12px 28px; font-size: 1rem; cursor: pointer; font-weight: 600;
    }
    button:hover { opacity: .88; }
    .token { font-family: monospace; font-size: .85rem; color: #666; margin-top: 1.5rem; }
    .alt { margin-top: 1.5rem; font-size: .85rem; color: #888; }
    code { background: #f4f4f4; border-radius: 4px; padding: 2px 6px; }
  </style>
</head>
<body>
  <h1>${emoji} ${label} Mergen HITL gate?</h1>
  <p>Clicking the button below will ${action} the held tool call and release it ${action === 'approve' ? 'for execution' : 'with a cancellation error'}.</p>
  <form method="POST" action="/hitl/${action}?token=${_escHtml(token)}">
    <input type="hidden" name="_nonce" value="${nonce}">
    <button type="submit">${emoji} Confirm ${label}</button>
  </form>
  <p class="token">Token: <code>${_escHtml(token)}</code></p>
  <p class="alt">Alternatively, run: <code>mergen ${action} ${_escHtml(token)}</code></p>
</body>
</html>`;
}

export function createHitlRouter(localSecret: string): Router {
  const router = Router();

  // ── GET /hitl/approve — confirmation page (Slack url: button → browser opens this) ──
  router.get('/hitl/approve', (req, res) => {
    const token = (req.query.token as string | undefined)?.trim();
    if (!token) { res.status(400).send('token required'); return; }
    // Only generate a nonce for tokens that correspond to an actual pending hold.
    // Without this check the endpoint is a nonce oracle — any caller can get a
    // valid HMAC for an arbitrary token string and use it to POST-approve.
    if (!getPendingHolds().some(h => h.token === token)) {
      res.status(404).send('token not found'); return;
    }
    const nonce = _generateNonce(token, localSecret);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.send(confirmationPage('approve', token, nonce));
  });

  // ── GET /hitl/deny — confirmation page ───────────────────────────────────────
  router.get('/hitl/deny', (req, res) => {
    const token = (req.query.token as string | undefined)?.trim();
    if (!token) { res.status(400).send('token required'); return; }
    if (!getPendingHolds().some(h => h.token === token)) {
      res.status(404).send('token not found'); return;
    }
    const nonce = _generateNonce(token, localSecret);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.send(confirmationPage('deny', token, nonce));
  });

  // ── POST /hitl/approve — self-authenticated via token+nonce or x-mergen-secret ──
  router.post('/hitl/approve', (req, res) => {
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    if (hitlRateLimited(ip)) {
      logger.warn({ ip }, 'hitl: rate limit exceeded on /hitl/approve');
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const token = ((req.query.token ?? req.body?.token) as string | undefined)?.trim();
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    if (!_isHitlAuthorized(req, token, localSecret)) {
      logger.warn({ ip, token }, 'hitl: approve rejected — missing or invalid auth');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const released = approveToolCall(token);
    if (!released) {
      logger.warn({ ip, token }, 'hitl: approve attempted with unknown or expired token');
      const exhausted = recordFailedTokenAttempt(token);
      if (exhausted) logger.warn({ token }, 'hitl: token invalidated after too many failed attempts');
      res.status(404).json({ error: 'token not found or already expired' });
      return;
    }
    _tokenAttempts.delete(token);
    if ((req.headers.accept ?? '').includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Approved</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px">
<h1>✅ Tool call approved</h1><p>The held tool call has been released for execution.</p>
<p style="color:#888;font-size:.85rem">Token: <code>${token}</code></p>
</body></html>`);
      return;
    }
    res.json({ ok: true, action: 'approved', token });
  });

  // ── POST /hitl/deny — self-authenticated via token+nonce or x-mergen-secret ──
  router.post('/hitl/deny', (req, res) => {
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    if (hitlRateLimited(ip)) {
      logger.warn({ ip }, 'hitl: rate limit exceeded on /hitl/deny');
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const token = ((req.query.token ?? req.body?.token) as string | undefined)?.trim();
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    if (!_isHitlAuthorized(req, token, localSecret)) {
      logger.warn({ ip, token }, 'hitl: deny rejected — missing or invalid auth');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const denied = denyToolCall(token);
    if (!denied) {
      logger.warn({ ip, token }, 'hitl: deny attempted with unknown or expired token');
      const exhausted = recordFailedTokenAttempt(token);
      if (exhausted) logger.warn({ token }, 'hitl: token invalidated after too many failed attempts');
      res.status(404).json({ error: 'token not found or already expired' });
      return;
    }
    _tokenAttempts.delete(token);
    if ((req.headers.accept ?? '').includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Denied</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px">
<h1>❌ Tool call denied</h1><p>The held tool call has been cancelled. The agent will receive a cancellation error.</p>
<p style="color:#888;font-size:.85rem">Token: <code>${token}</code></p>
</body></html>`);
      return;
    }
    res.json({ ok: true, action: 'denied', token });
  });

  // GET /hitl/pending is protected by SENSITIVE_GET_PATHS in app.ts (requires x-mergen-secret).
  router.get('/hitl/pending', (_req, res) => {
    res.json({ ok: true, pending: getPendingHolds() });
  });

  // ── GET /hitl/fatigue — HITL approval fatigue status ─────────────────────────
  // Returns whether the HITL hold rate has exceeded the fatigue threshold in the
  // last hour, and a recommendation to convert noisy HOLD rules to BLOCK rules.
  router.get('/hitl/fatigue', (_req, res) => {
    const status = getHitlFatigueStatus();
    res.json({ ok: true, ...status });
  });

  return router;
}
