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

  // Load port AND muted state from storage on startup so existing tabs
  // pick up the right state after extension reload without needing a message.
  try {
    chrome.storage.local.get('mergenPort', ({ mergenPort }) => {
      if (mergenPort) currentPort = mergenPort;
    });
  } catch { /* ignore — storage not available on some pages */ }

  try {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) return;
      chrome.storage.session.get(`muted_${tab.id}`).then((r) => {
        if (r[`muted_${tab.id}`] === true) muted = true;
      }).catch(() => {});
    }).catch(() => {});
  } catch { /* ignore */ }

  // Listen for messages from background/popup
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'MERGEN_PING') { sendResponse({ ok: true }); return; }
      if (msg.type === 'MERGEN_PORT_CHANGED' && msg.port) currentPort = msg.port;
      if (msg.type === 'MERGEN_MUTE') muted = msg.muted;

      // Component tree capture request
      if (msg.type === 'MERGEN_CAPTURE_COMPONENT_TREE') {
        try {
          const maxDepth = msg.maxDepth || 5;
          const reactTree = captureReactComponentTree(maxDepth);
          const vueTree = captureVueComponentTree(maxDepth);

          sendResponse({
            ok: true,
            reactTree: reactTree,
            vueTree: vueTree,
            timestamp: Date.now(),
          });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
        return true; // Keep channel open for async response
      }
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

  // ── Build SHA detection ───────────────────────────────────────────────────────
  let _buildSha = null;
  const SHA_RE = /^[0-9a-f]{7,40}$/i;

  function _tryExtractSha(val) {
    if (typeof val === 'string' && SHA_RE.test(val.trim())) return val.trim().toLowerCase();
    return null;
  }

  function _detectShaFromPage() {
    const globals = ['__MERGEN_SHA__','__SHA__','__COMMIT_SHA__','__GIT_SHA__','__BUILD_SHA__','__GIT_COMMIT__','__COMMIT_HASH__','__REVISION__'];
    for (const key of globals) { const f = _tryExtractSha(window[key]); if (f) return f; }
    const metas = ['meta[name="mergen:sha"]','meta[name="commit-sha"]','meta[name="build-sha"]','meta[name="git-hash"]','meta[name="git-sha"]'];
    for (const sel of metas) { try { const el = document.querySelector(sel); if (el) { const f = _tryExtractSha(el.getAttribute('content')); if (f) return f; } } catch {} }
    return null;
  }

  // ── Capture native fetch before any patching ─────────────────────────────────

  const _nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  function _fetchServerSha() {
    try {
      const tryPort = function(p) {
        _nativeFetch(`http://127.0.0.1:${p}/current-version`, { cache: 'no-store' })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(d) { if (d && d.sha) { const f = _tryExtractSha(d.sha); if (f && !_buildSha) _buildSha = f; } })
          .catch(function() { if (p < 3003) tryPort(p + 1); });
      };
      tryPort(currentPort || 3000);
    } catch {}
  }

  function _initBuildSha() {
    try { const f = _detectShaFromPage(); if (f) { _buildSha = f; return; } _fetchServerSha(); } catch {}
  }

  try {
    if (document.readyState !== 'loading') { _initBuildSha(); }
    else { document.addEventListener('DOMContentLoaded', _initBuildSha, { once: true }); }
  } catch {}

  // ── Ingest helper (fire-and-forget, silent on server-not-running) ────────────

  function post(event) {
    if (muted) return;
    if (!_nativeFetch) return;
    try {
      const enriched = (_buildSha && (event.type === 'console' || event.type === 'network'))
        ? Object.assign({}, event, { buildSha: _buildSha })
        : event;
      _nativeFetch(getIngestUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enriched),
        keepalive: true,
      }).catch(function () {});
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

  // ── React component tree serialization ───────────────────────────────────────

  function serializeReactFiber(fiber, maxDepth, currentDepth) {
    if (!fiber || currentDepth >= maxDepth) return null;

    try {
      const node = {
        name: 'Unknown',
        type: fiber.type ? (typeof fiber.type === 'string' ? fiber.type : fiber.type.name || 'Anonymous') : 'Unknown',
        props: null,
        state: null,
        hooks: null,
        children: [],
      };

      // Extract component name
      if (fiber.type && typeof fiber.type === 'function') {
        node.name = fiber.type.name || 'Anonymous';
      } else if (typeof fiber.type === 'string') {
        node.name = fiber.type;
      }

      // Extract props (limit to 500 chars per prop)
      if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') {
        node.props = {};
        const propKeys = Object.keys(fiber.memoizedProps).slice(0, 10);
        for (const key of propKeys) {
          if (key === 'children') continue;
          try {
            const val = fiber.memoizedProps[key];
            const serialized = typeof val === 'string' ? val : JSON.stringify(val);
            node.props[key] = serialized.length > 500 ? serialized.slice(0, 500) + '...' : serialized;
          } catch {
            node.props[key] = '[unserializable]';
          }
        }
      }

      // Extract state (class components)
      if (fiber.memoizedState && typeof fiber.memoizedState === 'object' && !Array.isArray(fiber.memoizedState)) {
        try {
          node.state = {};
          const stateKeys = Object.keys(fiber.memoizedState).slice(0, 10);
          for (const key of stateKeys) {
            const val = fiber.memoizedState[key];
            const serialized = typeof val === 'string' ? val : JSON.stringify(val);
            node.state[key] = serialized.length > 500 ? serialized.slice(0, 500) + '...' : serialized;
          }
        } catch {
          node.state = '[unserializable]';
        }
      }

      // Extract hooks (function components)
      if (fiber.memoizedState && fiber.tag === 0) {
        try {
          node.hooks = [];
          let hook = fiber.memoizedState;
          let hookIndex = 0;
          while (hook && hookIndex < 10) {
            try {
              const hookVal = typeof hook.memoizedState === 'string'
                ? hook.memoizedState
                : JSON.stringify(hook.memoizedState);
              node.hooks.push({
                index: hookIndex,
                value: hookVal.length > 200 ? hookVal.slice(0, 200) + '...' : hookVal,
              });
            } catch {
              node.hooks.push({ index: hookIndex, value: '[unserializable]' });
            }
            hook = hook.next;
            hookIndex++;
          }
        } catch { /* ignore */ }
      }

      // Traverse children
      let child = fiber.child;
      let childCount = 0;
      while (child && childCount < 5) {
        const childNode = serializeReactFiber(child, maxDepth, currentDepth + 1);
        if (childNode) node.children.push(childNode);
        child = child.sibling;
        childCount++;
      }

      return node;
    } catch {
      return null;
    }
  }

  function captureReactComponentTree(maxDepth) {
    try {
      const root = document.querySelector('#root,[data-reactroot],[data-react-root]');
      if (!root) return null;

      const fiberKey = Object.keys(root).find(function(k) {
        return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
      });

      if (!fiberKey) return null;

      const fiber = root[fiberKey];
      return serializeReactFiber(fiber, maxDepth || 5, 0);
    } catch {
      return null;
    }
  }

  // ── Vue component tree serialization ─────────────────────────────────────────

  function serializeVueComponent(vm, maxDepth, currentDepth) {
    if (!vm || currentDepth >= maxDepth) return null;

    try {
      const node = {
        name: 'Unknown',
        props: null,
        data: null,
        computed: null,
        children: [],
      };

      // Vue 2
      if (vm.$options) {
        node.name = vm.$options.name || vm.$options._componentTag || 'Anonymous';

        // Props
        if (vm.$props && typeof vm.$props === 'object') {
          node.props = {};
          const propKeys = Object.keys(vm.$props).slice(0, 10);
          for (const key of propKeys) {
            try {
              const val = vm.$props[key];
              const serialized = typeof val === 'string' ? val : JSON.stringify(val);
              node.props[key] = serialized.length > 500 ? serialized.slice(0, 500) + '...' : serialized;
            } catch {
              node.props[key] = '[unserializable]';
            }
          }
        }

        // Data
        if (vm.$data && typeof vm.$data === 'object') {
          node.data = {};
          const dataKeys = Object.keys(vm.$data).slice(0, 10);
          for (const key of dataKeys) {
            if (key.startsWith('_')) continue;
            try {
              const val = vm.$data[key];
              const serialized = typeof val === 'string' ? val : JSON.stringify(val);
              node.data[key] = serialized.length > 500 ? serialized.slice(0, 500) + '...' : serialized;
            } catch {
              node.data[key] = '[unserializable]';
            }
          }
        }

        // Children
        if (vm.$children && Array.isArray(vm.$children)) {
          const childCount = Math.min(vm.$children.length, 5);
          for (let i = 0; i < childCount; i++) {
            const childNode = serializeVueComponent(vm.$children[i], maxDepth, currentDepth + 1);
            if (childNode) node.children.push(childNode);
          }
        }
      }

      return node;
    } catch {
      return null;
    }
  }

  function captureVueComponentTree(maxDepth) {
    try {
      const root = document.querySelector('#app,[data-v-app]');
      if (!root) return null;

      // Vue 2
      if (root.__vue__) {
        return serializeVueComponent(root.__vue__, maxDepth || 5, 0);
      }

      // Vue 3 (simplified)
      if (root.__vueParentComponent) {
        return {
          name: root.__vueParentComponent.type?.name || 'App',
          framework: 'Vue3',
          note: 'Vue 3 detailed tree capture coming soon',
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  function postContext(trigger) {
    try {
      const contextData = {
        type: 'context',
        trigger: trigger,
        timestamp: Date.now(),
        url: window.location.href,
        title: document.title,
        activeElement: getActiveElementDesc(),
        component: detectComponent(),
        localStorage: captureStorage(window.localStorage),
        sessionStorage: captureStorage(window.sessionStorage),
      };

      // Layer 1: Enhanced instrumentation
      if (window.__mergenLayers) {
        try {
          const componentTree = window.__mergenLayers.getComponentTree();
          if (componentTree) contextData.componentTree = componentTree;

          const stateDiff = window.__mergenLayers.captureStateDiff();
          if (stateDiff) contextData.stateDiff = stateDiff;

          const perfTrace = window.__mergenLayers.getRecentPerformanceTrace();
          if (perfTrace && perfTrace.length > 0) contextData.performanceTrace = perfTrace;
        } catch { /* enhanced instrumentation failed — continue with basic */ }
      }

      // Built-in component tree capture (fallback if layers not loaded)
      if (!contextData.componentTree && trigger === 'error') {
        try {
          const reactTree = captureReactComponentTree(3);
          const vueTree = captureVueComponentTree(3);
          if (reactTree) {
            contextData.componentTree = { framework: 'React', tree: reactTree };
          } else if (vueTree) {
            contextData.componentTree = { framework: 'Vue', tree: vueTree };
          }
        } catch { /* ignore */ }
      }

      post(contextData);
    } catch { /* never break the page */ }
  }

  // Rate-limit warn context snapshots: at most 1 per 5 seconds.
  // We never want to spam the buffer with identical warn snapshots.
  let _lastWarnContextTs = 0;
  const WARN_CONTEXT_THROTTLE_MS = 5_000;

  // ── HMR checkpoint (Vite + webpack-HMR) ─────────────────────────────────────
  // When the dev server hot-reloads a module, we post a lightweight checkpoint
  // event so Mergen can show the state *between* saves — not just after a crash.
  // This turns Mergen from a "crash detector" into a "dev loop observer".
  //
  // Vite emits a custom event on window: 'vite:afterUpdate'
  // webpack HMR emits: module.hot events — we detect via the public API
  let _lastHmrContextTs = 0;
  const HMR_CONTEXT_THROTTLE_MS = 3_000; // at most one snapshot per save cycle

  function onHmrUpdate(source) {
    try {
      const now = Date.now();
      if (now - _lastHmrContextTs < HMR_CONTEXT_THROTTLE_MS) return;
      _lastHmrContextTs = now;
      post({
        type: 'console',
        level: 'log',
        args: ['[mergen:hmr] hot reload — ' + source],
        stack: '',
        url: window.location.href,
        timestamp: now,
      });
      // Also snapshot storage/DOM so state is always captured around each save.
      // The 'hmr' trigger flips Mergen's hypothesis engine into post-save
      // baseline mode (see hypothesis-history.RebuildReason).
      postContext('hmr');
    } catch { /* never break the page */ }
  }

  // ── Pageload checkpoint ─────────────────────────────────────────────────────
  // Fire a 'pageload' context snapshot after the document fully loads (and
  // again on bfcache restore via pageshow). This is the primary trigger that
  // makes Mergen continuous: every refresh produces a baseline diagnosis,
  // not just every crash.
  function firePageload() {
    try { postContext('pageload'); } catch { /* never break */ }
  }
  try {
    if (document.readyState === 'complete') {
      // Defer one tick so the network panel sees the initial fetches first.
      setTimeout(firePageload, 50);
    } else {
      window.addEventListener('load', function () { setTimeout(firePageload, 50); }, { once: true });
    }
    // bfcache restore (Safari/Chrome back/forward) — counts as a fresh view.
    window.addEventListener('pageshow', function (ev) {
      if (ev && ev.persisted) firePageload();
    });
  } catch { /* ignore */ }

  try {
    // Vite
    window.addEventListener('vite:afterUpdate', function() { onHmrUpdate('vite'); });
    // webpack HMR — module.hot.addStatusHandler fires on 'apply' (after patch)
    if (typeof module !== 'undefined' && module.hot) {
      module.hot.addStatusHandler(function(status) {
        if (status === 'apply') onHmrUpdate('webpack');
      });
    }
    // Next.js / generic HMR via custom event
    window.addEventListener('next-route-announcer:route-changed', function() {
      onHmrUpdate('next');
    });
  } catch { /* not in a dev server context — ignore */ }

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
        if (level === 'error') {
          postContext('error');
        } else if (level === 'warn') {
          // Throttled: capture storage/DOM state on warn so the LLM has
          // context even before the warning escalates to an error.
          const now = Date.now();
          if (now - _lastWarnContextTs >= WARN_CONTEXT_THROTTLE_MS) {
            _lastWarnContextTs = now;
            postContext('warn');
          }
        }
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

        // Extract request headers from init.headers or input.headers (Request object)
        var requestHeaders = undefined;
        try {
          var rawHeaders = (init && init.headers) || (input && typeof input === 'object' && input.headers);
          if (rawHeaders) {
            requestHeaders = {};
            if (typeof Headers !== 'undefined' && rawHeaders instanceof Headers) {
              rawHeaders.forEach(function(v, k) { requestHeaders[k] = v.slice(0, 200); });
            } else if (Array.isArray(rawHeaders)) {
              rawHeaders.forEach(function(pair) { if (pair.length >= 2) requestHeaders[pair[0]] = String(pair[1]).slice(0, 200); });
            } else if (typeof rawHeaders === 'object') {
              for (var hk in rawHeaders) { if (rawHeaders.hasOwnProperty(hk)) requestHeaders[hk] = String(rawHeaders[hk]).slice(0, 200); }
            }
          }
        } catch { /* ignore */ }

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
          requestHeaders: requestHeaders,
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

  // ── WebSocket interception ───────────────────────────────────────────────────

  try {
    const _OrigWebSocket = window.WebSocket;
    const MAX_FRAMES_PER_CONNECTION = 50;
    const FRAME_RATE_LIMIT_MS = 100; // Max 10 frames/sec per connection

    window.WebSocket = function MergenWebSocket(url, protocols) {
      const ws = protocols
        ? new _OrigWebSocket(url, protocols)
        : new _OrigWebSocket(url);

      const connectionId = Math.random().toString(36).slice(2, 11);
      const frames = [];
      let lastFrameTime = 0;

      function captureFrame(direction, data) {
        try {
          const now = Date.now();
          // Rate-limit frame capture
          if (now - lastFrameTime < FRAME_RATE_LIMIT_MS && frames.length > 0) {
            return;
          }
          lastFrameTime = now;

          let parsedData = data;
          if (typeof data === 'string') {
            try {
              parsedData = JSON.parse(data);
            } catch { /* not JSON, keep as string */ }
          }

          const frame = {
            direction: direction,
            data: typeof parsedData === 'string'
              ? parsedData.slice(0, 500)
              : JSON.stringify(parsedData).slice(0, 500),
            timestamp: now,
          };

          frames.push(frame);

          // Keep only last MAX_FRAMES_PER_CONNECTION
          if (frames.length > MAX_FRAMES_PER_CONNECTION) {
            frames.shift();
          }
        } catch { /* never break */ }
      }

      ws.addEventListener('open', function(event) {
        try {
          post({
            type: 'websocket',
            connectionId: connectionId,
            url: url,
            status: 'open',
            timestamp: Date.now(),
          });
        } catch { /* ignore */ }
      });

      ws.addEventListener('message', function(event) {
        try {
          captureFrame('received', event.data);
        } catch { /* ignore */ }
      });

      ws.addEventListener('close', function(event) {
        try {
          post({
            type: 'websocket',
            connectionId: connectionId,
            url: url,
            status: 'closed',
            code: event.code,
            reason: event.reason,
            frames: frames,
            timestamp: Date.now(),
          });
        } catch { /* ignore */ }
      });

      ws.addEventListener('error', function(event) {
        try {
          post({
            type: 'websocket',
            connectionId: connectionId,
            url: url,
            status: 'error',
            error: 'WebSocket error',
            frames: frames,
            timestamp: Date.now(),
          });
        } catch { /* ignore */ }
      });

      // Intercept send to capture outgoing frames
      const _origSend = ws.send;
      ws.send = function mergenSend(data) {
        try {
          captureFrame('sent', data);
        } catch { /* ignore */ }
        return _origSend.call(ws, data);
      };

      return ws;
    };

    // Copy static properties
    window.WebSocket.CONNECTING = _OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = _OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = _OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = _OrigWebSocket.CLOSED;
  } catch { /* WebSocket patch failed — page continues normally */ }

  // ── EventSource (Server-Sent Events) interception ────────────────────────────

  try {
    const _OrigEventSource = window.EventSource;
    const MAX_SSE_MESSAGES = 50;

    window.EventSource = function MergenEventSource(url, config) {
      const es = new _OrigEventSource(url, config);
      const connectionId = Math.random().toString(36).slice(2, 11);
      const messages = [];

      es.addEventListener('open', function() {
        try {
          post({
            type: 'sse',
            connectionId: connectionId,
            url: url,
            status: 'open',
            timestamp: Date.now(),
          });
        } catch { /* ignore */ }
      });

      es.addEventListener('message', function(event) {
        try {
          let parsedData = event.data;
          try {
            parsedData = JSON.parse(event.data);
          } catch { /* not JSON */ }

          const message = {
            data: typeof parsedData === 'string'
              ? parsedData.slice(0, 500)
              : JSON.stringify(parsedData).slice(0, 500),
            timestamp: Date.now(),
          };

          messages.push(message);
          if (messages.length > MAX_SSE_MESSAGES) {
            messages.shift();
          }
        } catch { /* ignore */ }
      });

      es.addEventListener('error', function() {
        try {
          post({
            type: 'sse',
            connectionId: connectionId,
            url: url,
            status: 'error',
            messages: messages,
            timestamp: Date.now(),
          });
        } catch { /* ignore */ }
      });

      return es;
    };

    // Copy static properties
    window.EventSource.CONNECTING = _OrigEventSource.CONNECTING;
    window.EventSource.OPEN = _OrigEventSource.OPEN;
    window.EventSource.CLOSED = _OrigEventSource.CLOSED;
  } catch { /* EventSource patch failed — page continues normally */ }

})();
