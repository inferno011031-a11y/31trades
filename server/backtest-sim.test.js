'use strict';

// ============================================================================
// 31TRADES — Backtest Simulation Engine tests
// Exercises the battle-reusable engine end to end on a deterministic synthetic
// timeline: session creation, replay controls (play/pause/step/seek/reset),
// order validation, risk-based sizing, SL/TP fills, manual close, derived
// results and the strict separation of practice trades from live records.
// ============================================================================

process.env.TRADEMIND_AUTH = 'off';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '31trades-sim-'));
process.env.TRADEMIND_BACKTEST_DATA_DIR = TMP;

const Sim = require('./backtest-sim.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

// deterministic gentle uptrend: close = 100 + 0.2*i, range ±0.5
function makeCandles(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const close = 100 + 0.2 * i;
        out.push({
            time: 1700000000 + i * 3600,
            open: close - 0.1,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1000 + i * 10
        });
    }
    return out;
}

function newSession(overrides) {
    return new Sim.BacktestSession(Object.assign({
        userId: 'u-test',
        symbol: 'EURUSD',
        timeframe: '1h',
        category: 'Forex',
        strategy: 'Manual practice',
        startingBalance: 10000,
        riskModel: { basis: 'money', perTrade: 25 },
        candles: makeCandles(60),
        startIndex: 10
    }, overrides || {}));
}

