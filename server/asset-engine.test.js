'use strict';

// ============================================================================
// 31TRADES — Asset Spec Engine tests (no database required)
// ----------------------------------------------------------------------------
// The shared engine (src/core/index.js) recognizes every major asset class and
// computes P&L / position sizing from contract specs — the SAME math the
// journal form, analytics and the server trade pipeline use. These tests pin
// the recognition table and the per-class formulas so a spec edit can't
// silently change what a logged trade is worth.
//
// Run:  node server/asset-engine.test.js
// ============================================================================

global.window = { SERVER_MODE: true };
require('../demo-trades.js');
const createCore = require('../src/core/index.js');
const core = createCore({ demoTrades: global.window.DemoTrades });

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra || '')));
    if (!cond) failures++;
}

// ---- 1. asset-class recognition ------------------------------------------
const CLASSES = {
    EURUSD: ['Forex', 'Pips'], GBPUSD: ['Forex', 'Pips'], USDJPY: ['Forex', 'Pips'],
    XAUUSD: ['Commodities', 'Pips'], XAGUSD: ['Commodities', 'Pips'], USOIL: ['Commodities', 'Pips'], NATGAS: ['Commodities', 'Pips'],
    NAS100: ['Indices', 'Points'], US30: ['Indices', 'Points'], SPX500: ['Indices', 'Points'], DAX40: ['Indices', 'Points'],
    BTCUSD: ['Crypto', 'Coins'], ETHUSD: ['Crypto', 'Coins'], SOLUSD: ['Crypto', 'Coins'],
    AAPL: ['Stocks', 'Cents'], TSLA: ['Stocks', 'Cents'], MSFT: ['Stocks', 'Cents']
};
Object.keys(CLASSES).forEach(sym => {
    const s = core.assetSpecFor(sym) || {};
    check('class ' + sym + ' → ' + CLASSES[sym][0] + ' / ' + CLASSES[sym][1],
        s.assetClass === CLASSES[sym][0] && s.unit === CLASSES[sym][1],
        JSON.stringify(s));
});
check('unknown symbol → Other class', core.assetClassOf('XYZQ1') === 'Other', core.assetClassOf('XYZQ1'));

// ---- 2. dynamic P&L — each class uses its own contract math ----------------
const PNL = [
    ['EURUSD', 'Long', 1.08845, 1.09085, 1, 240],   // 24 pips × $10
    ['USDJPY', 'Long', 155.20, 155.30, 1, 100],      // 10 pips (0.01) × $10
    ['XAUUSD', 'Long', 2345.10, 2346.10, 1, 100],    // 10 × 0.1 pips × $10
    ['NAS100', 'Short', 21840, 21820, 1, 20],        // 20 points × $1
    ['AAPL', 'Long', 150, 155, 20, 100],             // 20 shares × $5
    ['BTCUSD', 'Long', 60000, 60500, 0.5, 250],      // 0.5 coins × $500
    ['USOIL', 'Long', 78.00, 78.10, 1, 100]          // 10 × 0.01 ticks × $10
];
PNL.forEach(([sym, dir, entry, exit, size, want]) => {
    const got = core.calcPnl(sym, dir, entry, exit, size);
    check('pnl ' + sym + ' ' + dir + ' → $' + want, got === want, 'got $' + got);
});

// ---- 3. risk-based position sizing -----------------------------------------
check('size EURUSD $100 / 20-pip stop → 0.5 lots', core.calcPositionSize('EURUSD', 100, 1.09, 1.088) === 0.5, core.calcPositionSize('EURUSD', 100, 1.09, 1.088));
check('size AAPL $100 / $5 stop → 20 shares', core.calcPositionSize('AAPL', 100, 150, 145) === 20, core.calcPositionSize('AAPL', 100, 150, 145));
check('size NAS100 $100 / 50-point stop → 2 contracts', core.calcPositionSize('NAS100', 100, 21800, 21750) === 2, core.calcPositionSize('NAS100', 100, 21800, 21750));
check('actual risk EURUSD 0.5 lots / 20-pip stop → $100', core.calcRiskDollars('EURUSD', 1.09, 1.088, 0.5) === 100, core.calcRiskDollars('EURUSD', 1.09, 1.088, 0.5));
check('rr 1:2 from entry/stop/tp', core.calcRR(1.09, 1.088, 1.094) === 2, core.calcRR(1.09, 1.088, 1.094));

// ---- 4. the 7-step pipeline auto-derives P&L / size -------------------------
core.ConfigAPI.createAccount({ name: 'Asset Engine Test', start: 10000, dailyLoss: 100, maxDD: 500, risk: 25 }, 'acc-asset');
core.ConfigAPI.createStrategy({ name: 'T', markets: 'All', sessions: ['London'], setup: 'X', riskPerTrade: '1%', minRR: 1.5, stopRequired: true, behavior: [], evidence: [], tags: [] }, 'strat-asset');
const t1 = core.logTradePipeline({ account_id: 'acc-asset', strategy_id: 'strat-asset', symbol: 'AAPL', dir: 'Long', entry: 150, exit: 155, size: 20, setup: 'X', session: 'London' });
check('pipeline computes stock P&L ($100) + class Stocks', t1.pnl === 100 && t1.assetClass === 'Stocks', JSON.stringify({ pnl: t1.pnl, assetClass: t1.assetClass }));
const t2 = core.logTradePipeline({ account_id: 'acc-asset', strategy_id: 'strat-asset', symbol: 'EURUSD', dir: 'Long', entry: 1.09, exit: 1.092, pnl: 100, setup: 'X', session: 'London' });
check('pipeline derives size from P&L (0.5 lots)', t2.size === 0.5, t2.size);
const t3 = core.logTradePipeline({ account_id: 'acc-asset', strategy_id: 'strat-asset', symbol: 'BTCUSD', dir: 'Long', entry: 60000, exit: 60500, size: 0.5, setup: 'X', session: 'London' });
check('pipeline computes crypto P&L ($250)', t3.pnl === 250, t3.pnl);
check('spec-aware price format (forex 5, index 0, stock 2)', core.fmtPrice('EURUSD', 1.08845) === '1.08845' && core.fmtPrice('NAS100', 21840) === '21840' && core.fmtPrice('AAPL', 150.5) === '150.50');

// ---- summary -----------------------------------------------------------------
console.log('');
if (failures) {
    console.log('RESULT: ' + failures + ' check(s) FAILED');
    process.exit(1);
}
console.log('RESULT: all asset-engine checks passed');
