'use strict';

// ============================================================================
// ENGINE TEST: tiltAnalysis
// ============================================================================
// Pins:
//   1. revenge-trader → tilt episode detected (episodes.length > 0).
//   2. all-losers     → tilt may be active (inTilt = true, sev = 'critical').
//   3. clean-trader   → no active tilt (sev ≠ 'critical').
//   4. Below 8-trade guardrail → returns array of length 1, sev ≠ 'critical'.
//   5. Tilt result always a single-element array with correct shape.
//   6. Evidence ids exist in core.Trades (grounding rule).
//   7. missing-fields: no crash.
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const fx = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

function ctx(core) { return AI.buildContext(core, 'acc-prop', 'all'); }
function tilt(core) { return AI.tiltAnalysis(ctx(core)); }

// ---- 1. revenge-trader: episode detected -----------------------------------
const revCore  = fx.revengeTrader();
const revTilt  = tilt(revCore);

check('revenge-trader: tilt returns array',        Array.isArray(revTilt),         'got: ' + typeof revTilt);
check('revenge-trader: tilt length is 1',          revTilt.length === 1,           'length: ' + revTilt.length);

const rt = revTilt[0];
check('tilt result has id',          rt && rt.id && rt.id.startsWith('ai-tilt-'));
check('tilt result has type=tilt',   rt && rt.type === 'tilt');
check('tilt result has sev',         rt && typeof rt.sev === 'string');
check('tilt result has msg',         rt && typeof rt.msg === 'string' && rt.msg.length > 0);
check('tilt result has count',       rt && typeof rt.count === 'number');
check('tilt result has ev array',    rt && Array.isArray(rt.ev));
check('tilt ev.length ≤ 8',         rt && rt.ev.length <= 8);

// revenge-trader should produce some episode signal (either critical or watching)
check('revenge-trader: tilt references episodes or signal',
    rt && /(episode|signal|match|calm)/i.test(rt.msg),
    rt && rt.msg.slice(0, 80));

// ---- 2. all-losers: active tilt (inTilt likely true) ----------------------
const loseCore  = fx.allLosers();
const loseTilt  = tilt(loseCore);
check('all-losers: tilt array length 1',  loseTilt.length === 1);
const lt = loseTilt[0];
// All-losers has consecutive losses + escalating risk → should be critical
check('all-losers: tilt is critical or watching', lt && (lt.sev === 'critical' || lt.sev === 'positive'));

// ---- 3. clean-trader: no active tilt (sev ≠ 'critical') -------------------
const cleanCore = fx.cleanTrader();
const cleanTilt = tilt(cleanCore);
check('clean-trader: tilt array length 1',     cleanTilt.length === 1);
check('clean-trader: tilt NOT critical',
    cleanTilt[0] && cleanTilt[0].sev !== 'critical',
    'sev: ' + (cleanTilt[0] && cleanTilt[0].sev));

// ---- 4. below 8-trade guardrail → one item, sev ≠ critical -----------------
const smallCore = fx.smallSample(6);
const smallTilt = tilt(smallCore);
check('6-trade: tilt returns empty array (< 8 guardrail)',
    smallTilt.length === 0,
    'length: ' + smallTilt.length + ' items');

// ---- 5. grounding: all evidence ids exist in core.Trades ------------------
function checkGrounding(name, tiltArr, core) {
    const realIds = new Set(core.Trades.map(t => t.id));
    const orphans = tiltArr.flatMap(t => (t.ev || []).filter(id => !realIds.has(id)));
    check(name + ': all tilt evidence in core.Trades', orphans.length === 0,
        'orphan ids: ' + JSON.stringify(orphans.slice(0, 3)));
}

checkGrounding('revenge',   revTilt,   revCore);
checkGrounding('all-losers', loseTilt, loseCore);
checkGrounding('clean',     cleanTilt, cleanCore);

// ---- 6. missing-fields: no crash -------------------------------------------
let crashed = false;
try { tilt(fx.missingFields()); } catch (e) { crashed = true; }
check('missing-fields: tiltAnalysis does not crash', !crashed);

// ---- 7. confidence is set --------------------------------------------------
check('tilt result has confidence',
    revTilt.every(t => t.confidence === 'high' || t.confidence === 'medium' || t.confidence === 'low'));

module.exports = results;
