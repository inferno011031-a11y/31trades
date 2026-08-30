-- ============================================================================
-- 31TRADES — Migration 004: user-scoped primary keys
-- ----------------------------------------------------------------------------
-- accounts.id and strategies.id were global PRIMARY KEYs. With per-user data
-- (003) two users can legitimately own the same entity ids — e.g. the demo
-- seed's fixed 'acc-prop' / 'strat-lfvg', or coincidentally matching generated
-- ids — and the second user's INSERT would violate the global PK.
--
-- Fix: make the PKs composite (user_id, id) and rebuild every FK that
-- references them as a matching composite FK. Order matters: the referencing
-- FKs must be dropped BEFORE the PKs they depend on.
--
-- config_versions / rule_sets / trades / assignments keep their globally-unique
-- generated ids (cv_/rs_/txn_/asgn_ + timestamp + counter + random), so those
-- PKs stay single-column.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop the FKs that reference accounts / strategies (dependency order)
-- ---------------------------------------------------------------------------

ALTER TABLE assignments       DROP CONSTRAINT assignments_account_id_fkey;
ALTER TABLE assignments       DROP CONSTRAINT assignments_strategy_id_fkey;
ALTER TABLE trades            DROP CONSTRAINT trades_account_id_fkey;
ALTER TABLE trades            DROP CONSTRAINT trades_strategy_id_fkey;
ALTER TABLE trade_evaluations DROP CONSTRAINT trade_evaluations_account_id_fkey;
ALTER TABLE violations        DROP CONSTRAINT violations_account_id_fkey;
ALTER TABLE reviews           DROP CONSTRAINT reviews_account_id_fkey;
ALTER TABLE reviews           DROP CONSTRAINT reviews_account_id_period_date_key;
ALTER TABLE daily_snapshots   DROP CONSTRAINT daily_snapshots_account_id_fkey;

-- ---------------------------------------------------------------------------
-- 2. Composite PKs (user_id, id)
-- ---------------------------------------------------------------------------

ALTER TABLE accounts   DROP CONSTRAINT accounts_pkey;
ALTER TABLE accounts   ADD PRIMARY KEY (user_id, id);

ALTER TABLE strategies DROP CONSTRAINT strategies_pkey;
ALTER TABLE strategies ADD PRIMARY KEY (user_id, id);

-- ---------------------------------------------------------------------------
-- 3. Recreate the FKs as composite
-- ---------------------------------------------------------------------------

ALTER TABLE assignments ADD FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE;
ALTER TABLE assignments ADD FOREIGN KEY (user_id, strategy_id) REFERENCES strategies(user_id, id) ON DELETE CASCADE;

ALTER TABLE trades ADD FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE;
ALTER TABLE trades ADD FOREIGN KEY (user_id, strategy_id) REFERENCES strategies(user_id, id) ON DELETE RESTRICT;

ALTER TABLE trade_evaluations ADD FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE;

ALTER TABLE violations ADD FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE;

ALTER TABLE reviews ADD FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE;
ALTER TABLE reviews ADD UNIQUE (user_id, account_id, period, date);

-- daily_snapshots is scoped per account-day → becomes per user too.
ALTER TABLE daily_snapshots ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
UPDATE daily_snapshots SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
ALTER TABLE daily_snapshots ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE daily_snapshots ADD FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id) ON DELETE CASCADE;

ALTER TABLE daily_snapshots DROP CONSTRAINT daily_snapshots_pkey;
ALTER TABLE daily_snapshots ADD PRIMARY KEY (user_id, account_id, day);

COMMIT;
