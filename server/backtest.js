'use strict';

// ============================================================================
// 31TRADES — Backtest data service
// ----------------------------------------------------------------------------
// Serves deterministic historical OHLCV candles for the Backtesting page
// (FX Replay-style charting). There is no live market feed yet, so candles are
// synthesized with a seeded random walk that is REGIME-AWARE (trend + range +
// volatility bursts) and keyed to the symbol's real price level and pip/point
// convention. Determinism is the contract: the same symbol + timeframe always
// returns the identical series, so a chart reloads to the exact same picture
// and tests can assert stable output. A real broker import can later replace
// this generator behind the same /api/backtest/candles endpoint.
// ============================================================================

const TIMEFRAMES = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

const DEFAULT_COUNTS = { '1m': 720, '5m': 500, '15m': 400, '1h': 320, '4h': 240, '1d': 200 };

// ---- base price + tick/pip conventions per symbol/category ----
const BASE_PRICE = {
    // FX majors/minors
    EURUSD: 1.0850, GBPUSD: 1.2700, USDJPY: 155.20, EURJPY: 168.40, AUDUSD: 0.6600,
    USDCAD: 1.3650, USDCHF: 0.9050, NZDUSD: 0.6120, EURGBP: 0.8540, EURCHF: 0.9820,
    AUDNZD: 1.0780, EURNZD: 1.7730, GBPAUD: 1.9250, GBPNZD: 2.0760, EURCAD: 1.4810,
    GBPCAD: 1.7350, AUDCHF: 0.5970, CADCHF: 0.6630,
    // metals
    XAUUSD: 2380, XAGUSD: 29.5, XPTUSD: 960, XPDUSD: 930,
    // energy
    USOIL: 78.4, UKOIL: 82.1, XTIUSD: 78.4, XBRUSD: 82.1, BRENT: 82.1, CL: 78.4,
    WTI: 78.4, OIL: 78.4, NATGAS: 2.85, XNGUSD: 2.85, NG: 2.85,
    // agriculture
    COFFEE: 198, SUGAR: 21.5, COCOA: 4200, COTTON: 79, WHEAT: 540, CORN: 430,
    SOYBEAN: 1040, OATS: 320, RICE: 17.8, KC: 198, SB: 21.5, CC: 4200,
    // indices
    NAS100: 19850, US100: 19850, US30: 39500, SPX500: 5400, SP500: 5400,
    DAX40: 18500, GER40: 18500, DE40: 18500, UK100: 8200, JPN225: 39200,
    NIKKEI: 39200, AUS200: 7800, EU50: 5000, FRA40: 7800, HK50: 18500,
    // crypto
    BTC: 64000, ETH: 3200, SOL: 145, XRP: 0.55, DOGE: 0.13, ADA: 0.42, DOT: 6.1,
    LTC: 82, BNB: 590, PEPEUSD: 0.000011, XLMUSD: 0.11, NEARUSD: 6.8, APTUSD: 9.2,
    ARBUSD: 1.1, OPUSD: 2.4, SUIUSD: 1.05, INJUSD: 28, SEIUSD: 0.55, TIAUSD: 8.5,
    // stocks
    AAPL: 228, TSLA: 245, MSFT: 430, NVDA: 118, AMZN: 185, META: 490, GOOGL: 172, NFLX: 640
};

// ---- category classification (matches assets/asset-meta.js) ----
function categoryOf(sym) {
    const s = String(sym || '').toUpperCase();
    if (BASE_PRICE[s] !== undefined) {
        if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|DOT|LTC|BNB|PEPEUSD|XLMUSD|NEARUSD|APTUSD|ARBUSD|OPUSD|SUIUSD|INJUSD|SEIUSD|TIAUSD)$/.test(s)) return 'Crypto';
        if (/USD$/.test(s) && s.length === 6 && !/^(USOIL|UKOIL|XTIUSD|XBRUSD|XNGUSD|US30|US100|NAS100|SPX500|SP500|UK100|HK50|EU50|FRA40|JPN225|AUS200|DAX40|GER40|DE40|NIKKEI|COFFEE|SUGAR|COCOA|COTTON|WHEAT|CORN|SOYBEAN|OATS|RICE)$/.test(s)) {
            // 6-letter pairs ending in USD that aren't indices/commodities are FX
            if (!/^(PEPEUSD|XLMUSD|NEARUSD|APTUSD|ARBUSD|OPUSD|SUIUSD|INJUSD|SEIUSD|TIAUSD)$/.test(s)) return 'Forex';
        }
    }
    if (/^(XAU|XAG|XPT|XPD)/.test(s)) return 'Metals';
    if (/^(USOIL|UKOIL|XTIUSD|XBRUSD|BRENT|CL|WTI|OIL|NATGAS|XNGUSD|NG)$/.test(s)) return 'Energy';
    if (/^(COFFEE|SUGAR|COCOA|COTTON|WHEAT|CORN|SOYBEAN|OATS|RICE|KC|SB|CC)$/.test(s)) return 'Agriculture';
    if (/^(NAS100|US100|US30|SPX500|SP500|DAX40|GER40|DE40|UK100|JPN225|NIKKEI|AUS200|EU50|FRA40|HK50)$/.test(s)) return 'Indices';
    if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|DOT|LTC|BNB)$/.test(s)) return 'Crypto';
    if (/^(AAPL|TSLA|MSFT|NVDA|AMZN|META|GOOGL|NFLX)$/.test(s)) return 'Stocks';
    return 'Other';
}

