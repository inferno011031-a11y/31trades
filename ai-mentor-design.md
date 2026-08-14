# 31Trades — AI Intelligence & Mentorship Layer: Implementation Plan

> **Status:** design spec (v1). Grounded in the existing architecture: the shared
> canonical core (`src/core/index.js` — Accounts, ConfigVersions, Trades,
> TradeEvaluations, Violations, discipline/analytics/insights services), the
> event bus, the REST API (`server.js`), and Supabase Postgres storage. The AI
> layer is a **separate service that reads the same canonical data** — it never
> writes trades or config, and it never generates advice without evidence.
>
> **Principle:** *"You've made this same early-entry mistake 7 times in the last
> 30 trades"* is a finding. *"Try to be more patient"* is not a finding.

---

## 1. System Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │              CORE LAYER (exists)            │
                        │                                             │
  User ──▶ Journal ──▶ Trade created ──▶ 7-step pipeline ──▶ Rule     │
   │         │                                  │         Engine      │
   │         │                                  ▼                     │
   │         │                          Canonical Ledger              │
   │         ▼                            (Trades, Evaluations,       │
  Dashboard ◀─── Event Bus ◀─── Violations, Reviews, ConfigVersions)  │
   │  Risk / Discipline / Analytics / Calendar / Insights             │
   │                                                                  │
   └─────────── read-only API ── /api/state, /api/trades,             │
               /api/discipline, /api/analytics, /api/insights         │
                                    │  (Bearer session, user-scoped)  │
                                    ▼                                 │
              ┌─────────────────────────────────────┐                 │
              │        AI INTELLIGENCE LAYER        │   (NEW — this    │
              │                                     │    plan)         │
              │  ai-mentor service (stateless,      │                  │
              │  per-request, reads user slice)     │                  │
              │   · heuristics/rule engine (v1)     │                  │
              │   · analytics-derived signals       │                  │
              │   · (v2) ML/NLP models              │                  │
              │   · (v3) LLM narration ONLY over    │                  │
              │        structured findings          │                  │
              └─────────────────────────────────────┘                 │
                        │                                              │
                        ▼                                              │
                 AI Mentor UI  (ai.html)                               │
                 Autopsy · Patterns · Psychology · Risk ·             │
                 Discipline Coach · Session Intelligence ·            │
                 Tilt detection                                       │
              └───────────────────────────────────────────────────────┘
```

**Hard rules:**
1. The AI layer is **read-only** over the core: it consumes `/api/state`,
   `/api/trades`, `/api/discipline`, `/api/analytics`, `/api/insights` (or the
   same shared core in-process). It never mutates the ledger.
2. Every AI finding carries **evidence**: the trade ids, the rule keys, the
   actual numbers (counts, $, R) it was computed from.
3. **Sample-size guardrails:** no finding below its minimum evidence (e.g. ≥5
   occurrences, ≥10 trades for session rankings). A developing account gets an
   honest "insufficient evidence" state — never manufactured insight.
4. **Personalization is structural:** every message template is filled with
   the user's own numbers, compared against the user's own baselines (their
   average risk, their rule set, their historical tilt periods). No templates
   without slots.

---

## 2. Data Model Requirements (what each feature needs)

All of these already exist in the canonical model — the AI layer reads them:

| AI feature | Canonical data it consumes | Extra needed |
|---|---|---|
| **Trade Autopsy** | `Trades` (entry/exit/size/risk/pnl/r/dir/setup/session), `TradeEvaluations`, `Violations`, active `ConfigVersions` (policy + strategy version at trade time) | trade-level `stop`/`tp` (already optional) |
| **Journal Analysis** | `Trades.note`, `emotion`, `adherence`, `reviewed` | none (notes are free text — NLP in v2) |
| **Pattern Detection** | `adherence`, `emotion`, `postLoss`, `delayMin`, `risk` vs policy | none — all derived fields exist |
| **Psychology** | `emotion`, `postLoss`, `notes`, outcomes | none |
| **Risk Analysis** | `risk`, `pnl`, `r`, policy limits, `riskState` | none |
| **Discipline Coach** | `disciplineState()` (dims/rules/streaks), `Violations` with `pnl` cost | none |
| **Session Intelligence** | `analytics().bySetup/bySession/bySymbol/byDirection` | none |
| **Tilt detection** | sequence of trades: risk, pnl, delayMin, emotion, violations | none |
| **Personalized Coach** | everything above, plus account policy + rule set | user profile (risk tolerance, goals — future `users` columns) |

**Schema changes required:** none for v1. Optional later: an `ai_findings`
table (cached findings: `user_id, finding_type, evidence_ids, created_at,
suppressed`) so the UI is instant and users can dismiss/confirm findings.

---

## 3. API & Event Design (core ⇄ AI)

The AI layer exposes its own namespace so it stays decoupled:

```
GET  /api/ai/mentor                     — the full mentor bundle
      ?accountId=&from=&to=
