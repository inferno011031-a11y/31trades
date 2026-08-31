'use strict';

// Fixture: mixed-realistic
// 30+ trades with a realistic spread of emotions, setups, sessions, pnl.
// Enough data per dimension for session intel tables (>=5 per group).
// Expectation: most engines produce real findings; good for bot ask tests.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 35;
    const sessions  = ['London', 'New York', 'Asia', 'London', 'New York'];
    const setups    = ['BOS', 'FVG', 'MSS', 'BOS', 'FVG'];
    const symbols   = ['EURUSD', 'GBPUSD', 'EURUSD', 'NAS100', 'EURUSD'];
    const emotions  = ['Calm', 'FOMO', 'Calm', 'Revenge', 'Calm', 'Calm', 'Frustrated'];
    const adherence = ['followed', 'early exit', 'followed', 'moving stop', 'followed', 'followed', 'no-plan'];

    const trades = generate(n, i => {
        const emo  = emotions[i % emotions.length];
        const adh  = adherence[i % adherence.length];
        const isGood = emo === 'Calm' && adh === 'followed';
        const risk = 40 + (i % 5) * 15;
        const pnl  = isGood ? risk * 1.3 : -(risk * 0.8 + (i % 3) * 20);
        return makeTrade({
            id:        'synth-mix-' + String(i + 1).padStart(3, '0'),
            ts:        daysAgo(Math.floor(i / 3), 9 + (i % 5)),
            symbol:    symbols[i % symbols.length],
            session:   sessions[i % sessions.length],
            setup:     setups[i % setups.length],
            emotion:   emo,
            adherence: adh,
            risk,
            pnl:       Math.round(pnl),
            r:         isGood ? 1.3 : -0.8,
            postLoss:  emo === 'Revenge',
            delayMin:  emo === 'Revenge' ? 15 : null,
            note:      isGood ? 'Good execution.' : ''
        });
    });
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
