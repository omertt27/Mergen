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
//
// Each pattern is intentionally broad — it must catch the same failure mode
// expressed across Node.js, Python, Java, Go, Ruby, and Rust. Comments show
// the representative error from each runtime.

const DB_POOL_RE = new RegExp([
  // Generic
  'connection pool', 'pool exhausted', 'pool timeout', 'connection limit',
  'too many connections', 'max_connections', 'max connections',
  // Node.js (pg, mysql2, knex, sequelize)
  'ECONNREFUSED', 'ETIMEDOUT', 'Client checkout timed out',
  'Connection terminated unexpectedly', 'remaining connection slots',
  // Python (psycopg2, SQLAlchemy, asyncpg, Django ORM)
  'OperationalError.*connection', 'QueuePool limit', 'TimeoutError.*pool',
  'could not connect to server', 'connection pool exhausted',
  'psycopg2\\.OperationalError', 'sqlalchemy\\.exc\\.TimeoutError',
  // Java (HikariCP, c3p0, DBCP, Spring)
  'HikariPool.*Connection is not available', 'Connection pool exhausted',
  'Unable to acquire JDBC Connection', 'Timeout waiting for connection from pool',
  'java\\.sql\\.SQLTimeoutException', 'Connection pool size.*exceeded',
  // Go (database/sql, pgx, gorm)
  'pq: connection refused', 'pq: sorry, too many clients',
  'context deadline exceeded.*sql', 'sql: no rows in result set',
  'pgx: connection pool exhausted',
  // Ruby (ActiveRecord, PG gem)
  'ActiveRecord::StatementInvalid.*connection', 'PG::ConnectionBad',
  'PG::TooManyConnections', 'could not obtain a database connection',
  // Rust (sqlx, diesel)
  'PoolTimedOut', 'connection error: Connection refused',
].join('|'), 'i');

const OOM_RE = new RegExp([
  // Generic / kernel
  'out of memory', 'OOMKilled', 'memory limit exceeded', 'cannot allocate',
  'allocation failed', 'oom_score',
  // Node.js
  'heap out of memory', 'JavaScript heap out of memory',
  'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed',
  // Python
  'MemoryError', 'Cannot allocate memory', 'numpy.*MemoryError',
  // Java
  'java\\.lang\\.OutOfMemoryError', 'GC overhead limit exceeded',
  'Java heap space', 'PermGen space', 'Metaspace',
  // Go
  'runtime: out of memory', 'runtime: cannot allocate memory',
  // Ruby
  'NoMemoryError', 'failed to allocate memory',
  // Container / Kubernetes
  'OOM killer', 'memory cgroup out of memory', 'Killed process.*memory',
].join('|'), 'i');

const RATE_LIMIT_RE = new RegExp([
  'rate limit', 'rate-limit', 'RateLimit', 'too many requests',
  'HTTP 429', 'status 429', 'quota exceeded', 'quota limit', 'throttled',
  'throttling', 'backpressure', 'retry-after', 'Retry-After',
  // Cloud provider specifics
  'RequestLimitExceeded', 'SlowDown', 'ThrottlingException',
  'RESOURCE_EXHAUSTED', 'API rate limit',
  // Service mesh / proxy
  'x-envoy-ratelimited', 'upstream request timeout',
].join('|'), 'i');

const CERT_RE = new RegExp([
  'certificate', 'Certificate', 'CERT_HAS_EXPIRED', 'certificate verify failed',
  'ssl error', 'SSL error', 'tls', 'TLS', 'x509',
  'handshake failed', 'CERTIFICATE_VERIFY_FAILED',
  // Node.js
  'CERT_UNTRUSTED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS',
  'certificate has expired',
  // Python
  'ssl\\.SSLError', 'ssl\\.CertificateError', 'CERTIFICATE_VERIFY_FAILED',
  // Java
  'javax\\.net\\.ssl\\.SSLHandshakeException', 'sun\\.security\\.validator\\.ValidatorException',
  'PKIX path building failed',
  // Go
  'tls: certificate has expired', 'x509: certificate signed by unknown authority',
  'x509: certificate has expired',
  // Ruby
  'OpenSSL::SSL::SSLError', 'certificate verify failed',
].join('|'), 'i');

const SLOW_QUERY_RE = new RegExp([
  'slow query', 'query timeout', 'statement timeout', 'lock timeout',
  'deadlock', 'lock wait', 'canceling statement due to',
  // PostgreSQL
  'ERROR.*statement timeout', 'ERROR.*lock timeout', 'ERROR.*deadlock detected',
  // MySQL
  'Lock wait timeout exceeded', 'Deadlock found when trying to get lock',
  // MongoDB
  'operation exceeded time limit', 'cursor id.*not found',
  // Redis
  'SLOWLOG', 'ERR max number of clients reached',
  // Elasticsearch
  'search_phase_execution_exception.*timeout', 'circuit_breaking_exception',
  // Java
  'java\\.sql\\.SQLTimeoutException', 'QueryTimeoutException',
  // Python
  'QueryTimeout', 'StatementTimeout', 'OperationalError.*timeout',
].join('|'), 'i');

