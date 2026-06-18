/**
 * routes/api-keys.ts — CRUD for cloud-mode API keys.
 *
 * All mutating endpoints require the x-mergen-secret header.
 * Only active when MERGEN_CLOUD_MODE=true — returns 404 otherwise.
 *
 * POST   /api-keys              { tenantId, label, rateLimit?, scope?, expiresAt?, createdBy? } → { key, id, ... }
 * GET    /api-keys              → { keys: [...] }  (no plain-text keys returned)
 * DELETE /api-keys/:id          → { ok: true }
 */

import { Router } from 'express';
import type { Request } from 'express';
import { createApiKey, listApiKeys, revokeApiKey, CLOUD_MODE } from '../sensor/cloud-auth.js';

/** Resolve the caller identity from request headers for audit purposes. */
function resolveCaller(req: Request): string {
  return (req.headers['x-mergen-member'] as string | undefined)
    ?? (req.tenantId ?? 'api-admin');
}

export function createApiKeysRouter(): Router {
  const router = Router();

  router.post('/api-keys', (req, res) => {
    if (!CLOUD_MODE) { res.status(404).json({ error: 'cloud mode not enabled', fix: 'set MERGEN_CLOUD_MODE=true' }); return; }
    const { tenantId, label, rateLimit, scope, expiresAt, createdBy } = (req.body ?? {}) as {
      tenantId?:  string;
      label?:     string;
      rateLimit?: number;
      scope?:     string[];
      expiresAt?: string;
      createdBy?: string;
    };
    if (!tenantId || typeof tenantId !== 'string') {
      res.status(400).json({ ok: false, error: 'tenantId (string) is required' });
      return;
    }
    if (!label || typeof label !== 'string') {
      res.status(400).json({ ok: false, error: 'label (string) is required' });
      return;
    }
    if (rateLimit !== undefined && (typeof rateLimit !== 'number' || rateLimit < 1)) {
      res.status(400).json({ ok: false, error: 'rateLimit must be a positive number' });
      return;
    }
    if (scope !== undefined && (!Array.isArray(scope) || scope.some((s) => typeof s !== 'string'))) {
      res.status(400).json({ ok: false, error: 'scope must be an array of strings (e.g. ["ingest", "read"])' });
      return;
    }
    if (expiresAt !== undefined && isNaN(Date.parse(expiresAt))) {
      res.status(400).json({ ok: false, error: 'expiresAt must be a valid ISO 8601 date string' });
      return;
    }

    const caller  = createdBy ?? resolveCaller(req);
    const created = createApiKey({ tenantId, label, rateLimit, scope, expiresAt, createdBy: caller });
    res.status(201).json({
      ok: true,
      ...created,
      note: 'Store this key securely — it will not be shown again.',
    });
  });

  router.get('/api-keys', (_req, res) => {
    if (!CLOUD_MODE) { res.status(404).json({ error: 'cloud mode not enabled' }); return; }
    res.json({ ok: true, keys: listApiKeys() });
  });

  router.delete('/api-keys/:id', (req, res) => {
    if (!CLOUD_MODE) { res.status(404).json({ error: 'cloud mode not enabled' }); return; }
    const deleted = revokeApiKey(req.params.id);
    if (!deleted) { res.status(404).json({ ok: false, error: `no key with id: ${req.params.id}` }); return; }
    res.json({ ok: true });
  });

  return router;
}
