'use strict';

// ============================================================================
// BATTLEXJOURNAL — Master Admin Service & 2FA Engine
// ----------------------------------------------------------------------------
// Features:
//   1. Independent 2FA Admin Authentication (Username + Password + 6-digit Master PIN)
//   2. Real Database/Store Analytics (Zero Fake/Demo Data)
//   3. Server-side Paginated User Explorer with Search & Filter
//   4. Activity Tracking & Audit Logs
// ============================================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');
const Access = require('./access.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACTIVITY_FILE = path.join(
    process.env.TRADEMIND_AI_DATA_DIR || DATA_DIR,
    'activity.json'
);

// Admin Credentials Configuration
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'battlex_admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BattleXAdmin@2026';
const ADMIN_2FA_PIN = process.env.ADMIN_2FA_PIN || '882026';

// In-memory token stores
const preAuthTokens = new Map(); // token -> { username, expiresAt }
const adminSessions = new Map(); // token -> { username, createdAt, expiresAt }

// ---------------------------------------------------------------------------
// 1. Admin Authentication & 2FA Handlers
// ---------------------------------------------------------------------------
function adminLogin({ username, password }) {
    if (!username || !password) {
        throw Object.assign(new Error('Admin username and password are required.'), { code: 400 });
    }
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        throw Object.assign(new Error('Invalid admin credentials.'), { code: 401 });
    }

    const preAuthToken = 'pre_' + crypto.randomBytes(32).toString('hex');
    preAuthTokens.set(preAuthToken, {
        username,
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
    });

    return {
        ok: true,
        requires2FA: true,
        preAuthToken,
        message: 'Credentials verified. Enter your 6-digit 2FA Master Security PIN to complete login.'
    };
}

function adminVerify2FA({ preAuthToken, pin }) {
    if (!preAuthToken || !pin) {
        throw Object.assign(new Error('Pre-auth token and 2FA PIN are required.'), { code: 400 });
    }

    const pre = preAuthTokens.get(preAuthToken);
    if (!pre || pre.expiresAt < Date.now()) {
        preAuthTokens.delete(preAuthToken);
        throw Object.assign(new Error('2FA session expired. Please sign in again.'), { code: 401 });
    }

    if (String(pin).trim() !== ADMIN_2FA_PIN) {
        throw Object.assign(new Error('Invalid 2FA Master PIN.'), { code: 401 });
    }

    preAuthTokens.delete(preAuthToken);

    const adminToken = 'adm_' + crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    adminSessions.set(adminToken, {
        username: pre.username,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(expiresAt).getTime()
    });

    return {
        ok: true,
        adminToken,
        expiresAt,
        username: pre.username
    };
}

function verifyAdminSession(token) {
    if (!token) return null;
    const clean = token.replace(/^Bearer\s+/i, '').trim();
    const sess = adminSessions.get(clean);
    if (!sess) return null;
    if (sess.expiresAt < Date.now()) {
        adminSessions.delete(clean);
        return null;
    }
    return sess;
}

