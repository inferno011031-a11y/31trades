-- 018_backtest_sessions.sql
-- Backtest sessions remain isolated from live journal trades. The application keeps
-- the local JSON mirror as a safe fallback and asynchronously mirrors each session
-- here when SUPABASE_DB_URL is configured.
CREATE TABLE IF NOT EXISTS backtest_sessions (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',
    period TEXT,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    session JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backtest_sessions_user_updated_idx
    ON backtest_sessions (user_id, updated_at DESC);
