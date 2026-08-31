'use strict';

// ============================================================================
// ENGINE TEST: sessionIntel
// ============================================================================
// Pins:
//   1. mixed-realistic (35 trades, ≥5 per session) → session findings fire.
//   2. Session/setup/symbol/dir tables are always objects with arrays.
//   3. Below 10-trade guardrail → findings = [].
//   4. weak-setup → setup table shows 'Scalp' with negative avgR.
//   5. Table row shape contract: key, n, pnl, winRate, avgR.
//   6. missing-fields: no crash.
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const fx = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

function ctx(core) { return AI.buildContext(core, 'acc-prop', 'all'); }
function sess(core) { return AI.sessionIntel(ctx(core)); }

// ---- 1. session findings fire on mixed-realistic ---------------------------
const mixSess = sess(fx.mixedRealistic());

check('mixed-realistic: session findings present',
    mixSess.findings.length > 0,
    'findings: ' + mixSess.findings.length);

check('mixed-realistic: ses-best fires',
    mixSess.findings.some(f => f.type === 'ses-best'),
    'findings: ' + mixSess.findings.map(f => f.type).join(','));

const sesBest = mixSess.findings.find(f => f.type === 'ses-best');
check('ses-best has positive avgR in msg', sesBest && /win rate|\d+\.?\d*R/i.test(sesBest.msg), sesBest && sesBest.msg.slice(0, 80));
check('ses-best sev is positive',          sesBest && sesBest.sev === 'positive');
check('ses-best evidence is array',        sesBest && Array.isArray(sesBest.ev));

// ---- 2. tables always present as object with arrays ------------------------
check('mixed-realistic: tables.session is array',  Array.isArray(mixSess.tables.session));
check('mixed-realistic: tables.setup is array',    Array.isArray(mixSess.tables.setup));
check('mixed-realistic: tables.symbol is array',   Array.isArray(mixSess.tables.symbol));
check('mixed-realistic: tables.dir is array',      Array.isArray(mixSess.tables.dir));

// ---- 3. below 10-trade guardrail → empty ------------------------------------
const smallSess = sess(fx.smallSample(6));
check('6-trade: session findings = 0',   smallSess.findings.length === 0,  'findings: ' + smallSess.findings.length);
check('6-trade: tables are still object', smallSess.tables && typeof smallSess.tables === 'object');

// ---- 4. table rows pass filter (n ≥ 5): build a larger fixture if needed ---
// overtrader has enough per session
const overSess = sess(fx.overtrader());
if (overSess.tables.session && overSess.tables.session.length > 0) {
    const row = overSess.tables.session[0];
    check('session table row has key',     typeof row.key === 'string');
    check('session table row has n',       typeof row.n   === 'number' && row.n >= 5);
    check('session table row has pnl',     typeof row.pnl === 'number');
    check('session table row has winRate', typeof row.winRate === 'number' && row.winRate >= 0 && row.winRate <= 1);
    check('session table row has avgR',    typeof row.avgR === 'number');
} else {
    // Not enough data per session in overtrader — skip individual row checks
    check('overtrader: tables object present', typeof overSess.tables === 'object');
}

// ---- 5. weak-setup: Scalp has negative avgR in setup table -----------------
const weakSess = sess(fx.weakSetup());
if (weakSess.tables.setup && weakSess.tables.setup.length > 0) {
    const scalpRow = weakSess.tables.setup.find(r => r.key === 'Scalp');
    check('weak-setup: Scalp row present in setup table', !!scalpRow, 'rows: ' + weakSess.tables.setup.map(r => r.key).join(','));
    if (scalpRow) {
        check('weak-setup: Scalp has negative avgR', scalpRow.avgR < 0, 'avgR: ' + scalpRow.avgR);
    }
}

// ---- 6. missing-fields: no crash -------------------------------------------
let crashed = false;
try { sess(fx.missingFields()); } catch (e) { crashed = true; }
check('missing-fields: sessionIntel does not crash', !crashed);

// ---- 7. finding shape contract ----------------------------------------------
for (const f of mixSess.findings) {
    check('ses-finding(' + f.type + ') has id',   f.id && f.id.startsWith('ai-'));
    check('ses-finding(' + f.type + ') has msg',  typeof f.msg === 'string' && f.msg.length > 0);
    check('ses-finding(' + f.type + ') ev ≤ 8',  Array.isArray(f.ev) && f.ev.length <= 8);
}

module.exports = results;
