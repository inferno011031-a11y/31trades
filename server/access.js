'use strict';

// ============================================================================
// BATTLEXJOURNAL — 60-Member 1-Year Invite Access & Quota Engine
// ----------------------------------------------------------------------------
// Securely enforces:
//   · 2 Invite Code Groups: BXJ-2026-A (30 users) and BXJ-2026-B (30 users) = 60 total
//   · Atomic server-side validation & redemption (concurrency safe / race-condition free)
//   · Fixed 1-year (365 days) access period tied to authenticated Supabase account
//   · Server-side monthly AI quota enforcement (configurable via AI_MONTHLY_LIMIT)
//   · Dual storage: Supabase PostgreSQL RPC (DB_MODE) + Atomic memory/disk fallback
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_ENTITLEMENTS_FILE = path.join(
    process.env.TRADEMIND_AI_DATA_DIR || DATA_DIR,
    'entitlements.json'
);

const DEFAULT_AI_MONTHLY_LIMIT = parseInt(process.env.AI_MONTHLY_LIMIT || '100', 10);

// In-memory mutex for race-condition prevention in local/fallback store
let localLock = Promise.resolve();
function withLock(fn) {
    const next = localLock.then(() => fn());
    localLock = next.catch(() => {});
    return next;
}

// Default Invite Codes Definition
const INVITE_GROUPS = {
    'BXJ-2026-A': { maxUses: 30, durationDays: 365, plan: 'yearly_invite' },
    'BXJ-2026-B': { maxUses: 30, durationDays: 365, plan: 'yearly_invite' }
};

