-- 019_entitlements_billing.sql
-- Provider-neutral billing contract.
--
-- 1. user_entitlements gains the plan columns a verified provider webhook writes.
--    Tester-program fields (access_type, access_expires_at, tester_ai_*) are left
--    exactly as they are, so redeeming a tester code never fights a paid plan.
-- 2. subscription_events is the idempotency ledger: one row per provider event,
--    unique on (provider, external_event_id), so a retried webhook can never
--    double-apply a plan change.
--
-- No plan is ever written without a verified HMAC signature
-- (BILLING_WEBHOOK_SECRET). Without that env var the webhook endpoint answers
-- 503 billing_not_configured and this table stays empty.
ALTER TABLE user_entitlements ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE user_entitlements ADD COLUMN IF NOT EXISTS plan_status TEXT;
ALTER TABLE user_entitlements ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE user_entitlements ADD COLUMN IF NOT EXISTS billing_provider TEXT;
ALTER TABLE user_entitlements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS subscription_events (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    plan TEXT,
    status TEXT NOT NULL,
    current_period_end TIMESTAMPTZ,
    external_customer_id TEXT,
    occurred_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS subscription_events_user_idx
    ON subscription_events (user_id, received_at DESC);
