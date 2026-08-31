'use strict';

// ============================================================================
// ENGINE TEST: mentor-bundle shape + context metrics
// ============================================================================
// Pins:
//   1. mentorBundle returns a fully-shaped object on a real fixture.
//   2. All required top-level keys present.
//   3. context metrics are numbers (not NaN, not undefined).
//   4. autopsies are arrays of objects with required keys.
//   5. Returns null for unknown accountId (no crash).
// ============================================================================

const AI    = require('../../../server/ai-mentor.js');
const fx    = require('../fixtures/index.js');

const results = [];

function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

// ---- 1. Bundle shape from mixed-realistic fixture ---------------------------
const core   = fx.mixedRealistic();
const ACCT   = 'acc-prop';
const bundle = AI.mentorBundle(core, ACCT, { period: 'all' });

check('bundle is not null',          bundle !== null,                              'mentorBundle returned null');
check('bundle.accountId present',    bundle && bundle.accountId === ACCT);
check('bundle.period present',       bundle && typeof bundle.period === 'string');
check('bundle.generatedAt present',  bundle && typeof bundle.generatedAt === 'string');

// Required top-level keys
const REQUIRED_KEYS = ['account', 'context', 'coach', 'patterns', 'psychology', 'risk', 'discipline', 'sessions', 'tilt', 'autopsies'];
for (const k of REQUIRED_KEYS) {
    check('bundle has key: ' + k, bundle && k in bundle, 'missing key: ' + k);
}

// ---- 2. context metrics are numbers ----------------------------------------
const ctx = bundle && bundle.context;
check('context.tradeCount is number',  ctx && typeof ctx.tradeCount  === 'number' && !isNaN(ctx.tradeCount));
check('context.netPnl is number',      ctx && typeof ctx.netPnl      === 'number' && !isNaN(ctx.netPnl));
check('context.winRate is number',     ctx && typeof ctx.winRate     === 'number' && !isNaN(ctx.winRate));
check('context.expectancy is number',  ctx && typeof ctx.expectancy  === 'number' && !isNaN(ctx.expectancy));
check('context.maxDD is number',       ctx && typeof ctx.maxDD       === 'number' && !isNaN(ctx.maxDD));
check('context.violations is number',  ctx && typeof ctx.violations  === 'number');
check('context.cleanStreak is number', ctx && typeof ctx.cleanStreak === 'number');

// ---- 3. coach message is a non-empty string --------------------------------
check('coach.message is non-empty string', bundle && typeof bundle.coach.message === 'string' && bundle.coach.message.length > 0);
check('coach.patterns is array',           bundle && Array.isArray(bundle.coach.patterns));
check('coach.strengths is array',          bundle && Array.isArray(bundle.coach.strengths));

// ---- 4. sub-section shapes -------------------------------------------------
check('patterns is array',              bundle && Array.isArray(bundle.patterns));
check('psychology.findings is array',   bundle && Array.isArray(bundle.psychology.findings));
check('psychology.emotionTable is array', bundle && Array.isArray(bundle.psychology.emotionTable));
check('risk.findings is array',         bundle && Array.isArray(bundle.risk.findings));
check('risk.histogram is array',        bundle && Array.isArray(bundle.risk.histogram));
check('discipline.findings is array',   bundle && Array.isArray(bundle.discipline.findings));
check('sessions.findings is array',     bundle && Array.isArray(bundle.sessions.findings));
check('sessions.tables is object',      bundle && typeof bundle.sessions.tables === 'object');
check('tilt is array',                  bundle && Array.isArray(bundle.tilt));

// ---- 5. autopsies ----------------------------------------------------------
check('autopsies is array',             bundle && Array.isArray(bundle.autopsies));
if (bundle && bundle.autopsies.length > 0) {
    const ap = bundle.autopsies[0];
    check('autopsy has tradeId',  ap && ap.tradeId != null);
    check('autopsy has symbol',   ap && 'symbol' in ap);
    check('autopsy has pnl',      ap && typeof ap.pnl === 'number');
    check('autopsy has verdict',  ap && typeof ap.verdict === 'string');
}

// ---- 6. unknown account → null (no crash) ----------------------------------
const nullBundle = AI.mentorBundle(core, 'acc-does-not-exist', { period: 'all' });
check('unknown accountId → null', nullBundle === null);

// ---- 7. all-winners edge case ----------------------------------------------
const coreWin  = fx.allWinners();
const bWin     = AI.mentorBundle(coreWin, ACCT, { period: 'all' });
check('all-winners bundle not null',   bWin !== null);
check('all-winners context.winRate 100%', bWin && bWin.context.winRate === 100);

// ---- 8. missing-fields fixture — no crash ----------------------------------
const coreMiss = fx.missingFields();
let crashed = false;
try { AI.mentorBundle(coreMiss, ACCT, { period: 'all' }); } catch (e) { crashed = true; }
check('missing-fields fixture: no crash', !crashed);

module.exports = results;
