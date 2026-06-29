-- Migration 002: api_keys and shadow_log tables

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  label        TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  rate_limit   INTEGER NOT NULL DEFAULT 1000,
  scope        JSONB NOT NULL DEFAULT '[]',
  expires_at   TEXT,
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT,
  created_by   TEXT NOT NULL DEFAULT 'api-admin'
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx   ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS shadow_log (
  id                     TEXT NOT NULL,
  tenant_id              TEXT NOT NULL DEFAULT 'local',
  pid                    TEXT NOT NULL,
  incident_tag           TEXT NOT NULL,
  service                TEXT NOT NULL,
  command                TEXT,
  diagnosis_confidence   REAL NOT NULL DEFAULT 0,
  remediation_confidence REAL NOT NULL DEFAULT 0,
  would_have_executed    BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason            TEXT NOT NULL,
  fired_at               BIGINT,
  recorded_at            BIGINT NOT NULL,
  human_verdict          TEXT,
  human_note             TEXT,
  verdict_at             BIGINT,
  override_id            TEXT,
  runbook_id             TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS shadow_log_tenant_recorded_idx ON shadow_log(tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS shadow_log_pid_idx ON shadow_log(tenant_id, pid);