GET  /api/ai/autopsy/:tradeId           — one trade, fully dissected
GET  /api/ai/patterns                   — recurring-behavior findings
GET  /api/ai/psychology                 — emotion/behavior analysis
GET  /api/ai/risk                       — risk consistency + flags
GET  /api/ai/discipline                 — rule adherence coach
GET  /api/ai/sessions                   — session/setup/symbol intelligence
GET  /api/ai/tilt                       — tilt/overtrading warnings
POST /api/ai/findings/:id/suppress      — user dismisses a finding
POST /api/ai/feedback/:id               — thumbs up/down (RLHF later)
```

All endpoints: `Authorization: Bearer` (reuse `auth.verify`), account-scoped
like every core endpoint, JSON `{ ok, findings: [...] }` where every finding
is `{ id, type, severity, title, message, evidence: [tradeIds], numbers,
confidence, sample }`.

**Events consumed (bus → AI cache invalidation):** `TRADE_CREATED`,
`TRADE_UPDATED`, `TRADE_DELETED`, `RULE_CHANGED`, `STRATEGY_VERSION_CREATED`,
`ACCOUNT_LIMIT_CHANGED`, `REVIEW_COMPLETED` (already emitted by the core).
v1 recomputes per request (30–1,000 trades is cheap); the event bus only
invalidates cached findings when we add `ai_findings`.

**Event emitted by AI:** `AI_FINDING_CREATED` (optional — surfaces a coach
toast on the Dashboard when a high-severity tilt finding appears).

---

## 4. Tech Stack — adaptation plan for 31Trades

The existing stack is zero-dependency Node + a shared core + Supabase. The
adaptation is deliberately incremental:

| Phase | Technology | Why |
|---|---|---|
| **v1 (heuristics)** | Plain JS functions in the shared core (`src/core/ai-mentor.js`) or a sibling `server/ai/` module | No new deps; deterministic; testable; works offline/local-first — matches the product today |
| **v1.5 (persistence)** | Supabase table `ai_findings` + cache | Instant UI, dismiss/confirm, audit |
| **v2 (ML/NLP)** | Node + `natural` or `compromise` for journal-note NLP; scikit-learn-ish stats in JS (mean/std/percentiles) | Runs in-process; no GPU; deterministic where it matters |
| **v3 (LLM narration)** | A hosted LLM (OpenAI/Anthropic) **as a text layer only**, called with a strict JSON context: structured findings + evidence, never raw prompt soup | The LLM rephrases grounded findings; it cannot invent numbers because it never sees a template without slots. `SUPABASE_ANON_KEY`-style env gate + per-user rate limits + server-side only (never expose the key to the browser) |
| **Backtesting/Battles (later)** | Reuses the same deterministic engine with historical versions | Same rule engine, same evaluator |

**Why not a generic chatbot:** the mentor has no free-form "ask anything"
surface in v1. It answers only over its own evidence-backed findings. A
constrained question box (v3) is routed through the same finding pipeline.

---

## 5. Phased Roadmap

```
Phase 0 (DONE)        Core: auth → trades → journal → analytics → risk →
                      discipline → calendar → insights → strategy lab.
Phase 1 (THIS PR)     First AI section: ai.html "AI Mentor" reading the
                      canonical ledger directly (in-browser heuristics),
                      sidebar-linked. Everything grounded, evidence-backed.
