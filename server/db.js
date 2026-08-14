'use strict';

// ============================================================================
// 31TRADES — Supabase (PostgreSQL) connection layer
// ----------------------------------------------------------------------------
// Reads SUPABASE_DB_URL (the Postgres connection string) from the environment.
//
//   · The pool is created lazily and only when a connection string is present,
//     so the server keeps working in local-first mode without a database.
//   · Everything degrades gracefully: status() reports configured/connected,
//     ping() records the last liveness probe (also the error when down).
//
// Connection string (Supabase dashboard → Project Settings → Database →
// Connection string → URI, Node.js) looks like:
//   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
// ============================================================================

const { Pool } = require('pg');

let pool = null;
let lastPing = null;   // { ok, at, latencyMs, error?, serverTime? }

function dbConfig() {
    const url = process.env.SUPABASE_DB_URL;
    if (!url) return null;
    const ssl = process.env.SUPABASE_DB_SSL !== 'false';
    return {
        connectionString: url,
        ssl: ssl ? { rejectUnauthorized: false } : false,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    };
}

function getPool() {
    if (pool) return pool;
    const cfg = dbConfig();
    if (!cfg) return null;
    pool = new Pool(cfg);
    pool.on('error', err => {
        lastPing = { ok: false, at: new Date().toISOString(), error: err.message };
    });
    return pool;
}

// Live liveness probe — returns and caches the result.
async function ping() {
    const p = getPool();
    if (!p) {
        lastPing = { ok: false, at: new Date().toISOString(), error: 'not configured — set SUPABASE_DB_URL in .env' };
        return lastPing;
    }
    const t0 = Date.now();
    try {
        const r = await p.query('SELECT 1 AS ok, now() AS server_time');
        lastPing = { ok: true, at: new Date().toISOString(), latencyMs: Date.now() - t0, serverTime: r.rows[0].server_time };
    } catch (err) {
        lastPing = { ok: false, at: new Date().toISOString(), latencyMs: Date.now() - t0, error: err.message };
    }
    return lastPing;
}

// Cheap cached status for /api/health (no network call).
function status() {
    return {
        configured: !!dbConfig(),
        connected: !!(lastPing && lastPing.ok),
        lastPing
    };
}

module.exports = { getPool, ping, status };
