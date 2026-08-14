'use strict';

// ============================================================================
// 31TRADES — AI Mentor service tests (no database required)
// ----------------------------------------------------------------------------
// The mentor must be grounded in the REAL canonical ledger — every finding
// carries evidence (trade ids), and sample-size guardrails suppress findings
// below their minimum evidence. These tests pin:
//   1. Bundle shape + context metrics from seeded real data.
//   2. Pattern/psychology/risk/discipline/session/tilt findings fire with
//      evidence + counts on the seeded demo ledger.
//   3. Guardrails: zero/small samples produce NO manufactured findings.
//   4. ai_findings cache round-trip (file fallback path — no DB in tests):
//      save → load, setPref suppress → mentorWithPrefs filters the finding.
//
// Run:  node server/ai-mentor.test.js
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const AI = require('./ai-mentor.js');

global.window = { SERVER_MODE: true };
require('../demo-trades.js');
const createCore = require('../src/core/index.js');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra || '')));
    if (!cond) failures++;
}

// ---- 1. bundle from the seeded demo ledger ---------------------------------
const demo = createCore({ demoTrades: global.window.DemoTrades });
demo.seedDemoAccount(117);          // ~30 trades across asset classes
const ACCOUNT = demo.Accounts[0].id;

const bundle = AI.mentorBundle(demo, ACCOUNT, { period: 'all' });

check('bundle returned', !!bundle, 'mentorBundle returned null');
check('context metrics present', bundle && typeof bundle.context.netPnl === 'number' && bundle.context.tradeCount > 0,
    'context.tradeCount=' + (bundle && bundle.context.tradeCount));
check('coach message present', bundle && typeof bundle.coach.message === 'string' && bundle.coach.message.length > 0);
check('autopsies present', bundle && Array.isArray(bundle.autopsies) && bundle.autopsies.length > 0,
    'autopsies.length=' + (bundle && bundle.autopsies.length));

// ---- 2. findings carry evidence + real counts -------------------------------
const all = bundle ? [
    ...bundle.patterns, ...bundle.psychology.findings, ...bundle.risk.findings,
    ...bundle.discipline.findings, ...bundle.sessions.findings, ...bundle.tilt
] : [];
check('findings exist on a real ledger', all.length >= 3, 'found ' + all.length);
check('every finding has an id', all.every(f => f.id && f.id.indexOf('ai-') === 0));
check('every finding has a message', all.every(f => typeof f.msg === 'string' && f.msg.length > 0));
check('every finding has evidence (trade ids)', all.every(f => Array.isArray(f.ev)),
    'finding without evidence: ' + (all.find(f => !Array.isArray(f.ev)) || {}).id);
check('every finding has a count', all.every(f => typeof f.count === 'number'));
check('no finding exceeds evidence cap of 8', all.every(f => f.ev.length <= 8));

// Findings must reference REAL trades from the ledger (grounding contract).
const realIds = new Set(demo.Trades.map(t => t.id));
check('all evidence ids exist in the ledger', all.every(f => f.ev.every(id => realIds.has(id))),
    'orphan evidence: ' + JSON.stringify(all.flatMap(f => f.ev.filter(id => !realIds.has(id))).slice(0, 3)));

// ---- 3. guardrails — zero / small samples -----------------------------------
const fresh = createCore({ demoTrades: global.window.DemoTrades });
fresh.reseed();                      // first-user state: zero trades
const emptyBundle = AI.mentorBundle(fresh, 'acc-prop', { period: 'all' });
check('zero-account bundle is null', emptyBundle === null,
    'expected null for unknown account, got ' + (emptyBundle && emptyBundle.accountId));

// Each capability has its OWN sample-size guardrail (the design contract):
// patterns ≥5, psychology ≥5, sessions ≥10, tilt ≥8. A 6-trade sample must
// not manufacture pattern/session/tilt findings.
const tiny = createCore({ demoTrades: global.window.DemoTrades });
tiny.seedDemoAccount(6);             // 6 trades
const tctx = AI.buildContext(tiny, tiny.Accounts[0].id, 'all');
check('patterns need ≥5 trades', AI.detectPatterns(tctx).length === 0, 'fired: ' + AI.detectPatterns(tctx).map(f => f.type).join(','));
check('psychology needs ≥5 trades', AI.psychologyAnalysis(tctx).findings.length === 0);
check('session intel needs ≥10 trades', AI.sessionIntel(tctx).findings.length === 0);
check('tilt needs ≥8 trades', AI.tiltAnalysis(tctx).length === 0);

