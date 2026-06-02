/**
 * mergen-inject.js — Zero-dependency Mergen SDK
 *
 * Streams console and network events to the local Mergen server.
 * Works in:
 *   - React Native (import and call mergenInit())
 *   - Mobile webviews (inject via evaluateJavaScript / stringByEvaluatingJavaScript)
 *   - Any JS environment with fetch or XMLHttpRequest
 *
 * Usage (React Native):
 *   import './mergen-inject.js';  // patches console + fetch globally
 *
 * Usage (webview):
 *   webView.evaluateJavaScript(fs.readFileSync('mergen-inject.js', 'utf8'));
 *
 * Configuration (optional — set before importing):
 *   global.mergenConfig = { port: 3000, secret: 'your-secret' };
 */
(function mergenInject(opts) {
  'use strict';

  var port   = (opts && opts.port)   || (typeof MERGEN_PORT   !== 'undefined' ? MERGEN_PORT   : 3000);
  var secret = (opts && opts.secret) || (typeof MERGEN_SECRET !== 'undefined' ? MERGEN_SECRET : null);
  var base   = 'http://127.0.0.1:' + port + '/ingest';

  function safeStringify(val) {
    try { return typeof val === 'object' && val !== null ? JSON.parse(JSON.stringify(val)) : val; }
    catch (e) { return String(val); }
  }

  function post(payload) {
    try {
      var body    = JSON.stringify(payload);
      var headers = { 'Content-Type': 'application/json' };
      if (secret) headers['x-mergen-secret'] = secret;

      if (typeof fetch !== 'undefined') {
        fetch(base, { method: 'POST', headers: headers, body: body }).catch(function () {});
        return;
      }
      if (typeof XMLHttpRequest !== 'undefined') {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', base, true);
        for (var h in headers) xhr.setRequestHeader(h, headers[h]);
        xhr.send(body);
      }
    } catch (e) { /* never break the host app */ }
  }

  // ── Patch console.log / warn / error ────────────────────────────────────────
  var _origConsole = {};
  ['log', 'warn', 'error'].forEach(function (level) {
    _origConsole[level] = console[level] && console[level].bind ? console[level].bind(console) : console[level];
    console[level] = function () {
      if (_origConsole[level]) _origConsole[level].apply(console, arguments);
      try {
        post({
          type:      'console',
          level:     level,
          args:      Array.prototype.slice.call(arguments).map(safeStringify),
          url:       (typeof window !== 'undefined' && window.location && window.location.href) || 'mergen://sdk',
          timestamp: Date.now(),
        });
      } catch (e) {}
    };
  });

  // ── Patch fetch ──────────────────────────────────────────────────────────────
  var _globalObj = typeof globalThis !== 'undefined' ? globalThis
                 : typeof global     !== 'undefined' ? global
                 : typeof window     !== 'undefined' ? window
                 : {};

  if (typeof _globalObj.fetch === 'function') {
    var _origFetch = _globalObj.fetch.bind(_globalObj);
    _globalObj.fetch = function mergenFetch(input, init) {
      var url       = typeof input === 'string' ? input : (input && input.url) || '';
      var method    = (init && init.method ? init.method : 'GET').toUpperCase();
      var startTime = Date.now();

      return _origFetch(input, init).then(function (response) {
        var duration = Date.now() - startTime;
        response.clone().text().then(function (body) {
          post({
            type:         'network',
            method:       method,
            url:          url,
            status:       response.status,
            statusText:   response.statusText || '',
            duration:     duration,
            responseBody: body.slice(0, 2000),
            timestamp:    startTime,
          });
        }).catch(function () {
          post({ type: 'network', method: method, url: url, status: response.status, statusText: response.statusText || '', duration: duration, timestamp: startTime });
        });
        return response;
      }, function (err) {
        post({
          type:      'network',
          method:    method,
          url:       url,
          status:    0,
          statusText:'',
          duration:  Date.now() - startTime,
          error:     err ? (err.message || String(err)) : 'network error',
          timestamp: startTime,
        });
        throw err;
      });
    };
  }

  // ── Done ─────────────────────────────────────────────────────────────────────
  if (typeof console !== 'undefined' && _origConsole.log) {
    _origConsole.log('[Mergen] SDK active — sending events to http://127.0.0.1:' + port);
  }

})(typeof mergenConfig !== 'undefined' ? mergenConfig : {});
