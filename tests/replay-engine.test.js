'use strict';

/**
 * BATTLEXJOURNAL — Automated Replay Engine Test Suite
 * ---------------------------------------------------
 * Validates:
 * 1. Replay initialization
 * 2. One-bar advancement
 * 3. Multiple-bar advancement
 * 4. Replay start (play)
 * 5. Replay pause
 * 6. Replay completion
 * 7. Reset
 * 8. Future-candle hiding
 * 9. Deterministic candle ordering and OHLCV data integrity
 * 10. Boundary conditions at first (0) and last candle
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

// Generate realistic mock Gold dataset (100 candles)
function generateMockGoldBars(count = 100) {
    const bars = [];
    let currentPrice = 2040.0;
    const baseTime = 1706745600000; // 2024-02-01 00:00:00 UTC
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

(async function runAllTests() {
    console.log('\n======================================================');
    console.log('  BATTLEXJOURNAL REPLAY ENGINE AUTOMATED TESTS');
    console.log('======================================================\n');

    const mockData = generateMockGoldBars(100);

    // 1. Dataset Loading
    console.log('--- Test Group 1: Dataset Loading ---');
    Replay.loadDataset('XAUUSD_FEB2024', 'XAUUSD', '15m', mockData);
    const snap1 = Replay.getSnapshot();
    assert(snap1.dataset === 'XAUUSD_FEB2024', 'Dataset name recorded correctly');
    assert(snap1.symbol === 'XAUUSD', 'Symbol set to XAUUSD');
    assert(snap1.totalCount === 100, 'Total historical candles count is 100');
    assert(snap1.replayStatus === 'idle', 'Initial status is idle');
    assert(snap1.visibleCount === 100, 'Idle mode exposes all candles initially');

    // 2. Replay Initialization (Cutting at candle index 25)
    console.log('\n--- Test Group 2: Replay Initialization & Future-Candle Hiding ---');
    Replay.init(25);
    const snap2 = Replay.getSnapshot();
    assert(snap2.replayStatus === 'paused', 'Status transitioned to paused');
    assert(snap2.replayStartIndex === 25, 'Replay start index is exactly 25');
    assert(snap2.replayCursorIndex === 25, 'Replay cursor index is exactly 25');
    assert(snap2.visibleCount === 26, 'Visible count matches cursor index + 1 (26 candles)');
    
    // Future candle hiding check
    const lastVisibleBar = Replay.state.visibleCandles[Replay.state.visibleCandles.length - 1];
    const cutBar = Replay.state.historicalCandles[25];
    assert(lastVisibleBar.time === cutBar.time, 'Last visible candle matches exact cut candle timestamp');
    assert(lastVisibleBar.close === cutBar.close, 'Last visible candle OHLCV matches cut candle');
    const futureBars = Replay.state.visibleCandles.filter(b => b.time > cutBar.time);
    assert(futureBars.length === 0, 'Zero future candles leaked after the cursor');

    // Data integrity check
    const integrityCheck = Replay.validateIntegrity();
    assert(integrityCheck.ok === true, 'Data integrity validation passed');

    // 3. One-Bar Advancement (step 1 bar)
    console.log('\n--- Test Group 3: One-Bar Advancement (Step) ---');
    const step1Result = Replay.step();
    assert(step1Result.success === true, 'Step forward returned success');
    assert(Replay.state.replayCursorIndex === 26, 'Replay cursor advanced from 25 to 26');
    assert(Replay.state.visibleCandles.length === 27, 'Visible candles increased by exactly 1');
    const revealedBar1 = Replay.state.visibleCandles[26];
    assert(revealedBar1.time === mockData[26].time, 'Revealed bar timestamp strictly matches mockData[26]');
    assert(revealedBar1.close === mockData[26].close, 'Revealed bar close price matches mockData[26]');

    // 4. Multiple-Bar Advancement (repeated steps)
    console.log('\n--- Test Group 4: Multiple-Bar Advancement ---');
    for (let i = 0; i < 5; i++) {
        Replay.step();
    }
    assert(Replay.state.replayCursorIndex === 31, 'Cursor advanced by 5 steps to index 31');
    assert(Replay.state.visibleCandles.length === 32, 'Visible count is exactly 32');
    assert(Replay.validateIntegrity().ok === true, 'Integrity maintained through multiple steps');

    // 5. Replay Play & Pause (Automated Timer)
    console.log('\n--- Test Group 5: Replay Start (Play) & Pause ---');
    Replay.play(50); // 50ms per bar
    assert(Replay.state.replayStatus === 'playing', 'Replay status changed to playing');
    
    // Allow timer to advance 3-4 bars
    await new Promise(r => setTimeout(r, 220));
    const cursorWhilePlaying = Replay.state.replayCursorIndex;
    assert(cursorWhilePlaying > 31, `Cursor advanced while playing (from 31 to ${cursorWhilePlaying})`);

    // Pause
    Replay.pause();
    assert(Replay.state.replayStatus === 'paused', 'Replay paused');
    const cursorAtPause = Replay.state.replayCursorIndex;
    
    // Wait another 150ms to ensure timer is completely dead
    await new Promise(r => setTimeout(r, 150));
    assert(Replay.state.replayCursorIndex === cursorAtPause, 'Cursor stayed strictly frozen after pause');

    // 6. Reset (Restore start point & re-hide future candles)
    console.log('\n--- Test Group 6: Reset Mechanism ---');
    Replay.reset();
    const snapReset = Replay.getSnapshot();
    assert(snapReset.replayCursorIndex === 25, 'Reset restored cursor to replayStartIndex (25)');
    assert(snapReset.visibleCount === 26, 'Reset rewound visible count back to 26');
    assert(snapReset.replayStatus === 'paused', 'Status after reset is paused');
    const resetIntegrity = Replay.validateIntegrity();
    assert(resetIntegrity.ok === true, 'Integrity check after reset passes');
    const futureBarsAfterReset = Replay.state.visibleCandles.filter(b => b.time > cutBar.time);
    assert(futureBarsAfterReset.length === 0, 'Future candles re-hidden after reset');

    // 7. Reset during active playback
    console.log('\n--- Test Group 7: Reset While Playing ---');
    Replay.play(50);
    await new Promise(r => setTimeout(r, 120));
    assert(Replay.state.replayCursorIndex > 25, 'Cursor moved during play');
    Replay.reset();
    assert(Replay.state.replayStatus === 'paused', 'Reset stopped playback immediately');
    assert(Replay.state.replayCursorIndex === 25, 'Cursor rewound back to 25');

    // 8. Boundary Conditions: First Candle (index 0)
    console.log('\n--- Test Group 8: Boundary Condition at First Candle (Index 0) ---');
    Replay.init(0);
    assert(Replay.state.replayCursorIndex === 0, 'Cursor initialized at index 0');
    assert(Replay.state.visibleCandles.length === 1, 'Visible candles count is 1');
    const stepFromZero = Replay.step();
    assert(stepFromZero.success === true, 'Stepping from index 0 succeeded');
    assert(Replay.state.replayCursorIndex === 1, 'Cursor moved to index 1');

    // 9. Boundary Conditions: Last Candle & Replay Completion
    console.log('\n--- Test Group 9: Boundary Condition at Last Candle & Completion ---');
    Replay.init(98);
    assert(Replay.state.replayCursorIndex === 98, 'Cursor initialized at second-to-last candle (98)');
    const stepToLast = Replay.step();
    assert(stepToLast.success === true, 'Stepped to last candle (99)');
    assert(Replay.state.replayCursorIndex === 99, 'Cursor is now at index 99');
    assert(Replay.state.replayStatus === 'complete', 'Status is marked as complete');
    
    // Attempting to step past the end
    const stepPastEnd = Replay.step();
    assert(stepPastEnd.success === false, 'Cannot step past end of historical data');
    assert(stepPastEnd.reason === 'end_of_data', 'Reason is end_of_data');
    assert(Replay.state.replayCursorIndex === 99, 'Cursor remained at 99');
    assert(Replay.state.visibleCandles.length === 100, 'Visible count remained at 100');

    // 10. Rapid Clicking / Race Condition Resilience
    console.log('\n--- Test Group 10: Rapid Execution & Race Condition Immunity ---');
    Replay.init(10);
    for (let i = 0; i < 20; i++) {
        Replay.step();
    }
    assert(Replay.state.replayCursorIndex === 30, 'Rapid 20 steps reached exactly index 30');
    assert(Replay.state.visibleCandles.length === 31, 'Visible count is exactly 31');
    assert(Replay.validateIntegrity().ok === true, 'No state corruption under rapid calls');

    console.log('\n======================================================');
    console.log(`  REPLAY TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('======================================================\n');

    if (failCount > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
