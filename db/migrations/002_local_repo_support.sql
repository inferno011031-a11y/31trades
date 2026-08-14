-- ============================================================================
-- 31TRADES — Migration 002: repository support
-- ----------------------------------------------------------------------------
-- The snapshot repository (server/pg-repo.js) mirrors the canonical core
-- state, where an assignment can legitimately exist without a policy version
-- (e.g. a strategy created before any risk policy existed for the account —
-- the core stores policy_id as NULL in that case, and the trade pipeline
-- self-heals it later). Relax the NOT NULL so those rows persist cleanly.
-- ============================================================================

BEGIN;

ALTER TABLE assignments ALTER COLUMN policy_version_id DROP NOT NULL;

COMMIT;
