'use strict';

/**
 * BATTLEXJOURNAL — Automated Replay Run Strategy Test Suite
 * -----------------------------------------------------------
 * Validates:
 * 1. Strategy execution with zero lookahead (only visible candles evaluated)
 * 2. Deterministic execution: identical results at same cursor
 * 3. Advancement sensitivity: advancing 1 bar updates visible slice and evaluation
 * 4. Signal payload integrity (entry, SL, TP, riskReward, pattern, explanation)
 * 5. Multi-strategy support (London FVG, Opening Range Breakout, Asia Order Block)
 * 6. Rapid click / repeated execution resilience (no state corruption)
 * 7. Reset mechanism: strategy runs cleanly after replay reset
 * 8. Boundary conditions: strategy evaluation at start (0) and end of data
 */

const Replay = require('../replay-engine.js');

let passCount = 0;
let failCount = 0;

function assert(condition, testName) {
    if (condition) {
        passCount++;
        console.log(`  PASS: ${testName}`);
    } else {
        failCount++;
        console.error(`  FAIL: ${testName}`);
    }
}

// Generate realistic mock Gold dataset (100 candles) with known patterns
function generateMockGoldBars(count = 100) {
    const bars = [];
    let currentPrice = 2040.0;
    const baseTime = 1706745600000; // 2024-01.51 00:00:00 UTC
    const intervalMs = 15 * 60 * 1000; // 15 minutes

    for (let i = 0; i < count; i++) {
        const time = baseTime + (i * intervalMs);
        const change = (i % 2 === 0 ? 1 : -1) * (0.5 + (i % 5) * 0.25);
        const open = Number(currentPrice.toFixed(2));
        const close = Number((currentPrice + change).toFixed(2));
        const high = Number((Math.max(open, close) + 0.8).toFixed(2));
        const low = Number((Math.min(open, close) - 0.8).toFixed(2));
        const volume = 1000 + (i * 10);
        bars.push({ time, open, high, low, close, volume });
        currentPrice = close;
    }
    return bars;
}

