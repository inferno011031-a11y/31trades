# 08 — REWARDS / CREDITS, SUBSCRIPTIONS / FREE PLAN, NOTIFICATIONS

---

## 8.1 Rewards — achievements read model (derived, no credits ledger)

**IMPLEMENTED — `server/rewards.js` → `GET /api/rewards`.** Rewards are a *read model*: there is no credits ledger, no balance, no redemption and nothing spendable, so progression cannot be bought, farmed or faked.

- 19 milestones across Journal · Consistency · Discipline · Edge · Proof · Battles · Mission 100K (`MILESTONES`), each with an explicit `metric`, `target` and `points`.
- Every number is recomputed from canonical engines on each read: live trades, journaled session days, discipline score, average R, profit factor, max-daily-loss breaches, backtest proof trades, completed battles + wins, Mission 100K rung.
- Output: `points`, `completionPct`, `tier` (Bronze/Silver/Gold/Platinum) + `nextTier` distance, `achieved[]`, `next[]` (three nearest), `locked[]`, and the raw `snapshot` used.
- Honesty guarantees: a milestone is only `achieved` when `value ≥ target`; deleting trades or losing a streak immediately removes the reward; an empty account earns zero (breach-free credit requires actual trading).
- `battlesCompleted` / `battleWins` are read from the user's battle store (completed battles with a seat; wins from the stored leaderboard).

## 8.2 Subscriptions — provider-neutral contract (no provider wired yet)

**PARTIALLY IMPLEMENTED — `server/billing.js`, migration `019_entitlements_billing.sql`.**

- Plan catalogue (`PLANS`): `standard` (free, 50 lifetime AI), `tester` (invite program, monthly AI), `pro` (paid, declared monthly AI). AI counters reported by `GET /api/billing/subscription` are always what `server/access.js` *actually enforces*; the plan's own allowance is exposed separately as `declaredAi`.
- Provider-neutral webhook: `POST /api/billing/webhook/:provider` accepts ANY provider that HMAC-signs the raw body with `BILLING_WEBHOOK_SECRET` (`X-Battlex-Signature: t=<unix>,v1=<hex>`). Timing-safe compare, 5-minute replay window, strict canonical schema validation (`subscription.activated|renewed|canceled|expired`).
- **No secret ⇒ no billing:** without `BILLING_WEBHOOK_SECRET` the endpoint answers `503 billing_not_configured` and no plan is ever written. There is no fake checkout, no fake invoice, no simulated payment.
- Idempotency: events are keyed `(provider, event_id)` in `subscription_events`; a retried webhook can never double-apply. Duplicate deliveries return `{ duplicate: true }`.
- Lifecycle semantics: `activated/renewed` → plan active until `current_period_end`; `canceled` → access continues until the period actually ends; `expired` → falls back to `standard`. An already-ended period never grants the plan, even if a stale row still says `active`.
- Storage: `user_entitlements` gains `plan`, `plan_status`, `plan_expires_at`, `billing_provider` (migration 019) written with an `UPDATE`-first strategy so an existing tester entitlement row is never clobbered; the local mirror `data/subscriptions.json` keeps the bot/app working without Postgres.
- Not done yet (honest): no provider account, no hosted checkout UI, no invoice/receipt artifacts, and paid plans do not yet raise the enforced AI quota — that requires plan-aware enforcement in `server/access.js`.

## 8.3 Notifications — the complete engine

`server/notifications.js` derives the feed **from the canonical state** (never hardcoded). `GET /api/notifications` returns `{ notifications[], unread, readIds[], brokerConnected }`. Read-state: `POST /api/notifications/read` → `notifications_read` table + `notif-<userId>.json` mirror. Cap 50, newest first.

### Trigger inventory (id → source → severity)

**0. Onboarding checklist** (info, emerald) — derived from workspace state; one next step at a time:
- `onb-account` — no accounts yet → "Create your first account" → `strategy-lab.html?tab=accounts`
- `onb-strategy` — no strategies → "Create your first strategy" → `strategy-lab.html?tab=strategies`
- `onb-trade` — no trades → "Log your first trade" → `journal.html`
- `onb-review` — any unreviewed trade → "Complete your first review" → `journal.html?view=unreviewed`
- `onb-broker` — not connected → "Connect a broker" → opens the broker picker → `POST /api/brokers/connect` (inline action, no navigation)

**1. Risk state** (from `riskState()`):
- `risk-limit` (critical, red) — status 'LIMIT' → "Daily risk limit breached" → `risk.html`
- `risk-high` (high, amber) — status 'HIGH' → "High risk — protect capital" → `risk.html`
- `risk-caution` (warn, blue) — status 'CAUTION' → "Risk caution — above the first warning band" → `risk.html`

**2. Policy blocks** (high, red) — `adherence_result === 'BLOCK'` trades (max 6, newest) → "Trade blocked — SYMBOL DIR" with block_reason → `journal.html?focus=<id>`

**3. Discipline violations** (high, red) — hard-rule violations from the canonical Violations table (max 8, newest). Stable id `viol-<tradeId>-<ruleKey>` → "Rule broken: <label>" with P&L + R → `discipline.html`

**4. Pending reviews** (info, blue) — any unreviewed trade → "N trades awaiting review" → `journal.html?view=unreviewed`

**5. System / audit** (info) — last 6 event-log entries; the one-time **Welcome** event (`entity '31Trades'`, `what 'Welcome'`) renders as a sparkles notification linking to `dashboard.html`; others link to `strategy-lab.html?tab=history`

**6. Market events** (high, amber) — next upcoming High/Medium calendar release within the window → "HIGH impact: <title>" with countdown + consensus + previous → `journal.html`

**7. Battle invitations** (indigo) — prepended from `Battle.pendingInvites(userId)` → "Battle invitation · <title>" with symbol/tf/seats taken → `backtesting.html?mode=battle&invite=<code>`

### Channels
- **In-app**: the derived feed above (Notifications page + bell/unread badge on every page).
- **Email**: NOT sent by this server. Supabase Auth sends confirmation/recovery emails; battle invites are `mailto:` links; a paste-ready welcome-email HTML template ships at `docs/welcome-email-template.html` for manual install into the Supabase "Confirm signup" template.
- **Push**: **UNKNOWN — NOT FOUND IN IMPLEMENTATION** (no push integration).

### Read-state sync
- `notifications_read(user_id, notification_id, read_at)` PK (user, notification); ids are stable keys derived from canonical data so marking persists across recomputation; syncs across devices.

### Welcome message (signup flow)
- On signup, `logWelcomeEvent()` writes one personalized `'31Trades' / 'Welcome'` event into the user's event log (idempotent). Surfaces as: System notification, audit-history entry, Dashboard first-run hero card ("Welcome to 31Trades, {first name}!" with onboarding checklist), and (optionally) the Supabase confirm-signup email via the template in `docs/`.

---

## 8.4 Other user-facing event surfaces (not in the notifications feed)

- **Audit/history**: `EVENT_LOG` entries for account/strategy/rule-set changes, version bumps, trade edits/deletes, reviews completed, welcome — shown on Strategy Lab → History tab and `/api/audit`.
- **WebSocket feed ping**: `feed.changed` on the dashboard when any battle mutates.
