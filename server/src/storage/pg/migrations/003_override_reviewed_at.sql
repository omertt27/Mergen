-- 003_override_reviewed_at.sql
-- Adds review tracking to the override corpus so operators can re-affirm
-- entries and the digest can surface stale (long-unreviewed) overrides.
-- Mirrors the sqlite/in-memory OverrideEvent.reviewedAt field.

ALTER TABLE override_corpus
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
