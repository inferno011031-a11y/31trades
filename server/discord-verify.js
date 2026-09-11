'use strict';

// ============================================================================
// BATTLEXJOURNAL — Discord ↔ BattleX identity verification (web side)
// ----------------------------------------------------------------------------
// Stateless OAuth bridge between Discord and the BattleXJournal account.
//
//   GET /api/discord/begin        (Bearer session) → 302 to Discord authorize
//   GET /api/discord/callback      (public)        → 302 to /discord-verify.html?status=…&msg=…
//
// Security invariants:
//   · The ONLY identity inputs are (a) the BattleX GoTrue session (validated
//     by auth.verify) and (b) Discord's OAuth identify response. The user
//     never types a Trader ID — manual claiming is impossible by construction.
//   · OAuth state = <issued>.<userId>.<nonce>.<HMAC> signed with the OAuth
//     client secret AND bound to the browser via a HttpOnly cookie echoed
//     back at the callback. Replay of a captured state without the cookie
//     fails. No server-side storage.
//   · Secrets never leave the process and never appear in logs.
//   · Role assignment never fails the verification.
// ============================================================================

const crypto = require('node:crypto');
const db = require('./db.js');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BIND_COOKIE = 'bxj_oauth_bind';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function cfg() {
    return {
        clientId: process.env.DISCORD_CLIENT_ID || process.env.DISCORD_OAUTH_CLIENT_ID || '',
        clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET || '',
        redirectUri: process.env.DISCORD_REDIRECT_URI || '',
        botToken: process.env.DISCORD_TOKEN || '',
        guildId: process.env.DISCORD_GUILD_ID || '',
        roleId: process.env.VERIFIED_TRADER_ROLE_ID || ''
    };
}

function configured() {
    const c = cfg();
    return !!(c.clientId && c.clientSecret && c.redirectUri);
}

function redirectUriFromReq(req) {
    // Prefer explicit env (production); else derive from the incoming Host so
    // local dev works with zero config.
    const c = cfg();
    if (c.redirectUri) return c.redirectUri;
    const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '127.0.0.1:8080';
    const proto = req && req.headers && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0] : 'http';
    return proto + '://' + host + '/api/discord/callback';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function log(scope, msg) {
    console.log('[discord-verify] ' + scope + ': ' + msg);
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
}

function hmac(payload) {
    const secret = process.env.DISCORD_OAUTH_CLIENT_SECRET || '';
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = (data && (data.error_description || data.message || data.error)) || ('HTTP ' + res.status);
        throw Object.assign(new Error(String(msg)), { status: res.status });
    }
    return data;
}

// ---------------------------------------------------------------------------
// State: <issuedMs>.<userId>.<nonce>.<hmac(payload)>
// The nonce is ALSO set as a short-lived HttpOnly cookie; the callback
// requires state.nonce === cookie value, so a stolen state alone is useless.
// ---------------------------------------------------------------------------
function makeState(userId) {
    const issued = Date.now();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const payload = issued + '.' + userId + '.' + nonce;
    return { state: payload + '.' + hmac(payload), nonce };
}

// Returns null when valid, else a reason string.
function checkState(state, userId, cookieNonce) {
    if (!state || typeof state !== 'string') return 'malformed';
    const parts = state.split('.');
    if (parts.length !== 4) return 'malformed';
    const [issued, stUserId, nonce, sig] = parts;
    const payload = issued + '.' + stUserId + '.' + nonce;
    if (!safeEqual(hmac(payload), sig)) return 'bad-signature';
    if (stUserId !== userId) return 'user-mismatch';
    if (!cookieNonce || !safeEqual(nonce, cookieNonce)) return 'browser-mismatch';
    const age = Date.now() - Number(issued);
    if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) return 'expired';
    return null;
}

// ---------------------------------------------------------------------------
// Supabase REST (service role)
// ---------------------------------------------------------------------------
function sbBase() {
    let u = (process.env.SUPABASE_URL || '').trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u.replace(/\/+$/, '');
}

function serviceHeaders(prefer) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const h = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (prefer) h.Prefer = prefer;
    return h;
}

