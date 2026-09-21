-- 018_backtest_sessions.sql
CREATE TABLE IF NOT EXISTS public.backtest_sessions (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',
    period TEXT,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    session JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backtest_sessions_user_updated_idx
    ON public.backtest_sessions (user_id, updated_at DESC);
