'use strict';

const path = require('node:path');
const fs = require('node:fs');

// ============================================================================
// 31TRADES — Notifications engine
// ----------------------------------------------------------------------------
// Derives the user's notification feed from the SAME canonical core that powers
// every other screen — there is exactly one derivation path for an alert, and
// the frontend reads it over GET /api/notifications (with a local fallback that
// runs the identical derivation when the backend is unreachable).
//
// Sources (all canonical, never hardcoded per page):
//   1. riskState()            — caution / high / limit bands from live policy
//   2. Trades.adherence_result — trades the rule engine BLOCKED
//   3. Violations             — hard-rule discipline breaches (canonical table)
//   4. Trades.reviewed        — pending-review queue
//   5. EVENT_LOG (audit)      — configuration changes & system events
//   6. upcoming calendar      — High/Medium market releases (injected by the
//                               server from the ecocal service; optional)
// ============================================================================

const CATS = ['Risk', 'Discipline', 'Reviews', 'System', 'Market'];

const SEV = {
    critical: 'critical',
    high: 'high',
    warn: 'warn',
    info: 'info'
};

// ---- helpers ---------------------------------------------------------------

function fmtR(r) {
    return r == null ? '—' : (r > 0 ? '+' : '') + r.toFixed(2) + 'R';
}
function fmtMoney(n) {
    return n == null ? '—' : (n > 0 ? '+' : '') + n;
}
function nowISO() {
    return new Date().toISOString();
}

// ---- derivation ------------------------------------------------------------

function buildNotifications(Core, accountId, opts) {
    const o = opts || {};
    const out = [];
    if (!Core || !Core.Accounts || !Core.Accounts.length) return out;

    const acc = Core.Accounts.find(a => a.id === accountId) || Core.Accounts[0];
    if (!acc) return out;

    // 1 · RISK STATE — the single live snapshot (never recomputed here)
    let rs = null;
    try { rs = Core.riskState(acc.id); } catch (e) { /* no policy yet */ }

    if (rs) {
        const riskPct = rs.dailyRiskBudget ? Math.round((rs.riskUsed / rs.dailyRiskBudget) * 100) : 0;
        if (rs.status === 'LIMIT') {
            out.push({
                id: 'risk-limit', cat: 'Risk', sev: SEV.critical, at: nowISO(),
                icon: 'shield-alert', tint: 'red',
                title: 'Daily risk limit breached',
                body: rs.riskUsed + ' risk used of ' + rs.dailyRiskBudget + ' budget · ' +
                    rs.lossUsed + ' loss · ' + rs.currentDrawdown + ' drawdown. Next trade is blocked until tomorrow.',
                href: 'risk.html'
            });
        }
        if (rs.status === 'HIGH') {
            out.push({
                id: 'risk-high', cat: 'Risk', sev: SEV.high, at: nowISO(),
                icon: 'alert-triangle', tint: 'amber',
                title: 'High risk — protect capital',
                body: 'Risk used ' + rs.riskUsed + ' / ' + rs.dailyRiskBudget + ' (' + riskPct + '%) · ' +
                    rs.currentDrawdown + ' drawdown of ' + rs.drawdownLimit + '. Max allowed next risk: $' + rs.maxAllowedRisk + '.',
                href: 'risk.html'
            });
        }
        if (rs.status === 'CAUTION') {
            out.push({
                id: 'risk-caution', cat: 'Risk', sev: SEV.warn, at: nowISO(),
                icon: 'activity', tint: 'blue',
                title: 'Risk caution — above the first warning band',
                body: 'Risk used ' + rs.riskUsed + ' / ' + rs.dailyRiskBudget + ' · ' +
                    rs.currentDrawdown + ' drawdown. Watch the next entries.',
                href: 'risk.html'
            });
        }
    }

    // 2 · POLICY BLOCKS — trades the rule engine rejected
    Core.Trades.filter(t => t.account_id === acc.id && t.adherence_result === 'BLOCK')
        .slice()
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
        .slice(0, 6)
        .forEach(t => {
            out.push({
                id: 'block-' + t.id, cat: 'Risk', sev: SEV.high, at: new Date(t.ts).toISOString(),
                icon: 'ban', tint: 'red',
                title: 'Trade blocked — ' + t.symbol + ' ' + (t.dir || ''),
                body: (t.block_reason || 'Rule engine rejected this trade') + ' · risk $' + (t.risk || 0) + ' · ' + (t.strategy || '—'),
                href: 'journal.html?focus=' + t.id
            });
        });

    // 3 · DISCIPLINE VIOLATIONS — hard-rule breaches (canonical Violations table)
    (Core.Violations || [])
        .filter(v => v.account_id === acc.id)
        .slice()
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
        .slice(0, 8)
        .forEach(v => {
            out.push({
                // stable across re-derivation: the violation entity id can be
                // regenerated by backfill on restart, so key on trade+rule instead
                id: 'viol-' + (v.tradeId || 'x') + '-' + (v.ruleKey || v.ruleLabel || 'x').replace(/\s+/g, '-'),
                cat: 'Discipline', sev: SEV.high, at: new Date(v.ts).toISOString(),
                icon: 'target', tint: 'red',
                title: 'Rule broken: ' + (v.ruleLabel || v.ruleKey || 'Rule'),
                body: (v.explanation || 'Hard-rule violation') + ' · P&L ' + fmtMoney(v.pnl) + ' · ' + fmtR(v.r),
                href: 'discipline.html'
            });
        });

    // 4 · PENDING REVIEWS — unreviewed trades (the Journal's pending queue)
    const pending = Core.Trades.filter(t => t.account_id === acc.id && !t.reviewed);
    if (pending.length) {
        out.push({
            id: 'reviews-pending', cat: 'Reviews', sev: SEV.info, at: nowISO(),
            icon: 'message-square', tint: 'blue',
            title: pending.length + ' trade' + (pending.length === 1 ? '' : 's') + ' awaiting review',
            body: pending.slice(0, 3).map(t => t.symbol + ' ' + (t.dir || '')).join(' · ') +
                (pending.length > 3 ? ' +' + (pending.length - 3) + ' more' : '') +
                ' — reflect on execution while it is fresh.',
            href: 'journal.html?view=unreviewed'
        });
    }

    // 5 · AUDIT / SYSTEM — configuration changes from the canonical event log.
    // A welcome event (logged once at signup) is surfaced as a friendly
    // first-run notification that links to the dashboard.
    (Core.getEventLog ? Core.getEventLog() : []).slice(0, 6).forEach(ev => {
        const isWelcome = ev.what === 'Welcome' && ev.entity === '31Trades';
        out.push({
            id: 'sys-' + (ev.at || ev.what || Math.random()), cat: 'System', sev: SEV.info, at: new Date(ev.at || Date.now()).toISOString(),
            icon: isWelcome ? 'sparkles' : 'settings',
            tint: isWelcome ? 'emerald' : 'gray',
            title: (ev.what || 'Configuration change') + ' · ' + (ev.entity || ''),
            body: (ev.detail || '') + (ev.impact ? ' — ' + ev.impact : ''),
            href: isWelcome ? 'dashboard.html' : 'strategy-lab.html?tab=history'
        });
    });

    // 6 · MARKET EVENTS — upcoming High/Medium releases (injected by the server)
    const upcoming = o.upcomingEvents || [];
    if (upcoming.length) {
        const next = upcoming[0];
        const mins = Math.max(0, Math.round((new Date(next.ts) - new Date()) / 60000));
        const h = Math.floor(mins / 60), m = mins % 60;
        out.push({
            id: 'market-' + next.ts, cat: 'Market', sev: SEV.high, at: new Date(next.ts).toISOString(),
            icon: 'newspaper', tint: 'amber',
            title: (next.impact || 'High') + ' impact: ' + next.title,
            body: 'In ~' + (h ? h + 'h ' : '') + m + 'm · ' + (next.country || next.currency || '') +
                (next.forecast ? ' · consensus ' + next.forecast : '') + (next.previous ? ' · prev ' + next.previous : ''),
            href: 'journal.html'
        });
    }

    // newest first, capped
    return out.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 50);
}

