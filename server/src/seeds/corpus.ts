/**
 * seeds/corpus.ts — 50-incident seed corpus from public postmortems.
 *
 * Each snapshot covers one real failure mode across the infra detector suite.
 * Sources: GitHub, Cloudflare, Stripe, PagerDuty, and AWS status page postmortems
 * (2022-2024). All service names, IPs, and account IDs are anonymised.
 *
 * Call loadSeedCorpus() once at demo startup. It is a no-op if seeds are
 * already present so it never overwrites real incidents.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import type { ReplaySnapshot } from '../intelligence/incident-replay.js';
import logger from '../sensor/logger.js';

const REPLAY_DIR = path.join(DATA_DIR, 'replay-snapshots');
// One incident every 3 hours starting 2024-01-01T00:00:00Z
const T0 = 1704067200000;
const GAP = 3 * 60 * 60 * 1000;
const t = (i: number) => T0 + i * GAP;
const cap = (i: number) => t(i) + 35_000;

// ── InfraEvent builder ────────────────────────────────────────────────────────

type IE = ReplaySnapshot['infraEvents'][number];

function ie(
  kind: IE['kind'],
  service: string,
  severity: IE['severity'],
  message: string,
  attrs: IE['attributes'] = {},
): IE {
  return { kind, timestamp: 0, service, severity, message, attributes: attrs, source: 'otlp' };
}

// ── ConsoleEvent builder ──────────────────────────────────────────────────────

type CE = ReplaySnapshot['logs'][number];

function ce(level: CE['level'], msg: string, url: string, ts: number): CE {
  return { type: 'console', level, args: [msg], url, timestamp: ts };
}

// ── NetworkEvent builder ──────────────────────────────────────────────────────

type NE = ReplaySnapshot['network'][number];

function ne(method: string, url: string, status: number, duration: number, ts: number, err?: string): NE {
  return {
    type: 'network', method, url, status,
    statusText: status >= 500 ? 'Internal Server Error' : status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : 'OK',
    duration, timestamp: ts, ...(err ? { error: err } : {}),
  };
}

// ── 50 Incidents ──────────────────────────────────────────────────────────────

const SNAPSHOTS: ReplaySnapshot[] = [

  // ── 001–005  infra_db_connection_pool ─────────────────────────────────────

  {
    pid: 'seed-001', capturedAt: cap(0), firedAt: t(0),
    logs: [
      ce('error', '[api] database connection pool exhausted — 0/20 connections available after 30000ms', 'http://api:8080/api/users', t(0) - 28000),
      ce('error', '[api] Error: connect ETIMEDOUT 10.12.0.5:5432\n    at Pool.acquire (/app/node_modules/pg-pool/index.js:192:15)', 'http://api:8080/api/users', t(0) - 27800),
      ce('warn',  '[api] pg-pool attempting emergency drain and reconnect — attempt 1/3', 'http://api:8080', t(0) - 15000),
    ],
    network: [
      ne('GET', 'http://api:8080/api/users',   503, 30421, t(0) - 27500, 'upstream connect error or disconnect/reset before headers'),
      ne('GET', 'http://api:8080/api/orders',  503, 30389, t(0) - 27200, 'upstream connect error'),
      ne('GET', 'http://api:8080/api/checkout',503, 142,   t(0) - 20000, 'circuit breaker open'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('db_connection_pool_exhausted', 'api-service', 'critical', 'pg-pool exhausted — 0/20 connections available after 30s timeout. DB host: 10.12.0.5:5432'), timestamp: t(0) - 28000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', traceId: 'a1b2c3d4e5f60001a1b2c3d4e5f60001', poolMax: 20, poolUsed: 20 } },
    ],
    originalTag: 'infra_db_connection_pool',
    originalConfidenceScore: 0.80,
    originalFixHint: 'Increase pool size: set `DB_POOL_MAX` (or `pool.max` in your ORM config). Check for connection leaks — unclosed transactions hold pool slots indefinitely. Add a connection pool metrics query to validate utilisation.',
  },

  {
    pid: 'seed-002', capturedAt: cap(1), firedAt: t(1),
    logs: [
      ce('error', '[payments] mysql2: too many connections (max_connections=151 reached)', 'http://payments:8082/charge', t(1) - 22000),
      ce('error', '[payments] SequelizeConnectionAcquireTimeoutError: timeout of 30000ms exceeded while acquiring a connection', 'http://payments:8082/charge', t(1) - 21800),
    ],
    network: [
      ne('POST', 'http://payments:8082/charge', 503, 30012, t(1) - 21600, 'connection acquire timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('db_connection_pool_exhausted', 'payments-service', 'critical', 'MySQL max_connections=151 reached — Sequelize pool cannot acquire connection'), timestamp: t(1) - 22000, attributes: { endpoint: 'mysql://10.12.0.8:3306/payments', maxConnections: 151 } },
    ],
    originalTag: 'infra_db_connection_pool',
    originalConfidenceScore: 0.80,
    originalFixHint: 'Increase pool size: set `DB_POOL_MAX` (or `pool.max` in your ORM config). Check for connection leaks — unclosed transactions hold pool slots indefinitely. Add a connection pool metrics query to validate utilisation.',
  },

  {
    pid: 'seed-003', capturedAt: cap(2), firedAt: t(2),
    logs: [
      ce('error', '[cache] ioredis: max retries per request limit exceeded — Redis connection pool saturated', 'http://cache:8083/get', t(2) - 18000),
      ce('error', '[cache] ReplyError: ERR max number of clients reached', 'http://cache:8083/get', t(2) - 17500),
    ],
    network: [
      ne('GET', 'http://cache:8083/api/session', 503, 18200, t(2) - 17000, 'Redis pool saturated'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('db_connection_pool_exhausted', 'cache-service', 'high', 'Redis: max number of clients reached — ioredis connection pool exhausted'), timestamp: t(2) - 18000, attributes: { endpoint: 'redis://10.12.0.10:6379', maxClients: 10000 } },
    ],
    originalTag: 'infra_db_connection_pool',
    originalConfidenceScore: 0.80,
    originalFixHint: 'Increase pool size: set `DB_POOL_MAX` (or `pool.max` in your ORM config). Check for connection leaks — unclosed transactions hold pool slots indefinitely. Add a connection pool metrics query to validate utilisation.',
  },

  {
    pid: 'seed-004', capturedAt: cap(3), firedAt: t(3),
    logs: [
      ce('error', '[api] PgBouncer: remaining connection slots are reserved for non-replication superuser connections', 'http://api:8080/api/products', t(3) - 25000),
      ce('error', '[api] FATAL: remaining connection slots are reserved (pgbouncer pool_size=30, server_pool_size=35)', 'http://api:8080/api/products', t(3) - 24500),
      ce('warn',  '[api] retrying DB connection in 5s (attempt 2/5)', 'http://api:8080', t(3) - 20000),
    ],
    network: [
      ne('GET', 'http://api:8080/api/products', 503, 25100, t(3) - 24200, 'upstream timeout'),
      ne('GET', 'http://api:8080/api/cart',     503, 25050, t(3) - 23800, 'upstream timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('db_connection_pool_exhausted', 'api-service', 'critical', 'PgBouncer pool_size=30 exhausted — server_pool_size=35 slots reserved for superuser'), timestamp: t(3) - 25000, attributes: { endpoint: 'postgres://pgbouncer:6432/app', pgbouncerPoolSize: 30 } },
    ],
    originalTag: 'infra_db_connection_pool',
    originalConfidenceScore: 0.80,
    originalFixHint: 'Increase pool size: set `DB_POOL_MAX` (or `pool.max` in your ORM config). Check for connection leaks — unclosed transactions hold pool slots indefinitely. Add a connection pool metrics query to validate utilisation.',
  },

  {
    pid: 'seed-005', capturedAt: cap(4), firedAt: t(4),
    logs: [
      ce('error', '[django-api] django.db.utils.OperationalError: FATAL: remaining connection slots are reserved for non-replication superuser connections', 'http://django-api:8000/api/v1/users', t(4) - 20000),
      ce('error', '[django-api] sqlalchemy.exc.TimeoutError: QueuePool limit of size 10 overflow 20 reached, connection timed out, timeout 30', 'http://django-api:8000/api/v1/orders', t(4) - 19500),
    ],
    network: [
      ne('GET', 'http://django-api:8000/api/v1/users',  503, 30000, t(4) - 19000, 'database connection timeout'),
      ne('POST', 'http://django-api:8000/api/v1/orders', 503, 30000, t(4) - 18500, 'database connection timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('db_connection_pool_exhausted', 'django-api', 'critical', 'SQLAlchemy QueuePool limit size=10 overflow=20 reached — connection timed out after 30s'), timestamp: t(4) - 20000, attributes: { endpoint: 'postgres://10.12.0.5:5432/django_prod', queuePoolSize: 10, overflow: 20 } },
    ],
    originalTag: 'infra_db_connection_pool',
    originalConfidenceScore: 0.80,
    originalFixHint: 'Increase pool size: set `DB_POOL_MAX` (or `pool.max` in your ORM config). Check for connection leaks — unclosed transactions hold pool slots indefinitely. Add a connection pool metrics query to validate utilisation.',
  },

  // ── 006–010  infra_oom_kill ───────────────────────────────────────────────

  {
    pid: 'seed-006', capturedAt: cap(5), firedAt: t(5),
    logs: [
      ce('error', '[worker] FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'http://worker:8084', t(5) - 12000),
      ce('error', '[k8s] OOMKilled: container worker-service exceeded memory limit 512Mi (exit code 137)', 'http://worker:8084', t(5) - 11500),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [
      { type: 'process_exit', process: 'worker-service', exitCode: 137, reason: 'oom', signal: 'SIGKILL', memoryLimitBytes: 536870912, timestamp: t(5) - 11500 },
    ], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('oom_kill', 'worker-service', 'critical', 'OOMKilled: container exceeded memory limit 512Mi — Node.js heap exhausted'), timestamp: t(5) - 12000, attributes: { exitCode: 137, memoryLimitMb: 512, process: 'worker-service' } },
    ],
    originalTag: 'infra_oom_kill',
    originalConfidenceScore: 0.90,
    originalFixHint: 'Increase container memory limit in k8s manifest / docker-compose. Heap-profile with `node --inspect` or `py-spy top` to find the leak. Check for unbounded caches or retained buffers in recent deploys.',
  },

  {
    pid: 'seed-007', capturedAt: cap(6), firedAt: t(6),
    logs: [
      ce('error', '[ml-service] MemoryError: Unable to allocate 2.50 GiB for an array with shape (336000000,) and data type float64', 'http://ml-service:8085/predict', t(6) - 9000),
      ce('error', '[k8s] OOMKilled: ml-service exceeded memory limit 2Gi (RSS: 2.1Gi, limit: 2.0Gi)', 'http://ml-service:8085', t(6) - 8500),
    ],
    network: [
      ne('POST', 'http://ml-service:8085/predict', 503, 9100, t(6) - 8200, 'service killed during request'),
    ],
    contexts: [], terminal: [], processExits: [
      { type: 'process_exit', process: 'ml-service', exitCode: 137, reason: 'oom', signal: 'SIGKILL', memoryLimitBytes: 2147483648, timestamp: t(6) - 8500 },
    ], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('oom_kill', 'ml-service', 'critical', 'OOMKilled: Python ML service exceeded 2Gi limit — NumPy allocation failed'), timestamp: t(6) - 9000, attributes: { exitCode: 137, memoryLimitMb: 2048, process: 'ml-service' } },
    ],
    originalTag: 'infra_oom_kill',
    originalConfidenceScore: 0.90,
    originalFixHint: 'Increase container memory limit in k8s manifest / docker-compose. Heap-profile with `node --inspect` or `py-spy top` to find the leak. Check for unbounded caches or retained buffers in recent deploys.',
  },

  {
    pid: 'seed-008', capturedAt: cap(7), firedAt: t(7),
    logs: [
      ce('error', '[go-service] runtime: out of memory: cannot allocate 1073741824-byte block (1536 MB in use)', 'http://go-service:8086/process', t(7) - 7000),
      ce('error', '[k8s] OOMKilled: go-service container killed by OOM killer — memory limit 1.5Gi exceeded', 'http://go-service:8086', t(7) - 6500),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [
      { type: 'process_exit', process: 'go-service', exitCode: 137, reason: 'oom', signal: 'SIGKILL', memoryLimitBytes: 1610612736, timestamp: t(7) - 6500 },
    ], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('oom_kill', 'go-service', 'critical', 'Go runtime OOM: cannot allocate 1GB block — RSS 1536MB exceeded 1.5Gi limit'), timestamp: t(7) - 7000, attributes: { exitCode: 137, memoryLimitMb: 1536 } },
    ],
    originalTag: 'infra_oom_kill',
    originalConfidenceScore: 0.90,
    originalFixHint: 'Increase container memory limit in k8s manifest / docker-compose. Heap-profile with `node --inspect` or `py-spy top` to find the leak. Check for unbounded caches or retained buffers in recent deploys.',
  },

  {
    pid: 'seed-009', capturedAt: cap(8), firedAt: t(8),
    logs: [
      ce('error', '[inference] java.lang.OutOfMemoryError: Java heap space\n\tat com.company.inference.ModelLoader.loadModel(ModelLoader.java:142)', 'http://inference:8087/infer', t(8) - 15000),
      ce('error', '[k8s] OOMKilled: inference-service — Java heap 4Gi exceeded JVM -Xmx limit', 'http://inference:8087', t(8) - 14500),
    ],
    network: [
      ne('POST', 'http://inference:8087/infer', 503, 15100, t(8) - 14200, 'OOMKilled'),
    ],
    contexts: [], terminal: [], processExits: [
      { type: 'process_exit', process: 'inference-service', exitCode: 137, reason: 'oom', signal: 'SIGKILL', memoryLimitBytes: 4294967296, timestamp: t(8) - 14500 },
    ], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('oom_kill', 'inference-service', 'critical', 'Java OutOfMemoryError: heap space — JVM Xmx 4Gi limit exceeded during model load'), timestamp: t(8) - 15000, attributes: { exitCode: 137, memoryLimitMb: 4096 } },
    ],
    originalTag: 'infra_oom_kill',
    originalConfidenceScore: 0.90,
    originalFixHint: 'Increase container memory limit in k8s manifest / docker-compose. Heap-profile with `node --inspect` or `py-spy top` to find the leak. Check for unbounded caches or retained buffers in recent deploys.',
  },

  {
    pid: 'seed-010', capturedAt: cap(9), firedAt: t(9),
    logs: [
      ce('warn',  '[report-worker] RSS growing: 380MB/512MB limit — possible memory leak in CSV serializer', 'http://report-worker:8088', t(9) - 45000),
      ce('warn',  '[report-worker] RSS: 490MB/512MB — GC pressure increasing, major GC pauses > 2s', 'http://report-worker:8088', t(9) - 30000),
      ce('error', '[report-worker] RSS: 511MB/512MB — CrashLoopBackOff imminent', 'http://report-worker:8088', t(9) - 10000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('memory_pressure', 'report-worker', 'high', 'RSS 511MB/512MB — sustained memory pressure, GC pauses > 2s, CrashLoopBackOff imminent'), timestamp: t(9) - 10000, attributes: { memoryLimitMb: 512, rssUsedMb: 511 } },
    ],
    originalTag: 'infra_oom_kill',
    originalConfidenceScore: 0.65,
    originalFixHint: 'Profile heap allocation. Check for unbounded in-memory caches or event-listener leaks. Review recent deploys for large data structure growth.',
  },

  // ── 011–015  infra_rate_limit_cascade ────────────────────────────────────

  {
    pid: 'seed-011', capturedAt: cap(10), firedAt: t(10),
    logs: [
      ce('error', '[payments] Stripe API error: rate limit exceeded (429) — 100 req/s limit hit on /v1/charges endpoint', 'http://payments:8082/charge', t(10) - 18000),
      ce('error', '[payments] Unhandled StripeRateLimitError: too many requests in 1s — retry backoff required', 'http://payments:8082/charge', t(10) - 17500),
      ce('warn',  '[payments] payment queue backing up — 847 pending charges, Stripe rate limited', 'http://payments:8082', t(10) - 10000),
    ],
    network: [
      ne('POST', 'https://api.stripe.com/v1/charges', 429, 120, t(10) - 18000, 'Rate limit exceeded'),
      ne('POST', 'https://api.stripe.com/v1/charges', 429, 115, t(10) - 17000, 'Rate limit exceeded'),
      ne('POST', 'https://api.stripe.com/v1/charges', 429, 118, t(10) - 16000, 'Rate limit exceeded'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('rate_limit_cascade', 'payments-service', 'high', 'Stripe API 429: 100 req/s limit exceeded — retry storm amplifying throttling'), timestamp: t(10) - 18000, attributes: { endpoint: 'https://api.stripe.com/v1/charges', retryAfterSec: 1 } },
    ],
    originalTag: 'infra_rate_limit_cascade',
    originalConfidenceScore: 0.75,
    originalFixHint: 'Add exponential backoff with jitter to the retry loop. Honour the `Retry-After` response header. Consider a token-bucket circuit breaker to shed load before hitting the upstream limit.',
  },

  {
    pid: 'seed-012', capturedAt: cap(11), firedAt: t(11),
    logs: [
      ce('error', '[notifications] Twilio API: 429 Too Many Requests — messaging rate limit of 1 message/sec exceeded for +1555XXXXXXXX', 'http://notifications:8090/send', t(11) - 12000),
      ce('warn',  '[notifications] SMS queue depth: 2400 messages — Twilio rate-limited, throughput reduced to 1 msg/s', 'http://notifications:8090', t(11) - 8000),
    ],
    network: [
      ne('POST', 'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json', 429, 95, t(11) - 12000, 'Rate limit exceeded'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('rate_limit_cascade', 'notifications-service', 'high', 'Twilio 429: 1 msg/s rate limit exceeded — SMS queue depth 2400, throughput degraded'), timestamp: t(11) - 12000, attributes: { endpoint: 'https://api.twilio.com/Messages', queueDepth: 2400 } },
    ],
    originalTag: 'infra_rate_limit_cascade',
    originalConfidenceScore: 0.75,
    originalFixHint: 'Add exponential backoff with jitter to the retry loop. Honour the `Retry-After` response header. Consider a token-bucket circuit breaker to shed load before hitting the upstream limit.',
  },

  {
    pid: 'seed-013', capturedAt: cap(12), firedAt: t(12),
    logs: [
      ce('error', '[ci-service] GitHub API secondary rate limit exceeded: You have exceeded a secondary rate limit and have been temporarily blocked. Please retry after 60 seconds.', 'http://ci-service:8091/sync', t(12) - 20000),
      ce('warn',  '[ci-service] Backing off 60s — GitHub API rate limited (5000 req/hr primary limit also at 4987/5000)', 'http://ci-service:8091', t(12) - 15000),
    ],
    network: [
      ne('GET', 'https://api.github.com/repos/company/app/commits', 429, 200, t(12) - 20000, 'secondary rate limit exceeded'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('rate_limit_cascade', 'ci-service', 'medium', 'GitHub API secondary rate limit — 5000 req/hr primary at 4987/5000, secondary limit triggered'), timestamp: t(12) - 20000, attributes: { endpoint: 'https://api.github.com', retryAfterSec: 60 } },
    ],
    originalTag: 'infra_rate_limit_cascade',
    originalConfidenceScore: 0.75,
    originalFixHint: 'Add exponential backoff with jitter to the retry loop. Honour the `Retry-After` response header. Consider a token-bucket circuit breaker to shed load before hitting the upstream limit.',
  },

  {
    pid: 'seed-014', capturedAt: cap(13), firedAt: t(13),
    logs: [
      ce('error', '[email-service] AWS SES: 454 Throttling — Maximum sending rate exceeded. Daily sending quota: 50000, used: 50000', 'http://email-service:8092/send', t(13) - 16000),
      ce('error', '[email-service] MessageRejected: Daily message quota exceeded — SES sending suspended until 00:00 UTC', 'http://email-service:8092/send', t(13) - 15500),
      ce('warn',  '[email-service] 1247 emails queued — SES quota exhausted for today. Earliest send: midnight UTC', 'http://email-service:8092', t(13) - 10000),
    ],
    network: [
      ne('POST', 'https://email.us-east-1.amazonaws.com/', 400, 350, t(13) - 16000, 'Daily message quota exceeded'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('rate_limit_cascade', 'email-service', 'high', 'AWS SES daily quota 50000/50000 exhausted — MessageRejected until midnight UTC'), timestamp: t(13) - 16000, attributes: { endpoint: 'https://email.us-east-1.amazonaws.com', dailyLimit: 50000, dailyUsed: 50000 } },
    ],
    originalTag: 'infra_rate_limit_cascade',
    originalConfidenceScore: 0.75,
    originalFixHint: 'Add exponential backoff with jitter to the retry loop. Honour the `Retry-After` response header. Consider a token-bucket circuit breaker to shed load before hitting the upstream limit.',
  },

  {
    pid: 'seed-015', capturedAt: cap(14), firedAt: t(14),
    logs: [
      ce('error', '[crm-sync] Salesforce API: REQUEST_LIMIT_EXCEEDED — Total API calls: 15000/15000 for 24-hour period', 'http://crm-sync:8093/sync', t(14) - 22000),
      ce('warn',  '[crm-sync] Salesforce daily API limit exhausted — sync paused until quota resets at 00:00 GMT', 'http://crm-sync:8093', t(14) - 18000),
    ],
    network: [
      ne('POST', 'https://company.my.salesforce.com/services/data/v57.0/sobjects/Contact', 403, 280, t(14) - 22000, 'REQUEST_LIMIT_EXCEEDED'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('rate_limit_cascade', 'crm-sync', 'high', 'Salesforce daily API calls exhausted 15000/15000 — REQUEST_LIMIT_EXCEEDED until quota reset'), timestamp: t(14) - 22000, attributes: { endpoint: 'https://company.my.salesforce.com/services/data', dailyLimit: 15000 } },
    ],
    originalTag: 'infra_rate_limit_cascade',
    originalConfidenceScore: 0.75,
    originalFixHint: 'Add exponential backoff with jitter to the retry loop. Honour the `Retry-After` response header. Consider a token-bucket circuit breaker to shed load before hitting the upstream limit.',
  },

  // ── 016–020  infra_slow_query ─────────────────────────────────────────────

  {
    pid: 'seed-016', capturedAt: cap(15), firedAt: t(15),
    logs: [
      ce('warn',  '[api] slow query detected: SELECT * FROM orders JOIN order_items ON ... WHERE user_id=$1 — 4821ms (threshold: 500ms)', 'http://api:8080/api/orders', t(15) - 15000),
      ce('error', '[api] StatementTimeout: canceling statement due to statement_timeout (5000ms) — N+1 query pattern detected on orders.order_items', 'http://api:8080/api/orders', t(15) - 14500),
    ],
    network: [
      ne('GET', 'http://api:8080/api/orders', 504, 5200, t(15) - 14200, 'query timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('slow_query', 'api-service', 'high', 'N+1 SELECT on orders.order_items — 4821ms, exceeds 500ms threshold. statement_timeout triggered.'), timestamp: t(15) - 15000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', durationMs: 4821, table: 'order_items', pattern: 'N+1' } },
    ],
    originalTag: 'infra_slow_query',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Run EXPLAIN ANALYZE on the slow query. Add indexes on WHERE / JOIN columns. Check recent schema migrations for unindexed columns.',
  },

  {
    pid: 'seed-017', capturedAt: cap(16), firedAt: t(16),
    logs: [
      ce('warn',  '[search-api] slow query: SELECT id, payload FROM user_events WHERE event_type=$1 AND created_at > $2 — 12340ms (Seq Scan, 0 index)', 'http://search-api:8094/search', t(16) - 20000),
      ce('error', '[search-api] query cancelled: statement_timeout 15000ms on user_events (rows examined: 48000000, no index on event_type)', 'http://search-api:8094/search', t(16) - 17500),
    ],
    network: [
      ne('GET', 'http://search-api:8094/search', 504, 15200, t(16) - 17000, 'gateway timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('slow_query', 'search-api', 'high', 'Full table scan on user_events (48M rows) — missing index on event_type column, 12340ms query'), timestamp: t(16) - 20000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', durationMs: 12340, table: 'user_events', rowsExamined: 48000000 } },
    ],
    originalTag: 'infra_slow_query',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Run EXPLAIN ANALYZE on the slow query. Add indexes on WHERE / JOIN columns. Check recent schema migrations for unindexed columns.',
  },

  {
    pid: 'seed-018', capturedAt: cap(17), firedAt: t(17),
    logs: [
      ce('error', '[api] Lock wait timeout exceeded — UPDATE payments SET status=$1 WHERE id=$2 waiting for lock held by txn 4821 (running 180s)', 'http://api:8080/api/payments', t(17) - 8000),
      ce('warn',  '[api] transaction 4821 blocking 14 other transactions — payments table row lock contention', 'http://api:8080', t(17) - 7000),
    ],
    network: [
      ne('PUT', 'http://api:8080/api/payments/pay_abc123', 504, 8200, t(17) - 7800, 'lock timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('slow_query', 'api-service', 'high', 'Lock wait timeout on payments table — txn 4821 holding row lock for 180s, blocking 14 transactions'), timestamp: t(17) - 8000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', durationMs: 8000, table: 'payments', blockingTxns: 14 } },
    ],
    originalTag: 'infra_slow_query',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Run EXPLAIN ANALYZE on the slow query. Add indexes on WHERE / JOIN columns. Check recent schema migrations for unindexed columns.',
  },

  {
    pid: 'seed-019', capturedAt: cap(18), firedAt: t(18),
    logs: [
      ce('warn',  '[products-api] slow query: SELECT * FROM products WHERE name LIKE $1 — 8920ms (Seq Scan 2.1M rows, no trigram index)', 'http://products-api:8095/search', t(18) - 12000),
      ce('error', '[products-api] statement_timeout: query cancelled after 10000ms — LIKE prefix scan without pg_trgm index', 'http://products-api:8095/search', t(18) - 10100),
    ],
    network: [
      ne('GET', 'http://products-api:8095/search?q=phone', 504, 10200, t(18) - 10000, 'gateway timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('slow_query', 'products-api', 'medium', 'LIKE prefix scan on products.name — 8920ms, missing pg_trgm GIN index, 2.1M row full scan'), timestamp: t(18) - 12000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', durationMs: 8920, table: 'products', rowsExamined: 2100000 } },
    ],
    originalTag: 'infra_slow_query',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Run EXPLAIN ANALYZE on the slow query. Add indexes on WHERE / JOIN columns. Check recent schema migrations for unindexed columns.',
  },

  {
    pid: 'seed-020', capturedAt: cap(19), firedAt: t(19),
    logs: [
      ce('warn',  '[api] slow query: SELECT * FROM events WHERE metadata @> $1::jsonb — 6740ms (Seq Scan, no GIN index on metadata column)', 'http://api:8080/api/events', t(19) - 10000),
      ce('error', '[api] canceling statement due to statement_timeout — jsonb @> operator on unindexed metadata column (events table: 12M rows)', 'http://api:8080/api/events', t(19) - 8100),
    ],
    network: [
      ne('GET', 'http://api:8080/api/events', 504, 8200, t(19) - 8000, 'query timeout'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('slow_query', 'api-service', 'high', 'JSONB @> containment query on unindexed events.metadata — 6740ms, Seq Scan 12M rows'), timestamp: t(19) - 10000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', durationMs: 6740, table: 'events', rowsExamined: 12000000 } },
    ],
    originalTag: 'infra_slow_query',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Run EXPLAIN ANALYZE on the slow query. Add indexes on WHERE / JOIN columns. Check recent schema migrations for unindexed columns.',
  },

  // ── 021–025  infra_certificate_expiry ────────────────────────────────────

  {
    pid: 'seed-021', capturedAt: cap(20), firedAt: t(20),
    logs: [
      ce('error', '[ingress] SSL_ERROR_RX_RECORD_TOO_LONG: TLS handshake failed for api.company.com — certificate expired 2024-01-01T00:00:00Z (3 days ago)', 'https://api.company.com', t(20) - 5000),
      ce('error', '[nginx] SSL certificate error: api.company.com: certificate has expired (notAfter=Jan  1 00:00:00 2024 GMT)', 'https://api.company.com', t(20) - 4500),
    ],
    network: [
      ne('GET', 'https://api.company.com/health', 526, 200, t(20) - 4800, 'certificate expired'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('certificate_expiry', 'api-gateway', 'critical', 'TLS certificate expired for api.company.com (notAfter: 2024-01-01 00:00:00 UTC) — Let\'s Encrypt auto-renewal failed'), timestamp: t(20) - 5000, attributes: { domain: 'api.company.com', expiredAt: '2024-01-01T00:00:00Z', daysPastExpiry: 3 } },
    ],
    originalTag: 'infra_certificate_expiry',
    originalConfidenceScore: 0.85,
    originalFixHint: "Check expiry: `openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates` Renew via Let's Encrypt (`certbot renew`) or your CA. Verify the cert covers the target hostname (SAN list).",
  },

  {
    pid: 'seed-022', capturedAt: cap(21), firedAt: t(21),
    logs: [
      ce('error', '[webhooks] CERT_HAS_EXPIRED: unable to verify the first certificate for webhooks.company.com — notAfter Jan 12 00:00:00 2024 GMT', 'https://webhooks.company.com/events', t(21) - 8000),
      ce('warn',  '[webhooks] 847 webhook deliveries failing — all HTTPS connections rejected by clients (expired TLS cert)', 'https://webhooks.company.com', t(21) - 5000),
    ],
    network: [
      ne('POST', 'https://webhooks.company.com/events', 525, 180, t(21) - 7800, 'SSL certificate has expired'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('certificate_expiry', 'webhooks-service', 'critical', 'TLS cert for webhooks.company.com expired Jan 12 2024 — 847 webhook deliveries rejected by clients'), timestamp: t(21) - 8000, attributes: { domain: 'webhooks.company.com', expiredAt: '2024-01-12T00:00:00Z' } },
    ],
    originalTag: 'infra_certificate_expiry',
    originalConfidenceScore: 0.85,
    originalFixHint: "Check expiry: `openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates` Renew via Let's Encrypt (`certbot renew`) or your CA. Verify the cert covers the target hostname (SAN list).",
  },

  {
    pid: 'seed-023', capturedAt: cap(22), firedAt: t(22),
    logs: [
      ce('error', '[auth-service] mTLS handshake failed: certificate verify failed (unable to get local issuer certificate) — peer cert signed by expired intermediate CA', 'http://auth-service:8081/validate', t(22) - 6000),
      ce('error', '[auth-service] service mesh mTLS broken — all sidecar-to-sidecar connections failing: intermediate CA cert expired', 'http://auth-service:8081', t(22) - 5500),
    ],
    network: [
      ne('POST', 'http://auth-service:8081/validate', 503, 6100, t(22) - 5700, 'mTLS certificate verification failed'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('certificate_expiry', 'auth-service', 'critical', 'Service mesh mTLS broken — intermediate CA cert expired, all sidecar connections failing'), timestamp: t(22) - 6000, attributes: { domain: 'internal-ca.company.local', certType: 'intermediate-ca' } },
    ],
    originalTag: 'infra_certificate_expiry',
    originalConfidenceScore: 0.85,
    originalFixHint: "Check expiry: `openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates` Renew via Let's Encrypt (`certbot renew`) or your CA. Verify the cert covers the target hostname (SAN list).",
  },

  {
    pid: 'seed-024', capturedAt: cap(23), firedAt: t(23),
    logs: [
      ce('error', '[integration] Error: unable to verify the first certificate — downstream partner API cert hostname mismatch: CN=old.partner.com, expected new.partner.com', 'http://integration:8096/sync', t(23) - 7000),
      ce('warn',  '[integration] 240 outbound webhook deliveries failing — partner changed their TLS cert hostname without notice', 'http://integration:8096', t(23) - 4000),
    ],
    network: [
      ne('POST', 'https://new.partner.com/webhook', 525, 190, t(23) - 6800, 'hostname mismatch in certificate'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('certificate_expiry', 'integration-service', 'high', 'TLS hostname mismatch: partner changed cert CN from old.partner.com to new.partner.com — 240 deliveries failing'), timestamp: t(23) - 7000, attributes: { domain: 'new.partner.com', certType: 'hostname-mismatch' } },
    ],
    originalTag: 'infra_certificate_expiry',
    originalConfidenceScore: 0.85,
    originalFixHint: "Check expiry: `openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates` Renew via Let's Encrypt (`certbot renew`) or your CA. Verify the cert covers the target hostname (SAN list).",
  },

  {
    pid: 'seed-025', capturedAt: cap(24), firedAt: t(24),
    logs: [
      ce('error', '[certbot] Certbot renewal failed for api.internal.company.com: Challenge failed for domain — HTTP-01 challenge response returned 404 (port 80 not reachable)', 'http://certbot-cron:8097', t(24) - 86400000),
      ce('error', '[nginx] SSL certificate will expire in 2 days — api.internal.company.com. Certbot renewal has been failing for 28 days.', 'https://api.internal.company.com', t(24) - 3600000),
      ce('error', '[nginx] SSL certificate EXPIRED: api.internal.company.com notAfter reached', 'https://api.internal.company.com', t(24) - 1000),
    ],
    network: [
      ne('GET', 'https://api.internal.company.com/health', 525, 150, t(24) - 800, 'certificate expired'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('certificate_expiry', 'internal-api', 'critical', 'Let\'s Encrypt renewal failed for 28 days — HTTP-01 challenge blocked (port 80 not reachable). Cert expired.'), timestamp: t(24) - 1000, attributes: { domain: 'api.internal.company.com', certType: 'letsencrypt', renewalFailureDays: 28 } },
    ],
    originalTag: 'infra_certificate_expiry',
    originalConfidenceScore: 0.85,
    originalFixHint: "Check expiry: `openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates` Renew via Let's Encrypt (`certbot renew`) or your CA. Verify the cert covers the target hostname (SAN list).",
  },

  // ── 026–030  infra_downstream_latency ────────────────────────────────────

  {
    pid: 'seed-026', capturedAt: cap(25), firedAt: t(25),
    logs: [
      ce('warn',  '[api] Redis latency spike: GET session:* — p99 latency 1240ms (normal: 3ms). redis-cluster node redis-2 under GC pressure.', 'http://api:8080/api/session', t(25) - 25000),
      ce('warn',  '[api] Redis connection timeout: GET user:profile:12345 took 5001ms — exceeds 5000ms client timeout', 'http://api:8080/api/user', t(25) - 20000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('downstream_latency_spike', 'api-service', 'high', 'Redis p99 latency 1240ms (normal 3ms) — cluster node under GC pressure, client timeouts cascading'), timestamp: t(25) - 25000, attributes: { endpoint: 'redis://redis-cluster:6379', p99Ms: 1240, normalP99Ms: 3 } },
    ],
    originalTag: 'infra_downstream_latency',
    originalConfidenceScore: 0.60,
    originalFixHint: 'Add circuit breaker around the slow downstream. Increase timeout if the dependency is legitimately slow, or reduce p99 of the dependency.',
  },

  {
    pid: 'seed-027', capturedAt: cap(26), firedAt: t(26),
    logs: [
      ce('warn',  '[search-api] Elasticsearch response time spike: POST /_search — p99 8400ms (normal: 200ms). Cluster health: yellow (1 shard unassigned).', 'http://search-api:8094/search', t(26) - 30000),
      ce('warn',  '[search-api] search request timeout after 10000ms — Elasticsearch cluster degraded (yellow status, 3 relocating shards)', 'http://search-api:8094/search', t(26) - 25000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('downstream_latency_spike', 'search-api', 'high', 'Elasticsearch p99 8400ms (normal 200ms) — cluster yellow: 1 unassigned shard, 3 relocating'), timestamp: t(26) - 30000, attributes: { endpoint: 'http://elasticsearch:9200/_search', p99Ms: 8400, clusterStatus: 'yellow' } },
    ],
    originalTag: 'infra_downstream_latency',
    originalConfidenceScore: 0.60,
    originalFixHint: 'Add circuit breaker around the slow downstream. Increase timeout if the dependency is legitimately slow, or reduce p99 of the dependency.',
  },

  {
    pid: 'seed-028', capturedAt: cap(27), firedAt: t(27),
    logs: [
      ce('warn',  '[asset-service] S3 GetObject latency spike: us-east-1 — p99 4800ms (normal: 120ms). AWS status page: increased error rates in us-east-1.', 'http://asset-service:8098/asset', t(27) - 35000),
      ce('warn',  '[asset-service] S3 request timeout after 5000ms — asset download failing for 23% of requests during us-east-1 partial outage', 'http://asset-service:8098/asset', t(27) - 30000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('downstream_latency_spike', 'asset-service', 'high', 'S3 GetObject p99 4800ms (normal 120ms) — us-east-1 partial degradation, 23% request timeout rate'), timestamp: t(27) - 35000, attributes: { endpoint: 'https://s3.amazonaws.com', p99Ms: 4800, region: 'us-east-1' } },
    ],
    originalTag: 'infra_downstream_latency',
    originalConfidenceScore: 0.60,
    originalFixHint: 'Add circuit breaker around the slow downstream. Increase timeout if the dependency is legitimately slow, or reduce p99 of the dependency.',
  },

  {
    pid: 'seed-029', capturedAt: cap(28), firedAt: t(28),
    logs: [
      ce('warn',  '[event-processor] Kafka consumer poll latency: 3200ms (normal: 50ms) — broker kafka-1 under disk I/O pressure, fetch.max.wait.ms exceeded', 'http://event-processor:8099', t(28) - 40000),
      ce('error', '[event-processor] KafkaConsumer: fetch timed out after 5000ms — broker not responding, consumer group lag growing: 180000 messages behind', 'http://event-processor:8099', t(28) - 35000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('downstream_latency_spike', 'event-processor', 'high', 'Kafka broker fetch latency 3200ms (normal 50ms) — disk I/O pressure on kafka-1, consumer lag 180k messages'), timestamp: t(28) - 40000, attributes: { endpoint: 'kafka-1:9092', p99Ms: 3200, consumerLag: 180000 } },
    ],
    originalTag: 'infra_downstream_latency',
    originalConfidenceScore: 0.60,
    originalFixHint: 'Add circuit breaker around the slow downstream. Increase timeout if the dependency is legitimately slow, or reduce p99 of the dependency.',
  },

  {
    pid: 'seed-030', capturedAt: cap(29), firedAt: t(29),
    logs: [
      ce('warn',  '[checkout] payment gateway p99 latency: 7200ms (normal: 800ms) — Adyen gateway experiencing elevated response times (incident #ADY-2024-01)', 'http://checkout:8100/checkout', t(29) - 50000),
      ce('warn',  '[checkout] payment processing timeout after 8000ms — Adyen gateway degraded, 41% of payment attempts timing out', 'http://checkout:8100/checkout', t(29) - 45000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('downstream_latency_spike', 'checkout-service', 'high', 'Adyen payment gateway p99 7200ms (normal 800ms) — 41% timeout rate, vendor incident active'), timestamp: t(29) - 50000, attributes: { endpoint: 'https://checkout.adyen.com', p99Ms: 7200, timeoutRate: 0.41 } },
    ],
    originalTag: 'infra_downstream_latency',
    originalConfidenceScore: 0.60,
    originalFixHint: 'Add circuit breaker around the slow downstream. Increase timeout if the dependency is legitimately slow, or reduce p99 of the dependency.',
  },

  // ── 031–035  infra_service_unavailable ───────────────────────────────────

  {
    pid: 'seed-031', capturedAt: cap(30), firedAt: t(30),
    logs: [
      ce('error', '[api] Redis connection refused — ECONNREFUSED 10.12.0.10:6379. Primary node failed, failover in progress (estimated 90s)', 'http://api:8080/api/session', t(30) - 18000),
      ce('warn',  '[api] session store unavailable — Redis Sentinel failover in progress. Returning 503 for all authenticated requests', 'http://api:8080', t(30) - 15000),
    ],
    network: [
      ne('GET', 'http://api:8080/api/user/profile', 503, 120, t(30) - 17000, 'session store unavailable'),
      ne('GET', 'http://api:8080/api/dashboard',    503, 115, t(30) - 14000, 'session store unavailable'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('service_unavailable', 'api-service', 'critical', 'Redis primary node ECONNREFUSED — Sentinel failover in progress (~90s), all session operations failing'), timestamp: t(30) - 18000, attributes: { endpoint: 'redis://10.12.0.10:6379', reason: 'redis-sentinel-failover' } },
    ],
    originalTag: 'infra_service_unavailable',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Check k8s pod status: `kubectl get pods -n <namespace>`. Look for CrashLoopBackOff or Pending pods. Review readiness probe failures and recent deploy events.',
  },

  {
    pid: 'seed-032', capturedAt: cap(31), firedAt: t(31),
    logs: [
      ce('error', '[search-api] Elasticsearch cluster status RED — shard [search_index-0][0] unassigned, no copies available. All search requests failing.', 'http://search-api:8094/search', t(31) - 25000),
      ce('error', '[search-api] ClusterBlockException: index [search_index] blocked by cluster block FORBIDDEN/8/index write — disk usage 95.2%, watermark exceeded', 'http://search-api:8094/search', t(31) - 22000),
    ],
    network: [
      ne('GET', 'http://search-api:8094/search', 503, 200, t(31) - 22000, 'cluster RED — no available shards'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('service_unavailable', 'search-api', 'critical', 'Elasticsearch cluster RED: shard [search_index-0][0] unassigned. Disk 95.2%, high watermark write-blocked'), timestamp: t(31) - 25000, attributes: { endpoint: 'http://elasticsearch:9200', clusterStatus: 'red', diskUsagePct: 95 } },
    ],
    originalTag: 'infra_service_unavailable',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Check k8s pod status: `kubectl get pods -n <namespace>`. Look for CrashLoopBackOff or Pending pods. Review readiness probe failures and recent deploy events.',
  },

  {
    pid: 'seed-033', capturedAt: cap(32), firedAt: t(32),
    logs: [
      ce('error', '[asset-service] S3 NoSuchBucket: The specified bucket does not exist — company-assets-prod bucket missing from us-east-1 (region migration in progress?)', 'http://asset-service:8098/upload', t(32) - 12000),
      ce('error', '[asset-service] All S3 operations returning NoSuchBucket — CDN origin pulling from non-existent bucket. 100% asset upload failure.', 'http://asset-service:8098', t(32) - 10000),
    ],
    network: [
      ne('PUT', 'https://company-assets-prod.s3.amazonaws.com/uploads/img_abc.jpg', 404, 350, t(32) - 11800, 'NoSuchBucket'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('service_unavailable', 'asset-service', 'critical', 'S3 bucket company-assets-prod missing in us-east-1 — 100% upload failure rate, possible misconfigured region migration'), timestamp: t(32) - 12000, attributes: { endpoint: 'https://s3.amazonaws.com/company-assets-prod', reason: 'NoSuchBucket' } },
    ],
    originalTag: 'infra_service_unavailable',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Check k8s pod status: `kubectl get pods -n <namespace>`. Look for CrashLoopBackOff or Pending pods. Review readiness probe failures and recent deploy events.',
  },

  {
    pid: 'seed-034', capturedAt: cap(33), firedAt: t(33),
    logs: [
      ce('error', '[event-service] RabbitMQ connection closed unexpectedly: CONNECTION_FORCED - broker forced connection closure with reason \'shutdown\'', 'http://event-service:8101/publish', t(33) - 22000),
      ce('error', '[event-service] amqplib: Channel lost — RabbitMQ broker unreachable at 10.12.0.15:5672. 1847 unacked messages.', 'http://event-service:8101', t(33) - 20000),
      ce('warn',  '[event-service] reconnection attempt 5/10 — RabbitMQ still unavailable', 'http://event-service:8101', t(33) - 10000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('service_unavailable', 'event-service', 'critical', 'RabbitMQ broker unreachable at 10.12.0.15:5672 — broker shutdown, 1847 unacked messages, reconnection failing'), timestamp: t(33) - 22000, attributes: { endpoint: 'amqp://10.12.0.15:5672', unackedMessages: 1847 } },
    ],
    originalTag: 'infra_service_unavailable',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Check k8s pod status: `kubectl get pods -n <namespace>`. Look for CrashLoopBackOff or Pending pods. Review readiness probe failures and recent deploy events.',
  },

  {
    pid: 'seed-035', capturedAt: cap(34), firedAt: t(34),
    logs: [
      ce('error', '[api-gateway] upstream connect error or disconnect/reset before headers: auth-service — 0/3 pods passing healthcheck', 'http://api-gateway:8080/api/auth', t(34) - 15000),
      ce('error', '[api-gateway] circuit breaker OPEN for auth-service: 100% failure rate in 60s window (0/3 healthy upstream pods)', 'http://api-gateway:8080', t(34) - 12000),
    ],
    network: [
      ne('POST', 'http://api-gateway:8080/api/auth/login', 503, 130, t(34) - 14000, 'circuit breaker open — no healthy upstream'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('service_unavailable', 'api-gateway', 'critical', 'auth-service 0/3 pods healthy — circuit breaker OPEN, all login requests failing, CrashLoopBackOff on auth pods'), timestamp: t(34) - 15000, attributes: { endpoint: 'http://auth-service:8081', healthyPods: 0, totalPods: 3 } },
    ],
    originalTag: 'infra_service_unavailable',
    originalConfidenceScore: 0.70,
    originalFixHint: 'Check k8s pod status: `kubectl get pods -n <namespace>`. Look for CrashLoopBackOff or Pending pods. Review readiness probe failures and recent deploy events.',
  },

  // ── 036–040  infra_disk_pressure ─────────────────────────────────────────

  {
    pid: 'seed-036', capturedAt: cap(35), firedAt: t(35),
    logs: [
      ce('error', '[api] ENOSPC: no space left on device — write to /var/log/app/access.log failed (disk 98% full)', 'http://api:8080', t(35) - 12000),
      ce('error', '[api] logger failed: write /var/log/app/error.log: no space left on device — rotating logs failed, disk full', 'http://api:8080', t(35) - 11500),
      ce('warn',  '[api] disk usage: /var/log 98% (19.6GB/20GB) — log rotation has been failing for 6 hours (logrotate misconfigured)', 'http://api:8080', t(35) - 10000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('disk_pressure', 'api-service', 'critical', '/var/log filesystem 98% full (19.6GB/20GB) — log writes failing ENOSPC, logrotate misconfigured'), timestamp: t(35) - 12000, attributes: { filesystem: '/var/log', usedPct: 98, usedGB: 19.6, totalGB: 20 } },
    ],
    originalTag: 'infra_disk_pressure',
    originalConfidenceScore: 0.85,
    originalFixHint: 'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`. Rotate logs immediately: `journalctl --vacuum-size=500M`. Increase PV size or add log retention policy to prevent recurrence.',
  },

  {
    pid: 'seed-037', capturedAt: cap(36), firedAt: t(36),
    logs: [
      ce('error', '[build-worker] ENOSPC: no space left on device — docker build failed: cannot create layer /tmp/docker-build-abc123 (disk 100% full)', 'http://build-worker:8102', t(36) - 8000),
      ce('error', '[build-worker] /tmp filesystem full (4.0GB/4.0GB) — Docker layer cache accumulation over 30 days without pruning', 'http://build-worker:8102', t(36) - 7500),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('disk_pressure', 'build-worker', 'critical', '/tmp filesystem 100% full (4.0GB/4.0GB) — Docker build layer cache accumulated without pruning for 30 days'), timestamp: t(36) - 8000, attributes: { filesystem: '/tmp', usedPct: 100, usedGB: 4.0, totalGB: 4.0 } },
    ],
    originalTag: 'infra_disk_pressure',
    originalConfidenceScore: 0.85,
    originalFixHint: 'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`. Rotate logs immediately: `journalctl --vacuum-size=500M`. Increase PV size or add log retention policy to prevent recurrence.',
  },

  {
    pid: 'seed-038', capturedAt: cap(37), firedAt: t(37),
    logs: [
      ce('error', '[postgres] PANIC: could not write to file "pg_wal/00000001000000050000000A": No space left on device', 'http://postgres:5432', t(37) - 5000),
      ce('error', '[postgres] database system is shut down — WAL write failed, /data filesystem 100% full (PostgreSQL PANIC halt)', 'http://postgres:5432', t(37) - 4500),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('disk_pressure', 'postgres', 'critical', 'PostgreSQL PANIC: WAL write failed — /data filesystem 100% full, database halted. pg_wal accumulation.'), timestamp: t(37) - 5000, attributes: { filesystem: '/data', usedPct: 100, cause: 'pg_wal_accumulation' } },
    ],
    originalTag: 'infra_disk_pressure',
    originalConfidenceScore: 0.85,
    originalFixHint: 'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`. Rotate logs immediately: `journalctl --vacuum-size=500M`. Increase PV size or add log retention policy to prevent recurrence.',
  },

  {
    pid: 'seed-039', capturedAt: cap(38), firedAt: t(38),
    logs: [
      ce('warn',  '[prometheus] TSDB disk usage: 95% (47.5GB/50GB PV) — retention policy set to 30d but actual data growth exceeds expectation', 'http://prometheus:9090', t(38) - 120000),
      ce('error', '[prometheus] storage compaction failed: no space left on device — TSDB cannot write new chunks. Metrics collection halted.', 'http://prometheus:9090', t(38) - 10000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('disk_pressure', 'prometheus', 'high', 'Prometheus TSDB 95% full (47.5GB/50GB PV) — compaction failing, metrics collection halted'), timestamp: t(38) - 10000, attributes: { filesystem: '/prometheus', usedPct: 95, usedGB: 47.5, totalGB: 50 } },
    ],
    originalTag: 'infra_disk_pressure',
    originalConfidenceScore: 0.85,
    originalFixHint: 'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`. Rotate logs immediately: `journalctl --vacuum-size=500M`. Increase PV size or add log retention policy to prevent recurrence.',
  },

  {
    pid: 'seed-040', capturedAt: cap(39), firedAt: t(39),
    logs: [
      ce('error', '[worker] ENOSPC: no space left on device — job output file /data/exports/export_20240101.csv cannot be created', 'http://worker:8084/export', t(39) - 15000),
      ce('error', '[worker] /data PersistentVolume 97% full (9.7GB/10GB) — export jobs failing. 847 failed exports in last hour.', 'http://worker:8084', t(39) - 12000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('disk_pressure', 'worker-service', 'critical', '/data PV 97% full (9.7GB/10GB) — export job file creation failing ENOSPC, 847 failed exports in last hour'), timestamp: t(39) - 15000, attributes: { filesystem: '/data', usedPct: 97, usedGB: 9.7, totalGB: 10 } },
    ],
    originalTag: 'infra_disk_pressure',
    originalConfidenceScore: 0.85,
    originalFixHint: 'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`. Rotate logs immediately: `journalctl --vacuum-size=500M`. Increase PV size or add log retention policy to prevent recurrence.',
  },

  // ── 041–045  infra_queue_backlog ─────────────────────────────────────────

  {
    pid: 'seed-041', capturedAt: cap(40), firedAt: t(40),
    logs: [
      ce('warn',  '[order-processor] SQS queue depth: 52847 messages (normal: <100) — order-processor consumers crashed after deploy a3f8c12, queue backing up', 'http://order-processor:8103', t(40) - 3600000),
      ce('error', '[order-processor] SQS ApproximateNumberOfMessages: 52847. Oldest message: 58 minutes. SLA breach imminent (60 min max latency).', 'http://order-processor:8103', t(40) - 1800000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('queue_backlog', 'order-processor', 'critical', 'SQS order-processing-prod queue depth 52847 (normal <100) — consumer crash after deploy a3f8c12, oldest message 58min'), timestamp: t(40) - 1800000, attributes: { queue: 'order-processing-prod', depth: 52847, oldestMessageAgeSec: 3480 } },
    ],
    originalTag: 'infra_queue_backlog',
    originalConfidenceScore: 0.65,
    originalFixHint: 'Scale up consumers (increase replica count or partition count). Check for slow message processing — add timing metrics around handler logic. Verify no consumer is in an error loop silently dropping messages.',
  },

  {
    pid: 'seed-042', capturedAt: cap(41), firedAt: t(41),
    logs: [
      ce('warn',  '[event-service] Kafka consumer group event-processor-prod lag: 2147483 messages — partition 0-7 all growing. Consumers alive but processing rate fallen 95%.', 'http://event-service:8099', t(41) - 7200000),
      ce('error', '[event-service] Kafka consumer lag exceeds alert threshold 500000: current lag 2147483. Message age on partition 0: 4.2 hours.', 'http://event-service:8099', t(41) - 3600000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('queue_backlog', 'event-service', 'critical', 'Kafka consumer group event-processor-prod lag 2.1M messages — 8 partitions, processing rate -95%, oldest message 4.2h'), timestamp: t(41) - 3600000, attributes: { topic: 'application-events', consumerGroup: 'event-processor-prod', lag: 2147483, oldestMessageAgeSec: 15120 } },
    ],
    originalTag: 'infra_queue_backlog',
    originalConfidenceScore: 0.65,
    originalFixHint: 'Scale up consumers (increase replica count or partition count). Check for slow message processing — add timing metrics around handler logic. Verify no consumer is in an error loop silently dropping messages.',
  },

  {
    pid: 'seed-043', capturedAt: cap(42), firedAt: t(42),
    logs: [
      ce('warn',  '[celery] task queue depth: 84240 tasks in send_email queue (normal: <500). Workers processing at 12 tasks/min (normal: 2400/min).', 'http://celery-worker:8104', t(42) - 5400000),
      ce('error', '[celery] send_email queue: ETA breach — 84240 tasks pending, 97% will miss 10-minute delivery SLA at current throughput', 'http://celery-worker:8104', t(42) - 1800000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('queue_backlog', 'celery-worker', 'high', 'Celery send_email queue 84240 tasks (normal <500) — processing rate 12/min vs normal 2400/min, SLA breach imminent'), timestamp: t(42) - 1800000, attributes: { queue: 'send_email', depth: 84240, processingRatePerMin: 12, normalRatePerMin: 2400 } },
    ],
    originalTag: 'infra_queue_backlog',
    originalConfidenceScore: 0.65,
    originalFixHint: 'Scale up consumers (increase replica count or partition count). Check for slow message processing — add timing metrics around handler logic. Verify no consumer is in an error loop silently dropping messages.',
  },

  {
    pid: 'seed-044', capturedAt: cap(43), firedAt: t(43),
    logs: [
      ce('warn',  '[payment-events] RabbitMQ dead letter queue growing: payment-events.dlq has 12847 messages (normal: 0). Consumer rejecting messages without requeue.', 'http://payment-service:8082', t(43) - 7200000),
      ce('error', '[payment-events] DLQ alarm: 12847 dead-lettered payment events — consumer throwing unhandled DeserializationException on schema change in v2.1.0 deploy', 'http://payment-service:8082', t(43) - 3600000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('queue_backlog', 'payment-service', 'high', 'RabbitMQ payment-events DLQ: 12847 messages — consumer DeserializationException from schema change in v2.1.0, messages unprocessable'), timestamp: t(43) - 3600000, attributes: { queue: 'payment-events.dlq', depth: 12847, reason: 'DeserializationException' } },
    ],
    originalTag: 'infra_queue_backlog',
    originalConfidenceScore: 0.65,
    originalFixHint: 'Scale up consumers (increase replica count or partition count). Check for slow message processing — add timing metrics around handler logic. Verify no consumer is in an error loop silently dropping messages.',
  },

  {
    pid: 'seed-045', capturedAt: cap(44), firedAt: t(44),
    logs: [
      ce('warn',  '[background-jobs] Redis queue depth: RPOPLPUSH background_jobs 47820 keys — 6 workers running but not draining', 'http://background-jobs:8105', t(44) - 2700000),
      ce('error', '[background-jobs] Redis background_jobs queue: 47820 pending jobs, oldest job 45min. Workers appear stuck — no heartbeat for 2 of 6 workers.', 'http://background-jobs:8105', t(44) - 1800000),
    ],
    network: [],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('queue_backlog', 'background-jobs', 'high', 'Redis background_jobs queue: 47820 pending jobs, oldest 45min. 2/6 workers not heartbeating — likely deadlocked'), timestamp: t(44) - 1800000, attributes: { queue: 'background_jobs', depth: 47820, stuckWorkers: 2, totalWorkers: 6 } },
    ],
    originalTag: 'infra_queue_backlog',
    originalConfidenceScore: 0.65,
    originalFixHint: 'Scale up consumers (increase replica count or partition count). Check for slow message processing — add timing metrics around handler logic. Verify no consumer is in an error loop silently dropping messages.',
  },

  // ── 046–050  Multi-signal cascade incidents ───────────────────────────────
  // These represent real incidents where multiple failure modes compound.

  {
    pid: 'seed-046', capturedAt: cap(45), firedAt: t(45),
    logs: [
      ce('error', '[api] database connection pool exhausted — 0/20 connections (pool leak suspected in long-running report query)', 'http://api:8080/api/reports', t(45) - 30000),
      ce('warn',  '[worker] memory pressure: RSS 490MB/512MB — report worker accumulating large result sets before pool exhaustion', 'http://worker:8084/report', t(45) - 25000),
      ce('error', '[api] ENOSPC writing report cache to /tmp — /tmp filesystem at 98% (report files not cleaned up)', 'http://api:8080', t(45) - 20000),
    ],
    network: [
      ne('GET', 'http://api:8080/api/reports', 503, 30100, t(45) - 29500, 'connection pool exhausted'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('db_connection_pool_exhausted', 'api-service', 'critical', 'pg-pool exhausted 0/20 — long-running report query holding connections'), timestamp: t(45) - 30000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', poolMax: 20 } },
      { ...ie('memory_pressure', 'worker-service', 'high', 'RSS 490MB/512MB — report worker building large result sets in memory'), timestamp: t(45) - 25000, attributes: { memoryLimitMb: 512, rssUsedMb: 490 } },
      { ...ie('disk_pressure', 'api-service', 'high', '/tmp 98% full — report cache files not cleaned up after pool exhaustion'), timestamp: t(45) - 20000, attributes: { filesystem: '/tmp', usedPct: 98 } },
    ],
    originalTag: 'infra_disk_pressure',
    originalConfidenceScore: 0.85,
    originalFixHint: 'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`. Rotate logs immediately: `journalctl --vacuum-size=500M`. Increase PV size or add log retention policy to prevent recurrence.',
  },

  {
    pid: 'seed-047', capturedAt: cap(46), firedAt: t(46),
    logs: [
      ce('error', '[k8s] OOMKilled: search-service container (2Gi limit) — Elasticsearch query loading full index segment into heap', 'http://search-service:8094', t(46) - 20000),
      ce('error', '[search-api] Elasticsearch cluster status degraded: search-service pod OOMKilled, 1 of 3 replicas unavailable', 'http://search-api:8094/search', t(46) - 15000),
      ce('warn',  '[search-api] search latency degraded: 2 replicas serving traffic — p99 latency 4200ms (normal: 200ms)', 'http://search-api:8094/search', t(46) - 10000),
    ],
    network: [
      ne('GET', 'http://search-api:8094/search', 503, 5000, t(46) - 14000, 'upstream OOMKilled'),
    ],
    contexts: [], terminal: [], processExits: [
      { type: 'process_exit', process: 'search-service', exitCode: 137, reason: 'oom', signal: 'SIGKILL', memoryLimitBytes: 2147483648, timestamp: t(46) - 20000 },
    ], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('oom_kill', 'search-service', 'critical', 'OOMKilled: search-service 2Gi limit exceeded — Elasticsearch heap loading full index segment for large query'), timestamp: t(46) - 20000, attributes: { exitCode: 137, memoryLimitMb: 2048 } },
      { ...ie('downstream_latency_spike', 'search-api', 'high', 'p99 latency 4200ms (normal 200ms) — 2/3 replicas serving after OOMKill'), timestamp: t(46) - 10000, attributes: { endpoint: 'http://search-service:8094', p99Ms: 4200 } },
    ],
    originalTag: 'infra_oom_kill',
    originalConfidenceScore: 0.90,
    originalFixHint: 'Increase container memory limit in k8s manifest / docker-compose. Heap-profile with `node --inspect` or `py-spy top` to find the leak. Check for unbounded caches or retained buffers in recent deploys.',
  },

  {
    pid: 'seed-048', capturedAt: cap(47), firedAt: t(47),
    logs: [
      ce('error', '[ingress] TLS certificate expired for api.company.com — all HTTPS traffic returning 526 (SSL handshake failed)', 'https://api.company.com', t(47) - 10000),
      ce('error', '[payments] Stripe webhook delivery failing: upstream 526 SSL error from api.company.com/webhooks/stripe — Stripe retrying', 'http://payments:8082', t(47) - 8000),
      ce('warn',  '[payments] 284 Stripe webhooks queued for retry — cert expiry causing webhook backlog. Stripe retry window: 72 hours.', 'http://payments:8082', t(47) - 5000),
    ],
    network: [
      ne('GET', 'https://api.company.com/health', 526, 150, t(47) - 9500, 'SSL certificate expired'),
      ne('POST', 'https://api.company.com/webhooks/stripe', 526, 145, t(47) - 8500, 'SSL certificate expired'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('certificate_expiry', 'api-gateway', 'critical', 'TLS cert expired for api.company.com — all HTTPS traffic failing 526, Stripe webhook backlog building'), timestamp: t(47) - 10000, attributes: { domain: 'api.company.com', sideEffect: 'stripe-webhook-backlog', webhookBacklog: 284 } },
      { ...ie('queue_backlog', 'payments-service', 'high', '284 Stripe webhooks queued for retry — cert expiry blocking delivery, 72h retry window'), timestamp: t(47) - 5000, attributes: { queue: 'stripe-webhooks', depth: 284 } },
    ],
    originalTag: 'infra_certificate_expiry',
    originalConfidenceScore: 0.85,
    originalFixHint: "Check expiry: `openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates` Renew via Let's Encrypt (`certbot renew`) or your CA. Verify the cert covers the target hostname (SAN list).",
  },

  {
    pid: 'seed-049', capturedAt: cap(48), firedAt: t(48),
    logs: [
      ce('warn',  '[checkout] Adyen rate limit approaching: 820/1000 requests in current 60s window', 'http://checkout:8100/checkout', t(48) - 120000),
      ce('error', '[checkout] Adyen 429 Too Many Requests — payment processing rate limited. Retry storm in progress: 3 workers retrying same requests.', 'http://checkout:8100/checkout', t(48) - 60000),
      ce('warn',  '[checkout] Kafka payment-events queue backing up: 8420 messages — rate-limited Adyen responses queuing for retry', 'http://checkout:8100', t(48) - 30000),
    ],
    network: [
      ne('POST', 'https://checkout.adyen.com/v68/payments', 429, 95, t(48) - 60000, 'Too Many Requests'),
      ne('POST', 'https://checkout.adyen.com/v68/payments', 429, 88, t(48) - 55000, 'Too Many Requests'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('rate_limit_cascade', 'checkout-service', 'high', 'Adyen 429: 1000 req/60s limit hit — retry storm amplifying rate limiting, 3 workers retrying same requests'), timestamp: t(48) - 60000, attributes: { endpoint: 'https://checkout.adyen.com', rateLimit: 1000, rateLimitWindowSec: 60 } },
      { ...ie('queue_backlog', 'checkout-service', 'medium', 'Kafka payment-events backlog 8420 messages — rate-limited Adyen responses accumulating'), timestamp: t(48) - 30000, attributes: { queue: 'payment-events', depth: 8420 } },
    ],
    originalTag: 'infra_rate_limit_cascade',
    originalConfidenceScore: 0.75,
    originalFixHint: 'Add exponential backoff with jitter to the retry loop. Honour the `Retry-After` response header. Consider a token-bucket circuit breaker to shed load before hitting the upstream limit.',
  },

  {
    pid: 'seed-050', capturedAt: cap(49), firedAt: t(49),
    logs: [
      ce('error', '[postgres] autovacuum: found unexpected data in FSM header of relation 16423/app/orders — disk pressure causing vacuum failures', 'http://postgres:5432', t(49) - 7200000),
      ce('error', '[postgres] ERROR: could not extend file "base/16423/1294784": No space left on device. HINT: Check free disk space.', 'http://postgres:5432', t(49) - 3600000),
      ce('error', '[api] connection pool exhausted — postgres cannot extend relation, all queries failing with ENOSPC', 'http://api:8080/api', t(49) - 3500000),
    ],
    network: [
      ne('GET', 'http://api:8080/api/users',   503, 30100, t(49) - 3400000, 'postgres ENOSPC'),
      ne('POST', 'http://api:8080/api/orders',  503, 30050, t(49) - 3300000, 'postgres ENOSPC'),
    ],
    contexts: [], terminal: [], processExits: [], ciEvents: [], deployments: [],
    infraEvents: [
      { ...ie('disk_pressure', 'postgres', 'critical', 'PostgreSQL ENOSPC: cannot extend relation — /data PV full, table growth exceeded PV capacity'), timestamp: t(49) - 3600000, attributes: { filesystem: '/data', cause: 'relation_extension_failed', table: 'orders' } },
      { ...ie('db_connection_pool_exhausted', 'api-service', 'critical', 'pg-pool exhausted — postgres cannot extend relation, all query slots blocked by ENOSPC errors'), timestamp: t(49) - 3500000, attributes: { endpoint: 'postgres://10.12.0.5:5432/app', poolMax: 20 } },
    ],
    originalTag: 'infra_disk_pressure',
    originalConfidenceScore: 0.85,
    originalFixHint: 'Check disk usage: `df -h` and `du -sh /var/log/* /tmp/*`. Rotate logs immediately: `journalctl --vacuum-size=500M`. Increase PV size or add log retention policy to prevent recurrence.',
  },
];

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadSeedCorpus(): { loaded: number; skipped: number } {
  let loaded = 0;
  let skipped = 0;

  try {
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
  } catch (err) {
    logger.warn({ err }, 'seed-corpus: cannot create replay dir');
    return { loaded: 0, skipped: SNAPSHOTS.length };
  }

  for (const snap of SNAPSHOTS) {
    const dest = path.join(REPLAY_DIR, `${snap.pid}.json`);
    if (fs.existsSync(dest)) {
      skipped++;
      continue;
    }
    try {
      fs.writeFileSync(dest, JSON.stringify(snap), 'utf8');
      loaded++;
    } catch (err) {
      logger.warn({ err, pid: snap.pid }, 'seed-corpus: failed to write snapshot');
      skipped++;
    }
  }

  if (loaded > 0) {
    logger.info({ loaded, skipped }, 'seed-corpus: loaded');
  }
  return { loaded, skipped };
}

export const SEED_COUNT = SNAPSHOTS.length;
