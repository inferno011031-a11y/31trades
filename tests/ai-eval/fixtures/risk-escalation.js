'use strict';

// Fixture: risk-escalation
// 15+ trades. After every loss, the NEXT trade has strictly higher risk than the loss trade.
// Expectation: risk-escalation pattern fires, risk-inconsistent fires (high CV).

const { makeTrade, buildCoreWithTrades, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 18;
    const trades = [];
    let lastPnl = 0;
    let lastRisk = 50;

    for (let i = 0; i < n; i++) {
        // Since we want i to map to chronological order (oldest first),
        // we set ts to (30 - i) days ago. As i increases, (30 - i) decreases,
        // which means the date is closer to today (newer).
        const ts = daysAgo(30 - i, 9);
        const isEscalated = lastPnl < 0;
        const isLoss = i % 3 === 2; // Make every 3rd trade lose (i=2, 5, 8, 11, 14)
        
        // Large difference between normal and escalated risk to ensure CV > 0.45
        const risk = isEscalated ? 200 : 50;
        const pnl = isLoss ? -risk : risk * 1.2;

        trades.push(makeTrade({
            id:        'synth-esc-' + String(i + 1).padStart(3, '0'),
            ts,
            symbol:    'XAUUSD',
            session:   'New York',
            setup:     'MSS',
            emotion:   isEscalated ? 'Revenge' : 'Calm',
            adherence: isEscalated ? 'moving stop' : 'followed',
            risk:      Math.round(risk),
            pnl:       Math.round(pnl),
            r:         isLoss ? -1.0 : 1.2,
            postLoss:  isEscalated,
            delayMin:  isEscalated ? 10 : null
        }));

        lastPnl = pnl;
        lastRisk = risk;
    }

    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
