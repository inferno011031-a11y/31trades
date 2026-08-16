# 02 — DATABASE SCHEMA

> Extracted from `db/migrations/001–011` and `server/pg-repo.js`. All tables are PostgreSQL on Supabase. Composite per-user keys are used for user-owned entities (migrations 004–007). Money is `NUMERIC(14,2)`, prices `NUMERIC(14,5)`.

---

## 2.1 Table inventory

| Table | Migration | Kind | Persisted by repo? |
|---|---|---|---|
| `users` | 001 | identity | FK mirror only (rows upserted on save) |
| `user_preferences` | 001 | user prefs | **NO** (defined, not used by pg-repo or any service — UNUSED) |
| `accounts` | 001 | canonical | yes |
| `config_versions` | 001 | canonical (immutable version table) | yes |
| `strategies` | 001 | canonical | yes |
| `rule_sets` | 001 | canonical | yes |
| `assignments` | 001 | canonical | yes |
| `trades` | 001 | canonical | yes |
| `trade_evaluations` | 001 | canonical (append-only audit) | yes |
| `violations` | 001 | canonical | yes |
| `reviews` | 001 | completion records | **NO** (completion only logged to event log; content derived) |
| `audit_log` | 001 | canonical (append-only) | yes (event log maps in) |
| `tags` | 001 | identity | **NO** |
| `trade_tags` | 001 | join | **NO** |
| `daily_snapshots` | 001 | optional read model | **NO** (never used in code) |
| `ai_findings` | 008 | side table (AI service) | no (service-direct) |
| `notifications_read` | 009 | side table (notifications service) | no (service-direct) |
| `broker_connections` | 010 | side table (brokers service) | no (service-direct) |
| `user_prefs` | 011 | side table (prefs service) | no (service-direct) |

`pg-repo.js` round-trips exactly **9 canonical tables**: accounts, config_versions, strategies, rule_sets, assignments, trades, trade_evaluations, violations, audit_log.

> ⚠️ Tables defined but **never read or written by any code**: `user_preferences`, `tags`, `trade_tags`, `daily_snapshots`. `reviews` rows are never written (only the event log records a completed review).

---

## 2.2 Entity-by-entity

### users
Mirror of `auth.users` (GoTrue). Needed for FK integrity. Password is a placeholder (`'!'`); the real password lives in GoTrue.
| field | type | notes |
|---|---|---|
| id | UUID PK | default `gen_random_uuid()`; anonymous placeholder `00000000-0000-0000-0000-000000000000` |
| email | TEXT UNIQUE | |
| password_hash | TEXT NOT NULL | placeholder only |
| display_name | TEXT | |
| timezone | TEXT | default `'UTC'` — never set by app code |
| created_at | TIMESTAMPTZ | |

### user_preferences
| field | type | notes |
|---|---|---|
| user_id | UUID PK FK→users | |
| selected_account_id | TEXT | "account selection persists across screens" — **never written by code** |
| saved_views | JSONB `[]` | journal saved views — **never written by code** |

### accounts
Identity only; risk limits live in `config_versions` as RiskPolicy.
| field | type | notes |
|---|---|---|
| id | TEXT PK (composite with user_id) | frontend-generated `'acc-…'` |
| user_id | UUID FK→users | part of composite PK |
| name | TEXT NOT NULL | |
| account_type | TEXT | 'Prop / Funded' \| 'Personal' \| 'Broker' |
| currency | TEXT default 'USD' | |
| starting_balance | NUMERIC(14,2) | |
| style | TEXT | 'Intraday', … |
| status | TEXT default 'Active' | Active \| Paused \| Archived |
| note | TEXT | |
| current_equity | NUMERIC(14,2) | **CACHE ONLY** — derived from starting_balance + Σ pnl |
| created_at / archived_at | TIMESTAMPTZ | |

### config_versions — the immutable version table (one table for ALL configuration)
Every config change inserts a new row (append-only); rows are never updated/deleted.
| field | type | notes |
|---|---|---|
| id | TEXT PK (composite) | `'cv_…'` |
| user_id | UUID FK→users | |
| entity_type | TEXT CHECK | **RiskPolicy \| Strategy \| RuleSet** |
| entity_id | TEXT | account id / strategy id / rule_set id |
| version | TEXT | 'v1.0', 'v1.1', … (UNIQUE with user+entity) |
| created_at | TIMESTAMPTZ | = "effective from" timestamp |
| values | JSONB | `{maxDailyLoss, riskPerTrade, rules:[…], sessions:[…], …}` |
| note | TEXT | |

