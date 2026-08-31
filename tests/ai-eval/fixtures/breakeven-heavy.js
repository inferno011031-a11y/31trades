'use strict';

// Fixture: breakeven-heavy
// 20+ trades, most pnl=0 and r=0. A few wins/losses to avoid pure flat.
// Expectation: findings fire only for real patterns (no data-free manufacturing).

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 22;
    const trades = generate(n, i => {
        const kind = i % 5;
        // 0,1,2,3 → breakeven. 4 → win or loss alternating.
        const pnl = kind === 4 ? (i % 8 === 4 ? 80 : -60) : 0;
        const r   = kind === 4 ? (i % 8 === 4 ? 1.6 : -1.2) : 0;
        return makeTrade({
            id:        'synth-be-' + String(i + 1).padStart(3, '0'),
            ts:        daysAgo(Math.floor(i / 2), 9),
            symbol:    'EURUSD',
            session:   i % 2 === 0 ? 'London' : 'New York',
            setup:     'BOS',
            emotion:   'Calm',
            adherence: 'followed',
            risk:      50,
            pnl,
            r
        });
    });
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
