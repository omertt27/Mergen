import { Request, Response, Router } from 'express';
import { store, BrowserEventSchema } from './buffer.js';
import { resolveStackTrace } from './sourcemap.js';
import logger from './logger.js';

export const ingestRouter = Router();

const SHARED_SECRET = process.env.MERGEN_SECRET;

// ── Rate limiter: token-bucket, max 100 events / second ──────────────────────
// P1.3: Replaced the leaky O(n) Array.shift() approach with an O(1)
// counter+timer bucket. The bucket refills every second; no array scanning.
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 1_000;
let _bucketCount = 0;
let _bucketTimer: ReturnType<typeof setTimeout> | null = null;

function isRateLimited(): boolean {
  if (_bucketCount >= RATE_LIMIT) return true;
  _bucketCount++;
  if (!_bucketTimer) {
    _bucketTimer = setTimeout(() => {
      _bucketCount = 0;
      _bucketTimer = null;
    }, RATE_WINDOW_MS);
  }
  return false;
}

// ── Sourcemap resolution timeout ──────────────────────────────────────────────
// P2.1: Guard against hung disk scans blocking the event loop indefinitely.
const SOURCEMAP_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`sourcemap resolution timed out after ${ms}ms`)), ms),
    ),
  ]);
}

ingestRouter.post('/ingest', (req: Request, res: Response): void => {
  if (SHARED_SECRET && req.headers['x-mergen-secret'] !== SHARED_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (isRateLimited()) {
    res.status(429).json({ error: 'rate limit exceeded' });
    return;
  }

  const result = BrowserEventSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: 'invalid event', details: result.error.flatten() });
    return;
  }

  const event = result.data;

  // Respond immediately so the extension is never blocked on sourcemap I/O
  res.status(204).end();

  if (event.type === 'console' && typeof event.stack === 'string') {
    withTimeout(resolveStackTrace(event.stack), SOURCEMAP_TIMEOUT_MS)
      .then((resolved) => store.push({ ...event, stack: resolved }))
      .catch((err) => {
        logger.warn({ err }, 'sourcemap resolution failed or timed out, storing raw event');
        store.push(event);
      });
  } else {
    store.push(event);
  }
});
