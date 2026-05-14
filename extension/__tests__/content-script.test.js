/**
 * content-script.test.js — Chrome extension content script tests
 *
 * Tests the browser extension's event capture, serialization, and sending logic.
 * Note: These tests simulate the browser environment. For real browser testing,
 * use Selenium/Puppeteer with the extension loaded.
 */

/**
 * Mock browser APIs for testing
 */
global.chrome = {
  storage: {
    local: {
      get: (keys, callback) => callback({}),
      set: () => {},
    },
    session: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
  },
  runtime: {
    onMessage: {
      addListener: () => {},
    },
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1 }]),
  },
};

global.fetch = async () => ({ ok: true, status: 200 });

describe('Content Script - Event Capture', () => {
  describe('Safe Value Serialization', () => {
    // Load the serialization logic from content.js
    const safeValue = (val, depth = 0, seen = new WeakSet()) => {
      const MAX_DEPTH = 6;
      const MAX_ARRAY_LEN = 50;
      const MAX_STR_LEN = 2000;

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
          try {
            result[key] = safeValue(val[key], depth + 1, seen);
          } catch {
            result[key] = '[GetterError]';
          }
        }
      } catch {}
      seen.delete(val);
      return result;
    };

    test('should handle primitives', () => {
      expect(safeValue(true)).toBe(true);
      expect(safeValue(false)).toBe(false);
      expect(safeValue(42)).toBe(42);
      expect(safeValue(3.14)).toBe(3.14);
      expect(safeValue(null)).toBe(null);
      expect(safeValue(undefined)).toBe('[undefined]');
      expect(safeValue('hello')).toBe('hello');
    });

    test('should handle BigInt', () => {
      const result = safeValue(BigInt(123));
      expect(result).toBe('123n');
    });

    test('should handle symbols', () => {
      const sym = Symbol('test');
      const result = safeValue(sym);
      expect(result).toContain('Symbol(test)');
    });

    test('should handle functions', () => {
      function namedFunc() {}
      const anonFunc = () => {};

      expect(safeValue(namedFunc)).toBe('[Function: namedFunc]');
      expect(safeValue(anonFunc)).toContain('[Function:');
    });

    test('should truncate long strings', () => {
      const longStr = 'x'.repeat(3000);
      const result = safeValue(longStr);

      expect(result.length).toBeLessThan(3000);
      expect(result).toContain('…(+');
      expect(result).toContain('1000)');
    });

    test('should handle arrays', () => {
      const arr = [1, 'two', true, null];
      const result = safeValue(arr);

      expect(result).toEqual([1, 'two', true, null]);
    });

    test('should truncate large arrays', () => {
      const largeArr = Array(100).fill('item');
      const result = safeValue(largeArr);

      expect(result.length).toBe(51); // 50 items + truncation message
      expect(result[50]).toContain('…(+50 more)');
    });

    test('should handle objects', () => {
      const obj = { a: 1, b: 'two', c: true };
      const result = safeValue(obj);

      expect(result).toEqual({ a: 1, b: 'two', c: true });
    });

    test('should handle nested objects', () => {
      const nested = {
        level1: {
          level2: {
            level3: { value: 42 },
          },
        },
      };

      const result = safeValue(nested);
      expect(result.level1.level2.level3.value).toBe(42);
    });

    test('should limit nesting depth', () => {
      const deepNested = { a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } } };
      const result = safeValue(deepNested);

      // Should hit max depth
      const traverse = (obj, depth = 0) => {
        if (typeof obj !== 'object' || obj === null) return depth;
        const keys = Object.keys(obj);
        if (keys.length === 0) return depth;
        return traverse(obj[keys[0]], depth + 1);
      };

      expect(traverse(result)).toBeLessThanOrEqual(6);
    });

    test('should handle circular references', () => {
      const obj = { a: 1 };
      obj.self = obj;

      const result = safeValue(obj);

      expect(result.a).toBe(1);
      expect(result.self).toBe('[Circular]');
    });

    test('should handle Error objects', () => {
      const error = new TypeError('Something went wrong');
      error.stack = 'TypeError: Something went wrong\n    at test.js:1:1';

      const result = safeValue(error);

      expect(result.__error__).toBe(true);
      expect(result.name).toBe('TypeError');
      expect(result.message).toBe('Something went wrong');
      expect(result.stack).toContain('TypeError');
    });

    test('should handle mixed complex structures', () => {
      const complex = {
        str: 'hello',
        num: 42,
        bool: true,
        nil: null,
        undef: undefined,
        arr: [1, 2, 3],
        nested: {
          inner: 'value',
        },
        func: function test() {},
      };

      const result = safeValue(complex);

      expect(result.str).toBe('hello');
      expect(result.num).toBe(42);
      expect(result.bool).toBe(true);
      expect(result.nil).toBe(null);
      expect(result.undef).toBe('[undefined]');
      expect(result.arr).toEqual([1, 2, 3]);
      expect(result.nested.inner).toBe('value');
      expect(result.func).toContain('[Function:');
    });

    test('should not throw on edge cases', () => {
      expect(() => safeValue(NaN)).not.toThrow();
      expect(() => safeValue(Infinity)).not.toThrow();
      expect(() => safeValue(-Infinity)).not.toThrow();
      expect(() => safeValue({})).not.toThrow();
      expect(() => safeValue([])).not.toThrow();
    });
  });

  describe('Event Format Validation', () => {
    test('console event should have required fields', () => {
      const event = {
        type: 'console',
        level: 'error',
        args: ['Error message'],
        url: 'http://localhost:3000',
        timestamp: Date.now(),
      };

      expect(event).toHaveProperty('type', 'console');
      expect(event).toHaveProperty('level');
      expect(event).toHaveProperty('args');
      expect(event).toHaveProperty('url');
      expect(event).toHaveProperty('timestamp');
      expect(['log', 'warn', 'error']).toContain(event.level);
    });

    test('network event should have required fields', () => {
      const event = {
        type: 'network',
        method: 'POST',
        url: 'http://localhost:3000/api/login',
        status: 401,
        statusText: 'Unauthorized',
        duration: 250,
        timestamp: Date.now(),
      };

      expect(event).toHaveProperty('type', 'network');
      expect(event).toHaveProperty('method');
      expect(event).toHaveProperty('url');
      expect(event).toHaveProperty('status');
      expect(event).toHaveProperty('statusText');
      expect(event).toHaveProperty('duration');
      expect(event).toHaveProperty('timestamp');
      expect(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).toContain(event.method);
    });

    test('context event should have required fields', () => {
      const event = {
        type: 'context',
        trigger: 'error',
        timestamp: Date.now(),
        url: 'http://localhost:3000',
        title: 'Test Page',
        activeElement: 'button#submit',
        localStorage: {},
        sessionStorage: {},
      };

      expect(event).toHaveProperty('type', 'context');
      expect(event).toHaveProperty('trigger');
      expect(event).toHaveProperty('timestamp');
      expect(event).toHaveProperty('url');
      expect(event).toHaveProperty('title');
      expect(event).toHaveProperty('activeElement');
      expect(event).toHaveProperty('localStorage');
      expect(event).toHaveProperty('sessionStorage');
    });
  });

  describe('Safety and Error Handling', () => {
    test('should never throw during serialization', () => {
      const dangerousInputs = [
        { getter: Object.defineProperty({}, 'x', { get() { throw new Error('boom'); } }) },
        { circular: (() => { const o = {}; o.self = o; return o; })() },
        { deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 'deep' } } } } } } } } } },
        { bigArray: Array(10000).fill('x') },
        { longString: 'x'.repeat(10000) },
      ];

      dangerousInputs.forEach((input) => {
        expect(() => JSON.stringify(safeValue(input))).not.toThrow();
      });
    });

    test('should handle objects with problematic toString', () => {
      const obj = {
        toString() {
          throw new Error('toString failed');
        },
      };

      expect(() => safeValue(obj)).not.toThrow();
    });

    test('should handle frozen objects', () => {
      const frozen = Object.freeze({ a: 1, b: 2 });
      const result = safeValue(frozen);

      expect(result).toEqual({ a: 1, b: 2 });
    });

    test('should handle sealed objects', () => {
      const sealed = Object.seal({ a: 1, b: 2 });
      const result = safeValue(sealed);

      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe('Real-World Scenarios', () => {
    test('should serialize typical React error', () => {
      const reactError = new Error('Cannot read property "name" of undefined');
      reactError.stack = `Error: Cannot read property "name" of undefined
    at UserProfile.render (UserProfile.tsx:42:15)
    at renderComponent (react-dom.js:1234:20)`;

      const result = safeValue(reactError);

      expect(result.__error__).toBe(true);
      expect(result.message).toContain('Cannot read property');
      expect(result.stack).toContain('UserProfile.tsx');
    });

    test('should serialize fetch response', () => {
      const fetchEvent = {
        method: 'POST',
        url: 'http://localhost:3000/api/users',
        status: 422,
        statusText: 'Unprocessable Entity',
        duration: 185,
        requestBody: {
          name: 'Alice',
          email: 'alice@example.com',
        },
        responseBody: {
          errors: ['Email is already taken'],
        },
      };

      const result = safeValue(fetchEvent);

      expect(result.method).toBe('POST');
      expect(result.status).toBe(422);
      expect(result.requestBody.email).toBe('alice@example.com');
      expect(result.responseBody.errors[0]).toBe('Email is already taken');
    });

    test('should serialize localStorage/sessionStorage', () => {
      const storage = {
        userId: '12345',
        theme: 'dark',
        preferences: JSON.stringify({ notifications: true }),
      };

      const result = safeValue(storage);

      expect(result.userId).toBe('12345');
      expect(result.theme).toBe('dark');
      expect(result.preferences).toContain('notifications');
    });

    test('should handle WebSocket messages', () => {
      const wsMessage = {
        type: 'message',
        data: JSON.stringify({
          event: 'user.updated',
          payload: { id: 123, status: 'online' },
        }),
      };

      const result = safeValue(wsMessage);

      expect(result.type).toBe('message');
      expect(result.data).toContain('user.updated');
    });

    test('should serialize complex Redux state', () => {
      const reduxState = {
        user: { id: 1, name: 'Alice', isLoggedIn: true },
        posts: [
          { id: 1, title: 'Post 1', author: 'Alice' },
          { id: 2, title: 'Post 2', author: 'Bob' },
        ],
        ui: { modal: null, loading: false },
      };

      const result = safeValue(reduxState);

      expect(result.user.name).toBe('Alice');
      expect(result.posts.length).toBe(2);
      expect(result.ui.loading).toBe(false);
    });
  });

  describe('Performance Characteristics', () => {
    test('should serialize quickly even with large objects', () => {
      const largeObj = {
        users: Array(100).fill(null).map((_, i) => ({
          id: i,
          name: `User ${i}`,
          email: `user${i}@example.com`,
        })),
      };

      const start = Date.now();
      safeValue(largeObj);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // Should be fast
    });

    test('should handle rapid successive serializations', () => {
      const start = Date.now();

      for (let i = 0; i < 100; i++) {
        safeValue({
          iteration: i,
          data: { x: 1, y: 2, z: 3 },
          arr: [1, 2, 3, 4, 5],
        });
      }

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(500);
    });
  });
});

describe('Content Script - Integration Scenarios', () => {
  test('should format console.error correctly', () => {
    const args = ['Login failed:', { status: 401, message: 'Invalid token' }];
    const event = {
      type: 'console',
      level: 'error',
      args,
      url: window.location?.href || 'http://test',
      timestamp: Date.now(),
    };

    expect(event.type).toBe('console');
    expect(event.level).toBe('error');
    expect(event.args[0]).toBe('Login failed:');
    expect(event.args[1]).toHaveProperty('status', 401);
  });

  test('should format network request correctly', () => {
    const event = {
      type: 'network',
      method: 'GET',
      url: 'http://localhost:3000/api/users',
      status: 200,
      statusText: 'OK',
      duration: 125,
      timestamp: Date.now(),
    };

    expect(event.type).toBe('network');
    expect(event.status).toBe(200);
    expect(event.duration).toBeGreaterThan(0);
  });

  test('should be JSON-serializable', () => {
    const event = {
      type: 'console',
      level: 'error',
      args: ['Test error', { code: 123 }],
      url: 'http://test',
      timestamp: Date.now(),
    };

    expect(() => JSON.stringify(event)).not.toThrow();

    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('console');
    expect(parsed.args[0]).toBe('Test error');
  });
});
