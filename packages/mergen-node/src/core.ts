/**
 * core.ts — Internal poster and trace context utilities.
 * Zero runtime dependencies — uses only Node.js built-ins.
 *
 * Captured BEFORE any patching so Mergen's own HTTP posts never
 * go through instrumented http.request (no infinite loops).
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as path from 'path';

export const MERGEN_PORT   = parseInt(process.env['MERGEN_PORT']   ?? '3000', 10);
export const MERGEN_HOST   = process.env['MERGEN_HOST']   ?? '127.0.0.1';
export const MERGEN_SECRET = process.env['MERGEN_SECRET'] ?? null;
export const PROCESS_NAME  = process.env['MERGEN_NAME']   ?? resolveProcessName();
export const PROCESS_URL   = `mergen://node/${PROCESS_NAME}`;

function resolveProcessName(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(process.cwd(), 'package.json')) as { name?: string };
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch { /* no package.json */ }
  try {
    if (process.argv[1]) return path.basename(process.argv[1], path.extname(process.argv[1]));
  } catch { /* ignore */ }
  return 'node';
}

// Capture native http.request BEFORE any patching to avoid self-instrumentation loops.
const _origHttpRequest = http.request.bind(http);

export function post(event: Record<string, unknown>): void {
  try {
    const body    = JSON.stringify(event);
    const headers: Record<string, string | number> = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (MERGEN_SECRET) headers['x-mergen-secret'] = MERGEN_SECRET;

    const req = _origHttpRequest({
      hostname: MERGEN_HOST,
      port:     MERGEN_PORT,
      path:     '/ingest',
      method:   'POST',
      headers,
    });
    req.on('error', () => {}); // server not running — silently ignore
    req.end(body);
  } catch { /* never crash the host process */ }
}

export interface TraceContext {
  traceId: string;
  spanId:  string;
  header:  string; // full W3C traceparent header value
}

export function generateTraceContext(): TraceContext {
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId  = crypto.randomBytes(8).toString('hex');
  return { traceId, spanId, header: `00-${traceId}-${spanId}-01` };
}

export function extractTraceId(traceparent: string | undefined): string | null {
  if (!traceparent) return null;
  const parts = traceparent.split('-');
  return parts.length >= 4 && parts[1] && /^[0-9a-f]{32}$/.test(parts[1]) ? parts[1] : null;
}

export function extractSpanId(traceparent: string | undefined): string | null {
  if (!traceparent) return null;
  const parts = traceparent.split('-');
  return parts.length >= 4 && parts[2] && /^[0-9a-f]{16}$/.test(parts[2]) ? parts[2] : null;
}

// Re-export for SDK consumers
export { http, https };
