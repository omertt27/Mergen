/**
 * routes/tenants.ts — Tenant provisioning API (cloud mode only).
 *
 *   POST   /tenants              { id, name, settings? } → create a tenant + initial API key
 *   GET    /tenants              → get the calling tenant's own record
 *   GET    /tenants/:id          → get one tenant (caller must own it)
 *   PATCH  /tenants/:id          { name?, settings? } → update name or settings
 *   DELETE /tenants/:id          → soft-delete (revokes all API keys, marks inactive)
 *
 * POST /tenants requires x-mergen-secret (admin-only tenant creation).
 * All other endpoints require a valid x-api-key; tenants can only read/mutate their
 * own record. Platform admins acting via x-mergen-secret may omit x-api-key and
 * therefore bypass the ownership check (req.tenantId is undefined).
 *
 * Tenant IDs must be lowercase alphanumeric + hyphens (e.g. "acme-corp").
 * The 'local' tenant ID is reserved for local/single-tenant mode.
 */

import { Router } from 'express';
import { getSql } from '../storage/pg/pg-client.js';
import { createApiKey, listApiKeys, revokeApiKey, CLOUD_MODE, cloudAuthMiddleware } from '../sensor/cloud-auth.js';
import logger from '../sensor/logger.js';

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const RESERVED_IDS = new Set(['local']);

