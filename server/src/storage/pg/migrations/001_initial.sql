-- Migration 001: initial schema

CREATE TABLE IF NOT EXISTS _migrations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  settings   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO tenants (id, name) VALUES ('local', 'local') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'local',
  type        TEXT NOT NULL,
  level       TEXT,
  data        JSONB NOT NULL,
  ts          BIGINT NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_tenant_ts_idx ON events(tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_tenant_ins_idx ON events(tenant_id, inserted_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  pid                     TEXT NOT NULL,
  tenant_id               TEXT NOT NULL DEFAULT 'local',
  hypothesis              TEXT NOT NULL DEFAULT '',
  tag                     TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL DEFAULT 'open',
  assignee                TEXT,
  notes                   JSONB NOT NULL DEFAULT '[]',
  sha                     TEXT,
  environment             TEXT,
  service                 TEXT,
  cluster                 TEXT,
  confidence              REAL NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_by         TEXT,
  resolved_at             TIMESTAMPTZ,
  resolved_autonomously   BOOLEAN NOT NULL DEFAULT FALSE,
  causally_correct        BOOLEAN NOT NULL DEFAULT FALSE,
  context_brief_viewed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, pid)
);
CREATE INDEX IF NOT EXISTS incidents_tenant_status_idx ON incidents(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS incidents_tenant_service_idx ON incidents(tenant_id, service, created_at DESC);

CREATE TABLE IF NOT EXISTS service_edges (
  tenant_id        TEXT NOT NULL DEFAULT 'local',
  source           TEXT NOT NULL,
  target           TEXT NOT NULL,
  weight           INTEGER NOT NULL DEFAULT 1,
  last_incident_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source, target)
);

CREATE TABLE IF NOT EXISTS override_corpus (
  id               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id        TEXT NOT NULL DEFAULT 'local',
  incident_tag     TEXT NOT NULL,
  proposed_command TEXT NOT NULL,
  override_reason  TEXT NOT NULL,
  note             TEXT,
  service          TEXT NOT NULL,
  environment      TEXT NOT NULL DEFAULT 'production',
  day_of_week      INTEGER NOT NULL,
  hour_of_day      INTEGER NOT NULL,
  manual_action    TEXT,
  outcome          TEXT,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor            TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS override_corpus_tag_idx ON override_corpus(tenant_id, incident_tag, service);

CREATE TABLE IF NOT EXISTS pending_approvals (
  token          TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL DEFAULT 'local',
  pid            TEXT NOT NULL,
  command        TEXT NOT NULL,
  tier           TEXT NOT NULL,
  service        TEXT NOT NULL,
  remediation_confidence REAL NOT NULL DEFAULT 0,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  cwd            TEXT,
  blast_radius   JSONB,
  resolved_at    TIMESTAMPTZ,
  resolution     TEXT
);
CREATE INDEX IF NOT EXISTS pending_approvals_pid_idx ON pending_approvals(pid);
