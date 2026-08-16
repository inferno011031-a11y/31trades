# 07 — SQUADS / GROUPS, COMMUNITY, TRADER PROFILE / IDENTITY

> Most of the community/social surface described in the brief is **not implemented in the backend**. This file is literal: what exists is a small set of battle-related "team" strings, a mostly-static Community page, and auth/profile identity. Everything else is marked **PLANNED / NOT IMPLEMENTED**.

---

## 7.1 Squads / Groups / Teams

**What the code actually has:**
- Battles support a `team` string per seat (free-form, e.g. "ICT" / "SMC" / custom). `POST /api/battles` accepts `teams: [team|null per seat]`. The leaderboard aggregates by team (average score, trades, winRate, avgR, maxDD, members).
- The battle UI labels seats/teams as **Squads** (backtesting.html `?mode=battle`: "Squad" language, seat join buttons). This is a **relabel of the battle seat model** — there is **no separate squad entity**.
- `battlesFeed` returns `teams: [...]` per battle for the dashboard feed.

**Not implemented anywhere in the backend:**
- Squad creation as a standalone entity, squad membership, squad invitations, squad roles, squad chat, voice, squad activity feeds, squad backtesting, squad stats, moderation, member limits. All **PLANNED / NOT IMPLEMENTED**.

## 7.2 Community

**What the code actually has:**
- `community.html` (static page, server-side only serves the file — no community API):
  - Identity card with the **unique user ID** (from the Supabase auth session; copyable — intended for Discord verification / giveaways).
  - Live **battle results feed** (`GET /api/battles`).
  - Weekly leaderboard (derived from battles the user can see).
- Sidebar links to Community on every page (reports/help also exist as static pages).

**Not implemented:**
- Regional groups, trader discovery, profiles of other traders, posts/discussions, messaging, voice rooms, moderation, reporting, roles, reputation, active-trader/moderator logic. All **PLANNED / NOT IMPLEMENTED**.
- Note: `community.html` renders `b.seats.forEach` safely — the battle API returns a **seat count**, not an array; the page was fixed to handle both shapes (see git history `5e563be`).

## 7.3 Trader Profile / Identity

**What the code actually has:**
- Identity: the Supabase auth user `{ id (UUID), email, name (from user_metadata.full_name), created_at }` — served by `GET /api/auth/me` and embedded in every session.
- The **unique user ID** is displayed on the Settings page and Community page (copyable, for Discord verification/role sync/giveaways). It is the GoTrue UUID (or the local placeholder `00000000-…` in anonymous mode).
- Display name: from signup `name` → `user_metadata.full_name`; default 'Trader' on the FK mirror.
- Profile-ish data the user can see about *their own* account: discipline score, streaks, violations (from the discipline/analytics/AI services), battle history (battles list + results feed), backtesting activity (sessions list), leaderboard rows they're on (completed battles they participated in).
- Settings page: user profile section (name/email/user id), Connected Brokers, Security (change password, password strength meter, last-changed timestamp), Appearance (theme picker synced per user via `GET/PUT /api/prefs`).

**Public vs private fields:**
- The app **does not implement any public-profile or visibility model** — there is no endpoint exposing a user's profile to other users, no public/private toggles. **UNKNOWN — NOT FOUND IN IMPLEMENTATION** for: public profile pages, social handles, reputation, achievements display, battle history visibility to others.

## 7.4 Roles / Reputation / Moderators

**UNKNOWN — NOT FOUND IN IMPLEMENTATION.** No role model, reputation system, moderator concept, or active-trader logic exists anywhere in the backend. The only "roles" are battle host vs participant (host controls the replay; participants control their own seat). The only "reputation-like" signal is the battle blended score + leaderboard rank.

## 7.5 Achievements / Streaks (as implemented)

- **Streaks** (computed, not stored): discipline clean-day streak (`disciplineState`), analytics best-win/best-loss streaks, bot streak answers (win/loss streaks over full history), battle-independent.
- **Achievements**: **UNKNOWN — NOT FOUND IN IMPLEMENTATION** (no achievement table/entity/endpoint; the only "achievement"-adjacent thing is AI findings with positive severity, e.g. "Clean streak", "Calm state is your edge").

## 7.6 Leaderboards (as implemented — battles only)

- Per-battle leaderboard (seats ranked by blended score 0–1000, see 06 §6.5) and team aggregation; dashboard feed shows the last 7 days of completed results with winners; Community page renders a weekly leaderboard from battle results.
- **No global/user-wide leaderboard**, no leaderboard table, no filters/timeframes/tie-breaking/eligibility/rewards. Those are **PLANNED / NOT IMPLEMENTED**.