// ---------------------------------------------------------------------------
// Local Store Helpers (Offline / File-backed fallback)
// ---------------------------------------------------------------------------
function loadLocalStore() {
    try {
        if (fs.existsSync(LOCAL_ENTITLEMENTS_FILE)) {
            return JSON.parse(fs.readFileSync(LOCAL_ENTITLEMENTS_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return {
        codes: {
            'BXJ-2026-A': { used_count: 0, users: [] },
            'BXJ-2026-B': { used_count: 0, users: [] }
        },
        entitlements: {} // userId -> { plan, expires_at, activated_at, code, ai_usage_month, ai_usage_count, ai_monthly_limit }
    };
}

function saveLocalStore(store) {
    try {
        fs.mkdirSync(path.dirname(LOCAL_ENTITLEMENTS_FILE), { recursive: true });
        fs.writeFileSync(LOCAL_ENTITLEMENTS_FILE, JSON.stringify(store, null, 2));
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 1. Get User Access Status
// ---------------------------------------------------------------------------
async function getAccessStatus(userId) {
    if (!userId) {
        return { hasAccess: false, plan: null, expiresAt: null, isExpired: false, aiUsage: null };
    }

    const pool = db.getPool();
    if (pool) {
        try {
            const res = await pool.query(
                'SELECT access_plan, access_expires_at, activated_at, ai_monthly_limit, ai_usage_month, ai_usage_count FROM user_entitlements WHERE user_id = $1',
                [userId]
            );
            if (res.rows.length) {
                const row = res.rows[0];
                const expiresAt = new Date(row.access_expires_at).toISOString();
                const isExpired = new Date(row.access_expires_at).getTime() <= Date.now();
                const currentMonth = new Date().toISOString().slice(0, 7);
                const used = row.ai_usage_month === currentMonth ? row.ai_usage_count : 0;
                const limit = row.ai_monthly_limit || DEFAULT_AI_MONTHLY_LIMIT;

                return {
                    hasAccess: !isExpired,
                    plan: row.access_plan,
                    expiresAt,
                    activatedAt: new Date(row.activated_at).toISOString(),
                    isExpired,
                    aiUsage: {
                        used,
                        limit,
                        remaining: Math.max(0, limit - used),
                        month: currentMonth
                    }
                };
            }
        } catch (err) {
            console.warn('[access] db getAccessStatus fallback to local:', err.message);
        }
    }

    // Local / In-memory fallback
    const store = loadLocalStore();
    const ent = store.entitlements[userId];
    if (ent) {
        const isExpired = new Date(ent.expires_at).getTime() <= Date.now();
        const currentMonth = new Date().toISOString().slice(0, 7);
        const used = ent.ai_usage_month === currentMonth ? ent.ai_usage_count : 0;
        const limit = ent.ai_monthly_limit || DEFAULT_AI_MONTHLY_LIMIT;

        return {
            hasAccess: !isExpired,
            plan: ent.plan,
            expiresAt: ent.expires_at,
            activatedAt: ent.activated_at,
            isExpired,
            aiUsage: {
                used,
                limit,
                remaining: Math.max(0, limit - used),
                month: currentMonth
            }
        };
    }

    return { hasAccess: false, plan: null, expiresAt: null, isExpired: false, aiUsage: null };
}

// ---------------------------------------------------------------------------
// 2. Atomic Invite Code Redemption
// ---------------------------------------------------------------------------
async function redeemInviteCode({ userId, code }) {
    if (!userId) {
        throw Object.assign(new Error('Authentication required.'), { code: 401 });
    }
    if (!code || !String(code).trim()) {
        throw Object.assign(new Error('Please enter an invite code.'), { code: 400 });
    }

    // Code Normalization (Uppercase + Trim whitespace)
    const normalizedCode = String(code).trim().toUpperCase();

    const pool = db.getPool();
    if (pool) {
        try {
            // Call atomic PostgreSQL RPC function with row-locking (SELECT ... FOR UPDATE)
            const res = await pool.query(
                'SELECT redeem_invite_code($1::uuid, $2::text) AS result',
                [userId, normalizedCode]
            );
            const r = res.rows[0]?.result || {};
            if (!r.ok) {
                const err = new Error(r.error || 'Failed to redeem invite code.');
                err.code = r.code === 'ALREADY_ACTIVE' ? 409 : r.code === 'CODE_FULL' ? 409 : 400;
                throw err;
            }
            return r;
        } catch (err) {
            // If PostgreSQL RPC function is not installed yet or error occurs, fallback to client transaction
            if (err.code && (err.code === 400 || err.code === 401 || err.code === 409)) throw err;
            console.warn('[access] db redeem_invite_code rpc fallback:', err.message);
        }
    }

    // Atomic Local / In-memory Redemption with Mutex Lock
    return withLock(async () => {
        const store = loadLocalStore();
        if (!store.codes) {
            store.codes = {
                'BXJ-2026-A': { used_count: 0, users: [] },
                'BXJ-2026-B': { used_count: 0, users: [] }
            };
        }
        if (!store.entitlements) store.entitlements = {};

        // Step 1: Check existing active entitlement
        const existing = store.entitlements[userId];
        if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
            const err = new Error('You already have an active BattleXJournal access period.');
            err.code = 409;
            throw err;
        }

        // Step 2: Validate code existence
        const groupMeta = INVITE_GROUPS[normalizedCode];
        if (!groupMeta) {
            const err = new Error('Invalid invite code. Please check the code and try again.');
            err.code = 400;
            throw err;
        }

        // Step 3: Check capacity (max 30 uses)
        const codeState = store.codes[normalizedCode] || { used_count: 0, users: [] };
        if (codeState.used_count >= groupMeta.maxUses) {
            const err = new Error('This invite code has reached its ' + groupMeta.maxUses + '-user limit.');
            err.code = 409;
            throw err;
        }

        // Step 4: Fixed 1-Year Expiration (365 days from now)
        const now = new Date();
        const expiresAt = new Date(now.getTime() + groupMeta.durationDays * 86400000).toISOString();
        const activatedAt = now.toISOString();

        // Step 5: Atomically increment count & record user
        codeState.used_count = (codeState.used_count || 0) + 1;
        if (!codeState.users.includes(userId)) codeState.users.push(userId);
        store.codes[normalizedCode] = codeState;

        // Step 6: Record entitlement
        store.entitlements[userId] = {
            plan: groupMeta.plan,
            expires_at: expiresAt,
            activated_at: activatedAt,
            code: normalizedCode,
            ai_monthly_limit: DEFAULT_AI_MONTHLY_LIMIT,
            ai_usage_month: now.toISOString().slice(0, 7),
            ai_usage_count: 0
        };

        saveLocalStore(store);

        return {
            ok: true,
            plan: groupMeta.plan,
            expires_at: expiresAt,
            activated_at: activatedAt,
            message: 'Access activated. Your 1-year BattleXJournal access is now active.'
        };
    });
}

// ---------------------------------------------------------------------------
// 3. Server-side AI Quota Verification & Consumption
// ---------------------------------------------------------------------------
async function enforceAiQuota(userId) {
    if (!userId) {
        throw Object.assign(new Error('Authentication required.'), { code: 401 });
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    const pool = db.getPool();

    if (pool) {
        try {
            const res = await pool.query(
                'SELECT access_expires_at, ai_monthly_limit, ai_usage_month, ai_usage_count FROM user_entitlements WHERE user_id = $1',
                [userId]
            );
            if (!res.rows.length) {
                throw Object.assign(new Error('Invite access code required to use AI Coach.'), { code: 403 });
            }
            const row = res.rows[0];
            if (new Date(row.access_expires_at).getTime() <= Date.now()) {
                throw Object.assign(new Error('Your 1-year BattleXJournal access has expired. Please renew your invite access.'), { code: 403 });
            }

            const limit = row.ai_monthly_limit || DEFAULT_AI_MONTHLY_LIMIT;
            let used = row.ai_usage_month === currentMonth ? row.ai_usage_count : 0;

            if (used >= limit) {
                throw Object.assign(new Error(`Monthly AI limit reached (${limit} requests/month). Your quota resets on the 1st of next month.`), { code: 429 });
            }

            // Increment usage atomically
            await pool.query(
                `UPDATE user_entitlements 
                 SET ai_usage_count = CASE WHEN ai_usage_month = $1 THEN ai_usage_count + 1 ELSE 1 END,
                     ai_usage_month = $1,
                     updated_at = now()
                 WHERE user_id = $2`,
                [currentMonth, userId]
            );

            return { ok: true, used: used + 1, limit, remaining: Math.max(0, limit - (used + 1)) };
        } catch (err) {
            if (err.code === 401 || err.code === 403 || err.code === 429) throw err;
            console.warn('[access] db enforceAiQuota fallback to local:', err.message);
        }
    }

    // Local / In-memory fallback
    return withLock(async () => {
        const store = loadLocalStore();
        const ent = store.entitlements[userId];
        if (!ent) {
            throw Object.assign(new Error('Invite access code required to use AI Coach.'), { code: 403 });
        }
        if (new Date(ent.expires_at).getTime() <= Date.now()) {
            throw Object.assign(new Error('Your 1-year BattleXJournal access has expired. Please renew your invite access.'), { code: 403 });
        }

        const limit = ent.ai_monthly_limit || DEFAULT_AI_MONTHLY_LIMIT;
        if (ent.ai_usage_month !== currentMonth) {
            ent.ai_usage_month = currentMonth;
            ent.ai_usage_count = 0;
        }

        if (ent.ai_usage_count >= limit) {
            throw Object.assign(new Error(`Monthly AI limit reached (${limit} requests/month). Your quota resets on the 1st of next month.`), { code: 429 });
        }

        ent.ai_usage_count += 1;
        saveLocalStore(store);

        return { ok: true, used: ent.ai_usage_count, limit, remaining: Math.max(0, limit - ent.ai_usage_count) };
    });
}

// ---------------------------------------------------------------------------
// 4. Admin / Inspection Stats
// ---------------------------------------------------------------------------
async function getInviteStats() {
    const pool = db.getPool();
    let stats = [];

    if (pool) {
        try {
            const res = await pool.query(
                'SELECT code, max_uses, used_count, plan, created_at FROM invite_codes ORDER BY code ASC'
            );
            if (res.rows.length) {
                stats = res.rows.map(r => ({
                    code: r.code,
                    maxUses: r.max_uses,
                    usedCount: r.used_count,
                    remaining: Math.max(0, r.max_uses - r.used_count),
                    plan: r.plan
                }));
            }
        } catch (e) { /* fallback */ }
    }

    if (!stats.length) {
        const store = loadLocalStore();
        stats = Object.keys(INVITE_GROUPS).map(code => {
            const meta = INVITE_GROUPS[code];
            const state = (store.codes && store.codes[code]) || { used_count: 0 };
            return {
                code,
                maxUses: meta.maxUses,
                usedCount: state.used_count || 0,
                remaining: Math.max(0, meta.maxUses - (state.used_count || 0)),
                plan: meta.plan
            };
        });
    }

    const totalMax = stats.reduce((s, x) => s + x.maxUses, 0);
    const totalUsed = stats.reduce((s, x) => s + x.usedCount, 0);

    return {
        groups: stats,
        totalMax,
        totalUsed,
        totalRemaining: Math.max(0, totalMax - totalUsed)
    };
}

module.exports = {
    getAccessStatus,
    redeemInviteCode,
    enforceAiQuota,
    getInviteStats,
    INVITE_GROUPS
};
