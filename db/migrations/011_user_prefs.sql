-- ============================================================================
-- 011 — Per-user preferences (theme sync)
-- ----------------------------------------------------------------------------
-- The theme choice (light / dark / system) lives per user so it follows them
-- across devices, not just one browser's localStorage. Written by the Settings
-- Appearance panel via GET/PUT /api/prefs (server/prefs.js), which mirrors
-- every write to a per-user JSON file as fallback when Postgres is down —
-- exactly like ai_findings (008) and notifications_read (009).
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_prefs (
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    theme      text        NOT NULL DEFAULT 'dark',   -- 'dark' | 'light' | 'system'
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id)
);
