/**
 * infra-detectors.ts — Hypothesis detectors for infrastructure signals.
 *
 * These detectors run on InfraEvent[] produced by infra-normalizer.ts and
 * are merged with the browser detector results inside buildCausalChain().
 *
 * Each detector handles exactly one failure mode. They run independently
 * and are merged + re-ranked by the same calibration pipeline as the browser
 * detectors — empirical accuracy beats prior confidence over time.
 *
 * Covered failure modes:
 *   - db_connection_pool_exhausted
 *   - oom_kill / memory_pressure
 *   - rate_limit_cascade
 *   - downstream_latency / slow_query
 *   - certificate_expiry
 *   - disk_pressure
 *   - queue_backlog
 *   - service_unavailable
 *   - upstream_error (catch-all fallback)
 */

import type { InfraEvent } from '../sensor/infra-normalizer.js';
import type { Hypothesis } from './causal.js';
import { scoreToConfidence } from './detectors.js';
// FixAction imported as type-only to avoid a dependency on causal.ts at runtime;
// the value is just a plain object literal so no runtime import is needed.
import type { FixAction } from './causal.js';

export type InfraDetector = (events: InfraEvent[]) => Hypothesis | null;

// Datadog APM traces are high-fidelity production signals — not inferred from
// log text. Boost confidence when the matched event came from the compactor.
const DATADOG_BOOST = 0.15;
function withDatadogBoost(base: number, matched: InfraEvent[]): number {
  return matched.some((e) => e.source === 'datadog')
    ? Math.min(base + DATADOG_BOOST, 0.95)
    : base;
}

// ── DB connection pool exhausted ──────────────────────────────────────────────

export function detectDbConnectionPool(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'db_connection_pool_exhausted');
  if (matches.length === 0) return null;

  const p     = matches[0];
  const score = withDatadogBoost(0.80, matches);

  return {
    tag: 'infra_db_connection_pool',
    summary: `Database connection pool exhausted on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    // Fix reliability is lower than diagnostic confidence: resize vs restart vs leak hunt
    // depends on the specific failure mode and cannot be determined from telemetry alone.
    remediationConfidence: 0.60,
    evidence: [
      `Service: \`${p.service}\``,
      `Endpoint: \`${p.attributes.endpoint || 'unknown'}\``,
      `Trace: \`${p.attributes.traceId || 'none'}\``,
      `Source: ${p.source} telemetry`,
    ],
    causalPath: [
      'Request volume exceeded connection pool capacity',
      'New connections queued waiting for a free slot',
      `\`${p.service}\` → timeout / connection refused on \`${p.attributes.endpoint || 'DB'}\``,
    ],
    fixHint: [
      'Increase pool size: set `DB_POOL_MAX` (or `pool.max` in your ORM config).',
      'Check for connection leaks — unclosed transactions hold pool slots indefinitely.',
      'Add a connection pool metrics query to validate utilisation.',
    ].join(' '),
    fixAction: { type: 'service_restart', target: p.service, method: 'kubectl' } as FixAction,
  };
}

// ── OOM kill / memory pressure ────────────────────────────────────────────────

export function detectOomKill(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'oom_kill' || e.kind === 'memory_pressure');
  if (matches.length === 0) return null;

  const p        = matches[0];
  const isHard   = p.kind === 'oom_kill';
  const score    = withDatadogBoost(isHard ? 0.90 : 0.65, matches);
  const exitCode = p.attributes.exitCode;
  const memMb    = p.attributes.memoryLimitMb;

  return {
    tag: 'infra_oom_kill',
    summary: `${isHard ? 'OOM kill' : 'Memory pressure'} on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    // Raising the memory limit restarts the service but does not fix the underlying leak.
    // Remediation confidence is lower: the hint is directionally correct but rarely complete.
    remediationConfidence: isHard ? 0.55 : 0.50,
    evidence: [
      `Service: \`${p.service}\``,
      ...(isHard ? [`Exit code ${exitCode} (SIGKILL — kernel OOM killer fired)`] : []),
      ...(memMb ? [`Memory limit: ${memMb} MB`] : []),
      `Source: ${p.source} telemetry`,
    ],
    causalPath: [
      'RSS / heap grew past the container memory limit',
      'Kernel OOM killer selected and killed the process (exit 137)',
      isHard
        ? `\`${p.service}\` is now restarting — possible CrashLoopBackOff`
        : `\`${p.service}\` experiencing memory pressure — degraded performance`,
    ],
    fixHint: isHard
      ? [
          'Increase container memory limit in k8s manifest / docker-compose.',
          'Heap-profile with `node --inspect` or `py-spy top` to find the leak.',
          'Check for unbounded caches or retained buffers in recent deploys.',
        ].join(' ')
      : [
          'Profile heap allocation. Check for unbounded in-memory caches or event-listener leaks.',
          'Review recent deploys for large data structure growth.',
        ].join(' '),
    fixAction: isHard
      ? ({ type: 'service_restart', target: p.service, method: 'kubectl' } as FixAction)
      : undefined,
  };
}

