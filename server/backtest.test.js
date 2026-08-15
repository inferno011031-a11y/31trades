'use strict';

// ============================================================================
// 31TRADES — Backtest data service tests
// Determinism is the core contract: same symbol + timeframe → identical series.
// ============================================================================

process.env.TRADEMIND_AUTH = 'off';
process.env.TRADEMIND_AI_DATA_DIR = require('node:path').join(__dirname, '..', '.freebuff', 'test-data-bt');

const B = require('./backtest.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

// 1 · determinism — identical series for the same inputs
{
    const a = B.generateCandles({ symbol: 'EURUSD', timeframe: '1h', count: 200 });
    const b = B.generateCandles({ symbol: 'EURUSD', timeframe: '1h', count: 200 });
    ok(JSON.stringify(a.candles) === JSON.stringify(b.candles), 'EURUSD 1h is deterministic (identical series)');
    ok(a.candles.length === 200, 'count respected (200 bars)');
}

// 2 · different symbols/timeframes differ
{
    const eur = B.generateCandles({ symbol: 'EURUSD', timeframe: '1h' });
    const xau = B.generateCandles({ symbol: 'XAUUSD', timeframe: '1h' });
    ok(JSON.stringify(eur.candles) !== JSON.stringify(xau.candles), 'different symbols → different series');
    const eur5 = B.generateCandles({ symbol: 'EURUSD', timeframe: '5m' });
    ok(JSON.stringify(eur.candles) !== JSON.stringify(eur5.candles), 'different timeframes → different series');
}

// 3 · OHLC sanity for every bar
{
    ['1m', '5m', '15m', '1h', '4h', '1d'].forEach(tf => {
        const d = B.generateCandles({ symbol: 'BTC', timeframe: tf });
        const sane = d.candles.every(c =>
            c.high >= Math.max(c.open, c.close) &&
            c.low <= Math.min(c.open, c.close) &&
            c.open > 0 && c.close > 0 && c.high > 0 && c.low > 0 &&
            c.volume > 0 &&
            Number.isInteger(c.time)
        );
        ok(sane, tf + ' bars are OHLC-sane (high≥max, low≤min, positive, int timestamps)');
        ok(d.candles.length === (B.DEFAULT_COUNTS[tf] || 320), tf + ' returns the default bar count');
    });
}

// 4 · timestamps strictly increasing + trading days only
{
    const d = B.generateCandles({ symbol: 'EURUSD', timeframe: '1h' });
    let increasing = true;
    for (let i = 1; i < d.candles.length; i++) {
        if (d.candles[i].time <= d.candles[i - 1].time) { increasing = false; break; }
    }
    ok(increasing, 'timestamps strictly increasing');
    const weekend = d.candles.some(c => {
        const dow = new Date(c.time * 1000).getUTCDay();
        return dow === 0 || dow === 6;
    });
    ok(!weekend, 'no weekend bars (FX market closed)');
}

// 5 · price level tracks the real asset (XAUUSD ~$2000+, BTC ~$50k+, EURUSD ~1.x)
{
    const xau = B.generateCandles({ symbol: 'XAUUSD', timeframe: '1h' });
    const mid = xau.candles.reduce((a, c) => a + c.close, 0) / xau.candles.length;
    ok(mid > 500 && mid < 10000, 'XAUUSD trades in the gold range (~$' + Math.round(mid) + ')');
    const btc = B.generateCandles({ symbol: 'BTC', timeframe: '1h' });
    const bmid = btc.candles.reduce((a, c) => a + c.close, 0) / btc.candles.length;
    ok(bmid > 5000 && bmid < 1000000, 'BTC trades in a sane range (~$' + Math.round(bmid) + ')');
    const eur = B.generateCandles({ symbol: 'EURUSD', timeframe: '1h' });
    const emid = eur.candles.reduce((a, c) => a + c.close, 0) / eur.candles.length;
    ok(emid > 0.5 && emid < 2, 'EURUSD trades around parity (~' + emid.toFixed(3) + ')');
}

// 6 · count never changes the underlying series (only the window)
{
    const full = B.generateCandles({ symbol: 'NAS100', timeframe: '1h', count: 400 });
    const short = B.generateCandles({ symbol: 'NAS100', timeframe: '1h', count: 120 });
    const tail = full.candles.slice(-120);
    ok(JSON.stringify(short.candles) === JSON.stringify(tail), 'count slices the same deterministic series (window only)');
}

// 7 · unknown symbol falls back to a sensible base and still works
{
    const d = B.generateCandles({ symbol: 'ZZZZZZ', timeframe: '1h' });
    ok(d.candles.length > 0 && d.candles.every(c => c.close > 0), 'unknown symbol still generates a valid series');
    ok(d.meta.category === 'Other', 'unknown symbol classified as Other');
}

console.log('\nALL BACKTEST DATA CHECKS PASS (' + okCount + ' ok' + (failCount ? ', ' + failCount + ' FAIL' : '') + ')\n');
process.exit(failCount ? 1 : 0);
