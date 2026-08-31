'use strict';

// ============================================================================
// AI-EVAL — Fixture builder helpers
// ----------------------------------------------------------------------------
// Provides a lightweight factory for creating isolated in-memory core
// instances loaded with synthetic trades. All synthetic trade ids are
// prefixed 'synth-' to be unmistakably separate from real ledger ids.
//
// SAFETY: Only touches in-memory arrays. No DB writes, no TradeService.save(),
// no real account mutations. The core created here is TEST-ONLY.
// ============================================================================

global.window = global.window || { SERVER_MODE: true };
// demo-trades.js attaches DemoTrades to global.window — needed by createCore.
try { require('../../../demo-trades.js'); } catch (e) { /* if missing, core still works */ }
const createCore = require('../../../src/core/index.js');

let _seq = 0;
function uid(prefix) {
    return (prefix || 'synth') + '-' + String(++_seq).padStart(4, '0');
}

// Reset the sequence counter (call between fixture builds in the same process
// if you need deterministic ids).
function resetSeq() { _seq = 0; }

// Base trade shape — all canonical fields present with sensible defaults.
function makeTrade(overrides) {
    const base = {
        id:           uid('synth'),
        account_id:   'acc-prop',
        ts:           new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
        symbol:       'EURUSD',
        dir:          'long',
        entry:        1.0850,
        exit:         1.0900,
        size:         0.1,
        risk:         50,
        pnl:          50,
        r:            1.0,
        session:      'London',
        setup:        'BOS',
        emotion:      'Calm',
        adherence:    'followed',
        note:         '',
        postLoss:     false,
        delayMin:     null
    };
    return Object.assign({}, base, overrides);
}

// Build a fresh in-memory core, reset state, inject a test account, and
// push synthetic trades. Returns the core instance.
//
// SAFETY: Only modifies in-memory arrays (Accounts, Trades). No DB calls.
function buildCoreWithTrades(trades) {
    const core = createCore({ demoTrades: global.window && global.window.DemoTrades });
    
    // seedDemoAccount sets up all strategies, rules, assignments, and accounts.
    core.seedDemoAccount(1);
    
    // Clear out the generated trades/violations to keep it isolated to synthetic data.
    core.Trades.length = 0;
    core.Violations.length = 0;

    // Inject synthetic trades into the in-memory Trades table directly.
    trades.forEach(t => core.Trades.push(t));
    return core;
}

// Convenience: generate an array of n trades with a factory fn.
function generate(n, factory) {
    return Array.from({ length: n }, (_, i) => factory(i));
}

// Deterministic timestamp: i days ago, session offset by session name.
function daysAgo(i, offsetHours) {
    const ms = Date.now() - (i + 1) * 86400000 + ((offsetHours || 9) * 3600000);
    return new Date(ms).toISOString();
}

module.exports = { makeTrade, buildCoreWithTrades, generate, daysAgo, uid, resetSeq };
