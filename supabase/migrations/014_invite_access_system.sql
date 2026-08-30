-- ============================================================================
-- BATTLEXJOURNAL — Migration 014: 60 Tester Access + 50 Lifetime AI Requests
-- ----------------------------------------------------------------------------
-- Supports:
--   1. 60 Tester Users (BXJ-2026-A max 30 + BXJ-2026-B max 30) with 1-year access & monthly AI quota
--   2. Normal Users with 50 lifetime AI requests (can use the app freely)
--   3. Atomic PostgreSQL RPC functions for concurrency-safe redemption and AI request consumption
--   4. RLS policies ensuring users only view their own entitlement and cannot manipulate counters
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Invite Codes Table (60 Testers: 30 for Group A, 30 for Group B)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_codes (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 TEXT NOT NULL UNIQUE,
    max_uses             INT NOT NULL DEFAULT 30,
    used_count           INT NOT NULL DEFAULT 0,
    access_type          TEXT NOT NULL DEFAULT 'tester',
    duration_days        INT NOT NULL DEFAULT 365,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Initial 2 Groups (30 testers each, 60 total capacity)
INSERT INTO invite_codes (code, max_uses, used_count, access_type, duration_days)
VALUES 
    ('BXJ-2026-A', 30, 0, 'tester', 365),
    ('BXJ-2026-B', 30, 0, 'tester', 365)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. User Entitlements Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_entitlements (
    user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_type          TEXT NOT NULL DEFAULT 'normal', -- 'normal' | 'tester' | 'internal'
    access_expires_at    TIMESTAMPTZ,                     -- NULL for normal, timestamp for tester
    invite_code_id       UUID REFERENCES invite_codes(id),
    activated_at         TIMESTAMPTZ,
    lifetime_ai_used     INT NOT NULL DEFAULT 0,          -- Normal user lifetime requests (max 50)
    tester_ai_limit      INT NOT NULL DEFAULT 100,        -- Configurable monthly quota for testers
    tester_ai_month      TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM'),
    tester_ai_used       INT NOT NULL DEFAULT 0,          -- Tester monthly consumption
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_entitlements_type ON user_entitlements (access_type);
CREATE INDEX IF NOT EXISTS idx_user_entitlements_expires ON user_entitlements (access_expires_at);

-- ---------------------------------------------------------------------------
-- 3. Atomic Tester Code Redemption RPC (Concurrency Safe with FOR UPDATE)
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
        RETURN jsonb_build_object('ok', false, 'error', 'Please enter a tester invitation code.', 'code', 'EMPTY_CODE');
    END IF;

    v_normalized_code := UPPER(TRIM(p_code));

    -- Step 1: Check whether authenticated user already has active tester access
    SELECT * INTO v_ent FROM user_entitlements WHERE user_id = p_user_id;
    IF FOUND AND v_ent.access_type = 'tester' AND v_ent.access_expires_at > now() THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'Your tester access is already active.',
            'code', 'ALREADY_TESTER',
            'expires_at', v_ent.access_expires_at
        );
    END IF;

    -- Step 2: Acquire exclusive row-level lock on the invite code row
    SELECT * INTO v_code FROM invite_codes WHERE UPPER(TRIM(code)) = v_normalized_code FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'Invalid tester code. Please check the code and try again.',
            'code', 'INVALID_CODE'
        );
    END IF;

    -- Step 3: Check if this specific code has reached its 30-user capacity
    IF v_code.used_count >= v_code.max_uses THEN
        -- Check if all tester slots across all codes are full
        IF (SELECT COALESCE(SUM(used_count), 0) >= COALESCE(SUM(max_uses), 0) FROM invite_codes) THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'Tester access is currently full. You can still use BattleXJournal with the standard AI allowance.',
                'code', 'ALL_SLOTS_FULL'
            );
        ELSE
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'This tester code has reached its ' || v_code.max_uses || '-user limit.',
                'code', 'CODE_FULL'
            );
        END IF;
    END IF;

    -- Step 4: Calculate exact fixed 1-year expiration (365 days from redemption timestamp)
    v_expires_at := now() + (v_code.duration_days || ' days')::INTERVAL;

    -- Step 5: Atomically increment code usage count
    UPDATE invite_codes
    SET used_count = used_count + 1
    WHERE id = v_code.id;

    -- Step 6: Create or update user entitlement to tester tier
    INSERT INTO user_entitlements (
        user_id,
        access_type,
        access_expires_at,
        invite_code_id,
        activated_at,
        lifetime_ai_used,
        tester_ai_limit,
        tester_ai_month,
        tester_ai_used,
        updated_at
    ) VALUES (
        p_user_id,
        'tester',
        v_expires_at,
        v_code.id,
        now(),
        0,
        100,
        to_char(now(), 'YYYY-MM'),
        0,
        now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        access_type = 'tester',
        access_expires_at = v_expires_at,
        invite_code_id = v_code.id,
        activated_at = now(),
        tester_ai_month = to_char(now(), 'YYYY-MM'),
        tester_ai_used = 0,
        updated_at = now();

    RETURN jsonb_build_object(
        'ok', true,
        'access_type', 'tester',
        'expires_at', v_expires_at,
        'activated_at', now(),
        'message', 'Tester access activated. Your 1-year BattleXJournal tester access is now active.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 4. Atomic AI Quota Consumption RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_ai_request(
    p_user_id UUID,
    p_tester_limit INT DEFAULT 100
) RETURNS JSONB AS $$
DECLARE
    v_ent RECORD;
    v_current_month TEXT;
    v_is_tester BOOLEAN;
    v_used INT;
    v_limit INT;
    v_remaining INT;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Authentication required.', 'code', 'UNAUTHORIZED');
    END IF;

    v_current_month := to_char(now(), 'YYYY-MM');

    -- Retrieve or initialize user entitlement
    SELECT * INTO v_ent FROM user_entitlements WHERE user_id = p_user_id FOR UPDATE;
    
    IF NOT FOUND THEN
        INSERT INTO user_entitlements (user_id, access_type, lifetime_ai_used, tester_ai_limit, tester_ai_month, tester_ai_used)
        VALUES (p_user_id, 'normal', 0, p_tester_limit, v_current_month, 0)
        RETURNING * INTO v_ent;
    END IF;

    -- Check if user has active tester access
    v_is_tester := (v_ent.access_type = 'tester' AND v_ent.access_expires_at IS NOT NULL AND v_ent.access_expires_at > now());

    IF v_is_tester THEN
        -- Tester tier: Monthly limit
        v_limit := COALESCE(v_ent.tester_ai_limit, p_tester_limit);
        IF v_ent.tester_ai_month = v_current_month THEN
            v_used := v_ent.tester_ai_used;
        ELSE
            v_used := 0;
        END IF;

        IF v_used >= v_limit THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'Monthly tester AI limit reached (' || v_limit || ' requests/month). Quota resets on the 1st of next month.',
                'code', 'TESTER_LIMIT_REACHED',
                'used', v_used,
                'limit', v_limit,
                'remaining', 0,
                'tier', 'tester'
            );
        END IF;

        -- Increment monthly tester usage
        UPDATE user_entitlements
        SET tester_ai_used = v_used + 1,
            tester_ai_month = v_current_month,
            updated_at = now()
        WHERE user_id = p_user_id;

        RETURN jsonb_build_object(
            'ok', true,
            'used', v_used + 1,
            'limit', v_limit,
            'remaining', v_limit - (v_used + 1),
            'tier', 'tester'
        );

    ELSE
        -- Normal user tier: 50 Lifetime Requests
        v_limit := 50;
        v_used := COALESCE(v_ent.lifetime_ai_used, 0);

        IF v_used >= v_limit THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'You have used all 50 lifetime AI requests available on the standard plan.',
                'code', 'LIFETIME_LIMIT_REACHED',
                'used', v_used,
                'limit', v_limit,
                'remaining', 0,
                'tier', 'normal'
            );
        END IF;

        -- Increment lifetime usage
        UPDATE user_entitlements
        SET lifetime_ai_used = v_used + 1,
            updated_at = now()
        WHERE user_id = p_user_id;

        RETURN jsonb_build_object(
            'ok', true,
            'used', v_used + 1,
            'limit', v_limit,
            'remaining', v_limit - (v_used + 1),
            'tier', 'normal'
        );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_entitlements_select ON user_entitlements;
CREATE POLICY user_entitlements_select ON user_entitlements
    FOR SELECT USING (auth.uid() = user_id);

COMMIT;
