/* ============================================================================
   31TRADES — Shared demo trade data (single source of truth for demo builds)
   Used by insights.html and analytics.html so every page reconciles to the
   same numbers (PRD §31 — Calculation Integrity).
   Deterministic: same seed + same date => identical trade history.
   ========================================================================== */
(function () {
    'use strict';

    const day = 864e5;

    // Fixed anchor date so every page generates the IDENTICAL trade history
    // regardless of when it loads (single source of truth — PRD §31).
    const ANCHOR = new Date(2026, 7, 12, 12, 0, 0); // Wed Aug 12, 2026 12:00

    // ---- PRNG (deterministic) ----
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    // Hash helper for derived fields — deterministic, no extra rnd() calls so
    // the rng sequence (and therefore the trades) stays identical everywhere.
    function h(n) {
        const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
        return x - Math.floor(x);
    }

    const SETUPS = ['MSS + FVG', 'FVG', 'Breakout', 'Order Block'];
    // One representative symbol per major asset class — the demo journal spans
    // Forex, Commodities (metals/energy), Indices, Crypto and Stocks.
    const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'USOIL', 'NAS100', 'US30', 'BTCUSD', 'ETHUSD', 'AAPL', 'TSLA'];
    const SESSIONS = ['London', 'New York', 'Asia'];
    const EMOTIONS = ['Calm', 'Confident', 'Anxious'];
    const ASSET_CLASS = { EURUSD: 'Forex', GBPUSD: 'Forex', USDJPY: 'Forex', XAUUSD: 'Commodities', USOIL: 'Commodities', NAS100: 'Indices', US30: 'Indices', BTCUSD: 'Crypto', ETHUSD: 'Crypto', AAPL: 'Stocks', TSLA: 'Stocks' };
    const TIMEFRAMES = ['M5', 'M15', 'H1', 'H4'];
    const NOTES = [
        'Waited for sweep and confirmation before entry.',
        'Entered at the open after the news spike settled.',
        'Chased the move late — entry not ideal.',
        'Clean setup, managed to BE before letting it run.',
        'Strong follow-through, closed into resistance.',
        'Small size to test the idea — valid but cautious.',
        'Stop slightly wide; would tighten next time.',
        'Perfect execution, thesis played out exactly.',
        'Left early — MFE showed more was available.',
        'Mixed signals; should have waited for the next session.'
    ];

    function genTrades() {
        const rnd = mulberry32(20260811);
        const trades = [];
        const now = ANCHOR;
        let prev = null;

        for (let back = 89; back >= 0; back--) {
            const date = new Date(now.getTime() - back * day);
            const dow = date.getDay();
            if (dow === 0 || dow === 6) continue;
            const n = 0.4 + rnd() * 3.6; // 0-4 trades/day, mostly 1-3
            const dayCount = Math.floor(n);
            for (let i = 0; i < dayCount; i++) {
                const t = new Date(date);
                // session by hour
                const sessRoll = rnd();
                const session = sessRoll < 0.45 ? 'London' : sessRoll < 0.85 ? 'New York' : 'Asia';
                const hourBase = session === 'London' ? 7 : session === 'New York' ? 13 : 1;
                t.setHours(hourBase + Math.floor(rnd() * 4), Math.floor(rnd() * 60), 0, 0);

                const postLoss = prev && prev.pnl < 0;
                const rawEmotion = rnd();
                let emotion;
                if (postLoss && rawEmotion > 0.62) emotion = rnd() > 0.5 ? 'Revenge' : 'FOMO';
                else emotion = EMOTIONS[Math.floor(rnd() * EMOTIONS.length)];

                const setup = SETUPS[Math.floor(rnd() * SETUPS.length)];
                const risk = Math.min(60, Math.round((20 + rnd() * 15 + (postLoss ? 12 : 0) + (emotion === 'Revenge' ? 8 : 0)) / 5) * 5);

                let adherence = 'followed';
                const vRoll = rnd();
                if (emotion === 'FOMO' || emotion === 'Revenge') { if (vRoll > 0.42) adherence = rnd() > 0.5 ? 'no-plan' : 'early exit'; }
                else if (vRoll > 0.88) adherence = rnd() > 0.5 ? 'moving stop' : 'early exit';

                // win probability model
                let wp = 0.62;
                if (setup === 'MSS + FVG') wp += 0.06;
                if (setup === 'Breakout') wp -= 0.06;
                if (emotion === 'FOMO' || emotion === 'Revenge') wp *= 0.55;
                if (adherence !== 'followed') wp *= 0.6;

                const win = rnd() < wp;
                const r = win
                    ? Math.round((0.6 + rnd() * 2.4) * 100) / 100
                    : -Math.round((0.5 + rnd() * 1.3) * 100) / 100;
                const pnl = Math.round(r * risk);

                const symbol = SYMBOLS[Math.floor(rnd() * SYMBOLS.length)];
                const dir = rnd() > 0.5 ? 'Long' : 'Short';
                const tsNum = t.getTime();

                // ---- derived fields (hash-based; no extra rnd() calls) ----
                const strategy = setup; // demo: strategy === primary setup
                const assetClass = ASSET_CLASS[symbol];
                const timeframe = TIMEFRAMES[Math.floor(h(tsNum) * TIMEFRAMES.length)];
                const holdMin = Math.round(8 + h(tsNum + 1) * 232); // 8..240 min
                const notes = NOTES[Math.floor(h(tsNum + 2) * NOTES.length)];

                const trade = {
                    ts: t, symbol, dir,
                    setup, strategy, session, emotion, adherence, risk, r, pnl,
                    assetClass, timeframe, holdMin, notes,
                    hour: t.getHours(), dow: t.getDay(),
                    delayMin: prev ? Math.round((t - prev.ts) / 60000) : null,
                    postLoss: !!postLoss
                };
                trades.push(trade);
                prev = trade;
            }
        }
        return trades;
    }

    // ---- Stats (single implementation shared by all pages) ----
    function stats(list) {
        const n = list.length;
        const wins = list.filter(t => t.pnl > 0);
        const losses = list.filter(t => t.pnl < 0);
        const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const avgR = n ? list.reduce((s, t) => s + t.r, 0) / n : 0;
        // max drawdown from equity curve
        let eq = 0, peak = 0, maxDD = 0, maxEq = 0, minEq = 0;
        list.slice().sort((a, b) => a.ts - b.ts).forEach(t => {
            eq += t.pnl;
            peak = Math.max(peak, eq);
            maxDD = Math.max(maxDD, peak - eq);
            maxEq = Math.max(maxEq, eq);
            minEq = Math.min(minEq, eq);
        });
        return {
            n,
            pnl: list.reduce((s, t) => s + t.pnl, 0),
            winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
            avgWinR: wins.length ? wins.reduce((s, t) => s + t.r, 0) / wins.length : 0,
            avgLossR: losses.length ? losses.reduce((s, t) => s + t.r, 0) / losses.length : 0,
            avgWin$: wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
            avgLoss$: losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
            expectancy: avgR,
            pf: grossLoss ? grossWin / grossLoss : wins.length ? 3 : 0,
            grossWin, grossLoss,
            avgTrade: n ? list.reduce((s, t) => s + t.pnl, 0) / n : 0,
            maxDD,
            recovery: maxDD ? list.reduce((s, t) => s + t.pnl, 0) / maxDD : 0,
            avgRisk: n ? list.reduce((s, t) => s + t.risk, 0) / n : 0,
            maxRisk: n ? Math.max(...list.map(t => t.risk)) : 0,
            avgHold: n ? list.reduce((s, t) => s + (t.holdMin || 0), 0) / n : 0,
            maxEq, minEq
        };
    }

    function confidence(n) {
        if (n < 10) return { label: 'Not enough data', cls: 'tag-gray', dot: '#6E6E78', msg: 'Log at least 10 trades to unlock insights.' };
        if (n < 30) return { label: 'Early signal', cls: 'tag-amber', dot: '#F59E0B', msg: 'Patterns shown are low-confidence — keep journaling.' };
        if (n < 80) return { label: 'Developing', cls: 'tag-blue', dot: '#3B82F6', msg: 'Sample is growing; trends are forming.' };
        return { label: 'High confidence', cls: 'tag-emerald', dot: '#34D399', msg: 'Strong evidence from ' + n + ' trades.' };
    }

    function groupBy(list, key) {
        const map = {};
        list.forEach(t => {
            const k = typeof key === 'function' ? key(t) : t[key];
            (map[k] = map[k] || []).push(t);
        });
        return map;
    }

    // ---- Formatters ----
    const fmtMoney = n => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const fmtR = n => (n >= 0 ? '+' : '') + Number(n).toFixed(2) + 'R';
    const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;

    const DemoTrades = {
        day, ANCHOR, mulberry32, SETUPS, SYMBOLS, SESSIONS, EMOTIONS, ASSET_CLASS, TIMEFRAMES,
        genTrades, stats, confidence, groupBy,
        fmtMoney, fmtR, pct
    };

    if (typeof window !== 'undefined') window.DemoTrades = DemoTrades;
    if (typeof module !== 'undefined' && module.exports) module.exports = DemoTrades;
})();
