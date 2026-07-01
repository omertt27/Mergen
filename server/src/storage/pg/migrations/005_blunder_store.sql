-- Migration 005: agent_blunders table for cloud/Postgres mode
--
-- Stores the hash-chained blunder log in Postgres so that the tamper-evident
-- audit trail persists in the team/cloud database instead of a local JSON file.
--
-- Hash chain semantics are identical to the file-based implementation:
--   previous_hash = hash of the preceding entry (or GENESIS_HASH '000…000')
--   hash          = SHA-256( previous_hash || JSON({ id, recordedAt, blunderType,
--                            command, blockReason, service, tag, actor, pid,
--                            confidenceScore, triggeredRules? }) )
--
-- Ring-buffer cap is enforced at write time by the application layer
-- (default MAX_BLUNDERS = 5000).

CREATE TABLE IF NOT EXISTS agent_blunders (
  id               TEXT        NOT NULL,
  tenant_id        TEXT        NOT NULL DEFAULT 'local',
  recorded_at      BIGINT      NOT NULL,
  blunder_type     TEXT        NOT NULL,
  command          TEXT,
  block_reason     TEXT        NOT NULL,
  service          TEXT,
  tag              TEXT,
  actor            TEXT,
  pid              TEXT,
  confidence_score DOUBLE PRECISION,
  triggered_rules  JSONB,
  previous_hash    TEXT        NOT NULL,
  hash             TEXT        NOT NULL,
  PRIMARY KEY (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_blunders_tenant_recorded
  ON agent_blunders (tenant_id, recorded_at ASC);
