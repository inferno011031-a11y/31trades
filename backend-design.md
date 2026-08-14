# 31TRADES — Backend Architecture Design

> Status: design spec. Grounded in the existing frontend (`core.js` canonical model + event bus + 7-step pipeline, `server.js` REST stub). The migration from the current local-first implementation should be mechanical, not conceptual.

## Guiding principles (already encoded in the frontend — keep them)

1. **`trades` + `config_versions` are the only facts.** Everything else — equity, risk state, discipline score, analytics, calendar, insights — is *derived* and recomputed from them.
2. **Configuration is append-only.** Editing a strategy / limits / rules inserts a new `config_versions` row; it never updates the old one. Every trade stores the exact version ids that were active when it happened, so history is frozen.
3. **One calculation core.** `computeAnalytics()`, `riskState()`, `disciplineState()`, `calendarMonth()`, `insights()` in `core.js` are the *only* implementations. Endpoints call them; pages never calculate their own totals. The backend must keep this: services shared between server and browser, never duplicated.
4. **Mutations go through the event bus.** The frontend already publishes `trade.created/updated/deleted`, `config.version.created`, `review.completed`, `account.changed`. The backend uses the same vocabulary with an outbox for transactional integrity.

---

## 1. Database Schema (PostgreSQL)

### Identity

```sql
users
  id            UUID PK
  email         TEXT UNIQUE NOT NULL
  password_hash TEXT NOT NULL
  display_name  TEXT
  timezone      TEXT DEFAULT 'UTC'
  created_at    TIMESTAMPTZ DEFAULT now()

user_preferences
  user_id            UUID PK FK → users
  selected_account_id TEXT NULL          -- shared account selection (already persisted client-side)
  saved_views        JSONB DEFAULT '[]'  -- journal saved views: [{name, filters, table}]
```

### Accounts

```sql
accounts                    -- identity only; limits live in config_versions
  id            TEXT PK        -- keep 'acc-…' ids
  user_id       UUID FK → users
  name          TEXT NOT NULL
  account_type  TEXT            -- 'Prop / Funded' | 'Personal' | 'Broker'
  currency      TEXT DEFAULT 'USD'
  starting_balance NUMERIC(14,2)
  style         TEXT            -- 'Intraday', …
  status        TEXT DEFAULT 'Active'   -- Active | Paused | Archived
  note          TEXT
  created_at    TIMESTAMPTZ
  archived_at   TIMESTAMPTZ NULL
  -- current_equity is DERIVED (starting_balance + Σ pnl). No authoritative
  -- column, or a cache column refreshed inside the trade transaction.
```

### The immutable version table (heart of the system)

```sql
config_versions              -- append-only. One table for ALL configuration.
  id            TEXT PK        -- 'cv_…'
  entity_type   TEXT           -- 'RiskPolicy' | 'Strategy' | 'RuleSet'
  entity_id     TEXT           -- account id / strategy id / rule_set id
  version       TEXT           -- 'v1.0', 'v1.1', …
  created_at    TIMESTAMPTZ    -- = "effective from" timestamp (mirrors the cv() helper)
  values        JSONB NOT NULL -- {maxDailyLoss, riskPerTrade, rules:[…], sessions:[…], …}
  note          TEXT
  UNIQUE (entity_type, entity_id, version)
  -- NEVER UPDATE. Active version as-of date = configVersionActiveAt(…)
```

### Identity registries + assignments

```sql
strategies                   -- StrategyMaster
  id TEXT PK, user_id UUID FK, name TEXT, desc TEXT, color TEXT, status TEXT DEFAULT 'Active'

rule_sets                    -- RuleSetMaster
  id TEXT PK, name TEXT, scope TEXT   -- 'Accounts' | 'Strategies' | 'Global'

assignments                  -- StrategyAssignments (append-only on re-point)
  id TEXT PK
  account_id TEXT FK → accounts
  strategy_id TEXT FK → strategies
  policy_version_id     TEXT FK → config_versions
  strategy_version_id   TEXT FK → config_versions
  active_from TIMESTAMPTZ
```

### Trades (canonical evidence)

