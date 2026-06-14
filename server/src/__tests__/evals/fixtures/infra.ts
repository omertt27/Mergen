import type { InfraEvent } from '../../../sensor/infra-normalizer.js';
import type { InfraFixture } from '../types.js';

const NOW = 1_700_000_000_000;

function evt(
  kind: InfraEvent['kind'],
  service: string,
  message: string,
  attrs: Record<string, string | number> = {},
  source: InfraEvent['source'] = 'otlp',
): InfraEvent {
  return { kind, timestamp: NOW, service, severity: 'high', message, attributes: attrs, source };
}

export const INFRA_FIXTURES: InfraFixture[] = [

  // ── DB connection pool ──────────────────────────────────────────────────────

  {
    name: 'db-pool-exhausted-otlp',
    events: [evt('db_connection_pool_exhausted', 'api', 'remaining connection slots reserved for non-replication superuser connections', { endpoint: 'postgres:5432', traceId: 'abc123' })],
    expected: { tag: 'infra_db_connection_pool', confidenceMin: 0.79, shouldFire: true },
  },
  {
    name: 'db-pool-exhausted-datadog-boost',
    events: [evt('db_connection_pool_exhausted', 'checkout', 'Client checkout timed out after 5000ms', { endpoint: 'mysql:3306', traceId: 'xyz789' }, 'datadog')],
    expected: { tag: 'infra_db_connection_pool', confidenceMin: 0.93, shouldFire: true },
  },

  // ── OOM kill ────────────────────────────────────────────────────────────────

  {
    name: 'oom-kill-hard-exit-137',
    events: [evt('oom_kill', 'worker', 'OOM killed — exit 137', { exitCode: 137, memoryLimitMb: 512 })],
    expected: { tag: 'infra_oom_kill', confidenceMin: 0.88, shouldFire: true },
  },
  {
    name: 'oom-kill-hard-datadog-boost',
    events: [evt('oom_kill', 'api', 'OOM killed — exit 137', { exitCode: 137, memoryLimitMb: 256 }, 'datadog')],
    expected: { tag: 'infra_oom_kill', confidenceMin: 0.95, shouldFire: true },
  },
  {
    name: 'memory-pressure-soft',
    events: [evt('memory_pressure', 'api-gateway', 'RSS approaching limit — 480/512 MB', { memoryLimitMb: 512 })],
    expected: { tag: 'infra_oom_kill', confidenceMin: 0.63, shouldFire: true },
  },

  // ── Rate limit cascade ───────────────────────────────────────────────────────

  {
    name: 'rate-limit-cascade',
    events: [evt('rate_limit_cascade', 'payment-service', 'upstream returned 429 Too Many Requests', { endpoint: 'stripe.com/v1/charges' })],
    expected: { tag: 'infra_rate_limit_cascade', confidenceMin: 0.73, shouldFire: true },
  },

  // ── Slow query ───────────────────────────────────────────────────────────────

  {
    name: 'slow-query',
    events: [evt('slow_query', 'orders', 'query exceeded statement_timeout (30s): SELECT * FROM orders WHERE status = ?', { endpoint: 'postgres:5432' })],
    expected: { tag: 'infra_slow_query', confidenceMin: 0.68, shouldFire: true },
  },
  {
    name: 'downstream-latency-spike',
    events: [evt('downstream_latency_spike', 'frontend-api', 'p99 latency to auth-service exceeded 5s', { endpoint: 'auth-service:8080' })],
    expected: { tag: 'infra_downstream_latency', confidenceMin: 0.58, shouldFire: true },
  },

  // ── Certificate expiry ───────────────────────────────────────────────────────

  {
    name: 'certificate-expired',
    events: [evt('certificate_expiry', 'api', 'TLS handshake failed — certificate expired 2024-01-15', {})],
    expected: { tag: 'infra_certificate_expiry', confidenceMin: 0.84, shouldFire: true },
  },

  // ── Disk pressure ────────────────────────────────────────────────────────────

  {
    name: 'disk-full',
    events: [evt('disk_pressure', 'logging-agent', 'no space left on device', {})],
    expected: { tag: 'infra_disk_pressure', confidenceMin: 0.84, shouldFire: true },
  },

  // ── Queue backlog ────────────────────────────────────────────────────────────

  {
    name: 'queue-consumer-lag',
    events: [evt('queue_backlog', 'notification-worker', 'consumer lag: 48291 messages behind', {})],
    expected: { tag: 'infra_queue_backlog', confidenceMin: 0.63, shouldFire: true },
  },

  // ── Service unavailable ──────────────────────────────────────────────────────

  {
    name: 'service-unavailable-no-healthy-upstream',
    events: [evt('service_unavailable', 'checkout', 'upstream connect error — no healthy upstream on inventory:8080', { endpoint: 'inventory:8080' })],
    expected: { tag: 'infra_service_unavailable', confidenceMin: 0.68, shouldFire: true },
  },

  // ── Upstream error catch-all ─────────────────────────────────────────────────

  {
    name: 'upstream-error-with-trace',
    events: [evt('upstream_error', 'api', 'production error on /v2/users', { endpoint: '/v2/users', traceId: 'trace-abc123' })],
    expected: { tag: 'infra_upstream_error', confidenceMin: 0.38, shouldFire: true },
  },

  // ── Negative: empty input ────────────────────────────────────────────────────

  {
    name: 'no-events-no-hypothesis',
    events: [],
    expected: { tag: '', confidenceMin: 0, shouldFire: false },
  },

  // ── Negative: infrastructure monitoring noise — must NOT fire ────────────────
  // These events arrive constantly from k8s probes and Prometheus and are never
  // actionable incidents. The catch-all must stay silent on them.

  {
    name: 'liveness-probe-no-fire',
    events: [evt('upstream_error', 'api', 'GET /health/live 404 — liveness probe failure', { endpoint: '/health/live' })],
    expected: { tag: '', confidenceMin: 0, shouldFire: false },
  },
  {
    name: 'healthcheck-404-no-fire',
    events: [evt('upstream_error', 'api', 'GET /health 503 — health check failed', { endpoint: '/health' })],
    expected: { tag: '', confidenceMin: 0, shouldFire: false },
  },
  {
    name: 'prometheus-scrape-no-fire',
    events: [evt('upstream_error', 'api', 'GET /metrics 500 — Prometheus scrape failed', { endpoint: '/metrics' })],
    expected: { tag: '', confidenceMin: 0, shouldFire: false },
  },
  {
    name: 'readiness-probe-no-fire',
    events: [evt('upstream_error', 'api', 'GET /ready 503 — readiness check timeout', { endpoint: '/ready' })],
    expected: { tag: '', confidenceMin: 0, shouldFire: false },
  },

  // ── Multi-signal: more specific detector beats catch-all ─────────────────────

  {
    name: 'db-pool-wins-over-upstream-catch-all',
    events: [
      evt('db_connection_pool_exhausted', 'api', 'pool exhausted — max_connections reached'),
      evt('upstream_error', 'api', 'error on /api/data'),
    ],
    expected: { tag: 'infra_db_connection_pool', confidenceMin: 0.79, shouldFire: true },
  },

  // ── OOM beats upstream catch-all ────────────────────────────────────────────

  {
    name: 'oom-wins-over-upstream-catch-all',
    events: [
      evt('oom_kill', 'worker', 'OOM killed', { exitCode: 137 }),
      evt('upstream_error', 'worker', 'error on /health'),
    ],
    expected: { tag: 'infra_oom_kill', confidenceMin: 0.88, shouldFire: true },
  },
];