const DISK_RE = new RegExp([
  'no space left', 'disk full', 'disk pressure', 'ENOSPC',
  'write failed', 'No space left on device', 'i/o error', 'I/O error',
  // Kubernetes
  'eviction.*disk', 'DiskPressure', 'ephemeral-storage',
  // Python
  'OSError.*No space left', 'IOError.*No space left',
  // Java
  'java\\.io\\.IOException.*No space left', 'DiskSpaceHealthIndicator',
  // Go
  'no space left on device', 'write.*no space',
].join('|'), 'i');

const QUEUE_RE = new RegExp([
  'queue full', 'queue depth', 'consumer lag', 'backlog', 'offset lag',
  // Kafka
  'TOPIC_AUTHORIZATION_FAILED', 'consumer group lag', 'OffsetOutOfRange',
  'RecordTooLargeException', 'producer queue is full',
  // RabbitMQ
  'channel error.*RESOURCE_LOCKED', 'queue.*full', 'basic\\.nack',
  // SQS / SNS
  'QueueDoesNotExist', 'message retention', 'ApproximateNumberOfMessages',
  // Redis Streams
  'XADD.*MAXLEN', 'stream.*full',
  // Celery / Sidekiq / Resque
  'Queue length.*exceeded', 'Worker.*timeout',
].join('|'), 'i');

const SVC_UNAVAIL_RE = new RegExp([
  'service unavailable', '503', 'upstream connect error',
  'no healthy upstream', 'ECONNRESET', 'connection reset',
  // Kubernetes / Envoy
  'upstream request timeout', 'no endpoints available', 'ServiceUnavailable',
  'circuit.*open', 'circuit breaker',
  // AWS
  'Service Unavailable', 'ServiceUnavailable', 'RequestExpired',
  // HTTP clients
  'ENOTFOUND', 'getaddrinfo.*ENOTFOUND', 'connect ETIMEDOUT',
].join('|'), 'i');

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

// ── Normalizer: OTLP span attributes (semantic conventions) ──────────────────
//
// OpenTelemetry semantic conventions give us structured, language-agnostic
// signals. Matching on span attributes is strictly higher-fidelity than
// parsing log text — the attribute value is already classified by the SDK.
//
// References:
//   https://opentelemetry.io/docs/specs/semconv/database/
//   https://opentelemetry.io/docs/specs/semconv/http/
//   https://opentelemetry.io/docs/specs/semconv/messaging/

