'use strict';

// ============================================================================
// 31TRADES — Public trader profiles (social layer)
// ----------------------------------------------------------------------------
// The identity half of the social layer. A trader stays completely invisible
// until they OPT IN (visibility.public = false by default) — and even then each
// metric can be hidden individually (net P&L is often private while win rate and
// avg R are not).
//
//   user_id ──▶ profile { handle, displayName, bio, country, avatar, links,
//                         visibility }        ← identity, never the email/UUID
//
// Storage mirrors the house pattern (008–011, 016): Supabase `social_profiles`
// first, per-store JSON file as the local-first fallback. Every function is
// async and always resolves — routes never see a throw from here.
//
// Public exposure rules (enforced in metricAllowed / publicProfile):
//   · no email, no user_id, no auth material ever leaves this module
//   · a profile is only visible when visibility.public === true
//   · each metric is gated by its own flag (see FLAG_FOR)
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');

// ---------------------------------------------------------------------------
// Shape + validation
// ---------------------------------------------------------------------------

const DEFAULT_VISIBILITY = Object.freeze({
    public: false,          // master switch — nothing is published until this is true
    showNet: true,          // net P&L (also gates profit factor)
    showWinRate: true,
    showAvgR: true,
    showTrades: true,
    showDiscipline: true,
    showSquad: true
});

const VISIBILITY_KEYS = Object.keys(DEFAULT_VISIBILITY);

// metric → visibility flag(s) that must be true for it to be shown / ranked on
const FLAG_FOR = {
    net: ['showNet'],
    pf: ['showNet'],
    winRate: ['showWinRate'],
    avgR: ['showAvgR'],
    trades: ['showTrades'],
    discipline: ['showDiscipline'],
    bxScore: ['showAvgR', 'showWinRate']   // process score — no profit data required
};

// Handles are public URLs — keep them clean and predictable.
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const RESERVED = new Set([
    'api', 'admin', 'administrator', 'me', 'you', 'battlex', 'battlexjournal', '31trades',
    'support', 'help', 'settings', 'profile', 'profiles', 'leaderboard', 'squads', 'squad',
    'community', 'journal', 'login', 'logout', 'signup', 'signin', 'auth', 'app', 'www',
    'null', 'undefined', 'anonymous', 'trader', 'system', 'root', 'mod', 'moderator'
]);

const LIMITS = { bio: 280, displayName: 40, country: 2, handle: 24 };

function text(v, max) {
    if (v === undefined || v === null) return null;
    // strip control chars, collapse runs of whitespace, clamp length
    const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.slice(0, max);
}

// 'Sri Ram' → 'sri-ram'; '  ...TRAILING--- ' → 'trailing'
function slugFromName(name) {
    return String(name == null ? '' : name)
        .toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, LIMITS.handle);
}

function normalizeHandle(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).toLowerCase().trim().replace(/^@/, '')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, LIMITS.handle);
    return s || null;
}

// Returns null when valid, else a human-readable reason (routes → 400).
function handleError(handle) {
    if (!handle) return 'handle is required (3–24 chars: a–z, 0–9, dash, underscore)';
    if (!HANDLE_RE.test(handle)) return 'handle must be 3–24 chars, start with a letter or number, and use only a–z, 0–9, dash or underscore';
    if (RESERVED.has(handle)) return 'that handle is reserved — pick another';
    return null;
}

function normalizeVisibility(v) {
    const out = { ...DEFAULT_VISIBILITY };
    if (!v || typeof v !== 'object') return out;
    VISIBILITY_KEYS.forEach(k => { if (typeof v[k] === 'boolean') out[k] = v[k]; });
    return out;
}

function normalizeLinks(l) {
    const out = {};
    if (!l || typeof l !== 'object') return out;
    ['x', 'discord', 'youtube', 'website', 'tradingview'].forEach(k => {
        const v = text(l[k], 120);
        if (v) out[k] = v;
    });
    return out;
}

const AVATAR_RE = /^#[0-9a-f]{6}$/i;
function normalizeAvatar(a) {
    const s = text(a, 7);
    return s && AVATAR_RE.test(s) ? s.toLowerCase() : null;
}

