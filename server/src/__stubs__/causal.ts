/**
 * Open-source stub for the closed-source causal analysis module.
 */

import type {
  ConsoleEvent, NetworkEvent, ContextSnapshot,
  TerminalOutputEvent, ProcessExitEvent, CIEvent, DeploymentEvent,
} from '../sensor/buffer.js';
import { recordPrediction, applyCalibration } from './calibration.js';

export interface Hypothesis {
  tag:                   string;
  summary:               string;
  confidence:            'HIGH' | 'MEDIUM' | 'LOW';
  confidenceScore:       number;
  causalPath:            string[];
  evidence:              string[];
  fixHint:               string | null;
  fixAction?:            string | null;
  remediationConfidence?: number;
  pid?:                  string;
  calibrationAction?:    string;
}

export interface ErrorBlock {
  message:      string;
  stack?:       string;
  primaryFrame: { file: string; line: number; col: number } | null;
  ts:           number;
}

export interface ChainEvent {
  kind:    'error' | 'warn' | 'network_fail' | 'network_ok' | 'state';
  ts:      number;
  message: string;
}

export interface CorrelatedNetwork {
  url:              string;
  method:           string;
  status:           number;
  duration:         number;
  error?:           string | null;
  requestBody?:     unknown;
  responseBody?:    unknown;
  requestHeaders?:  Record<string, string>;
  responseHeaders?: Record<string, string>;
  msBeforeError:    number | null;
  ts:               number;
}

export interface CausalChain {
  hypotheses:            Hypothesis[];
  suppressedHypotheses:  Hypothesis[];
  errors:                ErrorBlock[];
  chain:                 ChainEvent[];
  contextPack:           string;
  correlatedNetwork:     CorrelatedNetwork[];
  correlatedBackend:     ChainEvent[];
  stateAtError:          ContextSnapshot | null;
}

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-auth-token', 'x-api-key',
]);
const NETWORK_WINDOW_MS = 30_000;
const STATE_WINDOW_MS   = 5_000;
const SLOW_THRESHOLD_MS = 1_000;

function parseFrame(stack: string): { file: string; line: number; col: number } | null {
  const m = stack.match(/at\s+\S+\s+\((.+):(\d+):(\d+)\)/);
  return m ? { file: m[1], line: Number(m[2]), col: Number(m[3]) } : null;
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

function isEmptyBody(body: unknown): boolean {
  if (body == null) return false;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === 'object') return Object.keys(body as Record<string, unknown>).length === 0;
  if (typeof body === 'string') return body === '' || body === '[]' || body === '{}';
  return false;
}

function buildContextPack(
  errors: ErrorBlock[],
  correlated: CorrelatedNetwork[],
  state: ContextSnapshot | null,
): string {
  const lines: string[] = [];

  if (errors.length === 0) {
    lines.push('No console errors');
  } else {
    lines.push('## Console Errors');
    for (const e of errors) lines.push(`- ${e.message}`);
  }

  const failed = correlated.filter((n) => n.status >= 400 || n.status === 0 || n.error);
  if (failed.length > 0) {
    lines.push('\n## Network Failures');
    for (const n of failed) {
      let errPart = '';
      if (n.error) {
        const isNet = n.error.includes('NET_ERR') || n.error.includes('net::');
        errPart = ` (${isNet ? 'NET_ERR: ' + n.error : n.error})`;
      }
      lines.push(`- ${n.method} ${n.url} → ${n.status}${errPart}`);
      if (n.requestBody != null) lines.push(`  Request: ${JSON.stringify(n.requestBody)}`);
      if (n.responseBody != null) {
        const rb = typeof n.responseBody === 'string' ? n.responseBody : JSON.stringify(n.responseBody);
        lines.push(`  Response: ${rb}`);
      }
      if (n.requestHeaders && Object.keys(n.requestHeaders).length > 0) {
        lines.push(`  Request-Headers: ${JSON.stringify(redactHeaders(n.requestHeaders))}`);
      }
      if (n.responseHeaders && Object.keys(n.responseHeaders).length > 0) {
        lines.push(`  Response-Headers: ${JSON.stringify(n.responseHeaders)}`);
      }
    }
  }

  lines.push('\n## Invisible State');
  if (!state) {
    lines.push('No storage snapshot');
  } else {
    const ls = state.localStorage ?? {};
    if (Object.keys(ls).length === 0) {
      lines.push('localStorage: (empty)');
    } else {
      lines.push('localStorage:');
      for (const [k, v] of Object.entries(ls)) {
        const flag = (v === 'null' || v === '') ? ' *NULL/EMPTY*' : '';
        lines.push(`  ${k}: ${v}${flag}`);
      }
    }
  }

  return lines.join('\n');
}

