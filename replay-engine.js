'use strict';

/**
 * BATTLEXJOURNAL — Authoritative Local Replay Engine
 * --------------------------------------------------
 * Single source of truth for historical bar replay:
 * - Deterministic cursor advancement (Step 1 Bar)
 * - Automated playback with pause and speed control
 * - Clean reset restoring the original cut point
 * - Strict future-candle hiding and OHLCV data integrity
 * - Zero competing replay cursors
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BattleXReplay = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    function createReplayEngine() {
        const listeners = new Set();
        let timer = null;

        const state = {
            dataset: 'XAUUSD_FEB2024',
            symbol: 'XAUUSD',
            timeframe: '15m',
            historicalCandles: [],
            replayStartIndex: null,
            replayCursorIndex: null,
            visibleCandles: [],
            replayStatus: 'idle', // 'idle' | 'playing' | 'paused' | 'complete'
            speedMs: 500
        };

        function notify(eventType, detail) {
            const snapshot = getSnapshot();
            listeners.forEach(fn => {
                try { fn(snapshot, eventType, detail); } catch (e) { console.error('[ReplayEngine] Listener error:', e); }
            });
        }

        function getSnapshot() {
            return {
                dataset: state.dataset,
                symbol: state.symbol,
                timeframe: state.timeframe,
                replayStartIndex: state.replayStartIndex,
                replayCursorIndex: state.replayCursorIndex,
                visibleCount: state.visibleCandles.length,
                totalCount: state.historicalCandles.length,
                replayStatus: state.replayStatus,
                speedMs: state.speedMs,
                currentCandle: (typeof state.replayCursorIndex === 'number' && state.historicalCandles[state.replayCursorIndex])
                    ? state.historicalCandles[state.replayCursorIndex] : null
            };
        }

        function loadDataset(datasetName, symbol, timeframe, rawCandles) {
            if (timer) { clearInterval(timer); timer = null; }

            if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
                throw new Error('[ReplayEngine] Invalid candles array');
            }

            state.dataset = datasetName || 'XAUUSD_FEB2024';
            state.symbol = (symbol || 'XAUUSD').toUpperCase();
            state.timeframe = timeframe || '15m';

            // Normalize and enforce strict chronological order
            state.historicalCandles = rawCandles.map(c => {
                const t = Number(c.time);
                return {
                    time: t > 1e11 ? t : t * 1000,
                    open: Number(c.open),
                    high: Number(c.high),
                    low: Number(c.low),
                    close: Number(c.close),
                    volume: Number(c.volume || 0)
                };
            }).sort((a, b) => a.time - b.time);

            state.replayStartIndex = null;
            state.replayCursorIndex = null;
            state.visibleCandles = state.historicalCandles.slice();
            state.replayStatus = 'idle';

            notify('load');
            return getSnapshot();
        }

        function init(startIndex) {
            if (state.historicalCandles.length === 0) {
                throw new Error('[ReplayEngine] No historical candles loaded');
            }

            if (timer) { clearInterval(timer); timer = null; }

            const total = state.historicalCandles.length;
            const validIndex = Math.max(0, Math.min(Number(startIndex) || 0, total - 1));

            state.replayStartIndex = validIndex;
            state.replayCursorIndex = validIndex;
            state.visibleCandles = state.historicalCandles.slice(0, validIndex + 1);
            state.replayStatus = (validIndex >= total - 1) ? 'complete' : 'paused';

            notify('init', { startIndex: validIndex });
            return getSnapshot();
        }

        function _advanceBar(isAutoPlay = false) {
            if (state.historicalCandles.length === 0) return { success: false, reason: 'no_data' };

            // If manual step is called while playing, stop auto timer
            if (!isAutoPlay && timer) {
                clearInterval(timer);
                timer = null;
            }

            // If currently idle, initialize at index 0
            if (state.replayStatus === 'idle' || state.replayCursorIndex === null) {
                init(0);
                return { success: true, newBar: state.historicalCandles[0], cursor: 0 };
            }

            const total = state.historicalCandles.length;
            if (state.replayCursorIndex < total - 1) {
                const prevCursor = state.replayCursorIndex;
                state.replayCursorIndex++;
                state.visibleCandles = state.historicalCandles.slice(0, state.replayCursorIndex + 1);
                const isFinalBar = state.replayCursorIndex >= total - 1;
                if (isFinalBar) {
                    state.replayStatus = 'complete';
                    if (timer) {
                        clearInterval(timer);
                        timer = null;
                    }
                } else if (!isAutoPlay) {
                    state.replayStatus = 'paused';
                }
                const newBar = state.historicalCandles[state.replayCursorIndex];

                notify('step', { newBar, cursor: state.replayCursorIndex, prevCursor });
                if (isFinalBar) {
                    notify('complete', { cursor: state.replayCursorIndex });
                }
                return { success: true, newBar, cursor: state.replayCursorIndex, prevCursor, complete: isFinalBar };
            } else {
                state.replayStatus = 'complete';
                if (timer) {
                    clearInterval(timer);
                    timer = null;
                }
                notify('complete', { cursor: state.replayCursorIndex });
                return { success: false, reason: 'end_of_data', cursor: state.replayCursorIndex, prevCursor: state.replayCursorIndex };
            }
        }

        function step() {
            return _advanceBar(false);
        }

        function play(speedMs) {
            if (state.historicalCandles.length === 0) return;

            // If already playing, clear timer first (never create duplicate timers)
            if (timer) {
                clearInterval(timer);
                timer = null;
            }

            if (state.replayStatus === 'idle' || state.replayCursorIndex === null) {
                init(0);
            }

            const total = state.historicalCandles.length;
            if (state.replayCursorIndex >= total - 1) {
                state.replayStatus = 'complete';
                notify('complete');
                return;
            }

            state.replayStatus = 'playing';
            state.speedMs = Math.max(30, Number(speedMs) || state.speedMs || 500);

            notify('play', { speedMs: state.speedMs });

            timer = setInterval(() => {
                if (state.replayCursorIndex >= state.historicalCandles.length - 1) {
                    if (timer) { clearInterval(timer); timer = null; }
                    state.replayStatus = 'complete';
                    notify('complete');
                    return;
                }
                _advanceBar(true);
            }, state.speedMs);
        }

        function setSpeed(speedMs) {
            state.speedMs = Math.max(30, Number(speedMs) || 500);
            if (state.replayStatus === 'playing' && timer) {
                clearInterval(timer);
                timer = setInterval(() => {
                    if (state.replayCursorIndex >= state.historicalCandles.length - 1) {
                        if (timer) { clearInterval(timer); timer = null; }
                        state.replayStatus = 'complete';
                        notify('complete');
                        return;
                    }
                    _advanceBar(true);
                }, state.speedMs);
            }
            notify('speed', { speedMs: state.speedMs });
        }

        function pause() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (state.replayStatus === 'playing') {
                state.replayStatus = 'paused';
                notify('pause');
            }
        }

        function reset() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }

            if (state.replayStartIndex === null) return getSnapshot();

            state.replayCursorIndex = state.replayStartIndex;
            state.visibleCandles = state.historicalCandles.slice(0, state.replayCursorIndex + 1);
            state.replayStatus = 'paused';

            notify('reset', { startIndex: state.replayStartIndex });
            return getSnapshot();
        }

        function exit() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            state.replayStatus = 'idle';
            state.replayStartIndex = null;
            state.replayCursorIndex = null;
            state.visibleCandles = state.historicalCandles.slice();

            notify('exit');
            return getSnapshot();
        }

        function validateIntegrity() {
            const errors = [];
            const isReplayActive = state.replayStatus !== 'idle' && typeof state.replayCursorIndex === 'number';

            // 1. Length validation: visibleCandles.length === replayCursorIndex + 1
            const expectedLen = isReplayActive ? (state.replayCursorIndex + 1) : state.historicalCandles.length;
            if (state.visibleCandles.length !== expectedLen) {
                errors.push("Length mismatch: expected " + expectedLen + ", got " + state.visibleCandles.length);
            }

            // 2. Strict chronological order validation
            for (let i = 1; i < state.visibleCandles.length; i++) {
                if (state.visibleCandles[i].time <= state.visibleCandles[i - 1].time) {
                    errors.push("Chronological order violated at index " + i);
                }
            }

            // 3. Future candle hiding validation
            if (isReplayActive) {
                const maxAllowedTime = state.historicalCandles[state.replayCursorIndex].time;
                const futureBars = state.visibleCandles.filter(b => b.time > maxAllowedTime);
                if (futureBars.length > 0) {
                    errors.push("Future candle leak: " + futureBars.length + " bars exist with time > cursorTime (" + maxAllowedTime + ")");
                }
            }

            // 4. Exact OHLCV values fidelity against source
            for (let i = 0; i < state.visibleCandles.length; i++) {
                const v = state.visibleCandles[i];
                const h = state.historicalCandles[i];
                if (!h || v.open !== h.open || v.high !== h.high || v.low !== h.low || v.close !== h.close || v.time !== h.time) {
                    errors.push("OHLCV mismatch at index " + i);
                    break;
                }
            }

            return {
                ok: errors.length === 0,
                errors,
                snapshot: getSnapshot()
            };
        }

        function getVisibleCandles() {
            // If cursor is set, ALWAYS return the sliced view.
            // Never expose full historicalCandles while replayCursorIndex is active —
            // this prevents loading all bars into TV's cache during active replay.
            if (typeof state.replayCursorIndex === 'number' && state.replayCursorIndex !== null) {
                return state.historicalCandles.slice(0, state.replayCursorIndex + 1);
            }
            if (state.replayStatus === 'idle') {
                return state.historicalCandles.slice();
            }
            return state.historicalCandles.slice(0, (state.replayCursorIndex || 0) + 1);
        }

        /**
         * Deterministic Strategy Evaluation Engine
         * Evaluates ONLY the visible/revealed candles up to the current replayCursorIndex.
         * Lookahead is strictly prohibited.
         * 
         * @param {Object} [options]
         * @param {string} [options.strategyId] Strategy ID or key (e.g. 'strat-lfvg', 'strat-orob', 'strat-aob', 'default')
         * @param {string} [options.strategyName] Custom strategy display name
         * @param {Object} [options.riskConfig] Optional risk parameters ({ riskPerTrade, minRR })
         * @returns {Object} Deterministic signal evaluation result
         */
        function runStrategy(options) {
            const opts = options || {};
            const isReplayActive = state.replayStatus !== 'idle' && typeof state.replayCursorIndex === 'number';

            // 1. Guard check: Must have candle data
            if (state.historicalCandles.length === 0) {
                return {
                    ok: false,
                    error: 'NO_DATA',
                    message: 'No historical candles available for strategy evaluation.'
                };
            }

            // 2. Extract strictly revealed candles (C1..C_cursor) - NO FUTURE CANDLES
            const visible = isReplayActive
                ? state.historicalCandles.slice(0, state.replayCursorIndex + 1)
                : state.historicalCandles.slice();

            const cursorIndex = isReplayActive ? state.replayCursorIndex : visible.length - 1;
            const currentCandle = visible[visible.length - 1];

            if (!currentCandle || visible.length < 3) {
                return {
                    ok: true,
                    evaluated: true,
                    signal: null,
                    reason: 'INSUFFICIENT_BARS',
                    message: 'At least 3 historical bars are required to compute technical setups.',
                    cursorIndex,
                    visibleCount: visible.length,
                    timestamp: currentCandle ? currentCandle.time : null
                };
            }

            // 3. Resolve Strategy configuration
            const strategyName = opts.strategyName || opts.strategyId || 'London FVG';
            const riskConfig = Object.assign({
                riskPerTrade: 25,
                minRR: 1.5,
                slBuffer: 4.5
            }, opts.riskConfig || {});

            // 4. Deterministic technical analysis on strictly revealed bars
            // We inspect the last 3 visible candles: [prev2, prev1, curr]
            const len = visible.length;
            const curr = visible[len - 1];
            const prev1 = visible[len - 2];
            const prev2 = visible[len - 3];

            let signal = null; // 'BUY' | 'SELL' | null
            let pattern = 'NONE';
            let setup = 'None';
            let entryPrice = curr.close;
            let slPrice = null;
            let tpPrice = null;
            let explanation = '';

            // Strategy Model 1: Fair Value Gap (FVG) / Market Structure Shift
            // Bullish FVG: prev2.high < curr.low (imbalance gap between bar N-2 high and bar N low)
            // Bearish FVG: prev2.low > curr.high (imbalance gap between bar N-2 low and bar N high)
            const isBullishFVG = prev2.high < curr.low && curr.close > curr.open;
            const isBearishFVG = prev2.low > curr.high && curr.close < curr.open;

            // Strategy Model 2: Momentum / Moving Average Break
            // Measure short-term 5-period average close if available
            let avgClose5 = 0;
            const period5 = Math.min(5, len);
            for (let i = len - period5; i < len; i++) {
                avgClose5 += visible[i].close;
            }
            avgClose5 /= period5;

            // Strategy Model 3: Pin Bar / Liquidity Sweep Rejection
            const body = Math.abs(curr.close - curr.open);
            const totalRange = curr.high - curr.low;
            const lowerWick = Math.min(curr.open, curr.close) - curr.low;
            const upperWick = curr.high - Math.max(curr.open, curr.close);
            const isBullishPin = totalRange > 0 && (lowerWick >= totalRange * 0.55) && (body <= totalRange * 0.35);
            const isBearishPin = totalRange > 0 && (upperWick >= totalRange * 0.55) && (body <= totalRange * 0.35);

            if (isBullishFVG || (curr.close > avgClose5 && isBullishPin)) {
                signal = 'BUY';
                pattern = isBullishFVG ? 'Bullish FVG' : 'Bullish Liquidity Sweep';
                setup = 'MSS + FVG';
                entryPrice = curr.close;
                slPrice = Number((Math.min(curr.low, prev1.low) - 1.5).toFixed(2));
                const riskDist = Math.max(2.0, entryPrice - slPrice);
                tpPrice = Number((entryPrice + (riskDist * riskConfig.minRR)).toFixed(2));
                explanation = `${pattern} detected at bar ${cursorIndex + 1}. Price closed above imbalance with stop below recent swing low.`;
            } else if (isBearishFVG || (curr.close < avgClose5 && isBearishPin)) {
                signal = 'SELL';
                pattern = isBearishFVG ? 'Bearish FVG' : 'Bearish Liquidity Sweep';
                setup = 'MSS + FVG';
                entryPrice = curr.close;
                slPrice = Number((Math.max(curr.high, prev1.high) + 1.5).toFixed(2));
                const riskDist = Math.max(2.0, slPrice - entryPrice);
                tpPrice = Number((entryPrice - (riskDist * riskConfig.minRR)).toFixed(2));
                explanation = `${pattern} detected at bar ${cursorIndex + 1}. Price rejected liquidity with stop above recent swing high.`;
            } else if (curr.close > prev1.high && prev1.close > prev2.high) {
                // Continuation trend breakout
                signal = 'BUY';
                pattern = 'Bullish Trend Continuation';
                setup = 'Breakout';
                entryPrice = curr.close;
                slPrice = Number((prev1.low - 1.0).toFixed(2));
                const riskDist = Math.max(2.0, entryPrice - slPrice);
                tpPrice = Number((entryPrice + (riskDist * riskConfig.minRR)).toFixed(2));
                explanation = `Consecutive higher highs over previous 2 bars with strong bullish close at $${entryPrice.toFixed(2)}.`;
            } else if (curr.close < prev1.low && prev1.close < prev2.low) {
                // Continuation trend breakdown
                signal = 'SELL';
                pattern = 'Bearish Trend Continuation';
                setup = 'Breakout';
                entryPrice = curr.close;
                slPrice = Number((prev1.high + 1.0).toFixed(2));
                const riskDist = Math.max(2.0, slPrice - entryPrice);
                tpPrice = Number((entryPrice - (riskDist * riskConfig.minRR)).toFixed(2));
                explanation = `Consecutive lower lows over previous 2 bars with strong bearish close at $${entryPrice.toFixed(2)}.`;
            } else {
                signal = null;
                pattern = 'NEUTRAL / CONSOLIDATION';
                setup = 'None';
                explanation = `No actionable setup confirmed on bar ${cursorIndex + 1} ($${curr.close.toFixed(2)}). Market is in consolidation range.`;
            }

            const result = {
                ok: true,
                evaluated: true,
                strategy: strategyName,
                symbol: state.symbol,
                timeframe: state.timeframe,
                cursorIndex,
                visibleCount: visible.length,
                evaluatedCandle: {
                    time: curr.time,
                    open: curr.open,
                    high: curr.high,
                    low: curr.low,
                    close: curr.close,
                    volume: curr.volume
                },
                signal,
                setup,
                pattern,
                entryPrice,
                slPrice,
                tpPrice,
                riskReward: (signal && slPrice && tpPrice) ? riskConfig.minRR : null,
                explanation,
                timestamp: curr.time
            };

            notify('strategy_evaluated', result);
            return result;
        }

        function subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        }

        return {
            state,
            getSnapshot,
            getVisibleCandles,
            loadDataset,
            init,
            step,
            play,
            pause,
            reset,
            exit,
            setSpeed,
            runStrategy,
            validateIntegrity,
            subscribe
        };
    }

    return createReplayEngine();
}));
