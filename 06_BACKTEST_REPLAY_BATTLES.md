# 06 — BACKTESTING + MARKET REPLAY + BATTLES

> One engine, many modes: the **Backtest Simulation Engine** (`server/backtest-sim.js`) drives Practice, Battle, and (separately) Market Replay. All simulated records are tagged `source='BACKTEST'` and **never touch live account P&L**. UI lives in a single page `backtesting.html` with three in-page modes: `?mode=practice`, `?mode=battle`, `?mode=replay`.

---

## 6.1 Historical data pipeline (`server/marketdata.js` + `server/backtest.js`)

```
GET /api/backtest/candles?symbol&timeframe&count
  1. fresh disk cache (6h TTL per symbol+tf+count)          → source 'cache'
  2. TradingView WS via @mathieuc/tradingview (guest, no key) → source 'tradingview'
     (failure → 5-min latch so a dead symbol never hammers the socket)
  3. deterministic synthetic generator (backtest.js)        → source 'synthetic'
```
- TradingView symbol map: FX → `FX:*`, metals → `OANDA:*`, energy → `TVC:*`/`NYMEX:*`, ag → `NYMEX:*`/`CBOT:*`, indices → `TVC:*`, crypto → `COINBASE:*USD`, curated stocks → `NASDAQ:*`. Unknown symbols: live search (cfd type) or Coinbase guess.
- Timeframes: 1m/5m/15m/1h/4h/1d; count clamped 30–1500 (default 320).
- Synthetic generator: seeded mulberry32 random walk keyed to `symbol:timeframe`, regime-aware (trend/range/vol-burst), trading-days only (weekends skipped), anchored to a fixed recent date window (~Aug 2026 ±45 days). Deterministic: same symbol+tf ⇒ identical series.
- The `meta.category` is 'Forex'|'Metals'|'Energy'|'Agriculture'|'Indices'|'Crypto'|'Stocks'|'Other'.

## 6.2 Backtest Simulation Engine (`server/backtest-sim.js`)

### BacktestSession (per-user, persisted `data/backtest-<userId>.json`)
State: `id, userId, symbol, timeframe, strategy, category, startingBalance, riskModel {basis:'money'|'pct', perTrade}, candles[], startIndex, cursor, position|null, trades[], actions[], status ('running'|'completed'), createdAt, completedAt, balance, peak`.

### Replay engine
- Future candles hidden: `visibleCandles() = candles.slice(0, cursor+1)`; API returns only visible candles.
- `setCursor(idx)`: advancing simulates bar-by-bar; **rewinding never re-simulates** (cursor moves back without replaying fills).
- Controls: play (interval at `speedMs`, min 40 ms, saves ≤ every 400 ms), pause, step (+1), seek (jump — re-simulates forward), reset (clears position/trades, back to startIndex, balance reset to starting, status running).

### Trade execution (LONG/SHORT)
- `enter({direction, entry?, sl, tp?, riskAmount?, riskPct?, size?, notes?, setup?})`:
  - Validations: one position at a time; direction must be Long/Short; entry defaults to current bar close; entry+SL required; Long: SL < entry, TP > entry; Short: SL > entry, TP < entry.
  - Risk: explicit riskAmount → else riskPct of balance → else riskModel (`money`=perTrade $, `pct`=perTrade% of balance). Size derived `size = riskAmount ÷ |entry − sl|` when not given.
  - Position records: dir, entry, sl, tp, size, riskAmount, riskPct, rr (planned, `|tp−entry|÷|entry−sl|`), notes, setup, openedAt (bar time), openedAtIdx.
  - **Intrabar fill**: if SL is inside the entry bar it fills immediately.
- `close({price?, reason?})`: manual close at price (default current bar close), reason default 'manual'.
- **SL/TP simulation** (`_simulateBar`): conservative intrabar precedence — the losing fill happens first. Long: `low ≤ sl` → fill SL; `high ≥ tp` → fill TP. Short: `high ≥ sl` → SL; `low ≤ tp` → TP. `pnl = (exit−entry)×size × (±1)`; `realizedR = pnl ÷ riskAmount`.
- **Trade record**: id, sessionId, userId, symbol, timeframe, strategy, category, direction, entryTime (bar time), exitTime, entryIndex, exitIndex, entry, exit, sl, tp, size, riskAmount, riskPct, plannedRR, realizedR, pnl, result ('win'|'loss'), exitReason ('SL'|'TP'|'manual'|…), setup, notes, openedAt/closedAt ISO.
- **Action audit trail** (`actions[]`): every enter/close logged with type, at, cursor + payload (direction, entry, sl, tp, size, riskAmount / tradeId, reason, price, pnl, r).

