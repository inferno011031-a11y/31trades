'use strict';

// ============================================================================
// 31TRADES — backtest-analytics tests
// Covers: session classifier (boundaries, AM/PM split, env override),
//         enrichment + legacy derivation, year/month aggregation, drill-down.
// Run: node server/backtest-analytics.test.js
// ============================================================================

const A = require('./backtest-analytics.js');

let pass = 0, fail = 0;
function t(name, cond) {
    if (cond) { pass++; }
    else { fail++; console.error('  ✗ ' + name); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

// ---------------------------------------------------------------------------
// Fixtures — two sessions across years/months, incl. a legacy session whose
// trades carry NO stored session/year/month (must be derived on read).
// ---------------------------------------------------------------------------
function candle(time, o, h, l, c) { return { time, open: o, high: h, low: l, close: c, volume: 100 }; }

// unix seconds for UTC dates — mo is a REAL month number (1–12); helper subtracts 1
const ts = (y, mo, d, h, mi) => Math.floor(Date.UTC(y, mo - 1, d, h, mi || 0, 0) / 1000);

const sessA = { // 2025 — two months, multi-strategy
    id: 'bt_a', userId: 'u1', symbol: 'XAUUSD', timeframe: '15m', strategy: 'Silver Bullet',
    category: 'Metals', startingBalance: 10000, status: 'completed',
    createdAt: '2025-01-01T00:00:00Z', completedAt: '2025-02-20T00:00:00Z',
    balance: 10840, peak: 10900,
    candles: [], startIndex: 0, cursor: 0, position: null,
    trades: [
        { id: 't1', sessionId: 'bt_a', userId: 'u1', symbol: 'XAUUSD', direction: 'Long', entryTime: ts(2025, 1, 15, 14, 30), exitTime: ts(2025, 1, 15, 15, 10), entry: 2700, exit: 2710, sl: 2695, tp: 2715, size: 2, riskAmount: 10, riskPct: 0.1, realizedR: 2.0, pnl: 20, result: 'win', exitReason: 'TP', setup: 'FVG', session: 'New York AM', year: 2025, month: 1, tags: ['london-killzone'] },
        { id: 't2', sessionId: 'bt_a', userId: 'u1', symbol: 'XAUUSD', direction: 'Short', entryTime: ts(2025, 1, 22, 9, 0), exitTime: ts(2025, 1, 22, 9, 45), entry: 2712, exit: 2705, sl: 2717, tp: 2700, size: 1.4, riskAmount: 7, riskPct: 0.07, realizedR: 1.4, pnl: 9.8, result: 'win', exitReason: 'TP', setup: 'Breaker', session: 'London', year: 2025, month: 1, tags: [] },
        { id: 't3', sessionId: 'bt_a', userId: 'u1', symbol: 'XAUUSD', direction: 'Long', entryTime: ts(2025, 2, 5, 17, 20), exitTime: ts(2025, 2, 5, 18, 5), entry: 2730, exit: 2722, sl: 2735, tp: 2745, size: 2, riskAmount: 10, riskPct: 0.1, realizedR: -0.8, pnl: -16, result: 'loss', exitReason: 'SL', setup: 'FVG', session: 'New York PM', year: 2025, month: 2, tags: [] }
    ]
};

const sessB = { // 2024 — legacy session, NO stored session/year/month/tags on trades
    id: 'bt_b', userId: 'u1', symbol: 'EURUSD', timeframe: '1h', strategy: 'Liquidity Sweep',
    category: 'Forex', startingBalance: 5000, status: 'completed',
    createdAt: '2024-03-01T00:00:00Z', completedAt: '2024-03-30T00:00:00Z',
    balance: 5050, peak: 5060,
    candles: [], startIndex: 0, cursor: 0, position: null,
    trades: [
        { id: 't4', sessionId: 'bt_b', userId: 'u1', symbol: 'EURUSD', direction: 'Long', entryTime: ts(2024, 3, 12, 2, 0), exitTime: ts(2024, 3, 12, 3, 0), entry: 1.085, exit: 1.087, sl: 1.084, tp: 1.088, size: 10000, riskAmount: 10, riskPct: 0.2, realizedR: 2.0, pnl: 20, result: 'win', exitReason: 'TP', setup: 'Sweep' },
        { id: 't5', sessionId: 'bt_b', userId: 'u1', symbol: 'EURUSD', direction: 'Short', entryTime: ts(2024, 3, 19, 13, 30), exitTime: ts(2024, 3, 19, 14, 30), entry: 1.09, exit: 1.091, sl: 1.0915, tp: 1.088, size: 10000, riskAmount: 15, riskPct: 0.3, realizedR: -1.0, pnl: -10, result: 'loss', exitReason: 'SL', setup: 'Sweep' }
    ]
};

const sessRunning = { // in-progress — its CLOSED trade feeds analytics in real time
    id: 'bt_c', userId: 'u1', symbol: 'NAS100', timeframe: '5m', strategy: 'Silver Bullet',
    category: 'Indices', startingBalance: 2000, status: 'running',
    createdAt: '2025-03-01T00:00:00Z', completedAt: null,
    candles: [], startIndex: 0, cursor: 3, position: null,
    trades: [
        { id: 't6', sessionId: 'bt_c', userId: 'u1', symbol: 'NAS100', direction: 'Long', entryTime: ts(2025, 3, 5, 14, 0), exitTime: ts(2025, 3, 5, 14, 30), entry: 20000, exit: 20010, sl: 19995, tp: 20020, size: 2, riskAmount: 10, riskPct: 0.5, realizedR: 2.0, pnl: 20, result: 'win', exitReason: 'TP', setup: 'FVG' }
    ]
};

const SESSIONS = [sessA, sessB, sessRunning];

// ---------------------------------------------------------------------------
// 1. Session classifier
// ---------------------------------------------------------------------------
t('classify: 00:30 UTC → Asian', A.classifySession(ts(2025, 6, 2, 0, 30)) === 'Asian');
t('classify: 06:59 UTC → Asian', A.classifySession(ts(2025, 6, 2, 6, 59)) === 'Asian');
t('classify: 07:00 UTC → London (boundary)', A.classifySession(ts(2025, 6, 2, 7, 0)) === 'London');
t('classify: 11:59 UTC → London', A.classifySession(ts(2025, 6, 2, 11, 59)) === 'London');
t('classify: 12:00 UTC → New York AM (boundary)', A.classifySession(ts(2025, 6, 2, 12, 0)) === 'New York AM');
t('classify: 13:30 UTC → New York AM', A.classifySession(ts(2025, 6, 2, 13, 30)) === 'New York AM');
t('classify: 15:59 UTC → New York AM', A.classifySession(ts(2025, 6, 2, 15, 59)) === 'New York AM');
t('classify: 16:00 UTC → New York PM (boundary)', A.classifySession(ts(2025, 6, 2, 16, 0)) === 'New York PM');
t('classify: 20:59 UTC → New York PM', A.classifySession(ts(2025, 6, 2, 20, 59)) === 'New York PM');
t('classify: 21:00 UTC → Sydney (boundary)', A.classifySession(ts(2025, 6, 2, 21, 0)) === 'Sydney');
t('classify: 23:00 UTC → Sydney (no overlap bug)', A.classifySession(ts(2025, 6, 2, 23, 0)) === 'Sydney');
t('classify: ISO string input', A.classifySession('2025-06-02T08:00:00Z') === 'London');
t('classify: ms timestamp input', A.classifySession(ts(2025, 6, 2, 10, 0) * 1000) === 'London');
t('classify: null → —', A.classifySession(null) === '—');

// ---------------------------------------------------------------------------
// 2. Enrichment + legacy derivation
// ---------------------------------------------------------------------------
const enriched = A.collectTrades(SESSIONS);
t('collect: real-time — live-session closed trades included (6 trades)', enriched.length === 6 && enriched.some(x => x.id === 't6'));
t('collect: running session contributes closed trades, no completion gate', (() => {
    const t6 = enriched.find(x => x.id === 't6');
    return t6 && t6.sessionId === 'bt_c' && t6.year === 2025 && t6.month === 3;
})());
const t4 = enriched.find(x => x.id === 't4');
t('legacy: t4 session derived (02:00 UTC → Asian)', t4.session === 'Asian');
t('legacy: t4 year derived (2024)', t4.year === 2024);
t('legacy: t4 month derived (3)', t4.month === 3);
t('legacy: t4 tags defaulted to []', Array.isArray(t4.tags) && t4.tags.length === 0);
t('legacy: strategy inherited from session', t4.strategy === 'Liquidity Sweep');
const scoped = A.collectTrades([{
    id: 'bt-scoped', userId: 'u1', symbol: 'XAUUSD', strategy: 'Scoped replay',
    period: '2025-01', status: 'running', startingBalance: 10000,
    trades: [{ id: 'scoped-trade', entryTime: ts(2024, 12, 31, 23, 55), exitTime: ts(2025, 1, 1, 0, 5),
        symbol: 'XAUUSD', direction: 'Long', entry: 2600, exit: 2610, pnl: 10, realizedR: 1,
        result: 'win', exitReason: 'TP' }]
}]);
t('configured period overrides candle year/month for live session', scoped[0].year === 2025 && scoped[0].month === 1);
const scopedDetail = A.historyMonthDetail([{
    id: 'bt-scoped', userId: 'u1', symbol: 'XAUUSD', strategy: 'Scoped replay',
    period: 'January 2025', status: 'running', startingBalance: 10000,
    trades: [{ id: 'scoped-trade', entryTime: ts(2024, 12, 31, 23, 55), exitTime: ts(2025, 1, 1, 0, 5),
        symbol: 'XAUUSD', direction: 'Long', entry: 2600, exit: 2610, pnl: 10, realizedR: 1,
        result: 'win', exitReason: 'TP' }]
}], 2025, 1);
t('scoped month detail retains entry/exit prices and TP result', scopedDetail.trades[0].entry === 2600 && scopedDetail.trades[0].exit === 2610 && scopedDetail.trades[0].exitReason === 'TP');
const t1 = enriched.find(x => x.id === 't1');
t('stored: t1 session preserved (New York AM)', t1.session === 'New York AM');
t('stored: t1 tags preserved', t1.tags.length === 1 && t1.tags[0] === 'london-killzone');
t('duration: t1 = 40m → 2400s', t1.durationSec === 2400);
t('dow: t1 (2025-01-15) → Wednesday', t1.dow === 'Wednesday');

// ---------------------------------------------------------------------------
// 3. historyYears
// ---------------------------------------------------------------------------
const years = A.historyYears(SESSIONS);
t('years: 2025 before 2024 (desc)', years.years[0].year === 2025 && years.years[1].year === 2024);
const y2025 = years.years[0];
t('years 2025: 4 trades, 2 sessions (incl. live bt_c)', y2025.trades === 4 && y2025.sessions === 2);
t('years 2025: net = 20 + 9.8 - 16 + 20 = 33.8', near(y2025.net, 33.8));
t('years 2025: totalR = 2 + 1.4 - 0.8 + 2 = 4.6', near(y2025.totalR, 4.6));
t('years 2025: months = [1,2,3]', JSON.stringify(y2025.months) === '[1,2,3]');
t('years 2024: 2 trades, 2 months', years.years[1].trades === 2 && JSON.stringify(years.years[1].months) === '[3]');

// ---------------------------------------------------------------------------
// 4. historyMonths
// ---------------------------------------------------------------------------
const months2025 = A.historyMonths(SESSIONS, 2025);
t('months 2025: three cards (Jan, Feb, Mar — Mar live-session)', months2025.months.length === 3);
const jan = months2025.months[0];
t('Jan label', jan.label === 'January 2025');
t('Jan net 29.8, winRate 100, trades 2', near(jan.net, 29.8) && jan.winRate === 100 && jan.trades === 2);
t('Jan bestSession = New York AM (20 > 9.8)', jan.bestSession === 'New York AM');
t('Jan worstSession = London', jan.worstSession === 'London');
const feb = months2025.months[1];
t('Feb net -16, bestSession = New York PM (only group)', near(feb.net, -16) && feb.bestSession === 'New York PM');
t('months 2024: 1 card, March', A.historyMonths(SESSIONS, 2024).months.length === 1);
t('months empty year: []', A.historyMonths(SESSIONS, 2019).months.length === 0);

// ---------------------------------------------------------------------------
// 5. historyMonthDetail
// ---------------------------------------------------------------------------
const det = A.historyMonthDetail(SESSIONS, 2025, 1);
t('detail: card + headline present', det.card && det.headline);
t('detail: headline net 29.8', near(det.headline.net, 29.8));
t('detail: PF = 29.8 / 0 → null (no losses)', det.headline.profitFactor === null);
t('detail: bestTrade is t1 (+20)', det.headline.bestTrade && det.headline.bestTrade.id === 't1');
t('detail: bySession rows have winRate/net/avgR/PF', (() => {
    const ny = det.bySession.find(r => r.key === 'New York AM');
    return ny && ny.trades === 1 && ny.winRate === 100 && near(ny.net, 20) && near(ny.avgR, 2);
})());
t('detail: byStrategy has Silver Bullet (2 trades)', (() => {
    const sb = det.byStrategy.find(r => r.key === 'Silver Bullet');
    return sb && sb.trades === 2;
})());
t('detail: byAsset XAUUSD 2 trades', (() => {
    const x = det.byAsset.find(r => r.key === 'XAUUSD');
    return x && x.trades === 2 && near(x.net, 29.8);
})());
t('detail: byDayOfWeek/byHour/byTag populated', det.byDayOfWeek.length > 0 && det.byHour.length > 0 && det.byTag.length > 0);
t('detail: byRBucket buckets 2R win + 1.4R win', (() => {
    const b2 = det.byRBucket.find(r => r.key === '2R to 3R');
    const b1 = det.byRBucket.find(r => r.key === '1R to 2R');
    return b2 && b2.trades === 1 && b1 && b1.trades === 1;
})());
t('detail: trades[] carries compact trade objects with tags', det.trades.length === 2 && det.trades[0].tags != null);
t('detail: capital = 10000 → returnPct 0.30', near(det.headline.returnPct, 0.30, 0.005));
t('detail: invalid month → error', A.historyMonthDetail(SESSIONS, 2025, 13).error === 'invalid year/month');

// drawdown check on Feb (single -16 trade → maxDD 16)
const detFeb = A.historyMonthDetail(SESSIONS, 2025, 2);
t('Feb maxDrawdown 16', near(detFeb.headline.maxDrawdown, 16));

// ---------------------------------------------------------------------------
// 6. queryTrades (drill-down)
// ---------------------------------------------------------------------------
const q1 = A.queryTrades(SESSIONS, { year: '2025', month: '1' });
t('query: year+month filter → 2 trades, total=2', q1.total === 2 && q1.trades.length === 2);
const q2 = A.queryTrades(SESSIONS, { session: 'New York AM' });
t('query: by session → t1 + t5 + live t6 (NY AM classifies live too)', q2.total === 3 && q2.trades.some(x => x.id === 't1') && q2.trades.some(x => x.id === 't5') && q2.trades.some(x => x.id === 't6'));
const q3 = A.queryTrades(SESSIONS, { strategy: 'Liquidity Sweep' });
t('query: by strategy → 2 legacy trades', q3.total === 2);
const q4 = A.queryTrades(SESSIONS, { symbol: 'XAUUSD', direction: 'Long' });
t('query: symbol+direction AND-combined → 2', q4.total === 2);
const q5 = A.queryTrades(SESSIONS, { tag: 'london-killzone' });
t('query: by tag → t1', q5.total === 1 && q5.trades[0].id === 't1');
const q6 = A.queryTrades(SESSIONS, { result: 'loss' });
t('query: result=loss → t3, t5', q6.total === 2);
const q7 = A.queryTrades(SESSIONS, { limit: '2', offset: '1' });
t('query: pagination limit/offset respected', q7.trades.length === 2 && q7.total === 6);
const q8 = A.queryTrades(SESSIONS, {});
t('query: no filter → all 6, newest first', q8.total === 6);
const q9 = A.queryTrades(SESSIONS, { year: '2025', month: '3' });
t('query: live-session trade filterable mid-run (2025-03 → t6)', q9.total === 1 && q9.trades[0].id === 't6');

// ---------------------------------------------------------------------------
// 7. Env override for session rules
// ---------------------------------------------------------------------------
process.env.TRADEMIND_SESSIONS = JSON.stringify([{ name: 'Custom', start: 8, end: 20 }]);
t('env override: 10:00 UTC → Custom', A.classifySession(ts(2025, 6, 2, 10, 0)) === 'Custom');
t('env override: 07:00 UTC → — (no rule covers)', A.classifySession(ts(2025, 6, 2, 7, 0)) === '—');
delete process.env.TRADEMIND_SESSIONS;
t('env removed: defaults restored', A.classifySession(ts(2025, 6, 2, 10, 0)) === 'London');
t('period parser accepts ISO, named, and legacy month labels',
    A.periodParts('2025-01').month === 1
    && A.periodParts('January 2025').year === 2025
    && A.periodParts('jan2025').month === 1
    && A.periodParts('feb2024').year === 2024);
const tpSession = {
    id: 'bt-tp-period', userId: 'u1', symbol: 'XAUUSD', period: '2025-01', periodLabel: 'January 2025',
    trades: [{ id: 'tp-2025-jan', entryTime: ts(2024, 12, 31, 23, 0), exitTime: ts(2025, 1, 1, 0, 0),
        entry: 2700, exit: 2710, sl: 2695, tp: 2710, pnl: 10, realizedR: 2, result: 'win', exitReason: 'TP' }]
};
const tpDetail = A.historyMonthDetail([tpSession], 2025, 1);
t('selected 2025-Jan TP trade is grouped in 2025-Jan with prices intact',
    tpDetail.headline.trades === 1
    && tpDetail.trades[0].entry === 2700
    && tpDetail.trades[0].exit === 2710
    && tpDetail.trades[0].exitReason === 'TP');

// ---------------------------------------------------------------------------
console.log('\nbacktest-analytics: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