function detectHypotheses(
  errors: ErrorBlock[],
  allNetwork: NetworkEvent[],
  correlated: CorrelatedNetwork[],
  state: ContextSnapshot | null,
  terminal: TerminalOutputEvent[],
  processExits: ProcessExitEvent[],
  ciEvents: CIEvent[],
  deployments: DeploymentEvent[],
): Hypothesis[] {
  const hyps: Hypothesis[] = [];
  const ls = state?.localStorage ?? {};
  const errorText = errors.map((e) => e.message).join(' ').toLowerCase();

  // ── Detector 1 (original): auth_token_not_persisted ──────────────────────
  if (errors.length > 0) {
    const hasNullToken = Object.entries(ls).some(
      ([k, v]) => /token|session/i.test(k) && (v === 'null' || v === ''),
    );
    const hasLoginSuccess = correlated.some(
      (n) => /login|auth/i.test(n.url) && n.status >= 200 && n.status < 300,
    );
    if (hasNullToken && hasLoginSuccess && /token|null|read|undefined/i.test(errorText)) {
      hyps.push({
        tag: 'auth_token_not_persisted',
        summary: 'Token not persisted to localStorage after successful login — reads null on next access',
        confidence: 'HIGH',
        confidenceScore: 0.88,
        causalPath: ['login request succeeded', 'token not written to localStorage', 'next read returns null'],
        evidence: ['token: null in localStorage', 'successful login request', errorText.slice(0, 80)],
        fixHint: 'Ensure the token is written to localStorage immediately after the login response.',
        fixAction: null,
        remediationConfidence: 0.7,
      });
    }
  }

  // ── Silent detectors — fire even without console errors ───────────────────

  // Detector 2 (original): slow_api_silent
  for (const n of allNetwork) {
    if (n.status >= 200 && n.status < 300 && n.duration > SLOW_THRESHOLD_MS
        && !hyps.find((h) => h.tag === 'slow_api_silent')) {
      hyps.push({
        tag: 'slow_api_silent',
        summary: `${n.url} took ${n.duration}ms with no error — silent performance regression`,
        confidence: 'MEDIUM',
        confidenceScore: 0.65,
        causalPath: ['slow 2xx', 'no error thrown', 'UI blocked silently'],
        evidence: [`${n.method} ${n.url} duration=${n.duration}ms status=${n.status}`],
        fixHint: 'Check server-side query performance or add a timeout with user feedback.',
        fixAction: null,
        remediationConfidence: 0.5,
      });
    }

    // Detector 3 (original): empty_response_silent
    if (n.status >= 200 && n.status < 300 && isEmptyBody(n.responseBody)
        && !hyps.find((h) => h.tag === 'empty_response_silent')) {
      hyps.push({
        tag: 'empty_response_silent',
        summary: `${n.url} returned 200 with empty body — possible silent data loss`,
        confidence: 'MEDIUM',
        confidenceScore: 0.60,
        causalPath: ['200 with empty body', 'component renders nothing', 'blank UI'],
        evidence: [`${n.method} ${n.url} status=200 responseBody=empty`],
        fixHint: 'Verify the API query conditions are not overly restrictive.',
        fixAction: null,
        remediationConfidence: 0.4,
      });
    }
  }

  // ── Detector 4: disk_full ─────────────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'disk_full')) {
    const diskFullMsg = errors.find(
      (e) => /ENOSPC|No space left on device/i.test(e.message),
    );
    if (diskFullMsg) {
      hyps.push({
        tag: 'disk_full',
        summary: 'Disk full (ENOSPC) — process cannot write; likely log or temp file accumulation',
        confidence: 'HIGH',
        confidenceScore: 0.94,
        causalPath: ['disk write attempted', 'ENOSPC returned', 'process cannot continue'],
        evidence: [diskFullMsg.message.slice(0, 120)],
        fixHint: 'Free disk space — check for log accumulation or leaked temp files: `df -h && du -sh /var/log/*`',
        fixAction: null,
        remediationConfidence: 0.8,
      });
    }
  }

  // ── Detector 5: missing_env_var ───────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'missing_env_var')) {
    const envMsg = errors.find((e) => {
      const m = e.message;
      return /(process\.env|undefined.*env|env.*undefined)/i.test(m)
        || (m.includes('Cannot read properties of undefined') && !/auth|token/i.test(m));
    });
    if (envMsg) {
      hyps.push({
        tag: 'missing_env_var',
        summary: 'Missing environment variable — accessing undefined config at runtime',
        confidence: 'HIGH',
        confidenceScore: 0.89,
        causalPath: ['env var not set', 'process.env lookup returns undefined', 'downstream code throws'],
        evidence: [envMsg.message.slice(0, 120)],
        fixHint: 'Check for missing environment variables: `printenv | sort` and verify all required vars are set.',
        fixAction: null,
        remediationConfidence: 0.75,
      });
    }
  }

  // ── Detector 6: unhandled_promise_rejection ───────────────────────────────
  if (!hyps.find((h) => h.tag === 'unhandled_promise_rejection')) {
    const promiseMsg = errors.find(
      (e) => /UnhandledPromiseRejection|Unhandled promise rejection/i.test(e.message),
    );
    if (promiseMsg) {
      hyps.push({
        tag: 'unhandled_promise_rejection',
        summary: 'Unhandled promise rejection — async error escaped without a .catch() handler',
        confidence: 'HIGH',
        confidenceScore: 0.91,
        causalPath: ['async operation threw', 'no .catch() handler', 'process emits UnhandledPromiseRejection'],
        evidence: [promiseMsg.message.slice(0, 120)],
        fixHint: 'Add a .catch() handler or try/catch to the async operation flagged in the stack trace.',
        fixAction: null,
        remediationConfidence: 0.8,
      });
    }
  }

  // ── Detector 7: connection_refused ────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'connection_refused')) {
    const connMsg = errors.find(
      (e) => /ECONNREFUSED|connection refused/i.test(e.message),
    );
    if (connMsg) {
      hyps.push({
        tag: 'connection_refused',
        summary: 'Connection refused — target service is not running or not accepting connections',
        confidence: 'HIGH',
        confidenceScore: 0.87,
        causalPath: ['client attempts TCP connect', 'kernel returns ECONNREFUSED', 'request fails immediately'],
        evidence: [connMsg.message.slice(0, 120)],
        fixHint: 'Target service is not running or not accepting connections. Check `lsof -i :<port>` or restart the service.',
        fixAction: null,
        remediationConfidence: 0.75,
      });
    }
  }

  // ── Detector 8: rate_limit_silent ─────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'rate_limit_silent')) {
    const rateLimitNet = allNetwork.find((n) => n.status === 429);
    if (rateLimitNet) {
      // "silent" if no console error within 5s of the 429
      const hasNearbyError = errors.some(
        (e) => Math.abs(e.ts - rateLimitNet.timestamp) <= 5_000,
      );
      if (!hasNearbyError) {
        hyps.push({
          tag: 'rate_limit_silent',
          summary: `${rateLimitNet.url} returned 429 with no console error — rate limit hit silently`,
          confidence: 'MEDIUM',
          confidenceScore: 0.82,
          causalPath: ['request sent', 'server returns 429', 'client swallows error silently'],
          evidence: [`${rateLimitNet.method} ${rateLimitNet.url} status=429`],
          fixHint: 'Implement exponential backoff on 429 responses and surface the rate limit to the user.',
          fixAction: null,
          remediationConfidence: 0.65,
        });
      }
    }
  }

  // ── Detector 9: cors_preflight_failure ────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'cors_preflight_failure')) {
    const corsFail = allNetwork.find(
      (n) => (n.method === 'OPTIONS' && n.status >= 400)
        || (n.status === 0 && /CORS|blocked by CORS/i.test(n.error ?? '')),
    );
    if (corsFail) {
      hyps.push({
        tag: 'cors_preflight_failure',
        summary: 'CORS preflight failed — browser blocked the cross-origin request',
        confidence: 'HIGH',
        confidenceScore: 0.86,
        causalPath: ['browser sends OPTIONS preflight', 'server rejects or missing CORS headers', 'actual request blocked'],
        evidence: [`${corsFail.method} ${corsFail.url} status=${corsFail.status}${corsFail.error ? ' error=' + corsFail.error : ''}`],
        fixHint: 'Add CORS headers for the preflight origin: `Access-Control-Allow-Origin` and `Access-Control-Allow-Methods`.',
        fixAction: null,
        remediationConfidence: 0.8,
      });
    }
  }

  // ── Detector 10: jwt_expiry ───────────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'jwt_expiry')) {
    const unauthorizedRequests = allNetwork.filter((n) => n.status === 401);
    if (unauthorizedRequests.length > 0) {
      // Check if there were prior successful requests to the same host (session degraded mid-use)
      const failedHosts = new Set(
        unauthorizedRequests.map((n) => {
          try { return new URL(n.url).host; } catch { return n.url; }
        }),
      );
      const hadPriorSuccess = allNetwork.some((n) => {
        if (n.status < 200 || n.status >= 300) return false;
        try {
          return failedHosts.has(new URL(n.url).host)
            && unauthorizedRequests.some((u) => n.timestamp < u.timestamp);
        } catch { return false; }
      });
      if (hadPriorSuccess) {
        const sample = unauthorizedRequests[0];
        hyps.push({
          tag: 'jwt_expiry',
          summary: 'Session token expired mid-use — prior requests succeeded but now returning 401',
          confidence: 'HIGH',
          confidenceScore: 0.88,
          causalPath: ['requests succeeded with valid token', 'token TTL elapsed', 'subsequent requests return 401'],
          evidence: [`${sample.method} ${sample.url} status=401`, 'prior successful requests to same host'],
          fixHint: 'Token has expired. Implement refresh-token rotation or extend the JWT TTL.',
          fixAction: null,
          remediationConfidence: 0.75,
        });
      }
    }
  }

  // ── Detector 11: n_plus_one_query ─────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'n_plus_one_query')) {
    // Group network events into 3-second buckets and look for >8 requests with the same path prefix
    if (allNetwork.length > 8) {
      const sorted = [...allNetwork].sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < sorted.length; i++) {
        const windowStart = sorted[i].timestamp;
        const windowEvents = sorted.filter(
          (n) => n.timestamp >= windowStart && n.timestamp <= windowStart + 3_000,
        );
        if (windowEvents.length > 8) {
          // Check if they share a common path prefix (strip trailing ID segment)
          const pathPrefixes = windowEvents.map((n) => {
            try {
              const u = new URL(n.url);
              // Strip last path segment (likely an ID)
              return u.pathname.replace(/\/[^/]+$/, '');
            } catch { return n.url.replace(/\/[^/]+$/, ''); }
          });
          const prefixCounts = pathPrefixes.reduce<Record<string, number>>((acc, p) => {
            acc[p] = (acc[p] ?? 0) + 1;
            return acc;
          }, {});
          const topPrefix = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0];
          if (topPrefix && topPrefix[1] > 8) {
            hyps.push({
              tag: 'n_plus_one_query',
              summary: `N+1 query pattern: ${topPrefix[1]} requests to ${topPrefix[0]}/... within 3 seconds`,
              confidence: 'MEDIUM',
              confidenceScore: 0.72,
              causalPath: ['per-item fetch in loop', 'N separate HTTP requests fired', 'latency multiplies with list size'],
              evidence: [`${topPrefix[1]} requests matching ${topPrefix[0]}/* within 3s`],
              fixHint: 'Replace per-item fetches with a batch endpoint or join at the data layer.',
              fixAction: null,
              remediationConfidence: 0.6,
            });
            break;
          }
        }
      }
    }
  }

  // ── Detector 12: health_check_degraded ────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'health_check_degraded')) {
    const healthFail = allNetwork.find(
      (n) => /\/health|\/ping|\/ready|\/live/i.test(n.url)
        && (n.status >= 400 || n.duration > 2_000),
    );
    if (healthFail) {
      hyps.push({
        tag: 'health_check_degraded',
        summary: `Health endpoint degraded — ${healthFail.url} returned ${healthFail.status} or took ${healthFail.duration}ms`,
        confidence: 'MEDIUM',
        confidenceScore: 0.79,
        causalPath: ['health check called', 'dependent service (DB/cache) slow or down', 'health endpoint returns non-2xx or times out'],
        evidence: [`${healthFail.method} ${healthFail.url} status=${healthFail.status} duration=${healthFail.duration}ms`],
        fixHint: 'Health endpoint is degraded. Check dependent services (DB, cache) and resource limits.',
        fixAction: null,
        remediationConfidence: 0.6,
      });
    }
  }

  // ── Detector 13: memory_leak_oom ─────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'memory_leak_oom')) {
    const oomExit = processExits.find((p) => p.reason === 'oom');
    if (oomExit) {
      hyps.push({
        tag: 'memory_leak_oom',
        summary: `Process killed by OOM killer (${oomExit.process}) — heap exceeded available memory`,
        confidence: 'HIGH',
        confidenceScore: 0.93,
        causalPath: ['heap grows unbounded', 'OS OOM killer fires', 'process exits with reason=oom'],
        evidence: [`process exit reason=oom process=${oomExit.process}`],
        fixHint: 'Process killed by OOM. Profile heap with `node --inspect` or add `--max-old-space-size` as a stopgap.',
        fixAction: null,
        remediationConfidence: 0.7,
      });
    }
  }

  // ── Detector 14: deployment_induced_regression ────────────────────────────
  if (!hyps.find((h) => h.tag === 'deployment_induced_regression')) {
    const TEN_MINUTES = 10 * 60 * 1_000;
    const recentDeploy = deployments.find((d) => {
      if (d.status !== 'success') return false;
      const deployTs = d.timestamp ?? 0;
      return errors.some((e) => e.ts >= deployTs && e.ts <= deployTs + TEN_MINUTES);
    });
    if (recentDeploy) {
      hyps.push({
        tag: 'deployment_induced_regression',
        summary: `Errors appeared within 10 minutes of a successful deployment — likely regression introduced by the deploy`,
        confidence: 'HIGH',
        confidenceScore: 0.88,
        causalPath: ['deployment succeeded', 'new code activated', 'errors emerge within 10 minutes'],
        evidence: [
          `deployment status=success at ${new Date(recentDeploy.timestamp ?? 0).toISOString()}`,
          `first error at ${new Date(errors[0]?.ts ?? 0).toISOString()}`,
        ],
        fixHint: 'Rollback to the previous deployment: `kubectl rollout undo deployment/<name>` or `git revert HEAD && deploy`.',
        fixAction: null,
        remediationConfidence: 0.75,
      });
    }
  }

  // ── Detector 15: db_migration_lock ───────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'db_migration_lock')) {
    const THIRTY_MINUTES = 30 * 60 * 1_000;
    const now = Date.now();
    const recentDeploy = deployments.find(
      (d) => now - (d.timestamp ?? 0) <= THIRTY_MINUTES,
    );
    const dbTimeouts = allNetwork.filter(
      (n) => n.duration > 5_000 && /db|database|postgres|mysql|mongo|redis/i.test(n.url),
    );
    if (recentDeploy && dbTimeouts.length > 0) {
      hyps.push({
        tag: 'db_migration_lock',
        summary: 'DB timeouts after recent deployment — migration may have locked a table',
        confidence: 'MEDIUM',
        confidenceScore: 0.74,
        causalPath: ['deployment ran migrations', 'migration holds table lock', 'subsequent DB queries timeout'],
        evidence: [
          `${dbTimeouts.length} DB request(s) with duration >5s`,
          `recent deployment within 30 minutes`,
        ],
        fixHint: 'Check for locked tables: `SHOW PROCESSLIST` (MySQL) or `SELECT * FROM pg_stat_activity` (Postgres). Kill blocking queries.',
        fixAction: null,
        remediationConfidence: 0.6,
      });
    }
  }

  // ── Detector 16: stale_cache ─────────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'stale_cache')) {
    const has304 = allNetwork.some((n) => n.status === 304);
    if (has304 && errors.length > 0) {
      hyps.push({
        tag: 'stale_cache',
        summary: 'Cached resource (304 Not Modified) served while console errors present — possible stale cache',
        confidence: 'MEDIUM',
        confidenceScore: 0.69,
        causalPath: ['browser uses cached resource (304)', 'cached version is stale or broken', 'page errors on stale asset'],
        evidence: ['network status=304 observed', `${errors.length} console error(s) present`],
        fixHint: 'Force cache bypass with `Cache-Control: no-cache` on the erroring request or add a cache-busting query param.',
        fixAction: null,
        remediationConfidence: 0.5,
      });
    }
  }

  // ── Detector 17: cascading_timeout ───────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'cascading_timeout')) {
    const SIXTY_SECONDS = 60_000;
    const timeoutEvents = allNetwork.filter(
      (n) => n.status === 0 || n.status === 504 || n.status === 503,
    );
    if (timeoutEvents.length >= 3) {
      // Check they span multiple distinct hosts and fit within a 60-second window
      const hosts = new Set(
        timeoutEvents.map((n) => {
          try { return new URL(n.url).host; } catch { return n.url; }
        }),
      );
      const sorted = [...timeoutEvents].sort((a, b) => a.timestamp - b.timestamp);
      const windowMs = (sorted[sorted.length - 1].timestamp) - sorted[0].timestamp;
      if (hosts.size >= 2 && windowMs <= SIXTY_SECONDS) {
        hyps.push({
          tag: 'cascading_timeout',
          summary: `Cascading timeouts: ${timeoutEvents.length} failures across ${hosts.size} services within ${Math.round(windowMs / 1000)}s`,
          confidence: 'MEDIUM',
          confidenceScore: 0.76,
          causalPath: ['upstream service fails', 'dependent services timeout waiting', 'cascade spreads across services'],
          evidence: [
            `${timeoutEvents.length} timeout/503/504 events across ${hosts.size} hosts`,
            `window: ${Math.round(windowMs / 1000)}s`,
          ],
          fixHint: 'Multiple upstream services are failing. Start with the service that failed first and check its resource limits.',
          fixAction: null,
          remediationConfidence: 0.55,
        });
      }
    }
  }

  // ── Detector 18: connection_pool_exhausted ────────────────────────────────
  if (!hyps.find((h) => h.tag === 'connection_pool_exhausted')) {
    const poolFails = allNetwork.filter((n) => {
      const errStr = (n.error ?? '').toLowerCase();
      return n.status === 0 || errStr.includes('etimedout') || errStr.includes('econnreset');
    });
    if (poolFails.length >= 5) {
      // All failing to the same host
      const hosts = new Set(
        poolFails.map((n) => {
          try { return new URL(n.url).host; } catch { return n.url; }
        }),
      );
      if (hosts.size === 1) {
        const host = [...hosts][0];
        hyps.push({
          tag: 'connection_pool_exhausted',
          summary: `Connection pool exhausted — ${poolFails.length} consecutive timeouts/resets to ${host}`,
          confidence: 'HIGH',
          confidenceScore: 0.81,
          causalPath: ['all pool connections in use', 'new requests cannot acquire connection', 'ETIMEDOUT / ECONNRESET returned'],
          evidence: [`${poolFails.length} failed connections to ${host}`],
          fixHint: 'Connection pool exhausted. Increase pool size or check for connection leaks: `SHOW STATUS LIKE \'Threads_connected\'`.',
          fixAction: null,
          remediationConfidence: 0.65,
        });
      }
    }
  }

  // ── Detector 19: session_fixation ────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'session_fixation')) {
    const sessionKey = Object.keys(ls).find((k) => /sessionId|session_id/i.test(k));
    if (sessionKey) {
      const preLoginSessionId = ls[sessionKey];
      // Look for a successful login in correlated network events
      const loginSuccess = correlated.find(
        (n) => /login|auth/i.test(n.url) && n.status >= 200 && n.status < 300,
      );
      if (loginSuccess && preLoginSessionId && preLoginSessionId !== 'null' && preLoginSessionId !== '') {
        // If the same session ID persists after login, that is a session fixation risk
        // The state snapshot is taken around error time, so if the session hasn't changed it's suspect
        hyps.push({
          tag: 'session_fixation',
          summary: 'Session ID unchanged after successful login — potential session fixation vulnerability',
          confidence: 'MEDIUM',
          confidenceScore: 0.73,
          causalPath: ['pre-login session ID set', 'login succeeds', 'session ID not rotated', 'attacker can reuse pre-auth session'],
          evidence: [`${sessionKey} present before and after login`, `login to ${loginSuccess.url} returned ${loginSuccess.status}`],
          fixHint: 'Regenerate session ID immediately after successful login to prevent session fixation attacks.',
          fixAction: null,
          remediationConfidence: 0.7,
        });
      }
    }
  }

  // ── Detector 20: failed_migration ────────────────────────────────────────
  if (!hyps.find((h) => h.tag === 'failed_migration')) {
    const failedCIWithMigration = ciEvents.find(
      (ci) => ci.status === 'failure'
        && /migrat/i.test(JSON.stringify(ci)),
    );
    const terminalMigrationFail = terminal.find(
      (t) => /migration failed/i.test(t.data),
    );
    if (failedCIWithMigration || terminalMigrationFail) {
      const evidence: string[] = [];
      if (failedCIWithMigration) evidence.push(`CI event status=failure (migration keyword matched)`);
      if (terminalMigrationFail) evidence.push('terminal output: "migration failed"');
      hyps.push({
        tag: 'failed_migration',
        summary: 'Database migration failed — schema may be inconsistent between app and DB',
        confidence: 'HIGH',
        confidenceScore: 0.85,
        causalPath: ['migration script executed', 'migration step errored', 'schema left in partial state'],
        evidence,
        fixHint: 'Migration failed in CI. Check the migration SQL for syntax errors or version conflicts.',
        fixAction: null,
        remediationConfidence: 0.7,
      });
    }
  }

  return hyps;
}

