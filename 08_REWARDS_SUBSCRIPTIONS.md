# 08 — REWARDS / CREDITS, SUBSCRIPTIONS / FREE PLAN, NOTIFICATIONS

---

## 8.1 Rewards / Credits

**UNKNOWN — NOT FOUND IN IMPLEMENTATION.**
- No credits ledger, no reward events, no redemption, no giveaways, no achievement awards, no subscription redemption. The word "credits" appears nowhere in code. The only "reward-like" output is the battle **score** (0–1000, displayed on leaderboards) and AI positive findings ("strengths") — neither is spendable or storable.

## 8.2 Subscriptions / Free Plan

**UNKNOWN — NOT FOUND IN IMPLEMENTATION.**
- No plans, no feature gating, no ads, no upgrade/downgrade, no subscription status, no battle/backtesting/community access restrictions. **Every feature is available to every signed-in user.** (Auth itself is free GoTrue; email confirmation on signup is optional depending on the Supabase project config.)

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
