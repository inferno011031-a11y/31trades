'use strict';

// ============================================================================
// 31TRADES — Client⇄server sync end-to-end test (hermetic: no DB, no real data)
// ----------------------------------------------------------------------------
// Runs the REAL server on a test port, loads the REAL browser shell (core.js)
// in Node with a localStorage stub + real fetch, then verifies:
//   1. boot adopt:      browser state pushed to the server on connect
//   2. online replay:   a mutation replays to the server immediately
//   3. offline accum.:  mutations while offline stay local (localStorage)
//   4. reconnect adopt: full state pushed again → offline trades reach the store
//   5. stale client:    a browser holding MORE trades can never revert newer
//                       server data, and its own offline work still lands
//   6. offline edit:    editing an EXISTING record while offline survives the
//                       reconnect (the opposite failure — losing local work)
//
// Run:  node server/sync-e2e.js
//
// ISOLATION: the child server is started with TRADEMIND_DATA_DIR pointed at a
// scratch directory and SUPABASE_DB_URL emptied, so `POST /api/reset` inside this
// test can never touch the real `data/` store or the Supabase database.
// ============================================================================

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnv } = require('./env.js');
loadEnv();

const PORT = 8001 + Math.floor(Math.random() * 200);   // avoid collisions with stray children
const API = 'http://127.0.0.1:' + PORT;
const root = __dirname + '/..';
// Scratch store for this run — removed when the test finishes.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bxj-sync-e2e-'));

let serverProc = null;
let serverLog = '';
function startServer() {
    return new Promise((resolve, reject) => {
        serverProc = spawn(process.execPath, ['server.js'], {
            // anonymous mode: this test exercises the sync/replay layer, not auth.
            // TRADEMIND_DATA_DIR + an empty SUPABASE_DB_URL keep every write inside
            // the scratch directory (an empty string is "defined" to server/env.js,
            // so the real .env value cannot sneak back in).
            cwd: root,
            env: {
                ...process.env,
                TRADEMIND_PORT: String(PORT),
                TRADEMIND_AUTH: 'off',
                TRADEMIND_DATA_DIR: SCRATCH,
                SUPABASE_DB_URL: ''
            },
            stdio: ['ignore', 'pipe', 'pipe']
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
        // Pin the child this call owns: the SIGKILL fallback below must never fire
        // at a server started LATER (it would kill a healthy process mid-test), and
        // the timer must not outlive the graceful exit either.
        const proc = serverProc;
        serverProc = null;
        let done = false;
        let killTimer = null;
        const finish = () => {
            if (done) return;
            done = true;
            if (killTimer) clearTimeout(killTimer);
            resolve();
        };
        proc.on('exit', finish);
        proc.kill('SIGTERM');
        killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} finish(); }, 6000);
    });
}

// ---- browser shell environment -------------------------------------------------
const createCore = require('../src/core/index.js');
// The pages load this as <script src="src/merge.js"> right before the shared
// core; without it the shell refuses to push anything (its fail-safe).
const mergeModule = require('../src/merge.js');
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

// Minimal DOM stand-in: a real tab always has one, and the shell's boot path
// installs a global keyboard listener (Ctrl/⌘-K command palette) as it finishes.
// This test exercises the sync layer, so the nodes are inert.
const documentStub = {
    addEventListener() {}, removeEventListener() {},
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    activeElement: null
};