function serviceConfigured() {
    return !!(sbBase() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function sbPost(path, rows, prefer) {
    const res = await fetch(sbBase() + path, { method: 'POST', headers: serviceHeaders(prefer), body: JSON.stringify(rows) });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw Object.assign(new Error('Supabase ' + path + ' failed HTTP ' + res.status + (t ? ': ' + t.slice(0, 300) : '')), { status: res.status, pgCode: (t.match(/"code":"(\d{5})"/) || [])[1] });
    }
    return res.json().catch(() => null);
}

async function ensureUserMirror(user) {
    // public.users is a lightweight mirror of auth.users needed by FKs —
    // same approach as pg-repo.ensureUser. Password stays in GoTrue.
    try {
        await sbPost('/rest/v1/users?on_conflict=id',
            [{ id: user.id, email: user.email || 'trader@battlexjournal.dev', password_hash: '!', display_name: user.name || 'Trader' }],
            'resolution=merge-duplicates');
    } catch (e) {
        log('mirror', 'users upsert failed (FK insert may fail): ' + e.message);
    }
}

async function insertConnection(row) {
    // Prefer = return=representation so we can detect cross-account conflicts.
    try {
        const rows = await sbPost('/rest/v1/discord_connections', [row], 'return=representation');
        return { ok: true, row: Array.isArray(rows) ? rows[0] : null };
    } catch (e) {
        // 23505 unique_violation — the OTHER unique column collided.
        if (e.pgCode === '23505') return { ok: false, conflict: true };
        throw e;
    }
}

async function auditEntry(entry) {
    // audit_log is append-only per 001; failures never break verification.
    try {
        await sbPost('/rest/v1/audit_log', [entry]);
    } catch (e) {
        log('audit', 'write failed (non-fatal): ' + e.message);
    }
}

// ---------------------------------------------------------------------------
// Discord REST
// ---------------------------------------------------------------------------
async function exchangeCode(code, redirectUri) {
    const c = cfg();
    const body = new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
    });
    return fetchJson(DISCORD_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
}

async function fetchMe(accessToken) {
    return fetchJson(DISCORD_API + '/users/@me', { headers: { Authorization: 'Bearer ' + accessToken } });
}

async function assignVerifiedRole(discordUserId) {
    const c = cfg();
    if (!c.botToken || !c.guildId || !c.roleId) {
        log('role', 'not configured (DISCORD_TOKEN / DISCORD_GUILD_ID / VERIFIED_TRADER_ROLE_ID missing) — skipping');
        return { attempted: false };
    }
    const url = DISCORD_API + '/guilds/' + encodeURIComponent(c.guildId) + '/members/' + encodeURIComponent(discordUserId) + '/roles/' + encodeURIComponent(c.roleId);
    try {
        const res = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bot ' + c.botToken, 'Content-Length': '0' } });
        if (res.status === 204) return { attempted: true, ok: true };
        if (res.status === 404) { log('role', 'user not in guild or role missing (404) — verification stays successful'); return { attempted: true, ok: false, reason: 'user-not-in-guild-or-role-missing' }; }
        if (res.status === 403) { log('role', 'insufficient permission or role hierarchy (403) — verification stays successful'); return { attempted: true, ok: false, reason: 'insufficient-permission-or-hierarchy' }; }
        const t = await res.text().catch(() => '');
        log('role', 'HTTP ' + res.status + (t ? ' ' + t.slice(0, 200) : '') + ' — verification stays successful');
        return { attempted: true, ok: false, reason: 'http-' + res.status };
    } catch (e) {
        log('role', 'network error: ' + e.message + ' — verification stays successful');
        return { attempted: true, ok: false, reason: 'network-error' };
    }
}

