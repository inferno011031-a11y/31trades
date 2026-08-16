# 04 — TRADING ENGINE, RISK ENGINE, DISCIPLINE + BEHAVIOR ENGINE

> All formulas are literal from `src/core/index.js` (and `server.js` RiskEvents). These are the **single source of truth** shared by browser and server.

---

## 4.1 ASSET SPEC ENGINE (per-asset P&L / sizing / units)

`ASSET_SPECS` in `src/core/index.js` (first match wins, order matters):

| Class | Match | pip | val ($ per 1.0 unit per 1 pip) | unit | sizeLabel | decimals |
|---|---|---|---|---|---|---|
| Forex (JPY pairs) | USDJPY, EURJPY, GBPJPY, AUDJPY, CADJPY, CHFJPY, NZDJPY | 0.01 | 10 | Pips | Lots | 3 |
| Forex (majors) | EURUSD, GBPUSD, AUDUSD, NZDUSD, USDCAD, USDCHF, EURGBP, EURCHF, AUDNZD, EURNZD, GBPAUD, GBPNZD, EURCAD, GBPCAD, AUDCHF, CADCHF | 0.0001 | 10 | Pips | Lots | 5 |
| Metals | XAU* (0.1/10/Lots/2), XAG* (0.01/5), XPT/PD* (0.1/10) | — | — | Pips | Lots | — |
| Energy | USOIL, UKOIL, XTIUSD, XBRUSD, BRENT, CL, WTI, OIL (0.01/10/Contracts/2); NATGAS/XNGUSD/NG (0.001/10/3) | — | — | Pips | Contracts | — |
| Ag/softs | COFFEE, SUGAR, COCOA, COTTON, WHEAT, CORN, SOYBEAN, OATS, RICE, KC, SB, CC (0.01/1) | — | — | Pips | Contracts | 2 |
| Indices | NAS100, US100, US30, SPX500, SP500, DAX40, GER40, DE40, UK100, JPN225, NIKKEI, AUS200, EU50, FRA40, HK50, NQ, ES, YM | 1 | 1 | Points | Contracts | 0 |
| Crypto | BTC, ETH, SOL, XRP, ADA, DOGE, DOT, LTC, BNB, AVAX, MATIC, LINK, UNI, SHIB, PEPE, XLM, NEAR, APT, ARB, OP, SUI, INJ, SEI, TIA | 1 | 1 | Coins | Coins | 0 |
| Stocks | any `^[A-Z]{1,5}$` ticker (AAPL, TSLA…) | 0.01 | 0.01 | Cents | Shares | 2 |
| Fallback | everything else | 1 | 1 | Units | Units | 2 |

### Formulas (exact)
```
P&L = (exit − entry) ÷ pip × size × val × sign(dir)          // sign: Long=+1, Short=−1; rounded to 2dp
Per-unit contract value = val ÷ pip                          // $ per 1.0 price move per 1.0 unit
Position size = risk $ ÷ (|entry − stop| × contract value)   // calcPositionSize
Actual risk $ = |entry − stop| × size × contract value       // calcRiskDollars
R:R (planned) = |tp − entry| ÷ |entry − stop|                // calcRR
Price formatting = toFixed(spec.decimals)
```

`assetClassOf(symbol)` → 'Forex' | 'Commodities' | 'Indices' | 'Crypto' | 'Stocks' | 'Other' (fallback).

## 4.2 TRADE LIFECYCLE

### Creation — the 7-step pipeline (`logTradePipeline`)
1. **Idempotency:** if `rawTrade.id` already exists in the ledger, return it as-is (client-generated ids → safe replay).
2. **Resolve context:** account must exist (`account_id` required). Picks the active assignment (strategy-filtered, then any). Self-heals: if no assignment → auto-provisions a RiskPolicy (defaults `{ddModel:'static', maxDailyLoss:100, maxTotalDrawdown:500, riskPerTrade:25, riskBasis:'money', maxOpenRisk:50, openBasis:'money', maxTrades:5, warn:[50,70,90]}`), an active strategy (or creates "Manual Trading"), and reassigns. Also provisions the standard rule sets.
3. **Load policy:** the immutable `config_version_id` the assignment points at.
4. **Evaluate:** asset-aware derivation first —
   - if `pnl` missing but size+entry+exit present → `pnl = calcPnl(...)`;
   - if `size` missing but pnl+entry+exit present → `size = |pnl| ÷ (|exit−entry| × contractValue)`;
   - then `evaluateRules()` over the trade draft (see 4.4). Hard FAILs → rule result `BLOCK` (if any BLOCKING key) / `VIOLATION` (any hard fail) / `PASS`.