### Results (`results()`, pure derivation)
```
trades/wins/losses, net, grossProfit, grossLoss
winRate (wins/trades), profitFactor (grossL ? grossP/grossL : (grossP>0 ? ∞ : 0))
expectancy = Σ realizedR ÷ n,  avgR = same
avgWinner, avgLoser (magnitude), maxDrawdown (equity-curve), equity [{idx, balance}]
bestTrade, worstTrade, bestWinStreak, worstLossStreak
bySetup / byDirection / bySession (UTC London/NY/Asia/Sydney) / byTimeOfDay / byExitReason
  → each {key: {trades, wins, net, avgR, winRate}}
endingBalance = startingBalance + net; balance (current), peak
```

## 6.3 Practice view (`/api/practice/*`, `server/practice.js`)
- `flattenTrades`: every recorded backtest trade → canonical analytics shape `{id, account_id:'practice', source:'BACKTEST', session_id, ts (exitTime×1000), symbol, dir, setup, session (from entry hour), strategy_id, pnl, r, risk, riskPct, holdBars, exitReason, plannedRR, emotion:null, adherence:null}`.
- `/api/practice/analytics` = the **same** `computeAnalytics` over flattened trades (`source:'BACKTEST'`, plus raw `list`). Strictly separate from live.
- `/api/practice/insights` = practice findings (min 5 trades): best/weak setup, best session, SL dominance (≥60% SL exits), premature entries (resolved ≤2 bars, ≥3), inconsistent risk (cv>0.35, ≥4), revenge re-entry (within 1 bar of loss, ≥2), win streak (≥3), clean sample fallback.

## 6.4 Market Replay (`server/replay.js`, page mode `?mode=replay`)
- One session = one symbol/timeframe/window (default 400 bars, preRoll 30 revealed before playback).
- **Two data paths**:
  - `live` — true TradingView replay via `@mathieuc/tradingview` (requires `TRADEMIND_TV_SESSION` + `TRADEMIND_TV_SIGNATURE` cookies; paid TV feature); server opens a replay session at the chosen timestamp and steps `replayStep(1)` per tick.
  - `local` (default) — real cached TradingView history replayed bar-by-bar with a server timer (200 ms resolution), honest source label `history-local` (or `synthetic` when TV is unreachable).
