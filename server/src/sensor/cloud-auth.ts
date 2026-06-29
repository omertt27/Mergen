/**
 * cloud-auth.ts — Multi-tenant API key management and ingest middleware.
 *
 * Active only when MERGEN_CLOUD_MODE=true. In local mode this module is a
 * no-op — the existing shared-secret + Host-header checks are sufficient.
 *
 * API keys are stored at ~/.mergen/api-keys.json. Each key has:
 *   - A random 32-byte hex value (never stored in plain text — SHA-256 hashed)
 *   - A tenantId scoping all ingested events for multi-tenant isolation
 *   - A rate limit (events/minute, default 1000)
 *
 * Usage:
 *   POST /api-keys              — create a key (returns plain-text key once)
 *   GET  /api-keys              — list keys (ids + labels, never plain text)
 *   DELETE /api-keys/:id        — revoke a key
 *
 * Ingest requests must include:  x-api-key: <plain-text key>
 * The middleware sets req.tenantId on success; rejects 401 on failure.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { DATA_DIR } from './paths.js';
import logger from './logger.js';

// ── Storage ──────────────────────────────────────────────────────────────────

const API_KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');

export interface ApiKey {
  id: string;
  tenantId: string;
  label: string;
  /** SHA-256 of the plain-text key — never store plain text. */
  keyHash: string;
  createdAt: number;
  /** Max events per minute this key is allowed to ingest. */
  rateLimit: number;
  lastUsedAt?: number;
  /** Optional scopes, e.g. ["ingest", "read"]. Empty = full access. */
  scope?: string[];
  /** ISO 8601 expiry date. Null = never expires. */
  expiresAt?: string;
  /** Who created this key (member id or 'api-admin'). */
  createdBy?: string;
}

interface ApiKeysFile {
  version: 1;
  keys: ApiKey[];
}

let _keys: ApiKey[] = [];
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  if (!fs.existsSync(API_KEYS_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8')) as ApiKeysFile;
    if (parsed?.version === 1 && Array.isArray(parsed.keys)) _keys = parsed.keys;
  } catch (err) {
    logger.warn({ err }, 'cloud-auth: failed to load api-keys file');
  }
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${API_KEYS_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys: _keys } satisfies ApiKeysFile, null, 2), 'utf8');
    fs.renameSync(tmp, API_KEYS_FILE);
  } catch (err) {
    logger.warn({ err }, 'cloud-auth: failed to persist api-keys to file');
  }
}

async function upsertKeyToPg(key: ApiKey): Promise<void> {
  const { getSql } = await import('../storage/pg/pg-client.js');
  const sql = getSql();
  await sql`
    INSERT INTO api_keys (id, tenant_id, label, key_hash, rate_limit, scope, expires_at, created_at, last_used_at, created_by)
    VALUES (
      ${key.id}, ${key.tenantId}, ${key.label}, ${key.keyHash}, ${key.rateLimit},
      ${JSON.stringify(key.scope ?? [])}, ${key.expiresAt ?? null}, ${key.createdAt},
      ${key.lastUsedAt ?? null}, ${key.createdBy ?? 'api-admin'}
    )
    ON CONFLICT (id) DO UPDATE SET
      label        = EXCLUDED.label,
      rate_limit   = EXCLUDED.rate_limit,
      scope        = EXCLUDED.scope,
      expires_at   = EXCLUDED.expires_at,
      last_used_at = EXCLUDED.last_used_at
  `;
}

async function deleteKeyFromPg(id: string): Promise<void> {
  const { getSql } = await import('../storage/pg/pg-client.js');
  const sql = getSql();
  await sql`DELETE FROM api_keys WHERE id = ${id}`;
}

/**
 * Load API keys from Postgres into the in-memory store.
 * Call once at boot in cloud mode, after the PG client is initialized.
 */
export async function initCloudApiKeys(): Promise<void> {
  if (!CLOUD_MODE) return;
  try {
    const { getSql } = await import('../storage/pg/pg-client.js');
    const sql = getSql();
    const rows = await sql`SELECT * FROM api_keys ORDER BY created_at ASC`;
    _keys = rows.map((row) => ({
      id:          String(row['id']),
      tenantId:    String(row['tenant_id']),
      label:       String(row['label']),
      keyHash:     String(row['key_hash']),
      rateLimit:   Number(row['rate_limit']),
      createdAt:   Number(row['created_at']),
      ...(row['last_used_at'] != null ? { lastUsedAt: Number(row['last_used_at']) } : {}),
      ...(Array.isArray(row['scope']) && row['scope'].length > 0 ? { scope: row['scope'] as string[] } : {}),
      ...(row['expires_at']  != null ? { expiresAt:  String(row['expires_at'])  } : {}),
      ...(row['created_by']  != null ? { createdBy:  String(row['created_by'])  } : {}),
    }));
    _loaded = true;
    logger.info({ count: _keys.length }, 'cloud-auth: loaded api keys from postgres');
  } catch (err) {
    logger.error({ err }, 'cloud-auth: failed to load api keys from postgres — falling back to file');
    load();
  }
}