5. **Persist evidence:** push the trade with `adherence_result`, `block_reason`, `created_at`; compute `r = pnl ÷ risk` when missing and risk > 0; enrich derived fields; write evaluations + violations.
6. **Update state:** `account.current_equity += trade.pnl`.
7. **Publish events:** `trade.created` on the bus; sync to backend.

### Editing (`TradeService.update`)
- Updatable fields: symbol, dir, setup, session, emotion, adherence, entry, exit, size, risk, pnl, note, reviewed, stop, tp, ts.
- Recomputes `r = pnl ÷ risk` (if risk > 0), adjusts `current_equity += (newPnl − oldPnl)`, re-runs `enrichAllDerived()`, re-evaluates against the **same immutable versions** (history preserved), rewrites evaluations/violations, re-derives `adherence_result`/`block_reason`, logs an event.

### Deletion (`TradeService.remove`)
- Removes the trade + its evaluations/violations, `current_equity -= pnl`, re-derives, logs 'Deleted / reversed'.

### Fields available on a trade (after enrich)
`id, ts, account_id, strategy_id, config_version_id, strategy_version_id, symbol, dir, setup, session, emotion, adherence, entry, exit, size, risk, pnl, r, stop, tp, note, reviewed, adherence_result, block_reason, evidence, created_at` + derived `hour, dow, assetClass, timeframe, holdMin, notes, postLoss, delayMin`.

### Importing
**UNKNOWN — NOT FOUND IN IMPLEMENTATION.** No trade-import, broker-sync, or CSV import endpoint exists. (Brokers are a connect-status registry only; the onboarding copy mentions "auto-import live trades from MetaTrader, TradingView, cTrader" but no such importer is implemented.)

### Screenshots / evidence
- `evidence` JSONB array `[{kind:'screenshot', url:'…'}]` stored on the trade; the `screenshot` rule checks `evidence.screenshot` truthiness. **No file-upload endpoint exists** (screenshots are referenced, not uploaded).

### Trade review
- `reviewed` boolean on the trade; toggled via PATCH /api/trades/:id. Pending-review notifications derive from `!t.reviewed`.

### Closed/open states
- **Live trades: no open/closed state.** Every logged trade is a closed record (entry/exit/pnl). Open positions exist **only in the backtest/battle simulation engine** (see 06).

---

## 4.3 RISK ENGINE

### `riskState(accountId)` — the single live snapshot
```
policy       = activePolicy(accountId)  (latest RiskPolicy version)
dailyRisk    = policy.values.maxDailyRisk || policy.values.maxDailyLoss || 0
lossLimit    = policy.values.maxDailyLoss || 0
ddLimit      = policy.values.maxTotalDrawdown || 0
riskPerTrade = policy.values.riskPerTrade || 0
maxTrades    = policy.values.maxTrades || Infinity

today        = startOfDay(now); day = trades of the account on that day
riskUsed     = Σ day.risk
lossUsed     = |Σ day.pnl where pnl < 0|            // absolute realized loss today
riskRemaining  = max(0, dailyRisk − riskUsed)
lossRemaining  = max(0, lossLimit − lossUsed)

// drawdown from the realized equity curve (chronological)
eq=starting_balance, peak=starting_balance, maxDD=0
for t in trades sorted by ts: eq+=t.pnl; peak=max(peak,eq); maxDD=max(maxDD, peak−eq)
currentDD     = max(0, peak − current_equity)
drawdownRemaining = max(0, ddLimit − currentDD)

maxAllowedRisk = min(riskPerTrade||∞, riskRemaining, lossRemaining, drawdownRemaining, maxOpenRisk||∞)
recommendedMaxRisk = maxAllowedRisk (rounded)
```

