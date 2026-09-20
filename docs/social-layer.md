# Social layer — API contract (public profiles · global leaderboard · squads)

Backend for the BattleX community layer. **No frontend is included** — this is the
contract to build it against. Everything is auth-gated (Bearers token, same as the
rest of the app) and every response is `{ ok: true, ... }` or `{ ok: false, error }`
with a 400/403/404 status.

Modules: `server/profiles.js` · `server/leaderboard.js` · `server/squads.js`
Schema: `db/migrations/017_social.sql` (mirrored in `supabase/migrations/`)
Tests: `server/profiles.test.js` · `server/leaderboard.test.js` · `server/squads.test.js`

---

## 1. Privacy model — read this first

| Rule | Behaviour |
|---|---|
| **Opt-in only** | `visibility.public` defaults to **false**. A private trader appears on no board, has no public page and is invisible in every directory. |
| **Per-metric flags** | `showNet`, `showWinRate`, `showAvgR`, `showTrades`, `showDiscipline`, `showSquad`. Hiding net also hides profit factor / max DD; the process score (`bxScore`) needs only win rate + avg R. |
| **Ranking rule** | A board only lists traders who expose **the metric it is ranked by**. Hide net → you are absent from the net board, not present-but-masked. |
| **Masking** | Metrics a trader hides are returned as `null`, never omitted silently. |
| **Never exposed** | email, user id, auth material, trade-level rows, ticket/screenshot data. Only `handle`, `displayName`, `bio`, `country`, `avatar`, `links` are public. |
| **Squad deal** | Joining a squad adds your ledger to the **team total** (state this on the join screen). Member-level rows still respect your flags; a private member shows as `Private trader` with no metrics. |

---

## 2. Endpoints

### Profile

| Method | Path | Notes |
|---|---|---|
| GET | `/api/social/profile` | Own profile (includes `visibility` + `allowed` map) + `squad` + supported `ranges`/`metrics`. |
| PUT | `/api/social/profile` | Body: `{ handle, displayName, bio, country, avatar, links, visibility }`. Patch semantics — send only what changed. `handle` is validated loudly (400). |
| GET | `/api/social/profile/:handle` | Public trader card. 404 when private/unknown. |

Handle rules: `^[a-z0-9][a-z0-9_-]{2,23}$`, reserved words rejected (`admin`, `api`,
`me`, `battlex`, `support`, …), globally unique, case-insensitive, auto-derived from
the display name when omitted. `country` must be ISO-2. `avatar` is a `#rrggbb`
accent only (no image uploads exist — no file-storage infra in the product yet).

### Leaderboard

| Method | Path | Notes |
|---|---|---|
| GET | `/api/social/leaderboard` | `?metric=&range=&limit=&offset=&minTrades=&squad=` |
| GET | `/api/social/leaderboard/me` | Own rank + percentile + `reasons[]` when unranked |
| POST | `/api/social/publish` | Force-refresh own standings snapshot |

* **metrics** — `bxScore` (default) · `net` · `winRate` · `avgR` · `pf` · `trades` · `discipline`
* **ranges** — `7d` · `30d` (default) · `90d` · `ytd` · `season` (live calendar quarter) · `all`, plus explicit `YYYY`, `YYYY-MM`, `YYYY-Qn`
* **minTrades** — sample floor, default **10**. Traders below it are not listed.

`bxScore` is the headline metric: a blended 0–1000, process-weighted score
(30 % win rate + 30 % avg R + 20 % recovery + 20 % profit factor, scaled by
activity), null under the sample floor. Same philosophy as the battle scorer — one
oversized win never outranks consistent execution. `bxComps` exposes the weights.

Board rows are already ranked and masked:

```json
{ "rank": 1, "handle": "alpha", "displayName": "Alpha", "avatar": "#22d3ee",
  "country": "IN", "squadId": "sqd_…", "discipline": 71,
  "metrics": { "trades": 42, "net": 1840, "winRate": 61.9, "avgR": 0.71, "pf": 1.9,
               "maxDD": 620, "activeDays": 28, "bestDayStreak": 5,
               "streak": { "type": "win", "len": 2 } },
  "bxScore": 612, "bxComps": { "winRate": 0.62, "avgR": 0.57, "recovery": 0.99, "consistency": 0.95, "activity": 1 } }
```

`/me` always answers, even when private or below the floor:

```json
{ "ranked": false, "rank": null, "reasons": ["your profile is private — enable it in profile settings"] }
```

Reasons distinguish: profile private · metric hidden · below the sample floor.

### Squads

| Method | Path | Notes |
|---|---|---|
| GET | `/api/social/squads` | Own squad (`mine`) + public directory (name, tag, member count — never the invite code) |
| POST | `/api/social/squads` | `{ name, tag }` → 201. Name 2–24 chars, tag 2–5 `A-Z0-9`, unique tag |
| POST | `/api/social/squads/join` | `{ code }` — case-insensitive |
| POST | `/api/social/squads/leave` | Owner leaving **hands the squad over**; last member out dissolves it |
| GET | `/api/social/squads/:id` | Standings |
| DELETE | `/api/social/squads/:id` | Owner only — disbands, members released (403/404 otherwise) |

One squad per trader (switch = leave, then join). Cap **20 members**.
Standings expose the squad total (`totals`, `bxScore`, `bxComps`), `leader`, and
`members[]` with `role`/`public`; `inviteCode` is returned **only to members**.

---

## 3. Frontend integration notes

* **Freshness without cron** — every board read re-publishes the *caller's own*
  snapshot (throttled to 45 s inside the module). Log trades → next board load is
  current. `POST /api/social/publish` forces it.
* **What to show a new user** — call `/me` first: it returns the honest reason they
  are unranked, which is exactly the "set your handle / go public / log 10 trades"
  call to action.
* **Squad totals vs privacy** — show a one-line consent note on the join card.
* **Audit trail** — every profile publish, squad create/join/leave/disband writes a
  `ConfigAPI.logTagEvent`, so it surfaces in Strategy Lab → History and the System
  notification feed automatically.
* **Local-first** — file fallback stores live in `data/social-profiles.json`,
  `data/leaderboard.json`, `data/squads.json` (DB is authoritative when
  `SUPABASE_DB_URL` is set; all three are `CREATE TABLE IF NOT EXISTS`).

## 4. Deploy checklist

1. `npm run db:migrate` (applies `017_social.sql`; every deploy also runs it with `--deploy`).
2. Nothing else — no env vars, no storage bucket, no background worker.
