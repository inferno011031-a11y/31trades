# 31TRADES — Preview run doc

## How to reproduce the artifacts a fresh checkout needs

1. **Environment file** — copy `.env` from the main checkout into the project
   root (or recreate from `.env.example`). It holds the Supabase project
   settings (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and the Postgres connection
   string (`SUPABASE_DB_URL`). **Never commit `.env`.**
2. **Dependencies** — `npm install` (installs `pg`, the only runtime dep).
3. **Database schema** — with a reachable Supabase DB configured:
   `npm run db:migrate` (applies `db/migrations/*.sql` in order, tracked in
   `schema_migrations`). All migrations (001–009) must be applied — 001–007
   for per-user scoping, 008 for AI findings, 009 for notification read state.

## How to run the server

```bash
npm start          # = node server.js  → http://127.0.0.1:8080
```

- Port: `process.env.PORT` wins (Railway), else `TRADEMIND_PORT` (dev/tests), default `8080`. Server binds `0.0.0.0`.
- Boot logs print a Supabase env diagnostic (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_DB_URL detected or missing) plus a live database ping — check them in Railway runtime logs if the app falls back to data/db.json.
- Auth is ON by default — the app gates all pages behind Supabase GoTrue
  (sign up / sign in at `auth.html`). Sign-up requires email confirmation
  unless "Confirm email" is disabled in the Supabase dashboard.
- Dev/testing escape hatch: `TRADEMIND_AUTH=off` runs the server in anonymous
  mode (single local partition, no login) — used by `server/sync-e2e.js`.
- Storage: Supabase Postgres (per-user slices, `user_id`-scoped) with a
  per-user JSON mirror in `data/db-<userId>.json` as fallback.

## Tests

```bash
npm test                # repo mapping + migration column consistency (no DB)
node server/sync-e2e.js # browser⇄server sync e2e (needs a reachable Postgres)
```
