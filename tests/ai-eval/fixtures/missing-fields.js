'use strict';

// Fixture: missing-fields
// 15+ trades where optional fields are null / undefined / empty string.
// Tests robustness of engines against real-world sparse data.
// Expectation: no crashes, findings only fire when real evidence exists.

const { makeTrade, buildCoreWithTrades, generate, daysAgo } = require('./_helpers.js');

function buildCore(n) {
    n = n || 18;
    const trades = generate(n, i => {
        const base = makeTrade({
            id:     'synth-miss-' + String(i + 1).padStart(3, '0'),
            ts:     daysAgo(Math.floor(i / 2), 9),
            pnl:    i % 3 === 0 ? -50 : 40,
            r:      i % 3 === 0 ? -1.0 : 0.8
        });
        // Selectively strip optional fields to simulate incomplete journaling
        if (i % 4 === 0) { base.emotion    = null;      }
        if (i % 5 === 0) { base.adherence  = null;      }
        if (i % 3 === 0) { base.session    = null;      }
        if (i % 6 === 0) { base.setup      = null;      }
        if (i % 7 === 0) { base.risk       = undefined; }
        if (i % 8 === 0) { base.note       = null;      }
        if (i % 2 === 0) { base.symbol     = '';        }
        return base;
    });
    return buildCoreWithTrades(trades);
}

module.exports = buildCore;
