'use strict';

// ============================================================================
// 31TRADES — Market data service (TradingView-first)
// ----------------------------------------------------------------------------
// Serves historical OHLCV candles for Backtesting from REAL TradingView data
// via the open-source @mathieuc/tradingview client (github.com/Mathieu2301/
// Tradingview-API). Order of operations:
//
//   1. Fresh disk cache  → return it (TradingView rate-limits hard; caching
//      keeps every chart load fast and the feed polite).
//   2. TradingView WS    → fetch, write cache, return (source 'tradingview').
//   3. Failure latch     → after an error we skip TradingView for a few
//      minutes so a dead symbol never hammers the socket.
//   4. Synthetic fallback → deterministic seeded candles from ./backtest.js
//      (source 'synthetic'), so the app never breaks offline.
//
// The /api/backtest/candles contract is unchanged — only meta.source tells the
// UI whether the chart is live TradingView data or an estimate.
// Set TRADEMIND_TV=off to force the synthetic path (tests, airgapped hosts).
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const { generateCandles, TIMEFRAMES } = require('./backtest.js');

const DATA_DIR = process.env.TRADEMIND_TV_DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;      // 6h per (symbol, timeframe, count)
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const FAIL_LATCH_MS = 5 * 60 * 1000;          // skip TV for 5 min after a failure
const TV_TIMEOUT_MS = 15000;

let TV = null;
try { TV = require('@mathieuc/tradingview'); } catch (e) { /* not installed */ }

const tvEnabled = () => TV != null && process.env.TRADEMIND_TV !== 'off';

// ---- curated TradingView symbol map (exchange prefixes) ----------------------
const TV_SYMBOL = {
    // FX (all majors/minors on the FX: exchange)
    EURUSD: 'FX:EURUSD', GBPUSD: 'FX:GBPUSD', USDJPY: 'FX:USDJPY', EURJPY: 'FX:EURJPY',
    AUDUSD: 'FX:AUDUSD', USDCAD: 'FX:USDCAD', USDCHF: 'FX:USDCHF', NZDUSD: 'FX:NZDUSD',
    EURGBP: 'FX:EURGBP', EURCHF: 'FX:EURCHF', AUDNZD: 'FX:AUDNZD', EURNZD: 'FX:EURNZD',
    GBPAUD: 'FX:GBPAUD', GBPNZD: 'FX:GBPNZD', EURCAD: 'FX:EURCAD', GBPCAD: 'FX:GBPCAD',
    AUDCHF: 'FX:AUDCHF', CADCHF: 'FX:CADCHF',
    // metals
    XAUUSD: 'OANDA:XAUUSD', XAGUSD: 'OANDA:XAGUSD', XPTUSD: 'OANDA:XPTUSD', XPDUSD: 'OANDA:XPDUSD',
    // energy
    USOIL: 'TVC:USOIL', XTIUSD: 'TVC:USOIL', WTI: 'TVC:USOIL', CL: 'NYMEX:CL', OIL: 'NYMEX:CL',
    UKOIL: 'TVC:UKOIL', XBRUSD: 'TVC:UKOIL', BRENT: 'TVC:UKOIL',
    NATGAS: 'TVC:NATGAS', XNGUSD: 'TVC:NATGAS', NG: 'NYMEX:NG',
    // agriculture
    COFFEE: 'NYMEX:KC', KC: 'NYMEX:KC', SUGAR: 'NYMEX:SB', SB: 'NYMEX:SB',
    COCOA: 'NYMEX:CC', CC: 'NYMEX:CC', COTTON: 'NYMEX:CT',
    WHEAT: 'CBOT:ZW', CORN: 'CBOT:ZC', SOYBEAN: 'CBOT:ZS', OATS: 'CBOT:ZO', RICE: 'CBOT:ZR',
    // indices
    NAS100: 'TVC:NAS100', US100: 'TVC:NAS100', US30: 'TVC:DOW',
    SPX500: 'TVC:SPX', SP500: 'TVC:SPX', DAX40: 'TVC:DAX', GER40: 'TVC:DAX', DE40: 'TVC:DAX',
    UK100: 'TVC:UKX', JPN225: 'TVC:NIKKEI', NIKKEI: 'TVC:NIKKEI',
    AUS200: 'TVC:AUS200', EU50: 'TVC:EUSTX50', FRA40: 'TVC:FCHI', HK50: 'TVC:HSI',
    // crypto (Coinbase USD pairs)
    BTC: 'COINBASE:BTCUSD', ETH: 'COINBASE:ETHUSD', SOL: 'COINBASE:SOLUSD',
    XRP: 'COINBASE:XRPUSD', DOGE: 'COINBASE:DOGEUSD', ADA: 'COINBASE:ADAUSD',
    DOT: 'COINBASE:DOTUSD', LTC: 'COINBASE:LTCUSD', BNB: 'COINBASE:BNBUSD',
    // stocks
    AAPL: 'NASDAQ:AAPL', TSLA: 'NASDAQ:TSLA', MSFT: 'NASDAQ:MSFT', NVDA: 'NASDAQ:NVDA',
    AMZN: 'NASDAQ:AMZN', META: 'NASDAQ:META', GOOGL: 'NASDAQ:GOOGL', NFLX: 'NASDAQ:NFLX'
};

