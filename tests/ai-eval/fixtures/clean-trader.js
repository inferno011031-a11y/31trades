'use strict';

// Fixture: clean-trader
// 20+ trades. All Calm emotion, followed plan, consistent risk, positive R.
// Expectation: NO critical patterns. psych-calm positive finding fires.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 22;
    const sessions = ['London', 'New York', 'London', 'Asia'];
    const setups   = ['BOS', 'FVG', 'BOS', 'MSS'];
    const trades = generate(n, i => makeTrade({
        id:        'synth-clean-' + String(i + 1).padStart(3, '0'),
        ts:        daysAgo(Math.floor(i / 2), 9),
        symbol:    i % 3 === 0 ? 'GBPUSD' : 'EURUSD',
        session:   sessions[i % sessions.length],
        setup:     setups[i % setups.length],
        emotion:   'Calm',
        adherence: 'followed',
        risk:      50,
        pnl:       i % 5 === 0 ? -30 : 60,   // ~80% win rate
        r:         i % 5 === 0 ? -0.6 : 1.2,
        note:      'Plan followed, waited for confirmation.'
    }));
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
