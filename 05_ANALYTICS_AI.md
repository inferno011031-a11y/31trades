# 05 — ANALYTICS ENGINE + AI ENGINE

---

## 5.1 ANALYTICS ENGINE (`computeAnalytics` in src/core/index.js)

One implementation for live trades, practice trades (`analyticsFrom`), and (via flattening) anything trade-shaped. Filters applied before compute: symbol, setup, session, direction, result (win/loss/breakeven), emotion, adherence, from, to.

### Metrics (exact definitions)
```
n            = trade count in range
wins         = pnl > 0;  losses = pnl < 0
net          = Σ pnl
grossWin     = Σ positive pnl
grossLoss    = |Σ negative pnl|
winRate      = wins ÷ (wins + losses)                      // breakevens excluded from denominator
avgWin       = grossWin ÷ wins
avgLoss      = grossLoss ÷ losses
avgTrade     = net ÷ n
avgR         = Σ r ÷ n
expectancy   = Σ r ÷ n                                     // == avgR (R-based)
pf           = grossLoss ? grossWin ÷ grossLoss : (wins.length ? 3 : 0)
maxDD        = max over chronological curve of (peak − equity)
recovery     = maxDD ? net ÷ maxDD : 0
avgRisk      = Σ risk ÷ n
maxEq/minEq  = extremes of the running equity curve
curve        = [{ts, equity}] chronological (equity = cumulative Σ pnl from 0)
byStrategy / bySetup / bySymbol / bySession / byDirection
              = [{key, n, pnl, winRate, avgR, pf}] sorted by pnl desc
              (pf = grossWin/grossLoss, 3 if no losses but wins, else 0)
byRisk       = buckets ['$0–20','$21–35','$36–50','$50+']  (by t.risk)
streaks      = { bestWin, bestLoss }  (consecutive wins/losses by pnl sign; breakeven resets)
```

### Edge cases
- Empty list → winRate 0, pf 0, curve [], streaks 0, maxEq/minEq 0 (via `emptyAnalytics` for practice).
- No losses with wins → `pf = 3` (live) / `Infinity` (bot stats, backtest results).
- `recovery = 0` when maxDD is 0.
- `byRisk` bucket boundaries: ≤20, ≤35, ≤50, >50.

