/* ============================================================================
   31TRADES — Per-user preferences service
   ----------------------------------------------------------------------------
   Currently: the UI theme (light / dark / system). Stored in the Supabase
   user_prefs table (migration 011) so the choice syncs across devices; every
   write is mirrored to a per-user JSON file as fallback when Postgres is
   unavailable, exactly like ai_findings / notifications_read.
   All functions are async and always resolve — never throw into the routes.
   ============================================================================ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');

const THEMES = ['dark'];

function fileFor(userId) {
    return path.join(process.env.TRADEMIND_PREFS_DATA_DIR || path.join(__dirname, '..', 'data'), 'prefs-' + userId + '.json');
}

function sanitizeTheme(v) {
    return 'dark';
}

async function get(userId) {
    const pool = db.getPool();
    if (pool) {
        try {
            const r = await pool.query('SELECT theme FROM user_prefs WHERE user_id = $1', [userId]);
            if (r.rows.length) return { theme: sanitizeTheme(r.rows[0].theme) };
        } catch (e) { /* DB unavailable → file fallback */ }
    }
    try {
        const f = fileFor(userId);
        if (fs.existsSync(f)) {
            const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
            return { theme: sanitizeTheme(raw.theme) };
        }
    } catch (e) { /* ignore */ }
    return { theme: 'dark' };
}

async function set(userId, theme) {
    const value = sanitizeTheme(theme);
    const pool = db.getPool();
    if (pool) {
        try {
            await pool.query(
                `INSERT INTO user_prefs (user_id, theme, updated_at) VALUES ($1, $2, now())
                 ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme, updated_at = now()`,
                [userId, value]);
        } catch (e) { /* fall through to file mirror */ }
    }
    try {
        const f = fileFor(userId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify({ theme: value, updatedAt: new Date().toISOString() }));
    } catch (e) { /* ignore */ }
    return { theme: value };
}

module.exports = { get, set, THEMES };