### Status bands (exact precedence)
```
warn = policy.values.warn || [50, 70, 90]      // 3 bands: caution, high, limit
riskPct = dailyRisk ? riskUsed/dailyRisk*100 : 0
ddPct   = ddLimit  ? currentDD/ddLimit*100   : 0

status='LIMIT'   label='LIMIT BREACHED'  if (ddLimit && currentDD>=ddLimit)
                                        or (lossLimit && lossUsed>=lossLimit)
                                        or (dailyRisk && riskUsed>=dailyRisk)
status='HIGH'    label='HIGH RISK'       elif riskPct>=warn[2] or ddPct>=warn[2]
status='CAUTION' label='CAUTION'         elif riskPct>=warn[0] or ddPct>=warn[0]
else             status='NORMAL'         label='SAFE'
```
Output fields: `account_id, currency, policyVersion, equity, starting_balance, day, dailyRiskBudget, riskUsed, riskRemaining, dailyLossLimit, lossUsed, lossRemaining, tradeCount, maxTrades, currentDrawdown, maxDrawdown, drawdownLimit, drawdownRemaining, riskPerTradeLimit, maxOpenRiskLimit, maxAllowedRisk, recommendedMaxRisk, status, statusLabel`.

### `preTradeCheck(accountId, draft)` — deterministic decision
```
checks = evaluateRules(draft, policy override, strategy override, asOf=now)
rs = riskState(accountId)
blocks: [if t.risk > rs.riskRemaining     → 'Daily risk budget — only $X remaining'
         if t.risk > rs.lossRemaining     → 'Daily loss budget — only $X remaining'
         if t.risk > rs.drawdownRemaining → 'Drawdown buffer — only $X remaining']
state = 'BLOCKED' if blocks
      | 'VIOLATION' if any hard FAIL
      | 'CAUTION'  if any soft FAIL
      | 'CLEAR'
output: { account_id, state, checks, blocking_rules: [hard explanations + blocks], recommended_max_risk }
```

### Risk events feed (`RiskEvents` in server.js)
Per day, derived from the ledger + policy:
- `risk-breach` (critical) — Σ day risk > maxDailyRisk.
- `high-risk` (warning) — Σ day risk ≥ 70% of the daily budget.
- `loss-breach` (critical) — |Σ day losses| > maxDailyLoss.
Last 20, newest first.

### Account-level defaults (used in seeding / provisioning)
- Prop Firm A (demo): `ddModel:'trailing', maxDailyLoss:100, maxTotalDrawdown:500, riskPerTrade:25, maxOpenRisk:50, maxTrades:3, warn:[50,70,90]`.
- Personal (demo): `ddModel:'static', maxDailyLoss:250, maxTotalDrawdown:1500, riskPerTrade:50, maxOpenRisk:100, maxTrades:5`.
- New account defaults: `dailyLoss 100, maxDD 500, risk 25, openR 50, maxTrades 5, ddModel 'static'` (aliases `dailyLossLimit`/`maxDrawdown`/`riskPerTrade` accepted).

---

## 4.4 RULE ENGINE (evaluation + blocking)

`BLOCKING_KEYS = ['riskPerTrade', 'dailyRisk', 'dailyLoss', 'maxTrades', 'maxOpenRisk']` — a hard FAIL on any of these → `adherence_result = 'BLOCK'` (the trade is still saved, but flagged as blocked).

Evaluators (exact logic):

