# 09 — FRONTEND DATA REQUIREMENTS (by page)

> Every piece of data the current backend can serve, grouped by screen. Sources: canonical core (`window.TradeMindCore` after hydrate — local-first) and the REST/WS endpoints. "State-derived" = read from the canonical tables via the shared services; "API" = fetched per request.

---

## Global chrome (all pages)
- Session: `{ token, refresh_token, expires_in, user {id, email, name, created_at} }` — `31trades.session.v1` localStorage; `GET /api/auth/me`.
- Selected account: `selectedAccountId()` (persisted) — filters every screen's dataset.
- Backend connectivity: `backend.online/offline` events (topbar indicator).
- Theme: `dark|light|system` — localStorage + `GET/PUT /api/prefs` (per user, cross-device).
- Notifications bell: unread count + feed (`GET /api/notifications`), mark-read (`POST /api/notifications/read`).
- Sidebar nav: Dashboard, Journal, Insights, Analytics, AI Mentor, Backtesting (Practice/Battle/Replay), Strategy Lab, Market Replay, Risk, Discipline, Calendar, Community, Reports, Notifications, Settings, Help.
- Topbar: global search, timezone clock (timezone from `users.timezone` — never set by app, default UTC), broker connection status (`GET /api/brokers`), primary "Log Trade" action (opens the Log Trade modal), account selector.
- Log Trade modal: account selector, asset picker with category pills + flags/logos (All, Stocks, Futures, Forex, Crypto, Indices, Metals), structured sections (Account & Setup, Asset & Direction, Execution Prices & Risk, Calculation Readouts), live calc via asset spec engine (`calcPnl`, `calcPositionSize`, `calcRiskDollars`, `calcRR`, `fmtPrice`), pre-trade check (`preTradeCheck`), save via `logTradePipeline` (replayed to `POST /api/trades`).