```sql
trades                       -- canonical, immutable evidence
  id                 TEXT PK        -- keep 'txn-…' ids → idempotent POSTs for free
  account_id         TEXT FK → accounts
  strategy_id        TEXT FK → strategies
  config_version_id  TEXT FK → config_versions   -- policy version active at trade time
  strategy_version_id TEXT FK → config_versions  -- strategy version active at trade time
  ts                 TIMESTAMPTZ
  symbol TEXT, dir TEXT, setup TEXT, session TEXT, emotion TEXT, adherence TEXT
  entry NUMERIC, exit NUMERIC, size NUMERIC
  risk NUMERIC, pnl NUMERIC, r NUMERIC          -- r derived: pnl/risk, recomputed on edit
  stop NUMERIC NULL, tp NUMERIC NULL
  note TEXT, reviewed BOOLEAN DEFAULT false
  adherence_result TEXT, block_reason TEXT      -- PASS|VIOLATION|BLOCK, frozen at evaluation
  evidence JSONB DEFAULT '[]'                   -- [{kind:'screenshot', url:'…'}]
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
  -- Derived fields (hour, dow, assetClass, holdMin, postLoss, delayMin):
  -- keep as GENERATED/computed columns OR compute in the service layer
  -- (deterministic from ts/symbol/prev trade)
  -- Indexes: (account_id, ts DESC), (symbol), (setup), (session), (strategy_id)
```

### Audit + derived-by-products

```sql
trade_evaluations            -- append-only: what each rule said, at trade time
  id UUID PK, trade_id FK, account_id FK
  rule_id TEXT FK → config_versions   -- the rule-set version that ran
  rule_key TEXT, rule_label TEXT, rule_version TEXT
  category TEXT, severity TEXT
  expected TEXT, actual TEXT, state TEXT   -- PASS | FAIL | SKIP
  explanation TEXT, evaluated_at TIMESTAMPTZ

violations                   -- discipline events (hard-rule FAILs)
  id UUID PK, trade_id FK, account_id FK
  rule_key, rule_label, rule_version, severity, expected, actual, explanation
  pnl NUMERIC, r NUMERIC
  review_state TEXT DEFAULT 'open'   -- open | acknowledged | resolved
  ts TIMESTAMPTZ, created_at TIMESTAMPTZ

reviews                      -- completion records only; the CONTENT is derived
  id UUID PK, account_id FK, period TEXT, date DATE, note TEXT, completed_at TIMESTAMPTZ

audit_log                    -- append-only, written inside the same transaction as the change
  id UUID PK, actor_id UUID NULL FK → users
  entity_type TEXT, entity_id TEXT, action TEXT   -- created|edited|version-bumped|deleted|…
  detail TEXT, old_value JSONB, new_value JSONB
  version_id TEXT NULL       -- link to config_versions when a version was created
  created_at TIMESTAMPTZ

tags / trade_tags            -- tags + junction (TAG_ARCHIVED = soft delete via archived_at)
```

### Optional read-model (only past ~50k trades)

```sql
daily_snapshots              -- (account_id, day) → pnl, trades, wins, risk_used,
  -- violations, discipline_score. Refreshed after mutations. NEVER the source
  -- of truth — a rebuild-from-ledger job is the healing mechanism.
```

**Schema notes**

- JSONB on `config_versions.values` is deliberate — it keeps one append-only table for policies, strategies, *and* rule sets, exactly like the `cv()` helper does today. Index only the fields you filter on (entity_type, entity_id, created_at).
- `current_equity` has no authoritative column. The DB equivalent is a cache column updated in the same transaction as the trade write, with a rebuild function for safety.
- `Trades` already carry `config_version_id` + `strategy_version_id` — that's the whole versioning guarantee. The schema just makes them FKs.

---

## 2. API Endpoints

Auth: `Authorization: Bearer <jwt>`, every query scoped to the authenticated `user_id`. Consistent errors: `{ error: { code, message, field? } }`. All trade/analytics/calendar reads take `?accountId=` (account switching = one query param; "instantly filter all data" falls out of this).

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create user |
| POST | `/api/auth/login` | Issue JWT |
| POST | `/api/auth/refresh` | Rotate token |
| POST | `/api/auth/logout` | Revoke |

