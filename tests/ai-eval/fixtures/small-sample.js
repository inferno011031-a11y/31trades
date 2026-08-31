'use strict';

// Fixture: small-sample
// Only 6 trades — below most guardrail thresholds.
// Expectation: patterns=0, psychology.findings=0, session.findings=0, tilt no critical.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 6;
    const trades = generate(n, i => makeTrade({
        id:        'synth-small-' + String(i + 1).padStart(3, '0'),
        ts:        daysAgo(i, 9),
        symbol:    'EURUSD',
        session:   'London',
        setup:     'BOS',
        emotion:   i % 2 === 0 ? 'Calm' : 'Revenge',
        adherence: 'followed',
        risk:      50,
        pnl:       i % 2 === 0 ? 60 : -40,
        r:         i % 2 === 0 ? 1.2 : -0.8
    }));
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
