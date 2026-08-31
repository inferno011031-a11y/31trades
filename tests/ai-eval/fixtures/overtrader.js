'use strict';

// Fixture: overtrader
// 30+ trades across few days — many trades per day (>6/day).
// Mixed emotions and setups but high frequency.
// Expectation: session intel fires (enough per session), no guardrail issues.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 32;
    const sessions = ['London', 'New York', 'London', 'Asia', 'New York'];
    const setups   = ['BOS', 'FVG', 'Breakout', 'MSS', 'Scalp'];
    const emotions = ['Calm', 'FOMO', 'Calm', 'Excited', 'Calm'];
    const trades = generate(n, i => {
        const dayIdx = Math.floor(i / 8);   // ~8 trades per day
        const isWin  = i % 3 !== 0;
        return makeTrade({
            id:        'synth-over-' + String(i + 1).padStart(3, '0'),
            ts:        daysAgo(dayIdx, 8 + (i % 10)),
            symbol:    i % 4 === 0 ? 'GBPUSD' : 'EURUSD',
            session:   sessions[i % sessions.length],
            setup:     setups[i % setups.length],
            emotion:   emotions[i % emotions.length],
            adherence: i % 5 === 0 ? 'early exit' : 'followed',
            risk:      50 + (i % 4) * 10,
            pnl:       isWin ? 45 : -60,
            r:         isWin ? 0.9 : -1.2
        });
    });
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