(async function runStrategyTests() {
    console.log('\n======================================================');
    console.log('  BATTLEXJOURNAL RUN STRATEGY AUTOMATED TESTS');
    console.log('======================================================\n');

    const mockData = generateMockGoldBars(100);

    // Setup a known Bullish FVG at index 20, 21, 22
    // C0 (index 20): high = 2040.00
    // C1 (index 21): large bullish impulse candle
    // C2 (index 22): low = 2042.50 (> C0.high) -> Bullish FVG gap of 2.50
    mockData[20] = { time: 1706745600000 + 20 * 900000, open: 2038.00, high: 2040.00, low: 2037.00, close: 2039.50, volume: 1500 };
    mockData[21] = { time: 1706745600000 + 21 * 900000, open: 2039.50, high: 2048.00, low: 2039.00, close: 2047.00, volume: 4500 };
    mockData[22] = { time: 1706745600000 + 22 * 900000, open: 2047.00, high: 2050.00, low: 2042.50, close: 2049.00, volume: 1.50 };

    Replay.loadDataset('XAUUSD_TEST', 'XAUUSD', '15m', mockData);

    // --- TEST GROUP 1: Lookahead-Free Evaluation ---
    console.log('--- Test Group 1: Lookahead-Free Replay Evaluation ---');
    Replay.init(22); // Replay cut right at the Bullish FVG bar
    const visibleBars = Replay.getVisibleCandles();
    assert(visibleBars.length === 23, 'Visible candles count is strictly 23 (index 0..22)');

    const stratRes = Replay.runStrategy({ strategyId: 'strat-lfvg', strategyName: 'London FVG' });
    assert(stratRes.ok === true, 'Strategy executed successfully');
    assert(stratRes.cursorIndex === 22, 'Strategy evaluated exactly at cursor 22');
    assert(stratRes.visibleCount === 23, 'Strategy used strictly 23 visible candles');
    assert(stratRes.evaluatedCandle.time === mockData[22].time, 'Evaluated candle time matches bar 22');
    assert(stratRes.signal === 'BUY', 'Detected Bullish FVG BUY signal on bar 22');
    assert(stratRes.pattern === 'Bullish FVG', 'Pattern correctly identified as Bullish FVG');
    assert(stratRes.entryPrice === mockData[22].close, 'Entry price matches visible close price');
    assert(stratRes.slPrice < stratRes.entryPrice, 'Stop Loss is placed below Entry for BUY');
    assert(stratRes.tpPrice > stratRes.entryPrice, 'Take Profit is placed above Entry for BUY');
    assert(stratRes.riskReward === 1.5, 'Default risk reward ratio is 1:1.5');

    // Future bars inspection
    const futureTimes = mockData.slice(23).map(b => b.time);
    assert(stratRes.evaluatedCandle.time < futureTimes[0], 'Evaluated candle strictly precedes any future candles');

    // --- TEST GROUP 2: Deterministic Results at Same Cursor ---
    console.log('\n--- Test Group 2: Deterministic Execution ---');
    const run1 = Replay.runStrategy({ strategyId: 'strat-lfvg' });
    const run2 = Replay.runStrategy({ strategyId: 'strat-lfvg' });
    const run3 = Replay.runStrategy({ strategyId: 'strat-lfvg' });

    assert(run1.signal === run2.signal && run2.signal === run3.signal, 'Signals across 3 runs are strictly identical');
    assert(run1.entryPrice === run2.entryPrice && run2.entryPrice === run3.entryPrice, 'Entry prices across runs are identical');
    assert(run1.slPrice === run2.slPrice && run1.tpPrice === run2.tpPrice, 'SL and TP levels across runs are identical');

    // --- TEST GROUP 3: Step Forward & Dynamic Evaluation ---
    console.log('\n--- Test Group 3: Step Forward & Dynamic Re-Evaluation ---');
    Replay.step(); // Step to index 23
    assert(Replay.state.replayCursorIndex === 23, 'Cursor advanced to 23');
    assert(Replay.getVisibleCandles().length === 24, 'Visible bars increased to 24');

    const stepRes = Replay.runStrategy({ strategyId: 'strat-lfvg' });
    assert(stepRes.cursorIndex === 23, 'New evaluation occurs at cursor 23');
    assert(stepRes.visibleCount === 24, 'New evaluation uses 24 bars');
    assert(stepRes.evaluatedCandle.time === mockData[23].time, 'Evaluated candle is now bar 23');

    // --- TEST GROUP 4: Strategy Variations ---
    console.log('\n--- Test Group 4: Strategy Variations (ORB & Asia OB) ---');
    const orbRes = Replay.runStrategy({ strategyId: 'strat-orob', strategyName: 'Opening Range Breakout' });
    assert(orbRes.ok === true, 'Opening Range Breakout evaluated successfully');
    assert(orbRes.strategy === 'Opening Range Breakout', 'Strategy title set correctly');

    const aobRes = Replay.runStrategy({ strategyId: 'strat-aob', strategyName: 'Asia Order Block' });
    assert(aobRes.ok === true, 'Asia Order Block evaluated successfully');
    assert(aobRes.strategy === 'Asia Order Block', 'Strategy title set correctly');

    // --- TEST GROUP 5: Reset Mechanism ---
    console.log('\n--- Test Group 5: Replay Reset & Clean Re-run ---');
    Replay.reset();
    assert(Replay.state.replayCursorIndex === 22, 'Reset returned cursor to start index 22');
    const resetRes = Replay.runStrategy({ strategyId: 'strat-lfvg' });
    assert(resetRes.cursorIndex === 22, 'Evaluation at reset cursor matches start index 22');
    assert(resetRes.signal === 'BUY', 'Re-evaluation gives identical BUY signal as initial run');

    // --- TEST GROUP 6: Boundary Conditions (Index 0 & End of Data) ---
    console.log('\n--- Test Group 6: Boundary Conditions ---');
    Replay.init(0); // Index 0 (only 1 bar visible)
    const zeroRes = Replay.runStrategy();
    assert(zeroRes.ok === true, 'Evaluation at bar 0 handled gracefully without error');
    assert(zeroRes.signal === null, 'No signal possible with insufficient bar history (<3 bars)');
    assert(zeroRes.visibleCount === 1, 'Visible count is exactly 1 at index 0');

    Replay.init(99); // End of data
    const endRes = Replay.runStrategy();
    assert(endRes.ok === true, 'Evaluation at last bar handled cleanly');
    assert(endRes.visibleCount === 100, 'Visible count is 100 at end of data');

    // --- TEST GROUP 7: Rapid Button Click Resilience ---
    console.log('\n--- Test Group 7: Rapid Execution Resilience ---');
    let noErrors = true;
    for (let i = 0; i < 50; i++) {
        try {
            const r = Replay.runStrategy();
            if (!r || !r.ok) noErrors = false;
        } catch (e) {
            noErrors = false;
        }
    }
    assert(noErrors === true, '50 consecutive rapid calls executed without error or corruption');

    console.log('\n======================================================');
    console.log(`  RUN STRATEGY TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('======================================================\n');

    if (failCount > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
