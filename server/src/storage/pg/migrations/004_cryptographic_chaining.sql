-- Migration 004: add cryptographic chaining columns for tamper-evident audit logging
ALTER TABLE override_corpus ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE override_corpus ADD COLUMN IF NOT EXISTS prev_hash TEXT;

ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS prev_hash TEXT;
