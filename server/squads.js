'use strict';

// ============================================================================
// 31TRADES — Squads (social layer)
// ----------------------------------------------------------------------------
// A squad is a named team with a short banner tag and a join code. Standings
// reuse the leaderboard's day aggregates — no second calculation path:
//
//   squad_members[userIds] ──▶ Leaderboard.entriesFor() ──▶ merge day aggregates
//                                                        └─▶ metricsFromDays()
//                                                        └─▶ bxScore()
//
// Membership rules:
//   · one squad per trader (unique index on squad_members.user_id) — leaving is
//     the only way to switch, so squad standings stay unambiguous
//   · the owner can disband (members are released, never deleted)
//   · MAX_MEMBERS caps squad size
//
// Privacy: squad totals aggregate the team's ledger — that is the deal of
// joining a squad, and it is stated on join. Per-member rows expose ONLY what
// each trader's profile allows: a trader with a private profile shows up as
// "Private trader" with no metrics, and their identity is never revealed.
//
// Storage mirrors the rest of the social layer: Supabase first, JSON file
// fallback (data/squads.json). Every function is async and always resolves.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');
const Profiles = require('./profiles.js');
const Leaderboard = require('./leaderboard.js');

const MAX_MEMBERS = 20;
const MAX_SQUADS_LISTED = 50;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no ambiguous chars
function genCode(len) {
    let out = '';
    for (let i = 0; i < (len || 6); i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return out;
}

function newId() {
    return 'sqd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function text(v, max) {
    if (v === undefined || v === null) return null;
    const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
}

const TAG_RE = /^[A-Z0-9]{2,5}$/;
function normalizeTag(raw) {
    const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    return s || null;
}
function tagError(tag) {
    if (!tag) return 'tag is required (2–5 letters or digits)';
    if (!TAG_RE.test(tag)) return 'tag must be 2–5 characters (A–Z, 0–9)';
    return null;
}
function nameError(name) {
    if (!name) return 'squad name is required (2–24 characters)';
    if (name.length < 2 || name.length > 24) return 'squad name must be 2–24 characters';
    return null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const SQUAD_COLUMNS = ['id', 'name', 'tag', 'owner_id', 'invite_code'];
const MEMBER_COLUMNS = ['squad_id', 'user_id', 'role'];

function storeFile() {
    return path.join(process.env.TRADEMIND_SOCIAL_DATA_DIR || path.join(__dirname, '..', 'data'), 'squads.json');
}

function blank() { return { squads: {}, members: {} }; }

function readStore() {
    try {
        const f = storeFile();
        if (fs.existsSync(f)) {
            const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
            return { squads: raw.squads || {}, members: raw.members || {} };
        }
    } catch (e) { /* ignore */ }
    return blank();
}

function writeStore(s) {
    try {
        const f = storeFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(s));
    } catch (e) { /* ignore */ }
}

function squadFromRow(r) {
    return {
        id: r.id, name: r.name, tag: r.tag, ownerId: r.owner_id,
        inviteCode: r.invite_code,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null
    };
}

async function dbSquads() {
    const pool = db.getPool();
    if (!pool) return null;
    try {
        const r = await pool.query('SELECT * FROM squads');
        return r.rows.map(squadFromRow);
    } catch (e) { return null; }
}

async function dbMembers() {
    const pool = db.getPool();
    if (!pool) return null;
    try {
        const r = await pool.query('SELECT squad_id, user_id, role, joined_at FROM squad_members');
        return r.rows.map(x => ({ squadId: x.squad_id, userId: x.user_id, role: x.role, joinedAt: x.joined_at }));
    } catch (e) { return null; }
}

async function dbUpsertSquad(s) {
    const pool = db.getPool();
    if (!pool) return false;
    try {
        await pool.query(
            'INSERT INTO squads (' + SQUAD_COLUMNS.join(', ') + ') VALUES ($1,$2,$3,$4,$5) ' +
            'ON CONFLICT (id) DO UPDATE SET name = $2, tag = $3, owner_id = $4, invite_code = $5',
            [s.id, s.name, s.tag, s.ownerId, s.inviteCode]);
        return true;
    } catch (e) { return false; }
}

async function dbDeleteSquad(id) {
    const pool = db.getPool();
    if (!pool) return false;
    try { await pool.query('DELETE FROM squads WHERE id = $1', [id]); return true; }
    catch (e) { return false; }
}

async function dbAddMember(squadId, userId, role) {
    const pool = db.getPool();
    if (!pool) return false;
    try {
        await pool.query(
            'INSERT INTO squad_members (' + MEMBER_COLUMNS.join(', ') + ') VALUES ($1,$2,$3) ' +
            'ON CONFLICT (squad_id, user_id) DO UPDATE SET role = $3',
            [squadId, userId, role || 'member']);
        return true;
    } catch (e) { return false; }
}

async function dbRemoveMember(userId) {
    const pool = db.getPool();
    if (!pool) return false;
    try { await pool.query('DELETE FROM squad_members WHERE user_id = $1', [userId]); return true; }
    catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

// DB rows merged with the file mirror (DB wins on conflict).
async function all() {
    const file = readStore();
    const squads = { ...file.squads };
    const members = { ...file.members };
    const [rows, dbMem] = await Promise.all([dbSquads(), dbMembers()]);
    if (rows) rows.forEach(s => { squads[s.id] = s; });
    if (dbMem) dbMem.forEach(m => { members[m.userId] = m.squadId; });
    return { squads, members };
}

const byIdSync = (store, id) => store.squads[id] || null;

async function byId(id) {
    const store = await all();
    return byIdSync(store, String(id || ''));
}

async function byCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return null;
    const store = await all();
    return Object.values(store.squads).find(s => s.inviteCode === c) || null;
}

// The caller's squad (or null).
async function mine(userId) {
    const store = await all();
    const id = store.members[String(userId || '')];
    return id ? byIdSync(store, id) : null;
}

async function membersOf(id) {
    const store = await all();
    return Object.keys(store.members).filter(uid => store.members[uid] === id);
}

// Directory of squads (for discovery) + the caller's own squad.
async function list(userId) {
    const store = await all();
    const uid = String(userId || '');
    const counts = {};
    Object.keys(store.members).forEach(m => { counts[store.members[m]] = (counts[store.members[m]] || 0) + 1; });
    const squads = Object.values(store.squads)
        .map(s => ({ id: s.id, name: s.name, tag: s.tag, members: counts[s.id] || 0, createdAt: s.createdAt }))
        .sort((a, b) => b.members - a.members || a.name.localeCompare(b.name))
        .slice(0, MAX_SQUADS_LISTED);
    const mineId = store.members[uid] || null;
    return { mine: mineId ? (store.squads[mineId] || null) : null, squads };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function create(userId, opts) {
    const uid = String(userId || '');
    if (!uid) return { ok: false, error: 'missing user' };
    const o = opts || {};
    const name = text(o.name, 24);
    const tag = normalizeTag(o.tag);
    const nErr = nameError(name); if (nErr) return { ok: false, error: nErr };
    const tErr = tagError(tag); if (tErr) return { ok: false, error: tErr };

    const store = await all();
    if (store.members[uid]) return { ok: false, error: 'you are already in a squad — leave it first' };
    if (Object.values(store.squads).some(s => String(s.tag).toUpperCase() === tag)) {
        return { ok: false, error: 'that tag is already taken' };
    }

    const squad = { id: newId(), name, tag, ownerId: uid, inviteCode: genCode(6), createdAt: new Date().toISOString() };
    await dbUpsertSquad(squad);
    const file = readStore();
    file.squads[squad.id] = squad;
    file.members[uid] = squad.id;
    writeStore(file);

    await dbAddMember(squad.id, uid, 'owner');
    await Leaderboard.setSquad(uid, squad.id);
    return { ok: true, view: await view(squad.id, { userId: uid }) };
}

async function join(userId, code) {
    const uid = String(userId || '');
    if (!uid) return { ok: false, error: 'missing user' };
    const squad = await byCode(code);
    if (!squad) return { ok: false, error: 'invalid squad code' };
    const store = await all();
    if (store.members[uid]) return { ok: false, error: 'you are already in a squad — leave it first' };
    const members = await membersOf(squad.id);
    if (members.length >= MAX_MEMBERS) return { ok: false, error: 'this squad is full (' + MAX_MEMBERS + ' members)' };

    await dbAddMember(squad.id, uid, 'member');
    const file = readStore();
    if (!file.squads[squad.id]) file.squads[squad.id] = squad;
    file.members[uid] = squad.id;
    writeStore(file);
    await Leaderboard.setSquad(uid, squad.id);
    return { ok: true, view: await view(squad.id, { userId: uid }) };
}

async function leave(userId) {
    const uid = String(userId || '');
    const store = await all();
    const id = store.members[uid];
    if (!id) return { ok: true, squad: null };
    const squad = byIdSync(store, id);

    // The owner leaving hands the squad over; if they are the last member the
    // squad is dissolved so no orphan tag blocks the directory.
    const others = (await membersOf(id)).filter(m => m !== uid);
    if (squad && squad.ownerId === uid) {
        if (!others.length) return await disband(uid, id);
        const next = others[0];
        const updated = { ...squad, ownerId: next };
        await dbUpsertSquad(updated);
        const file = readStore();
        file.squads[id] = updated;
        writeStore(file);
    }

    await dbRemoveMember(uid);
    const file = readStore();
    delete file.members[uid];
    writeStore(file);
    await Leaderboard.setSquad(uid, null);
    return { ok: true, squad: null, ownerHandedTo: (squad && squad.ownerId === uid && others.length) ? others[0] : null };
}

async function disband(userId, id) {
    const uid = String(userId || '');
    const store = await all();
    const squad = byIdSync(store, String(id || ''));
    if (!squad) return { ok: false, error: 'unknown squad' };
    if (squad.ownerId !== uid) return { ok: false, error: 'only the squad owner can disband' };

    const members = await membersOf(squad.id);
    await dbDeleteSquad(squad.id);
    const file = readStore();
    delete file.squads[squad.id];
    members.forEach(m => { delete file.members[m]; });
    writeStore(file);
    for (const m of members) {
        await dbRemoveMember(m);
        await Leaderboard.setSquad(m, null);
    }
    return { ok: true, disbanded: squad.id, released: members.length };
}

// ---------------------------------------------------------------------------
// Standings — squad total + per-member rows (privacy-masked)
// ---------------------------------------------------------------------------

function mergeDays(target, src) {
    Object.keys(src || {}).forEach(k => {
        const d = target[k] || (target[k] = { n: 0, w: 0, l: 0, gW: 0, gL: 0, rS: 0, rk: 0, net: 0 });
        const s = src[k] || {};
        d.n += s.n || 0; d.w += s.w || 0; d.l += s.l || 0;
        d.gW += s.gW || 0; d.gL += s.gL || 0;
        d.rS += s.rS || 0; d.rk += s.rk || 0; d.net += s.net || 0;
    });
    return target;
}

async function view(id, opts) {
    const o = opts || {};
    const squad = await byId(id);
    if (!squad) return null;
    const range = Leaderboard.validRange(o.range) ? String(o.range).toLowerCase() : '30d';
    const minTrades = Number(o.minTrades) > 0 ? Math.round(Number(o.minTrades)) : Leaderboard.MIN_TRADES_DEFAULT;

    const memberIds = await membersOf(squad.id);
    const [entries, profiles] = await Promise.all([
        Leaderboard.entriesFor(memberIds),
        Profiles.all()
    ]);

    // Squad total: every member's ledger contributes (that is the squad deal),
    // but member-level rows only expose what each trader's profile allows.
    const merged = {};
    entries.forEach(e => mergeDays(merged, e.days));
    const totals = Leaderboard.metricsFromDays(merged);
    const bx = Leaderboard.bxScore(totals, minTrades);

    const memberRows = memberIds.map(uid => {
        const p = profiles[uid];
        const e = entries.find(x => x.userId === uid) || null;
        const isPublic = !!(p && p.visibility.public === true);
        const s = e ? Leaderboard.summarize(e, { range, minTrades }) : null;
        return {
            userId: uid,
            role: squad.ownerId === uid ? 'owner' : 'member',
            public: isPublic,
            handle: isPublic && p.handle ? p.handle : null,
            displayName: isPublic ? (p.displayName || p.handle) : 'Private trader',
            avatar: isPublic ? (p.avatar || null) : null,
            country: isPublic ? (p.country || null) : null,
            metrics: isPublic && s ? {
                trades: s.metrics.n,
                net: p.visibility.showNet === false ? null : s.metrics.net,
                winRate: p.visibility.showWinRate === false ? null : s.metrics.winRate,
                avgR: p.visibility.showAvgR === false ? null : s.metrics.avgR
            } : null,
            bxScore: isPublic && p.visibility.showAvgR !== false && p.visibility.showWinRate !== false && s ? s.bxScore : null,
            // expose only what the member allows — never their email or user id
            exposed: isPublic ? Profiles.allowedMetrics(p) : {}
        };
    });

    const ranked = memberRows.filter(m => m.public).sort((a, b) => (b.bxScore || -1) - (a.bxScore || -1));

    return {
        ok: true,
        squad: {
            id: squad.id,
            name: squad.name,
            tag: squad.tag,
            ownerId: squad.ownerId,
            createdAt: squad.createdAt,
            memberCount: memberIds.length,
            maxMembers: MAX_MEMBERS
        },
        // invite code is only returned to members
        inviteCode: o.userId && memberIds.indexOf(String(o.userId)) !== -1 ? squad.inviteCode : null,
        isMember: o.userId ? memberIds.indexOf(String(o.userId)) !== -1 : false,
        isOwner: o.userId ? squad.ownerId === String(o.userId) : false,
        range, minTrades,
        totals: {
            trades: totals.trades,
            net: totals.net,
            winRate: totals.winRate,
            avgR: totals.avgR,
            pf: totals.pf,
            maxDD: totals.maxDD,
            activeDays: totals.activeDays,
            bestDayStreak: totals.bestDayStreak,
            streak: totals.streak
        },
        bxScore: bx ? bx.score : null,
        bxComps: bx ? bx.comps : null,
        members: memberRows,
        leader: ranked[0] || null
    };
}

const standings = (id, opts) => view(id, opts);

module.exports = {
    MAX_MEMBERS, MAX_SQUADS_LISTED,
    create, join, leave, disband,
    mine, list, byId, byCode, membersOf, all,
    view, standings,
    normalizeTag, tagError, nameError, genCode,
    storeFile
};
