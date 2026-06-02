/**
 * sdk/node.js — Mergen Node.js SDK
 *
 * Drop-in instrumentation for any Node.js process. Works with Express,
 * Fastify, NestJS, Next.js SSR, plain scripts, or any backend service.
 *
 * Usage — zero code change:
 *   node --require mergen-server/sdk/node app.js
 *
 * Usage — in code (import once at the top of your entry point):
 *   require('mergen-server/sdk/node')
 *
 * What gets instrumented automatically:
 *   • console.log / warn / error  → captured and sent as console events
 *   • http.request / https.request → status + duration + traceparent injection
 *   • globalThis.fetch (Node 18+) → same as above
 *   • uncaughtException + unhandledRejection → captured as error events
 *
 * Config (env vars, all optional):
 *   MERGEN_PORT=3000       default: 3000
 *   MERGEN_SECRET=...      must match server's MERGEN_SECRET if set
 *   MERGEN_NAME=backend    process label shown in get_process_logs and get_unified_timeline
 */

'use strict';

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const path   = require('path');

// ── Config ─────────────────────────────────────────────────────────────────────

const MERGEN_PORT   = parseInt(process.env.MERGEN_PORT ?? '3000', 10);
const MERGEN_HOST   = process.env.MERGEN_HOST   ?? '127.0.0.1';
// Docker / k8s: set MERGEN_HOST=host.docker.internal so the container can
// reach the Mergen server running on the host machine.
const MERGEN_SECRET = process.env.MERGEN_SECRET ?? null;
const PROCESS_NAME  = process.env.MERGEN_NAME   ?? _resolveProcessName();

// Pseudo-URL used as the "url" field on events so the server and MCP tools
// can distinguish Node events from browser tab events.
const PROCESS_URL = `mergen://node/${PROCESS_NAME}`;

function _resolveProcessName() {
  try {
    const pkg = require(path.join(process.cwd(), 'package.json'));
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch { /* no package.json */ }
  try {
    if (process.argv[1]) return path.basename(process.argv[1], path.extname(process.argv[1]));
  } catch { /* ignore */ }
  return 'node';
}

// ── Internal poster ─────────────────────────────────────────────────────────────
// Captured BEFORE any patching so Mergen's own posts never go through the
// instrumented http.request (no infinite loops).

const _origHttpRequest = http.request.bind(http);

function _post(event) {
  try {
    const body    = JSON.stringify(event);
    const headers = {
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
  } catch { /* serialization error or server down — never crash the host */ }
}

// ── Trace context ───────────────────────────────────────────────────────────────

function _traceCtx() {
  const buf     = crypto.randomBytes(24);
  const traceId = buf.slice(0,  16).toString('hex'); // 32 hex chars
  const spanId  = buf.slice(16, 24).toString('hex'); // 16 hex chars
  return { header: `00-${traceId}-${spanId}-01`, traceId };
}

// ── Recursion guard ─────────────────────────────────────────────────────────────
// Don't instrument Mergen's own posts to 127.0.0.1:MERGEN_PORT.

function _isMergenHost(hostname, port) {
  const rightPort = Number(port || 0) === MERGEN_PORT;
  const isLocal   = hostname === '127.0.0.1' || hostname === 'localhost';
  return rightPort && (isLocal || hostname === MERGEN_HOST);
}

function _extractHost(urlOrOpts) {
  try {
    if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) {
      const u = new URL(urlOrOpts instanceof URL ? urlOrOpts.href : urlOrOpts);
      return { hostname: u.hostname, port: u.port };
    }
    if (urlOrOpts && typeof urlOrOpts === 'object') {
      return {
        hostname: urlOrOpts.hostname ?? (urlOrOpts.host ?? '').split(':')[0],
        port:     String(urlOrOpts.port ?? ''),
      };
    }
  } catch { /* ignore */ }
  return { hostname: '', port: '' };
}

// ── Console patching ────────────────────────────────────────────────────────────

const _origConsole = {
  log:   console.log.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
};

function _safeArg(a) {
  if (a === null || a === undefined) return String(a);
  if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return a;
  if (a instanceof Error) return { __error__: true, name: a.name, message: a.message, stack: a.stack ?? '' };
  try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); }
}

['log', 'warn', 'error'].forEach((level) => {
  console[level] = function mergenConsole(...args) {
    _origConsole[level].apply(console, args);
    try {
      const stack = level === 'error'
        ? new Error().stack?.split('\n').slice(2).join('\n')
        : undefined;
      _post({
        type:      'console',
        level,
        args:      args.map(_safeArg),
        stack,
        url:       PROCESS_URL,
        timestamp: Date.now(),
      });
    } catch { /* never crash */ }
  };
});

// ── HTTP / HTTPS request patching ───────────────────────────────────────────────
// Injects traceparent on all outbound requests except those to the Mergen server.
// Captures status + duration on response close WITHOUT consuming the body —
// safe for all callers regardless of streaming/buffering strategy.

function _buildNetworkEvent(method, urlStr, startTime, statusCode, statusText, traceId, error) {
  const ev = {
    type:      'network',
    method,
    url:       urlStr,
    status:    statusCode ?? 0,
    statusText: statusText ?? '',
    duration:  Date.now() - startTime,
    timestamp: startTime,
  };
  if (traceId) ev.traceId = traceId;
  if (error)   ev.error   = error;
  return ev;
}

