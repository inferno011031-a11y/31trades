'use strict';

// ============================================================================
// AI-EVAL FIXTURES — index
// ----------------------------------------------------------------------------
// Exports all 12 synthetic trader datasets by name. Each buildCore() returns
// an isolated in-memory createTradeMindCore instance with synthetic trades
// injected directly into core.Trades[]. No DB, no real user accounts.
// ============================================================================

const cleanTrader       = require('./clean-trader.js');
const revengeTrader     = require('./revenge-trader.js');
const fomoTrader        = require('./fomo-trader.js');
const riskEscalation    = require('./risk-escalation.js');
const overtrader        = require('./overtrader.js');
const weakSetup         = require('./weak-setup.js');
const mixedRealistic    = require('./mixed-realistic.js');
const smallSample       = require('./small-sample.js');
const breakevenHeavy    = require('./breakeven-heavy.js');
const allWinners        = require('./all-winners.js');
const allLosers         = require('./all-losers.js');
const missingFields     = require('./missing-fields.js');

module.exports = {
    cleanTrader,
    revengeTrader,
    fomoTrader,
    riskEscalation,
    overtrader,
    weakSetup,
    mixedRealistic,
    smallSample,
    breakevenHeavy,
    allWinners,
    allLosers,
    missingFields,
    all: [
        { name: 'clean-trader',      fn: cleanTrader },
        { name: 'revenge-trader',    fn: revengeTrader },
        { name: 'fomo-trader',       fn: fomoTrader },
        { name: 'risk-escalation',   fn: riskEscalation },
        { name: 'overtrader',        fn: overtrader },
        { name: 'weak-setup',        fn: weakSetup },
        { name: 'mixed-realistic',   fn: mixedRealistic },
        { name: 'small-sample',      fn: smallSample },
        { name: 'breakeven-heavy',   fn: breakevenHeavy },
        { name: 'all-winners',       fn: allWinners },
        { name: 'all-losers',        fn: allLosers },
        { name: 'missing-fields',    fn: missingFields }
    ]
};