RiskPolicy `values` shape (from seed + provisioning):
```
{ ddModel: 'trailing'|'static', maxDailyLoss, maxTotalDrawdown,
  riskPerTrade, riskBasis: 'money', maxOpenRisk, openBasis: 'money',
  maxTrades, warn: [50, 70, 90] }
```
Strategy `values` shape:
```
{ name, markets, sessions: [], setup, risk: { riskPerTrade, minRR, stopRequired, maxPositions },
  entry, exit, behavior: [], evidence: [], tags: [] }
```
RuleSet `values` shape:
```
{ rules: [ { key, cat, label, op: '≤'|'≥'|'=', threshold, unit, severity: 'Hard'|'Soft', enabled } ] }
```
Rule keys seen in code: `riskPerTrade, dailyRisk, dailyLoss, maxTrades, maxOpenRisk, cooldown, stopRequired, minRR, noRevenge, noFomo, noAddLoser, allowedSessions, approvedSetups, earlyExit, movingStop, screenshot, preTradeNote, endOfDayReview`.

SQL function `config_version_active_at(entity_type, entity_id, as_of)` resolves the active version (mirrors `configVersionActiveAt()` in core).

### strategies (StrategyMaster)
| field | type | notes |
|---|---|---|
| id | TEXT PK (composite) | `'strat-…'` |
| user_id | UUID | |
| name | TEXT NOT NULL | |
| description | TEXT | `'desc'` reserved word → column `description`, core maps to `.desc` |
| color | TEXT | |
| status | TEXT default 'Active' | |

### rule_sets (RuleSetMaster)
| field | type | notes |
|---|---|---|
| id | TEXT PK (composite) | `'rs-…'` |
| user_id | UUID | |
| name | TEXT NOT NULL | |
| scope | TEXT default 'Global' | 'Accounts' \| 'Strategies' \| 'Global' |

Standard seeded rule sets: `rs-core` (Core Risk Set, Accounts), `rs-exec` (Execution Discipline, Strategies), `rs-evidence` (Evidence & Review, Global).

### assignments (StrategyAssignments) — account ↔ strategy ↔ immutable policy version
| field | type | notes |
|---|---|---|
| id | TEXT PK (composite) | `'asgn-…'` |
| user_id | UUID | |
| account_id | TEXT FK→accounts (composite) | |
| strategy_id | TEXT FK→strategies (composite) | |
| policy_version_id | TEXT FK→config_versions | nullable after 002 (strategy may exist before a policy) |
| strategy_version_id | TEXT FK→config_versions | |
| active_from | TIMESTAMPTZ | append-only on re-point |

### trades — canonical, immutable evidence
| field | type | notes |
|---|---|---|
| id | TEXT PK (composite) | frontend-generated `'txn-…'` → idempotent POSTs |
| user_id | UUID FK→users | |
| account_id | TEXT FK→accounts | |
| strategy_id | TEXT FK→strategies (ON DELETE RESTRICT) | |
| config_version_id | TEXT FK→config_versions | policy version active at trade time (frozen) |
| strategy_version_id | TEXT FK→config_versions | strategy version at trade time (frozen) |
| ts | TIMESTAMPTZ | trade time |
| symbol | TEXT | |
| dir | TEXT CHECK in ('Long','Short') | |
| setup | TEXT | |
| session | TEXT | |
| emotion | TEXT | (e.g. Calm/Confident/Anxious/Revenge/FOMO) |
| adherence | TEXT | ('followed', 'early exit', 'moving stop', 'no-plan', …) |
| entry / exit | NUMERIC(14,5) | |
| size | NUMERIC(14,2) | |
| risk | NUMERIC(14,2) | planned/actual risk $ |
| pnl | NUMERIC(14,2) | |
| r | NUMERIC(10,2) | derived: pnl / risk |
| stop / tp | NUMERIC(14,5) | |
| note | TEXT | |
| reviewed | BOOLEAN default false | |
| adherence_result | TEXT CHECK in ('PASS','VIOLATION','BLOCK') | |
| block_reason | TEXT | |
| evidence | JSONB `[]` | `[{kind:'screenshot', url:'…'}]` |
| created_at / updated_at | TIMESTAMPTZ | updated_at kept honest by trigger `trg_trades_touch_updated_at` |

Derived (NOT stored): hour, dow, assetClass, timeframe, holdMin, postLoss, delayMin — computed in the service layer on every hydrate/edit.

### trade_evaluations — per-rule result per trade (append-only audit)
| field | type | notes |
|---|---|---|
| id | UUID PK | |
| trade_id / account_id / user_id | FKs | |
| rule_id | TEXT FK→config_versions | the rule-set version that ran |
| rule_key, rule_label, rule_version | TEXT | |
| category | TEXT | Risk / Frequency / Behavior / Execution / Evidence / Review / Custom |
| severity | TEXT CHECK ('Hard','Soft') | |
| expected, actual | TEXT | |
| state | TEXT CHECK ('PASS','FAIL','SKIP') | |
| explanation | TEXT | |
| evaluated_at | TIMESTAMPTZ | |

