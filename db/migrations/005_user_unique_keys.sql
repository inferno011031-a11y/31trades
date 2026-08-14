-- ============================================================================
-- 31TRADES — Migration 005: user-scoped unique constraints
-- ----------------------------------------------------------------------------
-- config_versions had UNIQUE (entity_type, entity_id, version) globally.
-- Entity ids are per-user (an account 'acc-prop' belongs to many users), so
-- two users creating the same version chain would collide. Scope it by user.
-- ============================================================================

BEGIN;

ALTER TABLE config_versions DROP CONSTRAINT config_versions_entity_type_entity_id_version_key;
ALTER TABLE config_versions ADD UNIQUE (user_id, entity_type, entity_id, version);

COMMIT;
