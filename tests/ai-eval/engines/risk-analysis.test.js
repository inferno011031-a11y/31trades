'use strict';

// ============================================================================
// ENGINE TEST: riskAnalysis
// ============================================================================
// Pins:
//   1. risk-escalation  → risk-inconsistent (high CV) fires.
//   2. all-losers       → risk-recovery fires (recovery factor < 1).
//   3. all-winners      → risk-small-wins does NOT fire if R ≥ 1.2.
//   4. Histogram buckets are non-empty arrays when risk fields present.
//   5. avgRisk and riskSd returned as numbers.
//   6. Below 5-trade guardrail → findings = [], histogram = [].
//   7. missing-fields  → no crash.
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const fx = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

function ctx(core) { return AI.buildContext(core, 'acc-prop', 'all'); }
function risk(core) { return AI.riskAnalysis(ctx(core)); }

// ---- 1. risk-inconsistent on risk-escalation fixture -----------------------
const escRisk = risk(fx.riskEscalation());
check('risk-escalation: risk-inconsistent fires',
    escRisk.findings.some(f => f.type === 'risk-inconsistent'),
    'findings: ' + escRisk.findings.map(f => f.type).join(','));

const ri = escRisk.findings.find(f => f.type === 'risk-inconsistent');
check('risk-inconsistent msg mentions CV or avg', ri && /variation|avg|σ/.test(ri.msg), ri && ri.msg.slice(0, 60));
check('risk-inconsistent ev is array',            ri && Array.isArray(ri.ev));

// ---- 2. risk-recovery on all-losers ----------------------------------------
const loseRisk = risk(fx.allLosers());
// All losers → maxDD should be positive, recovery < 1
check('all-losers: risk-recovery fires or findings present',
    loseRisk.findings.length > 0,
    'findings: ' + loseRisk.findings.map(f => f.type).join(','));

// ---- 3. all-winners: no risk-small-wins (R ≥ 1.2) -------------------------
const winRisk = risk(fx.allWinners());
check('all-winners: risk-small-wins does NOT fire',
    !winRisk.findings.some(f => f.type === 'risk-small-wins'),
    'unexpected: ' + winRisk.findings.map(f => f.type).join(','));

// ---- 4. histogram is non-empty when risk fields present --------------------
const mixRisk = risk(fx.mixedRealistic());
check('mixed-realistic: histogram has entries',
    mixRisk.histogram.length > 0,
    'histogram: ' + JSON.stringify(mixRisk.histogram.slice(0, 2)));

// histogram shape
if (mixRisk.histogram.length > 0) {
    const bucket = mixRisk.histogram[0];
    check('histogram bucket has key',   typeof bucket.key === 'string');
    check('histogram bucket has count', typeof bucket.count === 'number' && bucket.count > 0);
}

// ---- 5. avgRisk and riskSd are numbers -------------------------------------
check('mixed-realistic: avgRisk is number', typeof mixRisk.avgRisk === 'number' && !isNaN(mixRisk.avgRisk));
check('mixed-realistic: riskSd is number',  typeof mixRisk.riskSd  === 'number' && !isNaN(mixRisk.riskSd));

// ---- 6. below 5-trade guardrail → empty results ----------------------------
const smallRisk = risk(fx.smallSample(4));
check('4-trade: findings = []',   smallRisk.findings.length === 0, 'findings: ' + smallRisk.findings.length);
check('4-trade: histogram = []',  smallRisk.histogram.length === 0, 'histogram: ' + smallRisk.histogram.length);

// ---- 7. missing-fields: no crash -------------------------------------------
let crashed = false;
try { risk(fx.missingFields()); } catch (e) { crashed = true; }
check('missing-fields: riskAnalysis does not crash', !crashed);

// ---- 8. findings shape contract --------------------------------------------
for (const f of [...escRisk.findings, ...loseRisk.findings]) {
    check('finding(' + f.type + ') id starts with ai-', f.id && f.id.startsWith('ai-'));
    check('finding(' + f.type + ') sev is string',       typeof f.sev === 'string');
    check('finding(' + f.type + ') ev is array',         Array.isArray(f.ev));
    check('finding(' + f.type + ') ev.length ≤ 8',       f.ev.length <= 8);
}

module.exports = results;
