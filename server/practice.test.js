'use strict';

// ============================================================================
// 31TRADES — Practice Data Adapter tests
// Verifies that recorded backtest trades flatten into the canonical trade
// shape, flow through the SAME analytics math as live trades (analyticsFrom),
// stay isolated from live records, and produce evidence-backed insights.
// (Fill simulation itself is covered by backtest-sim.test.js — here we inject
// deterministic recorded trades to exercise the adapter + insight gates.)
// ============================================================================

process.env.TRADEMIND_AUTH = 'off';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '31trades-prc-'));
process.env.TRADEMIND_BACKTEST_DATA_DIR = TMP;

const Sim = require('./backtest-sim.js');
const Practice = require('./practice.js');
const createCore = require('../src/core/index.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

function makeCandles(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const close = 100 + 0.2 * i;
        out.push({ time: 1700000000 + i * 3600, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 1000 + i * 10 });
    }
    return out;
}

function seedSession(userId) {
    const s = new Sim.BacktestSession({
        userId, symbol: 'EURUSD', timeframe: '1h', category: 'Forex',
        strategy: 'Breakout', startingBalance: 10000, riskModel: { basis: 'money', perTrade: 25 },
        candles: makeCandles(60), startIndex: 10
    });
    // deterministic recorded trades: 3 wins / 4 losses, one setup dominant,
    // two premature entries, one oversized/inconsistent risk
    const mk = (i, dir, entry, exit, sl, tp, risk, rr, setup, reason, hold) => ({
        id: 'btt_' + i, sessionId: s.id, userId, symbol: 'EURUSD', timeframe: '1h',
        strategy: 'Breakout', category: 'Forex', direction: dir,
        entryTime: 1700000000 + 3600 * (20 + i * 5), exitTime: 1700000000 + 3600 * (20 + i * 5 + hold),
        entryIndex: 20 + i * 5, exitIndex: 20 + i * 5 + hold,
        entry, exit, sl, tp, size: risk / Math.abs(entry - sl),
        riskAmount: risk, riskPct: 0.25, plannedRR: rr, realizedR: Math.round(((dir === 'Long' ? exit - entry : entry - exit) / Math.abs(entry - sl)) * 1000) / 1000,
        pnl: Math.round(((dir === 'Long' ? exit - entry : entry - exit) / Math.abs(entry - sl)) * risk * 100) / 100,
        result: (dir === 'Long' ? exit - entry : entry - exit) > 0 ? 'win' : 'loss',
        exitReason: reason, setup, notes: '', openedAt: new Date().toISOString(), closedAt: new Date().toISOString()
    });
    s.trades = [
        mk(1, 'Long', 105, 107, 104, 107, 25, 2, 'Breakout', 'TP', 8),     // +50
        mk(2, 'Short', 109, 109.6, 109.6, 106, 25, 1.5, 'Breakout', 'SL', 1),  // -25 premature
        mk(3, 'Long', 111, 114, 110, 114, 25, 3, 'Pullback', 'TP', 12),    // +75
        mk(4, 'Short', 113, 113.8, 113.8, 110, 25, 1.5, 'Pullback', 'SL', 1), // -25 premature
        mk(5, 'Long', 116, 118, 115, 118, 25, 2, 'Breakout', 'TP', 5),     // +50
        mk(6, 'Short', 119, 119.5, 119.5, 116, 60, 1.25, 'Fade', 'SL', 3), // -60 inconsistent risk
        mk(7, 'Long', 120, 119.2, 119.2, 124, 25, 1.5, 'Fade', 'SL', 1)    // -25 premature
    ];
    Sim.saveSession(userId, s);
    return s;
}

(async function run() {

const userId = 'u-prac';
seedSession(userId);

// 1 · flatten maps recorded trades into the canonical analytics shape
const flat = Practice.flattenTrades(userId);
ok(flat.length === 7, 'flattens 7 recorded trades');
ok(flat.every(t => t.source === 'BACKTEST' && t.account_id === 'practice'), 'every trade flagged BACKTEST / practice account');
ok(flat.every(t => typeof t.pnl === 'number' && typeof t.r === 'number' && typeof t.risk === 'number'), 'pnl / r / risk carried');
ok(flat.every(t => t.dir === 'Long' || t.dir === 'Short'), 'direction normalized');
ok(flat.every(t => t.session && typeof t.session === 'string'), 'session derived per trade');
ok(flat.every(t => typeof t.ts === 'number'), 'ts is an epoch ms number');
ok(JSON.stringify(flat.map(t => t.holdBars).sort((a, b) => a - b)) === JSON.stringify([1, 1, 1, 3, 5, 8, 12]), 'hold duration carried for pattern detection');

// 2 · analytics runs the SAME canonical math (core.analyticsFrom)
const core = createCore({});
const a = Practice.analytics(userId, core, {});
ok(a.source === 'BACKTEST', 'analytics flagged BACKTEST');
ok(a.n === 7, 'analytics counts 7 practice trades');
ok(a.net === 40, 'net = 175 - 135 = 40 (matches the injected P&L)');
ok(Math.abs(a.winRate - 3 / 7) < 0.001, 'win rate 3/7');
ok(a.bySetup.some(x => x.key === 'Breakout' && x.n === 3), 'setup breakdown groups Breakout = 3');
ok(a.byDirection.some(x => x.key === 'Long' && x.n === 4) && a.byDirection.some(x => x.key === 'Short' && x.n === 3), 'direction breakdown matches');
ok(a.avgRisk > 25 && a.avgRisk < 35, 'avg risk reflects the oversized trade');
const f = Practice.analytics(userId, core, { direction: 'Long' });
ok(f.n === 4 && f.net === 150, 'direction filter isolates the longs');

// 3 · isolation — practice never touches live records
const liveCore = createCore({});
ok(liveCore.Trades.length === 0, 'live core has no trades from practice');
ok(liveCore.analytics('acc-prop', {}).n === 0, 'live analytics sees zero practice trades');

// 4 · insights — evidence-backed, min sample gate
const ins = Practice.insights(userId, core);
ok(ins.length >= 4, 'insights unlocked past the 5-trade gate');
ok(ins.every(f => Array.isArray(f.evidence) && f.evidence.every(id => flat.some(t => t.id === id))), "every finding's evidence references real practice trade ids");
ok(ins.some(f => f.sev === 'positive' && f.type === 'strength' && /Breakout/.test(f.title + ' ' + f.detail)), 'best-setup strength finding fired');
ok(ins.some(f => f.sev === 'negative' && f.type === 'behavior' && /Premature/.test(f.title)), 'premature-entry finding fired (3 trades ≤ 2 bars)');
ok(ins.some(f => f.sev === 'negative' && f.type === 'risk' && /Inconsistent/.test(f.title)), 'inconsistent-risk finding fired (risk CV > 0.35)');
const tooFew = Practice.insights('u-none', core);
ok(tooFew.length === 1 && tooFew[0].type === 'developing', 'insufficient sample returns the developing gate');

// 5 · serializer round trip — flatten after reload matches
const after = Practice.flattenTrades(userId);
ok(after.length === 7 && JSON.stringify(after.map(t => t.id)) === JSON.stringify(flat.map(t => t.id)), 'flatten is stable across reload');

console.log('\n' + (failCount ? 'FAILED: ' + failCount + ' / ' + (okCount + failCount) : 'ALL PASS: ' + okCount + ' checks'));
process.exit(failCount ? 1 : 0);

})().catch(e => { console.error('RUN ERROR: ' + e.message); process.exit(1); });
