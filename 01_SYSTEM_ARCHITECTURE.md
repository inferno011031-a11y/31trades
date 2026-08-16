# 01 — SYSTEM ARCHITECTURE

> Technical extraction from the existing codebase. The product implemented in this repo is **31Trades** (the working title "BattlexJournal" does not appear anywhere in the code). Everything below is literal — what the code actually does. Anything not found is marked **UNKNOWN — NOT FOUND IN IMPLEMENTATION**.

---

## 1.1 Frameworks / Languages

| Layer | Technology | Evidence |
|---|---|---|
| Backend | Plain **Node.js** HTTP server, CommonJS, **zero runtime dependencies beyond 4 npm packages** | `server.js`, `package.json` (`"type": "commonjs"`) |
| Frontend | **Static multi-page HTML** (16+ standalone `.html` pages), vanilla JS inline, **Tailwind CSS via CDN** (`https://cdn.tailwindcss.com`), **Lucide icons** via CDN (`unpkg.com/lucide`), custom tokens (`assets/tokens.css`, `assets/tailwind-config.js`) | every page's `<head>` |
| Shared logic | **UMD factory** `src/core/index.js` (`createTradeMindCore`) runs **identically in browser and Node** — single source of truth for data model + all calculation engines | header comment, `module.exports` + `window.createTradeMindCore` |
| Charts | **TradingView Lightweight Charts** (bundled locally: `assets/lightweight-charts.js`) | backtesting.html, replay-mode.js, battle-mode.js |
| Tests | Node test scripts per module (no framework), run via `npm test` | `package.json` scripts, `server/*.test.js` |

npm dependencies (complete): `@mathieuc/tradingview` (^3.5.2), `motion-sv` (^0.1.13), `pg` (^8.23.0), `ws` (^8.21.3).

## 1.2 Backend Architecture

```
Browser (static .html pages)
   │  Bearer JWT (Supabase GoTrue session, server-proxied)
   ▼
server.js  (single zero-dependency HTTP server, port process.env.PORT || 8080, binds 0.0.0.0)
   ├── /api/*  → handleApi(): thin stateless REST wrappers
   ├── /ws     → BattleWs.attach(): WebSocket hub (battle cursor/status + dashboard feed ping)
   └── static  → serves the .html pages from project root
        │
        ├── per-user core instances  (cores Map: userId → { core, serialize, scheduleSave, flush })
        │      └── src/core/index.js  (createCore factory, hydrated per user)
        │             ├── canonical tables: Accounts, ConfigVersions, StrategyAssignments,
        │             │   Trades, StrategyMaster, RuleSetMaster, TradeEvaluations, Violations, EVENT_LOG
        │             ├── ConfigAPI (accounts/strategies/rule-sets/versions, immutable version bumps)
        │             ├── Rule Engine (RULE_EVALUATORS, BLOCKING_KEYS)
        │             ├── Risk / Discipline / Analytics / Calendar / Insights / Reviews services
        │             ├── Asset Spec Engine (ASSET_SPECS: pip/val/unit per asset class)
        │             └── EventBus (trade.created, config.changed, account.changed, review.completed…)
        │
        └── service modules (server/*.js):
              auth.js        — Supabase GoTrue proxy (signup/login/verify/logout/oauth/password)
              pg-repo.js     — Postgres repository (snapshot load/save per user)
              db.js          — pg Pool (lazy, graceful degradation)
              ai-mentor.js   — AI Mentor engine (patterns/psych/risk/discipline/session/tilt) + ai_findings cache
              ai-bot.js      — grounded Q&A bot with conversation memory
              ai-coach.js    — AI Backtest Coach (reviews a finished practice session)
              llm.js         — Google Gemini narration layer with numeric grounding guard
              ecocal.js      — Economic calendar (FMP key → ForexFactory mirror, cached per day)
              marketdata.js  — TradingView historical candles (cache → TV WS → synthetic fallback)
              backtest.js    — deterministic synthetic candle generator (regime-aware random walk)
              backtest-sim.js— Backtest Simulation Engine (replay cursor, SL/TP fills, sizing, results)
              replay.js      — Market Replay sessions (local timer mode + optional live TV replay mode)
              practice.js    — Practice data adapter (flattens backtest trades into canonical analytics)
              battle.js      — Online Battle engine (one timeline, private seats, scoring, invites)
              battle-ws.js   — WebSocket hub for battles + dashboard feed
              notifications.js — derived notification feed + read-state persistence
              brokers.js     — broker connection registry (onboarding checklist state)
              prefs.js       — per-user preferences (theme light/dark/system)
              env.js         — .env loader
```

