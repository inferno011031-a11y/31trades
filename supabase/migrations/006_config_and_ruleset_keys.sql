-- ============================================================================
-- 31TRADES — Migration 006: user-scoped keys for rule_sets + config_versions
-- ----------------------------------------------------------------------------
-- The standard rule sets and their initial versions use FIXED ids
-- ('rs-core', 'rs-exec', 'rs-evidence', 'cv_rs_core_v1', …) so every user's
-- seed produces identical rows. With per-user data those must not collide:
-- make both PKs composite (user_id, id) and rebuild the FKs that reference
-- config_versions (assignments, trades, trade_evaluations, audit_log — all
-- already carry user_id from 003).
-- ============================================================================

BEGIN;

-- rule_sets: composite PK (nothing references it)
ALTER TABLE rule_sets DROP CONSTRAINT rule_sets_pkey;
ALTER TABLE rule_sets ADD PRIMARY KEY (user_id, id);

-- config_versions: drop referencing FKs first, composite PK, recreate FKs
ALTER TABLE assignments       DROP CONSTRAINT assignments_policy_version_id_fkey;
ALTER TABLE assignments       DROP CONSTRAINT assignments_strategy_version_id_fkey;
ALTER TABLE trades            DROP CONSTRAINT trades_config_version_id_fkey;
ALTER TABLE trades            DROP CONSTRAINT trades_strategy_version_id_fkey;
ALTER TABLE trade_evaluations DROP CONSTRAINT trade_evaluations_rule_id_fkey;
ALTER TABLE audit_log         DROP CONSTRAINT audit_log_version_id_fkey;

ALTER TABLE config_versions DROP CONSTRAINT config_versions_pkey;
ALTER TABLE config_versions ADD PRIMARY KEY (user_id, id);

ALTER TABLE assignments ADD FOREIGN KEY (user_id, policy_version_id) REFERENCES config_versions(user_id, id);
ALTER TABLE assignments ADD FOREIGN KEY (user_id, strategy_version_id) REFERENCES config_versions(user_id, id);

ALTER TABLE trades ADD FOREIGN KEY (user_id, config_version_id) REFERENCES config_versions(user_id, id);
ALTER TABLE trades ADD FOREIGN KEY (user_id, strategy_version_id) REFERENCES config_versions(user_id, id);

ALTER TABLE trade_evaluations ADD FOREIGN KEY (user_id, rule_id) REFERENCES config_versions(user_id, id);

ALTER TABLE audit_log ADD FOREIGN KEY (user_id, version_id) REFERENCES config_versions(user_id, id);

COMMIT;
