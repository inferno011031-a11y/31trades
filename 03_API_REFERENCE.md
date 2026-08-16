# 03 — API / BACKEND CAPABILITIES

> Every route implemented in `server.js` (+ WebSocket at `/ws`). Auth note: everything below the auth/health block requires a valid session — `coreFor(req)` verifies the `Authorization: Bearer <token>` via GoTrue (401 on failure). Anonymous mode (`TRADEMIND_AUTH=off`) skips auth. All JSON responses use `Cache-Control: no-store`. Read body cap: 2 MB. Errors are `{error: "…"}` with HTTP 400/401/403/404/410/500.

---

## 3.0 Auth & health (no session required)

### POST /api/auth/signup
- Body: `{ email, password, name? }`
- Behavior: proxies GoTrue `/auth/v1/signup` with `data: {full_name: name}`. Records email→id in `user-directory.json` for battle invites. Logs the one-time **Welcome event** into the user's canonical event log. Creates the user core (first-user empty state).
- Response: 201 `{ ok, session?, needsConfirmation?, user? }` — if email confirmation is on, no session is returned (`needsConfirmation: true`).
- Entities: `users` (mirror, on later save), event log.
- Errors: GoTrue messages; 400 missing email/password.

### POST /api/auth/login
- Body: `{ email, password }`
- Behavior: GoTrue password grant; records email→id.
- Response: 200 `{ ok, session: { token, refresh_token, expires_in, user } }`.
- Errors: 401 on bad credentials.

### POST /api/auth/logout
- Body: none (uses Bearer). Revokes session in GoTrue, invalidates verify cache.
- Response: 200 `{ ok: true }`.

### GET /api/auth/oauth/start?provider=google
- Behavior: builds GoTrue authorize URL (anon key embedded server-side), redirect target = request Origin/Host + `/auth.html`.
- Response: 200 `{ url }`.

### POST /api/auth/change-password
- Body: `{ currentPassword, newPassword }` (+ Bearer token)
- Behavior: verifies token → re-auths with current password → `PUT /auth/v1/user` with new password.
- Response: 200 `{ ok: true }`. Errors: 401 wrong current password, 400 length < 6.

### POST /api/auth/forgot
- Body: `{ email }` → GoTrue `/auth/v1/recover` (sends recovery email; never reveals whether the account exists).
- Response: 200 `{ ok: true }`.

### POST /api/auth/reset-password
- Body: `{ token, password }` → `PUT /auth/v1/user` with the recovery token as Bearer (recovery link format `auth.html#access_token=…&type=recovery`).
- Response: 200 `{ ok: true, session? }`.

### GET /api/auth/me
- Response: 200 `{ user }` (verified token) / 401.

### GET /api/health
- Response: 200 `{ ok, service: '31trades-backend', time, storage: 'supabase-postgres'|'db.json', auth: 'supabase-gotrue'|'off', db: { configured, connected, lastPing } }`.

### GET /api/health/db
- Response: 200 `{ ok, db: { ok, at, latencyMs, serverTime?, error? } }` — live ping.

---

## 3.1 Read endpoints (session required)

### GET /api/state
- Full canonical dump: `{ Accounts, ConfigVersions, StrategyAssignments, Trades, StrategyMaster, RuleSetMaster, TradeEvaluations, Violations, EVENT_LOG, serverTime }`.
- Source: user's Postgres slice (or file mirror).

### GET /api/audit
- `{ events }` — the user's event log (`EVENT_LOG`).

### GET /api/trades
- Query filters (all optional, applied in-memory): `accountId`, `strategyId`, `symbol`, `setup`, `session`, `direction`, `result` (`win`|`loss`|`breakeven`), `search` (substring over symbol+setup+session+note), `from`, `to` (ISO datetimes). Sorted newest first.
- Response: `{ total, trades }`.

### GET /api/trades/:id
- Response: `{ trade, evaluations, violations }` — trade + its per-rule evaluations + hard-rule violations. 404 unknown.