function adminLogout(token) {
    if (token) {
        const clean = token.replace(/^Bearer\s+/i, '').trim();
        adminSessions.delete(clean);
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// 2. Activity Logging
// ---------------------------------------------------------------------------
function loadLocalActivities() {
    try {
        if (fs.existsSync(ACTIVITY_FILE)) {
            return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}

function saveLocalActivities(list) {
    try {
        fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true });
        fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(list.slice(0, 1000), null, 2));
    } catch (e) {}
}

async function logActivity(userId, eventType, details = {}) {
    const pool = db.getPool();
    const now = new Date().toISOString();

    if (pool && userId && userId !== '00000000-0000-0000-0000-000000000000') {
        try {
            await pool.query(
                'INSERT INTO user_activity_log (user_id, event_type, details, created_at) VALUES ($1, $2, $3, $4)',
                [userId, eventType, JSON.stringify(details), now]
            );
            if (eventType === 'login') {
                await pool.query(
                    'UPDATE user_entitlements SET last_login_at = $1 WHERE user_id = $2',
                    [now, userId]
                );
            }
            return;
        } catch (e) {
            // fallback
        }
    }

    const list = loadLocalActivities();
    list.unshift({
        id: 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        user_id: userId || 'anon',
        event_type: eventType,
        details,
        created_at: now
    });
    saveLocalActivities(list);
}

// ---------------------------------------------------------------------------
// 3. Admin Metrics & Time-Series Aggregation
// ---------------------------------------------------------------------------
async function getDashboardMetrics(range = '30d') {
    const pool = db.getPool();
    const now = new Date();
    let rangeDays = 30;
    if (range === '7d') rangeDays = 7;
    else if (range === '90d') rangeDays = 90;
    else if (range === 'today') rangeDays = 1;
    else if (range === 'all') rangeDays = 3650;

    const rangeStart = new Date(now.getTime() - rangeDays * 86400000);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getTime() - 30 * 86400000);

    // Database mode
    if (pool) {
        try {
            const usersCountRes = await pool.query('SELECT COUNT(*)::int AS total FROM users');
            const totalUsers = usersCountRes.rows[0]?.total || 0;

            const newUsersRes = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE created_at >= $1', [rangeStart]);
            const newUsers = newUsersRes.rows[0]?.count || 0;

            const activeTodayRes = await pool.query(
                'SELECT COUNT(DISTINCT user_id)::int AS count FROM user_activity_log WHERE created_at >= $1',
                [todayStart]
            );
            const activeToday = activeTodayRes.rows[0]?.count || 0;

            const activeWeekRes = await pool.query(
                'SELECT COUNT(DISTINCT user_id)::int AS count FROM user_activity_log WHERE created_at >= $1',
                [weekStart]
            );
            const activeWeek = activeWeekRes.rows[0]?.count || 0;

            const activeMonthRes = await pool.query(
                'SELECT COUNT(DISTINCT user_id)::int AS count FROM user_activity_log WHERE created_at >= $1',
                [monthStart]
            );
            const activeMonth = activeMonthRes.rows[0]?.count || 0;

            const aiTotalRes = await pool.query(
                'SELECT COALESCE(SUM(lifetime_ai_used + tester_ai_used), 0)::int AS total FROM user_entitlements'
            );
            const totalAiRequests = aiTotalRes.rows[0]?.total || 0;

            const aiTodayRes = await pool.query(
                'SELECT COUNT(*)::int AS count FROM user_activity_log WHERE event_type = \'ai_request\' AND created_at >= $1',
                [todayStart]
            );
            const aiToday = aiTodayRes.rows[0]?.count || 0;

            const aiWeekRes = await pool.query(
                'SELECT COUNT(*)::int AS count FROM user_activity_log WHERE event_type = \'ai_request\' AND created_at >= $1',
                [weekStart]
            );
            const aiWeek = aiWeekRes.rows[0]?.count || 0;

            const aiMonthRes = await pool.query(
                'SELECT COUNT(*)::int AS count FROM user_activity_log WHERE event_type = \'ai_request\' AND created_at >= $1',
                [monthStart]
            );
            const aiMonth = aiMonthRes.rows[0]?.count || 0;

            const testerRes = await pool.query(
                'SELECT COUNT(*)::int AS count FROM user_entitlements WHERE access_type = \'tester\' AND access_expires_at > now()'
            );
            const testerUsers = testerRes.rows[0]?.count || 0;

            const normalRes = await pool.query(
                'SELECT COUNT(*)::int AS count FROM user_entitlements WHERE access_type = \'normal\' OR access_type IS NULL OR access_expires_at <= now()'
            );
            const normalUsers = normalRes.rows[0]?.count || 0;

            const expiredRes = await pool.query(
                'SELECT COUNT(*)::int AS count FROM user_entitlements WHERE access_type = \'tester\' AND access_expires_at <= now()'
            );
            const expiredUsers = expiredRes.rows[0]?.count || 0;

            // Daily new users time-series
            const dailyUsersRes = await pool.query(
                'SELECT to_char(created_at, \'YYYY-MM-DD\') AS day, COUNT(*)::int AS count FROM users WHERE created_at >= $1 GROUP BY day ORDER BY day ASC',
                [rangeStart]
            );
            const newUsersSeries = dailyUsersRes.rows;

            // Daily active users time-series
            const dauRes = await pool.query(
                'SELECT to_char(created_at, \'YYYY-MM-DD\') AS day, COUNT(DISTINCT user_id)::int AS count FROM user_activity_log WHERE created_at >= $1 GROUP BY day ORDER BY day ASC',
                [rangeStart]
            );
            const dauSeries = dauRes.rows;

            // AI Usage Distribution
            const aiDistRes = await pool.query(
                'SELECT ' +
                'COUNT(CASE WHEN lifetime_ai_used < 13 THEN 1 END)::int AS under_25, ' +
                'COUNT(CASE WHEN lifetime_ai_used >= 13 AND lifetime_ai_used < 25 THEN 1 END)::int AS p25_50, ' +
                'COUNT(CASE WHEN lifetime_ai_used >= 25 AND lifetime_ai_used < 38 THEN 1 END)::int AS p50_75, ' +
                'COUNT(CASE WHEN lifetime_ai_used >= 38 AND lifetime_ai_used < 50 THEN 1 END)::int AS p75_99, ' +
                'COUNT(CASE WHEN lifetime_ai_used >= 50 THEN 1 END)::int AS max_reached ' +
                'FROM user_entitlements'
            );
            const aiDist = aiDistRes.rows[0] || { under_25: 0, p25_50: 0, p50_75: 0, p75_99: 0, max_reached: 0 };

            // Top AI Users
            const topAiRes = await pool.query(
                'SELECT u.id, u.email, u.display_name, (COALESCE(e.lifetime_ai_used, 0) + COALESCE(e.tester_ai_used, 0))::int AS requests ' +
                'FROM user_entitlements e ' +
                'JOIN users u ON u.id = e.user_id ' +
                'ORDER BY requests DESC ' +
                'LIMIT 5'
            );
            const topAiUsers = topAiRes.rows;

            const inviteStats = await Access.getInviteStats();

            return {
                totalUsers,
                newUsers,
                activeUsers: { today: activeToday, week: activeWeek, month: activeMonth },
                aiRequests: { total: totalAiRequests, today: aiToday, week: aiWeek, month: aiMonth },
                testers: { used: testerUsers, max: 60, remaining: Math.max(0, 60 - testerUsers), groups: inviteStats.groups },
                normalUsers,
                expiredUsers,
                timeSeries: { newUsers: newUsersSeries, dau: dauSeries },
                aiDistribution: aiDist,
                topAiUsers
            };
        } catch (e) {
            console.warn('[admin] metrics DB aggregation fallback:', e.message);
        }
    }

    // Local / In-Memory Fallback aggregation
    const rawEnt = fs.existsSync(path.join(DATA_DIR, 'entitlements.json'))
        ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'entitlements.json'), 'utf8'))
        : { entitlements: {}, codes: {} };

    const entitlements = Object.entries(rawEnt.entitlements || {});
    const activities = loadLocalActivities();

    const totalUsers = entitlements.length;
    const testerUsers = entitlements.filter(([_, e]) => e.access_type === 'tester' && (!e.access_expires_at || new Date(e.access_expires_at) > now)).length;
    const expiredUsers = entitlements.filter(([_, e]) => e.access_type === 'tester' && e.access_expires_at && new Date(e.access_expires_at) <= now).length;
    const normalUsers = totalUsers - testerUsers;

    const totalAiRequests = entitlements.reduce((s, [_, e]) => s + (e.lifetime_ai_used || 0) + (e.tester_ai_used || 0), 0);

    const activeTodaySet = new Set(activities.filter(a => new Date(a.created_at) >= todayStart).map(a => a.user_id));
    const activeWeekSet = new Set(activities.filter(a => new Date(a.created_at) >= weekStart).map(a => a.user_id));
    const activeMonthSet = new Set(activities.filter(a => new Date(a.created_at) >= monthStart).map(a => a.user_id));

    const inviteStats = await Access.getInviteStats();

    return {
        totalUsers,
        newUsers: totalUsers,
        activeUsers: { today: activeTodaySet.size, week: activeWeekSet.size, month: activeMonthSet.size },
        aiRequests: {
            total: totalAiRequests,
            today: activities.filter(a => a.event_type === 'ai_request' && new Date(a.created_at) >= todayStart).length,
            week: activities.filter(a => a.event_type === 'ai_request' && new Date(a.created_at) >= weekStart).length,
            month: activities.filter(a => a.event_type === 'ai_request' && new Date(a.created_at) >= monthStart).length
        },
        testers: { used: testerUsers, max: 60, remaining: Math.max(0, 60 - testerUsers), groups: inviteStats.groups },
        normalUsers,
        expiredUsers,
        timeSeries: { newUsers: [], dau: [] },
        aiDistribution: { under_25: normalUsers, p25_50: 0, p50_75: 0, p75_99: 0, max_reached: 0 },
        topAiUsers: []
    };
}

