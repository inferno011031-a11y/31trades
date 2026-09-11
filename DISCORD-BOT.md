# BattleXJournal Discord Bot

Welcome automation + secure identity verification between Discord and BattleXJournal.

---

## Architecture

```
                        ┌──────────────────────────────────────────────┐
                        │              DISCORD                         │
                        │   guildMemberAdd · buttons · /verify /start  │
                        └──────────────┬───────────────────────────────┘
                                       │ gateway (discord.js)
            ┌──────────────────────────▼──────────────────────────┐
            │      discord-bot/  (Render service #2, stateless)   │
            │      index.js · branding.js · store.js · health.js  │
            └──────────────┬──────────────────────────────────────┘
                           │ Supabase REST (service role, server-side only)
   ┌───────────────────────▼────────────────────────┐   ┌──────────────────────────┐
   │  Supabase Postgres                             │   │  31trades web server     │
   │  discord_connections (016)                     │   │  (Render service #1)     │
   │    user_id UUID UNIQUE ──┐                     │◄──┤  /api/discord/begin      │
   │    discord_user_id TEXT UNIQUE                 │   │  /api/discord/callback   │
   │  user_entitlements (014) · users (001)         │   │  settings.html button    │
   └────────────────────────────────────────────────┘   └──────────────────────────┘
```

**Two deployables, one database:**

| Piece | Where | Role |
| :-- | :-- | :-- |
| Web verification | existing `31trades` server (`server/discord-verify.js`) | OAuth begin + callback, persists `discord_connections`, assigns role via Discord REST, writes `audit_log` |
| Bot | `discord-bot/` (separate process) | welcome embeds, buttons, slash commands, reads links + entitlements, re-grants role on rejoin |

The bot is **stateless**: no filesystem, no JSON/SQLite, no in-memory user data. All persistence is Supabase. All secrets live in environment variables.

**Security model (no manual claiming):** the only identity inputs are the BattleX GoTrue session (validated server-side by `auth.verify`) and Discord's OAuth `identify` response. Users never type a Trader ID — signing in *is* the proof. The OAuth `state` parameter is HMAC-signed (client secret) and bound to the browser with a short-lived HttpOnly cookie; replays and cross-browser finishes fail.

---

## Database

`016_discord_connections.sql` (applied automatically on deploy by `npm start` → `db/migrate.js --deploy`):

```sql
discord_connections
  id               UUID PK
  user_id          UUID UNIQUE → users(id)   -- one BattleX account ↔ one Discord
  discord_user_id  TEXT UNIQUE               -- Discord identity is authoritative
  discord_username TEXT
  verified         BOOLEAN
  verified_at      TIMESTAMPTZ
  created_at / updated_at
```

No user/trader/plan tables were duplicated: `users` (001) and `user_entitlements` (014) are reused via the REST join in `discord-bot/store.js`.

---

## Discord Developer Portal setup

1. **Application**: https://discord.com/developers/applications → *New Application* → name it `BattleXJournal`.
2. **Bot tab**: reset token → copy → `DISCORD_TOKEN`. Enable **Server Members Intent** (Privileged Gateway Intents) — required for `guildMemberAdd`.
3. **OAuth2 tab**: copy **Client ID** → `DISCORD_CLIENT_ID` / `DISCORD_OAUTH_CLIENT_ID`; copy **Client secret** → `DISCORD_OAUTH_CLIENT_SECRET`. Add redirect: `https://<your-domain>/api/discord/callback` → `DISCORD_REDIRECT_URI` (must match exactly, including scheme).
4. **Invite the bot**: OAuth2 → URL Generator → scopes `bot` + `applications.commands`; bot permissions: `View Channels`, `Send Messages`, `Embed Links`, `Manage Roles`. Open the generated URL, add the bot to your server.
5. **Server IDs** (Discord settings → Advanced → Developer Mode on, then right-click → Copy ID):
   - server → `DISCORD_GUILD_ID`
   - `#welcome` channel → `WELCOME_CHANNEL_ID`
   - create a **Verified Trader** role, place it *below* the bot's role → `VERIFIED_TRADER_ROLE_ID`

---

## Environment variables

**Web server (31trades on Render):**

