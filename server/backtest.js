'use strict';

// ============================================================================
// 31TRADES — Backtest data service
// ----------------------------------------------------------------------------
// Serves deterministic historical OHLCV candles for the Backtesting page
// (FX Replay-style charting). When a specific Year & Month is requested
// (e.g. 2024-10, 2021-05), candles are generated spanning that exact calendar
// month with era-appropriate asset base prices, authentic trading sessions
// (Asia, London Open, New York Overlap), and deterministic seeded walk.
// Supports Blind / Mystery mode (dates masked to prevent hindsight bias).
// If no period is specified, defaults to the canonical anchor series.
// ============================================================================

const TIMEFRAMES = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, 'w': 604800, 'm': 2592000 };

const DEFAULT_COUNTS = { '1m': 720, '5m': 500, '15m': 400, '30m': 350, '1h': 320, '2h': 260, '4h': 240, '1d': 200, 'w': 100, 'm': 50 };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

// ---- historical era base prices by year (for realistic market feel) ----
const ERA_PRICE_ADJUST = {
    BTC: { 2018: 6500, 2019: 7200, 2020: 10500, 2021: 47000, 2022: 21000, 2023: 28000, 2024: 63000, 2025: 88000, 2026: 92000 },
    ETH: { 2018: 300, 2019: 180, 2020: 380, 2021: 3400, 2022: 1300, 2023: 1850, 2024: 3100, 2025: 3600, 2026: 3800 },
    SOL: { 2020: 3, 2021: 160, 2022: 32, 2023: 24, 2024: 145, 2025: 190, 2026: 210 },
    XAUUSD: { 2018: 1250, 2019: 1400, 2020: 1800, 2021: 1800, 2022: 1750, 2023: 1940, 2024: 2400, 2025: 2650, 2026: 2750 },
    EURUSD: { 2018: 1.16, 2019: 1.11, 2020: 1.14, 2021: 1.18, 2022: 1.02, 2023: 1.08, 2024: 1.08, 2025: 1.07, 2026: 1.08 },
    GBPUSD: { 2018: 1.33, 2019: 1.28, 2020: 1.30, 2021: 1.37, 2022: 1.20, 2023: 1.25, 2024: 1.28, 2025: 1.29, 2026: 1.30 },
    USDJPY: { 2018: 110, 2019: 108, 2020: 106, 2021: 112, 2022: 135, 2023: 142, 2024: 155, 2025: 153, 2026: 152 },
    NAS100: { 2018: 7000, 2019: 8200, 2020: 11500, 2021: 15500, 2022: 12000, 2023: 15000, 2024: 19500, 2025: 21000, 2026: 21800 },
    SPX500: { 2018: 2750, 2019: 3000, 2020: 3400, 2021: 4400, 2022: 3900, 2023: 4400, 2024: 5500, 2025: 5800, 2026: 6000 }
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
    const cat = categoryOf(symbol);

    // Check if period is specified (e.g. '2024-10', '2023-05', or 'random')
    let rawPeriod = String(o.period || '').trim().toLowerCase();
    let isBlind = !!(o.blind || o.isRandom || rawPeriod === 'random');
    let year = null, monthIndex = null, periodKey = null;

    if (isBlind || rawPeriod === 'random') {
        const randSeed = hashSeed(symbol + ':' + timeframe + ':' + (o.seed || 'blind_v1'));
        const blindRand = mulberry32(randSeed);
        const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
        year = years[Math.floor(blindRand() * years.length)];
        monthIndex = Math.floor(blindRand() * 12); // 0-11
        periodKey = year + '-' + String(monthIndex + 1).padStart(2, '0');
        isBlind = true;
    } else if (/^[0-9]{4}-[0-9]{2}$/.test(rawPeriod)) {
        year = parseInt(rawPeriod.slice(0, 4), 10);
        monthIndex = parseInt(rawPeriod.slice(5, 7), 10) - 1;
        if (monthIndex < 0 || monthIndex > 11) monthIndex = 0;
        periodKey = rawPeriod;
    }

    // Historical Period Branch: generate bars for the specified calendar month
    if (year !== null && monthIndex !== null) {
        const monthLabel = (MONTH_NAMES[monthIndex] || 'Month') + ' ' + year;
        const startMs = Date.UTC(year, monthIndex, 1, 0, 0, 0);
        const endMs = Date.UTC(year, monthIndex + 1, 0, 23, 59, 59);

        // Era-adjusted base price
        const symAdjust = ERA_PRICE_ADJUST[symbol] || ERA_PRICE_ADJUST[symbol.replace(/USD$/, '')];
        const base = (symAdjust && symAdjust[year]) ? symAdjust[year] : (BASE_PRICE[symbol] || 100);
        const vol = volatilityFor(symbol, tf);
        const rand = mulberry32(hashSeed(symbol + ':' + timeframe + ':' + periodKey + ':v2'));

        const slots = [];
        let curr = startMs;
        while (curr <= endMs) {
            const d = new Date(curr);
            if (cat === 'Crypto' || isTradingDay(d)) {
                slots.push({ t: Math.floor(curr / 1000), date: d });
            }
            curr += (tf * 1000);
        }

        let price = base;
        const series = [];
        let drift = 0, regimeLen = 0, volMul = 1, trend = 0;

        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const utcHour = slot.date.getUTCHours();

            // Intraday session tags & volatility
            let session = 'close';
            let sessionVolMul = 0.85;
            if (utcHour >= 0 && utcHour < 7) {
                session = 'asia';
                sessionVolMul = 0.7;
            } else if (utcHour >= 7 && utcHour < 12) {
                session = 'london';
                sessionVolMul = 1.45;
            } else if (utcHour >= 12 && utcHour < 17) {
                session = 'ny';
                sessionVolMul = 1.75;
            }

            if (regimeLen <= 0) {
                const roll = rand();
                trend = roll < 0.45 ? (rand() < 0.5 ? 1 : -1) * (0.00022 + rand() * 0.0005)
                    : roll < 0.65 ? (rand() < 0.5 ? 1 : -1) * (0.00006 + rand() * 0.00015)
                    : 0;
                volMul = (roll > 0.88 ? 2.0 + rand() * 1.2 : 0.65 + rand() * 0.85) * sessionVolMul;
                regimeLen = 14 + Math.floor(rand() * 50);
            }
            regimeLen--;
            drift = drift * 0.8 + trend * 0.2;

            const shock = (rand() * 2 - 1) * vol * volMul;
            const open = price;
            const close = Math.max(price * (1 + drift * 0.02 + shock * 0.6), base * 0.02);
            const wick = vol * volMul * (0.4 + rand() * 1.3) * (cat === 'Crypto' ? 2.0 : 1);
            const high = Math.max(open, close) * (1 + wick * (0.35 + rand() * 0.65));
            const low = Math.min(open, close) * (1 - wick * (0.35 + rand() * 0.65));
            const volume = Math.round((250 + rand() * 3200) * sessionVolMul * (1 + Math.abs(close - open) / (open * vol || 1)));

            let barTime = slot.t;
            if (isBlind) {
                barTime = Math.floor(Date.UTC(2026, 0, 1) / 1000) + (i * tf);
            }

            series.push({
                time: barTime,
                open: roundP(open),
                high: roundP(high),
                low: roundP(low),
                close: roundP(close),
                volume,
                session
            });
            price = close;
        }

        const maxBars = 1500;
        const count = Math.max(30, Math.min(maxBars, Number(o.count) || series.length));
        const out = series.length > count ? series.slice(0, count) : series;

        return {
            ok: true,
            symbol,
            timeframe,
            period: periodKey,
            periodLabel: isBlind ? 'Blind Mystery Period' : monthLabel,
            count: out.length,
            base: roundP(base),
            candles: out,
            meta: {
                category: cat,
                generator: 'historical-period-engine',
                period: periodKey,
                periodLabel: isBlind ? 'Blind Mystery Period' : monthLabel,
                blind: isBlind,
                actualPeriod: periodKey,
                actualLabel: monthLabel,
                deterministic: true
            }
        };
    }

    // Default Anchor Branch (original implementation for backward compatibility & tests)
    const maxBars = 1500;
    const count = Math.max(30, Math.min(maxBars, Number(o.count) || (DEFAULT_COUNTS[timeframe] || 320)));

    const rand = mulberry32(hashSeed(symbol + ':' + timeframe + ':v1'));
    const base = BASE_PRICE[symbol] || 100;
    const vol = volatilityFor(symbol, tf);

    const seedHash = hashSeed(symbol + ':' + timeframe);
    const anchorDay = 20320 + (seedHash % 90);
    const endMs = Date.UTC(2026, 7, 15, 0, 0, 0) - ((anchorDay - 20320) % 90) * 86400000
        + (seedHash % 86400) * 1000;

    let price = base;
    const bars = [];
    const target = maxBars + 64;
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

    const series = [];
    let drift = 0, regimeLen = 0, volMul = 1, trend = 0;
    for (let i = 0; i < bars.length; i++) {
        const slot = bars[i];
        if (regimeLen <= 0) {
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
    const scale = n < 0.01 ? 1000000 : n < 10 ? 100000 : n < 100 ? 1000 : 100;
    return Math.round(n * scale) / scale;
}

module.exports = { generateCandles, categoryOf, TIMEFRAMES, DEFAULT_COUNTS, MONTH_NAMES, ERA_PRICE_ADJUST };
