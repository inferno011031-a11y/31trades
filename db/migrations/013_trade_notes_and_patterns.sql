-- ============================================================================
-- 013 — Trade Notes, Chart Snapshots & Behavioral Pattern Intelligence
-- ----------------------------------------------------------------------------
-- Adds chart_url and reflection_tags to canonical trades table.
-- Adds behavioral_patterns table for leak tracking and AI pattern detection.
-- ============================================================================

-- 1. Add additive columns to canonical trades
ALTER TABLE trades ADD COLUMN IF NOT EXISTS chart_url TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS reflection_tags TEXT;

-- 2. Behavioral Patterns Intelligence Table
CREATE TABLE IF NOT EXISTS behavioral_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    pattern_key TEXT NOT NULL,
    pattern_name TEXT NOT NULL,
    category TEXT NOT NULL,          -- 'Execution', 'Risk Management', 'Psychology'
    severity TEXT NOT NULL,          -- 'Critical', 'Warning', 'Positive'
    active_drag NUMERIC(14,2) DEFAULT 0,
    frequency_pct NUMERIC(5,2) DEFAULT 0,
    evidence_count INTEGER DEFAULT 0,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_occurred_at TIMESTAMPTZ,
    details JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_behavioral_patterns_user ON behavioral_patterns(user_id, detected_at DESC);
