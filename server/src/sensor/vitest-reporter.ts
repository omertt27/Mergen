/**
 * vitest-reporter.ts — Mergen programmatic reporter for Vitest.
 *
 * Streams structured test results to the local Mergen server so the
 * causal engine can correlate failing tests with active code changes.
 *
 * Usage (vitest.config.ts):
 *   import { defineConfig } from 'vitest/config';
 *   export default defineConfig({
 *     test: {
 *       reporters: ['default', './node_modules/mergen-server/dist/sensor/vitest-reporter.js'],
 *     },
 *   });
 *
 * The reporter auto-discovers the server port (3000–3010) and is
 * completely silent when the Mergen server is not running.
 */

import http from 'http';
import type { Reporter, TestCase, TestSuite } from 'vitest/node';

const DEFAULT_PORT = 3000;
const MERGEN_PORT = parseInt(process.env.MERGEN_PORT ?? String(DEFAULT_PORT), 10);

function postEvent(payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: MERGEN_PORT,
      path: '/ingest',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  req.write(body);
  req.end();
}

export default class MergenReporter implements Reporter {
  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result() as {
      state: string;
      errors?: unknown[];
      duration?: number;
    } | null;
    if (!result) return;

    const stateMap: Record<string, 'pass' | 'fail' | 'skip' | 'todo'> = {
      passed: 'pass',
      failed: 'fail',
      skipped: 'skip',
      todo: 'todo',
    };

    const rawCase = testCase as TestCase & {
      file?: { name?: string };
      module?: { filepath?: string; id?: string };
      moduleId?: string;
    };

    const firstError = result.errors?.[0];
    const normalizedError = firstError
      ? (firstError instanceof Error
        ? { message: firstError.message, stack: firstError.stack }
        : { message: String(firstError), stack: undefined })
      : undefined;

    postEvent({
      type: 'test_result',
      runner: 'vitest',
      file: rawCase.file?.name ?? rawCase.module?.filepath ?? rawCase.module?.id ?? rawCase.moduleId ?? '',
      name: testCase.fullName,
      status: stateMap[result.state] ?? 'skip',
      duration: result.duration ?? undefined,
      error: normalizedError,
      timestamp: Date.now(),
    });
  }

  onTestSuiteResult(_suite: TestSuite): void {
    // Individual test cases are reported above; suite-level is not needed.
  }
}