function _wrapRequest(mod, origReq) {
  return function mergenRequest(urlOrOpts, optsOrCb, cb) {
    const { hostname, port } = _extractHost(urlOrOpts);
    if (_isMergenHost(hostname, port)) return origReq(urlOrOpts, optsOrCb, cb);

    const ctx       = _traceCtx();
    let   urlStr    = '';
    let   method    = 'GET';

    // Build a loggable URL and method
    try {
      if (typeof urlOrOpts === 'string') {
        urlStr = urlOrOpts;
      } else if (urlOrOpts instanceof URL) {
        urlStr = urlOrOpts.href;
      } else if (urlOrOpts && typeof urlOrOpts === 'object') {
        const proto = urlOrOpts.protocol ?? (mod === https ? 'https:' : 'http:');
        const host  = hostname;
        const p     = port ? `:${port}` : '';
        urlStr = `${proto}//${host}${p}${urlOrOpts.path ?? '/'}`;
        if (urlOrOpts.method) method = urlOrOpts.method.toUpperCase();
      }
      if (typeof optsOrCb === 'object' && optsOrCb !== null && typeof optsOrCb !== 'function') {
        if (optsOrCb.method) method = optsOrCb.method.toUpperCase();
      }
    } catch { /* ignore */ }

    // Inject traceparent — patch whichever argument carries headers
    let arg0 = urlOrOpts;
    let arg1 = optsOrCb;
    try {
      if (typeof urlOrOpts === 'object' && !(urlOrOpts instanceof URL)) {
        // options-only call: http.request({ hostname, headers, ... }, cb)
        arg0 = { ...urlOrOpts, headers: { ...urlOrOpts.headers, traceparent: ctx.header } };
      } else if (typeof optsOrCb === 'object' && optsOrCb !== null && typeof optsOrCb !== 'function') {
        // URL + options call: http.request(url, { headers, ... }, cb)
        arg1 = { ...optsOrCb, headers: { ...optsOrCb.headers, traceparent: ctx.header } };
      }
      // URL-only call (http.request(url, cb)): no options object to inject into
    } catch { /* injection failed — proceed without traceparent */ }

    const startTime = Date.now();
    let req;
    try {
      req = origReq(arg0, arg1, cb);
    } catch (err) {
      _post(_buildNetworkEvent(method, urlStr, startTime, 0, '', ctx.traceId, err.message));
      throw err;
    }

    // Attach non-consuming response capture
    req.on('response', (res) => {
      const statusCode = res.statusCode;
      const statusText = res.statusMessage ?? '';
      // 'close' fires after the caller fully consumes the response stream.
      // We never call res.read() / res.resume() so the caller's stream is untouched.
      res.on('close', () => {
        _post(_buildNetworkEvent(method, urlStr, startTime, statusCode, statusText, ctx.traceId, null));
      });
    });

    req.on('error', (err) => {
      _post(_buildNetworkEvent(method, urlStr, startTime, 0, '', ctx.traceId, err.message));
    });

    return req;
  };
}

const _origHttpsRequest = https.request.bind(https);
http.request  = _wrapRequest(http,  _origHttpRequest);
https.request = _wrapRequest(https, _origHttpsRequest);

// ── Global fetch (Node 18+) ─────────────────────────────────────────────────────

if (typeof globalThis.fetch === 'function') {
  const _origFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function mergenFetch(input, init) {
    const url    = typeof input === 'string' ? input
                 : (input instanceof URL ? input.href : (input?.url ?? ''));
    const method = ((init?.method) ?? (input?.method) ?? 'GET').toUpperCase();

    const parsed = (() => { try { return new URL(url); } catch { return null; } })();
    if (parsed && _isMergenHost(parsed.hostname, parsed.port)) {
      return _origFetch(input, init);
    }

    const ctx = _traceCtx();
    let patchedInit = init;
    try {
      const hdrs = new Headers(init?.headers ?? {});
      if (!hdrs.has('traceparent')) hdrs.set('traceparent', ctx.header);
      patchedInit = { ...init, headers: hdrs };
    } catch { /* inject failed — proceed without traceparent */ }

    const startTime = Date.now();
    try {
      const response = await _origFetch(input, patchedInit);
      _post(_buildNetworkEvent(method, url, startTime, response.status, response.statusText, ctx.traceId, null));
      return response;
    } catch (err) {
      _post(_buildNetworkEvent(method, url, startTime, 0, '', ctx.traceId, err instanceof Error ? err.message : String(err)));
      throw err;
    }
  };
}

// ── Crash capture ───────────────────────────────────────────────────────────────
// uncaughtExceptionMonitor is read-only (Node 13+) — fires before the default
// crash handler, doesn't suppress it. Safe to add unconditionally.
//
// unhandledRejection: in Node 15+ the process still exits after all listeners
// have been called, so adding this listener doesn't change crash behavior.

process.on('uncaughtExceptionMonitor', (err) => {
  try {
    _post({
      type: 'console', level: 'error',
      args:  [`[uncaughtException] ${err.message}`],
      stack: err.stack,
      url:   PROCESS_URL,
      timestamp: Date.now(),
    });
  } catch { /* ignore */ }
});

process.on('unhandledRejection', (reason) => {
  try {
    const message = reason instanceof Error ? reason.message : String(reason ?? 'unhandled rejection');
    const stack   = reason instanceof Error ? reason.stack   : undefined;
    _post({
      type: 'console', level: 'error',
      args:  [`[unhandledRejection] ${message}`],
      stack,
      url:   PROCESS_URL,
      timestamp: Date.now(),
    });
  } catch { /* ignore */ }
});

// ── Ready ───────────────────────────────────────────────────────────────────────
_origConsole.log(`[Mergen] Node SDK active — ${PROCESS_NAME} → http://${MERGEN_HOST}:${MERGEN_PORT}`);
