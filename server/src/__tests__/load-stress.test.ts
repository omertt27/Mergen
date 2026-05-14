/**
 * load-stress.test.ts — Load testing and stress testing
 *
 * Tests system behavior under heavy load, concurrent access, and edge conditions.
 * Industry-level stress testing to verify production readiness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { createApp } from '../app.js';
import { store } from '../sensor/buffer.js';

const TEST_SECRET = 'load-test-secret';
const TEST_VERSION = '1.0.0-load';

describe('Load & Stress Tests', () => {
  let app: express.Express;
  let server: HttpServer;
  let baseURL: string;

  beforeEach(async () => {
    store.clear();
    app = createApp({ serverVersion: TEST_VERSION, localSecret: TEST_SECRET });

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 3000;
        baseURL = `http://127.0.0.1:${port}`;
        // Add small delay to ensure server is fully ready
        setTimeout(resolve, 50);
      });
      server.on('error', reject);
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  describe('High-Volume Event Ingestion', () => {
    it('should handle 1000 concurrent ingest requests', async () => {
      const eventCount = 1000;
      const startTime = Date.now();

      const promises = Array.from({ length: eventCount }, (_, i) =>
        fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Load test event ${i}`],
            url: 'http://test',
            timestamp: Date.now() + i,
          }),
        })
      );

      const responses = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // All requests should succeed
      const successCount = responses.filter((r) => r.ok).length;
      expect(successCount).toBeGreaterThan(eventCount * 0.95); // Allow 5% failure under extreme load

      // Should complete in reasonable time (< 5s for 1000 requests)
      expect(duration).toBeLessThan(5000);

      console.log(`✓ Processed ${successCount}/${eventCount} events in ${duration}ms`);
      console.log(`  Throughput: ${Math.round(successCount / (duration / 1000))} events/sec`);
    }, 10000); // 10s timeout

    it('should maintain data integrity under concurrent writes', async () => {
      const errorCount = 100;
      const warnCount = 150;
      const networkCount = 50;

      const events = [
        ...Array.from({ length: errorCount }, (_, i) => ({
          type: 'console',
          level: 'error',
          args: [`error ${i}`],
          url: 'http://test',
          timestamp: Date.now(),
        })),
        ...Array.from({ length: warnCount }, (_, i) => ({
          type: 'console',
          level: 'warn',
          args: [`warn ${i}`],
          url: 'http://test',
          timestamp: Date.now(),
        })),
        ...Array.from({ length: networkCount }, (_, i) => ({
          type: 'network',
          method: 'GET',
          url: `/api/${i}`,
          status: 500,
          statusText: 'Error',
          duration: 100,
          timestamp: Date.now(),
        })),
      ];

      // Shuffle and send concurrently
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

      // Verify counters are accurate (buffer is only 200, so some may be evicted)
      const counters = store.getCounters();
      const totalBuffered = store.size();

      expect(totalBuffered).toBeLessThanOrEqual(200);

      // Counters should reflect at least what's in buffer
      const bufferedErrors = store.getLogs(200, 'error').length;
      const bufferedWarnings = store.getLogs(200, 'warn').length;
      const bufferedNetwork = store.getNetwork(200, 500).length;

      expect(counters.errors).toBeGreaterThanOrEqual(bufferedErrors);
      expect(counters.warnings).toBeGreaterThanOrEqual(bufferedWarnings);
      expect(counters.networkErrors).toBeGreaterThanOrEqual(bufferedNetwork);

      console.log(`✓ Buffer integrity maintained: ${totalBuffered} events stored`);
      console.log(`  Errors: ${counters.errors}, Warnings: ${counters.warnings}, Network errors: ${counters.networkErrors}`);
    }, 15000);

    it('should handle rapid bursts from multiple simulated tabs', async () => {
      const tabCount = 10;
      const eventsPerTab = 50;

      const tabPromises = Array.from({ length: tabCount }, async (_, tabId) => {
        const events = Array.from({ length: eventsPerTab }, (_, eventId) => ({
          type: 'console',
          level: 'log',
          args: [`Tab ${tabId} - Event ${eventId}`],
          url: `http://localhost:3000/tab${tabId}`,
          timestamp: Date.now(),
        }));

        return Promise.all(
          events.map((event) =>
            fetch(`${baseURL}/ingest`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(event),
            })
          )
        );
      });

      const results = await Promise.all(tabPromises);
      const totalRequests = tabCount * eventsPerTab;
      const successfulRequests = results.flat().filter((r) => r.ok).length;

      expect(successfulRequests).toBeGreaterThan(totalRequests * 0.95);
      expect(store.size()).toBeGreaterThan(0);
      expect(store.size()).toBeLessThanOrEqual(200);

      console.log(`✓ Multi-tab simulation: ${successfulRequests}/${totalRequests} successful`);
    }, 15000);
  });

  describe('Memory and Buffer Pressure', () => {
    it('should handle buffer overflow gracefully', async () => {
      // Fill buffer beyond capacity
      const overflowCount = 300;

      for (let i = 0; i < overflowCount; i++) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Overflow event ${i}`],
            url: 'http://test',
            timestamp: Date.now() + i,
          }),
        });
      }

      // Buffer should cap at max size
      expect(store.size()).toBeLessThanOrEqual(200);

      // Newest events should be present
      const logs = store.getLogs(10);
      const lastEvent = logs[logs.length - 1];

      expect(lastEvent.args[0]).toContain('Overflow event');
      const eventNumber = parseInt(lastEvent.args[0].match(/\d+/)?.[0] || '0');
      expect(eventNumber).toBeGreaterThan(200); // Old events evicted

      console.log(`✓ Buffer overflow handled: ${store.size()} events retained`);
    }, 10000);

    it('should prioritize high-value events during eviction', async () => {
      // Fill with low-priority logs
      for (let i = 0; i < 200; i++) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Low priority ${i}`],
            url: 'http://test',
            timestamp: Date.now() + i,
          }),
        });
      }

      // Send critical errors
      const criticalErrors = [
        { args: ['Critical error 1: Database connection lost'], timestamp: Date.now() + 1000 },
        { args: ['Critical error 2: Auth service unavailable'], timestamp: Date.now() + 1001 },
        { args: ['Critical error 3: Payment gateway timeout'], timestamp: Date.now() + 1002 },
      ];

      for (const error of criticalErrors) {
        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'error',
            args: error.args,
            url: 'http://test',
            timestamp: error.timestamp,
          }),
        });
      }

      // Critical errors should be retained
      const errors = store.getLogs(200, 'error');
      expect(errors.length).toBe(3);
      expect(errors.some((e) => e.args[0].includes('Database connection lost'))).toBe(true);
      expect(errors.some((e) => e.args[0].includes('Auth service unavailable'))).toBe(true);
      expect(errors.some((e) => e.args[0].includes('Payment gateway timeout'))).toBe(true);

      console.log(`✓ Priority eviction: ${errors.length} critical errors retained`);
    }, 10000);

    it('should handle large payload stress', async () => {
      const largeArgs = [
        'Error with large context:',
        {
          user: { id: 123, name: 'Test User', metadata: Array(100).fill('x').join('') },
          request: { body: Array(500).fill('data').join(',') },
          stack: Array(50).fill('at function (file.js:1:1)').join('\n'),
        },
      ];

      const response = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'console',
          level: 'error',
          args: largeArgs,
          url: 'http://test',
          timestamp: Date.now(),
        }),
      });

      // Should handle gracefully (accept or reject, but not crash)
      expect([200, 201, 413, 400]).toContain(response.status);

      // Server should still be responsive
      const healthCheck = await fetch(`${baseURL}/health`);
      expect(healthCheck.ok).toBe(true);
    });
  });

  describe('Performance Under Load', () => {
    it('should maintain sub-100ms response times under moderate load', async () => {
      const requestCount = 100;
      const responseTimes: number[] = [];

      for (let i = 0; i < requestCount; i++) {
        const startTime = performance.now();

        await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Event ${i}`],
            url: 'http://test',
            timestamp: Date.now(),
          }),
        });

        const duration = performance.now() - startTime;
        responseTimes.push(duration);
      }

      const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      const p95ResponseTime = responseTimes.sort((a, b) => a - b)[Math.floor(requestCount * 0.95)];

      expect(avgResponseTime).toBeLessThan(100); // Average under 100ms
      expect(p95ResponseTime).toBeLessThan(200); // P95 under 200ms

      console.log(`✓ Performance metrics:`);
      console.log(`  Average: ${avgResponseTime.toFixed(2)}ms`);
      console.log(`  P95: ${p95ResponseTime.toFixed(2)}ms`);
      console.log(`  Max: ${Math.max(...responseTimes).toFixed(2)}ms`);
    }, 15000);

    it('should handle sustained load over time', async () => {
      const duration = 5000; // 5 seconds
      const requestsPerSecond = 20;
      const interval = 1000 / requestsPerSecond;

      const startTime = Date.now();
      let requestCount = 0;
      let errorCount = 0;

      while (Date.now() - startTime < duration) {
        try {
          const response = await fetch(`${baseURL}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'console',
              level: 'log',
              args: [`Sustained load event ${requestCount}`],
              url: 'http://test',
              timestamp: Date.now(),
            }),
          });

          if (!response.ok) errorCount++;
          requestCount++;
        } catch (err) {
          errorCount++;
          requestCount++;
        }

        // Wait for next interval
        await new Promise((resolve) => setTimeout(resolve, interval));
      }

      const successRate = requestCount > 0 ? ((requestCount - errorCount) / requestCount) * 100 : 0;

      expect(requestCount).toBeGreaterThan(80); // Should handle most requests
      expect(successRate).toBeGreaterThan(95); // 95%+ success rate

      console.log(`✓ Sustained load test:`);
      console.log(`  Requests: ${requestCount}`);
      console.log(`  Success rate: ${successRate.toFixed(2)}%`);
      console.log(`  Errors: ${errorCount}`);
    }, 10000);
  });

  describe('Concurrent MCP Tool Access', () => {
    it('should handle simultaneous reads from multiple clients', async () => {
      // Populate buffer
      for (let i = 0; i < 50; i++) {
        store.push({
          type: 'console',
          level: 'log',
          args: [`Event ${i}`],
          url: 'http://test',
          timestamp: Date.now() + i,
        });
      }

      // Simulate multiple AI IDE clients reading simultaneously
      const clientCount = 20;

      const readPromises = Array.from({ length: clientCount }, async (_, clientId) => {
        return {
          clientId,
          logs: store.getLogs(50),
          network: store.getNetwork(50),
          contexts: store.getContext(10),
          counters: store.getCounters(),
        };
      });

      const results = await Promise.all(readPromises);

      // All clients should get consistent data
      const firstResult = results[0];

      results.forEach((result) => {
        expect(result.logs.length).toBe(firstResult.logs.length);
        expect(result.counters.errors).toBe(firstResult.counters.errors);
        expect(result.counters.warnings).toBe(firstResult.counters.warnings);
      });

      console.log(`✓ ${clientCount} concurrent reads, all consistent`);
    });

    it('should handle read/write contention', async () => {
      const writeCount = 100;
      const readCount = 50;

      // Concurrent writes and reads
      const writes = Array.from({ length: writeCount }, (_, i) =>
        fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            level: 'log',
            args: [`Concurrent write ${i}`],
            url: 'http://test',
            timestamp: Date.now() + i,
          }),
        }).catch(() => ({ ok: false } as Response))
      );

      const reads = Array.from({ length: readCount }, () =>
        Promise.resolve({
          logs: store.getLogs(50),
          size: store.size(),
        })
      );

      const [writeResults, readResults] = await Promise.all([
        Promise.all(writes),
        Promise.all(reads),
      ]);

      const successfulWrites = writeResults.filter((r) => r.ok).length;
      const successfulReads = readResults.filter((r) => Array.isArray(r.logs)).length;

      expect(successfulWrites).toBeGreaterThan(writeCount * 0.95);
      expect(successfulReads).toBe(readCount);

      console.log(`✓ Read/write contention handled:`);
      console.log(`  Writes: ${successfulWrites}/${writeCount}`);
      console.log(`  Reads: ${successfulReads}/${readCount}`);
    });
  });

  describe('Resource Exhaustion Scenarios', () => {
    it('should reject requests exceeding body size limit', async () => {
      const hugePayload = {
        type: 'console',
        level: 'log',
        args: [Array(100000).fill('x'.repeat(100)).join('')],
        url: 'http://test',
        timestamp: Date.now(),
      };

      const response = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hugePayload),
      });

      // Should reject (413 Payload Too Large or 400 Bad Request)
      expect([413, 400]).toContain(response.status);

      // Server should remain operational
      const healthCheck = await fetch(`${baseURL}/health`);
      expect(healthCheck.ok).toBe(true);
    });

    it('should handle malformed requests without crashing', async () => {
      const malformedRequests = [
        '{"type":"console"', // Truncated JSON
        'not json at all',
        '{"type":"console","level":"error"}', // Missing required fields
        '[]', // Array instead of object
        'null',
        '',
      ];

      for (const body of malformedRequests) {
        const response = await fetch(`${baseURL}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(() => ({ ok: false } as Response));

        // Should reject gracefully
        expect(response.ok).toBe(false);
      }

      // Wait a bit for server to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Server should still work after all malformed requests
      const validRequest = await fetch(`${baseURL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'console',
          level: 'log',
          args: ['valid'],
          url: 'http://test',
          timestamp: Date.now(),
        }),
      }).catch(() => ({ ok: false } as Response));

      expect(validRequest.ok).toBe(true);
    });
  });

  describe('Recovery and Resilience', () => {
    it('should recover after buffer clear under load', async () => {
      // Start generating events
      const generateEvents = async (count: number): Promise<void> => {
        const promises = Array.from({ length: count }, (_, i) =>
          fetch(`${baseURL}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'console',
              level: 'log',
              args: [`Event ${i}`],
              url: 'http://test',
              timestamp: Date.now() + i,
            }),
          }).catch(() => ({ ok: false } as Response))
        );
        await Promise.all(promises);
      };

      // Generate 25 events
      await generateEvents(25);

      const sizeBefore = store.size();
      expect(sizeBefore).toBeGreaterThan(0);

      // Clear buffer
      await fetch(`${baseURL}/clear`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': TEST_SECRET,
        },
      });

      expect(store.size()).toBe(0);

      // Continue generating events
      await generateEvents(25);

      // Should work normally after clear
      const sizeAfter = store.size();
      expect(sizeAfter).toBeGreaterThan(20); // Allow some tolerance
      const logs = store.getLogs(50);
      expect(logs.length).toBeGreaterThan(20);

      console.log(`✓ Buffer recovered successfully after clear (${sizeAfter} events)`);
    });
  });
});