// The empty first-user state must not crash and must not manufacture findings.
const tinyBundle = AI.mentorBundle(tiny, tiny.Accounts[0].id, { period: 'all' });
check('tiny sample still yields a coach message', tinyBundle && tinyBundle.coach.message.indexOf('sample is still small') !== -1,
    'coach message: ' + (tinyBundle && tinyBundle.coach.message));

// ---- 4. ai_findings cache round-trip (file fallback — no pool in tests) ----
const tmpDir = path.join(require('node:os').tmpdir(), 'ai-mentor-test-' + process.pid);
process.env.TRADEMIND_AI_DATA_DIR = tmpDir;   // isolated data dir
const fileFor = id => path.join(tmpDir, 'ai-' + id + '.json');

// saveFindings then loadPrefs must round-trip.
(async () => {
    const userId = 'test-user-1';
    const sample = all.slice(0, 3).map(f => ({
        id: f.id, type: f.type, sev: f.sev, title: f.title, msg: f.msg, ev: f.ev, cost: f.cost, confidence: f.confidence
    }));
    await AI.saveFindings(userId, sample);
    const prefs = await AI.loadPrefs(userId);
    check('save → load round-trips findings', sample.every(f => prefs[f.id]),
        'missing after round-trip: ' + sample.filter(f => !prefs[f.id]).map(f => f.id).join(','));
    check('round-trip defaults suppressed=false', sample.every(f => prefs[f.id].suppressed === false));

    // setPref suppress → mentorWithPrefs hides the finding from the bundle.
    const target = sample[0].id;
    await AI.setPref(userId, target, { suppressed: true });
    const withPrefs = await AI.mentorWithPrefs(demo, ACCOUNT, { period: 'all', userId });
    const visible = withPrefs ? [
        ...withPrefs.patterns, ...withPrefs.psychology.findings, ...withPrefs.risk.findings,
        ...withPrefs.discipline.findings, ...withPrefs.sessions.findings, ...withPrefs.tilt
    ] : [];
    check('suppressed finding is hidden from the bundle', !visible.some(f => f.id === target),
        'still visible: ' + target);
    const prefs2 = await AI.loadPrefs(userId);
    check('suppressed persisted', prefs2[target] && prefs2[target].suppressed === true);

    // feedback round-trip.
    await AI.setPref(userId, target, { feedback: -1 });
    const prefs3 = await AI.loadPrefs(userId);
    check('feedback persisted', prefs3[target] && prefs3[target].feedback === -1);

    // unsuppress → visible again.
    await AI.setPref(userId, target, { suppressed: false });
    const withPrefs2 = await AI.mentorWithPrefs(demo, ACCOUNT, { period: 'all', userId });
    const visible2 = withPrefs2 ? [
        ...withPrefs2.patterns, ...withPrefs2.psychology.findings, ...withPrefs2.risk.findings,
        ...withPrefs2.discipline.findings, ...withPrefs2.sessions.findings, ...withPrefs2.tilt
    ] : [];
    check('unsuppressed finding is visible again', visible2.some(f => f.id === target));

    // ---- 5. tilt analysis is deterministic + episode-baselined --------------
    const tilt = AI.tiltAnalysis(AI.buildContext(demo, ACCOUNT, 'all'));
    check('tilt analysis returns array', Array.isArray(tilt));
    if (tilt.length) {
        check('tilt finding has cost', typeof tilt[0].cost === 'number');
        check('tilt finding has evidence', tilt[0].ev.length > 0);
        check('tilt evidence references real trades', tilt[0].ev.every(id => realIds.has(id)));
    }

    // cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL AI MENTOR CHECKS PASS');
    process.exit(failures ? 1 : 0);
})().catch(err => {
    console.error('test harness error: ' + err.stack);
    process.exit(1);
});
