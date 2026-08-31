'use strict';

// Fixture: revenge-trader
// 20+ trades. After each loss, next trade is marked Revenge + higher risk.
// Expectation: revenge pattern fires, psych-revenge fires, tilt episode detected.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 22;
    const trades = [];
    let lastLoss = false;

    for (let i = 0; i < n; i++) {
        const isRevenge = lastLoss && i % 3 !== 0;   // after a loss, next 1-2 trades are revenge
        const isLoss    = isRevenge || (i % 4 === 0); // revenge trades mostly lose
        const pnl       = isLoss ? -80 : 60;
        const r         = isLoss ? -1.6 : 1.2;
        trades.push(makeTrade({
            id:        'synth-rev-' + String(i + 1).padStart(3, '0'),
            ts:        daysAgo(Math.floor(i / 3), 9 + (i % 3)),
            symbol:    'EURUSD',
            session:   'London',
            setup:     'BOS',
            emotion:   isRevenge ? 'Revenge' : 'Calm',
            adherence: isRevenge ? 'early exit' : 'followed',
            risk:      isRevenge ? 100 : 50,    // doubled risk on revenge
            pnl,
            r,
            postLoss:  isRevenge,
            delayMin:  isRevenge ? 12 : null,
            note:      isRevenge ? 'Re-entered too fast, frustrated' : ''
        }));
        lastLoss = isLoss;
    }
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
