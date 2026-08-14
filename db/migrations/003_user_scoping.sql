-- ============================================================================
-- 31TRADES — Migration 003: per-user data scoping
-- ----------------------------------------------------------------------------
-- Every canonical table gets a user_id so the server can partition data per
-- Supabase Auth user. Accounts and strategies already carry user_id (001);
-- this adds it to the remaining tables, backfills existing rows to the local
-- placeholder user (pre-auth data), then makes it NOT NULL.
--
-- The repository (server/pg-repo.js) filters load() and deletes by user_id,
-- so each signed-in user only ever sees — and can only write — their own rows.
-- ============================================================================

BEGIN;

ALTER TABLE config_versions   ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE rule_sets         ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE assignments       ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE trades            ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE trade_evaluations ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE violations        ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reviews           ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE audit_log         ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill pre-auth rows to the local placeholder user, then lock the column.
UPDATE config_versions   SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
UPDATE rule_sets         SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
UPDATE assignments       SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
UPDATE trades            SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
UPDATE trade_evaluations SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
UPDATE violations        SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
UPDATE reviews           SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
UPDATE audit_log         SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;

ALTER TABLE config_versions   ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE rule_sets         ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE assignments       ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE trades            ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE trade_evaluations ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE violations        ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE reviews           ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE audit_log         ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX idx_config_versions_user   ON config_versions(user_id);
CREATE INDEX idx_rule_sets_user         ON rule_sets(user_id);
CREATE INDEX idx_assignments_user       ON assignments(user_id);
CREATE INDEX idx_trades_user            ON trades(user_id);
CREATE INDEX idx_trade_evals_user       ON trade_evaluations(user_id);
CREATE INDEX idx_violations_user        ON violations(user_id);
CREATE INDEX idx_reviews_user           ON reviews(user_id);
CREATE INDEX idx_audit_user             ON audit_log(user_id);

COMMIT;
