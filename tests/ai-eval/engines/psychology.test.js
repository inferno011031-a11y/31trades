'use strict';

// ============================================================================
// ENGINE TEST: psychologyAnalysis
// ============================================================================
// Pins:
//   1. revenge-trader  → psych-revenge finding fires with real cost.
//   2. fomo-trader     → psych-fomo finding fires (negative pnl).
//   3. clean-trader    → psych-calm positive finding fires.
//   4. emotionTable always present (even below 5-trade guardrail).
//   5. Below 5-trade guardrail → findings array is empty.
//   6. missing-fields  → no crash, emotionTable handles null emotion gracefully.
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const fx = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

function ctx(core) { return AI.buildContext(core, 'acc-prop', 'all'); }

// ---- 1. psych-revenge ------------------------------------------------------
const revCore  = fx.revengeTrader();
const revPsych = AI.psychologyAnalysis(ctx(revCore));

check('revenge-trader: psych-revenge fires',
    revPsych.findings.some(f => f.type === 'psych-revenge'),
    'findings: ' + revPsych.findings.map(f => f.type).join(','));

const rp = revPsych.findings.find(f => f.type === 'psych-revenge');
check('psych-revenge has cost (number)',   rp && typeof rp.cost === 'number');
check('psych-revenge has evidence',        rp && Array.isArray(rp.ev) && rp.ev.length > 0);
check('psych-revenge sev is critical',     rp && rp.sev === 'critical');

// ---- 2. psych-fomo ---------------------------------------------------------
const fomoCore  = fx.fomoTrader();
const fomoPsych = AI.psychologyAnalysis(ctx(fomoCore));

check('fomo-trader: psych-fomo fires',
    fomoPsych.findings.some(f => f.type === 'psych-fomo'),
    'findings: ' + fomoPsych.findings.map(f => f.type).join(','));

// ---- 3. psych-calm ---------------------------------------------------------
const cleanCore  = fx.cleanTrader();
const cleanPsych = AI.psychologyAnalysis(ctx(cleanCore));

check('clean-trader: psych-calm fires',
    cleanPsych.findings.some(f => f.type === 'psych-calm'),
    'findings: ' + cleanPsych.findings.map(f => f.type).join(','));

const cp = cleanPsych.findings.find(f => f.type === 'psych-calm');
check('psych-calm sev is positive',   cp && cp.sev === 'positive');
check('psych-calm has positive cost or null', cp && (cp.cost === null || cp.cost > 0));

// ---- 4. emotionTable always present ----------------------------------------
check('revenge emotionTable present',  Array.isArray(revPsych.emotionTable));
check('fomo emotionTable present',     Array.isArray(fomoPsych.emotionTable));
check('clean emotionTable present',    Array.isArray(cleanPsych.emotionTable));

// emotionTable should have entries matching known emotions in fixture
const revEmoTable = revPsych.emotionTable;
check('revenge emotionTable has Revenge entry',
    revEmoTable.some(e => e.key === 'Revenge'),
    'keys: ' + revEmoTable.map(e => e.key).join(','));

// ---- 5. below 5-trade guardrail → empty findings ---------------------------
const smallCore  = fx.smallSample(4);
const smallPsych = AI.psychologyAnalysis(ctx(smallCore));
check('4-trade sample: psychology findings = 0',
    smallPsych.findings.length === 0,
    'findings: ' + smallPsych.findings.length);
check('4-trade sample: emotionTable still present',
    Array.isArray(smallPsych.emotionTable));

// ---- 6. missing-fields: no crash -------------------------------------------
const missCore = fx.missingFields();
let crashed = false;
try {
    const mp = AI.psychologyAnalysis(ctx(missCore));
    check('missing-fields: emotionTable present', Array.isArray(mp.emotionTable));
} catch (e) {
    crashed = true;
}
check('missing-fields: psychologyAnalysis does not crash', !crashed);

// ---- 7. emotionTable row shape contract ------------------------------------
if (revEmoTable.length > 0) {
    const row = revEmoTable[0];
    check('emotionTable row has key',     'key'     in row);
    check('emotionTable row has n',       'n'       in row && typeof row.n === 'number');
    check('emotionTable row has pnl',     'pnl'     in row && typeof row.pnl === 'number');
    check('emotionTable row has winRate', 'winRate' in row);
    check('emotionTable row has avgR',    'avgR'    in row);
}

module.exports = results;
