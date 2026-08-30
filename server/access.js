'use strict';

// ============================================================================
// BATTLEXJOURNAL — 60 Tester Access + 50 Lifetime Normal User AI Engine
// ----------------------------------------------------------------------------
// Core Invariants:
//   1. 60 Tester Users max (BXJ-2026-A max 30 + BXJ-2026-B max 30).
//   2. Normal users can use BattleXJournal freely, receiving 50 lifetime AI requests.
//   3. Server-authoritative atomic operations preventing race conditions.
//   4. Fixed 1-year expiration from redemption date (never extended on login/refresh).
//   5. Expired testers gracefully fall back to the standard 50 lifetime AI allowance.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_ENTITLEMENTS_FILE = path.join(
    process.env.TRADEMIND_AI_DATA_DIR || DATA_DIR,
    'entitlements.json'
);

const DEFAULT_TESTER_AI_LIMIT = parseInt(process.env.TESTER_AI_LIMIT || process.env.AI_MONTHLY_LIMIT || '100', 10);
const NORMAL_LIFETIME_AI_LIMIT = 50;

// Mutex lock for atomic operations in local-fallback store
let localLock = Promise.resolve();
function withLock(fn) {
    const next = localLock.then(() => fn());
    localLock = next.catch(() => {});
    return next;
}

const INVITE_GROUPS = {
    'BXJ-2026-A': { maxUses: 30, durationDays: 365, accessType: 'tester' },
    'BXJ-2026-B': { maxUses: 30, durationDays: 365, accessType: 'tester' }
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
        entitlements: {} // userId -> { access_type, access_expires_at, activated_at, lifetime_ai_used, tester_ai_limit, tester_ai_month, tester_ai_used }
    };
}

