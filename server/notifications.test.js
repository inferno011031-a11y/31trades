'use strict';

// ============================================================================
// Notifications engine tests — derivation from the canonical core + read state.
// No DB, no network: an in-memory core fixture stands in for the canonical
// tables so the tests pin the exact derivation contract.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Notif = require('./notifications.js');

// ---- tiny canonical-core fixture (mirrors the real core's public surface) ----
function makeCore(trades, violations, eventLog, accounts) {
    const Accounts = accounts || [{ id: 'acc-prop', name: 'Prop Firm A', starting_balance: 10000, current_equity: 10319 }];
    const now = Date.now();
    const Trades = trades.map((t, i) => ({
        id: 't' + i, account_id: 'acc-prop', ts: new Date(now - i * 864e5).toISOString(),
        symbol: 'EURUSD', dir: 'Long', pnl: 10, r: 0.4, risk: 25,
        adherence_result: null, block_reason: null, reviewed: true,
        strategy: 'London FVG', ...t
    }));
    const Violations = violations || [];
    const EVENT_LOG = eventLog || [];
    return {
        Accounts,
        Trades,
        Violations,
        getEventLog: () => EVENT_LOG,
        riskState: accountId => {
            if (!Trades.length) {
                return { status: 'NORMAL', dailyRiskBudget: 100, riskUsed: 0, dailyLossLimit: 100, lossUsed: 0, currentDrawdown: 0, drawdownLimit: 500, maxAllowedRisk: 25 };
            }
            const used = Trades.reduce((s, t) => s + (t.risk || 0), 0);
            const status = used >= 100 ? 'LIMIT' : used >= 70 ? 'HIGH' : used >= 50 ? 'CAUTION' : 'NORMAL';
            return { status, dailyRiskBudget: 100, riskUsed: used, dailyLossLimit: 100, lossUsed: 0, currentDrawdown: 20, drawdownLimit: 500, maxAllowedRisk: 25 };
        }
    };
}

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ok  ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
}

console.log('\n== Notifications engine ==');

// ---- 1 · empty core → no notifications --------------------------------------
{
    const c = makeCore([]);
    const out = Notif.buildNotifications(c, 'acc-prop');
    ok(Array.isArray(out) && out.length === 0, 'empty core → empty feed');
}

// ---- 2 · risk limit breached → critical Risk notification -------------------
{
    const c = makeCore([
        { risk: 40 }, { risk: 40 }, { risk: 40 }   // 120 ≥ 100 budget → LIMIT
    ]);
    const out = Notif.buildNotifications(c, 'acc-prop');
    const r = out.find(n => n.id === 'risk-limit');
    ok(!!r, 'limit breach → risk-limit notification');
    ok(r && r.sev === 'critical', 'limit breach is critical');
    ok(r && r.cat === 'Risk', 'limit breach belongs to Risk');
}

// ---- 3 · policy block → Risk notification with the reason -------------------
{
    const c = makeCore([
        { risk: 45, adherence_result: 'BLOCK', block_reason: 'Max risk per trade: expected $25, actual $45', symbol: 'ETHUSD' }
    ]);
    const out = Notif.buildNotifications(c, 'acc-prop');
    const b = out.find(n => n.id.indexOf('block-') === 0);
    ok(!!b, 'blocked trade → block notification');
    ok(b && b.title.indexOf('ETHUSD') > -1, 'block title names the symbol');
    ok(b && b.body.indexOf('expected $25, actual $45') > -1, 'block body carries the reason');
}

// ---- 4 · discipline violation → Discipline notification with impact ---------
{
    const c = makeCore([], [{
        id: 'v1', account_id: 'acc-prop', tradeId: 't0', ruleLabel: 'Max risk per trade',
        explanation: 'expected $25, actual $45', pnl: -40, r: -0.89, ts: new Date().toISOString()
    }]);
    const out = Notif.buildNotifications(c, 'acc-prop');
    const v = out.find(n => n.id.indexOf('viol-') === 0);
    ok(!!v, 'violation → Discipline notification');
    ok(v && v.id === 'viol-t0-Max-risk-per-trade', 'violation id is stable across re-derivation (tradeId + ruleKey)');
    ok(v && v.cat === 'Discipline' && v.sev === 'high', 'violation severity + category');
    ok(v && v.body.indexOf('-0.89R') > -1, 'violation body carries R impact');
}

