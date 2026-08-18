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

## How to reproduce the compiled Tailwind CSS

`assets/tailwind-compiled.css` is committed, but if you change markup/JS
classes, regenerate it:

```bash
npm install                  # includes devDependency tailwindcss
npx tailwindcss -c tailwind.config.js -i assets/tailwind-input.css -o assets/tailwind-compiled.css --minify
```

Every page links this static file INSTEAD of the Tailwind CDN runtime (the
~400KB in-browser compiler is gone). `assets/tailwind-config.js` and
`assets/tailwind-input.css` are the build inputs. lucide is pinned at
`lucide@1.31.0` — do not bump without re-checking icon availability
(`file-import` does not exist in 1.31.0; the app uses `file-up`).

## How to run the server

```bash
npm start          # = node db/migrate.js --deploy && node server.js  → http://127.0.0.1:8080
```

Static assets are served with brotli/gzip compression (cached in memory),
ETag revalidation (304s), and `Cache-Control` (`no-cache` for HTML,
`max-age=86400` for js/css/svg/woff2). JSON API responses over 1KB get gzip.

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

## One-page chart hub (Backtesting / Battles / Market Replay)

All three chart experiences now live on ONE page — `backtesting.html`:

- **Practice** (default, `?mode=practice` or no param) — the original backtest
  simulation page.
- **Battle** (`backtesting.html?mode=battle`) — the Online Battle workstation,
  ported into `assets/battle-mode.js` (bl- prefixed ids, its own chart).
- **Market Replay** (`backtesting.html?mode=replay`) — the replay page, ported
  into `assets/replay-mode.js` (rp- prefixed ids, client-side dataset cache).
- `battles.html` and `replay.html` are thin redirects that preserve query
  params (`?invite=CODE`, `?full=1&battle=ID`) so old links keep working.
- Mode switching is SPA-style within the page (no reload except Practice,
  which boots on page load).

Theme: every shell page includes `assets/theme-toggle.js` + a sun/moon button;
`html[data-theme="light"]` re-points the semantic token layer in
`assets/trademind-theme.css` (flip point for the whole app). Charts listen for
the `tm:theme` CustomEvent to re-theme live.