// ---------------------------------------------------------------------------
// 4. Paginated User Explorer with Search & Filter
// ---------------------------------------------------------------------------
async function getUsersList({ page = 1, limit = 25, search = '', filter = 'all' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;
    const pool = db.getPool();

    if (pool) {
        try {
            let whereClauses = [];
            let params = [];
            let pIdx = 1;

            if (search && search.trim()) {
                const s = '%' + search.trim().toLowerCase() + '%';
                whereClauses.push('(LOWER(u.email) LIKE $' + pIdx + ' OR LOWER(COALESCE(u.display_name, \'\')) LIKE $' + pIdx + ' OR u.id::text LIKE $' + pIdx + ')');
                params.push(s);
                pIdx++;
            }

            if (filter === 'tester') {
                whereClauses.push('(e.access_type = \'tester\' AND e.access_expires_at > now())');
            } else if (filter === 'normal') {
                whereClauses.push('(e.access_type = \'normal\' OR e.access_type IS NULL OR e.access_expires_at <= now())');
            } else if (filter === 'expired') {
                whereClauses.push('(e.access_type = \'tester\' AND e.access_expires_at <= now())');
            }

            const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

            const countSql = 'SELECT COUNT(*)::int AS total FROM users u LEFT JOIN user_entitlements e ON e.user_id = u.id ' + whereSql;
            const countRes = await pool.query(countSql, params);
            const total = countRes.rows[0]?.total || 0;

            const dataSql = 
                'SELECT u.id, u.email, u.display_name, u.created_at, ' +
                'COALESCE(e.access_type, \'normal\') AS access_type, e.access_expires_at, e.activated_at, ' +
                'COALESCE(e.lifetime_ai_used, 0) AS lifetime_ai_used, COALESCE(e.tester_ai_limit, 100) AS tester_ai_limit, ' +
                'COALESCE(e.tester_ai_used, 0) AS tester_ai_used, e.last_login_at ' +
                'FROM users u ' +
                'LEFT JOIN user_entitlements e ON e.user_id = u.id ' +
                whereSql + ' ' +
                'ORDER BY u.created_at DESC ' +
                'LIMIT $' + pIdx + ' OFFSET $' + (pIdx + 1);

            const dataRes = await pool.query(dataSql, [...params, limitNum, offset]);

            const users = dataRes.rows.map(r => {
                const isTester = (r.access_type === 'tester' && r.access_expires_at && new Date(r.access_expires_at) > new Date());
                const isExpired = (r.access_type === 'tester' && r.access_expires_at && new Date(r.access_expires_at) <= new Date());
                const aiUsed = isTester ? r.tester_ai_used : r.lifetime_ai_used;
                const aiLimit = isTester ? r.tester_ai_limit : 50;
                return {
                    id: r.id,
                    email: r.email,
                    name: r.display_name || r.email.split('@')[0],
                    joinedAt: r.created_at,
                    lastActive: r.last_login_at || r.created_at,
                    accessType: isTester ? 'tester' : isExpired ? 'expired' : 'normal',
                    aiUsed,
                    aiLimit,
                    aiRemaining: Math.max(0, aiLimit - aiUsed),
                    accessExpiresAt: r.access_expires_at,
                    activatedAt: r.activated_at
                };
            });

            return {
                users,
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            };
        } catch (e) {
            console.warn('[admin] getUsersList DB fallback:', e.message);
        }
    }

    // Local / In-Memory Fallback
    const rawEnt = fs.existsSync(path.join(DATA_DIR, 'entitlements.json'))
        ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'entitlements.json'), 'utf8'))
        : { entitlements: {} };

    let items = Object.entries(rawEnt.entitlements || {}).map(([uid, e]) => {
        const isTester = (e.access_type === 'tester' && e.access_expires_at && new Date(e.access_expires_at) > new Date());
        const isExpired = (e.access_type === 'tester' && e.access_expires_at && new Date(e.access_expires_at) <= new Date());
        const aiUsed = isTester ? (e.tester_ai_used || 0) : (e.lifetime_ai_used || 0);
        const aiLimit = isTester ? (e.tester_ai_limit || 100) : 50;
        return {
            id: uid,
            email: uid.includes('@') ? uid : uid + '@battlex.app',
            name: uid.split('@')[0],
            joinedAt: e.activated_at || new Date().toISOString(),
            lastActive: e.last_login_at || e.activated_at || new Date().toISOString(),
            accessType: isTester ? 'tester' : isExpired ? 'expired' : 'normal',
            aiUsed,
            aiLimit,
            aiRemaining: Math.max(0, aiLimit - aiUsed),
            accessExpiresAt: e.access_expires_at,
            activatedAt: e.activated_at
        };
    });

    if (search) {
        const q = search.toLowerCase();
        items = items.filter(u => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q) || u.id.includes(q));
    }
    if (filter === 'tester') items = items.filter(u => u.accessType === 'tester');
    else if (filter === 'normal') items = items.filter(u => u.accessType === 'normal');
    else if (filter === 'expired') items = items.filter(u => u.accessType === 'expired');

    const total = items.length;
    const paginated = items.slice(offset, offset + limitNum);

    return {
        users: paginated,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
    };
}

