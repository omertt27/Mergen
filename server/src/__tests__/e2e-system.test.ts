/**
 * e2e-system.test.ts — Industry-level end-to-end system tests
 *
 * Tests the complete Mergen pipeline: HTTP ingest → buffer → MCP tools
 * Verifies production-critical scenarios, concurrency, reliability, and security.
 */

import net from 'net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import type { Server as HttpServer } from 'http';
import { createApp } from '../app.js';
import { store } from '../sensor/buffer.js';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const TEST_SECRET = 'test-secret-123';
const TEST_VERSION = '1.0.0-test';

describe('E2E System Tests', () => {
  let app: Express;
  let server: HttpServer;
  let baseURL: string;

  beforeEach(async () => {
    store.clear();
    const port = await findFreePort();
    app = createApp({ serverVersion: TEST_VERSION, localSecret: TEST_SECRET, port, bindHost: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => {
        baseURL = `http://127.0.0.1:${port}`;
      });
      server.on('error', reject);
      server.on('listening', async () => {
        // Poll /health rather than using a fixed delay — eliminates flakiness on
        // slow CI machines where the TCP stack isn't ready the instant listen fires.
        for (let i = 0; i < 40; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) { resolve(); return; }
          } catch {}
          await new Promise(r => setTimeout(r, 25));
        }
        reject(new Error(`Server on port ${port} did not become healthy within 1s`));
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  describe('Complete Pipeline Tests', () => {
    it('should handle complete error scenario from browser to MCP tool', async () => {
      // Simulate sequence of events that lead to an error
      const timestamp = Date.now();

      // 1. User action triggers network request
      const networkEvent = {
        type: 'network',
        method: 'POST',
        url: 'http://localhost:3000/api/login',
        status: 401,
        statusText: 'Unauthorized',
        duration: 245,
        responseBody: { error: 'Invalid credentials' },
        timestamp: timestamp - 100,
      };

      // 2. Console error is logged
      const consoleEvent = {
        type: 'console',
        level: 'error',
        args: ['Login failed:', { status: 401 }],
        url: 'http://localhost:3000/login',
        timestamp,
      };

      // 3. Context snapshot is captured
      const contextEvent = {
        type: 'context',
        trigger: 'error',
        timestamp,
        url: 'http://localhost:3000/login',
        title: 'Login Page',
        activeElement: 'button#login-submit',
        localStorage: { lastUser: 'test@example.com' },
        sessionStorage: {},
      };

      // Ingest all events
      const events = [networkEvent, consoleEvent, contextEvent];
      for (const event of events) {
        const response = await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        expect(response.ok).toBe(true);
      }

      // Verify complete picture is available via buffer (MCP tools would use this)
      const logs = store.getLogs(50, 'error');
      const network = store.getNetwork(50, 401);
      const contexts = store.getContext(10);

      expect(logs).toHaveLength(1);
      expect(logs[0].args[0]).toBe('Login failed:');

      expect(network).toHaveLength(1);
      expect(network[0].status).toBe(401);
      expect(network[0].responseBody).toEqual({ error: 'Invalid credentials' });

      expect(contexts).toHaveLength(1);
      expect(contexts[0].activeElement).toBe('button#login-submit');
      expect(contexts[0].localStorage.lastUser).toBe('test@example.com');
    });

    it('should maintain event ordering under concurrent load', async () => {
      const eventCount = 100;
      const events = Array.from({ length: eventCount }, (_, i) => ({
        type: 'console',
        level: 'log',
        args: [`Event ${i}`],
        url: 'http://test',
        timestamp: Date.now() + i, // Incrementing timestamps
      }));

      // Send all events concurrently
      const promises = events.map((event) =>
        fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        })
      );

      const responses = await Promise.all(promises);
      expect(responses.every((r) => r.ok)).toBe(true);

      // Verify all events stored and ordered by timestamp
      const stored = store.getLogs(eventCount);
      expect(stored.length).toBe(eventCount);

      // Check ordering
      for (let i = 1; i < stored.length; i++) {
        expect(stored[i].timestamp).toBeGreaterThanOrEqual(stored[i - 1].timestamp);
      }
    });

    it('should handle rapid-fire events from single tab', async () => {
      // Simulate 50 rapid console.log calls (e.g., in a loop)
      const rapidEvents = Array.from({ length: 50 }, (_, i) => ({
        type: 'console',
        level: 'log',
        args: [`Loop iteration ${i}`],
        url: 'http://localhost:5173',
        timestamp: Date.now() + i,
      }));

      for (const event of rapidEvents) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
      }

      const logs = store.getLogs(50);
      expect(logs.length).toBe(50);
    });
  });

  describe('Buffer Behavior Under Load', () => {
    it('should prioritize errors over info logs when buffer is full', async () => {
      // Fill buffer with info logs
      const infoLogs = Array.from({ length: 200 }, (_, i) => ({
        type: 'console',
        level: 'log',
        args: [`Info log ${i}`],
        url: 'http://test',
        timestamp: Date.now() + i,
      }));

      for (const log of infoLogs) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(log),
        });
      }

      // Now send critical errors
      const errors = [
        {
          type: 'console',
          level: 'error',
          args: ['Critical error 1'],
          url: 'http://test',
          timestamp: Date.now() + 300,
        },
        {
          type: 'console',
          level: 'error',
          args: ['Critical error 2'],
          url: 'http://test',
          timestamp: Date.now() + 301,
        },
      ];

      for (const error of errors) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(error),
        });
      }

      const storedErrors = store.getLogs(200, 'error');
      expect(storedErrors.length).toBe(2);
      expect(storedErrors[0].args[0]).toBe('Critical error 1');
      expect(storedErrors[1].args[0]).toBe('Critical error 2');
    });

    it('should maintain accurate counters under concurrent writes', async () => {
      const events = [
        ...Array.from({ length: 10 }, () => ({
          type: 'console',
          level: 'error',
          args: ['error'],
          url: 'http://test',
          timestamp: Date.now(),
        })),
        ...Array.from({ length: 15 }, () => ({
          type: 'console',
          level: 'warn',
          args: ['warning'],
          url: 'http://test',
          timestamp: Date.now(),
        })),
        ...Array.from({ length: 5 }, () => ({
          type: 'network',
          method: 'GET',
          url: '/api/fail',
          status: 500,
          statusText: 'Internal Server Error',
          duration: 100,
          timestamp: Date.now(),
        })),
      ];

      // Shuffle for concurrent submission
      const shuffled = events.sort(() => Math.random() - 0.5);

      await Promise.all(
        shuffled.map((event) =>
          fetch(`${baseURL}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          })
        )
      );

      const counters = store.getCounters();
      expect(counters.errors).toBe(10);
      expect(counters.warnings).toBe(15);
      expect(counters.networkErrors).toBe(5);
    });
  });

  describe('Security & Input Validation', () => {
    it('should reject malformed JSON', async () => {
      const response = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });

      expect(response.status).toBe(400);
      const data = await response.json() as any;
      expect(data.error).toBe('malformed JSON');
    });

    it('should reject events with missing required fields', async () => {
      const invalidEvent = {
        type: 'console',
        // missing level, args, url, timestamp
      };

      const response = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidEvent),
      });

      expect(response.ok).toBe(false);
    });

    it('should reject events with invalid types', async () => {
      const invalidEvent = {
        type: 'invalid_type',
        level: 'error',
        args: ['test'],
        url: 'http://test',
        timestamp: Date.now(),
      };

      const response = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidEvent),
      });

      expect(response.ok).toBe(false);
    });

    it('should sanitize extremely large payloads', async () => {
      const hugeArray = Array(10000).fill('x'.repeat(1000));

      const event = {
        type: 'console',
        level: 'log',
        args: hugeArray,
        url: 'http://test',
        timestamp: Date.now(),
      };

      const response = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      // Should either accept (with truncation) or reject gracefully
      expect([200, 201, 413]).toContain(response.status);
    });

    it('should require secret for mutating endpoints', async () => {
      const response = await fetch(`${baseURL}/clear`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        // No x-mergen-secret header
      });

      expect(response.status).toBe(401);
      const data = await response.json() as any;
      expect(data.error).toBe('unauthorized');
    });

    it('should allow mutating endpoints with valid secret', async () => {
      const response = await fetch(`${baseURL}/clear`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': TEST_SECRET,
        },
      });

      expect(response.ok).toBe(true);
    });

    it('should reject wrong secret', async () => {
      const response = await fetch(`${baseURL}/clear`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': 'wrong-secret',
        },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Error Recovery & Resilience', () => {
    it('should continue accepting events after validation errors', async () => {
      // Send invalid event
      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'invalid' }),
      });

      // Send valid event
      const validEvent = {
        type: 'console',
        level: 'log',
        args: ['valid log'],
        url: 'http://test',
        timestamp: Date.now(),
      };

      const response = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validEvent),
      });

      expect(response.ok).toBe(true);
      const logs = store.getLogs(10);
      expect(logs.length).toBe(1);
      expect(logs[0].args[0]).toBe('valid log');
    });

    it('should handle OPTIONS preflight correctly', async () => {
      const response = await fetch(`${baseURL}/ingest`, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    it('should maintain buffer integrity after clear', async () => {
      // Add events
      const event = {
        type: 'console',
        level: 'log',
        args: ['test'],
        url: 'http://test',
        timestamp: Date.now(),
      };

      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      expect(store.size()).toBe(1);

      // Clear
      await fetch(`${baseURL}/clear`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': TEST_SECRET,
        },
      });

      expect(store.size()).toBe(0);

      // Add more events - should work normally
      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      expect(store.size()).toBe(1);
    });
  });

  describe('Health & Monitoring', () => {
    it('should respond to health checks', async () => {
      const response = await fetch(`${baseURL}/health`);
      expect(response.ok).toBe(true);

      const data = await response.json() as any;
      expect(data).toHaveProperty('status');
      expect(data.status).toBe('ok');
    });

    it('should provide buffer statistics', async () => {
      // Add mix of events
      const events = [
        { type: 'console', level: 'error', args: ['e1'], url: 'u', timestamp: 1 },
        { type: 'console', level: 'error', args: ['e2'], url: 'u', timestamp: 2 },
        { type: 'console', level: 'warn', args: ['w1'], url: 'u', timestamp: 3 },
        { type: 'network', method: 'GET', url: '/fail', status: 500, statusText: 'Error', duration: 100, timestamp: 4 },
      ];

      for (const event of events) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
      }

      const counters = store.getCounters();
      expect(counters.errors).toBe(2);
      expect(counters.warnings).toBe(1);
      expect(counters.networkErrors).toBe(1);
      expect(store.size()).toBe(4);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle typical SPA navigation flow', async () => {
      const timestamp = Date.now();

      // Page load
      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'console',
          level: 'log',
          args: ['App initialized'],
          url: 'http://localhost:5173/',
          timestamp: timestamp,
        }),
      });

      // User navigates
      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'network',
          method: 'GET',
          url: 'http://localhost:5173/api/users',
          status: 200,
          statusText: 'OK',
          duration: 85,
          timestamp: timestamp + 100,
        }),
      });

      // Component error
      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'console',
          level: 'error',
          args: ['Cannot read property "name" of undefined'],
          url: 'http://localhost:5173/users',
          timestamp: timestamp + 200,
        }),
      });

      const logs = store.getLogs(50);
      const network = store.getNetwork(50);

      expect(logs.length).toBeGreaterThanOrEqual(2);
      expect(network.length).toBe(1);

      // Can filter for just errors
      const errors = store.getLogs(50, 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toContain('Cannot read property');
    });

    it('should handle WebSocket-style event stream', async () => {
      // Simulate real-time updates (chat, notifications, etc.)
      const messageCount = 30;
      const messages = Array.from({ length: messageCount }, (_, i) => ({
        type: 'console',
        level: 'log',
        args: [`WebSocket message ${i}: {"event":"update","data":{}}`],
        url: 'http://localhost:3000/chat',
        timestamp: Date.now() + i * 10,
      }));

      for (const msg of messages) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
        });
      }

      const logs = store.getLogs(messageCount);
      expect(logs.length).toBe(messageCount);
    });

    it('should correlate network errors with console errors', async () => {
      const timestamp = Date.now();

      // Failed API request
      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'network',
          method: 'POST',
          url: 'http://localhost:3000/api/submit',
          status: 422,
          statusText: 'Unprocessable Entity',
          duration: 150,
          responseBody: { errors: ['Email is required'] },
          timestamp: timestamp,
        }),
      });

      // Error handler logs it
      await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'console',
          level: 'error',
          args: ['Form submission failed:', { status: 422, errors: ['Email is required'] }],
          url: 'http://localhost:3000/form',
          timestamp: timestamp + 5,
        }),
      });

      // MCP tool would retrieve both with time filter
      const recentNetwork = store.getNetwork(50).filter(e => e.timestamp >= timestamp);
      const recentErrors = store.getLogs(50, 'error').filter(e => e.timestamp >= timestamp);

      expect(recentNetwork.length).toBe(1);
      expect(recentErrors.length).toBe(1);

      // Can correlate by status code
      expect(recentNetwork[0].status).toBe(422);
      expect(recentErrors[0].args[1]).toHaveProperty('status', 422);
    });
  });

  describe('Performance Characteristics', () => {
    it('should handle bursts without blocking', async () => {
      const startTime = Date.now();

      // Send 100 events as fast as possible
      const promises = Array.from({ length: 100 }, (_, i) =>
        fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Burst event ${i}`],
            url: 'http://test',
            timestamp: Date.now(),
          }),
        })
      );

      await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Should complete in under 2 seconds even under load
      expect(duration).toBeLessThan(2000);
      expect(store.size()).toBe(100);
    });

    it('should maintain O(1) buffer operations', async () => {
      // Fill buffer to capacity (200 events)
      for (let i = 0; i < 200; i++) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Event ${i}`],
            url: 'http://test',
            timestamp: Date.now() + i,
          }),
        });
      }

      // Adding more events should still be fast (triggers eviction)
      const startTime = Date.now();

      for (let i = 0; i < 50; i++) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Overflow event ${i}`],
            url: 'http://test',
            timestamp: Date.now() + 200 + i,
          }),
        });
      }

      const duration = Date.now() - startTime;

      // Eviction shouldn't cause linear slowdown
      expect(duration).toBeLessThan(1000);
      expect(store.size()).toBe(200); // Should stay at capacity
    });
  });
});