### GET /api/pre-trade-check
- Query: `accountId` (required), `risk`, `session?`, `setup?`, `emotion?`, `strategyId?`.
- Response: `{ account_id, state: 'CLEAR'|'CAUTION'|'VIOLATION'|'BLOCKED', checks[], blocking_rules[], recommended_max_risk }`.
- Also accepts POST with body `{ accountId, draft }`.

### GET /api/risk
- Query: `accountId` (default `acc-prop`).
- Response: `{ snapshot: riskState(), preTrade: preTradeCheck(accountId, {risk: recommendedMaxRisk}), events: RiskEvents(...) }` — risk events are the last 20 derived `risk-breach` / `high-risk` / `loss-breach` entries by day.

### GET /api/discipline
- Query: `accountId` (default `acc-prop`), `from`, `to`.
- Response: `disciplineState()` — `{ account_id, score, dims[], rules[], violations, cleanDayStreak, bestCleanDayStreak, strongest, weakest, sample }`.

### GET /api/discipline/violations
- Query: `accountId`, `from`, `to`.
- Response: `{ total, violations: [ {...violation, trade: <trade|null>} ] }` newest first.

### GET /api/analytics
- Query: `accountId` (default `acc-prop`), `symbol`, `setup`, `session`, `direction`, `result`, `emotion`, `adherence`, `from`, `to`.
- Response: full `computeAnalytics` object (see 05).

### GET /api/insights
- Query: `accountId` (default `acc-prop`).
- Response: `{ findings }` — evidence-backed findings (10-trade minimum; strongest setup/session/instrument, emotional entries, risk escalation after losses, violation cost).

### GET /api/ecocal
- Query: `session` (filter to London/New York/Sydney/Asia/Overnight), `impact` (High / Medium / others).
- Response: `{ ok, source: 'fmp'|'faireconomy'|'unavailable', day, events[], by: {session: events}, upcoming[], error? }` — today's High/Medium events by session, session-tagged in UTC.

### GET /api/calendar
- Query: `accountId`, `year`, `month` (0-indexed).
- Response: `calendarMonth()` — `{ year, month, days: [{day, date, pnl, trades, wins, losses, avgR, riskConsumed, disciplineScore, violations, list}], totalPnl, totalTrades, winDays, lossDays }`.

### GET /api/reviews
- Query: `accountId`, `period` ('all'|'daily'|'weekly'|'monthly'), `date?`.
- Response: `{ daily?, weekly?, monthly? }` — derived reviews (see 05).

### GET /api/notifications
- Query: `accountId?` (falls back to selected account, then first account, then null).
- Behavior: derives the notification feed (sources: onboarding checklist, risk state, BLOCKed trades, violations, pending reviews, event log, upcoming market events, broker-connected state, pending battle invites) — full detail in 08. Merges read-state.
- Response: `{ ok, notifications[], unread, readIds[], brokerConnected }`.

### GET /api/brokers
- Response: `{ ok, brokers: [{broker, connected_at, status}], connected: bool }`.

### GET /api/prefs
- Response: `{ ok, prefs: { theme: 'dark'|'light'|'system' } }` (DB → file → default dark).

### GET /api/backtest/candles
- Query: `symbol` (default EURUSD), `timeframe` (1m/5m/15m/1h/4h/1d), `count` (30–1500, default 320).
- Response: `{ ok, symbol, timeframe, count, base, candles: [{time, open, high, low, close, volume}], meta: { category, source: 'tradingview'|'cache'|'synthetic', provider } }`.

### GET /api/backtest/sessions
- Response: `{ ok, sessions: [{id, symbol, timeframe, strategy, status, createdAt, trades, net, winRate, balance, open, cursor, total}] }`.

### GET /api/backtest/sessions/:id
- Response: `{ ok, state }` — `stateOf()`: id/symbol/tf/strategy/category/status, startingBalance, balance, riskModel, cursor/total/startIndex, candle (current), position (private, incl. unrealized + unrealizedR), trades[], actions (last 60), candles (visible: `slice(0, cursor+1)` — future bars hidden).

