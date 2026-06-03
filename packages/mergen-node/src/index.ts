/**
 * mergen-node — Mergen Node.js SDK
 *
 * Drop-in instrumentation for any Node.js process.
 * Works with Express, Fastify, NestJS, Next.js SSR, plain scripts.
 *
 * Usage — zero code change (via --require):
 *   node --require mergen-node app.js
 *
 * Usage — explicit init in code:
 *   import 'mergen-node';        // auto-init on import
 *   // or
 *   import { init } from 'mergen-node';
 *   init({ port: 3000, name: 'api' });
 *
 * What gets instrumented automatically:
 *   • console.log / warn / error
 *   • http.request / https.request (outbound) — traceparent injection
 *   • globalThis.fetch (Node 18+)
 *   • uncaughtException + unhandledRejection
 *
 * Config (env vars, all optional):
 *   MERGEN_PORT=3000
 *   MERGEN_SECRET=...
 *   MERGEN_NAME=api-service
 */

import * as http  from 'http';
import * as https from 'https';
import { post, generateTraceContext, extractTraceId, PROCESS_URL, PROCESS_NAME } from './core.js';

export { post, generateTraceContext } from './core.js';
export { mergenMiddleware }           from './middleware/express.js';
export { withMergen }                 from './middleware/nextjs.js';

export interface InitOptions {
  port?:   number;
  host?:   string;
  secret?: string;
  name?:   string;
}

let _initialized = false;

export function init(_options?: InitOptions): void {
  if (_initialized) return;
  _initialized = true;
  _patchConsole();
  _patchHttp();
  _patchFetch();
  _registerGlobalHandlers();
}

// ── Auto-init when required/imported ────────────────────────────────────────
init();

// ── Console patching ─────────────────────────────────────────────────────────

function _patchConsole(): void {
  const levels = ['log', 'warn', 'error'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    (console[level] as unknown) = function (...args: unknown[]) {
      orig(...args);
      try {
        post({
          type:      'console',
          level,
          args:      args.map(a => typeof a === 'object' ? safeStringify(a) : a),
          stack:     level === 'error' ? new Error().stack?.slice(7) : undefined,
          url:       PROCESS_URL,
          timestamp: Date.now(),
          sdk:       'node',
        });
      } catch { /* never crash */ }
    };
  }
}

// ── HTTP/HTTPS outbound patching ─────────────────────────────────────────────

function _patchHttp(): void {
  _wrapRequest(http);
  _wrapRequest(https);
}

function _wrapRequest(mod: typeof http | typeof https): void {
  const orig = mod.request.bind(mod);
  (mod.request as unknown) = function (
    urlOrOptions: string | URL | http.RequestOptions,
    optionsOrCb?: http.RequestOptions | ((res: http.IncomingMessage) => void),
    cb?: (res: http.IncomingMessage) => void,
  ) {
    const startTime = Date.now();
    let options: http.RequestOptions = {};

    if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
      const u = typeof urlOrOptions === 'string' ? new URL(urlOrOptions) : urlOrOptions;
      options.hostname = u.hostname;
      options.port     = u.port || (u.protocol === 'https:' ? 443 : 80);
      options.path     = u.pathname + u.search;
      options.protocol = u.protocol;
      if (typeof optionsOrCb === 'object') Object.assign(options, optionsOrCb);
    } else {
      options = { ...urlOrOptions };
      if (typeof optionsOrCb === 'object') Object.assign(options, optionsOrCb);
    }

    // Skip Mergen's own ingest calls
    const isIngest = options.path?.startsWith('/ingest') || options.path?.startsWith('/health');
    if (!isIngest) {
      const tc = generateTraceContext();
      options.headers = { ...(options.headers ?? {}), traceparent: tc.header };
    }

    const actualCb = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    const req = orig(urlOrOptions as string, options, actualCb);

    if (!isIngest) {
      const urlStr = `${options.protocol ?? 'http:'}//${options.hostname}${options.port ? ':' + options.port : ''}${options.path ?? '/'}`;
      req.on('response', (res) => {
        const duration = Date.now() - startTime;
        const tp = res.headers['traceparent'] as string | undefined;
        const traceId = extractTraceId(tp) ??
          (res.headers['x-trace-id'] as string | undefined) ??
          (res.headers['x-request-id'] as string | undefined) ?? undefined;
        post({
          type:       'network',
          method:     (options.method ?? 'GET').toUpperCase(),
          url:        urlStr,
          status:     res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          duration,
          timestamp:  Date.now(),
          sdk:        'node',
          ...(traceId ? { traceId } : {}),
        });
      });
      req.on('error', (err) => {
        post({
          type:       'network',
          method:     (options.method ?? 'GET').toUpperCase(),
          url:        urlStr,
          status:     0,
          statusText: 'NetworkError',
          duration:   Date.now() - startTime,
          error:      err.message,
          timestamp:  Date.now(),
          sdk:        'node',
        });
      });
    }

    return req;
  };
}

// ── fetch patching (Node 18+) ─────────────────────────────────────────────────

function _patchFetch(): void {
  if (typeof globalThis.fetch !== 'function') return;
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;

    const isIngest = url.includes('/ingest') || url.includes('/health');
    if (isIngest) return origFetch(input, init);

    const tc = generateTraceContext();
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? {});
    if (!headers.has('traceparent')) headers.set('traceparent', tc.header);
    const patchedInit = { ...(init ?? {}), headers };

    const startTime = Date.now();
    try {
      const res = await origFetch(input, patchedInit);
      const duration = Date.now() - startTime;
      const tp = res.headers.get('traceparent') ?? undefined;
      const traceId = extractTraceId(tp) ?? tc.traceId;
      post({
        type: 'network', method: (init?.method ?? 'GET').toUpperCase(),
        url, status: res.status, statusText: res.statusText,
        duration, timestamp: Date.now(), sdk: 'node', traceId,
      });
      return res;
    } catch (err) {
      post({
        type: 'network', method: (init?.method ?? 'GET').toUpperCase(),
        url, status: 0, statusText: 'NetworkError',
        duration: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(), sdk: 'node',
      });
      throw err;
    }
  } as typeof fetch;
}

// ── Global error handlers ────────────────────────────────────────────────────

function _registerGlobalHandlers(): void {
  process.on('uncaughtException', (err) => {
    post({
      type: 'console', level: 'error',
      args: [`[uncaughtException] ${err.message}`],
      stack: err.stack,
      url: PROCESS_URL,
      timestamp: Date.now(),
      sdk: 'node',
    });
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    post({
      type: 'console', level: 'error',
      args: [`[unhandledRejection] ${msg}`],
      stack,
      url: PROCESS_URL,
      timestamp: Date.now(),
      sdk: 'node',
    });
  });

  process.on('exit', (code) => {
    if (code === 0) return;
    post({
      type: 'process_exit',
      process: PROCESS_NAME,
      exitCode: code,
      reason: 'crash',
      timestamp: Date.now(),
    });
  });
}

function safeStringify(val: unknown): string {
  try { return JSON.stringify(val); } catch { return String(val); }
}
