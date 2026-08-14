-- ============================================================================
-- 31TRADES — Migration 001: Initial schema
-- ----------------------------------------------------------------------------
-- Matches backend-design.md §1 (Database Schema).
--
-- Design invariants enforced here:
--   · config_versions is APPEND-ONLY — every configuration change inserts a
--     new row (version bump); rows are never updated or deleted. The UNIQUE
--     constraint on (entity_type, entity_id, version) guarantees one version
--     number per entity.
--   · trades carry the EXACT immutable version ids (config_version_id +
--     strategy_version_id) that were active when the trade happened, so
--     historical evaluations are frozen forever.
--   · accounts.current_equity is deliberately NOT a source of truth — it is a
--     cache column refreshed inside the trade transaction (see
--     src/core/index.js recomputeEquities / TradeService). A rebuild-from-ledger
--     job is the healing mechanism if it ever drifts.
--   · audit_log is append-only; nothing in the app ever updates or deletes it.
--
-- Money is NUMERIC(14,2); prices are NUMERIC(14,5) (forex needs 5 decimals).
-- Derived fields (hour, dow, assetClass, holdMin, postLoss, delayMin) are
-- computed in the service layer, not stored — per the spec's decision.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    timezone      TEXT NOT NULL DEFAULT 'UTC',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    selected_account_id TEXT,                       -- account selection persists across screens
    saved_views         JSONB NOT NULL DEFAULT '[]' -- journal saved views: [{name, filters, table}]
);

-- ---------------------------------------------------------------------------
-- Accounts (identity only — limits live in config_versions as RiskPolicy)
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
    id               TEXT PRIMARY KEY,              -- 'acc-…' (frontend generates ids)
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    account_type     TEXT,                          -- 'Prop / Funded' | 'Personal' | 'Broker'
    currency         TEXT NOT NULL DEFAULT 'USD',
    starting_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    style            TEXT,                          -- 'Intraday', …
    status           TEXT NOT NULL DEFAULT 'Active',-- Active | Paused | Archived
    note             TEXT,
    current_equity   NUMERIC(14,2),                 -- CACHE ONLY — derived from starting_balance + Σ pnl
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at      TIMESTAMPTZ
);

CREATE INDEX idx_accounts_user ON accounts(user_id);

-- ---------------------------------------------------------------------------
-- The immutable version table (one table for ALL configuration)
-- ---------------------------------------------------------------------------

CREATE TABLE config_versions (
    id          TEXT PRIMARY KEY,                   -- 'cv_…'
    entity_type TEXT NOT NULL CHECK (entity_type IN ('RiskPolicy', 'Strategy', 'RuleSet')),
    entity_id   TEXT NOT NULL,                      -- account id / strategy id / rule_set id
    version     TEXT NOT NULL,                      -- 'v1.0', 'v1.1', …
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(), -- = "effective from" timestamp
    values      JSONB NOT NULL,                     -- {maxDailyLoss, riskPerTrade, rules:[…], sessions:[…], …}
    note        TEXT,
    UNIQUE (entity_type, entity_id, version)
);

CREATE INDEX idx_config_versions_entity ON config_versions(entity_type, entity_id, created_at DESC);

-- Resolve the configuration version active for an entity as of a timestamp.
-- Mirrors configVersionActiveAt() in src/core/index.js — the rule engine and
-- all evaluation queries use this one resolution path.
CREATE FUNCTION config_version_active_at(
    p_entity_type TEXT,
    p_entity_id   TEXT,
    p_as_of       TIMESTAMPTZ
) RETURNS config_versions
LANGUAGE sql STABLE AS $$
    SELECT cv.*
    FROM config_versions cv
    WHERE cv.entity_type = p_entity_type
      AND cv.entity_id   = p_entity_id
      AND cv.created_at <= p_as_of
    ORDER BY cv.created_at DESC
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Identity registries + assignments
-- ---------------------------------------------------------------------------

CREATE TABLE strategies (                         -- StrategyMaster
    id          TEXT PRIMARY KEY,                 -- 'strat-…'
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,                             -- 'desc' is a reserved word; mapped to core's .desc
    color       TEXT,
    status      TEXT NOT NULL DEFAULT 'Active'
);

CREATE INDEX idx_strategies_user ON strategies(user_id);

CREATE TABLE rule_sets (                          -- RuleSetMaster
    id    TEXT PRIMARY KEY,                       -- 'rs-…'
    name  TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'Global'          -- 'Accounts' | 'Strategies' | 'Global'
);