export function createTenantsRouter(): Router {
  const router = Router();

  // All routes 404 in local mode
  function requireCloudMode(res: import('express').Response): boolean {
    if (!CLOUD_MODE) {
      res.status(404).json({ error: 'cloud mode not enabled', fix: 'set MERGEN_CLOUD_MODE=true' });
      return false;
    }
    return true;
  }

  // Enforce that the authenticated tenant (req.tenantId) matches the target id.
  // Admin callers using x-mergen-secret have no tenantId and are always allowed.
  function assertOwnership(req: import('express').Request, res: import('express').Response, targetId: string): boolean {
    if (req.tenantId && req.tenantId !== targetId) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return false;
    }
    return true;
  }

  // ── Create tenant (admin-only, protected by x-mergen-secret in MUTATING_PATHS) ──
  router.post('/tenants', async (req, res) => {
    if (!requireCloudMode(res)) return;

    const { id, name, settings } = (req.body ?? {}) as {
      id?:       string;
      name?:     string;
      settings?: Record<string, unknown>;
    };

    if (!id || typeof id !== 'string') {
      res.status(400).json({ ok: false, error: 'id (string) is required' }); return;
    }
    if (!TENANT_ID_RE.test(id)) {
      res.status(400).json({ ok: false, error: 'id must be lowercase alphanumeric with hyphens (e.g. "acme-corp")' }); return;
    }
    if (RESERVED_IDS.has(id)) {
      res.status(400).json({ ok: false, error: `tenant id "${id}" is reserved` }); return;
    }
    if (!name || typeof name !== 'string') {
      res.status(400).json({ ok: false, error: 'name (string) is required' }); return;
    }

    const sql = getSql();
    try {
      await sql`
        INSERT INTO tenants (id, name, settings)
        VALUES (${id}, ${name}, ${JSON.stringify(settings ?? {})})
      `;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({ ok: false, error: `tenant "${id}" already exists` }); return;
      }
      logger.error({ err, tenantId: id }, 'tenants: failed to create tenant');
      res.status(500).json({ ok: false, error: 'failed to create tenant' }); return;
    }

    // Provision an initial API key for this tenant
    const apiKey = createApiKey({
      tenantId: id,
      label:    `${id} — initial key`,
      createdBy: 'api-admin',
    });

    logger.info({ tenantId: id, name, keyId: apiKey.id }, 'tenants: tenant created');
    res.status(201).json({
      ok:    true,
      tenant: { id, name, settings: settings ?? {}, createdAt: new Date().toISOString() },
      initialApiKey: {
        id:    apiKey.id,
        key:   apiKey.key,
        note:  'Store this key securely — it will not be shown again.',
      },
    });
  });

  // ── List tenants — returns only the calling tenant's own record ────────────
  router.get('/tenants', cloudAuthMiddleware, async (req, res) => {
    if (!requireCloudMode(res)) return;

    const sql = getSql();
    const tenantId = req.tenantId!;
    const rows = await sql`SELECT id, name, settings, created_at FROM tenants WHERE id = ${tenantId}`;
    const keys = listApiKeys().filter((k) => k.tenantId === tenantId);

    const tenants = rows.map((row) => ({
      id:          row['id'] as string,
      name:        row['name'] as string,
      settings:    row['settings'] as Record<string, unknown>,
      createdAt:   (row['created_at'] as Date).toISOString(),
      apiKeyCount: keys.filter((k) => k.tenantId === row['id']).length,
    }));

    res.json({ ok: true, count: tenants.length, tenants });
  });

  // ── Get one tenant — caller must own the requested tenant ─────────────────
  router.get('/tenants/:id', cloudAuthMiddleware, async (req, res) => {
    if (!requireCloudMode(res)) return;
    if (!assertOwnership(req, res, req.params.id)) return;

    const sql = getSql();
    const rows = await sql`SELECT id, name, settings, created_at FROM tenants WHERE id = ${req.params.id}`;
    if (rows.length === 0) {
      res.status(404).json({ ok: false, error: `tenant "${req.params.id}" not found` }); return;
    }
    const row = rows[0];
    const keys = listApiKeys().filter((k) => k.tenantId === req.params.id);

    res.json({
      ok: true,
      tenant: {
        id:        row['id'] as string,
        name:      row['name'] as string,
        settings:  row['settings'] as Record<string, unknown>,
        createdAt: (row['created_at'] as Date).toISOString(),
      },
      apiKeys: keys.map(({ id, label, rateLimit, createdAt, lastUsedAt, scope, expiresAt }) => ({
        id, label, rateLimit, createdAt, lastUsedAt, scope, expiresAt,
      })),
    });
  });

  // ── Update tenant ──────────────────────────────────────────────────────────
  router.patch('/tenants/:id', async (req, res) => {
    if (!requireCloudMode(res)) return;
    if (!assertOwnership(req, res, req.params.id)) return;

    const { name, settings } = (req.body ?? {}) as { name?: string; settings?: Record<string, unknown> };
    if (!name && !settings) {
      res.status(400).json({ ok: false, error: 'at least one of name or settings is required' }); return;
    }

    const sql = getSql();
    const existing = await sql`SELECT id FROM tenants WHERE id = ${req.params.id}`;
    if (existing.length === 0) {
      res.status(404).json({ ok: false, error: `tenant "${req.params.id}" not found` }); return;
    }

    if (name && settings) {
      await sql`UPDATE tenants SET name = ${name}, settings = ${JSON.stringify(settings)} WHERE id = ${req.params.id}`;
    } else if (name) {
      await sql`UPDATE tenants SET name = ${name} WHERE id = ${req.params.id}`;
    } else {
      await sql`UPDATE tenants SET settings = ${JSON.stringify(settings!)} WHERE id = ${req.params.id}`;
    }

    logger.info({ tenantId: req.params.id }, 'tenants: tenant updated');
    res.json({ ok: true });
  });

  // ── Delete tenant ──────────────────────────────────────────────────────────
  // Revokes all API keys for the tenant. Does NOT delete incident/event data —
  // that stays for audit purposes. The tenant row itself is also kept (marked
  // inactive via settings.deleted=true) so references remain valid.
  router.delete('/tenants/:id', async (req, res) => {
    if (!requireCloudMode(res)) return;
    if (!assertOwnership(req, res, req.params.id)) return;

    if (req.params.id === 'local') {
      res.status(400).json({ ok: false, error: 'cannot delete the reserved "local" tenant' }); return;
    }

    const sql = getSql();
    const existing = await sql`SELECT id FROM tenants WHERE id = ${req.params.id}`;
    if (existing.length === 0) {
      res.status(404).json({ ok: false, error: `tenant "${req.params.id}" not found` }); return;
    }

    // Revoke all API keys
    const keys = listApiKeys().filter((k) => k.tenantId === req.params.id);
    const revokedCount = keys.filter((k) => revokeApiKey(k.id)).length;

    // Mark tenant as deleted in settings (soft delete)
    const deletedAt = new Date().toISOString();
    await sql`
      UPDATE tenants
      SET settings = settings || ${JSON.stringify({ deleted: true, deletedAt })}::jsonb
      WHERE id = ${req.params.id}
    `;

    logger.info({ tenantId: req.params.id, revokedKeys: revokedCount }, 'tenants: tenant deleted');
    res.json({ ok: true, revokedApiKeys: revokedCount });
  });

  // ── Provision additional API key for a tenant ──────────────────────────────
  router.post('/tenants/:id/api-keys', async (req, res) => {
    if (!requireCloudMode(res)) return;
    if (!assertOwnership(req, res, req.params.id)) return;

    const { label, rateLimit, scope, expiresAt } = (req.body ?? {}) as {
      label?:     string;
      rateLimit?: number;
      scope?:     string[];
      expiresAt?: string;
    };

    if (!label || typeof label !== 'string') {
      res.status(400).json({ ok: false, error: 'label (string) is required' }); return;
    }

    // Verify the tenant exists before provisioning a key for it
    const sql = getSql();
    const existing = await sql`SELECT 1 FROM tenants WHERE id = ${req.params.id}`;
    if (existing.length === 0) {
      res.status(404).json({ ok: false, error: `tenant "${req.params.id}" not found` }); return;
    }

    const apiKey = createApiKey({
      tenantId:  req.params.id,
      label,
      rateLimit,
      scope,
      expiresAt,
      createdBy: (req.headers['x-mergen-member'] as string | undefined) ?? 'api-admin',
    });

    logger.info({ tenantId: req.params.id, keyId: apiKey.id, label }, 'tenants: api key provisioned');
    res.status(201).json({
      ok: true,
      ...apiKey,
      note: 'Store this key securely — it will not be shown again.',
    });
  });

  return router;
}