### Persistence chain (server)
1. **Primary:** Supabase Postgres (`SUPABASE_DB_URL`, pg Pool, max 5 conns) — snapshot write per user in **one transaction** (DELETE user's rows in FK-safe order, then INSERT). Load filters by `user_id`.
2. **Fallback mirror:** per-user JSON file `data/db-<userId>.json` (atomic tmp+rename). Every write goes to Postgres first, then the file mirror.
3. **Boot probe:** `db.ping()` at startup; `/api/health` reports `storage: "supabase-postgres" | "db.json"`, `auth: "supabase-gotrue" | "off"`.

### Persistence chain (browser)
- localStorage keyed per user: `31trades.state.v1.<userId>` (anon: `31trades.state.v1`). Session: `31trades.session.v1`.
- `connectBackend()` flips ON the backend mirror: on boot the browser POSTs its full canonical state to `/api/state` (adopt), then every mutation replays to the API in order (`_syncChain`). Retry every 30s while offline. Status broadcast as `backend.online` / `backend.offline` events.
- Auth gate: `TRADEMIND_AUTH=off` → anonymous mode (single `LOCAL_USER_ID = 00000000-0000-0000-0000-000000000000` partition). Otherwise no session → redirect to `auth.html`. Browser bypass: `window.__TRADEMIND_AUTH_BYPASS__` or `sessionStorage['31trades.auth.bypass']==='1'`.

## 1.3 Database Technology
- **PostgreSQL 15** via Supabase (pooler connection string), `pg` package, SSL `rejectUnauthorized:false`.
- 11 migrations in `db/migrations/` (001–011); migration runner `db/migrate.js` (`npm run db:migrate`).
- Repository is a **snapshot writer**: `save()` rewrites a user's whole slice; there is no row-level incremental layer yet.
- Side tables (`ai_findings`, `notifications_read`, `broker_connections`, `user_prefs`) are written directly by their services with **file-mirror fallback** when Postgres is down.
- Derived state (equity, discipline score, analytics) is **computed, never stored** (except cached `accounts.current_equity`, refreshed inside the trade transaction).

## 1.4 Authentication System
- **Supabase GoTrue**, proxied exclusively server-side (`server/auth.js`). The browser never talks to Supabase directly; the anon key stays in `.env`/env.
- Endpoints (all via our server): signup, login (password grant), logout, `/auth/v1/user` verify (cached 60s, bounded at 500 tokens), Google OAuth (authorize URL handed to the client, callback lands on `auth.html#access_token=…`), password recovery (`/auth/v1/recover`), reset password (`PUT /auth/v1/user` with recovery token), change password (re-auth + update).
- Token errors on `/auth/v1/user` and `/auth/v1/logout` are normalized to **401** (client treats as session-expired → auth.html).
- `public.users` row is a lightweight FK mirror of `auth.users`; password stays in GoTrue (`'!'` placeholder in the mirror). Local placeholder user `local@31trades.local` for pre-auth/anonymous data.
- No refresh-token rotation logic in-app (GoTrue handles it; the client stores whatever session it's given).

## 1.5 Storage / File Systems
- `data/` (gitignored) holds: per-user canonical mirrors `db-<userId>.json`, backtest sessions `backtest-<userId>.json`, battles `battle-<hostId>.json` + `battle-registry.json` + `battle-invites-<userId>.json`, broker state `brokers-<userId>.json`, AI prefs `ai-<userId>.json`, chat memory `chat-<userId>-<accountId>.json`, notification read state `notif-<userId>.json`, prefs `prefs-<userId>.json`, econ calendar cache `ecocal-<day>.json`, TradingView candle cache `tv-candles-<sym>-<tf>-<count>.json` + failure latch `tv-fail-…`, user directory `user-directory.json` (email→id for invites).
- Browser: localStorage for canonical state, theme, chat transcript, chart workspaces (`31trades.ws.v1.<user>.<session>.<tf>`), battle seat id, replay dataset cache (in-memory only).

## 1.6 APIs
- REST over the same HTTP server (all routes listed in **03_API_REFERENCE.md**). Body cap 2 MB. Errors are JSON `{error}` with 400/401/403/404/410/500.
- `Cache-Control: no-store` on JSON responses; static pages served with `no-cache`.
- WebSocket `/ws` (see 1.8).

## 1.7 External Services
| Service | Purpose | Env keys | Failure mode |
|---|---|---|---|
| Supabase (GoTrue + Postgres) | Auth + canonical storage | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL` | falls back to file mode; auth errors → 401 |
| TradingView (`@mathieuc/tradingview`) | Historical OHLCV candles + true replay mode | `TRADEMIND_TV_SESSION`, `TRADEMIND_TV_SIGNATURE` (live replay), `TRADEMIND_TV=off` to disable | 6h disk cache → 5-min failure latch → synthetic generator |
| Economic calendar | FMP `economic_calendar` (needs `ECON_CALENDAR_KEY`/`FMP_API_KEY`) then keyless ForexFactory mirror `nfs.faireconomy.media/ff_calendar_thisweek.json` | `ECON_CALENDAR_KEY` or `FMP_API_KEY` | per-day cache (15 min TTL); honest `ok:false` — **never fabricated events** |
| Google Gemini | Narration of already-grounded AI answers (Interactions API `v1beta/interactions`, model `gemini-3.6-flash` default) | `GEMINI_API_KEY`, `GEMINI_MODEL` | degrades to null → deterministic answer used; grounding guard discards any narration that alters a number |

## 1.8 Realtime Systems
- **WebSocket server** at `/ws` (`server/battle-ws.js`, `ws` package), attached to the same HTTP server.
  - Subscribe by `?battle=<id>` → room receives `battle.cursor` (cursor+status) and `battle.status` (full public state) pushes on every battle mutation.
  - No battle param → dashboard feed client → receives lightweight `feed.changed` ping on any battle mutation (re-fetch trigger).
  - Only public state is pushed; private seat decisions are fetched over authed REST.
- The battle engine emits via `Battle.subscribe/emit`; sim sessions use in-process `setInterval` timers (server-owned replay cursor).

## 1.9 Scheduled / Background Jobs
- **No external job scheduler.** All timers are in-process:
  - `scheduleSave` — 120 ms debounce per user core write.
  - `backfillEvaluations()` — runs once when a user core is first loaded (evaluation + violation audit for the whole ledger).
  - Sim `play()` — interval advancing the replay cursor, saving at most every 400 ms.
  - Battle `play()` — interval advancing the canonical cursor, saves each tick.
  - Replay idle sweep — every 60 s, closes sessions idle > 20 min.
  - `connectLoop` (browser) — retries backend connection every 30 s.
- Graceful shutdown: SIGINT/SIGTERM flush all user cores (4 s cap).

## 1.10 Payments / Subscriptions
**UNKNOWN — NOT FOUND IN IMPLEMENTATION.** No billing, subscription, credits, ads, or plan-gating code exists anywhere (see **08_REWARDS_SUBSCRIPTIONS.md**).

## 1.11 Notification System
- **In-app only** (derived feed + read state). No email/push sending from our server (Supabase Auth sends its own confirmation/recovery emails; battle invites use `mailto:` links). Full trigger list in **08_REWARDS_SUBSCRIPTIONS.md** §17 / 03 API.
- Read state persisted to `notifications_read` (Supabase) + `notif-<userId>.json` fallback, syncing across devices.

## 1.12 Third-Party Integrations (complete list)
1. Supabase Auth (GoTrue) — auth.
2. Supabase Postgres — storage.
3. TradingView charting data (via `@mathieuc/tradingview`) — market data + replay.
4. Financial Modeling Prep / ForexFactory mirror — economic calendar.
5. Google Gemini — AI narration.
6. Tailwind CSS + Lucide icons (CDN) — UI.
7. TradingView Lightweight Charts (vendored) — charts.
8. `motion-sv` dependency — **no usage found in code** (declared in package.json; UNKNOWN usage).

## 1.13 How the major systems connect (flow diagram)

```
Auth (GoTrue) ──JWT──▶ server.js ──▶ per-user core (src/core/index.js)
                                        │ canonical ledger (Trades/Accounts/Config…)
                                        ▼
                        ┌── Rule Engine (evaluateRules) ──▶ trade_evaluations / violations
                        ├── Risk (riskState/preTradeCheck) ──▶ risk notifications, pre-trade blocks
                        ├── Discipline (disciplineState) ────▶ score, dims, streaks
                        ├── Analytics (analytics/analyticsFrom) ─▶ dashboard/insights/calendar
                        ├── AI Mentor (ai-mentor) + Bot (ai-bot) + Gemini (llm) ─▶ ai.html
                        ├── Practice (practice) ──▶ backtest-sim ──▶ /api/practice/*
                        ├── Battle (battle) ──▶ backtest-sim seats ──▶ WS /ws pushes
                        └── Notifications (notifications) ──▶ /api/notifications
                                        │
                Persistence: Postgres (primary) ⇄ data/db-<user>.json (mirror)
                Browser: localStorage (offline cache) ⇄ adoptState() + mutation replay
```

**Key invariant:** every screen (Risk, Discipline, Analytics, Journal, Calendar, AI, Practice, Battle leaderboard) derives from the **same canonical ledger + the same calculation functions** — there is exactly one data source of truth per user, and one set of formulas.
