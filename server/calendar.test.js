'use strict';

const createCore = require('../src/core/index.js');
const http = require('http');

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

// ---- 2. HTTP Endpoint test: /api/calendar/summary ----
http.get('http://localhost:8080/api/calendar/summary?accountId=acc-prop&year=2026', res => {
    check('/api/calendar/summary returns 200', res.statusCode === 200, 'got ' + res.statusCode);
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        try {
            const j = JSON.parse(d);
            check('summary payload has monthlyMatrix', Array.isArray(j.monthlyMatrix) && j.monthlyMatrix.length === 12);
            check('summary payload has equityCurve', j.equityCurve && typeof j.equityCurve.baseline === 'number');
            check('summary payload has kpis', j.kpis && j.kpis.ytdReturn);
        } catch (err) {
            check('parse summary json', false, err.message);
        }

        // ---- 3. HTTP Endpoint test: /api/calendar/export ----
        http.get('http://localhost:8080/api/calendar/export?accountId=acc-prop&year=2026&format=csv', res2 => {
            check('/api/calendar/export returns 200', res2.statusCode === 200, 'got ' + res2.statusCode);
            check('export Content-Type is text/csv', String(res2.headers['content-type']).includes('text/csv'));
            check('export Content-Disposition has attachment', String(res2.headers['content-disposition']).includes('attachment'));
            let d2 = '';
            res2.on('data', c => d2 += c);
            res2.on('end', () => {
                check('export CSV includes header row', d2.includes('Trade ID,Timestamp,Date,Time,Symbol'));
                if (failures > 0) {
                    console.error('FAILED with ' + failures + ' errors');
                    process.exit(1);
                } else {
                    console.log('All Calendar service & endpoint tests passed!');
                    process.exit(0);
                }
            });
        });
    });
}).on('error', err => {
    check('http connection to server', false, err.message);
    process.exit(1);
});
