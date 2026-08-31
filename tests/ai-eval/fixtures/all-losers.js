'use strict';

// Fixture: all-losers
// 15+ trades. Every single trade is a loss (pnl < 0). Risk escalates.
// Expectation: risk-escalation pattern, risk-recovery, tilt episodes.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 16;
    const trades = generate(n, i => makeTrade({
        id:        'synth-lose-' + String(i + 1).padStart(3, '0'),
        ts:        daysAgo(Math.floor(i / 2), 9),
        symbol:    'EURUSD',
        session:   i % 2 === 0 ? 'London' : 'New York',
        setup:     'BOS',
        emotion:   i % 3 === 0 ? 'Revenge' : 'Frustrated',
        adherence: i % 4 === 0 ? 'moving stop' : 'early exit',
        risk:      50 + i * 5,     // escalating risk each trade
        pnl:       -(60 + i * 4),  // increasing losses
        r:         -(1.2 + i * 0.05),
        postLoss:  i > 0,
        delayMin:  i > 0 ? 10 : null
    }));
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