### GET /api/backtest/sessions/:id/results
- Response: `{ ok, results }` — full derived results object (see 06).

### GET /api/practice/trades
- Response: `{ ok, trades }` — every recorded backtest trade flattened to canonical analytics shape, tagged `source: 'BACKTEST'`, `account_id: 'practice'`.

### GET /api/practice/analytics
- Query: same filters as /api/analytics.
- Response: canonical analytics over practice trades + `source: 'BACKTEST'` + `list`.

### GET /api/practice/insights
- Response: `{ ok, findings }` — evidence-backed practice findings (min 5 trades): best/weak setup, best session, SL dominance, premature entries, inconsistent risk, revenge re-entry, win streak. All tagged `source: 'BACKTEST'`.

### GET /api/ai/backtest-coach?sessionId=:id
- Response: AI coach review of a finished practice session — `{ ok, summary, findings[] }` (see 05).

### GET /api/battles
- Response: `{ ok, battles: [{id, title, symbol, timeframe, status, createdAt, cursor, total, seats, taken, teams, invite}] }` — the caller's own hosted battles + battles they were invited to.

### GET /api/battles/feed
- Response: `{ ok, feed: { active[], invites[], results[] } }` — dashboard feed. Active/running battles (with `mySeat`, live `myStats`: balance/realized/unrealized/equity/trades/wins/rank/seated when the caller is seated; `canJoin` when free), and completed results from the last 7 days (winner + full leaderboard).

### GET /api/battles/invites
- Response: `{ ok, invites: [{id, battleId, code, title, symbol, timeframe, status, hostId, seats, taken, free, createdAt, href}] }`.

### GET /api/battles/invite/:code
- Resolves a shareable invite code (cross-user via registry). Response: `{ ok, invite, state: publicState() }`. 404 unknown/used; 410 battle ended.

### GET /api/battles/:id
- Response: `{ ok, state: publicState() }` — public only: seats (id/name/team/taken/userId), cursor/total, current candle, leaderboard only when completed.

### GET /api/battles/:id/seat?seat=:seatId
- Response: `{ ok, state: seatState(seat) }` — private seat view: own position/trades + shared visible candles. 403 if not your seat.

### GET /api/replay/start
- Query: `symbol`, `timeframe`, `window` (20–1500), `preRoll` (5–window-10).
- Response: `{ ok, state }` — session id + initial revealed bars. Modes: `live` (real TV replay, needs TRADEMIND_TV_SESSION/SIGNATURE) or `local` (real cached history replayed server-side; source `history-local` or `synthetic`).

### GET /api/replay/status?id=:id&from=:idx
- Response: `{ ok, id, symbol, timeframe, source, playing, ended, position, total, from, bars[] (new bars since `from`), error? }`.

### GET /api/ai/mentor
- Query: `accountId`, `period` ('30d' default | '90d' | 'all'), `includeSuppressed=1`.
- Response: `{ ok, bundle }` — the full mentor bundle (context, coach message, patterns, psychology, risk, discipline, sessions, tilt, autopsies) with `ai_findings` prefs merged (suppressed filtered unless includeSuppressed), upcoming events attached, and Gemini narration replacing `coach.message` when a key is set (`ai: 'gemini'`).

### GET /api/ai/tilt
- Response: `{ ok, tilt: [] }` — tilt episode analysis for the account.

### GET /api/ai/autopsy/:tradeId
- Response: `{ ok, autopsy }` — trade autopsy (entry/exit/risk/rules/verdict).

---

## 3.2 Write endpoints (session required)

### POST /api/state
- Body: full canonical state `{ Accounts, Trades, … }`. Server hydrates it, backfills evaluations, saves. **This is the client→server adoption path** (called on every page boot + reconnect).
- Response: `{ ok, trades, accounts }`. 400 on malformed payload.

