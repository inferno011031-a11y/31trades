'use strict';
const E = require('./evidence.js');
let pass = 0, fail = 0;
function ok(v, s) { if (v) pass++; else { fail++; console.error('FAIL', s); } }
const trade = { evidence: [] };
ok(E.normalizeEvidence({ kind: 'screenshot', url: 'https://storage.example/trade.png' }).ok, 'https URL accepted');
ok(!E.normalizeEvidence({ url: 'javascript:alert(1)' }).ok, 'javascript URL rejected');
const first = E.attachToTrade(trade, { kind: 'chart', url: 'https://storage.example/chart.png', label: 'Replay' });
ok(first.ok && first.evidence.length === 1, 'attachment added');
trade.evidence = first.evidence;
const duplicate = E.attachToTrade(trade, { kind: 'chart', url: 'https://storage.example/chart.png' });
ok(duplicate.duplicate, 'duplicate rejected idempotently');
console.log(`evidence: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
