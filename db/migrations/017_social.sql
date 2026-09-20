-- ============================================================================
-- 017 — Social layer: public trader profiles, global leaderboard, squads
-- ----------------------------------------------------------------------------
--   social_profiles      one row per trader who opts into a public identity.
--                        `visibility` is the privacy contract: nothing is ever
--                        published about a trader whose visibility.public is
--                        false, and each metric can be hidden individually.
--   leaderboard_entries  the published standings snapshot, rebuilt from the
--                        user's OWN canonical ledger (server/leaderboard.js).
--                        `days` holds per-day aggregates (n/w/l/gW/gL/rS/rk) so
--                        any range (7d / 30d / quarter season / all-time) can be
--                        computed on read without rescanning trades.
--                        `squad_id` is a soft reference — squad rows live in the
--                        same file/migration set, and stale ids simply drop out
--                        of the squad board.
--   squads / squad_members  a squad is a named team with a join code. One squad
--                        per trader (ux_squad_members_user) keeps squad standings
--                        unambiguous — switching squads means leaving first.
-- Every table is keyed to public.users so deletes cascade. Local-first mode
-- mirrors all three stores to data/*.json (same pattern as 008–011, 016).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS social_profiles (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    handle       TEXT        NOT NULL,                       -- public slug, unique, case-insensitive
    display_name TEXT,
    bio          TEXT,
    country      TEXT,                                       -- ISO-2, optional
    avatar       TEXT,                                       -- accent hex (no image uploads yet)
    links        JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {x,discord,youtube,website}
    visibility   JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {public,showNet,showWinRate,...}
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_social_profiles_handle ON social_profiles (lower(handle));

CREATE TABLE IF NOT EXISTS leaderboard_entries (
    user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    handle         TEXT,
    display_name   TEXT,
    avatar         TEXT,
    country        TEXT,
    squad_id       TEXT,
    days           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    discipline     INTEGER,                                  -- latest discipline score (0–100)
    first_trade_at TIMESTAMPTZ,
    last_trade_at  TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_entries_updated ON leaderboard_entries (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_entries_squad   ON leaderboard_entries (squad_id);

CREATE TABLE IF NOT EXISTS squads (
    id          TEXT PRIMARY KEY,                            -- 'sqd_…'
    name        TEXT        NOT NULL,
    tag         TEXT        NOT NULL,                        -- 2–5 char banner tag
    owner_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_squads_invite_code ON squads (invite_code);
CREATE UNIQUE INDEX IF NOT EXISTS ux_squads_tag         ON squads (upper(tag));

CREATE TABLE IF NOT EXISTS squad_members (
    squad_id  TEXT        NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
    user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT        NOT NULL DEFAULT 'member',         -- 'owner' | 'member'
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (squad_id, user_id)
);

-- One squad per trader — squad standings stay unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS ux_squad_members_user ON squad_members (user_id);
CREATE INDEX IF NOT EXISTS idx_squad_members_squad      ON squad_members (squad_id);

COMMIT;
