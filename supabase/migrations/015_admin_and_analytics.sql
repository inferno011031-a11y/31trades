-- ============================================================================
-- BATTLEXJOURNAL — Migration 015: Admin Dashboard & Activity Analytics
-- ----------------------------------------------------------------------------
-- Supports:
--   1. Lightweight user activity logging for accurate DAU/WAU/MAU and event auditing
--   2. Last login tracking on user entitlements
--   3. Database indexes for fast aggregations and paginated user search
-- ============================================================================

BEGIN;

-- 1. Add last_login_at column to user_entitlements if not present
ALTER TABLE user_entitlements
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_entitlements_last_login ON user_entitlements (last_login_at);
CREATE INDEX IF NOT EXISTS idx_user_entitlements_created_at ON user_entitlements (created_at);

-- 2. Lightweight User Activity Log (Audit & Analytics)
CREATE TABLE IF NOT EXISTS user_activity_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type  TEXT NOT NULL, -- 'login' | 'register' | 'ai_request' | 'code_redeem'
    details     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_activity_created_at ON user_activity_log (created_at);
CREATE INDEX IF NOT EXISTS idx_user_activity_event_type ON user_activity_log (event_type);
CREATE INDEX IF NOT EXISTS idx_user_activity_user_id ON user_activity_log (user_id);

-- 3. Row Level Security for Activity Log (Admin only access)
ALTER TABLE user_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_activity_log_select ON user_activity_log;
CREATE POLICY user_activity_log_select ON user_activity_log
    FOR SELECT USING (auth.uid() = user_id);

COMMIT;
