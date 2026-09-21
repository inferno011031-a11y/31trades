'use strict';
const M = require('./mission-100k.js');
let pass = 0, fail = 0;
function ok(v, s) { if (v) pass++; else { fail++; console.error('FAIL', s); } }
const trades = Array.from({ length: 50 }, (_, i) => ({ id: 't' + i, source: 'LIVE', pnl: i === 49 ? 10000 : 10, r: i === 49 ? 2 : 0.2, ts: Date.UTC(2026, 0, i + 1) }));
const out = M.computeMission({ account: { id: 'a1', starting_balance: 10000 }, trades, discipline: { score: 75 }, risk: { breaches: 0 }, backtestTrades: Array.from({ length: 20 }, () => ({ id: 'bt' })) });
ok(out.accountId === 'a1', 'account id');
ok(out.netPnl === 10490, 'net pnl');
ok(out.progressPct === 10.49, 'progress');
ok(out.metrics.liveTrades === 50 && out.metrics.sessionDays === 50, 'metrics');
ok(out.gateStatus.trades50 && out.gateStatus.discipline70 && out.gateStatus.backtestProof, 'gates');
ok(out.rungs.length === 10 && out.rungs[0].reached, 'rungs');
console.log(`mission-100k: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