// ---- seeded PRNG (mulberry32) — the whole series is a pure function of seed ----
function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- per-bar volatility scaled to the asset's price level ----
function volatilityFor(sym, tfSeconds) {
    const s = String(sym || '').toUpperCase();
    const cat = categoryOf(s);
    const base = BASE_PRICE[s] || 100;
    const perSecond = cat === 'Crypto' ? 0.000055
        : cat === 'Stocks' || cat === 'Indices' ? 0.000028
        : cat === 'Metals' || cat === 'Energy' ? 0.000040
        : 0.000022; // FX, agriculture
    const tfScale = Math.sqrt(tfSeconds / 3600);
    return perSecond * tfScale * (base < 1 ? 1 : Math.max(0.5, Math.min(2, 100 / base)));
}

// ---- trading-day rule: FX/indices/stocks/commodities close weekends ----
function isTradingDay(date) {
    const d = date.getUTCDay();
    return d !== 0 && d !== 6;
}

function generateCandles(opts) {
    const o = opts || {};
    const symbol = String(o.symbol || 'EURUSD').toUpperCase();
    const timeframe = String(o.timeframe || '1h');
    const tf = TIMEFRAMES[timeframe] || 3600;
    const maxBars = 1500;                    // fixed-length base series (deterministic)
    const count = Math.max(30, Math.min(maxBars, Number(o.count) || (DEFAULT_COUNTS[timeframe] || 320)));

    const rand = mulberry32(hashSeed(symbol + ':' + timeframe + ':v1'));
    const base = BASE_PRICE[symbol] || 100;
    const vol = volatilityFor(symbol, tf);
    const cat = categoryOf(symbol);

    // anchor the series end at a fixed recent date derived from the seed, so the
    // same symbol/timeframe always maps to the same calendar window
    const seedHash = hashSeed(symbol + ':' + timeframe);
    const anchorDay = 20320 + (seedHash % 90);      // ~2026-08-15 window ±45 days
    const endMs = Date.UTC(2026, 7, 15, 0, 0, 0) - ((anchorDay - 20320) % 90) * 86400000
        + (seedHash % 86400) * 1000;

    // walk backwards from the anchor to build the base series (so the last bar
    // is always recent), then return the LAST `count` bars — count never alters
    // the underlying series, only the window shown.
    let price = base;
    const bars = [];
    const target = maxBars + 64; // warm-up discarded later
    let t = Math.floor(endMs / 1000);
    let made = 0;
    while (made < target) {
        const d = new Date(t * 1000);
        if (isTradingDay(d)) {
            made++;
            bars.push({ t, price });
        }
        t -= tf;
    }
    bars.reverse();

    // regime walk over the collected slots
    const series = [];
    let drift = 0, regimeLen = 0, volMul = 1, trend = 0;
    for (let i = 0; i < bars.length; i++) {
        const slot = bars[i];
        if (regimeLen <= 0) {
            // new regime: trending (drift) or ranging, occasionally high-vol
            const roll = rand();
            trend = roll < 0.42 ? (rand() < 0.5 ? 1 : -1) * (0.00018 + rand() * 0.00045)
                : roll < 0.62 ? (rand() < 0.5 ? 1 : -1) * (0.00005 + rand() * 0.00012)
                : 0;
            volMul = roll > 0.9 ? 2.2 + rand() * 1.3 : 0.6 + rand() * 0.9;
            regimeLen = 18 + Math.floor(rand() * 60);
        }
        regimeLen--;
        drift = drift * 0.82 + trend * 0.18;
        const shock = (rand() * 2 - 1) * vol * volMul;
        const open = price;
        const close = Math.max(price * (1 + drift * 0.02 + shock * 0.6), base * 0.02);
        const wick = vol * volMul * (0.4 + rand() * 1.4) * (cat === 'Crypto' ? 2.2 : 1);
        const high = Math.max(open, close) * (1 + wick * (0.35 + rand() * 0.65));
        const low = Math.min(open, close) * (1 - wick * (0.35 + rand() * 0.65));
        const volume = Math.round((200 + rand() * 2600) * (1 + Math.abs(close - open) / (open * vol || 1)) * (cat === 'Crypto' ? 4 : 1));
        series.push({
            time: slot.t,
            open: roundP(open),
            high: roundP(high),
            low: roundP(low),
            close: roundP(close),
            volume
        });
        price = close;
    }

    const out = series.slice(-count);
    return {
        ok: true,
        symbol, timeframe, count: out.length,
        base: roundP(base),
        candles: out,
        meta: { category: cat, generator: 'seeded-regime-walk', deterministic: true }
    };
}

function roundP(n) {
    // keep enough decimals for sub-1 crypto
    const scale = n < 0.01 ? 1000000 : n < 1 ? 100000 : n < 100 ? 1000 : 100;
    return Math.round(n * scale) / scale;
}

module.exports = { generateCandles, categoryOf, TIMEFRAMES, DEFAULT_COUNTS };