export interface OtlpSpanAttributes {
  /** The service that produced the span (resource.service.name). */
  service?: string;
  /** OTel db.system: postgresql, mysql, mongodb, redis, elasticsearch, etc. */
  'db.system'?: string;
  /** OTel db.operation: SELECT, INSERT, etc. */
  'db.operation'?: string;
  /** OTel db.connection_string or db.name */
  'db.name'?: string;
  /** OTel http.status_code or http.response.status_code */
  'http.status_code'?: number | string;
  'http.response.status_code'?: number | string;
  /** OTel http.url or url.full */
  'http.url'?: string;
  'url.full'?: string;
  /** OTel messaging.system: kafka, rabbitmq, aws_sqs, etc. */
  'messaging.system'?: string;
  /** OTel error.type or exception.type */
  'error.type'?: string;
  'exception.type'?: string;
  'exception.message'?: string;
  /** OTel rpc.grpc.status_code: 0=OK, 8=RESOURCE_EXHAUSTED, 14=UNAVAILABLE */
  'rpc.grpc.status_code'?: number | string;
  /** k8s.pod.name, k8s.namespace.name */
  'k8s.pod.name'?: string;
  'k8s.namespace.name'?: string;
  /** span.kind: server, client, producer, consumer */
  'span.kind'?: string;
  /** error=true when span records an error */
  error?: boolean | string;
  /** duration in milliseconds — for latency detection */
  'duration_ms'?: number;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Normalize a single OTLP span's attributes into zero or more InfraEvents.
 * Only spans with error=true (or equivalent) produce events.
 *
 * This is the high-fidelity path: matched on structured semantic conventions,
 * not regex on log text. Confidence is boosted relative to markdown parsing.
 */
export function normalizeOtlpSpan(
  attrs: OtlpSpanAttributes,
  timestamp = Date.now(),
): InfraEvent[] {
  const service = attrs.service ?? attrs['k8s.pod.name'] ?? 'unknown';
  const isError = attrs.error === true || attrs.error === 'true'
    || String(attrs['rpc.grpc.status_code'] ?? '') === '14' // UNAVAILABLE
    || String(attrs['rpc.grpc.status_code'] ?? '') === '8'; // RESOURCE_EXHAUSTED

  if (!isError) return [];

  const events: InfraEvent[] = [];
  const dbSystem  = attrs['db.system'];
  const httpCode  = Number(attrs['http.status_code'] ?? attrs['http.response.status_code'] ?? 0);
  const grpcCode  = Number(attrs['rpc.grpc.status_code'] ?? -1);
  const msgSystem = attrs['messaging.system'];
  const exType    = attrs['exception.type'] ?? attrs['error.type'] ?? '';
  const exMsg     = attrs['exception.message'] ?? '';

  const baseAttrs: Record<string, string | number> = {
    service,
    ...(attrs['http.url'] ?? attrs['url.full'] ? { endpoint: String(attrs['http.url'] ?? attrs['url.full'] ?? '') } : {}),
    ...(dbSystem ? { dbSystem } : {}),
    ...(exType ? { exceptionType: exType } : {}),
  };

  // ── Database errors ───────────────────────────────────────────────────────
  if (dbSystem) {
    const combinedText = `${exType} ${exMsg}`;
    if (DB_POOL_RE.test(combinedText) || SLOW_QUERY_RE.test(combinedText)) {
      const isPool  = DB_POOL_RE.test(combinedText);
      const isSlow  = SLOW_QUERY_RE.test(combinedText);
      events.push({
        kind: isPool ? 'db_connection_pool_exhausted' : 'slow_query',
        timestamp, service, severity: 'critical',
        message: exMsg || `${dbSystem} error: ${exType}`,
        attributes: { ...baseAttrs, dbSystem },
        source: 'otlp',
      });
      if (isSlow && !isPool) {
        // Already pushed slow_query above
      }
    } else {
      // Generic DB error — still useful for the upstream_error fallback path
      events.push({
        kind: 'upstream_error',
        timestamp, service, severity: 'high',
        message: exMsg || `${dbSystem} error`,
        attributes: { ...baseAttrs, dbSystem },
        source: 'otlp',
      });
    }
  }

  // ── HTTP 429 / rate limiting ──────────────────────────────────────────────
  if (httpCode === 429 || grpcCode === 8 /* RESOURCE_EXHAUSTED */) {
    events.push({
      kind: 'rate_limit_cascade',
      timestamp, service, severity: 'high',
      message: `HTTP ${httpCode || 'gRPC RESOURCE_EXHAUSTED'} from upstream`,
      attributes: baseAttrs,
      source: 'otlp',
    });
  }

  // ── HTTP 503 / service unavailable ────────────────────────────────────────
  if (httpCode === 503 || httpCode === 502 || grpcCode === 14 /* UNAVAILABLE */) {
    events.push({
      kind: 'service_unavailable',
      timestamp, service, severity: 'critical',
      message: `HTTP ${httpCode || 'gRPC UNAVAILABLE'} — upstream service not responding`,
      attributes: baseAttrs,
      source: 'otlp',
    });
  }

  // ── TLS / certificate errors ──────────────────────────────────────────────
  if (CERT_RE.test(exType) || CERT_RE.test(exMsg)) {
    events.push({
      kind: 'certificate_expiry',
      timestamp, service, severity: 'critical',
      message: exMsg || exType,
      attributes: baseAttrs,
      source: 'otlp',
    });
  }

  // ── OOM (exception type match) ────────────────────────────────────────────
  if (OOM_RE.test(exType) || OOM_RE.test(exMsg)) {
    events.push({
      kind: 'memory_pressure',
      timestamp, service, severity: 'critical',
      message: exMsg || exType,
      attributes: baseAttrs,
      source: 'otlp',
    });
  }

  // ── Messaging system errors ───────────────────────────────────────────────
  if (msgSystem && (QUEUE_RE.test(exMsg) || QUEUE_RE.test(exType))) {
    events.push({
      kind: 'queue_backlog',
      timestamp, service, severity: 'high',
      message: exMsg || `${msgSystem} error: ${exType}`,
      attributes: { ...baseAttrs, messagingSystem: msgSystem },
      source: 'otlp',
    });
  }

  // ── High-latency span (no error type, just duration) ─────────────────────
  if (events.length === 0 && typeof attrs['duration_ms'] === 'number' && attrs['duration_ms'] > 5000) {
    events.push({
      kind: 'downstream_latency_spike',
      timestamp, service, severity: 'high',
      message: `Span duration ${attrs['duration_ms']}ms exceeds 5s threshold`,
      attributes: { ...baseAttrs, durationMs: attrs['duration_ms'] },
      source: 'otlp',
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
