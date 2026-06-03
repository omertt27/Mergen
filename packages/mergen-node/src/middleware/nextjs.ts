/**
 * Next.js instrumentation — wraps API route handlers to record backend_span events.
 *
 * Usage (Next.js App Router — instrumentation.ts):
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') {
 *       await import('mergen-node');
 *     }
 *   }
 *
 * Usage (Pages Router — wrap individual API routes):
 *   import { withMergen } from 'mergen-node/middleware/nextjs';
 *   export default withMergen(async function handler(req, res) { ... });
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { post, generateTraceContext, extractTraceId, extractSpanId, PROCESS_NAME } from '../core.js';

type NextHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export function withMergen(handler: NextHandler): NextHandler {
  return async function mergenNextHandler(req: IncomingMessage, res: ServerResponse) {
    const startMs = Date.now();
    const incomingTp = req.headers['traceparent'] as string | undefined;
    const traceId = extractTraceId(incomingTp) ?? generateTraceContext().traceId;
    const spanId  = extractSpanId(incomingTp)  ?? generateTraceContext().spanId;

    res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);

    try {
      await handler(req, res);
    } finally {
      post({
        type:       'backend_span',
        service:    PROCESS_NAME,
        route:      req.url ?? '/',
        method:     (req.method ?? 'GET').toUpperCase(),
        statusCode: res.statusCode,
        durationMs: Date.now() - startMs,
        traceId,
        spanId,
        sdk:        'node',
        timestamp:  startMs,
      });
    }
  };
}
