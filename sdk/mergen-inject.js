/**
 * mergen-inject.js — Mergen universal JS SDK
 *
 * Streams console, network, and crash events to the local Mergen server.
 * Works in:
 *   - React Native  (import './mergen-inject.js' at app entry)
 *   - Mobile webviews (inject via evaluateJavaScript)
 *   - Any JS environment with fetch or XMLHttpRequest
 *
 * Usage (React Native):
 *   import './mergen-inject.js';  // top of index.js — patches console + fetch globally
 *
 * Usage (webview):
 *   webView.evaluateJavaScript(fs.readFileSync('mergen-inject.js', 'utf8'));
 *
 * Config (optional — set before importing):
 *   global.mergenConfig = { port: 3000, secret: 'your-secret', name: 'my-app' };
 */
(function mergenInject(opts) {
  'use strict';

  var port    = (opts && opts.port)    || (typeof MERGEN_PORT   !== 'undefined' ? MERGEN_PORT   : 3000);
  var secret  = (opts && opts.secret)  || (typeof MERGEN_SECRET !== 'undefined' ? MERGEN_SECRET : null);
  var appName = (opts && opts.name)    || (typeof MERGEN_NAME   !== 'undefined' ? MERGEN_NAME   : 'rn-app');
  var base    = 'http://127.0.0.1:' + port + '/ingest';
  var appUrl  = 'mergen://rn/' + appName;

  // ── Safe serialiser ───────────────────────────────────────────────────────────

  function safeArg(val) {
    if (val === null || val === undefined) return String(val);
    var t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') return val;
    if (val instanceof Error || (val && t === 'object' && typeof val.message === 'string' && typeof val.stack === 'string')) {
      return { __error__: true, name: val.name || 'Error', message: val.message, stack: val.stack || '' };
    }
    try { return JSON.parse(JSON.stringify(val)); } catch (e) { return String(val); }
  }

  // ── Internal poster (fire-and-forget) ─────────────────────────────────────────

  function post(event) {
    try {
      var body    = JSON.stringify(event);
      var headers = { 'Content-Type': 'application/json' };
      if (secret) headers['x-mergen-secret'] = secret;

      if (typeof fetch !== 'undefined') {
        // Use _nativeFetch if available (after fetch patching below), else raw fetch
        var poster = typeof _nativeFetch !== 'undefined' ? _nativeFetch : fetch;
        poster(base, { method: 'POST', headers: headers, body: body }).catch(function () {});
        return;
      }
      if (typeof XMLHttpRequest !== 'undefined') {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', base, true);
        for (var h in headers) if (Object.prototype.hasOwnProperty.call(headers, h)) {
          xhr.setRequestHeader(h, headers[h]);
        }
        xhr.send(body);
      }
    } catch (e) { /* never break the host app */ }
  }

  // ── Traceparent generation ─────────────────────────────────────────────────────
  // Uses crypto.getRandomValues when available (browser/RN), falls back to Math.random.

  function generateTraceContext() {
    try {
      var bytes = new Uint8Array(24);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      var hex = Array.prototype.map.call(bytes, function(b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
      var traceId = hex.slice(0, 32);
      var spanId  = hex.slice(32, 48);
      return { header: '00-' + traceId + '-' + spanId + '-01', traceId: traceId };
    } catch (e) { return null; }
  }

  function isSameOriginOrLocal(url) {
    try {
      if (!url || url.charAt(0) === '/') return true;
      var parsed = new URL(url);
      var h = parsed.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1';
    } catch (e) { return false; }
  }

  // ── Console patching ───────────────────────────────────────────────────────────

  var _origConsole = {};
  ['log', 'warn', 'error'].forEach(function (level) {
    _origConsole[level] = console[level] && console[level].bind
      ? console[level].bind(console)
      : console[level];

    console[level] = function mergenConsole() {
      if (_origConsole[level]) _origConsole[level].apply(console, arguments);
      try {
        var args = Array.prototype.slice.call(arguments).map(safeArg);
        var stack;
        if (level === 'error') {
          try { stack = new Error().stack.split('\n').slice(2).join('\n'); } catch (e) {}
        }
        post({
          type:      'console',
          level:     level,
          args:      args,
          stack:     stack,
          url:       appUrl,
          timestamp: Date.now(),
        });
      } catch (e) {}
    };
  });

  // ── Fetch patching ─────────────────────────────────────────────────────────────

  var _globalObj = typeof globalThis !== 'undefined' ? globalThis
                 : typeof global     !== 'undefined' ? global
                 : typeof window     !== 'undefined' ? window
                 : {};

  var _nativeFetch = typeof _globalObj.fetch === 'function'
    ? _globalObj.fetch.bind(_globalObj)
    : null;

  if (_nativeFetch) {
    _globalObj.fetch = function mergenFetch(input, init) {
      var url       = typeof input === 'string' ? input : (input && input.url) || '';
      var method    = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var startTime = Date.now();

      // Inject traceparent on local/same-origin requests
      var ctx     = isSameOriginOrLocal(url) ? generateTraceContext() : null;
      var useInit = init;
      if (ctx) {
        try {
          var existingHdrs = (init && init.headers) || (input && typeof input === 'object' && input.headers);
          var newHdrs = new Headers(existingHdrs || {});
          if (!newHdrs.has('traceparent')) newHdrs.set('traceparent', ctx.header);
          useInit = Object.assign({}, init || {}, { headers: newHdrs });
        } catch (e) { useInit = init; }
      }

      return _nativeFetch(input, useInit).then(function (response) {
        var duration = Date.now() - startTime;
        var traceId  = (ctx && ctx.traceId) || null;

        // Try to read traceId from response headers if we didn't inject one
        if (!traceId) {
          try {
            var tp = response.headers.get('traceparent');
            if (tp) { var tparts = tp.split('-'); if (tparts.length >= 4) traceId = tparts[1]; }
            if (!traceId) {
              traceId = response.headers.get('x-trace-id')
                     || response.headers.get('x-request-id')
                     || response.headers.get('x-correlation-id')
                     || null;
            }
            if (traceId) traceId = traceId.slice(0, 64);
          } catch (e) {}
        }

        var ev = {
          type:       'network',
          method:     method,
          url:        url,
          status:     response.status,
          statusText: response.statusText || '',
          duration:   duration,
          timestamp:  startTime,
        };
        if (traceId) ev.traceId = traceId;

        // Clone + read body only for non-streaming responses under 50KB
        try {
          response.clone().text().then(function (body) {
            var ct = response.headers.get('content-type') || '';
            ev.responseBody = ct.indexOf('application/json') !== -1
              ? (function() { try { return JSON.parse(body); } catch(e) { return body.slice(0, 500); } })()
              : body.slice(0, 500);
            post(ev);
          }).catch(function () { post(ev); });
        } catch (e) { post(ev); }

        return response;

      }, function (err) {
        post({
          type:      'network',
          method:    method,
          url:       url,
          status:    0,
          statusText: '',
          duration:  Date.now() - startTime,
          error:     err ? (err.message || String(err)) : 'network error',
          timestamp: startTime,
        });
        throw err;
      });
    };
  }

  // ── Crash capture (React Native) ───────────────────────────────────────────────
  // React Native exposes ErrorUtils for global error handling.
  // This is the RN equivalent of window.onerror.

  try {
    if (typeof ErrorUtils !== 'undefined' && ErrorUtils.setGlobalHandler) {
      var _prevHandler = ErrorUtils.getGlobalHandler && ErrorUtils.getGlobalHandler();
      ErrorUtils.setGlobalHandler(function mergenErrorHandler(err, isFatal) {
        try {
          post({
            type:      'console',
            level:     'error',
            args:      ['[' + (isFatal ? 'fatal' : 'error') + '] ' + (err && err.message ? err.message : String(err))],
            stack:     err && err.stack ? err.stack : undefined,
            url:       appUrl,
            timestamp: Date.now(),
          });
        } catch (e) {}
        if (_prevHandler) _prevHandler(err, isFatal);
      });
    }
  } catch (e) { /* ErrorUtils not available — browser or non-RN env */ }

  // ── Unhandled promise rejections ───────────────────────────────────────────────

  try {
    var _prevOnUnhandledRejection = _globalObj.onunhandledrejection;
    _globalObj.onunhandledrejection = function mergenUnhandledRejection(event) {
      try {
        var reason  = event && event.reason;
        var message = reason instanceof Error ? reason.message : String(reason || 'unhandled rejection');
        var stack   = reason instanceof Error ? reason.stack   : undefined;
        post({
          type:      'console',
          level:     'error',
          args:      ['[unhandledRejection] ' + message],
          stack:     stack,
          url:       appUrl,
          timestamp: Date.now(),
        });
      } catch (e) {}
      if (_prevOnUnhandledRejection) _prevOnUnhandledRejection(event);
    };
  } catch (e) { /* ignore */ }

  // ── Ready ──────────────────────────────────────────────────────────────────────
  if (_origConsole.log) {
    _origConsole.log('[Mergen] SDK active (' + appName + ') → http://127.0.0.1:' + port);
  }

})(typeof mergenConfig !== 'undefined' ? mergenConfig : {});
