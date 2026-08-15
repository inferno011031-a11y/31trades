-- ============================================================================
-- 010 — Broker connections (per-user, side table)
-- ----------------------------------------------------------------------------
-- Tracks which brokers/platforms a user has connected, so the onboarding
-- checklist ("Connect a broker") reflects real state. Read/written directly
-- by server/brokers.js — a side table like ai_findings (008) and
-- notifications_read (009), not part of the canonical snapshot rewrite.
-- ============================================================================

CREATE TABLE IF NOT EXISTS broker_connections (
    user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker        text        NOT NULL,
    status        text        NOT NULL DEFAULT 'active',
    connected_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, broker)
);
