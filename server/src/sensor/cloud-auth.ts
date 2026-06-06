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
    logger.warn({ err }, 'cloud-auth: failed to persist api-keys');
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
}

export function createApiKey(opts: {
  tenantId: string;
  label: string;
  rateLimit?: number;
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
  };
  _keys.push(entry);
  persist();
  logger.info({ id: entry.id, tenantId: entry.tenantId, label: entry.label }, 'cloud-auth: api key created');
  return { id: entry.id, tenantId: entry.tenantId, label: entry.label, key: plain, rateLimit: entry.rateLimit, createdAt: entry.createdAt };
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

  if (!checkRateLimit(key.id, key.rateLimit)) {
    res.status(429).json({ error: 'rate limit exceeded', limit: key.rateLimit, windowMs: WINDOW_MS });
    return;
  }

  key.lastUsedAt = Date.now();
  req.tenantId = key.tenantId;
  next();
}