// ── Rate limit cascade ────────────────────────────────────────────────────────

export function detectRateLimitCascade(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'rate_limit_cascade');
  if (matches.length === 0) return null;

  const p     = matches[0];
  const score = withDatadogBoost(0.75, matches);

  return {
    tag: 'infra_rate_limit_cascade',
    summary: `Rate-limit cascade on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    // The fix (add backoff + honour Retry-After) is correct but requires a code change
    // and deploy — not an immediately executable command. Remediation confidence reflects
    // that the hint cannot be auto-applied without human involvement.
    remediationConfidence: 0.65,
    evidence: [
      `Service: \`${p.service}\``,
      `Endpoint: \`${p.attributes.endpoint || 'unknown'}\``,
      `Source: ${p.source} telemetry`,
    ],
    causalPath: [
      'Upstream API / gateway returned 429 Too Many Requests',
      'Service retried without exponential backoff, amplifying the traffic spike',
      `\`${p.service}\` → retry storm → all requests throttled`,
    ],
    fixHint: [
      'Add exponential backoff with jitter to the retry loop.',
      'Honour the `Retry-After` response header.',
      'Consider a token-bucket circuit breaker to shed load before hitting the upstream limit.',
    ].join(' '),
  };
}

// ── Downstream latency / slow query ──────────────────────────────────────────

export function detectDownstreamLatency(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter(
    (e) => e.kind === 'downstream_latency_spike' || e.kind === 'slow_query',
  );
  if (matches.length === 0) return null;

  const p       = matches[0];
  const isQuery = p.kind === 'slow_query';
  const score   = withDatadogBoost(isQuery ? 0.70 : 0.60, matches);

  return {
    tag: isQuery ? 'infra_slow_query' : 'infra_downstream_latency',
    summary: `${isQuery ? 'Slow DB query' : 'Downstream latency spike'} on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    evidence: [
      `Service: \`${p.service}\``,
      `Endpoint: \`${p.attributes.endpoint || 'unknown'}\``,
      `Source: ${p.source} telemetry`,
    ],
    causalPath: isQuery
      ? [
          'Query plan degraded (missing index, table scan, lock contention)',
          `Database query exceeded statement_timeout on \`${p.service}\``,
          'Upstream requests queued waiting — goroutines / workers exhausted',
        ]
      : [
          'Downstream service p99 latency exceeded caller timeout',
          'Threads / goroutines blocked on slow dependency',
          `\`${p.service}\` → cascading timeouts to callers`,
        ],
    fixHint: isQuery
      ? 'Run EXPLAIN ANALYZE on the slow query. Add indexes on WHERE / JOIN columns. Check recent schema migrations for unindexed columns.'
      : 'Add circuit breaker around the slow downstream. Increase timeout if the dependency is legitimately slow, or reduce p99 of the dependency.',
  };
}

// ── Certificate expiry ────────────────────────────────────────────────────────

export function detectCertificateExpiry(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'certificate_expiry');
  if (matches.length === 0) return null;

  const p     = matches[0];
  const score = 0.85;

  return {
    tag: 'infra_certificate_expiry',
    summary: `TLS / certificate error on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    // certbot renew is deterministic when the cert is genuinely expired — high remediation
    // confidence. Mismatch cases (wrong hostname, CA trust) require manual intervention,
    // but certificate expiry is the dominant failure mode by volume.
    remediationConfidence: 0.90,
    evidence: [
      `Service: \`${p.service}\``,
      'Error pattern: TLS handshake failure / certificate validation error',
      `Source: ${p.source} telemetry`,
    ],
    causalPath: [
      'TLS handshake rejected — certificate expired, untrusted, or hostname mismatch',
      `\`${p.service}\` cannot establish HTTPS connection to endpoint`,
      'All HTTPS requests to this endpoint failing',
    ],
    fixHint: [
      "Check expiry: `openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates`",
      "Renew via Let's Encrypt (`certbot renew`) or your CA.",
      'Verify the cert covers the target hostname (SAN list).',
    ].join(' '),
  };
}