| key | expected | actual | pass when |
|---|---|---|---|
| riskPerTrade | `$<policy.riskPerTrade\|\|25>` | `$t.risk` | t.risk ≤ limit |
| dailyRisk | `$<maxDailyRisk\|\|maxDailyLoss\|\|∞>` | Σ risk of the day (incl. this trade) | used ≤ limit |
| dailyLoss | `$<maxDailyLoss\|\|∞>` | \|Σ day losses\| | used ≤ limit |
| maxTrades | `<maxTrades\|\|∞>` | count of day's trades (incl. this) | count ≤ limit |
| maxOpenRisk | `$<maxOpenRisk>` | '—' | always SKIP (not evaluated) |
| cooldown | `<cooldown\|\|0> min` | minutes since last trade | skipped unless previous trade was a loss; pass when ≥ limit |
| stopRequired | 'Yes' | stop present | `!!t.stop` (skipped if no stop AND no screenshot evidence) |
| minRR | `<strategy.minRR\|\|1.5>R` | computed R (from entry/stop/tp, else \|pnl\|/risk) | rr ≥ min |
| noRevenge | 'No' | Yes/No | emotion !== 'Revenge' |
| noFomo | 'No' | Yes/No | emotion !== 'FOMO' |
| noAddLoser | 'No' | Yes/No | !t.addedToLoser |
| allowedSessions | strategy sessions joined | t.session | session ∈ allowed (SKIP if none configured) |
| approvedSetups | strategy setup list | t.setup | setup ∈ list (SKIP if none) |
| earlyExit | 'No early exit' | Yes/No | adherence !== 'early exit' |
| movingStop | 'No moving stop' | Yes/No | adherence !== 'moving stop' |
| screenshot | 'Attached' | Attached/Missing | !!evidence.screenshot |
| preTradeNote | 'Written' | Written/Missing | !!t.note |
| endOfDayReview | 'Done' | Done/Pending | !!t.reviewed |

- Evaluation uses the rule-set version **active at the trade's timestamp** (`config_version_active_at('RuleSet', …)`) and the policy/strategy versions frozen on the trade.
- Results → `trade_evaluations` rows (state PASS/FAIL/SKIP); hard FAILs → `violations` rows.

---

## 4.5 DISCIPLINE + BEHAVIOR ENGINE

### Discipline score — exact algorithm (`disciplineState`)
Six weighted dimensions (`DISC_DIMS`):

| key | label | weight | rules |
|---|---|---|---|
| risk | Risk | 0.25 | riskPerTrade, dailyRisk, dailyLoss, maxOpenRisk |
| strategy | Strategy | 0.20 | allowedSessions, approvedSetups, minRR, stopRequired |
| execution | Execution | 0.20 | earlyExit, movingStop, stopRequired |
| frequency | Frequency | 0.15 | maxTrades, cooldown |
| session | Session | 0.10 | allowedSessions |
| behavior | Behavior | 0.10 | noRevenge, noFomo, noAddLoser, cooldown |

```
For each trade in range: evals = evaluateRules(trade).filter(state !== 'SKIP')
Per dimension: score = round(passed/evalsInDim*100) (null when no evaluations)
Overall: score = round( Σ(weight_i × score_i) ÷ Σ(weight_i for scored dims) )
```
- Also returns per-rule stats (passed/total/rate sorted desc → `strongest` = rules[0], `weakest` = last), `violations` count (hard-rule FAILs in range), and **clean-day streaks**:
```
for each day with trades, sorted: if any hard FAIL that day → streak=0; else streak++, bestStreak=max
cleanDayStreak = current streak; bestCleanDayStreak = all-time best
```

### Every input that affects the score
- Each trade's: risk, emotion, adherence, note, reviewed, stop, tp, entry/exit, session, setup, ts; plus the account policy (limits), the strategy version (minRR/sessions/setups), and the enabled rule set. **Everything is rule-driven** — the score is a weighted pass-rate of the user's enabled rules.

### Events that increase/decrease it
- Decrease: any hard-rule FAIL (risk/daily/loss/trades) on a trade, any soft-rule FAIL (minRR, cooldown, stopRequired, earlyExit, movingStop, noRevenge/FOMO, screenshot, preTradeNote, endOfDayReview).
- Increase: any rule PASS; the score is the weighted pass rate, so more clean trades raise it; a full clean day increments the clean-day streak.

### Behavior signals recognized by the engine (fields on trades)
- `emotion`: 'Calm' | 'Confident' | 'Anxious' | 'Revenge' | 'FOMO' (free text otherwise).
- `adherence`: 'followed' | 'early exit' | 'moving stop' | 'no-plan' (free text otherwise).
- Derived: `postLoss` (previous trade was a loss), `delayMin` (minutes since previous trade).
- The AI layer (05) additionally detects revenge/fomo/overtrading/risk escalation from these.

### Behavioral pattern detectors (AI layer, see 05)
Patterns with evidence floors: early-exit, revenge, fomo, moving-stop, no-plan, risk-escalation after loss, cut-winners, oversize (>1.5× avg risk), quick-reentry (<30 min after loss), tilt episodes (3-trade windows with ≥2 losses + escalation/emotion).
