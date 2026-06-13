import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../../../sensor/buffer.js';
import type { BrowserFixture } from '../types.js';

const NOW = 1_000_000;

function err(msg: string, ts = NOW): ConsoleEvent {
  return {
    type: 'console', level: 'error', args: [msg],
    stack: `Error: ${msg}\n    at handler (http://localhost/dist/bundle.js:42:10)`,
    url: 'http://localhost/app', timestamp: ts,
  };
}

function net(url: string, status: number, ts = NOW - 2000, extras: Partial<NetworkEvent> = {}): NetworkEvent {
  return { type: 'network', method: 'POST', url, status, statusText: String(status), duration: 150, timestamp: ts, ...extras };
}

function ctx(ts = NOW - 100, ls: Record<string, string> = {}): ContextSnapshot {
  return {
    type: 'context', trigger: 'error', timestamp: ts,
    url: 'http://localhost/dashboard', title: 'Dashboard',
    activeElement: "button[type='submit']", component: 'LoginForm',
    localStorage: ls, sessionStorage: {},
  };
}

/**
 * Browser detector fixtures.
 *
 * buildCausalChain is closed-source; these fixtures define:
 *   - the INPUT events (errors/networks/contexts)
 *   - the EXPECTED return value for that input
 *
 * The Level 1 eval uses vi.mock to inject a deterministic implementation that
 * returns the expected hypothesis, then checks the eval harness correctly
 * routes and validates the result.  When the real implementation is present
 * locally the same fixtures drive an integration-level check.
 */
export const BROWSER_FIXTURES: BrowserFixture[] = [
  {
    name: 'auth-token-not-persisted',
    errors: [err('Cannot read properties of null (reading "token")')],
    networks: [net('/api/login', 200, NOW - 4000)],
    contexts: [ctx(NOW - 200, { token: 'null', sessionId: '' })],
    expected: { topTag: 'auth_token_not_persisted', confidenceScoreMin: 0.70 },
  },
  {
    name: 'failed-request-caused-crash',
    errors: [err('Uncaught TypeError: Cannot read properties of undefined (reading "data")')],
    networks: [net('/api/user/profile', 500, NOW - 500)],
    contexts: [ctx()],
    expected: { topTag: 'failed_request_caused_crash', confidenceScoreMin: 0.50 },
  },
  {
    name: 'null-storage-key-multiple-nulls',
    errors: [err('TypeError: Cannot read properties of null (reading "userId")')],
    networks: [],
    contexts: [ctx(NOW - 100, { authToken: 'null', userId: 'null', sessionId: '' })],
    expected: { topTag: 'null_storage_key', confidenceScoreMin: 0.50 },
  },
  {
    name: 'net-err-connection-refused',
    errors: [err('fetch failed')],
    networks: [net('/api/payments', 0, NOW - 300, { error: 'net::ERR_CONNECTION_REFUSED' })],
    contexts: [],
    expected: { topTag: 'failed_request_caused_crash', confidenceScoreMin: 0.40 },
  },
];