### POST /api/trades — the 7-step rule pipeline (Log Trade)
- Body: trade object `{ account_id, symbol, dir: 'Long'|'Short', entry?, exit?, size?, risk?, pnl?, stop?, tp?, setup?, session?, emotion?, adherence?, note?, evidence?, ts?, id? (client-generated for idempotency), strategy_id? }`.
- Behavior: idempotent by id; self-heals missing assignments/policies; derives P&L/size from the asset spec when absent; evaluates every enabled rule; writes evaluations + violations; updates equity; publishes `trade.created`; replays to Postgres.
- Response: 201 `{ ok, trade, adherence }`.

### PATCH /api/trades/:id
- Body: `{ fields }` or the fields directly. Updatable: symbol, dir, setup, session, emotion, adherence, entry, exit, size, risk, pnl, note, reviewed, stop, tp, ts. Recomputes r, equity, derived fields; re-evaluates against the SAME immutable versions; rewrites evaluations/violations.
- Response: `{ ok, trade }`.

### DELETE /api/trades/:id
- Removes trade + its evaluations/violations; adjusts equity; recomputes derived fields.
- Response: `{ ok, deleted }`.

### POST /api/reviews/complete
- Body: `{ account_id, period ('daily'), note? }`.
- Behavior: logs 'Review completed' event, publishes `review.completed`. **Does not write the reviews table** (content is derived).
- Response: `{ ok, period }`.

### POST /api/ai/ask
- Body: `{ question, accountId?, period? ('30d' default), memory? }`.
- Behavior: grounded Q&A over the real ledger via `Bot.askBot` (intents: overall/period/tilt/discipline/streak/risk/session/symbol/setup/winloss/focus/news). Loads persisted conversation memory (or uses client memory), saves updated memory. Attaches upcoming market events for news warnings. Gemini narration replaces the answer when a key is set and the grounding guard passes.
- Response: `{ ok, question, intent, period, window?, answer, kpis[], evidence[], followUps[], news?, ai?, memory }`.

### POST /api/ai/findings/suppress
- Body: `{ finding_id, suppressed: bool }` → writes `ai_findings.suppressed`.
- Response: `{ ok, finding_id, suppressed, persisted }`.

### POST /api/ai/findings/feedback
- Body: `{ finding_id, value: 1|-1 }` → writes `ai_findings.feedback`.
- Response: `{ ok, finding_id, feedback, persisted }`.

### POST /api/events
- Body: `{ action: 'tag', entity, what, detail, impact }` (log tag event) or `{ action: 'manual', detail }` (record manual change). Appends to event log.
- Response: 201 `{ ok }`.

### POST /api/rule-sets/toggle
- Body: `{ key }` → toggles the rule in the active version → creates a new immutable RuleSet version.
- Response: `{ ok, version }`. 404 unknown key.

### POST /api/rule-sets/:id/rules/:key
- Body: `{ changes }` (or flat rule fields) → new immutable version with the edited rule.
- Response: `{ ok, version }`.

### POST /api/rule-sets/:id/rules
- Body: `{ rule: { label, cat?, op?, threshold, unit?, severity?, key? } }` → adds rule, new immutable version.
- Response: 201 `{ ok, version }`.

### POST /api/accounts
- Body: `{ fields: {name, type?, currency?, style?, start?, equity?, ddModel?, dailyLoss?, maxDD?, risk?, basis?, openR?, maxTrades?, status?, warn?}, id? }` (also accepts flat `{id, fields}`; defensive aliases `riskPerTrade`, `dailyLossLimit`, `maxDrawdown`, `starting_balance`, `account_type`, `openRisk`).
- Behavior: idempotent by preId; creates account + v1 RiskPolicy; provisions default rule sets; auto-assigns all active strategies.
- Response: 201 `{ ok, id }`.

### POST /api/accounts/:id/strategies
- Body: `{ strategy_id }` → creates an assignment row.
- Response: `{ ok }`. 404 if account or strategy missing.

