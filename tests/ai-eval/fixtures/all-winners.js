'use strict';

// Fixture: all-winners
// 15+ trades. Every single trade is profitable (pnl > 0, r >= 1.2).
// Expectation: no risk-small-wins, no tilt critical, psych-calm positive.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 16;
    const sessions = ['London', 'New York', 'London', 'Asia'];
    const setups   = ['BOS', 'FVG', 'MSS', 'BOS'];
    const trades = generate(n, i => makeTrade({
        id:        'synth-win-' + String(i + 1).padStart(3, '0'),
        ts:        daysAgo(Math.floor(i / 2), 9),
        symbol:    i % 2 === 0 ? 'EURUSD' : 'GBPUSD',
        session:   sessions[i % sessions.length],
        setup:     setups[i % setups.length],
        emotion:   'Calm',
        adherence: 'followed',
        risk:      50,
        pnl:       60 + (i % 3) * 10,
        r:         1.2 + (i % 3) * 0.2
    }));
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
