# BattleX Replay Engine — Rules, Root Causes & Asset Onboarding Guide

> Read this first if candles stop painting during replay.

---

## What Broke & Why (The Full Story)

### Problem: Candles not appearing during replay

Three separate bugs were stacked on top of each other. Each one alone would break replay. Together they made it seem like everything was completely broken.

---

### Bug 1 — loadDataset() was nuking the replay cursor mid-flight

**What happened:**
Every time TradingView called getBars for a replay symbol (like XAUUSD_REPLAY_xxx), our code checked if the engine data was up to date. If the bar array reference had changed, it called BattleXReplay.loadDataset() to sync. But loadDataset() resets replayStatus back to idle and wipes the cursor.

**Side effect:**
getVisibleCandles() checks replayStatus === idle and when true, returns ALL historical bars instead of the cut slice. TradingView loaded 2,500 bars (the entire month) into its cache — ending at Feb 29.

**Why candles stopped:**
TradingView putToCacheNewBar checks that every new bar time is strictly GREATER than the last cached bar. The last cached bar was Feb 29. We were sending Feb 1 bars (just after the cut). Feb 1 is earlier than Feb 29 → TradingView silently dropped every single bar.

**The fix applied:**
In getBars, if replayCursorIndex is not null (replay is active), skip loadDataset() entirely. Just update the historicalCandles array reference directly, without touching cursor or status.

Also in getVisibleCandles(): if replayCursorIndex is a number, ALWAYS return the sliced view even if replayStatus somehow reads as idle.

---

### Bug 2 — Multiple stale subscribers were getting onTick calls

**What happened:**
Every time subscribeBars is called, we stored the callback in a Map keyed by listenerGuid. When the user did a second cut (new replay session), TradingView subscribed again with a new guid. But the old XAUUSD guid and the old replay guid stayed in the Map.

**Side effect:**
When we dispatched onTick(bar), we called every stored callback — including the stale XAUUSD feed (which had Feb 29 23:45 as its last bar) and old replay feeds. All of them threw time violations.

**The fix applied:**
Track window._activeSubscriberGuid — always the most recently subscribed guid. During onTick dispatch, only call the active guid callback. Ignore all others.

---

### Bug 3 — _onResetCacheNeeded was destroying the subscription after every tick

**What happened:**
We had a "Strategy 2" fallback that called TradingView onResetCacheNeededCallback after every tick. This tells TradingView "data has changed, reload everything." TradingView responds by calling getBars and subscribeBars fresh — creating a brand new subscription and destroying the old one.

**Side effect:**
Only the FIRST onTick ever painted a candle. After that the subscription was reset and all subsequent candles were silently dropped.

**The fix applied:**
Removed Strategy 2 entirely. onTick alone is sufficient. TradingView appends each bar to its cache incrementally when onTick is called — no reset needed.

---

## How to Diagnose This Problem If It Comes Back

Open browser DevTools Console. Look for these exact messages:

| Console message | What it means | Which bug |
|---|---|---|
| putToCacheNewBar: time violation, previous bar time: Feb 29 | TV cache has ALL bars (full dataset leaked) | Bug 1: loadDataset reset cursor |
| time violation on XAUUSD feed (not replay feed) | Stale old subscriber still in Map | Bug 2: dispatching to all instead of active |
| Only one candle, then nothing | Subscription destroyed after tick 1 | Bug 3: resetCacheNeeded called after each tick |
| [REPLAY PLAY] 0 -> 1 repeating from 0 | Cursor keeps resetting | loadDataset called while replay is active |
| [REPLAY] No active subscriber | _activeSubscriberGuid is null | TV subscribeBars not yet called — wait for chart to load |

---

## Four Rules That Must Never Be Broken

### Rule 1 — Never call loadDataset() while replay cursor is active

  If window.BattleXReplay.state.replayCursorIndex is NOT null:
    Do NOT call BattleXReplay.loadDataset()
    Instead directly update: state.historicalCandles = newBarsArray

Calling loadDataset() resets replayStatus to idle and wipes replayCursorIndex. getVisibleCandles() then returns ALL bars and TV loads the entire dataset.

---

### Rule 2 — Never call chart.resetData() or _onResetCacheNeeded() during active replay

  During replay playback NEVER call:
    chart.resetData()
    chart.setSymbol() (except for initial cut)
    _onResetCacheNeeded()
    _resetCacheCallbacks.forEach(cb => cb())

All of these tell TradingView to start over. TradingView destroys the current onTick subscription and creates a new one. The old onTick you were using to paint candles is now dead.

---

### Rule 3 — Only dispatch onTick to the most recently subscribed guid

  window._activeSubscriberGuid tracks the latest guid.
  Only call: window._subscribers.get(window._activeSubscriberGuid)(bar)
  Never loop all subscribers with .forEach()