function saveLocalStore(store) {
    try {
        fs.mkdirSync(path.dirname(LOCAL_ENTITLEMENTS_FILE), { recursive: true });
        fs.writeFileSync(LOCAL_ENTITLEMENTS_FILE, JSON.stringify(store, null, 2));
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 1. Get User Access & AI Quota Status
// ---------------------------------------------------------------------------
async function getAccessStatus(userId) {
    if (!userId) {
        return {
            isTester: false,
            accessType: 'normal',
            expiresAt: null,
            isExpired: false,
            aiUsage: { tier: 'normal', used: 0, limit: NORMAL_LIFETIME_AI_LIMIT, remaining: NORMAL_LIFETIME_AI_LIMIT, isLifetime: true }
        };
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    const pool = db.getPool();

    if (pool) {
        try {
            const res = await pool.query(
                'SELECT access_type, access_expires_at, activated_at, lifetime_ai_used, tester_ai_limit, tester_ai_month, tester_ai_used FROM user_entitlements WHERE user_id = $1',
                [userId]
            );
            if (res.rows.length) {
                const row = res.rows[0];
                const isTesterActive = row.access_type === 'tester' && row.access_expires_at && new Date(row.access_expires_at).getTime() > Date.now();
                const isExpired = row.access_type === 'tester' && row.access_expires_at && new Date(row.access_expires_at).getTime() <= Date.now();

                if (isTesterActive) {
                    const limit = row.tester_ai_limit || DEFAULT_TESTER_AI_LIMIT;
                    const used = row.tester_ai_month === currentMonth ? row.tester_ai_used : 0;
                    return {
                        isTester: true,
                        accessType: 'tester',
                        expiresAt: new Date(row.access_expires_at).toISOString(),
                        activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
                        isExpired: false,
                        aiUsage: {
                            tier: 'tester',
                            used,
                            limit,
                            remaining: Math.max(0, limit - used),
                            isLifetime: false,
                            month: currentMonth
                        }
                    };
                }

                // Normal / Expired tester tier
                const used = row.lifetime_ai_used || 0;
                return {
                    isTester: false,
                    accessType: isExpired ? 'expired_tester' : 'normal',
                    expiresAt: row.access_expires_at ? new Date(row.access_expires_at).toISOString() : null,
                    isExpired,
                    aiUsage: {
                        tier: 'normal',
                        used,
                        limit: NORMAL_LIFETIME_AI_LIMIT,
                        remaining: Math.max(0, NORMAL_LIFETIME_AI_LIMIT - used),
                        isLifetime: true
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
        const isTesterActive = ent.access_type === 'tester' && ent.access_expires_at && new Date(ent.access_expires_at).getTime() > Date.now();
        const isExpired = ent.access_type === 'tester' && ent.access_expires_at && new Date(ent.access_expires_at).getTime() <= Date.now();

        if (isTesterActive) {
            const limit = ent.tester_ai_limit || DEFAULT_TESTER_AI_LIMIT;
            const used = ent.tester_ai_month === currentMonth ? (ent.tester_ai_used || 0) : 0;
            return {
                isTester: true,
                accessType: 'tester',
                expiresAt: ent.access_expires_at,
                activatedAt: ent.activated_at,
                isExpired: false,
                aiUsage: {
                    tier: 'tester',
                    used,
                    limit,
                    remaining: Math.max(0, limit - used),
                    isLifetime: false,
                    month: currentMonth
                }
            };
        }

        const used = ent.lifetime_ai_used || 0;
        return {
            isTester: false,
            accessType: isExpired ? 'expired_tester' : 'normal',
            expiresAt: ent.access_expires_at || null,
            isExpired,
            aiUsage: {
                tier: 'normal',
                used,
                limit: NORMAL_LIFETIME_AI_LIMIT,
                remaining: Math.max(0, NORMAL_LIFETIME_AI_LIMIT - used),
                isLifetime: true
            }
        };
    }

    // Default for brand new unrecorded user: Normal user with 50 lifetime requests
    return {
        isTester: false,
        accessType: 'normal',
        expiresAt: null,
        isExpired: false,
        aiUsage: {
            tier: 'normal',
            used: 0,
            limit: NORMAL_LIFETIME_AI_LIMIT,
            remaining: NORMAL_LIFETIME_AI_LIMIT,
            isLifetime: true
        }
    };
}

// ---------------------------------------------------------------------------
// 2. Atomic Tester Code Redemption
// ---------------------------------------------------------------------------
async function redeemInviteCode({ userId, code }) {
    if (!userId) {
        throw Object.assign(new Error('Authentication required.'), { code: 401 });
    }
    if (!code || !String(code).trim()) {
        throw Object.assign(new Error('Please enter a tester invitation code.'), { code: 400 });
    }

    const normalizedCode = String(code).trim().toUpperCase();
    const pool = db.getPool();

    if (pool) {
        try {
            const res = await pool.query(
                'SELECT redeem_invite_code($1::uuid, $2::text) AS result',
                [userId, normalizedCode]
            );
            const r = res.rows[0]?.result || {};
            if (!r.ok) {
                const err = new Error(r.error || 'Failed to redeem tester code.');
                err.code = r.code === 'ALREADY_TESTER' ? 409 : r.code === 'CODE_FULL' || r.code === 'ALL_SLOTS_FULL' ? 409 : 400;
                throw err;
            }
            return r;
        } catch (err) {
            if (err.code && (err.code === 400 || err.code === 401 || err.code === 409)) throw err;
            console.warn('[access] db redeem_invite_code rpc fallback to local:', err.message);
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

        // Step 1: Check if user already has active tester access
        const existing = store.entitlements[userId];
        if (existing && existing.access_type === 'tester' && existing.access_expires_at && new Date(existing.access_expires_at).getTime() > Date.now()) {
            const err = new Error('Your tester access is already active.');
            err.code = 409;
            throw err;
        }

        // Step 2: Validate code existence
        const groupMeta = INVITE_GROUPS[normalizedCode];
        if (!groupMeta) {
            const err = new Error('Invalid tester code. Please check the code and try again.');
            err.code = 400;
            throw err;
        }

        // Step 3: Check capacity (max 30 uses per code)
        const codeState = store.codes[normalizedCode] || { used_count: 0, users: [] };
        if (codeState.used_count >= groupMeta.maxUses) {
            const totalUsed = Object.values(store.codes).reduce((s, c) => s + (c.used_count || 0), 0);
            if (totalUsed >= 60) {
                const err = new Error('Tester access is currently full. You can still use BattleXJournal with the standard AI allowance.');
                err.code = 409;
                throw err;
            }
            const err = new Error('This tester code has reached its ' + groupMeta.maxUses + '-user limit.');
            err.code = 409;
            throw err;
        }

        // Step 4: Fixed 1-Year Expiration (365 days from redemption)
        const now = new Date();
        const expiresAt = new Date(now.getTime() + groupMeta.durationDays * 86400000).toISOString();
        const activatedAt = now.toISOString();

        // Step 5: Atomically increment count
        codeState.used_count = (codeState.used_count || 0) + 1;
        if (!codeState.users.includes(userId)) codeState.users.push(userId);
        store.codes[normalizedCode] = codeState;

        // Step 6: Record tester entitlement
        store.entitlements[userId] = Object.assign(existing || {}, {
            access_type: 'tester',
            access_expires_at: expiresAt,
            activated_at: activatedAt,
            invite_code_id: normalizedCode,
            tester_ai_limit: DEFAULT_TESTER_AI_LIMIT,
            tester_ai_month: now.toISOString().slice(0, 7),
            tester_ai_used: 0
        });

        saveLocalStore(store);

        return {
            ok: true,
            access_type: 'tester',
            expires_at: expiresAt,
            activated_at: activatedAt,
            message: 'Tester access activated. Your 1-year BattleXJournal tester access is now active.'
        };
    });
}

// ---------------------------------------------------------------------------
// 3. Server-side AI Quota Verification & Consumption (canUseAI)
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
                'SELECT consume_ai_request($1::uuid, $2::int) AS result',
                [userId, DEFAULT_TESTER_AI_LIMIT]
            );
            const r = res.rows[0]?.result || {};
            if (!r.ok) {
                const err = new Error(r.error || 'AI quota limit exceeded.');
                err.code = 429;
                throw err;
            }
            return r;
        } catch (err) {
            if (err.code === 401 || err.code === 429) throw err;
            console.warn('[access] db consume_ai_request rpc fallback to local:', err.message);
        }
    }

    // Local / In-memory Atomic Authorization with Mutex Lock
    return withLock(async () => {
        const store = loadLocalStore();
        let ent = store.entitlements[userId];

        if (!ent) {
            // Auto-initialize normal user record
            ent = {
                access_type: 'normal',
                lifetime_ai_used: 0,
                tester_ai_limit: DEFAULT_TESTER_AI_LIMIT,
                tester_ai_month: currentMonth,
                tester_ai_used: 0
            };
            store.entitlements[userId] = ent;
        }

        const isTester = (ent.access_type === 'tester' && ent.access_expires_at && new Date(ent.access_expires_at).getTime() > Date.now());

        if (isTester) {
            // Tester Tier: Monthly Quota
            const limit = ent.tester_ai_limit || DEFAULT_TESTER_AI_LIMIT;
            if (ent.tester_ai_month !== currentMonth) {
                ent.tester_ai_month = currentMonth;
                ent.tester_ai_used = 0;
            }

            if ((ent.tester_ai_used || 0) >= limit) {
                const err = new Error(`Monthly tester AI limit reached (${limit} requests/month). Quota resets on the 1st of next month.`);
                err.code = 429;
                throw err;
            }

            ent.tester_ai_used = (ent.tester_ai_used || 0) + 1;
            saveLocalStore(store);

            return {
                ok: true,
                used: ent.tester_ai_used,
                limit,
                remaining: Math.max(0, limit - ent.tester_ai_used),
                tier: 'tester'
            };
        } else {
            // Normal User Tier: 50 Lifetime Requests
            const limit = NORMAL_LIFETIME_AI_LIMIT;
            const used = ent.lifetime_ai_used || 0;

            if (used >= limit) {
                const err = new Error('You have used all 50 lifetime AI requests available on the standard plan.');
                err.code = 429;
                throw err;
            }

            ent.lifetime_ai_used = used + 1;
            saveLocalStore(store);

            return {
                ok: true,
                used: ent.lifetime_ai_used,
                limit,
                remaining: Math.max(0, limit - ent.lifetime_ai_used),
                tier: 'normal'
            };
        }
    });
}

// ---------------------------------------------------------------------------
// 4. Admin / Monitoring Stats
// ---------------------------------------------------------------------------
async function getInviteStats() {
    const pool = db.getPool();
    let stats = [];

    if (pool) {
        try {
            const res = await pool.query(
                'SELECT code, max_uses, used_count, access_type, duration_days, created_at FROM invite_codes ORDER BY code ASC'
            );
            if (res.rows.length) {
                stats = res.rows.map(r => ({
                    code: r.code,
                    maxUses: r.max_uses,
                    usedCount: r.used_count,
                    remaining: Math.max(0, r.max_uses - r.used_count),
                    accessType: r.access_type
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
                accessType: meta.accessType
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
    INVITE_GROUPS,
    NORMAL_LIFETIME_AI_LIMIT
};
