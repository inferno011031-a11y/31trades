-- ============================================================================
-- 012 — Legacy Journal Import Engine
-- ----------------------------------------------------------------------------
-- Adds source metadata to the canonical trades table (imported trades are
-- marked source='IMPORT' + carry import_batch_id + a small import_meta jsonb
-- with source_row / external_reference — the canonical ledger itself is the
-- single source of truth; analytics/discipline/calendar/insights all read it).
--
-- Also creates the import_batches side table (per-user batch metadata + the
-- parsed preview payload in a jsonb column) — the same DB-first/file-fallback
-- pattern as broker_connections / ai_findings. Indexes for user_id,
-- account_id, status and the trades→import_batch lookup.
-- ============================================================================

-- ---- canonical trades: import provenance (optional, additive). Plain ADD
-- COLUMN like every other migration — schema_migrations guarantees each file
-- runs exactly once, so re-run guards are unnecessary. ----
ALTER TABLE trades ADD COLUMN source text;
ALTER TABLE trades ADD COLUMN import_batch_id text;
ALTER TABLE trades ADD COLUMN import_meta jsonb;

CREATE INDEX IF NOT EXISTS idx_trades_import_batch
    ON trades (user_id, import_batch_id);

-- ---- import batch metadata (side table, not part of the snapshot rewrite) ----
CREATE TABLE IF NOT EXISTS import_batches (
    id           text        PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id   text        NOT NULL,
    status       text        NOT NULL DEFAULT 'UPLOADED',
    fingerprint  text,                          -- sha256 of the uploaded bytes
    data         jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_batches_user
    ON import_batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_account
    ON import_batches (user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_status
    ON import_batches (user_id, status);
CREATE INDEX IF NOT EXISTS idx_import_batches_fingerprint
    ON import_batches (user_id, fingerprint);
