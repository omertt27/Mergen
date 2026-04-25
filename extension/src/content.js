/**
 * content.js — Mergen content script (self-contained, no imports)
 * Runs at document_start in every top-level frame.
 *
 * Safety contract: MUST NEVER throw or break the host page.
 * Every code path that could throw is wrapped in try/catch.
 */

(function mergenInit() {
  'use strict';

  const DEFAULT_PORT = 3000;
  let currentPort = DEFAULT_PORT;
  let muted = false;

  function getIngestUrl() {
    return `http://127.0.0.1:${currentPort}/ingest`;
  }

  // Load port from storage on startup
  try {
    chrome.storage.local.get('mergenPort', ({ mergenPort }) => {
      if (mergenPort) currentPort = mergenPort;
    });
  } catch { /* ignore — storage not available on some pages */ }

  // Listen for messages from background/popup
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'MERGEN_PORT_CHANGED' && msg.port) currentPort = msg.port;
      if (msg.type === 'MERGEN_MUTE') muted = msg.muted;
    });
  } catch { /* ignore */ }

  // ── Safe serializer (handles circular refs, DOM nodes, undefined) ───────────

  const MAX_DEPTH = 6;
  const MAX_ARRAY_LEN = 50;
  const MAX_STR_LEN = 2000;

  function safeValue(val, depth, seen) {
    if (depth > MAX_DEPTH) return '[MaxDepth]';
    if (val === null) return null;
    if (val === undefined) return '[undefined]';

    const t = typeof val;
    if (t === 'boolean' || t === 'number') return val;
    if (t === 'bigint') return val.toString() + 'n';
    if (t === 'symbol') return val.toString();
    if (t === 'function') return '[Function: ' + (val.name || 'anonymous') + ']';
    if (t === 'string') {
      return val.length > MAX_STR_LEN
        ? val.slice(0, MAX_STR_LEN) + '…(+' + (val.length - MAX_STR_LEN) + ')'
        : val;
    }

    if (val instanceof Error) {
      return { __error__: true, name: val.name, message: val.message, stack: val.stack || '' };
    }

    if (typeof Node !== 'undefined' && val instanceof Node) {
      const tag = val.nodeName || 'Node';
      const id = val.id ? '#' + val.id : '';
      const cls = val.className
        ? '.' + String(val.className).split(' ').filter(Boolean).join('.')
        : '';
      return '[' + tag + id + cls + ']';
    }

    if (seen.has(val)) return '[Circular]';
    seen.add(val);

    if (Array.isArray(val)) {
      const result = val.slice(0, MAX_ARRAY_LEN).map((v) => safeValue(v, depth + 1, seen));
      if (val.length > MAX_ARRAY_LEN) result.push('…(+' + (val.length - MAX_ARRAY_LEN) + ' more)');
      seen.delete(val);
      return result;
    }

    const result = {};
    try {
      for (const key of Object.keys(val)) {
        try { result[key] = safeValue(val[key], depth + 1, seen); }
        catch { result[key] = '[GetterError]'; }
      }
    } catch { /* ignore */ }
    seen.delete(val);
    return result;
  }

  function safeArgs(args) {
    const seen = new WeakSet();
    return Array.from(args).map((a) => safeValue(a, 0, seen));
  }

  // ── Capture native fetch before any patching ─────────────────────────────────

  const _nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  // ── Ingest helper (fire-and-forget, silent on server-not-running) ────────────

  function post(event) {
    if (muted) return;
    if (!_nativeFetch) return;
    try {
      _nativeFetch(getIngestUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        keepalive: true,
      }).catch(function () { /* server not running — ignore */ });
    } catch { /* ignore */ }
  }

  // ── DOM / storage context capture (fired on console.error only) ─────────────

  function captureStorage(storage) {
    const out = {};
    try {
      const limit = Math.min(storage.length, 20);
      for (let i = 0; i < limit; i++) {
        const key = storage.key(i);
        if (!key) continue;
        const val = storage.getItem(key) || '';
        out[key] = val.length > 500 ? val.slice(0, 500) + '…' : val;
      }
    } catch { /* blocked in sandboxed frames */ }
    return out;
  }

  function getActiveElementDesc() {
    try {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return undefined;
      let desc = el.tagName.toLowerCase();
      if (el.id) desc += '#' + el.id;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).slice(0, 3).join('.');
        if (cls) desc += '.' + cls;
      }
      return desc;
    } catch { return undefined; }
  }

  function detectComponent() {
    try {
      const el = document.activeElement || document.querySelector('[data-reactroot],#root,#app');
      if (!el) return undefined;
      // React 16+ fiber
      const rKey = Object.keys(el).find(function(k) {
        return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
      });
      if (rKey) {
        let fiber = el[rKey];
        let depth = 0;
        while (fiber && depth < 20) {
          if (fiber.type && typeof fiber.type === 'function' && fiber.type.name &&
              fiber.type.name !== 'mergenConsole') {
            return 'React:' + fiber.type.name;
          }
          fiber = fiber.return;
          depth++;
        }
      }
      // Vue 2
      if (el.__vue__) {
        const name = el.__vue__.$options && el.__vue__.$options.name;
        return 'Vue:' + (name || 'Anonymous');
      }
      // Vue 3
      if (el.__vueParentComponent) {
        const name = el.__vueParentComponent.type && el.__vueParentComponent.type.name;
        return 'Vue3:' + (name || 'Anonymous');
      }
    } catch { /* ignore */ }
    return undefined;
  }

  function postContext() {
    try {
      post({
        type: 'context',
        trigger: 'error',
        timestamp: Date.now(),
        url: window.location.href,
        title: document.title,
        activeElement: getActiveElementDesc(),
        component: detectComponent(),
        localStorage: captureStorage(window.localStorage),
        sessionStorage: captureStorage(window.sessionStorage),
      });
    } catch { /* never break the page */ }
  }

  // ── Console override ─────────────────────────────────────────────────────────

  const _origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function patchConsole(level) {
    const orig = _origConsole[level];
    console[level] = function mergenConsole() {
      orig.apply(console, arguments);
      try {
        const stack = (new Error().stack || '').split('\n').slice(2).join('\n');
        post({
          type: 'console',
          level: level,
          args: safeArgs(arguments),
          stack: stack,
          url: window.location.href,
          timestamp: Date.now(),
        });
        if (level === 'error') postContext();
      } catch { /* never break the page */ }
    };
  }

  try { patchConsole('log'); } catch { /* ignore */ }
  try { patchConsole('warn'); } catch { /* ignore */ }
  try { patchConsole('error'); } catch { /* ignore */ }

  // ── Fetch interception ───────────────────────────────────────────────────────

  if (_nativeFetch) {
    try {
      window.fetch = async function mergenFetch(input, init) {
        const url =
          typeof input === 'string' ? input
          : input instanceof URL ? input.href
          : (input && input.url) || String(input);
        const method = (
          (init && init.method) ||
          (input && typeof input === 'object' && input.method) ||
          'GET'
        ).toUpperCase();
        const startTime = Date.now();

        let response;
        try {
          response = await _nativeFetch(input, init);
        } catch (err) {
          post({
            type: 'network',
            method: method,
            url: url,
            status: 0,
            statusText: 'NetworkError',
            duration: Date.now() - startTime,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
          throw err;
        }

        const duration = Date.now() - startTime;
        let responseBody = null;
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          const ct = response.headers.get('content-type') || '';
          responseBody = ct.includes('application/json') ? JSON.parse(text) : text.slice(0, 500);
        } catch { /* ignore */ }

        const reqBody = init && init.body;
        post({
          type: 'network',
          method: method,
          url: url,
          status: response.status,
          statusText: response.statusText,
          duration: duration,
          requestBody: reqBody
            ? (typeof reqBody === 'string' ? reqBody.slice(0, 500) : '[non-string body]')
            : undefined,
          responseBody: responseBody,
          timestamp: Date.now(),
        });

        return response;
      };
    } catch { /* fetch patch failed — page continues normally */ }
  }

  // ── XHR interception ─────────────────────────────────────────────────────────

  try {
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function mergenOpen(method, url) {
      this._mergen = { method: String(method).toUpperCase(), url: String(url), startTime: 0 };
      return _origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function mergenSend(body) {
      if (this._mergen) {
        this._mergen.startTime = Date.now();
        this._mergen.requestBody =
          typeof body === 'string' ? body.slice(0, 500)
          : body ? '[non-string body]'
          : undefined;

        const xhr = this;
        xhr.addEventListener('loadend', function () {
          try {
            const { method, url, startTime, requestBody } = xhr._mergen;
            const ct = xhr.getResponseHeader('content-type') || '';
            let responseBody = null;
            try {
              responseBody = ct.includes('application/json')
                ? JSON.parse(xhr.responseText)
                : xhr.responseText.slice(0, 500);
            } catch { /* ignore */ }

            post({
              type: 'network',
              method: method,
              url: url,
              status: xhr.status,
              statusText: xhr.statusText,
              duration: Date.now() - startTime,
              requestBody: requestBody,
              responseBody: responseBody,
              timestamp: Date.now(),
            });
          } catch { /* never break the page */ }
        });
      }
      return _origSend.apply(this, arguments);
    };
  } catch { /* XHR patch failed — page continues normally */ }

})();
