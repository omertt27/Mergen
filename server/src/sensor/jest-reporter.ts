/**
 * jest-reporter.ts — Mergen custom reporter for Jest.
 *
 * Usage (jest.config.js):
 *   reporters: ['default', '<rootDir>/node_modules/mergen-server/dist/sensor/jest-reporter.js']
 *
 * Silent when Mergen server is not running.
 */

import http from 'http';

const MERGEN_PORT = parseInt(process.env.MERGEN_PORT ?? '3000', 10);

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

interface JestTestResult {
  testFilePath: string;
  testResults: Array<{
    fullName: string;
    status: 'passed' | 'failed' | 'skipped' | 'todo' | 'pending';
    duration?: number | null;
    failureMessages: string[];
  }>;
}

export default class MergenJestReporter {
  constructor(_globalConfig: unknown, _options: unknown) {}

  onTestResult(_test: unknown, testResult: JestTestResult): void {
    const file = testResult.testFilePath;
    for (const t of testResult.testResults) {
      const stateMap: Record<string, 'pass' | 'fail' | 'skip' | 'todo'> = {
        passed: 'pass',
        failed: 'fail',
        skipped: 'skip',
        todo: 'todo',
        pending: 'skip',
      };
      const error = t.failureMessages[0]
        ? { message: t.failureMessages[0].split('\n')[0], stack: t.failureMessages[0] }
        : undefined;

      postEvent({
        type: 'test_result',
        runner: 'jest',
        file,
        name: t.fullName,
        status: stateMap[t.status] ?? 'skip',
        duration: t.duration ?? undefined,
        error,
        timestamp: Date.now(),
      });
    }
  }
}
