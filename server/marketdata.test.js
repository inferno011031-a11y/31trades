'use strict';

// ============================================================================
// 31TRADES — Market data service tests
// These tests never touch the network: they pin the cache-first / synthetic-
// fallback behavior and the curated TradingView symbol map. The live
// TradingView WS path is exercised manually (see the probe in the run doc).
// ============================================================================

process.env.TRADEMIND_AUTH = 'off';
process.env.TRADEMIND_TV = 'off';                       // force the offline path
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '31trades-tv-'));
process.env.TRADEMIND_TV_DATA_DIR = TMP;

const M = require('./marketdata.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

(async function run() {


// 1 · TV disabled → deterministic synthetic fallback
{
    const a = await M.getCandles({ symbol: 'EURUSD', timeframe: '1h', count: 120 });
    const b = await M.getCandles({ symbol: 'EURUSD', timeframe: '1h', count: 120 });
    ok(a.ok && a.meta.source === 'synthetic', 'TV off → synthetic source');
    ok(JSON.stringify(a.candles) === JSON.stringify(b.candles), 'synthetic fallback is deterministic');
    ok(a.candles.length === 120, 'requested count respected');
    ok(a.candles.every(c => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)), 'fallback OHLC sane');
}

// 2 · fresh disk cache wins over everything (no network needed)
{
    const canned = [
        { time: 1700000000, open: 100, high: 105, low: 99, close: 104, volume: 1000 },
        { time: 1700000100, open: 104, high: 106, low: 102, close: 103, volume: 900 }
    ];
    fs.writeFileSync(path.join(TMP, 'tv-candles-AAPL-1h-50.json'), JSON.stringify({ fetchedAt: Date.now(), candles: canned, info: { tv: 'NASDAQ:AAPL' } }));
    const r = await M.getCandles({ symbol: 'AAPL', timeframe: '1h', count: 50 });
    ok(r.meta.source === 'cache', 'fresh cache → source cache');
    ok(r.candles.length === 2 && r.candles[0].time === 1700000000, 'cache contents returned verbatim');
}

// 3 · stale cache is ignored (falls through to synthetic when TV is off)
{
    fs.writeFileSync(path.join(TMP, 'tv-candles-ETH-1h-50.json'), JSON.stringify({ fetchedAt: Date.now() - M.CACHE_TTL_MS - 1000, candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] }));
    const r = await M.getCandles({ symbol: 'ETH', timeframe: '1h', count: 50 });
    ok(r.meta.source === 'synthetic', 'stale cache expires → synthetic fallback');
    ok(r.candles.length === 50, 'fallback returns the full requested window');
}

// 4 · curated symbol map resolves real TradingView tickers (sync map, no network)
{
    const cases = [['EURUSD', 'FX:EURUSD'], ['XAUUSD', 'OANDA:XAUUSD'], ['AAPL', 'NASDAQ:AAPL'],
                   ['NAS100', 'TVC:NAS100'], ['BTC', 'COINBASE:BTCUSD'], ['US30', 'TVC:DOW'], ['GBPUSD', 'FX:GBPUSD']];
    const results = await Promise.all(cases.map(([sym]) => M.resolveSymbol(sym)));
    cases.forEach(([sym, expected], i) => {
        ok(results[i] && results[i].tv === expected, sym + ' → ' + expected + ' (got ' + (results[i] && results[i].tv) + ')');
    });
}

// 5 · unknown symbol still yields a valid series (map miss → fallback)
{
    const r = await M.getCandles({ symbol: 'ZZZZZZ', timeframe: '1h', count: 60 });
    ok(r.ok && r.candles.length === 60 && r.meta.source === 'synthetic', 'unknown symbol → valid synthetic series');
}

console.log('\nALL MARKET DATA CHECKS PASS (' + okCount + ' ok' + (failCount ? ', ' + failCount + ' FAIL' : '') + ')\n');
process.exit(failCount ? 1 : 0);
})();