Old symbols and old replay sessions leave dead callbacks in the Map. Calling them causes time violations in TradingViews internal cache.

---

### Rule 4 — Bar time in onTick must match the format getBars returns

  Our _candlesCache stores times in MILLISECONDS (time > 1e11).
  onTick must receive bars with time in MILLISECONDS.
  setVisibleRange uses SECONDS (divide ms by 1000 before passing).
  periodParams.from / periodParams.to in getBars are in SECONDS.

Never convert onTick bars from ms to seconds unless getBars also returns seconds.

---

## How to Add New Assets (EURUSD, NASDAQ, NQ, etc.)

### Step 1 — Add the symbol to resolveSymbol

In chart-test.html, find the resolveSymbol function. Add a branch:

    // EURUSD example
    if (symbolName.startsWith('EURUSD')) {
        symbolInfo = {
            name: symbolName,
            ticker: symbolName,
            description: 'Euro / US Dollar',
            type: 'forex',
            session: '24x5',
            timezone: 'Etc/UTC',
            exchange: '',
            minmov: 1,
            pricescale: 100000,   // 5 decimal places for forex
            has_intraday: true,
            supported_resolutions: ['1', '5', '15', '30', '60', '240', 'D'],
            volume_type: 'lot',
            data_status: 'streaming'
        };
    }

pricescale by asset type:
  - Gold XAUUSD: 100 (2 decimal places)
  - Forex pairs EURUSD GBPUSD: 100000 (5 decimal places)
  - US indices NQ ES: 4 (tick size 0.25 = pricescale 4)
  - Crypto BTC: 100 or 1000 depending on price range

---

### Step 2 — Add the candles API endpoint in server.js

The GET /api/backtest/candles route must accept the new symbol name:

    GET /api/backtest/candles?symbol=EURUSD&timeframe=15m&count=2500&period=feb2024

Response format (time must be UNIX seconds — 10 digits):

    { "ok": true, "candles": [
        { "time": 1706745600, "open": 1.08234, "high": 1.08290, "low": 1.08200, "close": 1.08260, "volume": 12345 }
    ]}

The code normalizes: if time > 1e11 it is already ms. If time < 1e11 it multiplies by 1000. Either seconds or ms works — but be consistent per symbol.

---

### Step 3 — CRITICAL: Fix baseSym extraction in getBars

In chart-test.html, getBars, currently:

    const baseSym = symbolInfo.name.startsWith('XAUUSD') ? 'XAUUSD' : symbolInfo.name;

This only handles XAUUSD. For new assets extend it:

    function getBaseSym(name) {
        if (name.startsWith('XAUUSD')) return 'XAUUSD';
        if (name.startsWith('EURUSD')) return 'EURUSD';
        if (name.startsWith('GBPUSD')) return 'GBPUSD';
        if (name.startsWith('NASDAQ') || name.startsWith('NQ')) return 'NQ';
        return name.replace(/_REPLAY_\d+$/, '');  // strip _REPLAY_timestamp suffix
    }
    const baseSym = getBaseSym(symbolInfo.name);

If baseSym is wrong, the cache key is wrong, loadDataset gets called, cursor resets, all bars leak to TV. Bug 1 comes back.

---

### Step 4 — Replay engine needs zero changes for new assets

BattleXReplay in replay-engine.js only stores OHLCV bars with timestamps. It does not know or care about the symbol. No changes needed there for any asset.

---

### Step 5 — executeCut and the play flow are asset-agnostic

executeCut(barIndex) already generates SYMBOLNAME_REPLAY_timestamp from chart.setSymbol(). It works for any symbol as long as Steps 1-3 are done.

---

## Quick Checklist Before Going Live With a New Asset

  [ ] resolveSymbol handles NEWSYMBOL and NEWSYMBOL_REPLAY_* patterns
  [ ] pricescale is correct for that assets decimal precision
  [ ] /api/backtest/candles?symbol=NEWSYMBOL returns data
  [ ] getBaseSym() in getBars strips _REPLAY_timestamp suffix correctly
  [ ] Candle times from API are consistently seconds or consistently ms (not mixed)
  [ ] No loadDataset() call path can be triggered while replayCursorIndex is not null
  [ ] chart.resetData() is never called from any replay step or tick handler
  [ ] _onResetCacheNeeded is never called from any replay step or tick handler

---

## Files That Control Replay Behavior

| File | What it controls |
|---|---|
| 31trades/replay-engine.js | Core state machine: cursor, visibleCandles, step, play, pause, reset |
| 31trades/chart-test.html | TradingView datafeed (getBars, subscribeBars, onTick dispatch), executeCut, replay dock UI |
| 31trades/server.js | API routes including /api/backtest/candles |
| 31trades/tests/replay-engine.test.js | 48 unit tests for the engine — run after any engine change |
| 31trades/tests/replay-playback.test.js | 8 playback integration tests |
