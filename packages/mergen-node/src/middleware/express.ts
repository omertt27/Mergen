/**
 * Express middleware — records inbound HTTP request spans as backend_span events.
 *
 * Usage:
 *   import express from 'express';
 *   import { mergenMiddleware } from 'mergen-node/middleware/express';
 *
 *   const app = express();
 *   app.use(mergenMiddleware());   // register before your routes
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { post, generateTraceContext, extractTraceId, extractSpanId, PROCESS_NAME } from '../core.js';

export interface MergenMiddlewareOptions {
  /** Only record spans for requests slower than this threshold (ms). Default: 0 (all) */
  thresholdMs?: number;
  /** Only record spans for requests with status >= this code. Default: 0 (all) */
  minStatus?: number;
  /** Skip spans for these path prefixes. Default: ['/health', '/ping', '/_next'] */
  skipPaths?: string[];
}

const DEFAULT_SKIP = ['/health', '/ping', '/favicon.ico', '/_next', '/static'];

export function mergenMiddleware(options: MergenMiddlewareOptions = {}): RequestHandler {
  const thresholdMs = options.thresholdMs ?? 0;
  const minStatus   = options.minStatus ?? 0;
  const skipPaths   = options.skipPaths ?? DEFAULT_SKIP;

  return function mergenExpressMiddleware(req: Request, res: Response, next: NextFunction): void {
    const path = req.path ?? req.url ?? '/';

    if (skipPaths.some(p => path.startsWith(p))) {
      next();
      return;
    }

    const startMs = Date.now();
    const incomingTp = req.headers['traceparent'] as string | undefined;
    const traceId = extractTraceId(incomingTp) ?? generateTraceContext().traceId;
    const spanId  = extractSpanId(incomingTp)  ?? generateTraceContext().spanId;

    // Echo traceId back in response so browser extension can read the join key
    res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);

    res.on('finish', () => {
      const durationMs = Date.now() - startMs;

      if (durationMs < thresholdMs) return;
      if (res.statusCode < minStatus) return;

      const route = (req.route?.path as string | undefined) ?? req.path ?? req.url ?? '/';

      post({
        type:       'backend_span',
        service:    PROCESS_NAME,
        route,
        method:     req.method.toUpperCase(),
        statusCode: res.statusCode,
        durationMs,
        traceId,
        spanId,
        sdk:        'node',
        timestamp:  startMs,
        ...(res.statusCode >= 400 ? { error: `HTTP ${res.statusCode}` } : {}),
      });
    });

    next();
  };
}
