-- Migration 006: override_corpus provenance + lifecycle columns
--
-- source     — 'community' for pack-imported/pre-seeded entries, 'team' (or NULL)
--              for overrides recorded by this team. Powers pack export filtering
--              (re-exports exclude community entries) and UI provenance labels.
-- rationale  — plain-language "why past-you made this call". Existed on the
--              OverrideEvent type but was silently dropped by the PG store.
-- expires_at — entry lifetime; NULL = permanent. Backs GET /overrides/expiring-soon
--              (the PgOverrideCorpus.getExpiringSoon query already reads it).

ALTER TABLE override_corpus ADD COLUMN IF NOT EXISTS source     TEXT;
ALTER TABLE override_corpus ADD COLUMN IF NOT EXISTS rationale  TEXT;
ALTER TABLE override_corpus ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
