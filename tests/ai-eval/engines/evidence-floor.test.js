'use strict';

// ============================================================================
// ENGINE TEST: evidence-floor sweep
// ============================================================================
// Tests EVERY engine at these exact trade counts:
//   [0, 1, 2, 3, 5, 8, 9, 10, 20, 50, 100]
//
// At each count, verifies:
//   1. mentorBundle does not throw.
//   2. All finding ev[] arrays contain only ids in core.Trades.
//   3. No finding has ev.length > 8 (evidence cap).
//   4. n < 5  → patterns = 0, psychology.findings = 0, risk.findings = 0.
//   5. n < 8  → tilt[].sev ≠ 'critical'.
//   6. n < 10 → session findings = 0.
//   7. coach.message is always a non-empty string (never crashes).
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('../fixtures/_helpers.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

const COUNTS = [0, 1, 2, 3, 5, 8, 9, 10, 20, 50, 100];

const sessions  = ['London', 'New York', 'Asia', 'London', 'New York'];
const setups    = ['BOS', 'FVG', 'MSS', 'BOS', 'FVG'];
const emotions  = ['Calm', 'FOMO', 'Calm', 'Revenge', 'Calm', 'Frustrated'];
const adherence = ['followed', 'early exit', 'followed', 'moving stop', 'followed', 'no-plan'];

function buildN(n) {
    const trades = generate(n, i => {
        const emo = emotions[i % emotions.length];
        const adh = adherence[i % adherence.length];
        const isGood = emo === 'Calm' && adh === 'followed';
        const risk = 40 + (i % 5) * 15;
        const pnl  = isGood ? risk * 1.3 : -(risk * 0.8);
        return makeTrade({
            id:        'synth-floor-n' + n + '-' + String(i + 1).padStart(4, '0'),
            ts:        daysAgo(Math.floor(i / 3), 9 + (i % 5)),
            symbol:    i % 3 === 0 ? 'GBPUSD' : 'EURUSD',
            session:   sessions[i % sessions.length],
            setup:     setups[i % setups.length],
            emotion:   emo,
            adherence: adh,
            risk:      Math.round(risk),
            pnl:       Math.round(pnl),
            r:         isGood ? 1.3 : -0.8,
            postLoss:  emo === 'Revenge',
            delayMin:  emo === 'Revenge' ? 10 : null
        });
    });
    return buildCoreWithTrades(trades);
}

for (const n of COUNTS) {
    const core   = buildN(n);
    const ACCT   = 'acc-prop';
    const prefix = 'n=' + n;
    let bundle;

    // 1. mentorBundle does not throw
    let crashed = false;
    try { bundle = AI.mentorBundle(core, ACCT, { period: 'all' }); }
    catch (e) { crashed = true; bundle = null; }
    check(prefix + ': mentorBundle does not throw', !crashed, crashed ? 'crashed' : '');

    if (!bundle) continue;   // if null (n=0, no account trades), skip deeper checks

    // 2. All finding evidence ids exist in core.Trades
    const realIds = new Set(core.Trades.map(t => t.id));
    const allFindings = [
        ...bundle.patterns,
        ...bundle.psychology.findings,
        ...bundle.risk.findings,
        ...bundle.discipline.findings,
        ...bundle.sessions.findings,
        ...bundle.tilt
    ];
    const orphans = allFindings.flatMap(f => (f.ev || []).filter(id => !realIds.has(id)));
    check(prefix + ': all evidence ids in core.Trades', orphans.length === 0,
        'orphans: ' + JSON.stringify(orphans.slice(0, 3)));

    // 3. No finding exceeds the evidence cap of 8
    const overCap = allFindings.filter(f => (f.ev || []).length > 8);
    check(prefix + ': no finding ev.length > 8', overCap.length === 0,
        'over: ' + overCap.map(f => f.type).join(','));

    // 4. n < 5 → patterns, psychology.findings, risk.findings all empty
    if (n < 5) {
        check(prefix + ' (<5): patterns = 0',            bundle.patterns.length === 0,               'patterns: ' + bundle.patterns.length);
        check(prefix + ' (<5): psychology.findings = 0', bundle.psychology.findings.length === 0,    'psych: ' + bundle.psychology.findings.length);
        check(prefix + ' (<5): risk.findings = 0',       bundle.risk.findings.length === 0,          'risk: ' + bundle.risk.findings.length);
    }

    // 5. n < 8 → tilt sev ≠ 'critical'
    if (n < 8) {
        check(prefix + ' (<8): tilt NOT critical',
            bundle.tilt.every(t => t.sev !== 'critical'),
            'sev: ' + bundle.tilt.map(t => t.sev).join(','));
    }

    // 6. n < 10 → session findings = 0
    if (n < 10) {
        check(prefix + ' (<10): session findings = 0',
            bundle.sessions.findings.length === 0,
            'ses: ' + bundle.sessions.findings.length);
    }

    // 7. coach message is always a non-empty string
    check(prefix + ': coach.message is non-empty string',
        typeof bundle.coach.message === 'string' && bundle.coach.message.length > 0,
        'msg: ' + (bundle.coach.message || '').slice(0, 40));

    // 8. Anatomy: arrays are arrays, objects are objects
    check(prefix + ': patterns is array',              Array.isArray(bundle.patterns));
    check(prefix + ': psychology.emotionTable array',  Array.isArray(bundle.psychology.emotionTable));
    check(prefix + ': risk.histogram is array',        Array.isArray(bundle.risk.histogram));
    check(prefix + ': sessions.tables is object',      typeof bundle.sessions.tables === 'object');
    check(prefix + ': tilt is array',                  Array.isArray(bundle.tilt));
    check(prefix + ': autopsies is array',             Array.isArray(bundle.autopsies));
}

module.exports = results;
