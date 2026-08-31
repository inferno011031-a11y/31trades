'use strict';

// ============================================================================
// Fixture sanity — verifies all 12 fixtures build without error
// and that they produce in-memory cores with expected trade counts.
// ============================================================================

const fx = require('./fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

// Expected minimum trade counts per fixture
const EXPECTED = [
    { name: 'clean-trader',     fn: fx.cleanTrader,      minN: 20 },
    { name: 'revenge-trader',   fn: fx.revengeTrader,    minN: 20 },
    { name: 'fomo-trader',      fn: fx.fomoTrader,       minN: 20 },
    { name: 'risk-escalation',  fn: fx.riskEscalation,   minN: 15 },
    { name: 'overtrader',       fn: fx.overtrader,       minN: 30 },
    { name: 'weak-setup',       fn: fx.weakSetup,        minN: 20 },
    { name: 'mixed-realistic',  fn: fx.mixedRealistic,   minN: 30 },
    { name: 'small-sample',     fn: fx.smallSample,      minN: 5  },
    { name: 'breakeven-heavy',  fn: fx.breakevenHeavy,   minN: 20 },
    { name: 'all-winners',      fn: fx.allWinners,       minN: 15 },
    { name: 'all-losers',       fn: fx.allLosers,        minN: 15 },
    { name: 'missing-fields',   fn: fx.missingFields,    minN: 15 }
];

for (const spec of EXPECTED) {
    let core, crashed = false;
    try { core = spec.fn(); }
    catch (e) { crashed = true; }

    check(spec.name + ': builds without crash', !crashed, crashed ? 'crashed' : '');

    if (!crashed && core) {
        // Trades were injected
        const n = core.Trades.filter(t => t.account_id === 'acc-prop').length;
        check(spec.name + ': has ≥ ' + spec.minN + ' trades', n >= spec.minN, 'got ' + n);

        // All trade ids are unique
        const ids = core.Trades.map(t => t.id);
        const unique = new Set(ids);
        check(spec.name + ': all trade ids unique', unique.size === ids.length,
            'duplicate ids: ' + ids.length - unique.size);

        // All trade ids start with 'synth-' (never collide with real ledger)
        const nonSynth = ids.filter(id => !String(id).startsWith('synth-'));
        check(spec.name + ': all ids prefixed synth-', nonSynth.length === 0,
            'non-synth: ' + nonSynth.slice(0, 3).join(','));

        // All trades have account_id = 'acc-prop'
        const wrongAccount = core.Trades.filter(t => t.account_id !== 'acc-prop');
        check(spec.name + ': all trades on acc-prop', wrongAccount.length === 0,
            'wrong account: ' + wrongAccount.length);

        // Required fields present on every trade
        const REQUIRED = ['id', 'account_id', 'ts', 'pnl'];
        for (const field of REQUIRED) {
            const missing = core.Trades.filter(t => t[field] == null && spec.name !== 'missing-fields');
            check(spec.name + ': field "' + field + '" present on all trades',
                missing.length === 0 || spec.name === 'missing-fields',
                'missing count: ' + missing.length);
        }

        // ts is parseable ISO date
        const badTs = core.Trades.filter(t => isNaN(new Date(t.ts).getTime()));
        check(spec.name + ': all ts are valid dates', badTs.length === 0,
            'bad ts: ' + badTs.length);
    }
}

// Verify the 'all' export lists 12 fixtures
check('fixtures/index: exports 12 fixtures in .all array', fx.all.length === 12, 'got: ' + fx.all.length);
check('fixtures/index: all entries have name + fn', fx.all.every(f => typeof f.name === 'string' && typeof f.fn === 'function'));

module.exports = results;
