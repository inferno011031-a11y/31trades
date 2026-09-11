-- ============================================================================
-- 016 — Discord connections (Discord ↔ BattleXJournal identity link)
-- ----------------------------------------------------------------------------
-- One row per verified Discord↔BattleX link.
--   · user_id is UNIQUE   → a BattleX account can be linked to ONE Discord.
--   · discord_user_id is UNIQUE → a Discord account can claim ONE BattleX
--     account. Re-verification upserts the same row (idempotent).
-- The bot's /profile reads plan data from user_entitlements via this link —
-- no duplicated plan/quota columns live here.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS discord_connections (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    discord_user_id  TEXT NOT NULL,
    discord_username TEXT,
    verified         BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A BattleX account links to at most one Discord account.
CREATE UNIQUE INDEX IF NOT EXISTS ux_discord_connections_user
    ON discord_connections(user_id);

-- A Discord account claims at most one BattleX account.
CREATE UNIQUE INDEX IF NOT EXISTS ux_discord_connections_discord
    ON discord_connections(discord_user_id);

CREATE INDEX IF NOT EXISTS idx_discord_connections_verified
    ON discord_connections(verified);

COMMIT;
