/**
 * Mergen DevTools Snippet — zero-install alternative to the browser extension.
 *
 * HOW TO USE (no extension install required):
 *   1. Open DevTools in Chrome or Firefox  (F12 / Cmd+Option+I)
 *   2. Click the Console tab
 *   3. Paste this entire file and press Enter
 *   4. You'll see: "[Mergen] DevTools snippet active"
 *   5. Ask your AI: "Get recent logs"
 *
 * Works on any page you're developing on. Reloading the page clears it —
 * paste again or add it as a DevTools Snippet (Sources → Snippets) to persist.
 *
 * Optional: set port before pasting if your server isn't on 3000:
 *   var MERGEN_PORT = 3001;
 */
(function mergenDevTools() {
  'use strict';

  var port   = (typeof MERGEN_PORT   !== 'undefined' ? MERGEN_PORT   : 3000);
  var secret = (typeof MERGEN_SECRET !== 'undefined' ? MERGEN_SECRET : null);
  var base   = 'http://127.0.0.1:' + port + '/ingest';

  if (window.__mergenActive) {
    console.info('[Mergen] already active on this page (port ' + window.__mergenPort + ')');
    return;
  }
  window.__mergenActive = true;
  window.__mergenPort   = port;

  function post(payload) {
    try {
      var h = { 'Content-Type': 'application/json' };
      if (secret) h['x-mergen-secret'] = secret;
      fetch(base, { method: 'POST', headers: h, body: JSON.stringify(payload) }).catch(function () {});
    } catch (e) {}
  }

  function safe(val) {
    try { return typeof val === 'object' && val !== null ? JSON.parse(JSON.stringify(val)) : val; }
    catch (e) { return String(val); }
  }

  // Patch console
  var _orig = {};
  ['log', 'warn', 'error'].forEach(function (level) {
    _orig[level] = console[level].bind(console);
    console[level] = function () {
      _orig[level].apply(console, arguments);
      try {
        post({
          type: 'console', level: level,
          args: Array.prototype.slice.call(arguments).map(safe),
          url: location.href, timestamp: Date.now(),
        });
      } catch (e) {}
    };
  });

  // Patch fetch
  var _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url    = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init && init.method ? init.method : 'GET').toUpperCase();
    var t0     = Date.now();
    return _origFetch(input, init).then(function (res) {
      var dur = Date.now() - t0;
      res.clone().text().then(function (body) {
        post({ type: 'network', method: method, url: url, status: res.status, statusText: res.statusText, duration: dur, responseBody: body.slice(0, 2000), timestamp: t0 });
      }).catch(function () {
        post({ type: 'network', method: method, url: url, status: res.status, statusText: res.statusText, duration: dur, timestamp: t0 });
      });
      return res;
    }, function (err) {
      post({ type: 'network', method: method, url: url, status: 0, statusText: '', duration: Date.now() - t0, error: err ? (err.message || String(err)) : 'network error', timestamp: t0 });
      throw err;
    });
  };

  // Patch XHR (for older libraries)
  var _XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var xhr   = new _XHR();
    var _open = xhr.open.bind(xhr);
    var _url, _method, _t0;
    xhr.open = function (method, url) { _method = method; _url = url; _t0 = Date.now(); return _open.apply(xhr, arguments); };
    xhr.addEventListener('loadend', function () {
      try {
        post({ type: 'network', method: (_method || 'GET').toUpperCase(), url: _url || '', status: xhr.status, statusText: xhr.statusText, duration: Date.now() - (_t0 || Date.now()), responseBody: (xhr.responseText || '').slice(0, 2000), timestamp: _t0 || Date.now() });
      } catch (e) {}
    });
    return xhr;
  };

  _orig.log('[Mergen] DevTools snippet active — streaming to http://127.0.0.1:' + port);
  _orig.log('[Mergen] Ask your AI: "Get recent logs"');
})();