function normalizeCountry(c) {
    // strict: only a 2-letter code is accepted ("INDIA" is a mistake, not "IN")
    const s = text(c, 8);
    return s && /^[a-z]{2}$/i.test(s) ? s.toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Storage — Supabase first, JSON file fallback (same shape both places)
// ---------------------------------------------------------------------------

function storeFile() {
    return path.join(process.env.TRADEMIND_SOCIAL_DATA_DIR || path.join(__dirname, '..', 'data'), 'social-profiles.json');
}

function blankStore() { return { byUser: {}, byHandle: {} }; }

function readStore() {
    try {
        const f = storeFile();
        if (fs.existsSync(f)) {
            const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
            return {
                byUser: raw && raw.byUser ? raw.byUser : {},
                byHandle: raw && raw.byHandle ? raw.byHandle : {}
            };
        }
    } catch (e) { /* corrupt file → start clean, never throw into a route */ }
    return blankStore();
}

function writeStore(s) {
    try {
        const f = storeFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(s));
    } catch (e) { /* ignore — DB copy is authoritative when present */ }
}

// row (snake_case, pg) → profile (camelCase, canonical)
function fromRow(r) {
    return {
        userId: r.user_id,
        handle: normalizeHandle(r.handle),
        displayName: text(r.display_name, LIMITS.displayName),
        bio: text(r.bio, LIMITS.bio),
        country: normalizeCountry(r.country),
        avatar: normalizeAvatar(r.avatar),
        links: normalizeLinks(r.links),
        visibility: normalizeVisibility(r.visibility),
        createdAt: r.created_at || null,
        updatedAt: r.updated_at || null
    };
}

// profile (canonical) → row (snake_case, pg insert)
function toRow(p) {
    return [
        p.userId, p.handle, p.displayName, p.bio, p.country, p.avatar,
        JSON.stringify(p.links || {}), JSON.stringify(p.visibility || DEFAULT_VISIBILITY)
    ];
}

const ROW_COLUMNS = [
    'user_id', 'handle', 'display_name', 'bio', 'country', 'avatar',
    'links', 'visibility'
];

async function dbAll() {
    const pool = db.getPool();
    if (!pool) return null;
    try {
        const r = await pool.query('SELECT * FROM social_profiles');
        return r.rows.map(fromRow);
    } catch (e) {
        return null;   // table missing / DB down → file fallback
    }
}

async function dbUpsert(p) {
    const pool = db.getPool();
    if (!pool) return false;
    try {
        const row = toRow(p);
        const params = row.map((_, i) => '$' + (i + 1));
        await pool.query(
            'INSERT INTO social_profiles (' + ROW_COLUMNS.join(', ') + ', updated_at) VALUES (' +
            params.join(', ') + ', now()) ' +
            'ON CONFLICT (user_id) DO UPDATE SET ' +
            ROW_COLUMNS.slice(1).map((c, i) => c + ' = $' + (i + 2)).join(', ') +
            ', updated_at = now()',
            row
        );
        return true;
    } catch (e) {
        return false;
    }
}

