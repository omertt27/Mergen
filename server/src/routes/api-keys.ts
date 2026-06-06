/**
 * routes/api-keys.ts — CRUD for cloud-mode API keys.
 *
 * All endpoints require the x-mergen-secret header (same as other admin routes).
 * Only active when MERGEN_CLOUD_MODE=true — returns 404 otherwise.
 *
 * POST   /api-keys              { tenantId, label, rateLimit? } → { key, id, ... }
 * GET    /api-keys              → { keys: [...] }  (no plain-text keys returned)
 * DELETE /api-keys/:id          → { ok: true }
 */

import { Router } from 'express';
import { createApiKey, listApiKeys, revokeApiKey, CLOUD_MODE } from '../sensor/cloud-auth.js';

export function createApiKeysRouter(): Router {
  const router = Router();

  router.post('/api-keys', (req, res) => {
    if (!CLOUD_MODE) { res.status(404).json({ error: 'cloud mode not enabled' }); return; }
    const { tenantId, label, rateLimit } = (req.body ?? {}) as {
      tenantId?: string;
      label?: string;
      rateLimit?: number;
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
    const created = createApiKey({ tenantId, label, rateLimit });
    res.status(201).json({ ok: true, ...created });
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
