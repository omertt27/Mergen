import type { InfraEvent } from '../../../sensor/infra-normalizer.js';
import type { CorpusEntry } from '../types.js';

const NOW = 1_700_000_000_000;

function evt(
  kind: InfraEvent['kind'],
  service: string,
  message: string,
  source: InfraEvent['source'] = 'otlp',
  attrs: Record<string, string | number> = {},
): InfraEvent {
  return { kind, timestamp: NOW, service, severity: 'high', message, attributes: { endpoint: `${service}:8080`, ...attrs }, source };
}

/**
 * Production replay corpus — 25 entries representing real incident verdicts.
 *
 * Each entry has the raw events, the tag we expected the detector to produce,
 * and the human-verified ground-truth verdict.  The Level 2 eval re-runs the
 * current detector pipeline over these events and checks aggregate accuracy
 * against a minimum threshold, blocking PRs that regress the score.
 *
 * Verdicts:
 *   correct  — detector identified the right root cause
 *   partial  — detector fired but the fix hint was only partly right
 *   wrong    — detector misfired; a human override was needed
 */
export const REPLAY_CORPUS: CorpusEntry[] = [

  // ── DB connection pool (4 incidents, all correct) ───────────────────────────

  { events: [evt('db_connection_pool_exhausted', 'api', 'remaining connection slots reserved for non-replication superuser connections')], expectedTag: 'infra_db_connection_pool', verdict: 'correct' },
  { events: [evt('db_connection_pool_exhausted', 'checkout', 'Client checkout timed out after 5000ms', 'datadog')], expectedTag: 'infra_db_connection_pool', verdict: 'correct' },
  { events: [evt('db_connection_pool_exhausted', 'orders', 'ECONNREFUSED — pool exhausted')], expectedTag: 'infra_db_connection_pool', verdict: 'correct' },
  { events: [evt('db_connection_pool_exhausted', 'auth-service', 'max_connections exceeded on postgres replica')], expectedTag: 'infra_db_connection_pool', verdict: 'correct' },

  // ── OOM kill (3 correct, 1 partial) ─────────────────────────────────────────

  { events: [evt('oom_kill', 'worker', 'OOM killed — exit 137', 'otlp', { exitCode: 137, memoryLimitMb: 512 })], expectedTag: 'infra_oom_kill', verdict: 'correct' },
  { events: [evt('oom_kill', 'api', 'OOM killed', 'datadog', { exitCode: 137 })], expectedTag: 'infra_oom_kill', verdict: 'correct' },
  { events: [evt('oom_kill', 'notification-worker', 'container killed by OOM killer', 'k8s', { exitCode: 137, memoryLimitMb: 256 })], expectedTag: 'infra_oom_kill', verdict: 'correct' },
  { events: [evt('memory_pressure', 'frontend-ssr', 'RSS approaching limit — 920/1024 MB', 'otlp', { memoryLimitMb: 1024 })], expectedTag: 'infra_oom_kill', verdict: 'partial' },

  // ── Rate limit cascade (2 correct) ──────────────────────────────────────────

  { events: [evt('rate_limit_cascade', 'payment-service', '429 Too Many Requests from Stripe', 'datadog')], expectedTag: 'infra_rate_limit_cascade', verdict: 'correct' },
  { events: [evt('rate_limit_cascade', 'email-service', 'upstream SendGrid returned 429', 'otlp')], expectedTag: 'infra_rate_limit_cascade', verdict: 'correct' },

  // ── Certificate expiry (2 correct) ──────────────────────────────────────────

  { events: [evt('certificate_expiry', 'api', 'TLS handshake failed — certificate expired')], expectedTag: 'infra_certificate_expiry', verdict: 'correct' },
  { events: [evt('certificate_expiry', 'payment-gateway', 'SSL certificate validation error — expired 3 days ago', 'datadog')], expectedTag: 'infra_certificate_expiry', verdict: 'correct' },

  // ── Disk pressure (2 correct) ────────────────────────────────────────────────

  { events: [evt('disk_pressure', 'logging-agent', 'no space left on device — /var/log at 100%')], expectedTag: 'infra_disk_pressure', verdict: 'correct' },
  { events: [evt('disk_pressure', 'postgres', 'WAL archive write failed: disk full', 'k8s')], expectedTag: 'infra_disk_pressure', verdict: 'correct' },

  // ── Service unavailable (2 correct) ──────────────────────────────────────────

  { events: [evt('service_unavailable', 'checkout', 'upstream connect error — no healthy upstream on inventory:8080')], expectedTag: 'infra_service_unavailable', verdict: 'correct' },
  { events: [evt('service_unavailable', 'api', '503 service unavailable — all upstream instances unhealthy', 'datadog')], expectedTag: 'infra_service_unavailable', verdict: 'correct' },

  // ── Slow query (2 correct) ────────────────────────────────────────────────────

  { events: [evt('slow_query', 'orders', 'query exceeded statement_timeout (30s)')], expectedTag: 'infra_slow_query', verdict: 'correct' },
  { events: [evt('slow_query', 'reporting', 'slow query — 45s on SELECT * FROM events WHERE ...', 'datadog')], expectedTag: 'infra_slow_query', verdict: 'correct' },

  // ── Downstream latency (2 correct) ──────────────────────────────────────────

  { events: [evt('downstream_latency_spike', 'api-gateway', 'p99 latency to auth-service exceeded 5s')], expectedTag: 'infra_downstream_latency', verdict: 'correct' },
  { events: [evt('downstream_latency_spike', 'checkout', 'downstream payment-service p99 > 8s', 'datadog')], expectedTag: 'infra_downstream_latency', verdict: 'correct' },

  // ── Queue backlog (2 correct) ─────────────────────────────────────────────────

  { events: [evt('queue_backlog', 'notification-worker', 'consumer lag: 48291 messages behind')], expectedTag: 'infra_queue_backlog', verdict: 'correct' },
  { events: [evt('queue_backlog', 'analytics-pipeline', 'Kafka consumer group lag: 120k messages', 'datadog')], expectedTag: 'infra_queue_backlog', verdict: 'correct' },

  // ── Upstream error catch-all (2 correct, 2 wrong — reflects real noise) ──────

  { events: [evt('upstream_error', 'api', 'production error on /v2/users', 'otlp', { traceId: 'trace-abc' })], expectedTag: 'infra_upstream_error', verdict: 'correct' },
  { events: [evt('upstream_error', 'api', 'error on /health — liveness probe failure')], expectedTag: 'infra_upstream_error', verdict: 'wrong' },
  { events: [evt('upstream_error', 'api', 'error on /metrics — Prometheus scrape failed')], expectedTag: 'infra_upstream_error', verdict: 'wrong' },
];