### POST /api/accounts/:id/limits
- Body: `{ values: RiskPolicyValues, note? }` → new immutable RiskPolicy version, re-points every assignment of the account.
- Response: `{ ok, version }`.

### POST /api/accounts/:id/status
- Body: `{ status }` (Active/Paused/Archived).
- Response: `{ ok }`.

### POST /api/accounts/:id/duplicate
- Body: `{ id? }` → duplicates account + policy; copy starts **Paused**.
- Response: 201 `{ ok, id }`.

### POST /api/accounts/:id (update identity)
- Body: account fields (name, account_type, currency, style, starting_balance, current_equity, status, note). Not versioned.
- Response: `{ ok }`.

### POST /api/strategies
- Body: `{ fields: {name, desc?, color?, markets?, sessions[], setup?, riskPerTrade?, minRR?, stopRequired?, entry?, exit?, behavior[], tags[]}, id? }` → strategy + v1.0 version + assignment to the selected account.
- Response: 201 `{ ok, id }`.

### POST /api/strategies/:id/duplicate
- Body: `{ id? }` → strategy copy with fresh v1.0 (unassigned).
- Response: 201 `{ ok, id }`.

### POST /api/strategies/:id
- Body: `{ fields, note? }` → new immutable Strategy version (partial edits merged), re-points assignments.
- Response: `{ ok, version }`.

### POST /api/seed (dev/testing)
- Body: `{ count? }` → `Core.seedDemoAccount(count)` — deterministic ~30-trade demo dataset (accounts `acc-prop`, strategies London FVG / ORB / Asia OB, seeded rule sets).
- Response: `{ ok, trades, accounts, strategies }`.

### POST /api/reset
- Reseeds to the **first-user empty state** (zero trades/accounts/strategies), backfills, saves.
- Response: `{ ok, trades: 0, accounts: 0 }`.

### POST /api/backtest/sessions
- Body: `{ symbol, timeframe, window (30–1500), startBars?, strategy?, startingBalance?, riskModel: {basis: 'money'|'pct', perTrade} }`.
- Behavior: fetches candles (TradingView-first), creates `BacktestSession`, persists per user.
- Response: `{ ok, session: <id>, state }`.

### POST /api/backtest/sessions/:id/control
- Body: `{ action: 'play'|'pause'|'step'|'seek'|'reset', speedMs?, cursor? }` → server-owned replay controls.
- Response: `{ ok }`.

### POST /api/backtest/sessions/:id/enter
- Body: `{ direction: 'Long'|'Short', entry?, sl, tp?, riskAmount?, riskPct?, size?, notes?, setup? }` → opens a position (validated: direction, SL side, TP side, size derived from risk).
- Response: `{ ok, position, state }`. 400 on validation errors.

### POST /api/backtest/sessions/:id/close
- Body: `{ price?, reason? }` → closes the open position (manual close; default price = current bar close, reason default 'manual').
- Response: `{ ok, trade, state }`.

### DELETE /api/backtest/sessions/:id
- Deletes the practice session.
- Response: `{ ok }`.

### POST /api/battles
- Body: `{ title?, symbol, timeframe, window, startBars?, startingBalance?, riskModel?, seats: [names] (max 10), teams: [team|null per seat] }`.
- Behavior: fetches candles, creates `Battle` (status 'lobby'), host takes seat 0, persists under host, emits `created`.
- Response: `{ ok, battle, hostSeat, state }`.

### POST /api/battles/:id/invite
- Body: `{ emails: [], name? }`. Host-only (403 otherwise).
- Behavior: generates an invite code (8 chars, unambiguous alphabet), saves, returns shareable link `…/battles.html?invite=<code>`, records an in-app invitation for each known email's user, and returns a `mailto:` invite.
- Response: `{ ok, code, link, mailto }`.

### POST /api/battles/invite/:code/accept
- Body: `{ name? }` → resolves the battle, claims the first free seat for the caller.
- Response: `{ ok, seat, state }`. 410 battle ended; 400 full.

