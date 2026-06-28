/**
 * sso.ts — Enterprise SSO bearer-token middleware.
 *
 * Activates when MERGEN_SSO_REQUIRED=true + MERGEN_SSO_TOKEN is set.
 * All mutating requests (non-GET/OPTIONS) must include:
 *   Authorization: Bearer <MERGEN_SSO_TOKEN>
 *
 * Optional email allowlisting (MERGEN_SSO_ALLOWED_EMAILS):
 *   Token format becomes "<email>:<MERGEN_SSO_TOKEN>" and the email
 *   is checked against the allowlist.
 *
 * For OIDC/JWKS integration, set MERGEN_SSO_JWKS_URL and implement
 * full JWT validation here (requires `jose` or similar dependency).
 *
 * GET and OPTIONS requests are always allowed — they are read-only and
 * additionally gated by the existing local-secret guard for mutations.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeSecretEqual } from './security-utils.js';
import logger from './logger.js';

const SSO_REQUIRED      = process.env.MERGEN_SSO_REQUIRED === 'true';
const SSO_TOKEN         = process.env.MERGEN_SSO_TOKEN ?? '';
const SSO_ALLOWED_EMAILS = process.env.MERGEN_SSO_ALLOWED_EMAILS
  ? new Set(process.env.MERGEN_SSO_ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase()))
  : null;

const SSO_ACTIVE = SSO_REQUIRED && SSO_TOKEN.length > 0;

if (SSO_REQUIRED && !SSO_TOKEN) {
  logger.warn(
    'MERGEN_SSO_REQUIRED=true but MERGEN_SSO_TOKEN is not set — ' +
    'SSO enforcement is disabled. Set MERGEN_SSO_TOKEN to a shared bearer token.',
  );
}

export function ssoMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!SSO_ACTIVE)                                       { next(); return; }
  if (req.method === 'GET' || req.method === 'OPTIONS')  { next(); return; }

  const auth = req.headers['authorization'] as string | undefined;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({
      error:  'SSO required',
      detail: 'Provide "Authorization: Bearer <MERGEN_SSO_TOKEN>" on all write requests.',
    });
    return;
  }

  const presented = auth.slice(7).trim();

  if (SSO_ALLOWED_EMAILS) {
    const colonIdx = presented.indexOf(':');
    if (colonIdx < 0) {
      res.status(401).json({ error: 'SSO: token must be "<email>:<secret>"' });
      return;
    }
    const email  = presented.slice(0, colonIdx).toLowerCase();
    const secret = presented.slice(colonIdx + 1);
    if (!SSO_ALLOWED_EMAILS.has(email) || !timingSafeSecretEqual(secret, SSO_TOKEN)) {
      logger.warn({ email, path: req.path }, 'SSO: rejected — email not in allowlist or wrong secret');
      res.status(401).json({ error: 'SSO: unauthorized' });
      return;
    }
    logger.info({ email, path: req.path }, 'SSO: authenticated');
    next();
    return;
  }

  if (!timingSafeSecretEqual(presented, SSO_TOKEN)) {
    logger.warn({ path: req.path }, 'SSO: invalid bearer token');
    res.status(401).json({ error: 'SSO: invalid bearer token' });
    return;
  }

  next();
}