export async function buildCausalChain(
  logs: ConsoleEvent[],
  network: NetworkEvent[],
  contexts: ContextSnapshot[],
  _firedAt?: number,
  terminal: TerminalOutputEvent[] = [],
  processExits: ProcessExitEvent[] = [],
  ciEvents: CIEvent[] = [],
  deployments: DeploymentEvent[] = [],
  _infraEvents?: unknown[],
): Promise<CausalChain> {
  const errors   = logs.filter((e) => e.level === 'error');
  const warnings = logs.filter((e) => e.level === 'warn');
  const firstErrorTs = errors[0]?.timestamp ?? null;

  const errorBlocks: ErrorBlock[] = errors.map((e) => ({
    message:      (e.args?.[0] as string | undefined) ?? '',
    stack:        e.stack,
    primaryFrame: e.stack ? parseFrame(e.stack) : null,
    ts:           e.timestamp,
  }));

  const correlated: CorrelatedNetwork[] = network.map((n) => ({
    url:             n.url,
    method:          n.method,
    status:          n.status,
    duration:        n.duration,
    error:           n.error ?? null,
    requestBody:     n.requestBody,
    responseBody:    n.responseBody,
    requestHeaders:  n.requestHeaders,
    responseHeaders: n.responseHeaders,
    msBeforeError:   firstErrorTs !== null ? firstErrorTs - n.timestamp : null,
    ts:              n.timestamp,
  })).filter((n) => {
    if (firstErrorTs === null) return true;
    const diff = firstErrorTs - n.ts;
    return diff >= 0 && diff <= NETWORK_WINDOW_MS;
  });

  let stateAtError: ContextSnapshot | null = null;
  if (firstErrorTs !== null) {
    const eligible = contexts.filter((c) => {
      const diff = firstErrorTs - c.timestamp;
      return diff >= 0 && diff <= STATE_WINDOW_MS;
    });
    if (eligible.length > 0) {
      stateAtError = eligible.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
    }
  }

  const chain: ChainEvent[] = [
    ...contexts.map((c): ChainEvent => ({ kind: 'state', ts: c.timestamp, message: `${c.component ?? 'unknown'} state captured` })),
    ...errors.map((e): ChainEvent => ({ kind: 'error', ts: e.timestamp, message: (e.args?.[0] as string) ?? '' })),
    ...warnings.map((w): ChainEvent => ({ kind: 'warn', ts: w.timestamp, message: (w.args?.[0] as string) ?? '' })),
    ...network.map((n): ChainEvent => ({
      kind: (n.status >= 400 || n.status === 0 || !!n.error) ? 'network_fail' : 'network_ok',
      ts: n.timestamp,
      message: `${n.method} ${n.url} → ${n.status}`,
    })),
  ].sort((a, b) => a.ts - b.ts);

  const contextPack = buildContextPack(errorBlocks, correlated, stateAtError);
  const rawHyps = detectHypotheses(
    errorBlocks, network, correlated, stateAtError,
    terminal, processExits, ciEvents, deployments,
  );

  const tagged = recordPrediction(rawHyps) as Hypothesis[];
  const { active, suppressed } = applyCalibration(tagged) as { active: Hypothesis[]; suppressed: Hypothesis[] };

  return { errors: errorBlocks, chain, contextPack, correlatedNetwork: correlated, correlatedBackend: [], stateAtError, hypotheses: active, suppressedHypotheses: suppressed };
}

export function fixActionToCommand(_action: string | null): string | null {
  return null;
}