### Accounts
| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/accounts` | List (with derived equity) / create |
| GET / PATCH / DELETE | `/api/accounts/:id` | Read / edit identity / archive |
| POST | `/api/accounts/:id/limits` | **New immutable RiskPolicy version** + re-point assignments |
| POST | `/api/accounts/:id/status` | Activate / archive |
| POST | `/api/accounts/:id/duplicate` | Duplicate + fresh policy |
| GET / POST | `/api/accounts/:id/strategies` | List assigned / assign a strategy |
| PUT | `/api/accounts/:id/selection` | Persist selected account (navbar requirement) |

### Strategies & Rules
| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/strategies` | List / create (v1.0) |
| GET / PATCH | `/api/strategies/:id` | Read / **edit → bumps version** |
| GET | `/api/strategies/:id/versions` | Full version chain (Strategy Lab history) |
| POST | `/api/strategies/:id/duplicate` | Duplicate with fresh version |
| POST | `/api/strategies/:id/status` | Activate / deactivate |
| GET | `/api/rule-sets` | List rule sets |
| GET | `/api/rule-sets/:id/versions` | Version chain |
| POST | `/api/rule-sets/:id/rules` | Add rule → new version |
| PATCH | `/api/rule-sets/:id/rules/:key` | Edit rule → new version |
| POST | `/api/rule-sets/toggle` | Toggle rule → new version |
| GET | `/api/rules/effective?accountId=&strategyId=&asOf=` | **Resolve the active rule set as-of a date** — one call the rule engine uses everywhere |

### Trades (the 7-step pipeline)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/trades` | Filtered list (accountId, symbol, setup, session, direction, result, search, from, to) |
| POST | `/api/trades` | `logTradePipeline`: resolve context → load policy → **evaluate rules** → persist + evaluations + violations → update equity → publish event. Idempotent via client id. |
| GET | `/api/trades/:id` | Trade + its evaluations + violations |
| PATCH | `/api/trades/:id` | **Edit → full dependency recalc** (R, daily risk, discipline, audit) |
| DELETE | `/api/trades/:id` | **Delete → reverse all derived effects**; audit record stays |
| GET | `/api/trades/:id/evaluations` | Evaluation history |

### Risk / Discipline
| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/pre-trade-check` | Deterministic pre-trade decision (rule engine + budget math) |
| GET | `/api/risk?accountId=` | **One risk snapshot** — used by Dashboard, Risk AND Discipline. Never three calculations. |
| GET | `/api/risk/events` | Limit-breach / high-risk feed |
| GET | `/api/risk/history?from=&to=` | Daily risk/loss/drawdown history (for charts) |
| GET | `/api/discipline?accountId=&from=&to=` | Score, dimensions, strongest/weakest, streaks |
| GET | `/api/discipline/violations` | Violation feed |
| PATCH | `/api/discipline/violations/:id` | Acknowledge / resolve |

### Analytics / Insights / Calendar / Reviews (all derived, all from the same core)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/analytics?accountId=&symbol=&setup=&session=&direction=&result=&emotion=&from=&to=` | **One endpoint returns the whole computed object** (net P&L, PF, expectancy, curve, byStrategy/Symbol/Session/Direction, risk buckets, streaks). Tab switching is client-side. |
| GET | `/api/insights?accountId=` | Evidence-backed findings (same analytics dataset; empty below 10 trades) |
| GET | `/api/calendar?accountId=&year=&month=` | Daily read model + month totals (derived) |
| GET | `/api/reviews?period=daily\|weekly\|monthly` | Derived reviews |
| POST | `/api/reviews/complete` | Record completion + audit |

### Tags / Meta / Audit
| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/tags` | List / create |
| PATCH | `/api/tags/:id` | Archive (historical trades keep the tag) |
| POST | `/api/trades/:id/tags` | Attach / detach |
| GET | `/api/audit?entityType=&entityId=` | Read-only history |
| GET | `/api/health` | Liveness |
| GET | `/api/state` · POST `/api/reset` · POST `/api/seed` | Dev-only |

> Already built in `server.js` and just needing a DB port: trades list + create + PATCH + DELETE, pre-trade check, risk, discipline, analytics, insights, calendar, reviews, accounts CRUD + limits/status/duplicate, strategies CRUD + duplicate, rule-set toggle/add/edit, audit, reset/seed. Missing: auth, GET-by-id for accounts/strategies, tags, rule version chains, risk history, `daily_snapshots`.

---

## 3. Backend Logic Structure

```
src/
  server.js             → boot, static serving, wiring
  routes/               → HTTP mapping only: auth, validation, param parsing
    auth.js  accounts.js  strategies.js  ruleSets.js  trades.js
    risk.js  discipline.js  analytics.js  insights.js  calendar.js  reviews.js  audit.js
  controllers/          → thin: validate → call service → serialize (fold into routes if preferred)
  services/             ← THE CALCULATION CORE — mirrors core.js exactly
    configService.js    → ConfigAPI: version bumps, assignments, immutable inserts
    ruleEngine.js       → evaluateRules() + RULE_EVALUATORS map (one fn per rule key)
    tradeService.js     → the 7-step pipeline + edit/delete with full recalc
    riskService.js      → riskState(), preTradeCheck()
    disciplineService.js→ disciplineState()
    analyticsService.js → computeAnalytics()  ← the ONLY analytics implementation
    calendarService.js  → calendarMonth()
    insightService.js   → insights()
    reviewService.js    → daily/weekly/monthly reviews
  repositories/         → SQL per table (accounts, configVersions, trades, evaluations,
                          violations, audit, tags). Services never touch SQL directly.
  events/
    bus.js              → EventBus (same semantics as TradeMindBus)
    outbox.js           → transactional event publication
    handlers.js         → recalc triggers
  db/
    migrations/         → one file per schema change, versioned