Phase 2               Extract heuristics into a server module
                      (server/ai-mentor.js) + /api/ai/* endpoints +
                      ai_findings caching + dismiss/feedback.
Phase 3               ML/NLP: journal-note emotion/behavior extraction,
                      anomaly detection on risk sequences (z-score,
                      change-point), rolling-tilt scoring model.
Phase 4               LLM narration layer over structured findings
                      (server-side, keyed, rate-limited).
Phase 5               Backtesting integration (AI autopsies historical
                      trades against then-active versions) + Battles.
```

---

## 6. Methods per AI capability

| Capability | v1 method (rule-based) | v2/v3 method (ML/NLP) |
|---|---|---|
| **Trade Autopsy** | Deterministic: replay `evaluateRules` for the trade's versions; narrate entry/exit/risk/execution from fields + rule results | LLM narrates the structured autopsy (Phase 4) |
| **Journal Analysis** | Keyword + emotion-tag correlation: `emotion`, `adherence` vs P&L/R; notes presence vs outcome | NLP: extract entities/themes from `note`; sentiment → behavior labels |
| **Pattern Detection** | Counters over derived fields: `adherence='early exit'`, `emotion='Revenge'`, `postLoss && risk>prev.risk`, `delayMin<cooldown` etc. | Sequence mining (n-grams of behavior tags) + anomaly detection |
| **Psychology** | P&L × emotion matrix, post-loss emotion drift, tilt windows | Lexicon-based note sentiment → emotion confidence |
| **Risk Analysis** | risk mean/std/percentiles vs policy; oversize flags (`risk > policy×1.5`); R:R distribution; drawdown clustering | Change-point detection on equity curve; conditional value-at-risk |
| **Discipline Coach** | `disciplineState()` rules ranked by fail rate × cost (`Violations.pnl`) | — |
| **Session Intelligence** | `analytics().bySetup/bySession/bySymbol/byDirection` ranked with ≥5-trade guardrail | Bayesian credible intervals on win rates |
| **Tilt Detection** | Sequence rules: losses → risk escalation → emotional entries within a window; compare recent window vs baseline | Rolling logistic score on behavioral features; early-warning when recent window resembles historical tilt periods |
| **Personalization** | Every finding computed against the user's own baseline (their avg risk, their rule set, their tilt history) | User embeddings; per-user model fine-tunes |

**Tilt detection detail (the flagship):** define a *tilt episode* in the user's
own history (e.g. ≥2 consecutive losses AND next-trade risk ≥1.2× personal
average AND emotional tag). Learn the user's signature (their risk multiple
during tilt, their typical re-entry delay). For the **current** session,
compute a running tilt score over the last N trades; when it crosses the
user's own historical tilt threshold, emit a warning with *their* numbers:
*"The last 3 trades match your 4 previous tilt episodes (avg +38% risk, entries
within 9 min of a loss). In those episodes you lost $X."*

---

## 7. Personalization — how we avoid generic responses

1. **Baselines are the user's own.** All comparisons (risk escalation, tilt
   threshold, R:R quality) are vs their rolling statistics, not industry
   averages.
2. **Evidence is mandatory.** A finding without trade ids doesn't render.
3. **Counts are real.** Templates like *"This is the Nᵗʰ early exit in your
   last M trades; they cost $X in total"* are filled by the engine.
4. **The user's rules are the rubric.** Discipline coaching quotes their
   actual rule set and their actual violation history — a user with no
   revenge rule gets no revenge lecture.
5. **Suppress/confirm loop.** Users dismiss or confirm findings
   (`/api/ai/findings/:id/suppress`), so the coach learns what is noise for
   *this* trader.
6. **LLM guardrail (v4):** the model only ever rephrases a JSON context that
   already contains the numbers — it cannot add data. Verified by unit tests
   that assert the rendered message contains the evidence counts verbatim.

---

## 8. Acceptance criteria for Phase 1 (this PR)

1. `ai.html` renders from the **real** canonical ledger (zero hardcoded
   numbers) for the selected account.
2. Each of the 8 capabilities has at least one evidence-backed finding with
   trade ids and counts, or an honest "insufficient evidence" state.
3. A logged trade immediately changes the mentor output (bus-driven).
4. Zero-account / zero-trade first-user state renders gracefully.
5. Every finding is a *finding* ("7 of the last 30 trades…") — no generic
   advice strings.
6. `npm test` passes (heuristics pinned by unit tests).

---

*Design sections 1–8 are the architecture contract. The implementation
(ai.html + ai-mentor engine) follows the same shapes: findings with evidence,
sample guardrails, user-relative baselines.*