function loadBrowserShell() {
    // fresh globals per run — simulate a fresh browser tab (the UMD module sets
    // window.createTradeMindCore in a real browser; inject it here)
    global.document = documentStub;
    global.window = {
        localStorage: localStorageStub, document: documentStub,
        location: { pathname: '/', search: '', replace() {} },
        DemoTrades: undefined, createTradeMindCore: createCore, TradeMindMerge: mergeModule,
        __TRADEMIND_API_ROOT__: API, __TRADEMIND_AUTH_BYPASS__: true
    };
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

    // ============================================================================
    // 5. THE REGRESSION — a stale browser must never overwrite newer server data
    // ----------------------------------------------------------------------------
    // A trade was edited on ANOTHER machine, so the server's copy is newer. This
    // browser still holds an older copy of that trade plus an extra local-only
    // trade — i.e. MORE trades than the server, which is exactly what the old
    // trade-count heuristic pushed over the top of it. Two guarantees are checked
    // at once: the server's edit survives, and the local work is not thrown away.
    // ============================================================================
    {
        const shared = (await apiState()).Trades.find(t => t.id === t1.id);
        check('5 setup: the shared trade exists on the server', !!shared);
        const staleSnapshot = JSON.parse(localStorageStub.getItem('31trades.state.v1'));

        // another machine edits it, straight to the API (this browser never sees it)
        const NOTE = 'VOICE NOTE written on another machine';
        await fetch(API + '/api/trades/' + t1.id, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { note: NOTE } })
        });
        await sleep(400);
        const edited = (await apiState()).Trades.find(t => t.id === t1.id);
        check('5 setup: the server now holds the newer note', edited.note === NOTE, JSON.stringify(edited.note));

        // the stale browser: its own offline trade + the older copy of the shared one
        staleSnapshot.Trades.push({
            id: 'txn-offline-1', account_id: 'acc-sync', strategy_id: 'strat-sync', symbol: 'XAUUSD',
            dir: 'Long', entry: 2400, exit: 2405, size: 0.5, risk: 10, pnl: 250, r: 2.5,
            setup: 'Offline', session: 'London', note: 'logged while offline',
            created_at: new Date().toISOString()
        });
        localStorageStub.setItem('31trades.state.v1', JSON.stringify(staleSnapshot));
        const staleCount = staleSnapshot.Trades.length;
        check('5 setup: the stale browser holds MORE trades than the server',
            staleCount > (await apiState()).Trades.length, staleCount + ' vs ' + (await apiState()).Trades.length);

        Core = loadBrowserShell();          // fresh tab booting on stale data
        await sleep(1800);                  // let adopt (+ any push) finish

        const after = await apiState();
        const sharedAfter = after.Trades.find(t => t.id === t1.id);
        check('5 stale adopt: the newer server note SURVIVES', sharedAfter && sharedAfter.note === NOTE,
            sharedAfter ? JSON.stringify(sharedAfter.note) : 'trade missing');
        check('5 stale adopt: the server r was not reverted', sharedAfter && sharedAfter.r === edited.r,
            (sharedAfter ? sharedAfter.r : '?') + ' vs ' + edited.r);
        check('5 stale adopt: the shared trade was not duplicated',
            after.Trades.filter(t => t.id === t1.id).length === 1);
        check('5 stale adopt: local-only work still reached the server',
            after.Trades.some(t => t.id === 'txn-offline-1'), after.Trades.map(t => t.id).join(', '));
        check('5 stale adopt: no local trade was lost', after.Trades.length >= staleCount,
            after.Trades.length + ' vs ' + staleCount);

        // a second boot must be a NO-OP (the exchange settles, no push ping-pong)
        const settledBefore = (await apiState()).Trades.length;
        Core = loadBrowserShell();
        await sleep(1400);
        check('5 second boot: nothing changes when everyone agrees',
            (await apiState()).Trades.length === settledBefore, (await apiState()).Trades.length + ' vs ' + settledBefore);
    }

    // ============================================================================
    // 6. OFFline EDIT of an EXISTING record must survive the reconnect
    // ----------------------------------------------------------------------------
    // The opposite failure: the merge keeps the server's copy whenever it cannot
    // prove the client edited something. Editing a synced trade while the server is
    // down has to still reach the server — otherwise "protect the server" would
    // just mean losing the user's work instead.
    // ============================================================================
    {
        const acc = Core.Accounts.find(a => a.id === 'acc-sync') || Core.Accounts[0];
        const t4 = Core.logTradePipeline({
            account_id: acc.id, strategy_id: 'strat-sync', symbol: 'GBPJPY', dir: 'Short',
            entry: 190.1, exit: 189.9, size: 1, risk: 20, pnl: 40, setup: 'Offline edit', session: 'London'
        });
        await sleep(1200);
        check('6 setup: the trade reached the server while online',
            (await apiState()).Trades.some(t => t.id === t4.id));

        await stopServer();                        // server goes away
        await sleep(300);
        const EDIT = 'note written while the server was DOWN';
        Core.TradeService.update(t4.id, { note: EDIT, emotion: 'disciplined' });
        await sleep(400);                          // persist() is debounced by 60ms
        check('6 offline: the edit is in memory',
            (Core.Trades.find(t => t.id === t4.id) || {}).note === EDIT);
        const persisted = JSON.parse(localStorageStub.getItem('31trades.state.v1'));
        check('6 offline: the edit is persisted in the browser store',
            ((persisted.Trades || []).find(t => t.id === t4.id) || {}).note === EDIT);

        await startServer();
        check('6 reconnect: online again', await Core.connectBackend());
        await sleep(1800);
        const t4After = (await apiState()).Trades.find(t => t.id === t4.id);
        check('6 reconnect: the offline edit reached the server',
            t4After && t4After.note === EDIT, t4After ? JSON.stringify(t4After.note) : 'trade missing');
        check('6 reconnect: the other edited field came with it', t4After && t4After.emotion === 'disciplined',
            t4After ? String(t4After.emotion) : '?');
    }

    // cleanup: reset server + local store
    await fetch(API + '/api/reset', { method: 'POST' });
    Core.reseed();
    await stopServer();
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
    console.log('');
    if (failures) { console.log('RESULT: ' + failures + ' check(s) FAILED'); process.exit(1); }
    console.log('RESULT: sync e2e passed');
    process.exit(0);
}

run().catch(err => {
    console.error('sync-e2e crashed: ' + err.message);
    console.error('--- child server: pid ' + (serverProc && serverProc.pid) +
        ' exitCode ' + (serverProc && serverProc.exitCode) +
        ' signal ' + (serverProc && serverProc.signalCode) + ' ---');
    if (serverLog) console.error('--- server output (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
    stopServer().then(() => process.exit(1));
});