```
DISCORD_CLIENT_ID=…
DISCORD_OAUTH_CLIENT_SECRET=…        # server-only
DISCORD_REDIRECT_URI=https://<domain>/api/discord/callback
DISCORD_TOKEN=…                      # only for role assignment (server-side)
DISCORD_GUILD_ID=…
VERIFIED_TRADER_ROLE_ID=…
```

**Bot service (discord-bot on Render):**

```
DISCORD_TOKEN=…
DISCORD_CLIENT_ID=…
DISCORD_GUILD_ID=…
WELCOME_CHANNEL_ID=…
VERIFIED_TRADER_ROLE_ID=…
BATTLEXJOURNAL_URL=https://battlexjournal.com
SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…          # server-only, never frontend
PORT=…                               # Render injects this
```

---

## Verification flow (end to end)

```
1. Member joins           → guildMemberAdd → #welcome embed [🚀 Get Started] [🔐 Verify BattleX]
2. User clicks /verify    → ephemeral card with "Verify on BattleXJournal" link button
3. settings.html          → "Verify BattleX" button → GET /api/discord/begin (Bearer session)
4. begin                  → validates session, sets HttpOnly binding cookie,
                            returns signed Discord authorize URL → browser redirects
5. Discord consent        → scope: identify
6. /api/discord/callback  → validates state (HMAC + cookie + 10-min expiry)
                            → exchanges code → fetches Discord ID
                            → ensureUserMirror → INSERT discord_connections
                            → audit_log entry
                            → assigns Verified Trader role (best effort)
                            → 302 to /discord-verify.html?status=success|error
7. Bot /profile           → reads discord_connections ⨝ user_entitlements → branded card
```

Conflict handling: a Discord account already linked to a *different* BattleX account is rejected with `action: conflict-denied` in the audit log — no silent re-binding. Re-verifying the same pair is idempotent-safe via the two UNIQUE constraints.

---

## Deployment (Render)

**Service 1 — web (existing):** your current web service already runs `npm start`, which applies migration 016 automatically. Just add the web env vars above.

**Service 2 — bot:**

| Setting | Value |
| :-- | :-- |
| Type | Web Service (needs an HTTP port for health checks) |
| Root Directory | `discord-bot` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

The bot serves `/health` on `$PORT` so Render's probes pass; Discord traffic goes over the gateway connection, independent of the HTTP port.

---

## Reliability

- Every `guildMemberAdd` / interaction handler is wrapped — one failure never crashes the process.
- `unhandledRejection` / `uncaughtException` are logged, not fatal.
- discord.js auto-reconnects on shard disconnect/resume (logged).
- Missing welcome channel, missing role, missing Manage Roles permission, role above the bot's role → logged + skipped; verification still succeeds.
- Duplicate joins are tolerated; bots are ignored; `Partials.GuildMember` handles partial events.
- Supabase unreachable → ephemeral error to the user, retry-safe (idempotent upsert on retry).

## Security checklist

- [x] No secrets in code — everything from env vars; config validation fails closed (names only in errors).
- [x] Service-role key and OAuth client secret exist **only** in server processes (web server, bot) — never shipped to the browser.
- [x] Access tokens / codes / secrets never logged; `maskSecret` discipline reused from the existing server.
- [x] OAuth `state` is HMAC-signed, expiry-bound (10 min) and cookie-bound — replay and CSRF resistant.
- [x] Binding cookie: `HttpOnly`, `SameSite=Lax`, `Secure` behind HTTPS, cleared on every terminal path.
- [x] Manual Trader-ID claiming is impossible: no endpoint accepts a user-supplied trader/discord mapping.
- [x] One Discord ↔ one BattleX account, enforced by two UNIQUE constraints + explicit conflict rejection.
- [x] `audit_log` records verified / conflict-denied events (append-only).
- [x] Bot never removes roles — grant only.
- [x] CSP / security headers apply to the new result page automatically (existing `securityHeaders`).

## Local development

```bash
# web server (from 31trades/)
npm run dev                          # http://127.0.0.1:8080

# bot (from 31trades/discord-bot/)
npm run dev                          # needs real DISCORD_TOKEN
```

For local OAuth testing set `DISCORD_REDIRECT_URI=http://127.0.0.1:8080/api/discord/callback` and add exactly that to the Discord OAuth2 redirects.