### Calendar month (`calendarMonth`)
Per day: pnl, trades, wins, losses, avgR, riskConsumed (Σ risk), disciplineScore (pass-rate of that day's rule evals), violations count, trade list. Month totals: totalPnl, totalTrades, winDays, lossDays.

### Reviews (derived, never stored)
- **daily**: trades, pnl, discipline score + dims, violations + breakdown, summary text, focus (weakest dimension).
- **weekly**: last 7 days — score, dims, cleanDays, violations, most_frequent rule, most_costly rule, focus.
- **monthly**: current month — score, dims, strongest_dim, weakest_dim, trades, netPnl, winRate, violations, cleanDayStreak.
- `completeReview` only writes an event-log entry + publishes `review.completed`.

### Insights service (`insights`)
Evidence floors: needs ≥10 trades (else 'Developing' finding). Findings: strongest setup (≥8 trades), strongest session (≥8), strongest instrument (≥8), emotional entries cost (≥3 FOMO/Revenge), risk escalation after losses (≥5, avg-after-loss > 1.1× baseline), rule breaks cost money (≥5 violations). Each carries evidence trade ids + confidence (high/medium).

---

## 5.2 AI ENGINE

### Architecture (three layers, per ai-mentor-design.md + code)
1. **Deterministic engines** compute everything from the canonical ledger (never a blank canvas → cannot invent).
2. **Gemini narration** (`server/llm.js`) only rephrases the already-correct payload; a **grounding guard** re-checks every number/percent/R in the narration and discards it if any is altered (falls back to the deterministic answer).
3. **ai_findings cache** lets the user suppress (dismiss) or rate (±1) each finding; the coach learns what's noise per trader.

### 5.2.1 AI Mentor bundle (`GET /api/ai/mentor`) — computed per request, period 30d/90d/all
**Context**: `{ tradeCount, totalTrades, netPnl, winRate, expectancy, maxDD, recovery, disciplineScore, violations, cleanStreak, bestCleanStreak, avgRisk, riskSd, policyRiskPerTrade, upcomingEvents }`.
**Coach message** (deterministic): <10 trades → keep journaling; else "Your biggest leak: '<top finding>' — N occurrences" + tilt warning when flashing; strengths otherwise.
**Pattern detection** (`detectPatterns`, floor ≥3 evidence each):
- early-exit, revenge (critical), fomo, moving-stop, no-plan, risk-escalation after loss (critical), cut-winners, oversize (>1.5× own avg risk), quick-reentry (<30 min after a loss).
**Psychology** (`psychologyAnalysis`): emotion table grouped by emotion (n/pnl/winRate/avgR); findings: revenge costs money (≥2), FOMO correlates with losses (≥2, negative pnl), calm is the edge (≥4), notes correlate with wins (≥5 both, delta > 10%).
**Risk analysis** (`riskAnalysis`): inconsistency via **coefficient of variation** (cv = σ/mean; flag if cv > 0.45); over-policy risk (≥2 trades above policy.riskPerTrade, critical); winners too small (avg winner R < 1.2, ≥5 wins); slow drawdown recovery (recovery factor < 1); risk histogram ($ buckets).
**Discipline coach** (`disciplineCoach`): most-broken rule (≥3, cost), weakest rule adherence (≥5 checks), clean streak (positive).
**Session intelligence** (`sessionIntel`): best/worst session by avgR (≥5), best setup, symbol expectancy spread (both ≥5, best.avgR>0, worst<0).
**Tilt detection** (`tiltAnalysis`): 3-trade sliding windows with ≥2 losses AND (risk escalation OR Revenge/FOMO emotion) = episode; recent-5-trade signature (≥2 losses + escalation/emotion/risk-mult > 1.15) → **critical "tilt pattern active"** or positive "tilt watch".
**Trade autopsies** (last 3 trades): verdict Followed plan / Violation / Blocked, rule results, asset unit/size labels.
**AI findings prefs**: `POST /api/ai/findings/suppress` and `/feedback`; suppressed findings hidden from the coach view; `includeSuppressed=1` powers the dismissed-findings management view.
**Gemini**: narrates `coach.message` when `GEMINI_API_KEY` set (guard verified).

### 5.2.2 AI Mentor bot (`POST /api/ai/ask`) — grounded Q&A, conversation memory
- **Intent detection** (deterministic regex, order matters): news → period (today/yesterday/this week/last week/this month) → tilt → discipline → streak → risk → session → symbol → setup → winloss → focus → overall.
- **Conversation context** (`resolveAsk`): follow-up phrases ("and", "also", "what about", "tell me more", "more", "same", "again", "that", "it", "them", "else", "another") carry the previous subject/intent/window; explicit symbol/session/setup words override. Window modifiers resolve to since-ms.
- **Memory**: persisted `data/chat-<userId>-<accountId>.json`, rolling last 15 exchanges (30 entries); server memory wins over client memory.
- **Answers**: overall, win/loss, risk, tilt, discipline, session, symbol, setup, focus, streak (computed over full history), period, subject-row ("what about EURUSD?"), news (from real calendar events; honest "unavailable"/"quiet" states; 6-hour warning spliced into other answers).
- **KPIs + evidence + follow-ups** returned per answer; Gemini narration with the same grounding guard.

### 5.2.3 AI Backtest Coach (`GET /api/ai/backtest-coach`)
Reviews a finished practice session: premature entries (exit − entry ≤ 2 bars, ≥2), weak setups (<40% WR, ≥3), strong setups (≥60%, ≥4), inconsistent risk (cv > 0.35, ≥3), oversized risk (>1% of balance), SL dominance (≥60% of exits), winners closed manually before TP (≥2, no TP fills), revenge re-entry (within 1 bar of a loss, ≥2), best session, thin RR (avg planned R:R < 1.5, ≥3). Summary: sessionId, symbol, tf, strategy, trades, wins/losses, winRate, net, balances, status.

### 5.2.4 Where results live
- Findings/bundles are **recomputed per request** (not stored as content); only `ai_findings` prefs (suppressed/feedback) persist. Chat memory persists. No AI output is stored in the canonical tables.

### 5.2.5 How it appears in the UI / actions the trader can take
- `ai.html`: mentor dashboard (coach message, patterns by severity, psychology emotion table, risk histogram, discipline dims/rules, session tables, tilt card, autopsies), the personal bot chat, dismissed-findings management, per-finding dismiss (×) and thumbs up/down.
- `backtesting.html` (practice results tab): AI coach findings for the finished session.
- Dashboard: market events section feeds `context.upcomingEvents`.
- Actions: dismiss/restore findings, rate findings, ask follow-up questions.

### 5.2.6 Generation model
- **Once per request** (no continuous background generation; no push). Deterministic + optional LLM narration per request.
