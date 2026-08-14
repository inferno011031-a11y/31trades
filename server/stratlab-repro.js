'use strict';

// ============================================================================
// 31TRADES — Strategy Lab crash reproduction harness
// ----------------------------------------------------------------------------
// Spawns the REAL server (anonymous mode) on a test port, loads the REAL
// browser shell (core.js) in Node, then drives the exact requests Strategy
// Lab triggers: adopt → create account → create strategy → edit strategy
// (version bump) → toggle rule → log trade → delete. After every step it
// checks the server process is still alive and dumps the server log on death.
//
// Run:  node server/stratlab-repro.js
// ============================================================================

const { spawn } = require('node:child_process');
const { loadEnv } = require('./env.js');
loadEnv();

const PORT = 8300 + Math.floor(Math.random() * 100);
const API = 'http://127.0.0.1:' + PORT;
const root = __dirname + '/..';

let serverProc = null;
let serverLog = '';
function startServer() {
    return new Promise((resolve, reject) => {
        serverProc = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { ...process.env, TRADEMIND_PORT: String(PORT), TRADEMIND_AUTH: 'off' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        serverLog = '';
        serverProc.stdout.on('data', d => { serverLog += d; });
        serverProc.stderr.on('data', d => { serverLog += d; });
        serverProc.on('exit', (code, sig) => {
            console.log('!!! SERVER PROCESS EXITED  code=' + code + ' signal=' + sig);
            console.log('--- last server output ---');
            console.log(serverLog.slice(-1500));
        });
        const t0 = Date.now();
        const poll = async () => {
            try {
                const r = await fetch(API + '/api/health');
                if (r.ok) return resolve();
            } catch (e) { /* not up yet */ }
            if (Date.now() - t0 > 25000) return reject(new Error('server boot timeout'));
            setTimeout(poll, 500);
        };
        poll();
    });
}

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
    global.window = { localStorage: localStorageStub, DemoTrades: undefined, createTradeMindCore: createCore, __TRADEMIND_API_ROOT__: API, __TRADEMIND_AUTH_BYPASS__: true };
    delete require.cache[require.resolve('../core.js')];
    require('../core.js');
    return global.window.TradeMindCore;
}

let failures = 0;
const alive = () => (serverProc && serverProc.exitCode === null && !serverProc.killed);
const step = async (label, fn) => {
    try {
        await fn();
        console.log((alive() ? '  ok   ' : '  DEAD ') + label + (alive() ? '' : '  ← server crashed here'));
        if (!alive()) { failures++; process.exitCode = 1; return false; }
        return true;
    } catch (err) {
        console.log('  FAIL ' + label + '  — ' + err.message);
        failures++;
        return false;
    }
};

async function run() {
    await startServer();
    console.log('[repro] server up on :' + PORT);

    const Core = loadBrowserShell();
    await sleep(800);   // let connectLoop adopt

    await step('boot adopt', async () => {
        const r = await fetch(API + '/api/state');
        const st = await r.json();
        if (!Array.isArray(st.Trades)) throw new Error('bad state');
    });

    await step('create account', () => Core.ConfigAPI.createAccount(
        { name: 'Repro Acct', start: 10000, dailyLoss: 100, maxDD: 500, risk: 25 }, 'acc-repro'));

    await step('create strategy', () => Core.ConfigAPI.createStrategy(
        { name: 'Repro Strat', markets: ['Forex'], sessions: ['London'], setup: 'ICT', riskPerTrade: '1%', minRR: 1.5, stopRequired: true, behavior: [], evidence: [], tags: [] }, 'strat-repro'));

    await step('edit strategy (version bump)', () => Core.ConfigAPI.updateStrategy('strat-repro',
        { name: 'Repro Strat v2', minRR: 2, riskPerTrade: '2%' }, 'repro edit'));

    await step('toggle rule', () => Core.ConfigAPI.toggleRule('max-risk-per-trade'));

    await step('log trade', () => Core.logTradePipeline({
        account_id: 'acc-repro', strategy_id: 'strat-repro', symbol: 'EURUSD', dir: 'Long',
        entry: 1.1, exit: 1.105, size: 1, risk: 25, pnl: 50, setup: 'ICT', session: 'London' }));

    await step('edit trade', () => Core.TradeService.update(Core.Trades[0].id, { risk: 45 }));

    await step('delete trade', () => Core.TradeService.remove(Core.Trades[0].id));

    await sleep(1500);   // let scheduled saves flush
    console.log('');
    console.log('RESULT: ' + (alive() && !failures ? 'all steps ok, server alive' : (failures + ' step(s) failed / server crashed')));
    console.log('--- server log tail ---');
    console.log(serverLog.slice(-800));
    process.exit(failures ? 1 : 0);
}

run().catch(err => { console.error('repro crashed: ' + err.message); process.exit(1); });