function hashKey(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

// ── Rate limiter — sliding window per key ─────────────────────────────────────

const _rateBuckets = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60_000;

function checkRateLimit(keyId: string, limit: number): boolean {
  const now = Date.now();
  const bucket = _rateBuckets.get(keyId);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    _rateBuckets.set(keyId, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CreatedApiKey {
  id: string;
  tenantId: string;
  label: string;
  /** Plain-text key — shown once, never stored. */
  key: string;
  rateLimit: number;
  createdAt: number;
  scope?: string[];
  expiresAt?: string;
  createdBy?: string;
}

export function createApiKey(opts: {
  tenantId: string;
  label: string;
  rateLimit?: number;
  scope?: string[];
  expiresAt?: string;
  createdBy?: string;
}): CreatedApiKey {
  load();
  const plain = crypto.randomBytes(32).toString('hex');
  const entry: ApiKey = {
    id: `key-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    tenantId: opts.tenantId,
    label: opts.label,
    keyHash: hashKey(plain),
    createdAt: Date.now(),
    rateLimit: opts.rateLimit ?? 1000,
    ...(opts.scope     ? { scope:     opts.scope }     : {}),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
  };
  _keys.push(entry);
  persist();
  if (CLOUD_MODE) {
    upsertKeyToPg(entry).catch((err) => logger.warn({ err, id: entry.id }, 'cloud-auth: failed to persist new key to postgres'));
  }
  logger.info({ id: entry.id, tenantId: entry.tenantId, label: entry.label, createdBy: entry.createdBy }, 'cloud-auth: api key created');
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    label: entry.label,
    key: plain,
    rateLimit: entry.rateLimit,
    createdAt: entry.createdAt,
    ...(entry.scope     ? { scope:     entry.scope }     : {}),
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    ...(entry.createdBy ? { createdBy: entry.createdBy } : {}),
  };
}

export function listApiKeys(): Array<Omit<ApiKey, 'keyHash'>> {
  load();
  return _keys.map(({ keyHash: _h, ...rest }) => rest);
}

export function revokeApiKey(id: string): boolean {
  load();
  const before = _keys.length;
  _keys = _keys.filter((k) => k.id !== id);
  if (_keys.length === before) return false;
  _rateBuckets.delete(id);
  persist();
  if (CLOUD_MODE) {
    deleteKeyFromPg(id).catch((err) => logger.warn({ err, id }, 'cloud-auth: failed to delete key from postgres'));
  }
  logger.info({ id }, 'cloud-auth: api key revoked');
  return true;
}

// ── Express middleware ────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

export const CLOUD_MODE = process.env.MERGEN_CLOUD_MODE === 'true';

/**
 * Middleware applied to ingest routes in cloud mode.
 * Validates x-api-key, enforces per-tenant rate limits, sets req.tenantId.
 */
export function cloudAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!CLOUD_MODE) { next(); return; }

  const plain = req.headers['x-api-key'];
  if (!plain || typeof plain !== 'string') {
    res.status(401).json({ error: 'x-api-key header required in cloud mode' });
    return;
  }

  load();
  const hash = hashKey(plain);
  const key = _keys.find((k) => k.keyHash === hash);
  if (!key) {
    res.status(401).json({ error: 'invalid api key' });
    return;
  }

  // Check expiry
  if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
    res.status(401).json({ error: 'api key expired', expiredAt: key.expiresAt });
    return;
  }

  if (!checkRateLimit(key.id, key.rateLimit)) {
    res.status(429).json({ error: 'rate limit exceeded', limit: key.rateLimit, windowMs: WINDOW_MS });
    return;
  }

  key.lastUsedAt = Date.now();
  req.tenantId = key.tenantId;
  if (CLOUD_MODE) {
    upsertKeyToPg(key).catch(() => { /* non-critical lastUsedAt sync */ });
  }
  next();
}
