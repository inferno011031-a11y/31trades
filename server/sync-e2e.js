'use strict';

// ============================================================================
// 31TRADES — Client⇄server sync end-to-end test (needs a reachable Postgres)
// ----------------------------------------------------------------------------
// Runs the REAL server on a test port, loads the REAL browser shell (core.js)
// in Node with a localStorage stub + real fetch, then verifies:
//   1. boot adopt:      browser state pushed to the server on connect
//   2. online replay:   a mutation replays to the server immediately
//   3. offline accum.:  mutations while offline stay local (localStorage)
//   4. reconnect adopt: full state pushed again → offline trades reach Postgres
//
// Run:  node server/sync-e2e.js     (SUPABASE_DB_URL must be configured)
// ============================================================================

const { spawn } = require('node:child_process');
const { loadEnv } = require('./env.js');
loadEnv();

const PORT = 8001 + Math.floor(Math.random() * 200);   // avoid collisions with stray children
const API = 'http://127.0.0.1:' + PORT;
const root = __dirname + '/..';

let serverProc = null;
let serverLog = '';
function startServer() {
    return new Promise((resolve, reject) => {
        serverProc = spawn(process.execPath, ['server.js'], {
            // anonymous mode: this test exercises the sync/replay layer, not auth
            cwd: root, env: { ...process.env, TRADEMIND_PORT: String(PORT), TRADEMIND_AUTH: 'off' }, stdio: ['ignore', 'pipe', 'pipe']
        });
        serverLog = '';
        serverProc.stdout.on('data', d => { serverLog += d; });
        serverProc.stderr.on('data', d => { serverLog += d; });
        const t0 = Date.now();
        const poll = async () => {
            try {
                const r = await fetch(API + '/api/health');
                if (r.ok) { console.log('[sync-e2e] server up on :' + PORT + ' (storage: ' + (await r.json()).storage + ')'); return resolve(); }
            } catch (e) { /* not up yet */ }
            if (Date.now() - t0 > 25000) { console.log(serverLog.slice(-1000)); return reject(new Error('server boot timeout')); }
            setTimeout(poll, 500);
        };
        poll();
    });
}
function stopServer() {
    return new Promise(resolve => {
        if (!serverProc) return resolve();
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        serverProc.on('exit', finish);
        serverProc.kill('SIGTERM');
        setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch (e) {} finish(); }, 6000);
    });
}

// ---- browser shell environment -------------------------------------------------
const createCore = require('../src/core/index.js');
const localStorageStub = (() => {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear(),
        key: i => [...m.keys()][i] || null,
        get length() { return m.size; }
    };
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadBrowserShell() {
    // fresh globals per run — simulate a fresh browser tab (the UMD module sets
    // window.createTradeMindCore in a real browser; inject it here)
    global.window = { localStorage: localStorageStub, DemoTrades: undefined, createTradeMindCore: createCore, __TRADEMIND_API_ROOT__: API, __TRADEMIND_AUTH_BYPASS__: true };
    delete require.cache[require.resolve('../core.js')];
    require('../core.js');   // boots: hydrate + connectLoop (adopt)
    return global.window.TradeMindCore;
}

let failures = 0;
const check = (label, cond, extra) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (extra ? '  — ' + extra : ''));
    if (!cond) failures++;
};
const apiState = async () => (await (await fetch(API + '/api/state')).json());
const get = async p => (await (await fetch(API + p)).json());

async function run() {
    await startServer();
    await fetch(API + '/api/reset', { method: 'POST' });   // clean slate
    await sleep(500);

    // ---- 1. boot adopt: fresh tab with a pre-existing local store ----------------
    let Core = loadBrowserShell();
    await sleep(600);   // let the connect loop finish the adopt
    check('1 boot: backend online after connect', Core.isBackendOnline());
    check('1 boot: empty state adopted', (await apiState()).Trades.length === 0);

    // ---- 2. online replay ---------------------------------------------------------
    Core.ConfigAPI.createAccount({ name: 'Sync Test', start: 1000, dailyLoss: 50, maxDD: 200, risk: 10 }, 'acc-sync');
    Core.ConfigAPI.createStrategy({ name: 'Test Strat', sessions: ['London'], setup: 'Test', riskPerTrade: '1%', minRR: 1.5, stopRequired: true, behavior: [], evidence: [], tags: [] }, 'strat-sync');
    const t1 = Core.logTradePipeline({ account_id: 'acc-sync', strategy_id: 'strat-sync', symbol: 'EURUSD', dir: 'Long', entry: 1.1, exit: 1.102, size: 1, risk: 5, pnl: 20, setup: 'Test', session: 'London' });
    await sleep(1500);   // let the replay chain flush
    let st = await apiState();
    check('2 online: trade replayed to server', st.Trades.some(t => t.id === t1.id),
        'server trades: ' + st.Trades.length + ' = ' + st.Trades.map(t => t.id).join(', '));

    // ---- 3. offline accumulation ---------------------------------------------------
    const serverTradesBefore = (await apiState()).Trades.length;   // captured while online
    await stopServer();
    await sleep(300);
    const t2 = Core.logTradePipeline({ account_id: 'acc-sync', strategy_id: 'strat-sync', symbol: 'GBPUSD', dir: 'Short', entry: 1.27, exit: 1.268, size: 1, risk: 5, pnl: 20, setup: 'Test', session: 'London' });
    await sleep(300);
    check('3 offline: trade kept locally', Core.Trades.some(t => t.id === t2.id));
    // the online flag only flips on the next connect attempt (30s retry / manual
    // connect) — the meaningful guarantee is that the offline trade stayed local
    check('3 offline: local count grew while server frozen', Core.Trades.length === serverTradesBefore + 1,
        Core.Trades.length + ' vs ' + serverTradesBefore);

    // ---- 4. reconnect adopt ---------------------------------------------------------
    await startServer();
    const ok = await Core.connectBackend();   // manual reconnect (the loop would do this in 30s)
    check('4 reconnect: online again', ok);
    await sleep(1000);
    st = await apiState();
    check('4 reconnect: offline trade reached server', st.Trades.some(t => t.id === t2.id), 'server trades: ' + st.Trades.length);

    // idempotency: replaying the same create is a no-op
    const before = st.Trades.length;
    await fetch(API + '/api/trades', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...t2 }) });
    await sleep(800);
    st = await apiState();
    check('4 idempotent replay: no duplicate trade', st.Trades.length === before, st.Trades.length + ' vs ' + before);

    // cleanup: reset server + local store
    await fetch(API + '/api/reset', { method: 'POST' });
    Core.reseed();
    await stopServer();
    console.log('');
    if (failures) { console.log('RESULT: ' + failures + ' check(s) FAILED'); process.exit(1); }
    console.log('RESULT: sync e2e passed');
    process.exit(0);
}

run().catch(err => { console.error('sync-e2e crashed: ' + err.message); stopServer().then(() => process.exit(1)); });
