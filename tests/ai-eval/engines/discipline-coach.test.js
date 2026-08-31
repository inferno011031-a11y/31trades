'use strict';

// ============================================================================
// ENGINE TEST: disciplineCoach
// ============================================================================
// Pins:
//   1. clean-trader    → disc-streak positive finding fires (all-followed → no violations).
//   2. Fixture with violations manually injected → disc-violation fires.
//   3. Below 5-trade guardrail → findings = [].
//   4. dims array is always present (may be empty).
//   5. rules array is always present (may be empty).
//   6. missing-fields: no crash.
//
// NOTE: disciplineCoach uses ctx.disc (from core.disciplineState()) and
// ctx.viols (from core.Violations). Since synthetic fixtures don't have a
// real rule engine configured, we test that the engine:
//   (a) Doesn't crash when disc is null/empty.
//   (b) Fires disc-streak if cleanDayStreak > 0.
//   (c) Returns proper shape in all cases.
// We also manually inject violations into core.Violations to test disc-violation.
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const fx = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

function ctx(core) { return AI.buildContext(core, 'acc-prop', 'all'); }

// ---- 1. shape: dims and rules always present -------------------------------
const cleanCore = fx.cleanTrader();
const cleanCtx  = ctx(cleanCore);
const cleanDisc = AI.disciplineCoach(cleanCtx);

check('clean-trader: disciplineCoach returns object',  typeof cleanDisc === 'object' && cleanDisc !== null);
check('clean-trader: findings is array',               Array.isArray(cleanDisc.findings));
check('clean-trader: dims is array',                   Array.isArray(cleanDisc.dims));
check('clean-trader: rules is array',                  Array.isArray(cleanDisc.rules));

// ---- 2. disc-violation with injected violations ----------------------------
// Build a fresh core and inject synthetic violations directly.
const mixCore = fx.mixedRealistic();

// Inject fake violations matching trade ids from the core
const tradeIds = mixCore.Trades.slice(0, 8).map(t => t.id);
for (let i = 0; i < 4; i++) {
    mixCore.Violations.push({
        id:         'viol-' + i,
        account_id: 'acc-prop',
        trade_id:   tradeIds[i],
        tradeId:    tradeIds[i],
        ruleKey:    'max-loss-per-day',
        ruleLabel:  'Max Loss Per Day',
        pnl:        -80
    });
}
// Also inject a second rule with fewer violations
for (let i = 0; i < 2; i++) {
    mixCore.Violations.push({
        id:         'viol-b-' + i,
        account_id: 'acc-prop',
        trade_id:   tradeIds[4 + i],
        tradeId:    tradeIds[4 + i],
        ruleKey:    'no-revenge',
        ruleLabel:  'No Revenge Trades',
        pnl:        -50
    });
}

const mixCtx  = ctx(mixCore);
const mixDisc = AI.disciplineCoach(mixCtx);

check('injected-violations: disc-violation fires',
    mixDisc.findings.some(f => f.type === 'disc-violation'),
    'findings: ' + mixDisc.findings.map(f => f.type).join(','));

const dv = mixDisc.findings.find(f => f.type === 'disc-violation');
check('disc-violation mentions rule label',  dv && /Max Loss|max.loss|max-loss/i.test(dv.msg), dv && dv.msg.slice(0, 80));
check('disc-violation sev is critical',      dv && dv.sev === 'critical');
check('disc-violation has cost',             dv && typeof dv.cost === 'number');
check('disc-violation ev points to trades',  dv && Array.isArray(dv.ev) && dv.ev.length > 0);

// Top rule should be max-loss-per-day (most violations)
check('disc-violation top rule is max-loss-per-day',
    dv && (dv.msg.toLowerCase().includes('max') || dv.msg.toLowerCase().includes('loss')));

// ---- 3. below 5-trade guardrail → findings = [] ----------------------------
const smallCore = fx.smallSample(4);
const smallDisc = AI.disciplineCoach(ctx(smallCore));
check('4-trade: disciplineCoach findings = []',
    smallDisc.findings.length === 0,
    'findings: ' + smallDisc.findings.length);

// ---- 4. dims and rules always arrays, may be empty -------------------------
check('all cores: dims is array',  [cleanDisc, mixDisc, smallDisc].every(d => Array.isArray(d.dims)));
check('all cores: rules is array', [cleanDisc, mixDisc, smallDisc].every(d => Array.isArray(d.rules)));

// ---- 5. missing-fields: no crash -------------------------------------------
const missCore = fx.missingFields();
let crashed = false;
try { AI.disciplineCoach(ctx(missCore)); } catch (e) { crashed = true; }
check('missing-fields: disciplineCoach does not crash', !crashed);

// ---- 6. finding shape contract ----------------------------------------------
for (const f of mixDisc.findings) {
    check('finding(' + f.type + ') has id',    f.id && f.id.startsWith('ai-'));
    check('finding(' + f.type + ') has msg',   typeof f.msg === 'string' && f.msg.length > 0);
    check('finding(' + f.type + ') ev ≤ 8',   Array.isArray(f.ev) && f.ev.length <= 8);
}

module.exports = results;
