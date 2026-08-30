-- ============================================================================
-- 31TRADES — Migration 007: user-scoped keys (assignments + trades)
-- ----------------------------------------------------------------------------
-- assignments use sequential ids ('asgn-1', 'asgn-2', …) and the demo seed
-- uses fixed trade ids ('txn-0001', …) — both collide across users. Give them
-- composite (user_id, id) PKs and rebuild the FKs that reference trades
-- (trade_evaluations, violations — user_id from 003; trade_tags gets scoped
-- here so its FK stays valid).
-- ============================================================================

BEGIN;

-- assignments: composite PK (nothing references it)
ALTER TABLE assignments DROP CONSTRAINT assignments_pkey;
ALTER TABLE assignments ADD PRIMARY KEY (user_id, id);

-- trades: drop referencing FKs first, composite PK, recreate FKs
ALTER TABLE trade_evaluations DROP CONSTRAINT trade_evaluations_trade_id_fkey;
ALTER TABLE violations        DROP CONSTRAINT violations_trade_id_fkey;
ALTER TABLE trade_tags        DROP CONSTRAINT trade_tags_trade_id_fkey;

ALTER TABLE trades DROP CONSTRAINT trades_pkey;
ALTER TABLE trades ADD PRIMARY KEY (user_id, id);

ALTER TABLE trade_evaluations ADD FOREIGN KEY (user_id, trade_id) REFERENCES trades(user_id, id) ON DELETE CASCADE;
ALTER TABLE violations        ADD FOREIGN KEY (user_id, trade_id) REFERENCES trades(user_id, id) ON DELETE CASCADE;

-- trade_tags: scope per user so its composite FK works
ALTER TABLE trade_tags ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
UPDATE trade_tags SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
ALTER TABLE trade_tags ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE trade_tags ADD FOREIGN KEY (user_id, trade_id) REFERENCES trades(user_id, id) ON DELETE CASCADE;

COMMIT;
