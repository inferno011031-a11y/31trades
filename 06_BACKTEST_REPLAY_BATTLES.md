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

## 6.5 Battles (`server/battle.js`, page mode `?mode=battle`)

### Canonical-timeline architecture
- **One `Battle`** owns one `candles[]` (fetched once via marketdata) + a server-owned `cursor`. Every seat gets a `BacktestSession` over the **same candles array**; `setCursor` advances all seats bar-by-bar on the same bar (fair SL/TP event ordering).
- **Private seats**: each seat's position/trades/balance are private (`seatState` only returns your own); the public state exposes seats (id/name/team/taken) + cursor + current candle only. Anti-cheat: entries must be within the current visible bar's low/high (±0.1%).

### Lifecycle
- `status`: `lobby` → `running` → `completed`.
- Create: host picks symbol/tf/window/startBars/startingBalance/riskModel/seat names (max 10)/teams; host takes seat 0. Emits `created`.
- Join/accept invite: claim first free seat (lobby or running only).
- Host controls (only host): play/pause/step/seek/reset/complete. Auto-completes at the final bar.
- `actions[]` audit log per battle (enter/close per seat with cursor).
- Persistence: host-owned `data/battle-<hostId>.json`; cross-user invite registry `battle-registry.json` (battleId→hostId); per-invitee `battle-invites-<userId>.json`.
- Invites: shareable code (8 chars, unambiguous alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), `battles.html?invite=<code>` link, in-app invite for known emails (`user-directory.json`), `mailto:` for real email (20 max).

### Scoring (`scoreSeat`) — blended 0–1000, process over profit
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

### Realtime
- WebSocket `/ws?battle=<id>` → `battle.cursor` + `battle.status` pushes; no-battle clients get `feed.changed`. Private data is never pushed.

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
| Battle: synchronized replay + private seats + anti-cheat | **IMPLEMENTED** |
| Battle: blended scoring + team aggregation + leaderboard + dashboard feed | **IMPLEMENTED** |
| Battle: WebSocket realtime | **IMPLEMENTED** |
| Battle: battle replay with opponent-trade reveal | **PLANNED / NOT IMPLEMENTED** (leaderboard reveals trades post-hoc; no replay mode) |
| Duo/1v1/2v2/5v5/10v10 formats | **PLACEHOLDER** (seats are free-form; no matchmaking/ranked) |
| Battle categories (ICT/SMC presets) | **REMOVED** — users create/join open battles with free-form seats/teams |
| Squad chat / voice in battle | **PLANNED / NOT IMPLEMENTED** |
| Spread/slippage/commission/partial exits/multiple positions | **PLANNED / NOT IMPLEMENTED** (explicitly listed as "later" in code comments) |
| Live TradingView replay (true ReplayMode) | **IMPLEMENTED but gated** (requires session cookies env vars; falls back to local mode) |
| Workspace persistence (drawings/indicators/chart state per tf) | **IMPLEMENTED** (localStorage) |
