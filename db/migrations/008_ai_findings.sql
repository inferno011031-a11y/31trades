-- ============================================================================
-- 008 — AI Mentor findings cache
-- ----------------------------------------------------------------------------
-- The AI Intelligence layer stores every finding it generates so the UI can
-- render instantly and the user can dismiss (suppress) or rate (feedback)
-- individual findings — the coach learns what is noise for each trader.
-- Findings are user-scoped like every other canonical table; the composite
-- primary key matches the per-user scoping pattern established in 004–007.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_findings (
    user_id       uuid        NOT NULL,
    finding_id    text        NOT NULL,
    finding_type  text        NOT NULL,
    severity      text        NOT NULL,
    title         text        NOT NULL,
    message       text        NOT NULL,
    evidence      jsonb       NOT NULL DEFAULT '[]',
    cost          numeric,
    confidence    text,
    suppressed    boolean     NOT NULL DEFAULT false,
    feedback      integer,
    first_seen    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, finding_id)
);