### violations — discipline events (hard-rule FAILs)
| field | type | notes |
|---|---|---|
| id | UUID PK | |
| trade_id / account_id / user_id | FKs | |
| rule_key, rule_label, rule_version, severity, expected, actual, explanation | TEXT | |
| pnl, r | NUMERIC | |
| review_state | TEXT default 'open' | CHECK ('open','acknowledged','resolved') |
| ts | TIMESTAMPTZ | trade time |
| created_at | TIMESTAMPTZ | |

### reviews — completion records only (content is derived)
| field | type | notes |
|---|---|---|
| id | UUID PK | |
| user_id, account_id | FKs | |
| period | TEXT CHECK ('daily','weekly','monthly') | |
| date | DATE | |
| note | TEXT | |
| completed_at | TIMESTAMPTZ | |
| UNIQUE (user_id, account_id, period, date) | | |

### audit_log — append-only
| field | type | notes |
|---|---|---|
| id | UUID PK | |
| actor_id | UUID FK→users (SET NULL) | |
| user_id | UUID | |
| entity_type, entity_id | TEXT | |
| action | TEXT | created \| edited \| version-bumped \| deleted \| … |
| detail | TEXT | |
| old_value, new_value | JSONB | |
| version_id | TEXT FK→config_versions | set when a version was created |
| created_at | TIMESTAMPTZ | |

### tags / trade_tags
Defined but **never used by code**:
- `tags`: id TEXT PK `'tag-…'`, name TEXT UNIQUE, archived_at TIMESTAMPTZ (soft delete).
- `trade_tags`: (trade_id, tag_id) PK, plus user_id added in 007.

### daily_snapshots — optional read model
PK (user_id, account_id, day); pnl/trades/wins/losses/risk_used/violations/discipline_score. **Never used by code** — comment says only needed past ~50k trades.

### ai_findings (008) — AI Mentor cache
| field | type | notes |
|---|---|---|
| user_id | UUID | PK part |
| finding_id | TEXT | PK part — stable id `ai-<type>-<count>-<firstEvidenceId>` |
| finding_type, severity, title, message | TEXT | |
| evidence | JSONB `[]` | trade ids |
| cost | NUMERIC | |
| confidence | TEXT | low/medium/high |
| suppressed | BOOLEAN default false | dismiss |
| feedback | INTEGER | 1 / -1 / null |
| first_seen, updated_at | TIMESTAMPTZ | |

### notifications_read (009)
PK (user_id, notification_id); `read_at` TIMESTAMPTZ. Notification ids are stable keys (`'risk-limit'`, `'viol-<tradeId>-<ruleKey>'`, `'onb-account'`, …).

### broker_connections (010)
PK (user_id, broker); `status` TEXT default 'active'; `connected_at` TIMESTAMPTZ. `disconnect` sets status='inactive' (row kept).

### user_prefs (011)
PK (user_id); `theme` TEXT default 'dark' (CHECK enforced in app: dark|light|system); `updated_at` TIMESTAMPTZ.

---

## 2.3 Relationships (simplified)

```
users 1─∞ accounts 1─∞ trades 1─∞ trade_evaluations / violations
        │           1─∞ assignments ∞─1 strategies
        │           1─∞ reviews
config_versions (entity_type, entity_id) ← frozen references from:
        trades.config_version_id / strategy_version_id
        assignments.policy_version_id / strategy_version_id
        trade_evaluations.rule_id
        audit_log.version_id
rule_sets (user-scoped, no FK references into it)
```

Key design invariants (from migration comments):
1. `config_versions` is **append-only**; trades carry the exact immutable version ids active at trade time → historical evaluations frozen forever.
2. `accounts.current_equity` is a cache, refreshed inside the trade transaction; a rebuild-from-ledger job is the healing mechanism.
3. `audit_log` is append-only.
4. Derived fields (hour, dow, assetClass, holdMin, postLoss, delayMin) are computed in the service layer, not stored.

## 2.4 Local runtime data (files, not DB)
- `data/db-<userId>.json` — canonical snapshot mirror (same 9-table shape).
- `data/backtest-<userId>.json` — practice sessions (BacktestSession.serialize()).
- `data/battle-<hostId>.json` + `battle-registry.json` + `battle-invites-<userId>.json` — battles.
- `data/ai-<userId>.json`, `notif-<userId>.json`, `brokers-<userId>.json`, `prefs-<userId>.json` — side-table mirrors.
- `data/chat-<userId>-<accountId>.json` — bot conversation memory.
- `data/ecocal-<day>.json`, `data/tv-candles-…`, `data/tv-fail-…` — caches.
- `data/user-directory.json` — email → userId map (battle invites).