## Dashboard (`dashboard.html`)
- Account summary: equity (`current_equity`), starting balance, status.
- KPI cards: net P&L, win rate, profit factor, expectancy, avg R, max drawdown — from `analytics(accountId)` + `riskState()` + `disciplineState()`.
- Equity curve: `analytics().curve`.
- Recent trades table: canonical trades (symbol, dir, setup, session, pnl, r, adherence).
- Risk widget: `riskState()` snapshot (risk used/budget, drawdown, status label).
- Discipline widget: `disciplineState()` score, dims, clean streak.
- **Battle feed**: `GET /api/battles/feed` → `{active[], invites[], results[]}`; active includes live own-seat `myStats` (balance, realized, unrealized, equity, trades, wins, rank, seated); WS `feed.changed` re-fetch.
- **Market Events**: `GET /api/ecocal` (today's High/Medium by session) with graceful fallback (`ok:false` → placeholder).
- First-run hero card (welcome with user's first name + onboarding checklist) — state-derived + event log.
- Log Trade modal (see global).

## Journal (`journal.html`)
- Trades table: full canonical trade fields + derived (assetClass, timeframe, holdMin, hour, dow, postLoss, delayMin); symbol column renders **asset flags/logos** from `assets/asset-meta.js`.
- Filters: account, symbol, setup, session, direction, result, search, from/to (mirrors `GET /api/trades` query params).
- Trade detail view: trade + `evaluationsFor(tradeId)` + violations + autopsy (`GET /api/ai/autopsy/:id`), screenshots (evidence array).
- Log Trade modal (7-step pipeline, idempotent by client id).
- Edit trade (`TradeService.update`), delete (`TradeService.remove`), mark reviewed.
- Pending review queue (`!reviewed`).
- Market Events section (`GET /api/ecocal`) with session + impact filter.

## Insights (`insights.html`)
- Evidence-backed findings: `insights(accountId)` (strongest setup/session/instrument, emotional entries, risk escalation, violation cost; developing state <10 trades).
- Practice findings: `GET /api/practice/insights` (source BACKTEST).
- Confidence state from demo-trades `confidence(n)` when using demo data.

## Analytics (`analytics.html`)
- Full `computeAnalytics` object: n, net, grossWin/grossLoss, winRate, avgWin/avgLoss, avgTrade, avgR, expectancy, pf, maxDD, recovery, avgRisk, curve, byStrategy, bySetup, bySymbol, bySession, byDirection, byRisk buckets, streaks, maxEq/minEq.
- Filters: symbol/setup/session/direction/result/emotion/adherence/from/to.
- Practice toggle: `GET /api/practice/analytics` (same shape, `source:'BACKTEST'`).
- Instrument breakdown table with asset flags/logos.

## AI Mentor (`ai.html`)
- Mentor bundle: `GET /api/ai/mentor?accountId&period&includeSuppressed` → context, coach message, patterns, psychology (emotion table + findings), risk (findings + histogram), discipline (dims + rules + findings), sessions (tables + findings), tilt, autopsies.
- Dismiss/restore + thumbs feedback: `POST /api/ai/findings/suppress`, `/feedback`; dismissed-findings management view (`includeSuppressed=1`).
- Personal bot chat: `POST /api/ai/ask` (answer, kpis, evidence, followUps, memory); client transcript + server memory.
- Tilt card: `GET /api/ai/tilt`.

## Backtesting (`backtesting.html` — Practice / Battle / Replay modes)
- Practice: `GET /api/backtest/candles` (chart), `GET/POST /api/backtest/sessions`, `GET /api/backtest/sessions/:id` (state + visible candles), `POST .../control|enter|close`, `GET .../results`, `GET /api/ai/backtest-coach?sessionId` (AI review), `/api/practice/*` (analytics/insights views).
- Chart workspaces: `assets/workspace.js` (drawings, indicators ema/sma/bb/vwap/rsi/macd, chartState per symbol+timeframe).
- Battle: `GET/POST /api/battles`, `GET /api/battles/:id`, `GET /api/battles/:id/seat`, `POST .../join|invite|enter|close|control`, `DELETE ...`, `GET /api/battles/feed`, invites via `?invite=<code>`; WS `/ws?battle=<id>`.
- Replay: `GET /api/replay/start|status`, `POST /api/replay/control` (bars streamed incrementally).

## Strategy Lab (`strategy-lab.html`) — tabs Home, Accounts, Strategies, Rule Sets, Tags, System Map, History
- Accounts: create/update/status/duplicate (`ConfigAPI` → API), account risk limits (`updateAccountLimits`), account list with equity.
- Strategies: create/update/duplicate/assign (version-bumped), strategy versions chain (`getVersionChain`), strategy-account assignment map.
- Rule Sets: toggle/add/edit rules (new immutable versions), rule list with enabled/severity.
- Tags: **NOT IMPLEMENTED** (tags table exists in schema but no service/UI wiring).
- System Map: assignments/versions graph data (accounts ↔ strategies ↔ policy/strategy versions).
- History: event log (`getEventLog()` / `GET /api/audit`).

## Market Replay (`backtesting.html?mode=replay` — old replay.html redirects here)
- Same as Replay above: symbol/timeframe/window selectors, playback controls, progress, revealed bars.

## Risk (`risk.html`)
- `riskState(accountId)` snapshot: equity, daily budget/used/remaining, daily loss limit/used/remaining, trade count/max, current/max drawdown + limit + remaining, risk-per-trade limit, max open risk, max allowed risk, recommended max risk, status + label.
- Pre-trade check readout (`preTradeCheck`).
- Risk events feed (risk-breach/high-risk/loss-breach) — from `GET /api/risk`.
- Limit editor (account limits → new policy version).

## Discipline (`discipline.html`)
- `disciplineState()`: score, 6 dimension scores (Risk/Strategy/Execution/Frequency/Session/Behavior with weights), per-rule stats + rates, violations count, clean-day streak + best, strongest/weakest.
- Violations list with trade context (`GET /api/discipline/violations`).
- Pre-trade checks, live score, pattern chips, reviews (daily/weekly/monthly).

## Calendar (`calendar.html`)
- `calendarMonth(accountId, year, month)`: per-day pnl, trades, wins/losses, avgR, riskConsumed, disciplineScore, violations, trade list; month totals; win/loss day counts. Color-coded days (green/red).

## Community (`community.html`)
- Identity card (unique user ID, copyable).
- Battle results feed (`GET /api/battles`).
- Weekly leaderboard (from battle results).
- (Rest of community = NOT IMPLEMENTED — see 07.)

## Reports (`reports.html`)
- Summary tiles (NET P&L, win rate, profit factor, trade count) from canonical trades.
- Month-by-month table; by-symbol and by-setup breakdowns; CSV + JSON export (client-side).

## Profile / Settings (`settings.html`)
- User profile: name, email, unique user ID (copyable).
- Connected Brokers: `GET /api/brokers`, `POST /api/brokers/connect|disconnect` (status, connected_at).
- Security: change password (`POST /api/auth/change-password`), password strength meter + last-changed timestamp (client-side).
- Appearance: theme picker Light/Dark/System (`GET/PUT /api/prefs`).

## Notifications (`notifications.html`)
- `GET /api/notifications` feed + unread count + readIds; `POST /api/notifications/read`; categories Onboarding/Risk/Discipline/Reviews/System/Market/Battles; per-notification icon/tint/severity/href/action (broker-picker inline).

## Auth (`auth.html`)
- Signup/login/logout (`POST /api/auth/signup|login|logout`), Google OAuth (`GET /api/auth/oauth/start`), forgot/reset password (`POST /api/auth/forgot|reset-password`), session hash parsing (`#access_token=…&type=recovery`).

## Help (`help.html`)
- Static FAQ accordion, tour launcher, AI Mentor/Settings shortcuts, support email copy. (No backend data.)