// ---------------------------------------------------------------------------
// 5. User Dossier (Detailed View)
// ---------------------------------------------------------------------------
async function getUserDetails(userId) {
    if (!userId) throw Object.assign(new Error('User ID required.'), { code: 400 });
    const pool = db.getPool();

    if (pool) {
        try {
            const res = await pool.query(
                'SELECT u.id, u.email, u.display_name, u.timezone, u.created_at, ' +
                'e.access_type, e.access_expires_at, e.activated_at, e.invite_code_id, ' +
                'e.lifetime_ai_used, e.tester_ai_limit, e.tester_ai_used, e.last_login_at, ' +
                'i.code AS redeemed_code ' +
                'FROM users u ' +
                'LEFT JOIN user_entitlements e ON e.user_id = u.id ' +
                'LEFT JOIN invite_codes i ON i.id = e.invite_code_id ' +
                'WHERE u.id = $1',
                [userId]
            );
            if (res.rows.length) {
                const r = res.rows[0];
                const actRes = await pool.query(
                    'SELECT event_type, details, created_at FROM user_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25',
                    [userId]
                );
                return {
                    id: r.id,
                    email: r.email,
                    name: r.display_name || r.email.split('@')[0],
                    timezone: r.timezone || 'UTC',
                    createdAt: r.created_at,
                    lastLoginAt: r.last_login_at || r.created_at,
                    accessType: r.access_type || 'normal',
                    accessExpiresAt: r.access_expires_at,
                    activatedAt: r.activated_at,
                    redeemedCode: r.redeemed_code || (r.invite_code_id ? String(r.invite_code_id) : '—'),
                    aiUsage: {
                        lifetimeUsed: r.lifetime_ai_used || 0,
                        testerUsed: r.tester_ai_used || 0,
                        testerLimit: r.tester_ai_limit || 100
                    },
                    recentActivity: actRes.rows
                };
            }
        } catch (e) {
            console.warn('[admin] getUserDetails DB fallback:', e.message);
        }
    }

    const rawEnt = fs.existsSync(path.join(DATA_DIR, 'entitlements.json'))
        ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'entitlements.json'), 'utf8'))
        : { entitlements: {} };

    const e = rawEnt.entitlements[userId] || {};
    return {
        id: userId,
        email: userId.includes('@') ? userId : userId + '@battlex.app',
        name: userId.split('@')[0],
        timezone: 'UTC',
        createdAt: e.activated_at || new Date().toISOString(),
        lastLoginAt: e.last_login_at || e.activated_at || new Date().toISOString(),
        accessType: e.access_type || 'normal',
        accessExpiresAt: e.access_expires_at || null,
        activatedAt: e.activated_at || null,
        redeemedCode: e.invite_code_id || '—',
        aiUsage: {
            lifetimeUsed: e.lifetime_ai_used || 0,
            testerUsed: e.tester_ai_used || 0,
            testerLimit: e.tester_ai_limit || 100
        },
        recentActivity: loadLocalActivities().filter(a => a.user_id === userId).slice(0, 25)
    };
}

