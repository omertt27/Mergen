/**
 * seeds/community-corpus.ts — Pre-built override corpus entries from common
 * engineering operational patterns.
 *
 * These entries seed the Override Corpus on first install so the corpus-block
 * gate fires on day 1, not month 2. Each entry represents a pattern that
 * real engineering teams consistently encode as operational policy.
 *
 * All entries carry `source: 'community'` so teams can distinguish them from
 * their own overrides and dismiss any that don't apply to their stack.
 *
 * Call loadCommunityCorpus() once at server startup. It is a no-op if an
 * entry with the same (incidentTag, overrideReason, dayOfWeek, hourOfDay)
 * already exists — real team overrides always take precedence.
 */

import { importOverrides } from '../intelligence/override-corpus.js';
import logger from '../sensor/logger.js';

interface CommunityEntry {
  incidentTag: string;
  proposedCommand: string;
  overrideReason: import('../intelligence/override-corpus.js').OverrideReason;
  rationale: string;
  service: string;
  environment: string;
  dayOfWeek: number;   // 0=Sunday … 6=Saturday, UTC
  hourOfDay: number;   // 0–23 UTC
  actor: string;
}

// ── Community corpus (12 entries) ────────────────────────────────────────────

const COMMUNITY_ENTRIES: CommunityEntry[] = [
  // ── Friday settlement window ──────────────────────────────────────────────
  {
    incidentTag:     'infra_db_connection_pool',
    proposedCommand: 'ALTER SYSTEM SET max_connections = 300',
    overrideReason:  'compliance-hold',
    rationale:       'Friday settlement window — pool resize requires DBA sign-off and is unsafe during batch job window (Fri 14:00–24:00 UTC)',
    service:         'postgres',
    environment:     'production',
    dayOfWeek:       5, // Friday
    hourOfDay:       14,
    actor:           'community',
  },
  {
    incidentTag:     'infra_db_connection_pool',
    proposedCommand: 'ALTER SYSTEM SET max_connections = 300',
    overrideReason:  'compliance-hold',
    rationale:       'Friday settlement window late — do not resize DB connections after 18:00 UTC Friday',
    service:         'postgres',
    environment:     'production',
    dayOfWeek:       5,
    hourOfDay:       18,
    actor:           'community',
  },

  // ── Schema mutations during peak traffic ──────────────────────────────────
  {
    incidentTag:     'infra_slow_query',
    proposedCommand: 'CREATE INDEX CONCURRENTLY idx_users_email ON users(email)',
    overrideReason:  'batch-window',
    rationale:       'Index builds compete with peak traffic queries Mon–Fri 08:00–18:00 UTC — run during off-hours or maintenance window',
    service:         'postgres',
    environment:     'production',
    dayOfWeek:       1, // Monday
    hourOfDay:       9,
    actor:           'community',
  },
  {
    incidentTag:     'infra_slow_query',
    proposedCommand: 'CREATE INDEX CONCURRENTLY idx_users_email ON users(email)',
    overrideReason:  'batch-window',
    rationale:       'Index builds during mid-day peak — defer to overnight maintenance window',
    service:         'postgres',
    environment:     'production',
    dayOfWeek:       3, // Wednesday
    hourOfDay:       14,
    actor:           'community',
  },

  // ── Redis cache flush during active sessions ───────────────────────────────
  {
    incidentTag:     'infra_service_unavailable',
    proposedCommand: 'redis-cli FLUSHDB',
    overrideReason:  'on-call-discretion',
    rationale:       'Flushing Redis during business hours logs out all active users — coordinate with support team and post change notice first',
    service:         'redis',
    environment:     'production',
    dayOfWeek:       2, // Tuesday
    hourOfDay:       10,
    actor:           'community',
  },

  // ── Weekend batch window auto-scaling block ───────────────────────────────
  {
    incidentTag:     'infra_queue_backlog',
    proposedCommand: 'kubectl scale deployment/worker --replicas=20',
    overrideReason:  'batch-window',
    rationale:       'Weekend batch window — worker auto-scaling competes with scheduled ETL jobs Sat–Sun; coordinate with data team before scaling',
    service:         'worker',
    environment:     'production',
    dayOfWeek:       6, // Saturday
    hourOfDay:       2,
    actor:           'community',
  },
  {
    incidentTag:     'infra_queue_backlog',
    proposedCommand: 'kubectl scale deployment/worker --replicas=20',
    overrideReason:  'batch-window',
    rationale:       'Sunday batch window — do not auto-scale workers during Sunday ETL window (00:00–06:00 UTC)',
    service:         'worker',
    environment:     'production',
    dayOfWeek:       0, // Sunday
    hourOfDay:       3,
    actor:           'community',
  },

  // ── Database credential rotation ──────────────────────────────────────────
  {
    incidentTag:     'infra_service_unavailable',
    proposedCommand: 'aws secretsmanager rotate-secret --secret-id prod/db/password',
    overrideReason:  'compliance-hold',
    rationale:       'DB credential rotation requires CAB approval and a coordinated rolling restart — cannot be done autonomously without change ticket',
    service:         'secrets-manager',
    environment:     'production',
    dayOfWeek:       4, // Thursday
    hourOfDay:       15,
    actor:           'community',
  },

  // ── Direct production migration block ────────────────────────────────────
  {
    incidentTag:     'infra_slow_query',
    proposedCommand: 'prisma migrate deploy',
    overrideReason:  'compliance-hold',
    rationale:       'Production migrations must run via CI pipeline with rollback plan — direct deploy bypasses peer review and breaks audit trail',
    service:         'api',
    environment:     'production',
    dayOfWeek:       1,
    hourOfDay:       11,
    actor:           'community',
  },

  // ── OOM restart block during payment processing ──────────────────────────
  {
    incidentTag:     'infra_oom_kill',
    proposedCommand: 'kubectl rollout restart deployment/payments',
    overrideReason:  'on-call-discretion',
    rationale:       'Payments service restart during checkout window drops in-flight transactions — drain first, then restart after traffic drops below 20 req/s',
    service:         'payments',
    environment:     'production',
    dayOfWeek:       5, // Friday
    hourOfDay:       17,
    actor:           'community',
  },

  // ── Rate limit cascade: do not retry immediately ─────────────────────────
  {
    incidentTag:     'infra_rate_limit_cascade',
    proposedCommand: 'kubectl scale deployment/api --replicas=10',
    overrideReason:  'cost-constraint',
    rationale:       'Scaling API pods does not fix upstream rate limit cascades — it amplifies the retry storm; fix the backoff logic instead',
    service:         'api',
    environment:     'production',
    dayOfWeek:       2,
    hourOfDay:       8,
    actor:           'community',
  },

  // ── Disk pressure: do not delete pg_wal without DBA approval ─────────────
  {
    incidentTag:     'infra_disk_pressure',
    proposedCommand: 'find /var/lib/postgresql/data/pg_wal -mtime +7 -delete',
    overrideReason:  'compliance-hold',
    rationale:       'Deleting WAL segments without verifying replication lag can break standby replicas — always check pg_stat_replication first, then get DBA approval',
    service:         'postgres',
    environment:     'production',
    dayOfWeek:       3,
    hourOfDay:       20,
    actor:           'community',
  },
];

export function loadCommunityCorpus(): { loaded: number; skipped: number } {
  // importOverrides (not recordOverride): it preserves each entry's intended
  // dayOfWeek/hourOfDay window instead of stamping the current clock, and
  // dedups on the same pattern key this seeder previously computed by hand.
  try {
    const { imported, skipped } = importOverrides(
      COMMUNITY_ENTRIES.map(({ actor: _actor, ...entry }) => ({
        ...entry,
        manualAction: 'Deferred — see rationale',
      })),
      { source: 'community', actor: 'community' },
    );
    if (imported > 0) {
      logger.info({ loaded: imported, skipped }, 'community-corpus: seeded');
    }
    return { loaded: imported, skipped };
  } catch (err) {
    logger.warn({ err }, 'community-corpus: failed to seed');
    return { loaded: 0, skipped: COMMUNITY_ENTRIES.length };
  }
}

export const COMMUNITY_CORPUS_COUNT = COMMUNITY_ENTRIES.length;
