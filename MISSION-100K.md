# MISSION 100K
### The BattleXJournal playbook for a trader's first $100,000

> Status: **ACTIVE READ MODEL** — Part I–III describe systems that exist today.
> Part IV voice replay orders are now implemented behind explicit confirmation;
> Mission progress is exposed as a read-only view over the canonical ledger.

---

## Part I — The Mission

Most traders don't fail because they lack strategy videos. They fail because they
have **no measurable system**: no data, no structure, no analysis, no insight.
Mission 100K turns that failure mode into a game with real stakes.

**The premise:** a trader does not "get" $100K. They *build* it through verified,
journaled, reviewed executions. BattleXJournal is the referee, the scorekeeper,
and the coach.

```
DATA  →  STRUCTURE  →  ANALYSIS  →  INSIGHT  →  CAPITAL
```

Every dollar of the 100K must pass through the same canonical pipeline:

```
trade logged → rule engine → risk engine → analytics → discipline audit → mission credit
```

A trade that isn't journaled doesn't count toward the mission. A trade that
breaks rules counts, but **costs** the trader their discipline score — and the
next checkpoint gate demands a minimum score. The mission cannot be scammed by
one lucky oversized win; it can only be walked, rung by rung.

---

## Part II — The Ladder (milestone architecture)

The mission is ten rungs of $10K in *verified net P&L* on the trader's primary
mission account. Each rung is a **checkpoint**, and each checkpoint has gates.

| Rung | Checkpoint | Gates to advance |
|------|------------|------------------|
| 1 | $10K | 50+ journaled trades, discipline score ≥ 70 |
| 2 | $20K | Max drawdown < 15% of peak equity |
| 3 | $30K | Profit factor ≥ 1.5 across the rung |
| 4 | $40K | One full month with zero rule violations |
| 5 | $50K — **the halfway wall** | 100-day streak of journaled sessions, backtest proof of edge (see Part III) |
| 6 | $60K | Avg R ≥ 0.4 on the rung |
| 7 | $70K | Two consecutive profitable months |
| 8 | $80K | Risk engine: zero max-daily-loss breaches |
| 9 | $90K | Full season review (voice debriefs, Part III) |
| 10 | **$100K** | Mission complete — season report, permanent profile badge |

Checkpoint rules:

- Gates are computed from the **existing engines** (`computeAnalytics`,
  rule engine adherence states, risk engine drawdown/limits) — no new math.
- Rungs are computed per account; the mission account is chosen at enrollment.
- Checkpoints are **read-only views** over the same trade ledger the journal
  already persists — no duplicate tables, no duplicate truth.

---

## Part III — The Systems (what exists today)

### 3.1 The proving ground — backtesting
Before a trader risks a real dollar at rung 5, they prove the edge on history.
The backtesting workspace (replay engine, TradingView Advanced Charts, session
config panel) already records every replay trade into the same analytics
pipeline. Mission 100K consumes those results as **proof of edge**.

### 3.2 The recorder — voice logging (shipped)
A trader mid-session doesn't stop to type. The voice parser (v3, shipped and
pushed) converts a spoken transcript into a canonical trade:

- symbol, direction, size (micro/mini normalized), signed P&L with breakeven
  and risk/target disambiguation, session, setup, confluences
- emotion, tone confidence, tri-state rules-followed
- execution quality grade (A+ → D) that judges the **decision, not the outcome**
- multi-trade transcripts split into separate trades

Voice trades enter through the journal's confirm card → prefill → Save, and are
tagged `source: 'VOICE'` so analytics can compare spoken-entry vs manual
discipline. No API keys are required — the deterministic parser works offline;
an LLM key (optional, server-side) only improves messy-transcript extraction.

### 3.3 The conscience — discipline + risk
The rule engine evaluates every trade (BLOCK / WARN / OK), the risk engine
tracks equity, drawdown, and max daily loss, and the AI mentor reads emotion
fields (FOMO, Revenge, …) to surface tilt patterns. Mission gates read these
same signals.

---

## Part IV — SHIPPED: Voice in the Backtesting Flow

> Spoken replay orders are confirmation-gated and use the replay engine's
> existing fill/exit pipeline. No spoken P&L is trusted.

### 4.1 The experience

During a backtest replay, the trader narrates out loud instead of clicking
through the entry form:

```
Replay running (15m XAUUSD, Jan 2024)
  → trader taps the mic on the BattleX Execution HUD
  → speaks: "Shorting gold here at 2035, stop 2040, target 2022,
             liquidity sweep into the FVG, half a lot, feeling clean"
  → parser returns structured trade; HUD shows a compact confirm chip
  → trader taps Confirm (or keyboard: Enter)
  → trade is simulated against replay candles on SL/TP touch
  → on exit, full record lands in the SAME pipeline as manual replay trades
```

The spoken trade is a **pending order inside the replay engine**, not a journal
short-cut: entry/SL/TP are honored against the candle stream, exits fire
mechanically, and the realized result is what gets logged — not what the
trader *said* they made.

### 4.2 Backend implementation

| Piece | Design |
|---|---|
| Endpoint | Reuse `POST /api/ai/voice-parse` (exists) — add `mode: 'replay'` |
| New route | `POST /api/backtest/sessions/:id/voice-order` — takes parsed fields + session id; creates a pending replay order (entry, SL, TP, size, direction) |
| Order lifecycle | pending → filled (price touch) → exited on SL/TP touch or manual close; reuses the replay engine's existing order/exit machinery |
| Logging | On exit, `logTradePipeline` fires exactly as for manual replay trades, with `source: 'VOICE'` and `origin: 'backtest'` |
| Analytics | Session/strategy/asset analytics pick it up for free — zero new aggregation code |
| Schema | No new tables. Pending order lives in the backtest session state; final trade lands in the standard trades ledger |
| Quota | Each voice parse = 1 AI request via `Access.enforceAiQuota` (same as journal voice) |
| No keys | Deterministic parser path must work with zero API keys, same as journal voice |

### 4.3 Edge cases to handle (from the journal voice build — carry them over)

- Multi-trade narration → split into separate pending orders, confirmed one at a time
- Speech self-corrections ("one lot… actually two micros") → last mention wins
- Missing SL/TP → order requires explicit confirm; no silent defaults
- Rejected orders (risk limit in replay config) → BLOCK surfaced in HUD before fill
- Duplicate confirms → idempotent by client-generated order nonce
- Mic permission denied → type/paste path is identical

### 4.4 Acceptance criteria

1. A spoken replay trade appears in the session's trade list with the mic badge
2. SL/TP exits fire mechanically against replay candles
3. `GET /api/backtest/history/trades` returns it with `source: 'VOICE'`
4. Analytics year/month/session breakdowns include it with zero new code
5. All existing voice-parser tests still pass; new tests cover order fill/exit
6. Works with no API keys configured

---

## Part V — Season reviews

At every checkpoint the trader records a **voice debrief** — the same parser,
same confirm flow, extracting the season's pattern claims (best session, worst
habit, tilt triggers). These debriefs become the narrative layer of the season
report: numbers from the engines, story from the trader's own mouth.

---

## Part VI — Open decisions (for later)

- Whether mission progress feeds leaderboards/Squads (07) or stays private
- Whether rung 10 grants a permanent profile badge only, or rewards (08) too
- Whether backtest voice-orders count toward edge-proof gates automatically
  or require a minimum replay-trade count first
- Battle Battles (06) integration: mission checkpoints as battle entry gates

*Last updated: 2026-09-21 — voice parser v3 and confirmed backtest voice orders shipped; Mission read model added.*
