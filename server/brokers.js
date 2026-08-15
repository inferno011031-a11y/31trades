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
//   isConnected(userId)          → bool (has any active connection)
//   list(userId)                 → [{ broker, connected_at, status }]
//   connect(userId, broker)      → adds an active connection, returns it
//   disconnect(userId, broker)   → marks it inactive
// All functions are async and always resolve.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.js');

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
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT 1 FROM broker_connections WHERE user_id = $1 AND status = \'active\' LIMIT 1', [userId]);
            if (r.rows.length) return true;
        } catch (e) { /* table may not exist yet → file fallback */ }
    }
    return readFile(userId).some(b => b.status === 'active');
}

async function list(userId) {
    const pool = db.getPool();
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT broker, connected_at FROM broker_connections WHERE user_id = $1 AND status = \'active\' ORDER BY connected_at DESC', [userId]);
            if (r.rows.length) {
                return r.rows.map(row => ({ broker: row.broker, connected_at: row.connected_at, status: 'active' }));
            }
        } catch (e) { /* fall through */ }
    }
    return readFile(userId).filter(b => b.status === 'active');
}

async function connect(userId, broker) {
    const name = String(broker || '').trim() || 'TradingView';
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
    // file mirror (also the standalone fallback)
    const list = readFile(userId).filter(b => !(b.broker === name && b.status === 'active'));
    list.push({ broker: name, status: 'active', connected_at: now });
    writeFile(userId, list);
    return { broker: name, status: 'active', connected_at: now };
}

async function disconnect(userId, broker) {
    const name = String(broker || '').trim();
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
}

module.exports = { isConnected, list, connect, disconnect };
