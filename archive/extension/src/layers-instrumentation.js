/**
 * layers-instrumentation.js — Enhanced instrumentation for Layers 1-3
 *
 * Layer 1: Component tree, state diff, performance trace
 * Layer 3: Bidirectional communication for breakpoints, mocks, injected logs
 */

(function mergenLayersInit() {
  'use strict';

  const DEFAULT_PORT = 3000;
  let currentPort = DEFAULT_PORT;

  function getServerUrl(path) {
    return `http://127.0.0.1:${currentPort}${path}`;
  }

  // ── Layer 1: Component Tree Capture ──────────────────────────────────────────

  function captureReactTree(fiber, depth = 0, maxDepth = 5) {
    if (!fiber || depth > maxDepth) return null;

    const node = {
      name: fiber.type?.name || fiber.elementType?.name || 'Anonymous',
      type: 'React',
      props: {},
      state: {},
      children: [],
    };

    // Capture props (safe subset)
    if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') {
      try {
        const props = fiber.memoizedProps;
        for (const key of Object.keys(props)) {
          if (key === 'children') continue;
          if (typeof props[key] === 'function') continue;
          node.props[key] = safeValue(props[key], 2);
        }
      } catch { /* ignore */ }
    }

    // Capture state (hooks or class state)
    if (fiber.memoizedState) {
      try {
        if (typeof fiber.memoizedState === 'object' && !Array.isArray(fiber.memoizedState)) {
          node.state = safeValue(fiber.memoizedState, 2);
        } else {
          // Hooks: walk the linked list
          let hook = fiber.memoizedState;
          let idx = 0;
          while (hook && idx < 10) {
            if (hook.memoizedState !== undefined) {
              node.state[`hook${idx}`] = safeValue(hook.memoizedState, 2);
            }
            hook = hook.next;
            idx++;
          }
        }
      } catch { /* ignore */ }
    }

    // Capture children
    if (fiber.child && depth < maxDepth) {
      let child = fiber.child;
      while (child && node.children.length < 10) {
        const childNode = captureReactTree(child, depth + 1, maxDepth);
        if (childNode) node.children.push(childNode);
        child = child.sibling;
      }
    }

    return node;
  }

  function captureVueTree(vm, depth = 0, maxDepth = 5) {
    if (!vm || depth > maxDepth) return null;

    const node = {
      name: vm.$options?.name || vm.$options?._componentTag || 'Anonymous',
      type: 'Vue',
      props: {},
      state: {},
      children: [],
    };

    // Capture props
    if (vm.$props) {
      try {
        for (const key of Object.keys(vm.$props)) {
          node.props[key] = safeValue(vm.$props[key], 2);
        }
      } catch { /* ignore */ }
    }

    // Capture data
    if (vm.$data) {
      try {
        for (const key of Object.keys(vm.$data)) {
          if (!key.startsWith('_')) {
            node.state[key] = safeValue(vm.$data[key], 2);
          }
        }
      } catch { /* ignore */ }
    }

    // Capture children
    if (vm.$children && depth < maxDepth) {
      for (const child of vm.$children.slice(0, 10)) {
        const childNode = captureVueTree(child, depth + 1, maxDepth);
        if (childNode) node.children.push(childNode);
      }
    }

    return node;
  }

  function getComponentTree() {
    try {
      // Try React first
      const root = document.querySelector('[data-reactroot],#root,#app');
      if (root) {
        const rKey = Object.keys(root).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (rKey) {
          const fiber = root[rKey];
          return captureReactTree(fiber);
        }
      }

      // Try Vue
      if (root && root.__vue__) {
        return captureVueTree(root.__vue__);
      }

      // Vue 3
      if (root && root.__vueParentComponent) {
        const component = root.__vueParentComponent;
        return {
          name: component.type?.name || 'Anonymous',
          type: 'Vue3',
          props: safeValue(component.props, 2),
          state: {},
          children: [],
        };
      }
    } catch { /* ignore */ }
    return null;
  }

  // ── Layer 1: State Management Integration ───────────────────────────────────

  let lastReduxState = null;
  let lastZustandState = null;

  function captureStateDiff() {
    const diffs = [];

    // Redux
    try {
      if (window.__REDUX_DEVTOOLS_EXTENSION__) {
        const store = window.__REDUX_DEVTOOLS_EXTENSION__.store;
        if (store) {
          const currentState = store.getState();
          if (lastReduxState) {
            const diff = findStateDiff(lastReduxState, currentState);
            if (diff) {
              diffs.push({
                framework: 'Redux',
                before: lastReduxState,
                after: currentState,
                field: diff.path,
                timestamp: Date.now(),
              });
            }
          }
          lastReduxState = currentState;
        }
      }
    } catch { /* ignore */ }

    // Zustand (more challenging - requires instrumentation at store creation)
    // For now, mark as TODO

    return diffs.length > 0 ? diffs[0] : null;
  }

  function findStateDiff(before, after, path = '') {
    if (before === after) return null;
    if (typeof before !== 'object' || typeof after !== 'object') {
      return { path };
    }

    for (const key of Object.keys(after)) {
      const newPath = path ? `${path}.${key}` : key;
      if (before[key] !== after[key]) {
        return { path: newPath };
      }
    }

    return null;
  }

  // ── Layer 1: Performance Trace ───────────────────────────────────────────────

  const performanceEntries = [];

  function setupPerformanceObserver() {
    if (!window.PerformanceObserver) return;

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          performanceEntries.push({
            entryType: entry.entryType,
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            metadata: entry.toJSON ? entry.toJSON() : {},
          });

          // Keep only last 50 entries
          if (performanceEntries.length > 50) {
            performanceEntries.shift();
          }
        }
      });

      observer.observe({ entryTypes: ['longtask', 'layout-shift', 'paint', 'navigation'] });
    } catch { /* ignore */ }
  }

  setupPerformanceObserver();

  function getRecentPerformanceTrace() {
    return performanceEntries.slice(-20);
  }

  // ── Layer 3: Bidirectional Communication ─────────────────────────────────────

  const activeMocks = new Map();
  const activeInjections = new Map();

  // Poll for commands from server
  function pollCommands() {
    try {
      originalFetch(getServerUrl('/commands'))
        .then(res => res.json())
        .then(data => {
          if (data.commands && Array.isArray(data.commands)) {
            for (const cmd of data.commands) {
              handleCommand(cmd);
            }
          }
        })
        .catch(() => { /* server not running */ });
    } catch { /* ignore */ }
  }

  function handleCommand(cmd) {
    try {
      if (cmd.type === 'SET_MOCK') {
        activeMocks.set(cmd.payload.id, cmd.payload);
      } else if (cmd.type === 'REMOVE_MOCK') {
        activeMocks.delete(cmd.payload.id);
      } else if (cmd.type === 'INJECT_LOG') {
        injectTemporaryLog(cmd.payload);
      } else if (cmd.type === 'REMOVE_LOG') {
        removeInjectedLog(cmd.payload.id);
      }
    } catch (err) {
      console.error('[mergen:layers] Command handling failed:', err);
    }
  }

  // Start polling every 2 seconds
  setInterval(pollCommands, 2000);

  // Intercept fetch for mocks
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method || 'GET';

    // Check if this request should be mocked
    for (const mock of activeMocks.values()) {
      if (urlMatches(url, mock.url) && method.toUpperCase() === mock.method.toUpperCase()) {
        console.log('[mergen:layers] Mock hit:', mock.url);

        // Notify server
        try {
          originalFetch(getServerUrl('/mock-hit'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, method }),
          }).catch(() => {});
        } catch { /* ignore */ }

        // Return mocked response
        return new Response(
          typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body),
          {
            status: mock.status,
            headers: mock.headers || { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    return originalFetch.apply(this, arguments);
  };

  function urlMatches(url, pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return regex.test(url);
  }

  function injectTemporaryLog(payload) {
    try {
      const element = document.querySelector(payload.selector);
      if (!element) return;

      const handler = (event) => {
        try {
          // Evaluate expression in event context
          const result = eval(payload.expression);

          // Send captured data to server
          originalFetch(getServerUrl('/log-capture'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: payload.id, data: result }),
          }).catch(() => {});

          // Remove handler after first capture
          element.removeEventListener(payload.event, handler);
          activeInjections.delete(payload.id);
        } catch (err) {
          console.error('[mergen:layers] Log injection eval failed:', err);
        }
      };

      element.addEventListener(payload.event, handler);
      activeInjections.set(payload.id, { element, event: payload.event, handler });
    } catch (err) {
      console.error('[mergen:layers] Log injection failed:', err);
    }
  }

  function removeInjectedLog(id) {
    const injection = activeInjections.get(id);
    if (injection) {
      injection.element.removeEventListener(injection.event, injection.handler);
      activeInjections.delete(id);
    }
  }

  // ── Utility: Safe value serialization ───────────────────────────────────────

  function safeValue(val, depth, seen = new WeakSet()) {
    if (depth <= 0) return '[MaxDepth]';
    if (val === null) return null;
    if (val === undefined) return '[undefined]';

    const t = typeof val;
    if (t === 'boolean' || t === 'number') return val;
    if (t === 'string') return val.length > 200 ? val.slice(0, 200) + '…' : val;
    if (t === 'function') return '[Function]';

    if (typeof Node !== 'undefined' && val instanceof Node) {
      return '[DOMNode]';
    }

    if (seen.has(val)) return '[Circular]';
    seen.add(val);

    if (Array.isArray(val)) {
      return val.slice(0, 10).map(v => safeValue(v, depth - 1, seen));
    }

    const result = {};
    try {
      for (const key of Object.keys(val).slice(0, 20)) {
        try {
          result[key] = safeValue(val[key], depth - 1, seen);
        } catch {
          result[key] = '[GetterError]';
        }
      }
    } catch { /* ignore */ }
    return result;
  }

  // ── Export enhanced context capture ──────────────────────────────────────────

  window.__mergenLayers = {
    getComponentTree,
    captureStateDiff,
    getRecentPerformanceTrace,
  };

})();