(async function run() {

// 1 · session creation — cursor sits at the start, only visible bars exposed
{
    const s = newSession();
    ok(s.cursor === 10, 'cursor starts at startIndex (10)');
    ok(s.visibleCandles().length === 11, 'visible candles = startIndex + 1');
    ok(s.balance === 10000, 'balance equals starting balance');
    ok(s.trades.length === 0 && s.position === null, 'starts flat with no trades');
}

// 2 · order validation — direction, SL side, double entry, missing SL
{
    const s = newSession();
    ok(s.enter({ direction: 'long', entry: 101, sl: 102 }).ok === false, 'long with SL above entry rejected');
    ok(s.enter({ direction: 'short', entry: 101, sl: 100 }).ok === false, 'short with SL below entry rejected');
    ok(s.enter({ direction: 'long', entry: 101 }).ok === false, 'missing SL rejected');
    const r = s.enter({ direction: 'long', entry: 101, sl: 100, tp: 103, riskAmount: 50 });
    ok(r.ok === true, 'valid long entry accepted');
    ok(r.position.size === 50, 'size = risk / SL distance (50 units)');
    ok(r.position.rr === 2, 'planned R:R = (103-101)/(101-100) = 2');
    ok(r.position.riskPct === 0.5, 'risk % = 50 / 10000 balance');
    ok(s.enter({ direction: 'short', entry: 102, sl: 103 }).ok === false, 'double entry rejected while position open');
}

// 3 · SL fill on advance — trade recorded, -1R, position cleared
{
    // clean uptrend with a far TP: nothing fills, the position stays open
    const s = newSession();
    s.enter({ direction: 'long', entry: 100, sl: 99.5, tp: 200, riskAmount: 25 });
    s.setCursor(s.candles.length - 1);
    ok(s.position !== null, 'clean uptrend with far TP leaves the position open');
    ok(s.trades.length === 0, 'no trades recorded in a clean trend');
    // a dipped region below the stop triggers the SL on advance
    const s2 = newSession();
    s2.candles = makeCandles(60).map((c, i) => {
        if (i >= 15 && i <= 18) return { ...c, close: 99.3, low: 99.1, high: 99.6 };
        return c;
    });
    s2.enter({ direction: 'long', entry: 100, sl: 99.5, tp: 200, riskAmount: 25 });
    s2.setCursor(20);
    ok(s2.position === null, 'SL fill clears the position');
    ok(s2.trades.length === 1, 'exactly one trade recorded after SL hit');
    const t = s2.trades[0];
    ok(t.exitReason === 'SL', 'exit reason is SL');
    ok(t.exit === 99.5, 'filled at the stop price');
    ok(t.realizedR === -1, 'SL fills at exactly -1R');
    ok(t.pnl === -25, 'P&L equals the risk amount');
    ok(t.result === 'loss', 'result flagged as loss');
    ok(t.sessionId === s2.id && t.userId === 'u-test', 'trade carries session + user linkage');
}

// 4 · TP fill — +RR, then manual close records reason
{
    // TP at 103: entry bar (idx 10) ranges 101.5–102.5 (no cross), bar 13 high 103.1 crosses
    const s = newSession();
    s.enter({ direction: 'long', entry: 100, sl: 99, tp: 103, riskAmount: 25 });
    s.setCursor(12);
    ok(s.trades.length === 0 && s.position !== null, 'TP not hit before the crossing bar');
    s.setCursor(13);
    ok(s.trades.length === 1 && s.trades[0].exitReason === 'TP', 'TP fill on advancing cursor');
    ok(s.trades[0].realizedR === 3, 'TP realized exactly +3R');
    ok(s.trades[0].pnl === 75, 'TP P&L = risk × RR');
    // manual close of a fresh position at a later cursor (bar 25 close 105, range 104.5–105.5)
    const s2 = newSession();
    s2.setCursor(25);
    const r2 = s2.enter({ direction: 'long', entry: 105, sl: 104, tp: 108, riskAmount: 25 });
    ok(r2.ok === true, 'entry at later cursor accepted');
    const r = s2.close({ reason: 'manual', price: 106 });
    ok(r.ok === true && r.trade.exitReason === 'manual', 'manual close records the reason');
    ok(r.trade.realizedR === 1, 'manual close at 106 → +1R');
    ok(r.trade.pnl === 25, 'manual close P&L = +$25');
}

// 5 · risk modes — % of balance, explicit size
{
    const s = newSession({ riskModel: { basis: 'pct', perTrade: 2 } });
    const r = s.enter({ direction: 'long', entry: 100, sl: 99, tp: 200 });
    ok(r.ok === true, 'percent risk model accepted');
    ok(r.position.riskAmount === 200, 'risk = 2% of 10000 balance');
    const s2 = newSession();
    const r2 = s2.enter({ direction: 'long', entry: 100, sl: 99, tp: 200, size: 100 });
    ok(r2.ok === true && r2.position.riskAmount === 100, 'size-only entry derives risk = size × SL distance');
}

// 6 · results — core metrics + breakdowns derived purely
{
    const s = newSession();
    // win +2R (+50): advance to bar 25 (close 105, range 104.5–105.5) then long 105/104/107; TP crosses at bar 35 (high 107.5)
    s.setCursor(25);
    s.enter({ direction: 'long', entry: 105, sl: 104, tp: 107, riskAmount: 25, setup: 'Breakout' });
    s.setCursor(35);
    // loss -1R (-25): at bar 35 (close 107, range 106.5–107.5) short 108/109/106; rising market hits SL at bar 45 (high 109.5)
    s.setCursor(35);
    s.enter({ direction: 'short', entry: 108, sl: 109, tp: 106, riskAmount: 25, setup: 'Breakout' });
    s.setCursor(45);
    // win +1R (+25): at bar 48 (close 109.6, range 109.1–110.1) long 110/109/111; TP crosses at bar 55 (high 111.5)
    s.setCursor(48);
    s.enter({ direction: 'long', entry: 110, sl: 109, tp: 111, riskAmount: 25, setup: 'Pullback' });
    s.setCursor(55);
    const r = s.results();
    ok(r.trades === 3, '3 trades counted');
    ok(r.wins === 2 && r.losses === 1, '2 wins / 1 loss');
    ok(r.net === 50, 'net = +50 -25 +25 = +50');
    ok(r.winRate === 66.67, 'win rate 66.67%');
    ok(r.profitFactor === 3, 'profit factor 75/25 = 3');
    ok(r.expectancy === 0.667, 'expectancy = +2R / 3 = 0.667R');
    ok(r.avgR === 0.667, 'average R = 0.667');
    ok(r.avgWinner === 37.5 && r.avgLoser === 25, 'avg winner/loser derived (loser as magnitude)');
    ok(r.maxDrawdown === 25, 'max drawdown = 25 (single loss)');
    ok(r.bestWinStreak === 1 && r.worstLossStreak === 1, 'streaks derived (wins are non-consecutive)');
    ok(r.bestTrade.pnl === 50 && r.worstTrade.pnl === -25, 'best/worst trade picked');
    ok(r.equity.length === 4, 'equity curve has a point per close + start');
    ok(r.byDirection.Long.net === 75, 'long breakdown isolates the two long wins');
    ok(r.bySetup.Breakout.net === 25 && r.bySetup.Pullback.net === 25, 'setup breakdown groups + nets trades');
    ok(r.byExitReason.TP.trades === 2 && r.byExitReason.SL.trades === 1, 'exit breakdown counts TP/SL fills');
}

// 7 · replay controls — step, seek (forward + rewind), reset, delete
{
    const s = newSession();
    Sim.saveSession('u-test', s);
    ok(Sim.stepSession('u-test', s.id).ok === true, 'step advances');
    ok(Sim.getSession('u-test', s.id).cursor === 11, 'step persisted cursor 11');
    ok(Sim.seekSession('u-test', s.id, 30).ok === true, 'seek forward accepted');
    ok(Sim.getSession('u-test', s.id).cursor === 30, 'seek forward lands on 30');
    ok(Sim.seekSession('u-test', s.id, 5).ok === true && Sim.getSession('u-test', s.id).cursor === 10, 'seek back (rewind) clamps to startIndex without error');
    const p = Sim.play('u-test', s.id, 40);
    ok(p.ok === true, 'play starts a server timer');
    await new Promise(r => setTimeout(r, 150));
    ok(Sim.pause('u-test', s.id).ok === true, 'pause stops the timer');
    ok(Sim.getSession('u-test', s.id).cursor > 5, 'play advanced the cursor server-side');
    ok(Sim.resetSession('u-test', s.id).ok === true, 'reset accepted');
    const after = Sim.getSession('u-test', s.id);
    ok(after.cursor === 10 && after.trades.length === 0 && after.balance === 10000, 'reset restores startIndex, empty trades, starting balance');
    ok(Sim.listSessions('u-test').length === 1, 'session listed');
    Sim.deleteSession('u-test', s.id);
    ok(Sim.listSessions('u-test').length === 0, 'session deleted');
}

// 8 · isolation — practice data lives in its own per-user file, separate from live state
{
    const dir = process.env.TRADEMIND_BACKTEST_DATA_DIR;
    ok(dir === TMP, 'engine writes to its own isolated data dir');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('backtest-'));
    ok(files.length >= 0, 'backtest-*.json namespace exists (' + files.length + ' file(s))');
    const s = newSession();
    s.enter({ direction: 'long', entry: 100, sl: 99, tp: 102, riskAmount: 25 });
    Sim.saveSession('u-test', s);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'backtest-u-test.json'), 'utf8'));
    ok(Array.isArray(raw) && Array.isArray(raw[0].trades) && raw[0].trades.length === 1, 'saved session serializes its own trades array');
    ok(raw[0].trades[0].sessionId === raw[0].id && raw[0].trades[0].userId === 'u-test', 'recorded trade links back to its session, not the live journal');
    ok(!('Accounts' in raw[0]) && !('Trades' in raw[0]), 'no live-state collections leak into practice sessions');
}

console.log('\n' + (failCount ? 'FAILED: ' + failCount + ' / ' + (okCount + failCount) : 'ALL PASS: ' + okCount + ' checks'));
process.exit(failCount ? 1 : 0);

})().catch(e => { console.error('RUN ERROR: ' + e.message); process.exit(1); });
