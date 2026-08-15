-- ============================================================================
-- 009 — Notification read state
-- ----------------------------------------------------------------------------
-- The Notifications engine (server/notifications.js) tracks which notification
-- ids the user has read so unread counts sync across devices. One row per
-- (user, notification id); notification ids are stable keys derived from the
-- canonical data (e.g. 'risk-limit', 'viol-<tradeId>-<ruleKey>'), so marking a
-- notification read persists even as the feed is recomputed. This is a side
-- table like ai_findings (008): read/written directly by the service, not part
-- of the canonical snapshot rewrite in pg-repo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications_read (
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id text        NOT NULL,
    read_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, notification_id)
);