// crypto without a curated entry → try Coinbase, then Binance USDT quoting
function cryptoGuess(sym) {
    const root = String(sym).replace(/USD$/, '');
    return 'COINBASE:' + root + 'USD';
}

// ---- timeframe mapping to TradingView resolutions -----------------------------
const TV_TF = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

// ---- resolution cache (per process) ------------------------------------------
const resolutionCache = new Map();

async function resolveSymbol(sym) {
    const s = String(sym || '').toUpperCase();
    if (TV_SYMBOL[s]) return { symbol: s, tv: TV_SYMBOL[s], source: 'map' };
    if (resolutionCache.has(s)) return resolutionCache.get(s);
    // crypto fallback guesses
    if (/(BTC|ETH|SOL|XRP|DOGE|ADA|DOT|LTC|BNB|PEPE|XLM|NEAR|APT|ARB|OP|SUI|INJ|SEI|TIA)USD$/.test(s)) {
        const guess = cryptoGuess(s);
        resolutionCache.set(s, { symbol: s, tv: guess, source: 'guess' });
        return resolutionCache.get(s);
    }
    // live search — pick the first liquid match whose symbol matches
    try {
        const list = await TV.searchMarket(s, { type: 'cfd' });
        const hit = (list || []).find(m => m && m.symbol === s) ||
            (list || []).find(m => m && String(m.symbol).replace(/-/g, '') === s) || (list || [])[0];
        if (hit && hit.exchange && hit.symbol) {
            const r = { symbol: s, tv: hit.exchange + ':' + hit.symbol, source: 'search' };
            resolutionCache.set(s, r);
            return r;
        }
    } catch (e) { /* fall through */ }
    const r = { symbol: s, tv: null, source: 'none' };
    resolutionCache.set(s, r);
    return r;
}

// ---- fetch one candle series from TradingView (guest client, no key) ----------
function fetchFromTV(tvSymbol, timeframe, count) {
    return new Promise((resolve, reject) => {
        if (!TV) return reject(new Error('@mathieuc/tradingview not installed'));
        let client = null, chart = null, settled = false;
        const finish = (err, data) => {
            if (settled) return; settled = true;
            try { if (chart) chart.delete(); } catch (e) {}
            try { if (client) client.end(); } catch (e) {}
            if (err) reject(err); else resolve(data);
        };
        const timer = setTimeout(() => finish(new Error('TradingView timeout (' + tvSymbol + ')')), TV_TIMEOUT_MS);
        try {
            client = new TV.Client();
            chart = new client.Session.Chart();
            chart.onError((...errs) => {
                const msg = errs.map(e => typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e)).join(' ');
                finish(new Error('TradingView error: ' + msg.slice(0, 160)));
            });
            chart.onSymbolLoaded(() => { /* optional */ });
            chart.onUpdate(() => {
                const periods = (chart.periods || [])
                    .filter(p => p && p.open != null)
                    .map(p => {
                        const t = Number(p.time);
                        const time = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t); // ms → sec
                        return {
                            time,
                            open: p.open,
                            high: p.max != null ? p.max : Math.max(p.open, p.close),
                            low: p.min != null ? p.min : Math.min(p.open, p.close),
                            close: p.close,
                            volume: Math.round((p.volume || 0) * 100) / 100
                        };
                    })
                    .filter(c => c.time > 0 && c.close > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
                    .sort((a, b) => a.time - b.time);
                if (!periods.length) return finish(new Error('empty series from TradingView'));
                clearTimeout(timer);
                finish(null, { candles: periods, source: 'tradingview', info: { tv: tvSymbol } });
            });
            chart.setMarket(tvSymbol, {
                timeframe: TV_TF[timeframe] || '60',
                range: Math.min(1500, Math.max(60, Number(count) || 320))
            });
        } catch (e) {
            clearTimeout(timer);
            finish(e);
        }
    });
}