CREATE TABLE assignments (                        -- StrategyAssignments (append-only on re-point)
    id                    TEXT PRIMARY KEY,       -- 'asgn-…'
    account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    strategy_id           TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    policy_version_id     TEXT NOT NULL REFERENCES config_versions(id),
    strategy_version_id   TEXT REFERENCES config_versions(id),
    active_from           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignments_account ON assignments(account_id, active_from DESC);

-- ---------------------------------------------------------------------------
-- Trades (canonical, immutable evidence)
-- ---------------------------------------------------------------------------

CREATE TABLE trades (
    id                  TEXT PRIMARY KEY,          -- 'txn-…' (frontend generates ids → idempotent POSTs)
    account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    strategy_id         TEXT NOT NULL REFERENCES strategies(id) ON DELETE RESTRICT,
    config_version_id   TEXT NOT NULL REFERENCES config_versions(id),   -- policy version at trade time
    strategy_version_id TEXT REFERENCES config_versions(id),            -- strategy version at trade time
    ts                  TIMESTAMPTZ NOT NULL,
    symbol              TEXT NOT NULL,
    dir                 TEXT NOT NULL CHECK (dir IN ('Long', 'Short')),
    setup               TEXT,
    session             TEXT,
    emotion             TEXT,
    adherence           TEXT,
    entry               NUMERIC(14,5),
    exit                NUMERIC(14,5),
    size                NUMERIC(14,2),
    risk                NUMERIC(14,2),             -- planned / actual risk $
    pnl                 NUMERIC(14,2),
    r                   NUMERIC(10,2),             -- derived: pnl / risk (recomputed on edit)
    stop                NUMERIC(14,5),
    tp                  NUMERIC(14,5),
    note                TEXT,
    reviewed            BOOLEAN NOT NULL DEFAULT false,
    adherence_result    TEXT CHECK (adherence_result IN ('PASS', 'VIOLATION', 'BLOCK')),
    block_reason        TEXT,
    evidence            JSONB NOT NULL DEFAULT '[]',-- [{kind:'screenshot', url:'…'}]
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trades_account_ts   ON trades(account_id, ts DESC);
CREATE INDEX idx_trades_symbol       ON trades(symbol);
CREATE INDEX idx_trades_setup        ON trades(setup);
CREATE INDEX idx_trades_session      ON trades(session);
CREATE INDEX idx_trades_strategy     ON trades(strategy_id);

-- keep trades.updated_at honest on any row write
CREATE FUNCTION touch_trade_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_trades_touch_updated_at
    BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION touch_trade_updated_at();

-- ---------------------------------------------------------------------------
-- Audit + derived-by-products
-- ---------------------------------------------------------------------------

CREATE TABLE trade_evaluations (                  -- what each rule said, at trade time (append-only)
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id     TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    rule_id      TEXT NOT NULL REFERENCES config_versions(id),   -- the rule-set version that ran
    rule_key     TEXT NOT NULL,
    rule_label   TEXT,
    rule_version TEXT,
    category     TEXT,
    severity     TEXT CHECK (severity IN ('Hard', 'Soft')),
    expected     TEXT,
    actual       TEXT,
    state        TEXT NOT NULL CHECK (state IN ('PASS', 'FAIL', 'SKIP')),
    explanation  TEXT,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trade_evals_trade ON trade_evaluations(trade_id);

CREATE TABLE violations (                         -- discipline events (hard-rule FAILs)
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id     TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    rule_key     TEXT NOT NULL,
    rule_label   TEXT,
    rule_version TEXT,
    severity     TEXT CHECK (severity IN ('Hard', 'Soft')),
    expected     TEXT,
    actual       TEXT,
    explanation  TEXT,
    pnl          NUMERIC(14,2),
    r            NUMERIC(10,2),
    review_state TEXT NOT NULL DEFAULT 'open' CHECK (review_state IN ('open', 'acknowledged', 'resolved')),
    ts           TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_violations_account_ts ON violations(account_id, ts DESC);

CREATE TABLE reviews (                            -- completion records only; the CONTENT is derived
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period       TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
    date         DATE NOT NULL,
    note         TEXT,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, period, date)
);

CREATE TABLE audit_log (                          -- append-only, written inside the same transaction as the change
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,                    -- created | edited | version-bumped | deleted | …
    detail      TEXT,
    old_value   JSONB,
    new_value   JSONB,
    version_id  TEXT REFERENCES config_versions(id),  -- set when a version was created
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------

CREATE TABLE tags (
    id          TEXT PRIMARY KEY,                 -- 'tag-…'
    name        TEXT NOT NULL UNIQUE,
    archived_at TIMESTAMPTZ                       -- TAG_ARCHIVED = soft delete; historical trades keep the tag
);

CREATE TABLE trade_tags (
    trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (trade_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- Optional read-model — ONLY needed past ~50k trades. Never the source of
-- truth: a rebuild-from-ledger job is the healing mechanism. The calendar,
-- dashboard and analytics handlers refresh the affected day rows on mutation.
-- ---------------------------------------------------------------------------

CREATE TABLE daily_snapshots (
    account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    day              DATE NOT NULL,
    pnl              NUMERIC(14,2) NOT NULL DEFAULT 0,
    trades           INTEGER NOT NULL DEFAULT 0,
    wins             INTEGER NOT NULL DEFAULT 0,
    losses           INTEGER NOT NULL DEFAULT 0,
    risk_used        NUMERIC(14,2) NOT NULL DEFAULT 0,
    violations       INTEGER NOT NULL DEFAULT 0,
    discipline_score NUMERIC(5,2),
    PRIMARY KEY (account_id, day)
);

COMMIT;
