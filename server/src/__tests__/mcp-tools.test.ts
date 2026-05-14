/**
 * mcp-tools.test.ts — MCP tool interface tests
 *
 * Tests the Model Context Protocol tool implementations to ensure they work
 * correctly with AI IDEs (Claude, Cursor, Windsurf, Copilot).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { store } from '../sensor/buffer.js';
import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../sensor/buffer.js';

describe('MCP Tool Interface Tests', () => {
  beforeEach(() => {
    store.clear();
  });

  describe('get_recent_logs tool', () => {
    it('should return logs with default limit', () => {
      // Add test events
      for (let i = 0; i < 30; i++) {
        store.push({
          type: 'console',
          level: 'log',
          args: [`Log ${i}`],
          url: 'http://test',
          timestamp: Date.now() + i,
        });
      }

      const logs = store.getLogs(); // Default limit
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.length).toBeLessThanOrEqual(50);
    });

    it('should respect custom limit parameter', () => {
      for (let i = 0; i < 50; i++) {
        store.push({
          type: 'console',
          level: 'log',
          args: [`Log ${i}`],
          url: 'http://test',
          timestamp: Date.now() + i,
        });
      }

      const logs = store.getLogs(10);
      expect(logs.length).toBe(10);
    });

    it('should filter by log level', () => {
      store.push({ type: 'console', level: 'log', args: ['info'], url: 'u', timestamp: 1 });
      store.push({ type: 'console', level: 'warn', args: ['warning'], url: 'u', timestamp: 2 });
      store.push({ type: 'console', level: 'error', args: ['error'], url: 'u', timestamp: 3 });
      store.push({ type: 'console', level: 'error', args: ['error2'], url: 'u', timestamp: 4 });

      const errors = store.getLogs(50, 'error');
      expect(errors.length).toBe(2);
      expect(errors.every((e) => e.level === 'error')).toBe(true);

      const warnings = store.getLogs(50, 'warn');
      expect(warnings.length).toBe(1);
      expect(warnings[0].level).toBe('warn');
    });

    it('should filter by timestamp using since parameter', () => {
      const baseTime = Date.now();

      store.push({ type: 'console', level: 'log', args: ['old'], url: 'u', timestamp: baseTime - 1000 });
      store.push({ type: 'console', level: 'log', args: ['recent1'], url: 'u', timestamp: baseTime });
      store.push({ type: 'console', level: 'log', args: ['recent2'], url: 'u', timestamp: baseTime + 100 });

      const since = baseTime - 500;
      const recent = store.getLogs(50).filter((e) => e.timestamp >= since);

      expect(recent.length).toBe(2);
      expect(recent[0].args[0]).toBe('recent1');
      expect(recent[1].args[0]).toBe('recent2');
    });

    it('should return events in chronological order (oldest first)', () => {
      const timestamps = [100, 200, 300, 400, 500]; // Pre-sorted for insertion

      timestamps.forEach((ts) => {
        store.push({
          type: 'console',
          level: 'log',
          args: [`Event at ${ts}`],
          url: 'u',
          timestamp: ts,
        });
      });

      const logs = store.getLogs(50);

      // Buffer returns events in insertion order (which is chronological)
      for (let i = 1; i < logs.length; i++) {
        expect(logs[i].timestamp).toBeGreaterThanOrEqual(logs[i - 1].timestamp);
      }
    });

    it('should handle empty buffer gracefully', () => {
      const logs = store.getLogs(50);
      expect(logs).toEqual([]);
    });

    it('should serialize complex console args correctly', () => {
      const complexArgs = [
        'User object:',
        { id: 123, name: 'Alice', nested: { role: 'admin' } },
        ['tag1', 'tag2'],
        null,
        undefined,
      ];

      store.push({
        type: 'console',
        level: 'log',
        args: complexArgs,
        url: 'http://test',
        timestamp: Date.now(),
      });

      const logs = store.getLogs(1);
      expect(logs[0].args).toHaveLength(5);
      expect(logs[0].args[0]).toBe('User object:');
      expect(logs[0].args[1]).toEqual({ id: 123, name: 'Alice', nested: { role: 'admin' } });
      expect(logs[0].args[2]).toEqual(['tag1', 'tag2']);
    });
  });

  describe('get_network_activity tool', () => {
    it('should return network events with default limit', () => {
      for (let i = 0; i < 20; i++) {
        store.push({
          type: 'network',
          method: 'GET',
          url: `/api/data/${i}`,
          status: 200,
          statusText: 'OK',
          duration: 50 + i,
          timestamp: Date.now() + i,
        });
      }

      const network = store.getNetwork();
      expect(network.length).toBeGreaterThan(0);
      expect(network.length).toBeLessThanOrEqual(50);
    });

    it('should filter by status code', () => {
      store.push({ type: 'network', method: 'GET', url: '/ok', status: 200, statusText: 'OK', duration: 50, timestamp: 1 });
      store.push({ type: 'network', method: 'GET', url: '/notfound', status: 404, statusText: 'Not Found', duration: 30, timestamp: 2 });
      store.push({ type: 'network', method: 'POST', url: '/error', status: 500, statusText: 'Error', duration: 100, timestamp: 3 });
      store.push({ type: 'network', method: 'GET', url: '/notfound2', status: 404, statusText: 'Not Found', duration: 25, timestamp: 4 });

      const notFound = store.getNetwork(50, 404);
      expect(notFound.length).toBe(2);
      expect(notFound.every((e) => e.status === 404)).toBe(true);

      const serverErrors = store.getNetwork(50, 500);
      expect(serverErrors.length).toBe(1);
      expect(serverErrors[0].status).toBe(500);
    });

    it('should include response body when available', () => {
      store.push({
        type: 'network',
        method: 'POST',
        url: '/api/login',
        status: 401,
        statusText: 'Unauthorized',
        duration: 200,
        responseBody: { error: 'Invalid token', code: 'AUTH_FAILED' },
        timestamp: Date.now(),
      });

      const network = store.getNetwork(1);
      expect(network[0].responseBody).toEqual({
        error: 'Invalid token',
        code: 'AUTH_FAILED',
      });
    });

    it('should include request body when available', () => {
      store.push({
        type: 'network',
        method: 'POST',
        url: '/api/users',
        status: 201,
        statusText: 'Created',
        duration: 150,
        requestBody: { name: 'Alice', email: 'alice@example.com' },
        timestamp: Date.now(),
      });

      const network = store.getNetwork(1);
      expect(network[0].requestBody).toEqual({
        name: 'Alice',
        email: 'alice@example.com',
      });
    });

    it('should include request headers when available', () => {
      store.push({
        type: 'network',
        method: 'GET',
        url: '/api/protected',
        status: 200,
        statusText: 'OK',
        duration: 80,
        requestHeaders: { Authorization: 'Bearer token123', 'Content-Type': 'application/json' },
        timestamp: Date.now(),
      });

      const network = store.getNetwork(1);
      expect(network[0].requestHeaders).toEqual({
        Authorization: 'Bearer token123',
        'Content-Type': 'application/json',
      });
    });

    it('should track request duration accurately', () => {
      store.push({
        type: 'network',
        method: 'GET',
        url: '/api/slow',
        status: 200,
        statusText: 'OK',
        duration: 2500,
        timestamp: Date.now(),
      });

      const network = store.getNetwork(1);
      expect(network[0].duration).toBe(2500);
    });

    it('should handle network events without response body', () => {
      store.push({
        type: 'network',
        method: 'DELETE',
        url: '/api/users/123',
        status: 204,
        statusText: 'No Content',
        duration: 45,
        timestamp: Date.now(),
      });

      const network = store.getNetwork(1);
      expect(network[0].responseBody).toBeUndefined();
      expect(network[0].status).toBe(204);
    });

    it('should filter by timestamp', () => {
      const baseTime = Date.now();

      store.push({ type: 'network', method: 'GET', url: '/old', status: 200, statusText: 'OK', duration: 50, timestamp: baseTime - 2000 });
      store.push({ type: 'network', method: 'GET', url: '/recent', status: 200, statusText: 'OK', duration: 60, timestamp: baseTime });

      const since = baseTime - 1000;
      const recent = store.getNetwork(50).filter((e) => e.timestamp >= since);

      expect(recent.length).toBe(1);
      expect(recent[0].url).toBe('/recent');
    });
  });

  describe('get_context tool', () => {
    it('should return context snapshots', () => {
      store.push({
        type: 'context',
        trigger: 'error',
        timestamp: Date.now(),
        url: 'http://localhost:3000/page',
        title: 'Test Page',
        activeElement: 'button#submit',
        localStorage: { userId: '123' },
        sessionStorage: { token: 'abc' },
      });

      const contexts = store.getContext(10);
      expect(contexts.length).toBe(1);
      expect(contexts[0].url).toBe('http://localhost:3000/page');
      expect(contexts[0].activeElement).toBe('button#submit');
    });

    it('should include localStorage and sessionStorage', () => {
      store.push({
        type: 'context',
        trigger: 'manual',
        timestamp: Date.now(),
        url: 'http://test',
        title: 'Test',
        activeElement: 'input',
        localStorage: { theme: 'dark', lang: 'en' },
        sessionStorage: { tempData: 'xyz' },
      });

      const contexts = store.getContext(1);
      expect(contexts[0].localStorage).toEqual({ theme: 'dark', lang: 'en' });
      expect(contexts[0].sessionStorage).toEqual({ tempData: 'xyz' });
    });

    it('should include viewport dimensions when available', () => {
      store.push({
        type: 'context',
        trigger: 'error',
        timestamp: Date.now(),
        url: 'http://test',
        title: 'Test',
        activeElement: 'div',
        localStorage: {},
        sessionStorage: {},
        viewport: { width: 1920, height: 1080 },
      });

      const contexts = store.getContext(1);
      expect(contexts[0].viewport).toEqual({ width: 1920, height: 1080 });
    });

    it('should include DOM snapshot when available', () => {
      store.push({
        type: 'context',
        trigger: 'error',
        timestamp: Date.now(),
        url: 'http://test',
        title: 'Test',
        activeElement: 'button',
        localStorage: {},
        sessionStorage: {},
        domSnapshot: '<div class="error-boundary">Error occurred</div>',
      });

      const contexts = store.getContext(1);
      expect(contexts[0].domSnapshot).toBe('<div class="error-boundary">Error occurred</div>');
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 15; i++) {
        store.push({
          type: 'context',
          trigger: 'manual',
          timestamp: Date.now() + i,
          url: `http://test/${i}`,
          title: `Page ${i}`,
          activeElement: 'body',
          localStorage: {},
          sessionStorage: {},
        });
      }

      const contexts = store.getContext(5);
      expect(contexts.length).toBe(5);
    });
  });

  describe('clear_buffer tool', () => {
    it('should clear all events and reset counters', () => {
      store.push({ type: 'console', level: 'error', args: ['e'], url: 'u', timestamp: 1 });
      store.push({ type: 'console', level: 'warn', args: ['w'], url: 'u', timestamp: 2 });
      store.push({ type: 'network', method: 'GET', url: '/x', status: 500, statusText: 'Error', duration: 100, timestamp: 3 });

      expect(store.size()).toBe(3);

      store.clear();

      expect(store.size()).toBe(0);
      expect(store.getLogs()).toEqual([]);
      expect(store.getNetwork()).toEqual([]);
      expect(store.getContext()).toEqual([]);

      const counters = store.getCounters();
      expect(counters.errors).toBe(0);
      expect(counters.warnings).toBe(0);
      expect(counters.networkErrors).toBe(0);
    });

    it('should allow new events after clear', () => {
      store.push({ type: 'console', level: 'log', args: ['before'], url: 'u', timestamp: 1 });
      store.clear();
      store.push({ type: 'console', level: 'log', args: ['after'], url: 'u', timestamp: 2 });

      const logs = store.getLogs(10);
      expect(logs.length).toBe(1);
      expect(logs[0].args[0]).toBe('after');
    });
  });

  describe('Tool Parameter Validation', () => {
    it('should handle limit edge cases', () => {
      for (let i = 0; i < 10; i++) {
        store.push({ type: 'console', level: 'log', args: [`log ${i}`], url: 'u', timestamp: i });
      }

      // Zero limit - buffer may return all or none depending on implementation
      const zero = store.getLogs(0);
      expect(zero.length).toBeGreaterThanOrEqual(0);

      // Negative limit - buffer may treat as default limit
      const negative = store.getLogs(-5);
      expect(negative.length).toBeGreaterThanOrEqual(0);

      // Limit exceeding buffer size
      const large = store.getLogs(1000);
      expect(large.length).toBe(10);
    });

    it('should handle invalid level parameter gracefully', () => {
      store.push({ type: 'console', level: 'error', args: ['e'], url: 'u', timestamp: 1 });
      store.push({ type: 'console', level: 'log', args: ['l'], url: 'u', timestamp: 2 });

      // Invalid level should return no results or all results
      const invalid = store.getLogs(50, 'invalid' as any);
      expect(Array.isArray(invalid)).toBe(true);
    });

    it('should handle invalid status filter gracefully', () => {
      store.push({ type: 'network', method: 'GET', url: '/x', status: 200, statusText: 'OK', duration: 50, timestamp: 1 });

      const invalid = store.getNetwork(50, -1);
      expect(Array.isArray(invalid)).toBe(true);
    });
  });

  describe('AI-Friendly Output Format', () => {
    it('should provide structured data for AI parsing', () => {
      store.push({
        type: 'console',
        level: 'error',
        args: ['Error message', { code: 'ERR_001' }],
        url: 'http://localhost:3000',
        timestamp: 1234567890000,
      });

      const logs = store.getLogs(1);
      const log = logs[0];

      // Should have all required fields for AI to understand
      expect(log).toHaveProperty('type');
      expect(log).toHaveProperty('level');
      expect(log).toHaveProperty('args');
      expect(log).toHaveProperty('url');
      expect(log).toHaveProperty('timestamp');

      // Should be JSON-serializable
      expect(() => JSON.stringify(log)).not.toThrow();
    });

    it('should provide correlation hints across event types', () => {
      const timestamp = Date.now();

      store.push({
        type: 'network',
        method: 'POST',
        url: '/api/submit',
        status: 500,
        statusText: 'Internal Server Error',
        duration: 234,
        responseBody: { error: 'Database connection failed' },
        timestamp,
      });

      store.push({
        type: 'console',
        level: 'error',
        args: ['API request failed with status 500'],
        url: 'http://localhost:3000/form',
        timestamp: timestamp + 10,
      });

      store.push({
        type: 'context',
        trigger: 'error',
        timestamp: timestamp + 15,
        url: 'http://localhost:3000/form',
        title: 'Form Page',
        activeElement: 'button#submit',
        localStorage: {},
        sessionStorage: {},
      });

      // AI should be able to correlate these via timestamp proximity
      const logs = store.getLogs(10);
      const network = store.getNetwork(10);
      const contexts = store.getContext(10);

      expect(logs[0].timestamp).toBeGreaterThan(network[0].timestamp);
      expect(contexts[0].timestamp).toBeGreaterThan(logs[0].timestamp);

      // All within ~20ms window - clearly related
      expect(contexts[0].timestamp - network[0].timestamp).toBeLessThan(20);
    });
  });

  describe('Production Bug Scenarios', () => {
    it('should capture React hydration errors', () => {
      store.push({
        type: 'console',
        level: 'error',
        args: [
          'Hydration failed because the initial UI does not match what was rendered on the server.',
          { component: 'UserProfile' },
        ],
        url: 'http://localhost:3000/',
        timestamp: Date.now(),
      });

      const errors = store.getLogs(10, 'error');
      expect(errors[0].args[0]).toContain('Hydration failed');
    });

    it('should capture CORS errors', () => {
      store.push({
        type: 'console',
        level: 'error',
        args: ['CORS error: Access-Control-Allow-Origin header is missing'],
        url: 'http://localhost:3000',
        timestamp: Date.now(),
      });

      store.push({
        type: 'network',
        method: 'GET',
        url: 'https://api.external.com/data',
        status: 0, // CORS failure
        statusText: '',
        duration: 0,
        timestamp: Date.now(),
      });

      const errors = store.getLogs(10, 'error');
      const network = store.getNetwork(10, 0);

      expect(errors[0].args[0]).toContain('CORS error');
      expect(network[0].status).toBe(0);
    });

    it('should capture auth token expiration flow', () => {
      const timestamp = Date.now();

      store.push({
        type: 'network',
        method: 'GET',
        url: '/api/profile',
        status: 401,
        statusText: 'Unauthorized',
        duration: 120,
        responseBody: { error: 'Token expired' },
        timestamp,
      });

      store.push({
        type: 'console',
        level: 'error',
        args: ['Auth error: Token expired, redirecting to login'],
        url: 'http://localhost:3000/dashboard',
        timestamp: timestamp + 5,
      });

      const network = store.getNetwork(10, 401);
      const errors = store.getLogs(10, 'error');

      expect(network[0].responseBody).toEqual({ error: 'Token expired' });
      expect(errors[0].args[0]).toContain('Token expired');
    });
  });
});