// ---- disk cache ---------------------------------------------------------------
function cacheFile(symbol, timeframe, count) {
    return path.join(DATA_DIR, 'tv-candles-' + symbol + '-' + timeframe + '-' + count + '.json');
}
function readCache(symbol, timeframe, count) {
    try {
        const f = cacheFile(symbol, timeframe, count);
        if (!fs.existsSync(f)) return null;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Date.now() - (j.fetchedAt || 0) < CACHE_TTL_MS && Array.isArray(j.candles) && j.candles.length) {
            return { candles: j.candles, source: 'cache', info: j.info || {} };
        }
    } catch (e) { /* corrupt cache */ }
    return null;
}
function writeCache(symbol, timeframe, count, data) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(cacheFile(symbol, timeframe, count), JSON.stringify({ fetchedAt: Date.now(), ...data }));
    } catch (e) { /* cache is best-effort */ }
}

// ---- failure latch ------------------------------------------------------------
const lastFailure = new Map();
function latchFile(symbol, timeframe, count) {
    return path.join(DATA_DIR, 'tv-fail-' + symbol + '-' + timeframe + '-' + count + '.json');
}
function latchHit(symbol, timeframe, count) {
    try {
        const f = latchFile(symbol, timeframe, count);
        if (fs.existsSync(f)) {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            return Date.now() - (j.at || 0) < FAIL_LATCH_MS;
        }
    } catch (e) {}
    return false;
}
function latchSet(symbol, timeframe, count) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(latchFile(symbol, timeframe, count), JSON.stringify({ at: Date.now() }));
    } catch (e) {}
}