### DELETE /api/battles/:id/invite
- Invitee dismisses a pending invite. Response: `{ ok }`.

### POST /api/battles/:id/join
- Body: `{ name? }` → claims a free seat (lobby or running only).
- Response: `{ ok, seat, state }`.

### POST /api/battles/:id/control
- Body: `{ action: 'play'|'pause'|'step'|'seek'|'reset'|'complete', speedMs?, cursor? }`. **Host-only** (403).
- Response: `{ ok }` (complete also returns `leaderboard`).

### POST /api/battles/:id/enter
- Body: `{ seat, direction, entry?, sl, tp?, riskAmount?, riskPct?, size?, notes?, setup? }`. Seat-owner only.
- Anti-cheat: entry must be within the current visible bar's low/high (±0.1%).
- Response: `{ ok, position, state }`.

### POST /api/battles/:id/close
- Body: `{ seat, price?, reason? }`. Seat-owner only. Response: `{ ok, trade, state }`.

### DELETE /api/battles/:id
- Host-only. Pauses + deletes the battle. Response: `{ ok }`.

### POST /api/notifications/read
- Body: `{ ids: [] }` → marks notification ids read (upsert into `notifications_read` + file mirror).
- Response: `{ ok }`.

### POST /api/brokers/connect
- Body: `{ broker }` → upserts an active broker connection.
- Response: `{ ok, broker }`.

### POST /api/brokers/disconnect
- Body: `{ broker }` → sets status 'inactive'.
- Response: `{ ok }`.

### POST /api/prefs (also PUT)
- Body: `{ theme }` — must be one of `dark|light|system` (400 otherwise). Writes `user_prefs` + file mirror.
- Response: `{ ok, prefs }`.

### POST /api/replay/control
- Body: `{ id, action: 'play'|'pause'|'step'|'reset'|'close', speedMs? }` → replay controls; returns fresh status.
- Response: `{ ok, state }`.

---

## 3.3 WebSocket /ws
- `?battle=<id>` → room subscription. Messages pushed: `{type:'battle.cursor', battle, cursor, status}` and `{type:'battle.status', battle, state}` (public state).
- No battle param → dashboard feed client. Receives `{type:'feed.changed'}` ping on every battle mutation.
- Private seat state is never pushed.

## 3.4 Internal functions (not HTTP — exposed to callers/tests)
- Core (browser + server): `logTradePipeline`, `TradeService.create/update/remove/evaluationsFor`, `evaluateRules`, `preTradeCheck`, `riskState`, `disciplineState`, `analytics`, `analyticsFrom`, `calendarMonth`, `insights`, `reviews`/`dailyReview`/`weeklyReview`/`monthlyReview`/`completeReview`, `backfillEvaluations`, `ConfigAPI.*`, `assetSpecFor/assetClassOf/contractValueOf/calcPnl/calcPositionSize/calcRiskDollars/calcRR/fmtPrice`, `hydrate/reseed/serializeState/persist/seedDemoAccount/emptyState/enrichAllDerived`, `selectedAccountId/setSelectedAccount`, `connectBackend`.
- Modules: `AI.mentorBundle/mentorWithPrefs/autopsy/buildContext/detectPatterns/psychologyAnalysis/riskAnalysis/disciplineCoach/sessionIntel/tiltAnalysis/loadPrefs/saveFindings/setPref`; `Bot.askBot/detectIntent/resolveAsk/windowSinceMs/statsOf/rankBy/tradesIn/loadMemory/saveMemory/subjectRowAnswer`; `Sim.*`; `Battle.*`; `Practice.*`; `AICoach.coach`; `Notif.buildNotifications/readSetOf/unreadCount/markRead`; `Brokers.*`; `Prefs.*`; `Replay.start/control/status`; `MarketData.getCandles/...`; `EcoCal.getCalendar/todayBySession/upcomingHighImpact`; `LLM.narrate/narrateBotAnswer/narrateCoachMessage`.