// ---------------------------------------------------------------------------
// Route plumbing
// ---------------------------------------------------------------------------
function redirectTo(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

function done(res, ok, msg, extra) {
    const q = new URLSearchParams({ status: ok ? 'success' : 'error', msg: msg || '' });
    if (extra) for (const k of Object.keys(extra)) q.set(k, extra[k]);
    // Clear the binding cookie in every terminal path.
    res.setHeader('Set-Cookie', BIND_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    redirectTo(res, '/discord-verify.html?' + q.toString());
}

/**
 * GET /api/discord/begin — requires BattleX Bearer session? No: browsers
 * navigate here directly, so the BattleX session is read from the
 * localStorage token via a same-origin page instead. Simplest robust design:
 * the auth'd page (settings/community) calls begin WITH the Bearer header —
 * but a top-level navigation cannot set headers. So begin accepts the token
 * via ?t= … NO. Tokens in URLs leak into logs/history.
 *
 * Final design: begin is called as a fetch() with the Bearer header from the
 * Verify button; it returns { url }. The button then navigates to that URL.
 * This keeps the token out of URLs entirely.
 */
async function handleBegin(req, res, url) {
    try {
        if (!configured()) {
            log('begin', 'not configured: DISCORD_CLIENT_ID / DISCORD_OAUTH_CLIENT_SECRET / DISCORD_REDIRECT_URI missing');
            return json(res, 503, { error: 'Discord verification is not configured yet.' });
        }
        const auth = require('./auth.js');
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
        let user = null;
        if (m) {
            try { user = await auth.verify(m[1]); } catch (e) { user = null; }
        }
        if (!user) return json(res, 401, { error: 'Sign in to BattleXJournal first, then click Verify BattleX.' });

        const { state, nonce } = makeState(user.id);
        const redirectUri = redirectUriFromReq(req);
        const params = new URLSearchParams({
            client_id: cfg().clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'identify',
            state,
            prompt: 'consent'
        });

        // Bind the flow to this browser: nonce must round-trip via cookie.
        const secure = String(process.env.SITE_URL || '').startsWith('https://') ? '; Secure' : '';
        res.setHeader('Set-Cookie', BIND_COOKIE + '=' + nonce + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600' + secure);
        log('begin', 'user ' + user.id + ' starting Discord verification');
        return json(res, 200, { url: DISCORD_AUTHORIZE + '?' + params.toString() });
    } catch (e) {
        log('begin', 'error: ' + e.message);
        return json(res, 500, { error: 'Could not start verification. Please try again.' });
    }
}

function json(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(payload);
}

/**
 * GET /api/discord/callback — Discord redirects here with ?code&state.
 * Top-level navigation: no Bearer header available, the BattleX identity is
 * recovered from the signed state + binding cookie.
 */
async function handleCallback(req, res, url) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const discordErr = url.searchParams.get('error');

    // Parse the binding cookie (set by begin).
    let cookieNonce = null;
    const rawCookie = (req.headers.cookie || '');
    for (const part of rawCookie.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k === BIND_COOKIE) cookieNonce = rest.join('=');
    }

    try {
        if (discordErr) {
            log('callback', 'user denied consent: ' + discordErr);
            return done(res, false, 'Discord authorization was cancelled. You can click Verify BattleX again any time.');
        }
        if (!code || !state) {
            return done(res, false, 'Missing authorization data. Start again from Discord (Verify BattleX).');
        }

        // 1. Validate state against the signed BattleX user + cookie binding.
        const stParts = state.split('.');
        const stUserId = stParts.length === 4 ? stParts[1] : '';
        const reason = checkState(state, stUserId, cookieNonce);
        if (reason) {
            log('callback', 'state rejected: ' + reason);
            const friendly = reason === 'expired' ? 'This verification link has expired. Click Verify BattleX again.'
                : reason === 'browser-mismatch' ? 'Verification must finish in the same browser that started it. Click Verify BattleX again.'
                : 'This verification link is invalid. Click Verify BattleX again.';
            return done(res, false, friendly);
        }
        const battleUserId = stUserId;

        // 2. Discord identity.
        const tok = await exchangeCode(code, redirectUriFromReq(req));
        const me = await fetchMe(tok.access_token);
        const discordUserId = String(me.id);
        const discordUsername = me.global_name || me.username || ('discord-' + discordUserId);
        log('callback', 'discord identity resolved: ' + discordUserId + ' (' + discordUsername + ')');

        // 3. Persist. ensureUserMirror first so the FK target exists (OAuth
        //    signups may have no public.users row), then insert. A 23505 on
        //    the DISCORD column means this Discord account is already linked
        //    to a different BattleX account → refuse (no silent re-binding).
        try {
            await ensureUserMirror({ id: battleUserId });
            const r = await insertConnection({
                user_id: battleUserId,
                discord_user_id: discordUserId,
                discord_username: discordUsername,
                verified: true,
                verified_at: new Date().toISOString()
            });
            if (!r.ok) {
                log('callback', 'conflict: discord ' + discordUserId + ' already linked to another BattleX account');
                await auditEntry({
                    actor_id: battleUserId,
                    entity_type: 'discord_connection',
                    entity_id: discordUserId,
                    action: 'conflict-denied',
                    detail: 'Discord account already linked to a different BattleX account',
                    new_value: { discord_user_id: discordUserId }
                });
                return done(res, false, 'This Discord account is already linked to a different BattleXJournal account. Sign in with that account, or contact support to unlink.');
            }
        } catch (e) {
            log('callback', 'DB write failed: ' + e.message);
            return done(res, false, 'Verification reached Discord but the BattleX database could not be updated. Please try again shortly.');
        }

        // 4. Audit + role (both non-fatal by design).
        await auditEntry({
            actor_id: battleUserId,
            entity_type: 'discord_connection',
            entity_id: discordUserId,
            action: 'verified',
            detail: 'Discord ' + discordUsername + ' verified against BattleX account',
            new_value: { discord_user_id: discordUserId, discord_username: discordUsername, verified: true }
        });
        const role = await assignVerifiedRole(discordUserId);
        if (role.attempted && role.ok) log('role', 'Verified Trader role granted to ' + discordUserId);

        log('callback', 'SUCCESS battlex ' + battleUserId + ' ↔ discord ' + discordUserId);
        return done(res, true, 'Discord linked. Welcome to the Verified Traders, ' + discordUsername + '!', { discord: discordUsername });
    } catch (e) {
        log('callback', 'error: ' + e.message);
        return done(res, false, 'Verification failed: ' + (e.message || 'unknown error') + '. Click Verify BattleX again to retry.');
    }
}

module.exports = { handleBegin, handleCallback, configured, makeState, checkState };
