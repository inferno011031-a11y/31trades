'use strict';

// ============================================================================
// 31TRADES — AI Backtest Coach tests
// Reviews recorded practice sessions through evidence-gated heuristics:
// premature entries, weak setups, inconsistent risk, oversizing, stop-heavy
// exits, revenge behavior, strong conditions. Every finding must reference
// real trade ids and only exist when the data shows them.
// ============================================================================

process.env.TRADEMIND_AUTH = 'off';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '31trades-coach-'));
process.env.TRADEMIND_BACKTEST_DATA_DIR = TMP;

const Sim = require('./backtest-sim.js');
const Coach = require('./ai-coach.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

function sessionWith(trades) {
    const s = new Sim.BacktestSession({
        userId: 'u', symbol: 'EURUSD', timeframe: '1h', category: 'Forex',
        strategy: 'Breakout', startingBalance: 10000, riskModel: { basis: 'money', perTrade: 25 },
        candles: [{ time: 1, open: 1, high: 2, low: 0, close: 1 }], startIndex: 0
    });
    s.trades = trades;
    return s;
}
const mk = (i, dir, entry, exit, sl, risk, rr, setup, reason, hold, entryIdx) => {
    const entryIndex = entryIdx != null ? entryIdx : 10 + i * 5;
    const sign = dir === 'Long' ? 1 : -1;
    const dist = Math.abs(entry - sl);
    return {
        id: 't' + i, sessionId: 's', userId: 'u', symbol: 'EURUSD', timeframe: '1h',
        strategy: 'Breakout', category: 'Forex', direction: dir,
        entryTime: 1700000000 + 3600 * entryIndex, exitTime: 1700000000 + 3600 * (entryIndex + hold),
        entryIndex, exitIndex: entryIndex + hold,
        entry, exit, sl, tp: entry + sign * dist * rr, size: risk / dist,
        riskAmount: risk, riskPct: 0.25, plannedRR: rr,
        realizedR: Math.round(((dir === 'Long' ? exit - entry : entry - exit) / dist) * 1000) / 1000,
        pnl: Math.round(((dir === 'Long' ? exit - entry : entry - exit) / dist) * risk * 100) / 100,
        result: (dir === 'Long' ? exit - entry : entry - exit) > 0 ? 'win' : 'loss',
        exitReason: reason, setup, notes: '', openedAt: new Date().toISOString(), closedAt: new Date().toISOString()
    };
};

(async function run() {

// 1 · no trades → clean message, no findings
{
    const r = Coach.coach(sessionWith([]));
    ok(r.ok === true && r.findings.length === 0 && r.summary.trades === 0, 'empty session: ok with zero findings');
    ok(Coach.coach(null).ok === false, 'null session rejected');
}

// 2 · a rich bad session triggers every negative heuristic
{
    const trades = [
        mk(1, 'Long', 105, 107, 104, 25, 2, 'Breakout', 'TP', 8, 20),      // +50 good
        mk(2, 'Short', 109, 109.6, 109.6, 25, 1.5, 'Breakout', 'SL', 1, 30), // -25 premature
        mk(3, 'Long', 111, 111.4, 110, 25, 2, 'Pullback', 'SL', 1, 32),     // -25 premature + enters 1 bar after t2's loss → revenge
        mk(4, 'Short', 113, 113.8, 113.8, 60, 1.5, 'Breakout', 'SL', 1, 40),// -60 premature + inconsistent
        mk(5, 'Long', 116, 118, 115, 25, 2, 'Breakout', 'TP', 6, 42),       // +50 + enters 1 bar after t4's loss → revenge
        mk(6, 'Short', 119, 119.5, 119.5, 120, 1.25, 'Pullback', 'SL', 1, 50), // -120 premature + oversized (riskPct noted)
        mk(7, 'Long', 120, 120.5, 119, 25, 2, 'Fade', 'SL', 2, 55)          // +12.5 wait: long 120→120.5 = +0.5R → +12.5
    ];
    // force an oversized trade (riskPct > 1)
    trades[5].riskPct = 1.2;
    const r = Coach.coach(sessionWith(trades));
    ok(r.ok === true && r.summary.trades === 7, '7 trades summarized');
    const types = r.findings.map(f => f.type);
    ok(types.includes('premature-entry'), 'premature-entry finding fires (' + (trades.filter(t => (t.exitIndex - t.entryIndex) <= 2).length) + ' trades ≤ 2 bars)');
    ok(types.includes('risk-inconsistency'), 'risk-inconsistency fires (risk CV across 25/25/60/120)');
    ok(types.includes('oversizing'), 'oversizing fires (1.2% of balance)');
    ok(types.includes('stop-dominant'), 'stop-dominant fires (5 of 7 exits are SL)');
    ok(types.includes('revenge'), 'revenge fires (entries within 1 bar of a loss)');
    ok(r.findings.every(f => Array.isArray(f.evidence) && f.evidence.every(id => trades.some(t => t.id === id))), 'every finding evidences real trade ids');
    const winRate = trades.filter(t => t.pnl > 0).length / trades.length;
    ok(Math.abs(r.summary.winRate - winRate * 100) < 0.01, 'summary win rate matches');
}

// 3 · a clean session → no warnings, only strengths
{
    const trades = [
        mk(1, 'Long', 105, 107, 104, 25, 2, 'Breakout', 'TP', 8, 20),
        mk(2, 'Long', 110, 113, 109, 25, 3, 'Breakout', 'TP', 12, 30),
        mk(3, 'Long', 116, 118, 115, 25, 2, 'Breakout', 'TP', 6, 45),
        mk(4, 'Long', 120, 123, 119, 25, 3, 'Breakout', 'TP', 10, 55)
    ];
    const r = Coach.coach(sessionWith(trades));
    ok(!r.findings.some(f => f.sev === 'warning'), 'no warnings on a clean session');
    ok(r.findings.some(f => f.sev === 'positive' && f.type === 'strength'), 'strength finding (strong setup) fires');
}

// 4 · evidence gates — single trade never triggers pattern findings
{
    const r = Coach.coach(sessionWith([mk(1, 'Long', 105, 107, 104, 25, 2, 'Breakout', 'TP', 8, 20)]));
    ok(r.findings.length === 0, 'one trade triggers nothing (gates hold)');
}

console.log('\n' + (failCount ? 'FAILED: ' + failCount + ' / ' + (okCount + failCount) : 'ALL PASS: ' + okCount + ' checks'));
process.exit(failCount ? 1 : 0);

})().catch(e => { console.error('RUN ERROR: ' + e.message); process.exit(1); });