function fileUpsert(p) {
    const s = readStore();
    const prev = s.byUser[p.userId] || null;
    if (prev && prev.handle && prev.handle !== p.handle && s.byHandle[prev.handle] === p.userId) {
        delete s.byHandle[prev.handle];
    }
    s.byUser[p.userId] = p;
    if (p.handle) s.byHandle[p.handle] = p.userId;
    writeStore(s);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// The caller's own profile — always resolves; new users get a blank, private one.
async function get(userId) {
    const uid = String(userId || '');
    const dbRows = await dbAll();
    if (dbRows) {
        const mine = dbRows.find(p => p.userId === uid);
        if (mine) return mine;
    }
    const s = readStore();
    if (s.byUser[uid]) return s.byUser[uid];
    return {
        userId: uid, handle: null, displayName: null, bio: null, country: null,
        avatar: null, links: {}, visibility: { ...DEFAULT_VISIBILITY },
        createdAt: null, updatedAt: null
    };
}

// Every profile, keyed by userId — the leaderboard's join table.
async function all() {
    const dbRows = await dbAll();
    const s = readStore();
    const out = {};
    Object.keys(s.byUser).forEach(uid => { out[uid] = s.byUser[uid]; });
    if (dbRows) dbRows.forEach(p => { out[p.userId] = p; });   // DB wins
    return out;
}

async function byHandle(handle) {
    const h = normalizeHandle(handle);
    if (!h) return null;
    const dbRows = await dbAll();
    if (dbRows) {
        const hit = dbRows.find(p => p.handle === h);
        if (hit) return hit;
    }
    const s = readStore();
    const uid = s.byHandle[h];
    return uid ? (s.byUser[uid] || null) : null;
}

// Patch semantics: only the fields present in `patch` are touched.
async function save(userId, patch) {
    const uid = String(userId || '');
    if (!uid) return { ok: false, error: 'missing user' };
    const current = await get(uid);
    const p = patch || {};

    const visibility = p.visibility === undefined
        ? normalizeVisibility(current.visibility)
        : normalizeVisibility({ ...current.visibility, ...(p.visibility || {}) });

    // An explicitly requested handle is validated LOUDLY (the trader typed it);
    // an empty string means "clear it". A derived handle that turns out to be
    // reserved just stays null — an unrelated bio edit must not 400.
    let handle = current.handle;
    if (p.handle !== undefined) {
        if (p.handle === null || String(p.handle).trim() === '') {
            handle = null;
        } else {
            const h = normalizeHandle(p.handle);
            const err = handleError(h);
            if (err) return { ok: false, error: err };
            handle = h;
        }
    } else if (!handle) {
        const derived = slugFromName(p.displayName || current.displayName);
        handle = reservedOrInvalid(derived) ? null : derived;
    }

    if (handle && handle !== current.handle) {
        const taken = await byHandle(handle);
        if (taken && taken.userId !== uid) return { ok: false, error: 'that handle is already taken' };
    }
    // Publishing requires a usable handle.
    if (visibility.public && !handle) {
        return { ok: false, error: 'set a handle (3–24 chars) before making your profile public' };
    }

    const next = {
        userId: uid,
        handle,
        displayName: p.displayName === undefined ? current.displayName : text(p.displayName, LIMITS.displayName),
        bio: p.bio === undefined ? current.bio : text(p.bio, LIMITS.bio),
        country: p.country === undefined ? current.country : normalizeCountry(p.country),
        avatar: p.avatar === undefined ? current.avatar : normalizeAvatar(p.avatar),
        links: p.links === undefined ? normalizeLinks(current.links) : normalizeLinks({ ...current.links, ...(p.links || {}) }),
        visibility,
        createdAt: current.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    if (!next.displayName) next.displayName = next.handle;

    await dbUpsert(next);
    fileUpsert(next);
    return { ok: true, profile: next };
}

function reservedOrInvalid(handle) {
    return !handle || !HANDLE_RE.test(handle) || RESERVED.has(handle);
}

// metric gate — is this trader allowed to expose/rank on `metric`?
function metricAllowed(profile, metric) {
    if (!profile || !profile.visibility || profile.visibility.public !== true) return false;
    const flags = FLAG_FOR[metric];
    if (!flags) return false;
    return flags.every(f => profile.visibility[f] !== false);
}

// Which metrics this trader exposes (drives both board eligibility + masking).
function allowedMetrics(profile) {
    const out = {};
    Object.keys(FLAG_FOR).forEach(m => { out[m] = metricAllowed(profile, m); });
    return out;
}

// The public-facing projection. Identity only — never email/user_id/auth data.
function publicProfile(profile, extra) {
    if (!profile) return null;
    return {
        handle: profile.handle,
        displayName: profile.displayName || profile.handle,
        bio: profile.bio,
        country: profile.country,
        avatar: profile.avatar,
        links: profile.links || {},
        joinedAt: profile.createdAt || null,
        allowed: allowedMetrics(profile),
        ...(extra || {})
    };
}

module.exports = {
    DEFAULT_VISIBILITY, FLAG_FOR, RESERVED, LIMITS,
    get, all, byHandle, save,
    metricAllowed, allowedMetrics, publicProfile,
    normalizeHandle, slugFromName, handleError, normalizeVisibility,
    fromRow, toRow, ROW_COLUMNS,
    storeFile
};