- Controls: play/pause/step/reset (reset falls back to local mode because live replay can't rewind), speed (min 50 ms).
- Status polling: `GET /api/replay/status?id&from` returns **only new bars since `from`** (browser appends). Idle sessions swept after 20 min.
- UI: top control bar (symbol, timeframe, window, play/pause/step, speed, progress), chart with candle+volume series, dataset cache (5 min) for instant re-open.

## 6.5 Battles (`server/battle.js` + `server/battle-config.js`, pages `battles.html` and `?mode=battle`)

### Relationship to the backtesting engine (read this first)
Battles are **not** a second simulator and **not** an arcade page. The dependency chain is one-way and there is no parallel chart or execution stack:

```
Market Data (server/marketdata.js)  →  Chart engine (chart-test.html: TradingView Charting Library + BattleX HUD + replay-engine.js)
                                    →  Backtesting engine (server/backtest-sim.js)
                                    →  Battle engine (server/battle.js: ONE cursor, N private seats)
```

- One `Battle` owns ONE `candles[]` array (the real archived month, fetched once) and ONE server-owned `cursor`. Every seat holds a `BacktestSession` over that **same** array, so identical candles, identical start bar, identical future bars, identical SL/TP fill bar for every participant.
- Clients render state; they never determine it. The cursor, fills, P&L, ending condition and settlement are all server-authoritative; `battle-ws.js` only pushes, REST only reads.

### The configuration contract (`server/battle-config.js`)
Battle mechanics, rules, scoring and modes are **not specified yet**. Instead of guessing, the engine has an explicit contract with named policy SLOTS (`market`, `replay`, `execution`, `risk`, `settlement`, `scoring`, `visibility`), each declaring its fields and the policies the engine can honour, and each policy flagged `implemented: true|false`:

- Requesting an **unimplemented** policy is a hard error on create (`400` + `errors[]`) and a **blocker** on start — the engine refuses to run a battle it cannot honour instead of inventing one. `step/play` return `{ok:false, error:'battle configuration cannot run yet: …', blockers[]}`.
- Unknown keys/fields are preserved verbatim (`config.extra`, declared placeholder values such as `settlement.bars`) with warnings, so a later specification can read them without a schema migration.
- `GET /api/battles/config` serves the capability catalogue (version, lifecycle, availability states, per-slot fields + policies + implemented flags, participant fields) — the lobby renders it and labels anything missing as *not specified yet*.
- `publicState()` reports `config`, `configBlockers`, `runnable`, `endCondition` and `visibility`, so a client can always show WHY something is unavailable.

Extensibility seams: `registerEndCondition(name, fn)` (engineering) plus flipping a policy's `implemented` flag (contract). Both are deliberate — registering an evaluator alone never changes behaviour, and a test pins that.

### Battle timeline model — one canonical resolution, one shared cut time, free display timeframes (TARGET ARCHITECTURE)
**The backend must never dictate the battle's timeframe.** A battle owns ONE canonical timeline at the **base resolution** (`config.market.baseTimeframe` — the finest timeframe the archive actually has for that symbol + month, `1m` whenever it exists) and ONE server-owned cursor into it. What every client is told is the **cut**: `timeline.cutTime` = the open time of the base bar at the cursor. That single wall-clock value IS the market state:

```
base timeline (finest archive resolution, whole archived month)
  bar 0 ......... bar[cursor] ....................... bar N-1     ← stays on the server
                      ▲
                   cutTime   ← server-authoritative "you are here"

display series for ANY timeframe = revealed base bars, aggregated/clipped at cutTime
```

- **Fill precision and fairness.** SL/TP simulate on the base-resolution bars as the cursor advances, and entry validation uses the base bar at the cut — so fill bar, fill price and the anti-cheat window are IDENTICAL for every seat regardless of which timeframe that seat is looking at. A chart timeframe can never change someone's execution.
- **Display timeframe is a per-seat view, switchable mid-battle.** `GET /api/battles/:id/timeline?timeframe=15m&from=N` builds that timeframe's series by aggregating the *revealed* base bars:
  - a bar is **complete** when its close time ≤ `cutTime` (fully revealed, real high/low/close);
  - the bar containing the cut is returned as `forming` with OHLC built ONLY from revealed base bars (`complete:false`) — a live candle, exactly like a real chart, never a leak;
  - nothing past the cut is ever aggregated, so a coarser bar is never shipped with its post-cut interior filled in (the leak that plain `b.time <= cut` slicing has whenever the display timeframe is coarser than the replay base).
- **Timeframes finer than the base resolution are not offered** for that dataset (the base is already the finest the archive has). `GET /api/battles/config` reports the display set per dataset instead of pretending it is available.
- Warm-up (`startBars`) and `Bars shown at once` are counted in **base bars**, because that is what the canonical timeline now is; the create form prints the converted value and the base resolution so the number is never ambiguous.
- The host's timeframe choice becomes `config.market.startingTimeframe` (what the chart opens on) — a display default, not a constraint. `config.market.timeframe` stays as a compatibility alias.
- `timeline` block on `publicState`, `seatState` and the WS `battle.cursor` push: `{ baseTimeframe, timeframeMs, startingTimeframe, displayTimeframes, cutTime, cutIndex, revealedBars, totalBars }`.

### Chart surface — the SAME chart as backtesting, driven by the battle cut (TARGET ARCHITECTURE)
The seat view is the same chart practice hands off to (`chart-test.html`: TradingView Charting Library + BattleX HUD + `executeCut` / `_replayCutTimeMs` time-sliced replay). Battle mode is a **driver, not a fork**:

- `chart-test.html?battle=<id>&seat=<id>&tf=<startingTimeframe>` → `assets/battle-driver.js` follows the battle's server cut instead of the local replay engine (`BattleXReplay.play/step` are disabled; the market only moves when the server moves it).
- The chart's own timeframe bar stays fully functional: switching re-slices the SAME cut (`_replayCutTimeMs`), so two players can look at different timeframes and still be at the same market moment.
- Orders go through the existing `BacktestBridge`, re-pointed at the battle seat endpoints (`/api/battles/:id/enter|close`) — same HUD, same execution path, no second order ticket.
- `battles.html` keeps ONLY the Battles surface (availability · find/challenge/quick/available players/history · create form · lobby). Opening a seat opens the terminal.

### Canonical-timeline architecture (as first built — superseded above where the two disagree)
- **One `Battle`** owns one `candles[]` (fetched once via marketdata) + a server-owned `cursor`. Every seat gets a `BacktestSession` over the **same candles array**; `setCursor` advances all seats bar-by-bar on the same bar (fair SL/TP event ordering).
- **Battles replay exactly like practice backtesting — a full archived month (at base resolution).** The create form offers the same hierarchy: `Symbol → Historical archive (Year · Month) → Starting timeframe` (timeframes listed per month straight from `/api/backtest/periods`, so a battle can never silently fall back to another month) plus `Bars shown at once`, `Warm-up bars before start`, starting balance and risk-per-trade. `Replay data: Recent live window` stays as an explicit fallback mode.
- **Seat bar delivery** (the terminal's battle driver polls this; the *chart series* itself comes from `/api/battles/:id/timeline`): when a seat opens, the client fetches `…/seat?full=1` — every bar the shared cursor has revealed, from bar 0 of the archive month — then polls `…/seat?from=<held>` for deltas only. `Fit month` zooms out to everything revealed, `Cursor` jumps back to the replay edge, the open position's entry/SL/TP are drawn as price lines and fills as markers. Future bars are never sent in any mode, so no client can leak the outcome; the display series is rebuilt from that delivery by the timeline aggregation above.
- **Blind battles:** the create form's month list carries a `Random month (blind — revealed on start)` option. The server resolves `period: 'random'` to a real archived month that actually has the requested timeframe (from `/api/backtest/periods`) and reveals it when the battle opens.
- **Why a battle could look like "limited bars":** (kept for history — the fix is that the canonical timeline is now always sent and every display timeframe is built from it) two different layers. The *canonical timeline* is the WHOLE archived month — every seat is scored over all of it and SL/TP fills on the same bar for everyone. The *chart delivery window* (`candleWindow`, default 400, host-selectable up to 2000) only bounds the tail of visible bars sent on each seat poll, so a 1m month (≈20k+ bars) never becomes a multi-megabyte response every few hundred ms. `publicState.total` always reports the true bar count for the month — the UI prints `Timeline: N bars total · <Month Year> archive` so the window is never mistaken for the data set.
- `startBars` (warm-up bars) is an explicit host choice; an absent value falls back to the 30-bar pre-roll default, and an explicit `0` is honoured.
- **Private seats**: each seat's position/trades/balance are private (`seatState` only returns your own); the public state exposes seats (id/name/team/taken) + cursor + current candle only. Anti-cheat: entries must be within the current visible bar's low/high (±0.1%).
- **Seat candle delivery modes** (`seatState(seatId, { full, from, window })`): `full=1`/`window=all` → every revealed bar from index 0; `from=N` → only bars after N (incremental polls); default → the legacy bounded tail window. All three clamp to `cursor + 1`, so no mode can ship an unrevealed candle (covered by tests).

### Lifecycle
- Compatibility `status` remains `lobby` → `running` → `completed`, while the foundation also carries an extensible lifecycle: `discovery` → `matching` → `lobby` → `ready` → `battle` → `settlement` → `results` → `analytics`.
- `POST /api/battles/:id/control {action:'transition', lifecycle}` is host-authoritative. No transition adds matchmaking, timing, scoring, or settlement rules; it only records the state boundary for future policies.
- Every state mutation carries a monotonic `stateRevision` and append-only battle event envelope. Clients render snapshots; they never advance the cursor locally.
- Create: host picks symbol/tf/window/startBars/startingBalance/riskModel/seat names (max 10)/teams; host takes seat 0. Emits `created`.
- Join/accept invite: claim first free seat (lobby or running only).
- Host controls (only host): play/pause/step/seek/reset/complete. Auto-completes at the final bar.
- `actions[]` audit log per battle (enter/close per seat with cursor).
- Configuration is normalized through the contract above; the `replay`/`execution`/`settlement` namespaces stay as versioned passthrough, and the resolved market identity (`config.market.dataset` = `SYMBOL:timeframe:period`) is written back so a record describes itself.
- Presence is separate from a battle: `/api/battles/availability` stores `online|available|in_battle|spectating|offline` with a 5-minute freshness window. Claiming a seat (join/accept invite) moves a player to `in_battle`; `POST /api/battles/:id/spectate` marks watching without a seat — watching never silently becomes a seat.
- Persistence: host-owned `data/battle-<hostId>.json`; cross-user invite registry `battle-registry.json` (battleId→hostId); per-invitee `battle-invites-<userId>.json`; pending challenges `battle-challenges.json`.
- Invites: shareable code (8 chars, unambiguous alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), `battles.html?invite=<code>` link, in-app invite for known emails (`user-directory.json`), `mailto:` for real email (20 max).

### Entry points and matching (availability → matching → lobby)
- `battles.html` is the single Battles surface: availability control + **Quick Battle** + **Find Battle** (open seats), **Available players** list with a Challenge button, incoming **challenges** with accept/decline, live/open battles, recent activity and **Battle history**.
- A **challenge** is not a mode: it is a named offer carrying a validated `config`. `POST /api/battles/challenges {toUserId|quick:true, config?, message?}` → pending (15 min TTL, one pending offer per pair, newest supersedes). `POST /api/battles/challenges/:id/accept` creates a REAL battle in the `lobby` state with both players seated (same creation path as a hosted battle), moves both to `in_battle` and links the battle id back to the challenge; `decline` closes the offer. Only the challenged player may answer.
- Quick Battle uses `pickQuickOpponent()` — the longest-waiting player marked available. This is a clearly-labelled PLACEHOLDER (no ratings, no queues, no formats) isolated in one function so the real matchmaker replaces it without touching the challenge flow.
- Every battle-starting path (host create, invite accept, challenge accept) funnels through one server-side creator, so archive resolution, warm-up, seat layout and config validation can never drift between them.

### Opponent state synchronization
- Presence is the ONE always-synchronized competitor signal, derived server-side from per-seat activity (`markSeatSeen` on a seat poll, plus `enter`/`close`), and persisted at most every 15s so polling stays cheap. States: `unclaimed → waiting → online → active → offline`.
- Everything else about an opponent is gated by the `visibility` policy: `presence` (default — identity + presence only), `custom` (exactly the declared fields), `full` (every tracked field). Participant fields the engine tracks: `presence, status, direction, risk, pnl, trades`. A viewer's OWN seat is never filtered; `visibility.hidden` names what is withheld so the UI explains the gap instead of implying idleness.
- `GET /api/battles/:id/participants` returns the viewer-filtered projection; WS pushes `battle.cursor`/`battle.seat` carry the same viewer-neutral projection (no private seat data ever on the wire). `battle.seat` announces THAT a seat moved (`seat`, `kind`, `stateRevision`) — never the decision itself.
- Both `battles.html` and `?mode=battle` render an opponent panel with a presence dot and only the fields the policy allows, plus an explicit note listing the hidden ones.

### Results as a first-class trading dataset
- `canonicalTrades()` flattens every seat's closed trades through the SAME mapper practice uses (`practice.toAnalyticsTrade`), tagged `source:'BATTLE'`, `account_id:'battle'`, `battle_id`, `seat`, `seat_name`, `team`, `period` — so battle trades can feed analytics/insights/journal alongside practice trades instead of being an isolated game record.
- `GET /api/battles/:id/results` (participants only, and only once the battle has ended — 409 before that) returns the **settlement record**: battle identity + lifecycle, market context (symbol, timeframe, dataset identity, archive month, start/end timestamp of the replayed slice, total vs revealed bars), the normalized config, the active ending-condition policy and how it ended, players with their final participant projection, the derived leaderboard, canonical trades, and the battle event log.
- `GET /api/battles/history?limit&offset&status` lists every battle the caller was part of (host file + invite registry), with their own final row (`mySeat`, `myTrades`, `myNet`, `myScore`), the winner, and a `provisional` scoring flag.
- The record is **derived on read** (no second store to drift); the only persisted settlement fact is `settlement {status, policy, reached, at}`.

### Scoring (provisional compatibility adapter only)
> Final scoring, rewards, and outcome rules are intentionally **not part of this foundation**. The scoring policy comes from the contract (`config.scoring.policy`, default `legacy-compat`), and an explicit `scoringPolicy` object overrides it. Because `legacy-compat` is flagged `provisional: true`, every surface reports `scoring: {status:'provisional', id:'legacy-compat'}` and the UI/history marks results as provisionally scored — a battle never looks officially scored. Passing `scoringPolicy: null` no longer strips scoring: the adapter is derived from the contract so a completed battle still ranks its seats (regression-covered).

```
minTrades = 2
activity        = clamp(n/2, 0, 1)
winRateComp     = winRate/100
avgRComp        = clamp((avgR+1)/3, 0, 1)        // −1R → 0, +2R → 1
ddRatio         = maxDrawdown / (startingBalance × 0.06)
riskComp        = clamp(1 − ddRatio, 0, 1)        // ≤6% drawdown = full credit
consistencyComp = clamp(1 − CV(riskAmounts)×0.9, 0, 1)
raw  = 0.30·winRate + 0.30·avgR + 0.20·risk + 0.20·consistency
score = round(1000 × raw × activity)
detail: trades/wins/losses/net/winRate/avgR/maxDD/riskCV + component breakdown
```
- **Leaderboard** (completed): seats ranked by score desc, with full trade list (direction, entry, exit, sl, tp, entryTime, exitTime, exitReason, riskAmount, realizedR, pnl, setup) + **team aggregation** (average score, trades, winRate, avgR, maxDD, members).
- **Dashboard feed** (`/api/battles/feed`): active battles (with live own-seat `myStats`: balance, realized, unrealized, equity, trades, wins, **rank vs seated participants**, seat count), joinable invites, and completed results from the last 7 days (winner + leaderboard).

### Testing the foundation (`server/battle-timeline.test.js`)
Unit coverage lives in `server/battle.test.js` (one canonical timeline, per-viewer participant filtering with two userIds, lifecycle, settlement) and `server/battle-config.test.js` (the policy contract, the resolution table agreeing with `backtest.js`, base-resolution resolution). The cross-cutting properties are pinned end to end, against the REAL server on a scratch data dir, by `server/battle-timeline.test.js`:

1. the battle walks the **finest archived resolution** while the host's timeframe becomes the starting *display* timeframe, and the form's warm-up is converted into canonical bars;
2. two seats polling on **different display timeframes** are told one `cutTime` / `revealedBars` / `baseTimeframe` and sit on the same cursor;
3. every display series is built from revealed bars — the canonical series ends exactly at the cut, at most one coarser bar is forming, no completed coarser bar extends past the cut, and the forming bar's OHLC is **exactly** the aggregate of the revealed canonical bars in its window;
4. the **same order on both seats produces the same fill**: same entry, same exit price, the same fill bar, identical P&L and exit reason;
5. different orders stay independent: own long vs own short on the same bar, own stop/target, own trades, unchanged balances, and the other seat's decision never appears in this seat's history;
6. seat bar delivery (`full=1`, tail window, `from=N`) never ships a bar past the cut.

> An auth-off run owns both seats with one id, so the per-viewer *filter* is proven in `battle.test.js` (distinct userIds) and this test pins the policy contract it reads.

### Realtime
- WebSocket `/ws?battle=<id>` → `battle.cursor` (cursor, lifecycle, stateRevision, policy-filtered `participants`), `battle.seat` (a seat moved: `seat`, `kind`, `stateRevision`, `participants`) and `battle.status` (full public state). No-battle clients get `feed.changed`/`challenges.changed`. Private seat data is never pushed — the socket is unauthenticated by design, so only the viewer-neutral projection travels on it.

## 6.6 Workspaces (`assets/workspace.js` — chart persistence)
- Every timeframe is its own workspace: switching 1H→5M does NOT carry drawings/indicators across; each restores its own saved state.
- Key chain: `31trades.ws.v1.<userId>.<sessionId>.<timeframe>` → `{ drawings: [{kind,a,b,color}], indicators: {ema,sma,bb,vwap,rsi,macd}, chartState: {theme, rightOffset, visibleTime} }`.
- Practice keys by **symbol+timeframe** (timeframe switches create new sessions); Battle keys by **battle id + timeframe + seat**. localStorage only (per user).

## 6.7 Chart UI (backtesting.html)
- Lightweight Charts candlestick + volume; top toolbar (symbol, timeframe bar, indicators menu, settings, theme), left drawing-tool rail (cursor, trend/horizontal/vertical line, rectangle, measurement, text, clear), native crosshair/zoom/pan, compact replay strip (play/pause/step/speed/progress), collapsible order ticket (LONG/SHORT/CLOSE, order type, risk %, risk amount, position size, entry, SL, TP, planned R:R, confirm), bottom positions/orders/history/events/notes + balance/P&L/win-rate/avg-R/expectancy/profit-factor/drawdown, Results and AI tabs.

## 6.8 Implemented vs planned (this section)
| Feature | Status |
|---|---|
| Historical OHLCV (TV + synthetic fallback) | **IMPLEMENTED** |
| Replay engine (hidden future candles, play/pause/step/seek/reset/speed) | **IMPLEMENTED** |
| LONG/SHORT/CLOSE + SL/TP simulation, intrabar fills | **IMPLEMENTED** |
| Trade event/action recording | **IMPLEMENTED** (actions[] audit trail) |
| Session persistence per user (file; DB swap planned) | **IMPLEMENTED** (file only) |
| Results/analytics (equity curve, R distribution, by-setup/session/time/exit) | **IMPLEMENTED** |
| Practice view isolated from live (analytics/insights tagged BACKTEST) | **IMPLEMENTED** |
| AI backtest coach | **IMPLEMENTED** |
| Battle: create/join/invite/control/enter/close | **IMPLEMENTED** |
| Battle: configuration contract (policy slots, implemented-flags, capability catalogue, refuse-not-fake) | **IMPLEMENTED** |
| Battle: availability → challenge → lobby handshake (15-min TTL) | **IMPLEMENTED** (quick-match opponent picker is an explicit PLACEHOLDER) |
| Battle: opponent-state synchronization driven by a visibility policy | **IMPLEMENTED** (default exposes presence only) |
| Battle: settlement record + canonical BATTLE trade dataset + battle history | **IMPLEMENTED** |
| Battle: synchronized replay + private seats + anti-cheat | **IMPLEMENTED** |
| Battle: canonical base-resolution timeline + server-owned cut time + per-seat display timeframe (`/timeline`, forming candle, no coarse-bar leak) | **IMPLEMENTED** |
| Battle: two-seat timeline end-to-end test (real server, two seats, two display timeframes, one market moment, identical fills, independent positions) | **IMPLEMENTED** — `server/battle-timeline.test.js` (in `npm test`) |
| Battle: seat view runs on the SAME chart as practice (chart-test.html battle driver, HUD orders → battle seat API) | **IMPLEMENTED** |
| Battle: blended scoring + team aggregation + leaderboard + dashboard feed | **IMPLEMENTED** |
| Battle: WebSocket realtime | **IMPLEMENTED** |
| Battle: battle replay with opponent-trade reveal | **PLANNED / NOT IMPLEMENTED** (leaderboard reveals trades post-hoc; no replay mode) |
| Duo/1v1/2v2/5v5/10v10 formats | **PLACEHOLDER** (seats are free-form; no matchmaking/ranked) |
| Battle categories (ICT/SMC presets) | **REMOVED** — users create/join open battles with free-form seats/teams |
| Squad chat / voice in battle | **PLANNED / NOT IMPLEMENTED** |
| Spread/slippage/commission/partial exits/multiple positions | **PLANNED / NOT IMPLEMENTED** (explicitly listed as "later" in code comments) |
| Live TradingView replay (true ReplayMode) | **IMPLEMENTED but gated** (requires session cookies env vars; falls back to local mode) |
| Workspace persistence (drawings/indicators/chart state per tf) | **IMPLEMENTED** (localStorage) |
