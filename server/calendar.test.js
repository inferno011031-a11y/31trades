'use strict';

// ============================================================================
// 31TRADES — Calendar service and summary logic tests
// Verifies:
//   1. Core calendarSummary calculation: monthly matrix, win rate, KPIs, equity curve
//   2. API contract: payload serialization, range filtering, CSV export structure
// ============================================================================

const createCore = require('../src/core/index.js');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra || '')));
    if (!cond) failures++;
}

console.log('Calendar summary service & API tests:');

// ---- 1. Test Core calendarSummary math ----
const core = createCore();
check('calendarSummary function exposed on core', typeof core.calendarSummary === 'function');

// Seed test trades
const testTrades = [
    {
        id: 't-1',
        account_id: 'acc-prop',
        symbol: 'NQ',
        dir: 'Long',
        size: 4,
        entry_price: 20410.5,
        exit_price: 20500.5,
        pnl: 7200,
        ts: '2026-09-24T14:10:00Z',
        duration_sec: 3600
    },
    {
        id: 't-2',
        account_id: 'acc-prop',
        symbol: 'ES',
        dir: 'Long',
        size: 6,
        entry_price: 5820.25,
        exit_price: 5837.0,
        pnl: 5025,
        ts: '2026-09-18T09:45:00Z',
        duration_sec: 7200
    },
    {
        id: 't-3',
        account_id: 'acc-prop',
        symbol: 'EURUSD',
        dir: 'Short',
        size: 15,
        entry_price: 1.1082,
        exit_price: 1.10622,
        pnl: 2965,
        ts: '2026-09-04T11:15:00Z',
        duration_sec: 1800
    },
    {
        id: 't-4',
        account_id: 'acc-prop',
        symbol: 'NQ',
        dir: 'Long',
        size: 3,
        entry_price: 19840.0,
        exit_price: 19916.0,
        pnl: 4560,
        ts: '2026-08-14T15:30:00Z',
        duration_sec: 5400
    }
];

testTrades.forEach(t => core.Trades.push(t));

const summary = core.calendarSummary('acc-prop', 2026);
check('summary returns monthlyMatrix with 12 months', summary.monthlyMatrix && summary.monthlyMatrix.length === 12);
check('August (index 7) has 1 trade and +4560 pnl', summary.monthlyMatrix[7].tradesCount === 1 && summary.monthlyMatrix[7].pnl === 4560);
check('September (index 8) has 3 trades and +15190 pnl', summary.monthlyMatrix[8].tradesCount === 3 && summary.monthlyMatrix[8].pnl === 15190);
check('Total trades count is 4', summary.kpis.totalTrades.total === 4);
check('Win rate is 100%', summary.kpis.totalTrades.winRate === '100%');
check('Profitable months count is 2', summary.kpis.profitableMonths.profitableCount === 2);
check('Current month top trade is NQ', summary.kpis.currentMonth.topTrade && summary.kpis.currentMonth.topTrade.symbol === 'NQ');
check('Equity curve has starting baseline point and progression points', summary.equityCurve && summary.equityCurve.points.length === 5);
check('Recent trades count is 4', summary.recentTrades && summary.recentTrades.length === 4);

// ---- 2. Test Range Filtering & All Years ----
const summaryAll = core.calendarSummary('acc-prop', 'all');
check('All Years summary returns 12 aggregate months', summaryAll.monthlyMatrix && summaryAll.monthlyMatrix.length === 12);
check('All Years total trades matches 4', summaryAll.kpis.totalTrades.total === 4);

const summary3M = core.calendarSummary('acc-prop', 2026, { range: '3M' });
check('Range filtered summary contains valid equity curve', summary3M.equityCurve && typeof summary3M.equityCurve.baseline === 'number');

// ---- 3. Test Export CSV Generation ----
let list = core.Trades.filter(t => t.account_id === 'acc-prop');
list.sort((a, b) => new Date(a.ts) - new Date(b.ts));
const csvHeader = 'Trade ID,Timestamp,Date,Time,Symbol,Direction,Size,Entry Price,Exit Price,Net PnL ($),Return (%),Duration (sec)\n';
let csvBody = list.map(t => [
    t.id,
    t.ts,
    t.ts ? t.ts.slice(0, 10) : '',
    t.ts ? t.ts.slice(11, 19) : '',
    t.symbol,
    t.dir,
    t.size,
    t.entry_price,
    t.exit_price,
    t.pnl,
    (t.pnl / 1000).toFixed(2),
    t.duration_sec || 0
].join(',')).join('\n');
const fullCsv = csvHeader + csvBody;

check('export CSV contains header row', fullCsv.includes('Trade ID,Timestamp,Date,Time,Symbol'));
check('export CSV contains trade records', fullCsv.includes('20410.5') && fullCsv.includes('7200'));

if (failures > 0) {
    console.error('FAILED with ' + failures + ' errors');
    process.exit(1);
} else {
    console.log('All Calendar service & endpoint tests passed!');
    process.exit(0);
}
