'use strict';

// ============================================================================
// BATTLEXJOURNAL — Supabase REST store (service role, server-side only)
// ----------------------------------------------------------------------------
// Stateless persistence for the bot: every call hits Supabase PostgREST.
// Nothing is cached to disk, nothing is kept in memory beyond a request.
//
// Tables used:
//   discord_connections  — the Discord ↔ BattleX link (016_discord_connections)
//   user_entitlements    — plan / AI quota (014_invite_access_system)
// ============================================================================

const config = require('./config.js');

const BASE = config.supabaseUrl + '/rest/v1';
const HEADERS = {
    apikey: config.supabaseKey,
    Authorization: 'Bearer ' + config.supabaseKey,
    'Content-Type': 'application/json'
};

async function sbFetch(path, opts) {
    const res = await fetch(BASE + path, opts);
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err = new Error('Supabase ' + path.split('?')[0] + ' → HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : ''));
        err.status = res.status;
        throw err;
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
}

/**
 * The verified BattleX profile for a Discord user — or null.
 * Joins discord_connections → users → user_entitlements (server-side key).
 */
async function getVerifiedProfile(discordUserId) {
    const qs = '?discord_user_id=eq.' + encodeURIComponent(String(discordUserId)) +
        '&select=discord_user_id,discord_username,verified,verified_at,users!inner(id,display_name),user_entitlements(access_type,access_expires_at,lifetime_ai_used,lifetime_ai_limit,tester_ai_limit,tester_ai_used)';
    const rows = await sbFetch('/discord_connections' + qs, { headers: HEADERS });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.verified) return null;

    const user = row.users || {};
    const ent = (row.user_entitlements && row.user_entitlements[0]) || null;

    let tier = 'Standard';
    let aiUsed = 0, aiLimit = 50;
    let expiresAt = null;
    if (ent) {
        const isTester = ent.access_type === 'tester';
        const expired = ent.access_expires_at && new Date(ent.access_expires_at) < new Date();
        if (isTester && !expired) {
            tier = 'Tester · 1-Year';
            aiLimit = ent.tester_ai_limit || 100;
            aiUsed = ent.tester_ai_used || 0;
            try { expiresAt = new Date(ent.access_expires_at).toISOString().slice(0, 10); } catch (e) {}
        } else {
            tier = 'Standard · Lifetime AI';
            aiLimit = 50;
            aiUsed = ent.lifetime_ai_used || 0;
        }
    }

    return {
        battlexId: user.id,
        displayName: user.display_name || (user.email ? String(user.email).split('@')[0] : 'Trader'),
        tier,
        aiUsed,
        aiLimit,
        expiresAt,
        verifiedAt: row.verified_at
    };
}

/** Bot-side role flag check: is this Discord user already marked verified? */
async function isVerified(discordUserId) {
    const qs = '?discord_user_id=eq.' + encodeURIComponent(String(discordUserId)) + '&select=verified&limit=1';
    const rows = await sbFetch('/discord_connections' + qs, { headers: HEADERS });
    const row = Array.isArray(rows) ? rows[0] : null;
    return !!(row && row.verified);
}

module.exports = { getVerifiedProfile, isVerified };
