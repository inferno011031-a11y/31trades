'use strict';

// Fixture: fomo-trader
// 20+ trades. Chases moves - FOMO emotion, mostly negative pnl.
// Expectation: fomo pattern fires, psych-fomo fires.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 22;
    const trades = generate(n, i => {
        const isFomo = i % 3 !== 2;   // ~67% FOMO trades
        return makeTrade({
            id:        'synth-fomo-' + String(i + 1).padStart(3, '0'),
            ts:        daysAgo(Math.floor(i / 2), 10 + (i % 4)),
            symbol:    i % 2 === 0 ? 'EURUSD' : 'NAS100',
            session:   i % 2 === 0 ? 'London' : 'New York',
            setup:     'Breakout',
            emotion:   isFomo ? 'FOMO' : 'Calm',
            adherence: isFomo ? 'no-plan' : 'followed',
            risk:      isFomo ? 75 : 40,
            pnl:       isFomo ? -(40 + (i % 3) * 20) : 70,
            r:         isFomo ? -(0.5 + (i % 3) * 0.3) : 1.75,
            note:      isFomo ? 'Chased the move, missed the entry' : ''
        });
    });
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
