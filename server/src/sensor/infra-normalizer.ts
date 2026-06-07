/**
 * infra-normalizer.ts — Normalizes heterogeneous infra signals into a common InfraEvent type.
 *
 * Sources:
 *   - Datadog RuntimeFact markdown (from compactor.ts)
 *   - ProcessExitEvent from the ring buffer (OOM kills, crashes)
 *
 * The InfraEvent type is the primary input to infra-detectors.ts, which runs
 * alongside the browser detector set in causal.ts. This lets the causal engine
 * reason about production incidents that produce no browser events at all —
 * database pool exhaustion, OOM kills, rate limit cascades, TLS failures.
 */

import type { ProcessExitEvent } from './buffer.js';

// ── InfraEvent type ───────────────────────────────────────────────────────────

export type InfraEventKind =
  | 'db_connection_pool_exhausted'
  | 'memory_pressure'
  | 'oom_kill'
  | 'downstream_latency_spike'
  | 'certificate_expiry'
  | 'rate_limit_cascade'
  | 'pod_crash'
  | 'service_unavailable'
  | 'disk_pressure'
  | 'queue_backlog'
  | 'upstream_error'
  | 'slow_query';

export interface InfraEvent {
  kind: InfraEventKind;
  timestamp: number;
  service: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  attributes: Record<string, string | number>;
  source: 'otlp' | 'k8s' | 'process' | 'datadog';
}

// ── Signal patterns ───────────────────────────────────────────────────────────

const DB_POOL_RE    = /connection pool|too many connections|connection limit|max_connections|connection refused|connection timeout|ECONNREFUSED|ETIMEDOUT|pool exhausted/i;
const OOM_RE        = /out of memory|oom|oomkilled|memory limit exceeded|heap out of memory|cannot allocate|allocation failed/i;
const RATE_LIMIT_RE = /rate limit|too many requests|429|throttled|quota exceeded|backpressure/i;
const CERT_RE       = /certificate|ssl error|tls|x509|handshake failed|certificate expired|certificate verify|CERT_HAS_EXPIRED/i;
const SLOW_QUERY_RE = /slow query|query timeout|statement timeout|lock timeout|deadlock|lock wait/i;
const DISK_RE       = /no space left|disk full|disk pressure|i\/o error|write failed|ENOSPC/i;
const QUEUE_RE      = /queue full|queue depth|consumer lag|backlog|offset lag/i;
const SVC_UNAVAIL_RE = /service unavailable|503|upstream connect error|no healthy upstream|ECONNRESET/i;

// ── Normalizer: Datadog RuntimeFact markdown string ───────────────────────────

/**
 * Parses the RuntimeFact markdown produced by compactor.ts and extracts
 * structured InfraEvent signals from the error message and stack trace text.
 */
export function normalizeRuntimeFactMarkdown(
  markdown: string,
  service: string,
  timestamp = Date.now(),
): InfraEvent[] {
  const events: InfraEvent[] = [];

  // Extract structured fields from the RuntimeFact markdown
  const errMatch      = markdown.match(/\*\*(?:Error|Exception):\*\*\s*`?([^\n`]+)`?/);
  const endpointMatch = markdown.match(/\*\*Failure Endpoint:\*\*\s*`([^`]+)`/);
  const traceMatch    = markdown.match(/\*\*Trace ID:\*\*\s*`([^`]+)`/);
  const fileMatch     = markdown.match(/\*\*(?:Failing Location|Local Code Context)\*\*\s*\(`([^:`)]+):(\d+)`\)/);

  const errorMessage = errMatch?.[1]?.trim() ?? 'unknown error';
  const endpoint     = endpointMatch?.[1] ?? '';
  const traceId      = traceMatch?.[1] ?? '';
  const failingFile  = fileMatch?.[1] ?? '';
  const failingLine  = fileMatch?.[2] ? parseInt(fileMatch[2], 10) : 0;

  const baseAttrs: Record<string, string | number> = {
    endpoint,
    traceId,
    ...(failingFile ? { file: failingFile } : {}),
    ...(failingLine ? { line: failingLine } : {}),
  };

  // Run each pattern against the full markdown (captures error msg + stack trace)
  if (DB_POOL_RE.test(markdown)) {
    events.push({
      kind: 'db_connection_pool_exhausted',
      timestamp, service, severity: 'critical',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  if (OOM_RE.test(markdown)) {
    events.push({
      kind: 'memory_pressure',
      timestamp, service, severity: 'critical',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  if (RATE_LIMIT_RE.test(markdown)) {
    events.push({
      kind: 'rate_limit_cascade',
      timestamp, service, severity: 'high',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  if (CERT_RE.test(markdown)) {
    events.push({
      kind: 'certificate_expiry',
      timestamp, service, severity: 'critical',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  if (SLOW_QUERY_RE.test(markdown)) {
    events.push({
      kind: 'slow_query',
      timestamp, service, severity: 'high',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  if (DISK_RE.test(markdown)) {
    events.push({
      kind: 'disk_pressure',
      timestamp, service, severity: 'critical',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  if (QUEUE_RE.test(markdown)) {
    events.push({
      kind: 'queue_backlog',
      timestamp, service, severity: 'high',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  if (SVC_UNAVAIL_RE.test(markdown)) {
    events.push({
      kind: 'service_unavailable',
      timestamp, service, severity: 'critical',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  // Fallback: emit a generic upstream_error if nothing more specific matched.
  // This ensures every RuntimeFact produces at least one InfraEvent so the
  // infra detector set always has something to work with.
  if (events.length === 0 && errorMessage !== 'unknown error') {
    events.push({
      kind: 'upstream_error',
      timestamp, service, severity: 'high',
      message: errorMessage,
      attributes: baseAttrs,
      source: 'datadog',
    });
  }

  return events;
}

// ── Normalizer: ProcessExitEvent (OOM kills, crashes) ─────────────────────────

export function normalizeProcessExits(exits: ProcessExitEvent[]): InfraEvent[] {
  return exits
    .filter((e) => e.exitCode !== 0 || e.reason === 'oom')
    .map((e): InfraEvent => {
      const isOom = e.reason === 'oom' || e.exitCode === 137; // 137 = 128 + SIGKILL
      return {
        kind: isOom ? 'oom_kill' : 'pod_crash',
        timestamp: e.timestamp,
        service: e.process,
        severity: 'critical',
        message: `\`${e.process}\` exited with code ${e.exitCode} (${e.reason}${e.signal ? ` — ${e.signal}` : ''})`,
        attributes: {
          process: e.process,
          exitCode: e.exitCode,
          reason: e.reason,
          ...(e.signal ? { signal: e.signal } : {}),
          ...(e.memoryLimitBytes ? { memoryLimitMb: Math.round(e.memoryLimitBytes / 1_048_576) } : {}),
        },
        source: 'process',
      };
    });
}