// ---- public API ----------------------------------------------------------------
async function getCandles(opts) {
    const o = opts || {};
    const symbol = String(o.symbol || 'EURUSD').toUpperCase();
    const timeframe = String(o.timeframe || '1h');
    const count = Math.max(30, Math.min(6500, Number(o.count) || 320));
    const period = String(o.period || '').toLowerCase();

    // 0 · Real historical Gold dataset — per-month archives produced by
    // tools/split-gold-months.js  (data/gold/YYYY-MM/xau_<tf>_<YYYY-MM>.json)
    // Legacy folders jan2024/feb2024 keep working unchanged.
    if (symbol === 'XAUUSD' || symbol === 'GOLD') {
        let periodFolder = null;
        let periodLabel = null;
        if (/^\d{4}-\d{2}$/.test(period)) {
            periodFolder = period;
            const [yy, mm] = period.split('-');
            periodLabel = MONTH_NAMES[Number(mm) - 1] + ' ' + yy;
        } else if (period === 'jan2024' || period.includes('jan2024')) {
            periodFolder = 'jan2024'; periodLabel = 'January 2024';
        } else if (period === 'feb2024' || period.includes('feb2024')) {
            periodFolder = 'feb2024'; periodLabel = 'February 2024';
        } else if (period.includes('jan')) {          // legacy shorthand
            periodFolder = 'jan2024'; periodLabel = 'January 2024';
        } else if (period.includes('feb')) {
            periodFolder = 'feb2024'; periodLabel = 'February 2024';
        }

        let tfFile = timeframe.toLowerCase();
        if (!['1m', '2m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '1d', 'w', 'm'].includes(tfFile)) {
            if (tfFile.includes('1440') || tfFile.includes('1d') || tfFile === 'd') tfFile = '1d';
            else if (tfFile.includes('4h') || tfFile.includes('240')) tfFile = '4h';
            else if (tfFile.includes('6h') || tfFile.includes('360')) tfFile = '6h';
            else if (tfFile.includes('2h') || tfFile.includes('120')) tfFile = '2h';
            else if (tfFile.includes('1h') || tfFile.includes('60')) tfFile = '1h';
            else if (tfFile.includes('30')) tfFile = '30m';
            else if (tfFile.includes('15')) tfFile = '15m';
            else if (tfFile.includes('5')) tfFile = '5m';
            else if (tfFile.includes('3')) tfFile = '3m';
            else if (tfFile.includes('2')) tfFile = '2m';
            else if (tfFile.includes('1')) tfFile = '1m';
            else if (tfFile.includes('w')) tfFile = 'w';
            else if (tfFile.includes('m')) tfFile = 'm';
            else tfFile = '1h';
        }

        if (periodFolder) {
            const histFile = path.join(DATA_DIR, 'gold', periodFolder, `xau_${tfFile}_${periodFolder}.json`);
            if (fs.existsSync(histFile)) {
                try {
                    const j = JSON.parse(fs.readFileSync(histFile, 'utf8'));
                    const candles = (count && count < j.candles.length && !o.all) ? j.candles.slice(-count) : j.candles;
                    return {
                        ok: true,
                        symbol: 'XAUUSD',
                        timeframe,
                        period: j.period || periodFolder,
                        periodLabel: j.label || periodLabel,
                        count: candles.length,
                        base: candles[0] ? candles[0].close : 2040,
                        candles,
                        meta: { source: 'historical-archive', provider: 'BattleX Gold Historical Archive' }
                    };
                } catch (e) { /* fall through to synthetic */ }
            }
            // requested month has no archive → fall through: exact-month synthetic
            // (block 0.5) keeps the period picker meaningful for every month.
        }
    }

    // 0.5 · Specific historical period or blind mystery backtesting
    if (period && period !== 'live' && (period === 'random' || /^[0-9]{4}-[0-9]{2}$/.test(period) || o.blind || o.isRandom)) {
        const syn = generateCandles({ symbol, timeframe, count, period, blind: o.blind || o.isRandom });
        return Object.assign({}, syn, {
            meta: Object.assign({}, syn.meta, {
                source: syn.meta && syn.meta.blind ? 'blind-archive' : 'historical-period',
                provider: '31Trades Historical Replay Engine'
            })
        });
    }

    // 1 · fresh cache
    const cached = readCache(symbol, timeframe, count);
    if (cached) return { ok: true, symbol, timeframe, count, candles: cached.candles, meta: { source: cached.source, provider: 'TradingView' } };

    // 2 · live TradingView (unless disabled or latched)
    if (tvEnabled() && !latchHit(symbol, timeframe, count)) {
        try {
            const r = await resolveSymbol(symbol);
            if (r.tv) {
                const live = await fetchFromTV(r.tv, timeframe, count);
                const tail = live.candles.slice(-count);
                writeCache(symbol, timeframe, count, { candles: tail, info: live.info });
                const first = tail[0];
                return { ok: true, symbol, timeframe, count: tail.length, base: first ? first.close : null, candles: tail, meta: { source: 'tradingview', provider: 'TradingView', tv: r.tv } };
            }
        } catch (e) {
            latchSet(symbol, timeframe, count);
            console.log('[marketdata] TradingView failed for ' + symbol + ' (' + e.message + ') — synthetic fallback');
        }
    }

    // 3 · deterministic synthetic fallback
    const syn = generateCandles({ symbol, timeframe, count });
    return Object.assign({}, syn, { meta: Object.assign({}, syn.meta, { source: 'synthetic', provider: '31Trades deterministic generator' }) });
}

// expose the synthetic generator + helpers for tests
module.exports = { getCandles, resolveSymbol, fetchFromTV, generateCandles, TV_TF, DATA_DIR, CACHE_TTL_MS };
