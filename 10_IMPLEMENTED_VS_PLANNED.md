# 10 — IMPLEMENTED VS PLANNED + FINAL INVENTORIES

> Classification key: **IMPLEMENTED** = working in code; **PARTIALLY IMPLEMENTED** = works but incomplete/limited; **PLACEHOLDER** = UI/structure exists, real behavior missing; **PLANNED / NOT IMPLEMENTED** = described but absent. Every claim is code-evidenced. Product name in code: **31Trades**.

---

## 10.1 Implemented vs Planned matrix

| Feature | Status | Evidence |
|---|---|---|
| **Core journaling** | | |
| Account management (create/edit/status/duplicate/limits) | IMPLEMENTED | ConfigAPI + /api/accounts* |
| Strategy management (create/edit/duplicate/versioning) | IMPLEMENTED | ConfigAPI + /api/strategies* |
| Rule sets (toggle/add/edit rules, versioned) | IMPLEMENTED | ConfigAPI + /api/rule-sets* |
| Log Trade (7-step rule pipeline) | IMPLEMENTED | logTradePipeline |
| Trade edit/delete with full recalculation | IMPLEMENTED | TradeService |
| Asset-class-aware P&L/sizing/units (FX/Indices/Crypto/Stocks/Commodities) | IMPLEMENTED | ASSET_SPECS |
| Trade screenshots/evidence | PARTIALLY IMPLEMENTED | evidence JSONB stored; **no upload endpoint** |
| Trade importing (broker/MT/TV/cTrader) | PLANNED / NOT IMPLEMENTED | only onboarding copy mentions it |
| Tags | PLACEHOLDER | schema exists; no service/UI |
| Daily snapshots read model | PLACEHOLDER | schema exists; never used |
| Saved journal views | PLACEHOLDER | user_preferences.saved_views; never used |
| **Risk engine** | | |
| Risk state (daily risk/loss, drawdown, limits, status bands) | IMPLEMENTED | riskState |
| Pre-trade check (block/violation/caution/clear) | IMPLEMENTED | preTradeCheck |
| Risk events feed (breach/high/loss) | IMPLEMENTED | RiskEvents |
| Risk notifications | IMPLEMENTED | notifications.js |
| **Discipline engine** | | |
| Discipline score (6 weighted dims) | IMPLEMENTED | disciplineState |
| Rule evaluations + violations ledger | IMPLEMENTED | evaluateRules/writeEvaluations |
| Clean-day streaks | IMPLEMENTED | disciplineState |
| Reviews (daily/weekly/monthly derived) | IMPLEMENTED | reviews service |
| **Analytics** | | |
| Full analytics (win rate, PF, expectancy, avgR, maxDD, equity, breakdowns, streaks, risk buckets) | IMPLEMENTED | computeAnalytics |
| Calendar month read model | IMPLEMENTED | calendarMonth |
| Insights (evidence-backed findings) | IMPLEMENTED | insights |
| Practice analytics/insights (BACKTEST source, isolated) | IMPLEMENTED | practice.js |
| **AI layer** | | |
| AI Mentor bundle (patterns/psych/risk/discipline/session/tilt) | IMPLEMENTED | ai-mentor.js |
| Trade autopsy | IMPLEMENTED | AI.autopsy |
| Personal bot (grounded Q&A, intents, memory) | IMPLEMENTED | ai-bot.js |
| AI Backtest Coach | IMPLEMENTED | ai-coach.js |
| Gemini narration with grounding guard | IMPLEMENTED (optional, key-gated) | llm.js |
| ai_findings cache (dismiss/feedback, dismissed view) | IMPLEMENTED | ai-mentor.js + 008 |
| **Backtesting / Replay** | | |
| Real TradingView historical candles + synthetic fallback | IMPLEMENTED | marketdata.js |
| Replay engine (hidden future, play/pause/step/seek/reset/speed) | IMPLEMENTED | backtest-sim.js |
| LONG/SHORT/SL/TP simulation, intrabar fills, audit trail | IMPLEMENTED | backtest-sim.js |
| Session persistence (file) | PARTIALLY IMPLEMENTED | per-user JSON; **no DB table** |
| Results (equity curve, R dist, breakdowns) | IMPLEMENTED | results() |
| Market Replay page (local + gated live TV replay) | IMPLEMENTED | replay.js |
| Chart workspaces per timeframe (drawings/indicators/state) | IMPLEMENTED | workspace.js (localStorage) |
| Spread/slippage/commission/partial exits/multi-position | PLANNED / NOT IMPLEMENTED | code comments say "later" |
| **Battles** | | |
| Battle create/join/invite/control/enter/close | IMPLEMENTED | battle.js |
| Canonical timeline + private seats + anti-cheat | IMPLEMENTED | battle.js |
| Blended scoring + team aggregation + leaderboard | IMPLEMENTED | scoreSeat |
| Dashboard live feed with own-seat P&L/rank | IMPLEMENTED | battlesFeed |
| WebSocket realtime (cursor/status/feed) | IMPLEMENTED | battle-ws.js |
| Battle replay with opponent reveal | PLANNED / NOT IMPLEMENTED | leaderboard shows trades post-hoc only |
| Squad chat / voice | PLANNED / NOT IMPLEMENTED | — |
| Matchmaking/ranked/1v1-10v10 formats | PLANNED / NOT IMPLEMENTED | free-form seats only |
| **Community / Social** | | |
| Community page (user id, battle feed, leaderboard) | PARTIALLY IMPLEMENTED | static page + battle APIs |
| Squads/teams (label + aggregation) | PARTIALLY IMPLEMENTED | battle `team` string only |
| Trader profiles, discovery, posts, messaging, voice, moderation, reputation, roles | PLANNED / NOT IMPLEMENTED | — |
| **Identity** | | |
| Auth (signup/login/logout/OAuth/recovery/change password) | IMPLEMENTED | auth.js |
| Unique user ID (copyable, for Discord/giveaways) | IMPLEMENTED | auth user id |
| Public/private profile fields | PLANNED / NOT IMPLEMENTED | — |
| **Leaderboards / Rewards / Subs** | | |
| Battle leaderboard (per-battle + feed) | IMPLEMENTED | scoreSeat/leaderboard |
| Global/user leaderboards, filters, rewards | PLANNED / NOT IMPLEMENTED | — |
| Credits/rewards/giveaways | PLANNED / NOT IMPLEMENTED | — |
| Subscriptions/free-plan gating/ads | PLANNED / NOT IMPLEMENTED | — |
| **Notifications** | | |
| Derived feed (onboarding/risk/discipline/reviews/system/market/battles) | IMPLEMENTED | notifications.js |
| Read-state sync across devices | IMPLEMENTED | notifications_read + 009 |
| Welcome message (event log + hero card + email template) | IMPLEMENTED | server.js logWelcomeEvent, docs/welcome-email-template.html |
| Email/push sending from server | PLANNED / NOT IMPLEMENTED | mailto only; Supabase handles auth emails |
| **Theming / UX** | | |
| Light/Dark/System theme, per-user sync | IMPLEMENTED | theme-toggle.js + prefs + 011 |
| First-run tour (sidebar highlight + Journal/Risk demo steps) | IMPLEMENTED | assets/tour.js |
| **Infra** | | |
| Supabase Postgres persistence (snapshot per user) | IMPLEMENTED | pg-repo.js |
| File fallback (offline/local-first) | IMPLEMENTED | data/*.json + localStorage |
| Railway-ready (PORT/0.0.0.0, crash-guard, boot diagnostics) | IMPLEMENTED | server.js |

---

## 10.2 A. Complete feature inventory (summary)
1. Multi-account journaling with per-account risk policies (versioned).
2. Versioned strategies + rule sets (append-only config_versions).
3. 7-step rule-evaluation Log Trade pipeline (PASS/VIOLATION/BLOCK).
4. Asset-spec engine (P&L/sizing/units per class).
5. Risk engine (daily risk/loss budgets, trailing/static drawdown, 4 status bands, pre-trade checks).
6. Discipline engine (6 weighted dims, rule stats, clean-day streaks).
7. Analytics engine (all metrics + breakdowns + equity curve).
8. Calendar month view.
9. Insights (evidence-backed, 10-trade floor).
10. AI Mentor (patterns, psychology, risk, discipline coach, session intel, tilt detection, autopsies, dismiss/feedback).
11. AI Bot (grounded Q&A, 12 intents, conversation memory, news awareness).
12. Gemini narration (grounding-guarded).
13. AI Backtest Coach.
14. Backtesting (practice) with replay engine + results + workspaces.
15. Market Replay (local + gated live TV).
16. Online Battles (canonical timeline, private seats, scoring, invites, WS realtime, dashboard feed).
17. Notifications (6 categories + battle invites + onboarding checklist + read sync).
18. Broker connection registry (status only).
19. Per-user theme prefs (cross-device).
20. Auth (GoTrue proxy, OAuth, password recovery, change password).
21. Community/Reports/Help static pages (id, battle feed, leaderboard, exports, FAQ).
22. First-run onboarding (welcome event, hero card, checklist, tour).
23. Theme system (dark/light/system, tokens).

## 10.3 B. Complete entity/data inventory
Tables: users, user_preferences*, accounts, config_versions, strategies, rule_sets, assignments, trades, trade_evaluations, violations, reviews, audit_log, tags*, trade_tags*, daily_snapshots*, ai_findings, notifications_read, broker_connections, user_prefs (* defined but unused). Canonical in-memory collections: Accounts, ConfigVersions, StrategyAssignments, Trades, StrategyMaster, RuleSetMaster, TradeEvaluations, Violations, EVENT_LOG. Derived services: riskState, disciplineState, analytics, calendarMonth, insights, reviews. Side data: backtest sessions, battles (+ registry + invites), broker connections, ai prefs, notification read state, chat memory, user prefs, user directory, market caches. Full field lists in **02_DATABASE_SCHEMA.md**.

## 10.4 C. Complete API inventory
~60 HTTP endpoints + 1 WebSocket path + core-internal functions. Full list with methods/auth/params/responses in **03_API_REFERENCE.md**.

## 10.5 D. Complete calculation/formula inventory
- P&L = (exit−entry)÷pip×size×val×sign(dir); contractValue = val÷pip; size = risk÷(|entry−stop|×cv); risk$ = |entry−stop|×size×cv; RR = |tp−entry|÷|entry−stop|; R = pnl÷risk.
- Risk: riskUsed/lossUsed/day; currentDD/maxDD from equity curve; maxAllowedRisk = min(riskPerTrade, riskRemaining, lossRemaining, drawdownRemaining, maxOpenRisk); status bands (LIMIT ≥ 100% of any limit; HIGH ≥ warn[2]; CAUTION ≥ warn[0]).
- Discipline: weighted dims (0.25/0.20/0.20/0.15/0.10/0.10) over per-rule pass rates; streaks.
- Analytics: winRate = wins/(wins+losses); PF = grossWin/grossLoss (3 if no losses; ∞ in bot/backtest); expectancy = avgR = Σr/n; recovery = net/maxDD; streaks; risk buckets.
- Battle score = 1000 × activity × (0.30·winRate + 0.30·avgRComp + 0.20·riskComp + 0.20·consistencyComp); avgRComp = clamp((avgR+1)/3); riskComp = clamp(1−maxDD/(balance×0.06)); consistencyComp = clamp(1−CV(risk)×0.9); activity = clamp(n/2,0,1).
- AI: CV>0.45 risk inconsistency; CV>0.35 practice/battle; oversize >1.5× avg risk; quick re-entry <30 min; premature entry ≤2 bars; tilt = 3-trade window, ≥2 losses + escalation/emotion; news window 6h.
- Asset volatility/synthetic candles: mulberry32 seeded walk (see 06 §6.1).

## 10.6 E. Complete permissions/roles inventory
- **Anonymous mode** (TRADEMIND_AUTH=off): single LOCAL_USER partition.
- **Signed-in user**: everything under their own `user_id` (data isolation is the only hard boundary — enforced by repo filters + core-per-user).
- **Battle host**: control replay, invite, delete. **Participant**: enter/close own seat only (403 otherwise).
- **Seat owner**: seat state readable only by the seat's user (or host viewing an open seat).
- **No admin/moderator/role system.** No per-endpoint role checks beyond the above.

## 10.7 F. Complete user-flow inventory (backend-supported)
1. Signup/login → first-user empty state → onboarding checklist → create account → create strategy → log first trade → review → connect broker. (Supported: auth, account/strategy creation, trade pipeline, reviews, brokers.)
2. Log trade → rule evaluation → adherence/block result → equity/risk/discipline/analytics/calendar update → AI findings refresh. (Supported end-to-end.)
3. Edit/delete trade → full downstream recalculation (risk/discipline/analytics/history). (Supported.)
4. Configure risk limits / strategy edits / rule toggles → new immutable versions → history + notifications. (Supported.)
5. Backtest: create practice session → replay → enter/close LONG/SHORT → results → AI coach → practice analytics/insights (isolated from live). (Supported.)
6. Market replay: start session → play/step → revealed bars. (Supported.)
7. Battle: create battle → invite via code/email → join seat → host drives shared timeline → enter/close privately → complete → blended leaderboard + team scores → dashboard feed + WS updates. (Supported.)
8. Ask the AI bot (follow-ups + memory) / browse mentor bundle / dismiss-rate findings. (Supported.)
9. Review daily/weekly/monthly; mark trades reviewed. (Supported — completion only, content derived.)
10. Reset/seed (dev tools): /api/reset, /api/seed. (Supported.)
11. **Not supported**: trade import, public profiles, squads as entities, community posts/messaging, rewards/credits, subscriptions, global leaderboards, battle replay with reveal, market replay from a live broker.

## 10.8 G. Matrix — see 10.1 above.

## 10.9 H. Frontend data requirements — see **09_FRONTEND_DATA_REQUIREMENTS.md**.

## 10.10 I. Important backend constraints the UI designer must know
1. **One source of truth per user**: every screen must read the shared core services (or their API mirrors) — never hardcode numbers. The core's math is the contract.
2. **Immutable versions**: strategies/rule sets/risk policies version on every change; trades freeze the versions active at their timestamp. UI must display version chains and "effective from" dates, and must not let users edit historical versions.
3. **Derived ≠ stored**: equity, discipline score, analytics, calendar, reviews are computed on demand. UI should treat them as read-only outputs (except `completeReview` which only logs).
4. **adherence_result semantics**: BLOCK ≠ "rejected" — the trade is saved and flagged (block_reason). VIOLATION = hard-rule fail; PASS = clean. Pre-trade check returns a separate CLEAR/CAUTION/VIOLATION/BLOCKED decision.
5. **Local-first + backend mirror**: the browser boots from localStorage, adopts server state, and replays mutations. UI must tolerate offline (`backend.offline`), and must keep client ids stable (idempotent replays).
6. **Auth-gated**: without a session every page redirects to auth.html; API 401s mean session-expired. Anonymous/dev mode exists only when `TRADEMIND_AUTH=off`.
7. **Practice/Battle records are isolated**: `source='BACKTEST'`, `account_id='practice'` — they must never mix into live P&L, risk, or discipline. Practice analytics is a separate view.
8. **Battle privacy**: private seat state is never pushed over WS; only public state. The dashboard feed's `myStats` is computed server-side per user.
9. **No upload infrastructure**: screenshots are URL references in `evidence` only. No file storage exists.
10. **No payments/rewards/subscriptions**: don't design gates that imply a paid tier — there is no mechanism behind them.
11. **Sync caveats**: the Postgres password in the local `.env` is stale (pooler rejects it) — deployments use Railway env vars; the app degrades to per-user JSON files when Postgres is unreachable. Migrations 001–011 must be applied to a fresh Supabase project (side tables 008–011 are `CREATE TABLE IF NOT EXISTS`).
12. **Frontend rendering source**: pages are static HTML; core data arrives via `window.TradeMindCore` (hydrated from localStorage/state) and `window.TradeMindCore.apiFetch` for REST. Charts use the vendored Lightweight Charts; icons via Lucide; styling via Tailwind CDN + `assets/tokens.css`.
