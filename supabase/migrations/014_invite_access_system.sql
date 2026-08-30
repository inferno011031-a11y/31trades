-- ============================================================================
-- BATTLEXJOURNAL — Migration 014: 60-Member 1-Year Invite Access System
-- ----------------------------------------------------------------------------
-- Creates:
--   1. invite_codes table (Group A: BXJ-2026-A max 30, Group B: BXJ-2026-B max 30)
--   2. user_entitlements table (tied to auth user, fixed 1-year expiration, monthly AI quota)
--   3. redeem_invite_code RPC function (atomic row locking with FOR UPDATE to prevent race conditions)
--   4. RLS policies protecting entitlements and invite code validation
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Invite Codes Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_codes (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 TEXT NOT NULL UNIQUE,
    max_uses             INT NOT NULL DEFAULT 30,
    used_count           INT NOT NULL DEFAULT 0,
    access_duration_days INT NOT NULL DEFAULT 365,
    plan                 TEXT NOT NULL DEFAULT 'yearly_invite',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Initial 2 Groups (30 members each, 60 total)
INSERT INTO invite_codes (code, max_uses, used_count, access_duration_days, plan)
VALUES 
    ('BXJ-2026-A', 30, 0, 365, 'yearly_invite'),
    ('BXJ-2026-B', 30, 0, 365, 'yearly_invite')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. User Entitlements Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_entitlements (
    user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_plan          TEXT NOT NULL DEFAULT 'yearly_invite',
    access_expires_at    TIMESTAMPTZ NOT NULL,
    invite_code_id       UUID REFERENCES invite_codes(id),
    activated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    ai_monthly_limit     INT NOT NULL DEFAULT 100,
    ai_usage_month       TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM'),
    ai_usage_count       INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_entitlements_expires ON user_entitlements (access_expires_at);

-- ---------------------------------------------------------------------------
-- 3. Atomic Code Redemption Function (PostgreSQL Transaction + Lock)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redeem_invite_code(
    p_user_id UUID,
    p_code TEXT
) RETURNS JSONB AS $$
DECLARE
    v_code RECORD;
    v_ent RECORD;
    v_normalized_code TEXT;
    v_expires_at TIMESTAMPTZ;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Authentication required.', 'code', 'UNAUTHORIZED');
    END IF;

    IF p_code IS NULL OR TRIM(p_code) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Please enter an invite code.', 'code', 'EMPTY_CODE');
    END IF;

    v_normalized_code := UPPER(TRIM(p_code));

    -- Step 1: Check whether authenticated user already has an active 1-year access period
    SELECT * INTO v_ent FROM user_entitlements WHERE user_id = p_user_id;
    IF FOUND AND v_ent.access_expires_at > now() THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'You already have an active BattleXJournal access period.',
            'code', 'ALREADY_ACTIVE',
            'expires_at', v_ent.access_expires_at
        );
    END IF;

    -- Step 2: Acquire atomic row-level lock on the invite code row to prevent race conditions
    SELECT * INTO v_code FROM invite_codes WHERE UPPER(TRIM(code)) = v_normalized_code FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'Invalid invite code. Please check the code and try again.',
            'code', 'INVALID_CODE'
        );
    END IF;

    -- Step 3: Check if code has reached capacity limit
    IF v_code.used_count >= v_code.max_uses THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'This invite code has reached its ' || v_code.max_uses || '-user limit.',
            'code', 'CODE_FULL'
        );
    END IF;

    -- Step 4: Calculate exact fixed 1-year expiration (from redemption timestamp)
    v_expires_at := now() + (v_code.access_duration_days || ' days')::INTERVAL;

    -- Step 5: Atomically increment used count
    UPDATE invite_codes
    SET used_count = used_count + 1
    WHERE id = v_code.id;

    -- Step 6: Create or update user entitlement
    INSERT INTO user_entitlements (
        user_id,
        access_plan,
        access_expires_at,
        invite_code_id,
        activated_at,
        ai_monthly_limit,
        ai_usage_month,
        ai_usage_count,
        updated_at
    ) VALUES (
        p_user_id,
        v_code.plan,
        v_expires_at,
        v_code.id,
        now(),
        100,
        to_char(now(), 'YYYY-MM'),
        0,
        now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        access_plan = EXCLUDED.access_plan,
        access_expires_at = EXCLUDED.access_expires_at,
        invite_code_id = EXCLUDED.invite_code_id,
        activated_at = EXCLUDED.activated_at,
        updated_at = now();

    RETURN jsonb_build_object(
        'ok', true,
        'plan', v_code.plan,
        'expires_at', v_expires_at,
        'activated_at', now(),
        'message', 'Access activated. Your 1-year BattleXJournal access is now active.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_entitlements ENABLE ROW LEVEL SECURITY;

-- Users can only read their own entitlement
DROP POLICY IF EXISTS user_entitlements_select ON user_entitlements;
CREATE POLICY user_entitlements_select ON user_entitlements
    FOR SELECT USING (auth.uid() = user_id);

COMMIT;