// ---- per-user read state ------------------------------------------------------
// Read-tracking lives server-side so unread state survives devices — not just
// one browser's localStorage. Primary storage is the Supabase
// notifications_read table (migration 009); a per-user JSON file mirrors every
// write as fallback when Postgres is unavailable, exactly like ai_findings.
// All functions are async and always resolve.

const db = require('./db.js');

function fileFor(userId) {
    return path.join(process.env.TRADEMIND_NOTIF_DATA_DIR || path.join(__dirname, '..', 'data'), 'notif-' + userId + '.json');
}

async function readSetOf(userId) {
    const pool = db.getPool();
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT notification_id FROM notifications_read WHERE user_id = $1', [userId]);
            return new Set(r.rows.map(row => row.notification_id));
        } catch (e) { /* DB unavailable → file fallback */ }
    }
    try {
        const f = fileFor(userId);
        if (fs.existsSync(f)) return new Set(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (e) { /* ignore */ }
    return new Set();
}

async function unreadCount(userId, notifs) {
    const read = await readSetOf(userId);
    return notifs.filter(n => !read.has(n.id)).length;
}

async function markRead(userId, ids) {
    const pool = db.getPool();
    const list = (ids || []).filter(Boolean);
    if (!list.length) return;
    if (pool) {
        try {
            await pool.query('BEGIN');
            for (const id of list) {
                await pool.query(
                    `INSERT INTO notifications_read (user_id, notification_id) VALUES ($1, $2)
                     ON CONFLICT (user_id, notification_id) DO NOTHING`,
                    [userId, id]);
            }
            await pool.query('COMMIT');
        } catch (e) {
            try { await pool.query('ROLLBACK'); } catch (e2) { /* connection may be gone */ }
            /* fall through to file mirror */
        }
    }
    // file mirror (also the standalone fallback when DB is off)
    try {
        const f = fileFor(userId);
        let read = new Set();
        if (fs.existsSync(f)) { try { read = new Set(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) {} }
        list.forEach(id => read.add(id));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify([...read]));
    } catch (e) { /* ignore */ }
}

module.exports = {
    CATS,
    SEV,
    buildNotifications,
    readSetOf,
    unreadCount,
    markRead
};