// ── Disk pressure ─────────────────────────────────────────────────────────────

export function detectDiskPressure(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'disk_pressure');
  if (matches.length === 0) return null;

  const p     = matches[0];
  const score = 0.85;

  return {
    tag: 'infra_disk_pressure',
    summary: `Disk pressure on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    evidence: [
      `Service: \`${p.service}\``,
      'Error pattern: no space left / disk full',
      `Source: ${p.source} telemetry`,
    ],
    causalPath: [
      'Filesystem reached 100% capacity',
      'Writes blocked — log rotation, WAL, or temp files cannot be created',
      `\`${p.service}\` → I/O errors / service crash`,
    ],
    fixHint: [
      'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`.',
      'Rotate logs immediately: `journalctl --vacuum-size=500M`.',
      'Increase PV size or add log retention policy to prevent recurrence.',
    ].join(' '),
  };
}

// ── Queue backlog ─────────────────────────────────────────────────────────────

export function detectQueueBacklog(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'queue_backlog');
  if (matches.length === 0) return null;

  const p     = matches[0];
  const score = withDatadogBoost(0.65, matches);

  return {
    tag: 'infra_queue_backlog',
    summary: `Message queue backlog on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    // Scaling consumers is directionally correct but may not be the fastest path —
    // slow handler logic or a poison message may require different intervention.
    remediationConfidence: 0.60,
    evidence: [
      `Service: \`${p.service}\``,
      'Error pattern: consumer lag / queue depth / backlog',
      `Source: ${p.source} telemetry`,
    ],
    causalPath: [
      'Producer rate exceeded consumer throughput',
      'Consumer group lagging — messages accumulating in queue',
      `\`${p.service}\` → processing delay / stale data`,
    ],
    fixHint: [
      'Scale up consumers (increase replica count or partition count).',
      'Check for slow message processing — add timing metrics around handler logic.',
      'Verify no consumer is in an error loop silently dropping messages.',
    ].join(' '),
  };
}

// ── Service unavailable ───────────────────────────────────────────────────────

export function detectServiceUnavailable(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'service_unavailable');
  if (matches.length === 0) return null;

  const p     = matches[0];
  const score = withDatadogBoost(0.70, matches);

  return {
    tag: 'infra_service_unavailable',
    summary: `Service unavailable: \`${p.service}\` cannot reach upstream — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    evidence: [
      `Service: \`${p.service}\``,
      `Endpoint: \`${p.attributes.endpoint || 'unknown'}\``,
      'Error pattern: 503 / upstream connect error / no healthy upstream',
      `Source: ${p.source} telemetry`,
    ],
    causalPath: [
      'Upstream service is down or all instances are unhealthy',
      'Load balancer / ingress cannot find a healthy backend',
      `\`${p.service}\` receiving 503 on every request to the dependency`,
    ],
    fixHint: [
      'Check k8s pod status: `kubectl get pods -n <namespace>`.',
      'Look for CrashLoopBackOff or Pending pods.',
      'Review readiness probe failures and recent deploy events.',
    ].join(' '),
  };
}

// ── Generic upstream error (catch-all) ───────────────────────────────────────

export function detectUpstreamError(events: InfraEvent[]): Hypothesis | null {
  const matches = events.filter((e) => e.kind === 'upstream_error');
  if (matches.length === 0) return null;

  const p     = matches[0];
  const score = 0.40; // low — this is the fallback

  return {
    tag: 'infra_upstream_error',
    summary: `Production error on \`${p.service}\` — ${p.message}`,
    confidence: scoreToConfidence(score),
    confidenceScore: score,
    evidence: [
      `Service: \`${p.service}\``,
      `Endpoint: \`${p.attributes.endpoint || 'unknown'}\``,
      `Trace: \`${p.attributes.traceId || 'none'}\``,
    ],
    causalPath: [
      `\`${p.service}\` returned an error on \`${p.attributes.endpoint || 'unknown'}\``,
    ],
    fixHint: p.attributes.traceId
      ? `Inspect trace \`${p.attributes.traceId}\` in Datadog APM for the full call stack. Check service logs around the incident time.`
      : 'Check service logs and recent deploys. Run `get_incident_context` to fetch the full Datadog trace.',
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const ALL_INFRA_DETECTORS: InfraDetector[] = [
  detectDbConnectionPool,
  detectOomKill,
  detectRateLimitCascade,
  detectDownstreamLatency,
  detectCertificateExpiry,
  detectDiskPressure,
  detectQueueBacklog,
  detectServiceUnavailable,
  detectUpstreamError,   // catch-all — must be last
];
