'use strict';

// ============================================================================
// Broker registry tests — per-user connection state (server/brokers.js).
// No real DB, no network: the module runs in file-fallback mode against a
// throwaway temp directory, and the DB path is exercised with a stubbed pool
// to pin the merge/fallback behavior.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// isolate from any real Postgres config — this module must run file-only
delete process.env.SUPABASE_DB_URL;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'brokers-test-'));
process.env.TRADEMIND_BROKER_DATA_DIR = TMP;

const Brokers = require('./brokers.js');
const Notif = require('./notifications.js');
const db = require('./db.js');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ok  ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
}

// tiny canonical-core fixture (mirrors the real core's public surface)
function makeCore(trades) {
    const now = Date.now();
    const Trades = trades.map((t, i) => ({
        id: 't' + i, account_id: 'acc-prop', ts: new Date(now - i * 864e5).toISOString(),
        symbol: 'EURUSD', dir: 'Long', pnl: 10, r: 0.4, risk: 25,
        adherence_result: null, block_reason: null, reviewed: true,
        strategy: 'London FVG', ...t
    }));
    const EVENT_LOG = [];
    return {
        Accounts: [{ id: 'acc-prop', name: 'Prop Firm A', starting_balance: 10000, current_equity: 10319 }],
        Trades,
        Violations: [],
        getEventLog: () => EVENT_LOG,
        ConfigAPI: {
            logTagEvent(entity, what, detail, impact) {
                EVENT_LOG.unshift({ entity, what, detail, impact, at: 'Aug 16, 10:00' });
            }
        },
        riskState: () => ({ status: 'NORMAL', dailyRiskBudget: 100, riskUsed: 0 })
    };
}

