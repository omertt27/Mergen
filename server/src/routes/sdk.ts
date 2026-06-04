/**
 * sdk.ts — Serves @mergen/browser as a self-contained JavaScript file.
 *
 * Any frontend can instrument itself with one line — no npm install, no build step:
 *
 *   <script src="http://localhost:3000/sdk.js"></script>
 *
 * The script auto-initialises with sensible defaults (endpoint=origin, service=hostname).
 * Enterprise teams add this to their base HTML template or nginx config once;
 * every developer's browser is instantly instrumented.
 *
 * Query params:
 *   ?service=my-app     — override service name (default: window.location.hostname)
 *   ?autoInit=false     — load the SDK but don't call init() — call Mergen.init() manually
 *   ?endpoint=<url>     — override the Mergen server endpoint (default: request origin)
 *
 * CORS: served with wildcard Allow-Origin so any page can load it via <script>.
 */

import { Router, type Request, type Response } from 'express';

export function createSdkRouter(): Router {
  const router = Router();

  router.get('/sdk.js', (req: Request, res: Response): void => {
    const autoInit = req.query['autoInit'] !== 'false';
    const service  = typeof req.query['service'] === 'string' ? req.query['service'] : null;
    const endpoint = typeof req.query['endpoint'] === 'string' ? req.query['endpoint'] : null;

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // 60 s cache — short enough that config changes apply quickly, long enough to avoid hammering
    res.setHeader('Cache-Control', 'public, max-age=60');

    res.send(buildSdkSource({ autoInit, service, endpoint }));
  });

  return router;
}

// ── SDK source ─────────────────────────────────────────────────────────────────
// Self-contained IIFE. No external dependencies. Same logic as
// packages/mergen-browser/src/* but compiled to a single browser-compatible file.