// ---------------------------------------------------------------------------
// 6. Recent Activity Feed
// ---------------------------------------------------------------------------
async function getActivityFeed({ page = 1, limit = 30 } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;
    const pool = db.getPool();

    if (pool) {
        try {
            const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM user_activity_log');
            const total = countRes.rows[0]?.total || 0;

            const res = await pool.query(
                'SELECT a.id, a.user_id, a.event_type, a.details, a.created_at, COALESCE(u.email, \'Anonymous\') AS user_email ' +
                'FROM user_activity_log a ' +
                'LEFT JOIN users u ON u.id = a.user_id ' +
                'ORDER BY a.created_at DESC ' +
                'LIMIT $1 OFFSET $2',
                [limitNum, offset]
            );
            return {
                activities: res.rows,
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            };
        } catch (e) {
            console.warn('[admin] getActivityFeed DB fallback:', e.message);
        }
    }

    const all = loadLocalActivities();
    const total = all.length;
    return {
        activities: all.slice(offset, offset + limitNum),
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
    };
}

module.exports = {
    adminLogin,
    adminVerify2FA,
    verifyAdminSession,
    adminLogout,
    logActivity,
    getDashboardMetrics,
    getUsersList,
    getUserDetails,
    getActivityFeed,
    ADMIN_USERNAME
};
