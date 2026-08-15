# 31trades

Trading journal + analytics platform: Dashboard, Journal, Insights, Analytics, AI Mentor, Strategy Lab, Risk, Discipline, Calendar and Notifications — all driven by a single canonical data core (browser + server share the same model).

## First-run experience (what a brand-new user sees)

1. **Welcome email** — on signup, Supabase Auth sends the confirmation email. The paste-ready welcome template (with the 1-2-3 checklist and CTA) lives at [`docs/welcome-email-template.html`](docs/welcome-email-template.html). Install it: Supabase dashboard → Authentication → Emails → *Confirm signup* template.
2. **In-app welcome** — the Dashboard shows a dismissible first-run hero card ("Welcome to 31Trades, {name}!") with Account → Strategy → Log-first-trade steps. Dismissed once, it stays gone (per browser).
3. **Onboarding checklist notification** — the Notifications feed derives a single next step (`onb-account` → `onb-strategy` → `onb-trade`) from the workspace state, so it disappears the moment each step is done. No fake data: it reads the same `Accounts` / `StrategyMaster` / `Trades` every screen reads.
4. **Welcome notification** — a personalized "Welcome to 31Trades, {name}!" System notification is logged once into the user's canonical event log, so it also appears in audit history and links to the dashboard.
