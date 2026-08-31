'use strict';

// Fixture: weak-setup
// 20+ trades. One setup ('Scalp') has consistently negative avgR.
// Other setups are profitable.
// Expectation: session intel fires setup table; worst setup is 'Scalp'.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 24;
    const trades = generate(n, i => {
        const isScalp = i % 4 === 0;   // 25% are the weak setup
        return makeTrade({
            id:        'synth-weak-' + String(i + 1).padStart(3, '0'),
            ts:        daysAgo(Math.floor(i / 2), 9),
            symbol:    i % 2 === 0 ? 'EURUSD' : 'GBPUSD',
            session:   i % 3 === 0 ? 'London' : 'New York',
            setup:     isScalp ? 'Scalp' : (i % 3 === 1 ? 'BOS' : 'FVG'),
            emotion:   isScalp ? 'FOMO' : 'Calm',
            adherence: isScalp ? 'early exit' : 'followed',
            risk:      50,
            pnl:       isScalp ? -70 : 80,
            r:         isScalp ? -1.4 : 1.6
        });
    });
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