function buildSdkSource(opts: { autoInit: boolean; service: string | null; endpoint: string | null }): string {
  const serviceExpr = opts.service
    ? JSON.stringify(opts.service)
    : `(typeof location !== 'undefined' ? location.hostname : 'browser')`;
  const endpointExpr = opts.endpoint
    ? JSON.stringify(opts.endpoint)
    : `(typeof location !== 'undefined' ? location.origin : 'http://localhost:3000')`;

  return `
/* @mergen/browser — auto-served by Mergen server */
/* Add to any page: <script src="http://localhost:3000/sdk.js"></script> */
(function(global) {
  'use strict';
  if (global.Mergen && global.Mergen._active) return; // idempotent

  // ── Utilities ────────────────────────────────────────────────────────────
  function randomHex(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function msToNano(ms) {
    return String(BigInt(Math.round(ms)) * 1000000n);
  }

  function attr(k, v) { return { key: k, value: { stringValue: v } }; }

  function post(url, body, onError) {
    var json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon) {
        if (navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }))) return;
      }
    } catch(e) {}
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true })
      .catch(function() { if (onError) onError(); });
  }

  // ── Mergen public API ─────────────────────────────────────────────────────
  var Mergen = {
    _active: false,
    _teardowns: [],
    _endpoint: ${endpointExpr},
    _service: ${serviceExpr},
    _resource: null,

    init: function(cfg) {
      if (this._active) return this;
      cfg = cfg || {};
      this._endpoint = cfg.endpoint || this._endpoint;
      this._service  = cfg.service  || this._service;
      this._resource = { attributes: [attr('service.name', this._service)] };

      if (cfg.captureConsole !== false) this._patchConsole();
      if (cfg.captureNetwork !== false) { this._patchFetch(); this._patchXHR(); }
      this._active = true;
      return this;
    },

    shutdown: function() {
      this._teardowns.forEach(function(fn) { fn(); });
      this._teardowns = [];
      this._active = false;
    },

    // ── Console patch ───────────────────────────────────────────────────────
    _patchConsole: function() {
      var self = this;
      var levels = ['log', 'warn', 'error'];
      var originals = {};
      var severities = { log: 9, warn: 13, error: 17 };

      levels.forEach(function(level) {
        originals[level] = console[level].bind(console);
        console[level] = function() {
          originals[level].apply(console, arguments);
          try {
            var args = Array.from(arguments);
            var body = args.map(function(a) {
              if (typeof a === 'string') return a;
              if (a instanceof Error) return a.name + ': ' + a.message;
              try { return JSON.stringify(a); } catch(e) { return String(a); }
            }).join(' ');
            if (body.indexOf('/v1/') !== -1) return;
            var stack = (level === 'error' && args[0] instanceof Error) ? args[0].stack : null;
            self._sendLog(severities[level] || 9, level.toUpperCase(), body, stack);
          } catch(e) {}
        };
      });

      this._teardowns.push(function() {
        levels.forEach(function(level) { console[level] = originals[level]; });
      });
    },

    _sendLog: function(severityNumber, severityText, body, stack) {
      var attrs = [attr('browser.url', typeof location !== 'undefined' ? location.href : '')];
      if (stack) attrs.push(attr('exception.stacktrace', stack.slice(0, 2000)));
      post(this._endpoint + '/v1/logs', {
        resourceLogs: [{ resource: this._resource, scopeLogs: [{ logRecords: [{
          timeUnixNano: msToNano(Date.now()),
          severityNumber: severityNumber,
          severityText: severityText,
          body: { stringValue: body },
          attributes: attrs
        }] }] }]
      });
    },

    // ── Fetch patch ─────────────────────────────────────────────────────────
    _patchFetch: function() {
      if (typeof fetch === 'undefined') return;
      var self = this;
      var _orig = window.fetch.bind(window);

      window.fetch = function(input, init) {
        var url    = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input.url || ''));
        var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        var traceId = randomHex(16);
        var spanId  = randomHex(8);
        var startMs = Date.now();
        var tp = '00-' + traceId + '-' + spanId + '-01';

        var headers = new Headers((init && init.headers) || (input && !(typeof input === 'string') && !(input instanceof URL) ? input.headers : null) || {});
        headers.set('traceparent', tp);
        var pInit = Object.assign({}, init || {}, { headers: headers });
        var pInput = (typeof input === 'string' || input instanceof URL) ? input : new Request(input, pInit);

        return _orig(pInput, typeof pInput === 'string' || pInput instanceof URL ? pInit : undefined).then(
          function(resp) {
            self._sendSpan(traceId, spanId, method, url, startMs, Date.now(), resp.status, resp.ok ? null : (resp.statusText || 'HTTP ' + resp.status));
            return resp;
          },
          function(err) {
            self._sendSpan(traceId, spanId, method, url, startMs, Date.now(), 0, err.message || 'NetworkError');
            throw err;
          }
        );
      };

      this._teardowns.push(function() { window.fetch = _orig; });
    },

    _sendSpan: function(traceId, spanId, method, url, startMs, endMs, status, error) {
      var isErr = status >= 400 || !!error;
      try {
        var pathname = new URL(url, typeof location !== 'undefined' ? location.href : undefined).pathname;
        post(this._endpoint + '/v1/traces', {
          resourceSpans: [{ resource: this._resource, scopeSpans: [{ spans: [{
            traceId: traceId, spanId: spanId,
            name: method + ' ' + pathname,
            kind: 3, // CLIENT
            startTimeUnixNano: msToNano(startMs),
            endTimeUnixNano:   msToNano(endMs),
            status: { code: isErr ? 2 : 1, message: error || '' },
            attributes: [
              attr('http.method', method),
              attr('http.url', url),
              attr('http.status_code', String(status))
            ]
          }] }] }]
        });
      } catch(e) {}
    },

    // ── XHR patch ───────────────────────────────────────────────────────────
    _patchXHR: function() {
      if (typeof XMLHttpRequest === 'undefined') return;
      var self = this;
      var _origOpen = XMLHttpRequest.prototype.open;
      var _origSend = XMLHttpRequest.prototype.send;
      var _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      var meta = new WeakMap();

      XMLHttpRequest.prototype.open = function(method, url) {
        meta.set(this, { method: method.toUpperCase(), url: String(url), traceId: randomHex(16), spanId: randomHex(8), startMs: 0 });
        return _origOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        var m = meta.get(this);
        if (m) {
          m.startMs = Date.now();
          try { _origSetHeader.call(this, 'traceparent', '00-' + m.traceId + '-' + m.spanId + '-01'); } catch(e) {}
          var xhr = this;
          this.addEventListener('loadend', function() {
            self._sendSpan(m.traceId, m.spanId, m.method, m.url, m.startMs, Date.now(),
              xhr.status, xhr.status >= 400 ? (xhr.statusText || 'HTTP ' + xhr.status) : null);
          }, { once: true });
        }
        return _origSend.call(this, body);
      };

      this._teardowns.push(function() {
        XMLHttpRequest.prototype.open = _origOpen;
        XMLHttpRequest.prototype.send = _origSend;
      });
    }
  };

  global.Mergen = Mergen;

${opts.autoInit ? `  // Auto-init with defaults (pass ?autoInit=false to disable)
  Mergen.init({ endpoint: ${endpointExpr}, service: ${serviceExpr} });` : `  // Auto-init disabled — call Mergen.init() manually`}

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
/* Mergen SDK loaded. Type Mergen in the console to inspect the instance. */
`.trim();
}
