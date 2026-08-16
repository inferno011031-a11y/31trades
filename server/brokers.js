'use strict';

// ============================================================================
// 31TRADES — Broker connections (per-user state)
// ----------------------------------------------------------------------------
// Tracks which brokers/platforms a user has connected. Used by the onboarding
// checklist ("Connect a broker") so the nudge reflects real state instead of
// a hardcoded value. Persists per user to a small JSON file, with a Supabase
// table (broker_connections) as primary when reachable — the same DB-first /
// file-fallback pattern as notifications read-state and ai_findings.
//
// SECURITY MODEL
//   · Every function takes the authenticated userId and never looks up a
//     different user — reads and writes are scoped to that id only (the file
//     key is per-user and every SQL statement filters on user_id).
//   · No credentials exist here: this is an honest connection REGISTRY, not a
//     live-trading integration. connect() records { broker, status,
//     connected_at } and nothing else — no passwords, API keys, tokens, or
//     private keys are ever stored, logged, or returned.
//
//   isConnected(userId)          → bool (has any active connection)
//   list(userId)                 → [{ broker, connected_at, status }]
//   connect(userId, broker)      → { ok, broker } | { ok:false, error }
//   disconnect(userId, broker)   → { ok } | { ok:false, error }
// All functions are async and always resolve (never throw).
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.js');

const MAX_BROKER_NAME = 100;

// Validate a broker name for the API contract: must be a non-empty string,
// trimmed, and not absurdly long. Returns the clean name or null.
function normalizeName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    if (!name || name.length > MAX_BROKER_NAME) return null;
    return name;
}

function fileFor(userId) {
    return path.join(process.env.TRADEMIND_BROKER_DATA_DIR || path.join(__dirname, '..', 'data'), 'brokers-' + userId + '.json');
}

function readFile(userId) {
    try {
        const f = fileFor(userId);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { /* ignore */ }
    return [];
}

function writeFile(userId, list) {
    try {
        const f = fileFor(userId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(list));
    } catch (e) { /* ignore */ }
}

async function isConnected(userId) {
    const pool = db.getPool();
    let dbAny = false;
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT 1 FROM broker_connections WHERE user_id = $1 AND status = \'active\' LIMIT 1', [userId]);
            dbAny = r.rows.length > 0;
        } catch (e) { /* table may not exist yet → file fallback */ }
    }
    if (dbAny) return true;
    return readFile(userId).some(b => b.status === 'active');
}

async function list(userId) {
    const pool = db.getPool();
    let dbRows = [];
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT broker, connected_at FROM broker_connections WHERE user_id = $1 AND status = \'active\'', [userId]);
            dbRows = r.rows.map(row => ({ broker: row.broker, connected_at: row.connected_at, status: 'active' }));
        } catch (e) { /* table may not exist yet → file only */ }
    }
    const fileRows = readFile(userId)
        .filter(b => b.status === 'active')
        .map(b => ({ broker: b.broker, connected_at: b.connected_at, status: 'active' }));
    // Merge both sources per broker: the DB wins when both have the broker
    // (same-user rows), while the file fills in anything connected during a
    // brief DB outage so reads never lose state.
    const byBroker = new Map();
    fileRows.forEach(b => byBroker.set(b.broker, b));
    dbRows.forEach(b => byBroker.set(b.broker, b));
    return [...byBroker.values()].sort((a, b) =>
        String(b.connected_at || '').localeCompare(String(a.connected_at || '')));
}

async function connect(userId, broker) {
    const name = normalizeName(broker);
    if (!name) return { ok: false, error: 'A valid broker name is required (string, up to ' + MAX_BROKER_NAME + ' characters)' };
    const now = new Date().toISOString();
    const pool = db.getPool();
    if (pool) {
        try {
            await pool.query(
                `INSERT INTO broker_connections (user_id, broker, status, connected_at)
                 VALUES ($1, $2, 'active', $3)
                 ON CONFLICT (user_id, broker) DO UPDATE SET status = 'active', connected_at = EXCLUDED.connected_at`,
                [userId, name, now]);
        } catch (e) { /* fall through to file */ }
    }
    // file mirror (also the standalone fallback). Upsert semantics — remove any
    // prior entry (active OR inactive) so reconnect never leaves a stale row.
    const list = readFile(userId).filter(b => b.broker !== name);
    list.push({ broker: name, status: 'active', connected_at: now });
    writeFile(userId, list);
    return { ok: true, broker: { broker: name, status: 'active', connected_at: now } };
}

async function disconnect(userId, broker) {
    const name = normalizeName(broker);
    if (!name) return { ok: false, error: 'A valid broker name is required (string, up to ' + MAX_BROKER_NAME + ' characters)' };
    const pool = db.getPool();
    if (pool) {
        try {
            await pool.query(
                'UPDATE broker_connections SET status = \'inactive\' WHERE user_id = $1 AND broker = $2',
                [userId, name]);
        } catch (e) { /* fall through */ }
    }
    const list = readFile(userId).map(b =>
        b.broker === name ? Object.assign({}, b, { status: 'inactive' }) : b);
    writeFile(userId, list);
    return { ok: true };
}

module.exports = { isConnected, list, connect, disconnect, normalizeName };
