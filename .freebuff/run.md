# 31TRADES — Preview run doc

## How to reproduce the artifacts a fresh checkout needs

1. **Environment file** — copy `.env` from the main checkout into the project
   root (or recreate from `.env.example`). It holds the Supabase project
   settings (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and the Postgres connection
   string (`SUPABASE_DB_URL`). **Never commit `.env`.**
2. **Dependencies** — `npm install` (installs `pg`, the only runtime dep).
3. **Database schema** — with a reachable Supabase DB configured:
   `npm run db:migrate` (applies `db/migrations/*.sql` in order, tracked in
   `schema_migrations`). All migrations (001–017) must be applied — 001–007
   for per-user scoping, 008 for AI findings, 009 for notification read state,
   016 for the Discord connection table, 017 for the social layer
   (`social_profiles`, `leaderboard_entries`, `squads`, `squad_members`).
   Every module has a JSON fallback, so the app boots without a DB — social
   and leaderboard features just stay empty until 017 is applied.

## How to reproduce the compiled Tailwind CSS

`assets/tailwind-compiled.css` is committed, but if you change markup/JS
classes, regenerate it:

```bash
npm install            # includes devDependency tailwindcss
npm run build:css      # tailwindcss -c … --minify
```

**Run it after ANY markup edit.** A class only exists in that file if it was in
the source when the build last ran, so a new class like `bg-[#06090e]` or
`lg:grid-cols-4` silently does nothing until the build runs again — no console
error, the UI just looks wrong. That exact drift left **401 utilities unstyled
across 28 pages** until the build was re-run. `server/ui-lint.test.js` now fails
when markup uses an arbitrary utility the compiled CSS doesn't have.

For deployment, run `npm run build:css` in the build step — the compiled CSS is
the artifact, so a stale one ships a broken UI.

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
npm test                # the full deterministic chain (no DB, no keys)
node server/sync-e2e.js # browser⇄server sync e2e — hermetic, safe to run any time
```

The chain includes `server/trade-notes.test.js`, which covers the notes domain
module below — tags, the markdown renderer (escape-before-decorate), note
quality/coverage maths, and the refusal to report a lift the sample can't support.

`server/battle-timeline.test.js` boots the REAL server on a scratch data dir
(`TRADEMIND_DATA_DIR` + `TRADEMIND_BATTLE_DATA_DIR`, `TRADEMIND_AUTH=off`, no DB)
and drives TWO battle seats over HTTP on different display timeframes, proving
they share one market moment (`cutTime`), that every display series is built from
revealed bars only (the forming bar is exactly the aggregate of the revealed
canonical bars), that the same order on both seats produces the same fill, and
that positions/trades/balances stay independent per seat. ~3s, part of `npm test`.

`server/state-merge.test.js` covers the sync model: the real data-loss incident,
legacy rows with no stamps, the content-baseline rules (including "the server has
NO usable timestamp" — the situation Postgres actually produces), the settle
property (a completed exchange must push nothing on the next boot), plus guards
that no page can ship without `src/merge.js` and that the count heuristic cannot
come back.

`server/sync-e2e.js` runs the REAL server + REAL browser shell (localStorage stub,
real fetch) and covers six cases: boot adopt, online replay, offline
accumulation, reconnect, a STALE client holding more trades than the server (the
regression — the server's newer note must survive and the client's own offline
trade must still land), and an offline EDIT of an existing record surviving the
reconnect. It is hermetic: the child server gets `TRADEMIND_DATA_DIR` pointed at a
scratch temp directory and an emptied `SUPABASE_DB_URL`, so its `POST /api/reset`
can never touch the real `data/` store or Supabase. It needs no database.

`server.js` honours `TRADEMIND_DATA_DIR` (default `data/`) — the same convention as
the other modules' `TRADEMIND_*_DATA_DIR` overrides. Point it at a scratch
directory for any test that resets state.

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

## Trade notes (`notes.html` + `assets/trade-notes.js`)

`assets/trade-notes.js` is the single source of truth for journal notes and is
shared by browser and Node (UMD: `window.TradeNotes` / `module.exports`).
`notes.html` depends on it — if it is missing, the page throws on load.

- Notes are edited **inline** in the cockpit's Trade Notes card: no modal.
  Drafts autosave (debounced), `Ctrl/⌘+S` saves in place, `Ctrl/⌘+Enter` saves
  and returns to the log, `Esc` leaves focus mode.
- A save is only announced after the value is **read back** from the store;
  the status chip reflects real state (`dirty / saving / saved / error`).
- Reflection tags round-trip through the `trades.reflection_tags` TEXT column
  (comma-separated keys from the taxonomy in the module).
- **Never fabricate note content.** An empty note is `''`; no sample text, no
  invented rating, no invented R:R. Chart evidence comes from `trades.chart_url`.
- Both columns come from migration 013 **and** must stay listed in
  `server/pg-repo.js` `TABLE_COLUMNS` *and* the matching positional value list
  in `stateToRows` — the pair is hand-written, and a column without a value
  silently shifts every field after it (`pg-repo.test.js` guards this).

## Sync model (`src/merge.js` + `core.js` adopt)

The browser store is the offline cache; the server is the shared authority. The
reconciliation is RECORD by RECORD in `src/merge.js` (UMD — browser and Node run
the same code). It is NOT a trade-count comparison any more: a count is not a
recency signal, and the old `serverTradeCount >= localTradeCount` rule let a stale
browser POST its whole local state over newer server data (a real note + `r` were
reverted that way, with no audit entry, because the write never went through
`TradeService.update`).

Classification for a record present on both sides, in order:

| condition | outcome |
|---|---|
| identical content | keep the server's copy |
| this client changed it, server did not | **keep local and push** (offline work) |
| the server changed it, client did not | keep the server's copy |
| both changed (true conflict) | later `updated_at` wins; unusable stamps keep the server's |
| no baseline entry for the record | same stamp rule; unusable → the server's |
| only on the server | keep it, never push it |
| only locally | keep and push it |

"Did the server change it?" is answered by CONTENT against a **baseline of
content hashes** (`31trades.state.v1[.<userId>].syncbase` in localStorage), not by
timestamps: Postgres writes `updated_at` but never maps it back on read, the JSON
mirror keeps only what a client sent, and the shared core never writes one at all.
The baseline is only updated after the server provably holds the merged state
(push succeeded) — if a push fails the old baseline survives, so the local edits
stay provable on the next attempt.

The whole-state POST is still the transport (there is no field-level API); merging
first is what makes it safe — `mergedCoversServer()` asserts the merged result is
a superset of the server state, and `core.js` only posts `plan.merged`.

**Load order matters**: `src/merge.js` must load before `src/core/index.js`, which
must load before `core.js` — all 25 shell pages do this, and
`server/state-merge.test.js` fails if a page omits it. Without the module the shell
fails SAFE: it hydrates from the server read-only and refuses to write anything.

Deletions are still not merged (a record the server deleted can be pushed back by a
client that still has it) — removals must go through the DELETE endpoints, never a
sync.

**`sw.js` precaches with `cache: 'reload'`** so a `CACHE_NAME` bump pulls the
DEPLOYED `core.js` instead of whatever the browser still has fresh under
`max-age=86400`. Without that, a cache version bump could precache the previous
build and keep serving the old sync code for a day after this fix ships.

## Preview (Freebuff thread)

Default port **8080** is normally free for a preview — use it unless another
thread is already listening (`netstat -ano | grep ":8080" | grep -i listen`).

```bash
node server.js                       # http://127.0.0.1:8080
```

Detached (Windows — `Start-Process` does not resolve shell shims, and stdout and
stderr MUST go to different files):

```powershell
powershell -NoProfile -Command "(Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory 'C:\Users\user\Downloads\battlexjournal\31trades' -RedirectStandardOutput '<log>' -RedirectStandardError '<log>.err' -WindowStyle Hidden -PassThru).Id"
```

Confirm it survived with `powershell -NoProfile -Command "Get-Process -Id <pid>"`,
and wait for the `31Trades backend listening on http://0.0.0.0:8080` line in the
log before registering the preview.

**Demo data for the social pages.** To preview `leaderboard.html` against data
instead of an empty board, seed and serve from a SCRATCH store so the real
`data/` is never touched (pass a native Windows path — git-bash's `/tmp` would
be translated by MSYS for a native binary but NOT when launched via PowerShell):

```bash
TRADEMIND_SOCIAL_DATA_DIR=/tmp/bx-lb-demo node tools/seed-social-demo.js --yes
# then start the server with
#   TRADEMIND_SOCIAL_DATA_DIR=C:\Users\user\AppData\Local\Temp\bx-lb-demo
```

Plain `node server.js` (no env var) gives the real thing: an empty board until
traders opt in.

Serves the same app + landing-page chat widget. With `GEMINI_API_KEY` in `.env`
the widget's `POST /api/chat-test` answers with real Gemini replies; without
it, it returns 503 "not configured". CSP is report-only by default — the
landing page (and app pages) ship inline scripts, so do NOT set
`CSP_ENFORCE=true` until those are externalized.
