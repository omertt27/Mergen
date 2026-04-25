import { Request, Response, Router } from 'express';
import { store, BrowserEventSchema } from './buffer.js';
import { resolveStackTrace } from './sourcemap.js';
import logger from './logger.js';

export const ingestRouter = Router();

const SHARED_SECRET = process.env.MERGEN_SECRET;

// ── Rate limiter: sliding-window counter, max 100 events / second globally ───
// This prevents a runaway extension from exhausting memory.
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 1_000;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  // Evict timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) return true;
  requestTimestamps.push(now);
  return false;
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
    resolveStackTrace(event.stack)
      .then((resolved) => store.push({ ...event, stack: resolved }))
      .catch((err) => {
        logger.warn({ err }, 'sourcemap resolution failed, storing raw event');
        store.push(event);
      });
  } else {
    store.push(event);
  }
});