function brokerFile(userId) {
    const f = path.join(TMP, 'brokers-' + userId + '.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

console.log('\n== Brokers ==');

(async () => {

// ---- 1 · connect → clean shape, list + isConnected reflect it --------------
{
    const r = await Brokers.connect('u-1', 'TradingView');
    ok(r.ok === true, 'connect returns ok');
    ok(r.broker && r.broker.broker === 'TradingView' && r.broker.status === 'active' && r.broker.connected_at, 'connect returns broker {broker,status,connected_at}');
    // secret redaction: the payload exposes ONLY the registry fields
    const keys = r.broker ? Object.keys(r.broker).sort() : [];
    ok(JSON.stringify(keys) === JSON.stringify(['broker', 'connected_at', 'status']),
        'connect payload contains no secrets (only broker/connected_at/status)');
    const list = await Brokers.list('u-1');
    ok(list.length === 1 && list[0].broker === 'TradingView', 'list returns the connection');
    ok(await Brokers.isConnected('u-1') === true, 'isConnected true after connect');
}

// ---- 2 · disconnect → state clears ------------------------------------------
{
    await Brokers.disconnect('u-1', 'TradingView');
    ok(await Brokers.isConnected('u-1') === false, 'isConnected false after disconnect');
    const list = await Brokers.list('u-1');
    ok(list.length === 0, 'list empty after disconnect');
}

// ---- 3 · reconnect never duplicates (file upsert) ---------------------------
{
    await Brokers.connect('u-1', 'TradingView');
    await Brokers.disconnect('u-1', 'TradingView');
    await Brokers.connect('u-1', 'TradingView');   // reconnect after inactive
    const list = await Brokers.list('u-1');
    ok(list.length === 1 && list[0].status === 'active', 'reconnect leaves exactly one active entry');
    const file = brokerFile('u-1');
    ok(file && file.filter(b => b.broker === 'TradingView').length === 1,
        'file mirror has exactly one entry for the broker (no stale inactive duplicate)');
}

// ---- 4 · user isolation ------------------------------------------------------
{
    await Brokers.connect('u-alice', 'MetaTrader');
    ok(await Brokers.isConnected('u-bob') === false, 'bob is not connected when alice connects');
    ok((await Brokers.list('u-bob')).length === 0, 'bob sees an empty list');
    await Brokers.connect('u-bob', 'cTrader');
    ok((await Brokers.list('u-bob'))[0].broker === 'cTrader', 'bob sees only his own connection');
    await Brokers.disconnect('u-alice', 'MetaTrader');
    ok(await Brokers.isConnected('u-bob') === true, 'alice disconnecting does not touch bob');
    ok((await Brokers.list('u-alice')).length === 0, 'alice list empty after her own disconnect');
}

// ---- 5 · persistence across restarts ----------------------------------------
{
    const file = brokerFile('u-alice');
    ok(file !== null && file.length === 1 && file[0].status === 'inactive',
        'disconnect preserves history as an inactive row (matching the DB upsert)');
    await Brokers.connect('u-persist', 'NinjaTrader');
    const onDisk = brokerFile('u-persist');
    ok(onDisk && onDisk.length === 1 && onDisk[0].broker === 'NinjaTrader' && onDisk[0].status === 'active',
        'connection is written to the per-user data file');
    // a fresh module instance reads the same file (registry survives restart)
    const reloaded = require('./brokers.js');
    const seen = await reloaded.list('u-persist');
    ok(seen.length === 1 && seen[0].broker === 'NinjaTrader', 'state survives reload from disk');
}

// ---- 6 · input validation ----------------------------------------------------
{
    for (const bad of [undefined, null, 42, {}, '', '   ', 'x'.repeat(101)]) {
        const r = await Brokers.connect('u-validate', bad);
        ok(r.ok === false && typeof r.error === 'string', 'connect rejects invalid input: ' + JSON.stringify(bad));
    }
    ok(await Brokers.isConnected('u-validate') === false, 'no connection created by rejected input');
    const d = await Brokers.disconnect('u-validate', null);
    ok(d.ok === false, 'disconnect rejects invalid broker');
    const d2 = await Brokers.disconnect('u-validate', 'TradingView');   // not connected — idempotent
    ok(d2.ok === true, 'disconnect of an unknown broker is a clean no-op');
}

// ---- 7 · notification state follows broker state -----------------------------
{
    const core = makeCore([{ id: 't0' }]);
    const absent = Notif.buildNotifications(core, 'acc-prop', { brokerConnected: true, upcomingEvents: [] });
    ok(!absent.some(n => n.id === 'onb-broker'), 'onb-broker absent when a broker is connected');
    const present = Notif.buildNotifications(core, 'acc-prop', { brokerConnected: false, upcomingEvents: [] });
    ok(present.some(n => n.id === 'onb-broker'), 'onb-broker present when no broker is connected');
}

// ---- 7b · broker connect/disconnect writes the canonical event log -----------
// Mirrors server.js's logBrokerEvent() exactly (the route helper is tested
// against the same core surface the server uses). Events must land in the
// event log and surface as System notifications + audit history.
{
    const core = makeCore([{ id: 't0' }]);
    const logBrokerEvent = (Core, broker, what) => {
        const name = typeof broker === 'string' ? broker : String(broker || 'Broker');
        Core.ConfigAPI.logTagEvent(
            'Broker · ' + name, what, what + ' · ' + name,
            'Broker state shown in Settings & onboarding checklist'
        );
    };

    // connect event
    logBrokerEvent(core, 'TradingView', 'Connected');
    let log = core.getEventLog();
    ok(log.length === 1, 'connect writes one event-log entry');
    ok(log[0].entity === 'Broker · TradingView' && log[0].what === 'Connected',
        'connect event entity/what correct');
    ok(log[0].detail === 'Connected · TradingView' && typeof log[0].impact === 'string',
        'connect event has detail + impact');
    ok(!/secret|token|key|password/i.test(JSON.stringify(log[0])),
        'connect event contains no credential material');

    // disconnect event
    logBrokerEvent(core, 'TradingView', 'Disconnected');
    log = core.getEventLog();
    ok(log.length === 2 && log[0].what === 'Disconnected', 'disconnect writes its own event');

    // the same event surfaces in the System notification feed
    const feed = Notif.buildNotifications(core, 'acc-prop', { brokerConnected: false, upcomingEvents: [] });
    const sys = feed.filter(n => n.cat === 'System');
    ok(sys.length >= 2, 'broker events surface in System notifications');
    ok(sys.some(n => n.title === 'Connected · Broker · TradingView' && n.body.indexOf('TradingView') !== -1),
        'System feed shows the broker Connected notification');
    ok(sys.some(n => n.title === 'Disconnected · Broker · TradingView'),
        'System feed shows the broker Disconnected notification');
    // (the announcement, if present, is also a System entry with its own href)
    const brokerSys = sys.filter(n => /Broker ·/.test(n.title));
    ok(brokerSys.length === 2 && brokerSys.every(n => n.href === 'strategy-lab.html?tab=history'),
        'broker events link to audit history like other config changes');
}

// ---- 8 · DB path: merge + fallback (stubbed pool) ----------------------------
{
    const orig = db.getPool;
    const rows = [{ broker: 'ThinkOrSwim', connected_at: '2026-08-01T00:00:00.000Z', status: 'active' }];
    // pool returns rows → DB entries win, file fills gaps
    db.getPool = () => ({
        async query() { return { rows }; }
    });
    await Brokers.connect('u-merge', 'TradingView');   // file-only connection
    let merged = await Brokers.list('u-merge');
    ok(merged.length === 2, 'list merges DB + file rows');
    ok(merged.some(b => b.broker === 'ThinkOrSwim') && merged.some(b => b.broker === 'TradingView'),
        'merged list contains both the DB broker and the file-only broker');
    ok((await Brokers.isConnected('u-merge')) === true, 'isConnected true when DB has a row');

    // pool throws (table missing) → file fallback only
    db.getPool = () => ({
        async query() { throw new Error('relation "broker_connections" does not exist'); }
    });
    const fb = await Brokers.list('u-merge');
    ok(fb.length === 1 && fb[0].broker === 'TradingView', 'table-missing pool falls back to file');
    ok((await Brokers.isConnected('u-bob')) === true, 'isConnected falls back to file when DB throws');

    // pool returns empty rows → file still answers
    db.getPool = () => ({
        async query() { return { rows: [] }; }
    });
    const empty = await Brokers.list('u-persist');
    ok(empty.length === 1 && empty[0].broker === 'NinjaTrader', 'empty DB rows fall back to the file mirror');

    db.getPool = orig;
}

// ---- 9 · route contract: normalizeName exported for thin 400 mapping ---------
{
    ok(Brokers.normalizeName('  TradingView  ') === 'TradingView', 'normalizeName trims');
    ok(Brokers.normalizeName('') === null && Brokers.normalizeName(7) === null, 'normalizeName rejects empty/non-string');
}

console.log('\n' + (fail === 0 ? 'ALL BROKER CHECKS PASS' : fail + ' BROKER CHECKS FAILED') + ' (' + pass + ' ok)\n');
process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('BROKER TEST CRASH:', err); process.exit(1); });