// ---- 5 · pending reviews ------------------------------------------------------
{
    const c = makeCore([{ reviewed: false, symbol: 'GBPUSD', dir: 'Short' }, { reviewed: true }]);
    const out = Notif.buildNotifications(c, 'acc-prop');
    const r = out.find(n => n.id === 'reviews-pending');
    ok(!!r, 'unreviewed trade → reviews notification');
    ok(r && r.title.indexOf('1 trade') === 0, 'review count correct');
    ok(r && r.body.indexOf('GBPUSD') > -1, 'review body names the symbol');
}

// ---- 6 · system / audit events ------------------------------------------------
{
    const c = makeCore([], [], [{ entity: 'Account · Prop Firm A', what: 'Limit edited', detail: '$80 → $100', at: 'Aug 2, 17:40' }]);
    const out = Notif.buildNotifications(c, 'acc-prop');
    const s = out.find(n => n.id.indexOf('sys-') === 0);
    ok(!!s, 'audit event → System notification');
    ok(s && s.cat === 'System' && s.sev === 'info', 'system category + severity');
}

// ---- 7 · upcoming market events (injected by the server) ----------------------
{
    const c = makeCore([]);
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const out = Notif.buildNotifications(c, 'acc-prop', {
        upcomingEvents: [{ ts: inOneHour, title: 'US Nonfarm Payrolls', impact: 'High', country: 'USD', forecast: '0.2%' }]
    });
    const m = out.find(n => n.id.indexOf('market-') === 0);
    ok(!!m, 'upcoming event → Market notification');
    ok(m && m.title.indexOf('Nonfarm Payrolls') > -1, 'market title names the event');
    ok(m && m.body.indexOf('1h') > -1 || m.body.indexOf('60') > -1, 'market body carries the countdown');
}

// ---- 8 · newest first ordering ------------------------------------------------
{
    const c = makeCore([{ reviewed: false, risk: 90 }]);
    const out = Notif.buildNotifications(c, 'acc-prop');
    const times = out.map(n => new Date(n.at).getTime());
    const sorted = times.every((t, i) => i === 0 || times[i - 1] >= t);
    ok(sorted, 'feed is sorted newest-first');
}

// ---- 9 · read-state persistence (async; DB-first with file fallback) -----------
;(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-test-'));
    process.env.TRADEMIND_NOTIF_DATA_DIR = dir;
    try {
        const c = makeCore([{ risk: 90 }]);   // → caution
        const out = Notif.buildNotifications(c, 'acc-prop');
        const first = out[0];
        ok(await Notif.unreadCount('u1', out) === out.length, 'all unread before marking');
        await Notif.markRead('u1', [first.id]);
        ok(await Notif.unreadCount('u1', out) === out.length - 1, 'one read after markRead');
        // persists: a fresh set reads the same store
        const fresh = await Notif.readSetOf('u1');
        ok(fresh.has(first.id), 'read state persists (DB or file fallback)');
        // other users are isolated
        ok(await Notif.unreadCount('u2', out) === out.length, 'read state is per-user');
    } finally {
        delete process.env.TRADEMIND_NOTIF_DATA_DIR;
    }
    console.log('\n' + (fail === 0 ? 'ALL NOTIFICATION CHECKS PASS' : fail + ' NOTIFICATION CHECKS FAILED') + ' (' + pass + ' ok)\n');
    process.exit(fail === 0 ? 0 : 1);
})();

// ---- 10 · market events only fire when injected (no fake data) -----------------
{
    const c = makeCore([]);
    const out = Notif.buildNotifications(c, 'acc-prop', { upcomingEvents: [] });
    ok(!out.some(n => n.id.indexOf('market-') === 0), 'no market notification when no upcoming events');
}

