const assert = require('assert');
const createReplayEngine = require('../replay-engine.js');

function createMockCandles(count = 50) {
    const baseTime = 1707696000000; // 2024-02-12 00:00:00 UTC
    const candles = [];
    let price = 2020.50;

    for (let i = 0; i < count; i++) {
        const time = baseTime + (i * 900 * 1000); // 15m intervals
        const open = price;
        const high = price + 1.25;
        const low = price - 0.75;
        const close = price + 0.50;
        price = close;
        candles.push({ time, open, high, low, close, volume: 100 + i });
    }
    return candles;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;

function it(desc, fn) {
    return (async () => {
        try {
            await fn();
            console.log('  PASS: ' + desc);
            passed++;
        } catch (err) {
            console.error('  FAIL: ' + desc);
            console.error('    ' + err.message);
            failed++;
        }
    })();
}

async function runTests() {
    console.log('======================================================');
    console.log('  BATTLEXJOURNAL REPLAY PLAYBACK AUTOMATED TESTS');
    console.log('======================================================\n');

    const candles = createMockCandles(100);

    console.log('--- Test Group 1: Play Progression (Advancing Candles) ---');
    const engine1 = createReplayEngine;
    engine1.loadDataset('XAUUSD_MOCK', 'XAUUSD', '15m', candles);
    engine1.init(5); // Start index 5, visible count 6

    await it('Initial state verified at start index 5', () => {
        assert.strictEqual(engine1.state.replayStartIndex, 5);
        assert.strictEqual(engine1.state.replayCursorIndex, 5);
        assert.strictEqual(engine1.state.visibleCandles.length, 6);
        assert.strictEqual(engine1.state.replayStatus, 'paused');
    });

    const stepEvents = [];
    const unsubscribe1 = engine1.subscribe((snapshot, eventType, detail) => {
        if (eventType === 'step') {
            stepEvents.push({ snapshot, detail });
        }
    });

    await it('Play advances candles across timer intervals (5 -> 6 -> 7 -> 8 -> 9)', async () => {
        engine1.play(40); // 40ms interval
        assert.strictEqual(engine1.state.replayStatus, 'playing');

        // Wait for ~180ms to allow ~4 steps
        await sleep(180);

        assert(engine1.state.replayCursorIndex >= 8, 'Expected cursor >= 8, got ' + engine1.state.replayCursorIndex);
        assert.strictEqual(engine1.state.visibleCandles.length, engine1.state.replayCursorIndex + 1);
        assert(stepEvents.length >= 3, 'Expected at least 3 step events, got ' + stepEvents.length);

        // Verify each step event contained correct bar and progression
        for (let i = 0; i < stepEvents.length; i++) {
            const ev = stepEvents[i];
            assert(ev.detail.newBar, 'Step event must include newBar');
            assert.strictEqual(ev.detail.cursor, ev.snapshot.replayCursorIndex);
            assert.strictEqual(ev.detail.newBar.time, candles[ev.detail.cursor].time);
        }
    });

    unsubscribe1();

    console.log('\n--- Test Group 2: Pause Freezes Replay without State Loss ---');
    let frozenCursor = null;
    await it('Pause freezes replay on current candle', async () => {
        engine1.pause();
        assert.strictEqual(engine1.state.replayStatus, 'paused');
        frozenCursor = engine1.state.replayCursorIndex;
        const frozenVisible = engine1.state.visibleCandles.length;

        // Wait 100ms and verify no further advancement occurred
        await sleep(100);
        assert.strictEqual(engine1.state.replayCursorIndex, frozenCursor, 'Cursor must not change while paused');
        assert.strictEqual(engine1.state.visibleCandles.length, frozenVisible, 'Visible count must not change while paused');
    });

    console.log('\n--- Test Group 3: Resume Playback ---');
    await it('Resume from paused candle advances forward cleanly', async () => {
        const beforeResume = engine1.state.replayCursorIndex;
        engine1.play(40);
        assert.strictEqual(engine1.state.replayStatus, 'playing');

        await sleep(100);
        engine1.pause();

        assert(engine1.state.replayCursorIndex > beforeResume, 'Expected cursor > ' + beforeResume + ', got ' + engine1.state.replayCursorIndex);
        assert.strictEqual(engine1.state.visibleCandles.length, engine1.state.replayCursorIndex + 1);
    });

    console.log('\n--- Test Group 4: Speed Modulation ---');
    await it('setSpeed dynamically updates interval while playing', async () => {
        const start = engine1.state.replayCursorIndex;
        engine1.play(100);
        engine1.setSpeed(40); // Update to 40ms
        assert.strictEqual(engine1.state.speedMs, 40);

        await sleep(140);
        engine1.pause();

        const advanced = engine1.state.replayCursorIndex - start;
        assert(advanced >= 2, 'Expected at least 2 bars advanced at 40ms speed, got ' + advanced);
    });

    console.log('\n--- Test Group 5: Zero-Lookahead Verification During Playback ---');
    await it('Zero future candles leaked at any point during active playback', async () => {
        const engine2 = createReplayEngine;
        engine2.loadDataset('XAUUSD_MOCK2', 'XAUUSD', '15m', candles);
        engine2.init(10);

        let lookaheadViolations = 0;
        const unsub = engine2.subscribe((snapshot, eventType, detail) => {
            if (eventType === 'step') {
                const cur = snapshot.replayCursorIndex;
                const vis = engine2.getVisibleCandles();
                if (vis.length !== cur + 1) lookaheadViolations++;
                if (vis[vis.length - 1].time !== candles[cur].time) lookaheadViolations++;
                // Check future candles do not exist in visible
                for (let j = cur + 1; j < candles.length; j++) {
                    if (vis.some(c => c.time === candles[j].time)) {
                        lookaheadViolations++;
                    }
                }
            }
        });

        engine2.play(30);
        await sleep(150);
        engine2.pause();
        unsub();

        assert.strictEqual(lookaheadViolations, 0, 'Found lookahead violations during playback');
        const integrity = engine2.validateIntegrity();
        assert.strictEqual(integrity.ok, true);
    });

    console.log('\n--- Test Group 6: Reset Rewinds to Start Candle ---');
    await it('Reset stops playback and rewinds to initial start index', () => {
        const engine3 = createReplayEngine;
        engine3.loadDataset('XAUUSD_MOCK3', 'XAUUSD', '15m', candles);
        engine3.init(6);

        engine3.step();
        engine3.step();
        engine3.step();
        assert.strictEqual(engine3.state.replayCursorIndex, 9);
        assert.strictEqual(engine3.state.visibleCandles.length, 10);

        const resetRes = engine3.reset();
        assert.strictEqual(engine3.state.replayCursorIndex, 6);
        assert.strictEqual(engine3.state.visibleCandles.length, 7);
        assert.strictEqual(engine3.state.replayStatus, 'paused');
        assert.strictEqual(resetRes.replayCursorIndex, 6);
    });

    console.log('\n--- Test Group 7: End-of-Data Boundary & Completion ---');
    await it('Replay cleanly finishes at end of historical candles with status complete', async () => {
        const engine4 = createReplayEngine;
        engine4.loadDataset('XAUUSD_MOCK4', 'XAUUSD', '15m', candles);
        engine4.init(95); // 5 candles away from end (99)

        let completed = false;
        engine4.subscribe((snapshot, eventType) => {
            if (eventType === 'complete') completed = true;
        });

        engine4.play(30);
        await sleep(250);

        assert.strictEqual(engine4.state.replayCursorIndex, 99);
        assert.strictEqual(engine4.state.visibleCandles.length, 100);
        assert.strictEqual(engine4.state.replayStatus, 'complete');
        assert.strictEqual(completed, true);
    });

    console.log('\n======================================================');
    console.log('  PLAYBACK TEST RESULTS: ' + passed + ' PASSED, ' + failed + ' FAILED');
    console.log('======================================================');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