```

### The rules that make it work

1. **Services are the only place calculations exist.** `analyticsService.computeAnalytics` is imported by the analytics endpoint, the insights endpoint, the calendar endpoint, and the dashboard bootstrap — never re-implemented. This is the single most important decision in the whole build.

2. **All trade mutations run in ONE transaction:**
   ```
   BEGIN
     INSERT/UPDATE/DELETE trade
     DELETE + INSERT trade_evaluations (re-evaluate against the SAME version ids)
     INSERT violations for hard FAILs
     UPDATE accounts.current_equity (cache column)          -- affected account only
     INSERT audit_log
     Write events to outbox → published after COMMIT
   COMMIT
   ```
   Edit and delete recalc exactly what `TradeService.update/remove` already do — the DB transaction just makes it atomic.

3. **Recalculation strategy (targeted, not full-db):**
   - `trade.created/updated/deleted` → recompute that account's equity + that trade's evaluations + refresh `daily_snapshots` rows for the affected days. Nothing else is recomputed on write.
   - Analytics, insights, calendar, risk, discipline → computed **on read** from the ledger (single-user journals are tiny; snapshots only become necessary past ~50k trades).
   - `config.version.created` → never touches historical trades. Only new evaluations pick up the new version (`configVersionActiveAt` handles this by construction).

4. **Event bus with an outbox.** Keep the exact event names the frontend already publishes. Handlers that must be consistent (equity, evaluations, snapshots) run inside the transaction; anything slow (notifications, exports) consumes the outbox async. Same vocabulary on both sides = the browser's `connectBackend()`/`syncToBackend()` seam keeps working.

5. **Idempotent writes.** The client already generates ids (`txn-…`, `acc-…`). `POST /api/trades` with a client id is naturally idempotent — return 200 with the existing trade on conflict instead of 500. This also fixes double-submit of the Save Trade button for free.

6. **Audit is a write-path concern, not a feature.** Every mutation inserts an `audit_log` row in the same transaction, capturing `old_value`/`new_value` and the new `version_id`. Never update or delete audit rows.

7. **Shared core package.** Move the services into a single module (e.g. `src/core/`) that BOTH the server and the browser import (via a bundler build of `core.js`). The exact same `computeAnalytics`/`riskState`/`evaluateRules` code runs in Node and in the browser — that guarantees "the same $10 remaining appears everywhere" today *and* after the backend exists. Server-side, the repositories replace the in-memory arrays; the service signatures don't change.

8. **Choice of stack.** Node (keep zero-dependency or move to Express/Fastify) + PostgreSQL (JSONB for `config_versions.values`, `NUMERIC` for money, native `TIMESTAMPTZ`). For a single-user local install, SQLite is a drop-in alternative since the schema is portable — ship local-first with SQLite, use Postgres for the hosted version.

9. **Security.** JWT (httpOnly cookie or bearer), bcrypt/argon2 password hashing, and a `user_id` check on *every* query — accounts/strategies/trades are all scoped through the authenticated user. Rate-limit auth endpoints.

---

## Migration path from the current implementation

1. Freeze the current `core.js` services as `src/core/` (shared, no DOM/localStorage dependencies).
2. Write the Postgres schema + migrations (tables above).
3. Port `server.js`'s endpoints from "wrapper over in-memory Core" to "wrapper over repositories", keeping the same paths — the frontend's `syncToBackend()` already targets them.
4. Add auth + tags + version chains + risk history (the gaps listed in section 2).
5. Flip `connectBackend()` on in `core.js`; the browser keeps its local store as cache/offline and replays mutations.

The acceptance test maps directly onto this design: steps 1–6 are `configService` writes (each creating a version), 7–9 are `tradeService` + `riskService`, 10–15 are read endpoints over the shared services, 16–19 are `TradeService.update/remove` inside the transaction, and 20–22 are guaranteed by the append-only `config_versions` + frozen version ids on trades.
