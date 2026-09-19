'use strict';

// ============================================================================
// 31TRADES — Backtest History Analytics (cross-session aggregation)
// ----------------------------------------------------------------------------
// Pure aggregation over COMPLETED backtest sessions' closed trades. Powers the
// BattleX historical analytics hierarchy:
//
//     YEAR → MONTH → SESSION / STRATEGY / ASSET → TRADE → TRADE DETAILS
//
// Design invariants:
//   · Pure functions — no I/O, no persistence. Callers pass in sessions
//     (hydrated BacktestSession instances or plain fixture objects with the
//     same fields). A Postgres swap later changes only the caller.
//   · Live sessions feed history in real time: every CLOSED trade is
//     included the moment it settles (spec 13 — real-time analytics sync,
//     no waiting for session completion). Open positions have no trade
//     record yet, so they contribute nothing. Blind-mode masking still
//     holds: blind sessions expose actualPeriod only after completion.
//     The optional LIVE_EXCLUDED filter keeps completed-only callers alive.
//   · Legacy compatibility: trades recorded before session/year/month were
//     stored on the trade object are derived on read from entryTime.
//   · Extensible dimensions: one new accessor in DIMENSIONS = one new
//     analytics breakdown. No schema or aggregation redesign needed.
//
// Session rules (UTC, non-overlapping, configurable via TRADEMIND_SESSIONS
// env JSON — an array of { name, start, end } covering 0–24):
//     Asian 00–07 · London 07–12 · New York AM 12–16 · New York PM 16–21 ·
//     Sydney 21–24
// ============================================================================

// ---------------------------------------------------------------------------
// Session classification
// ---------------------------------------------------------------------------
const DEFAULT_SESSION_RULES = [
    { name: 'Asian', start: 0, end: 7 },
    { name: 'London', start: 7, end: 12 },
    { name: 'New York AM', start: 12, end: 16 },
    { name: 'New York PM', start: 16, end: 21 },
    { name: 'Sydney', start: 21, end: 24 }
];

function loadSessionRules() {
    try {
        const raw = process.env.TRADEMIND_SESSIONS;
        if (!raw) return DEFAULT_SESSION_RULES;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || !arr.length) return DEFAULT_SESSION_RULES;
        const rules = arr
            .map(r => ({ name: String(r.name), start: Number(r.start), end: Number(r.end) }))
            .filter(r => r.name && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end <= 24 && r.end > r.start)
            .sort((a, b) => a.start - b.start);
        return rules.length ? rules : DEFAULT_SESSION_RULES;
    } catch (e) {
        return DEFAULT_SESSION_RULES;
    }
}

/** Normalize a timestamp (unix seconds, unix ms, or ISO string) → unix seconds. */
function toUnixSec(ts) {
    if (ts == null) return null;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
        return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts); // ms → s
    }
    if (typeof ts === 'string') {
        const t = Date.parse(ts);
        return Number.isFinite(t) ? Math.floor(t / 1000) : null;
    }
    return null;
}

/** Classify a timestamp into a trading session name (UTC rules). */
function classifySession(ts) {
    const sec = toUnixSec(ts);
    if (sec == null) return '—';
    const h = new Date(sec * 1000).getUTCHours();
    const rules = loadSessionRules();
    for (const r of rules) {
        if (h >= r.start && h < r.end) return r.name;
    }
    return '—';
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------------------
// Extensible analytics dimensions (spec 10) — one accessor per breakdown
// ---------------------------------------------------------------------------
const DIMENSIONS = {
    session: { label: 'Session', keyFn: t => t.session },
    strategy: { label: 'Strategy', keyFn: t => t.strategy || 'Unclassified' },
    asset: { label: 'Asset', keyFn: t => t.symbol || t.asset || 'Unknown' },
    direction: { label: 'Direction', keyFn: t => t.direction },
    setup: { label: 'Setup', keyFn: t => t.setup || 'No setup' },
    tag: { label: 'Tag', keyFn: t => (Array.isArray(t.tags) && t.tags.length ? t.tags : ['Untagged']) },
    dow: { label: 'Day of Week', keyFn: t => t.dow },
    hour: { label: 'Hour of Day', keyFn: t => t.hour },
    rBucket: {
        label: 'R Bucket',
        keyFn: t => {
            const r = Number(t.realizedR) || 0;
            if (r <= -2) return '≤ -2R';
            if (r < -1) return '-2R to -1R';
            if (r < 0) return '-1R to 0R';
            if (r === 0) return '0R';
            if (r < 1) return '0R to 1R';
            if (r < 2) return '1R to 2R';
            if (r < 3) return '2R to 3R';
            return '≥ 3R';
        }
    },
    duration: {
        label: 'Duration',
        keyFn: t => {
            const s = t.durationSec || 0;
            if (s < 300) return '< 5m';
            if (s < 900) return '5–15m';
            if (s < 3600) return '15–60m';
            if (s < 4 * 3600) return '1–4h';
            if (s < 24 * 3600) return '4–24h';
            return '> 24h';
        }
    }
};

// ---------------------------------------------------------------------------
// Trade collection + enrichment
// ---------------------------------------------------------------------------

/** Enrich one raw trade with analytics fields (stored values win; legacy derived). */
function enrichTrade(t, session) {
    const sec = toUnixSec(t.entryTime);
    const d = sec != null ? new Date(sec * 1000) : null;
    const exitSec = toUnixSec(t.exitTime);
    const sessionName = t.session || classifySession(t.entryTime);
    return {
        ...t,
        session: sessionName,
        year: t.year != null ? t.year : (d ? d.getUTCFullYear() : null),
        month: t.month != null ? t.month : (d ? d.getUTCMonth() + 1 : null),
        dow: d ? DOW_NAMES[d.getUTCDay()] : '—',
        hour: d ? (String(d.getUTCHours()).padStart(2, '0') + ':00') : '—',
        durationSec: exitSec != null && sec != null ? Math.max(0, exitSec - sec) : 0,
        tags: Array.isArray(t.tags) ? t.tags : [],
        asset: t.symbol || t.asset || (session && session.symbol) || 'Unknown',
        sessionId: t.sessionId || (session && session.id) || null,
        strategy: t.strategy || (session && session.strategy) || 'Unclassified'
    };
}

/**
 * All closed trades, enriched — real-time (live + completed sessions).
 * A closed trade enters the YEAR→MONTH→SESSION→TRADE hierarchy the moment
 * it settles, regardless of session status. Sessions may optionally set
 * `analyticsExcluded = true` (e.g. blind mode pre-completion) to opt out.
 */
function collectTrades(sessions) {
    const out = [];
    const list = Array.isArray(sessions) ? sessions : [];
    list.forEach(s => {
        if (!s || s.analyticsExcluded) return;
        const trades = Array.isArray(s.trades) ? s.trades : [];
        trades.forEach(t => { if (t) out.push(enrichTrade(t, s)); });
    });
    return out;
}

// ---------------------------------------------------------------------------
// Grouping + metrics
// ---------------------------------------------------------------------------
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

function groupAggregate(trades, keyFn) {
    const map = new Map();
    trades.forEach(t => {
        const keys = keyFn(t);
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
            const key = k == null || k === '' ? '—' : String(k);
            if (!map.has(key)) map.set(key, { key, trades: 0, wins: 0, net: 0, totalR: 0, grossP: 0, grossL: 0 });
            const g = map.get(key);
            g.trades++;
            if (t.pnl > 0) g.wins++;
            g.net += t.pnl || 0;
            g.totalR += Number(t.realizedR) || 0;
            if (t.pnl > 0) g.grossP += t.pnl; else g.grossL += Math.abs(t.pnl || 0);
        });
    });
    return Array.from(map.values()).map(g => ({
        key: g.key,
        trades: g.trades,
        wins: g.wins,
        winRate: g.trades ? round2((g.wins / g.trades) * 100) : 0,
        net: round2(g.net),
        avgR: g.trades ? round3(g.totalR / g.trades) : 0,
        totalR: round3(g.totalR),
        profitFactor: g.grossL > 0 ? round2(g.grossP / g.grossL) : (g.grossP > 0 ? null : 0)
    }));
}

function headlineMetrics(trades, startingCapital) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const net = trades.reduce((a, t) => a + (t.pnl || 0), 0);
    const grossP = wins.reduce((a, t) => a + t.pnl, 0);
    const grossL = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const totalR = trades.reduce((a, t) => a + (Number(t.realizedR) || 0), 0);
    // drawdown over the cumulative P&L path (chronological by exit)
    const ordered = trades.slice().sort((a, b) => (toUnixSec(a.exitTime) || 0) - (toUnixSec(b.exitTime) || 0));
    let cum = 0, peak = 0, maxDD = 0;
    const equity = [];
    ordered.forEach(t => {
        cum += t.pnl || 0;
        if (cum > peak) peak = cum;
        const dd = peak - cum;
        if (dd > maxDD) maxDD = dd;
        equity.push({ t: toUnixSec(t.exitTime), balance: round2((startingCapital || 0) + cum) });
    });
    const sorted = trades.slice().sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
    const cap = startingCapital > 0 ? startingCapital : 0;
    return {
        net: round2(net),
        returnPct: cap > 0 ? round2((net / cap) * 100) : 0,
        totalR: round3(totalR),
        trades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: trades.length ? round2((wins.length / trades.length) * 100) : 0,
        avgR: trades.length ? round3(totalR / trades.length) : 0,
        profitFactor: grossL > 0 ? round2(grossP / grossL) : (grossP > 0 ? null : 0),
        maxDrawdown: round2(maxDD),
        maxDrawdownPct: cap > 0 ? round2((maxDD / cap) * 100) : 0,
        bestTrade: compactTrade(sorted[0] || null),
        worstTrade: compactTrade(sorted[sorted.length - 1] || null),
        equity
    };
}

/** JSON-safe compact trade for best/worst references and drill-down lists. */
function compactTrade(t) {
    if (!t) return null;
    return {
        id: t.id || null,
        sessionId: t.sessionId || null,
        asset: t.asset,
        symbol: t.asset,
        direction: t.direction,
        session: t.session,
        strategy: t.strategy,
        setup: t.setup || '',
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        entry: t.entry,
        exit: t.exit,
        sl: t.sl,
        tp: t.tp,
        size: t.size,
        riskPct: t.riskPct,
        pnl: t.pnl,
        realizedR: t.realizedR,
        result: t.result,
        exitReason: t.exitReason,
        tags: t.tags
    };
}

function bestAndWorstGroup(rows) {
    if (!rows.length) return { best: null, worst: null };
    const sorted = rows.slice().sort((a, b) => (b.net - a.net) || (b.winRate - a.winRate));
    return { best: sorted[0].key, worst: sorted[sorted.length - 1].key };
}

/** Starting capital = sum of starting balances of sessions contributing trades in scope. */
function startingCapitalFor(trades, sessions) {
    const ids = new Set(trades.map(t => t.sessionId).filter(Boolean));
    let sum = 0;
    (Array.isArray(sessions) ? sessions : []).forEach(s => {
        if (ids.has(s.id) && Number.isFinite(Number(s.startingBalance))) sum += Number(s.startingBalance);
    });
    return sum;
}

// ---------------------------------------------------------------------------
// Public query API — year index → month cards → month detail → trade drill-down
// ---------------------------------------------------------------------------

/** Spec 5 — available years with headline stats (year cards). */
function historyYears(sessions) {
    const trades = collectTrades(sessions).filter(t => t.year != null);
    const byYear = new Map();
    trades.forEach(t => {
        if (!byYear.has(t.year)) byYear.set(t.year, []);
        byYear.get(t.year).push(t);
    });
    const years = Array.from(byYear.keys()).sort((a, b) => b - a).map(year => {
        const yt = byYear.get(year);
        const h = headlineMetrics(yt, 0);
        const sessionIds = new Set(yt.map(t => t.sessionId).filter(Boolean));
        return {
            year,
            trades: yt.length,
            sessions: sessionIds.size,
            net: h.net,
            totalR: h.totalR,
            winRate: h.winRate,
            months: Array.from(new Set(yt.map(t => t.month).filter(Boolean))).sort((a, b) => a - b)
        };
    });
    return { years };
}

/** Spec 6 — month cards for one year. */
function historyMonths(sessions, year) {
    const y = Number(year);
    if (!Number.isInteger(y)) return { year, months: [] };
    const trades = collectTrades(sessions).filter(t => t.year === y);
    const byMonth = new Map();
    trades.forEach(t => {
        if (t.month == null) return;
        if (!byMonth.has(t.month)) byMonth.set(t.month, []);
        byMonth.get(t.month).push(t);
    });
    const months = Array.from(byMonth.keys()).sort((a, b) => a - b).map(m => {
        const mt = byMonth.get(m);
        const h = headlineMetrics(mt, 0);
        const sessRows = groupAggregate(mt, DIMENSIONS.session.keyFn);
        const bw = bestAndWorstGroup(sessRows);
        return {
            month: m,
            label: (MONTH_NAMES[m - 1] || m) + ' ' + y,
            trades: mt.length,
            net: h.net,
            totalR: h.totalR,
            winRate: h.winRate,
            avgR: h.avgR,
            bestSession: bw.best,
            worstSession: bw.worst
        };
    });
    return { year: y, months };
}

/** Spec 7–10 — full analytics for one month (headline + all dimension breakdowns + trades). */
function historyMonthDetail(sessions, year, month) {
    const y = Number(year), m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
        return { error: 'invalid year/month' };
    }
    const all = collectTrades(sessions);
    const trades = all.filter(t => t.year === y && t.month === m);
    const capital = startingCapitalFor(trades, sessions);
    const headline = headlineMetrics(trades, capital);

    const bySession = groupAggregate(trades, DIMENSIONS.session.keyFn);
    const bwSession = bestAndWorstGroup(bySession);
    const byStrategy = groupAggregate(trades, DIMENSIONS.strategy.keyFn);
    const bwStrategy = bestAndWorstGroup(byStrategy);
    const byAsset = groupAggregate(trades, DIMENSIONS.asset.keyFn);

    const card = {
        year: y,
        month: m,
        label: (MONTH_NAMES[m - 1] || m) + ' ' + y,
        trades: trades.length,
        net: headline.net,
        totalR: headline.totalR,
        winRate: headline.winRate,
        avgR: headline.avgR,
        bestSession: bwSession.best,
        worstSession: bwSession.worst
    };

    return {
        card,
        headline,
        bySession,
        byStrategy,
        byAsset,
        bestStrategy: bwStrategy.best,
        worstStrategy: bwStrategy.worst,
        byDirection: groupAggregate(trades, DIMENSIONS.direction.keyFn),
        byDayOfWeek: groupAggregate(trades, DIMENSIONS.dow.keyFn),
        byHour: groupAggregate(trades, DIMENSIONS.hour.keyFn),
        bySetup: groupAggregate(trades, DIMENSIONS.setup.keyFn),
        byTag: groupAggregate(trades, DIMENSIONS.tag.keyFn),
        byRBucket: groupAggregate(trades, DIMENSIONS.rBucket.keyFn),
        byDuration: groupAggregate(trades, DIMENSIONS.duration.keyFn),
        trades: trades.map(compactTrade)
    };
}

/** Spec 11 — drill-down query engine. Filters combine with AND; pagination via limit/offset. */
function queryTrades(sessions, filter) {
    const f = filter || {};
    let trades = collectTrades(sessions);
    if (f.year != null && f.year !== '') { const y = Number(f.year); if (Number.isInteger(y)) trades = trades.filter(t => t.year === y); }
    if (f.month != null && f.month !== '') { const m = Number(f.month); if (Number.isInteger(m) && m >= 1 && m <= 12) trades = trades.filter(t => t.month === m); }
    if (f.session) trades = trades.filter(t => t.session === f.session);
    if (f.strategy) trades = trades.filter(t => t.strategy === f.strategy);
    if (f.symbol || f.asset) trades = trades.filter(t => t.asset === (f.symbol || f.asset));
    if (f.direction) trades = trades.filter(t => t.direction === f.direction);
    if (f.setup) trades = trades.filter(t => t.setup === f.setup);
    if (f.result) trades = trades.filter(t => t.result === f.result);
    if (f.tag) trades = trades.filter(t => t.tags.includes(f.tag));
    const total = trades.length;
    const offset = Math.max(0, Number(f.offset) || 0);
    const limit = Math.min(1000, Math.max(1, Number(f.limit) || 200));
    const page = trades
        .slice()
        .sort((a, b) => (toUnixSec(b.entryTime) || 0) - (toUnixSec(a.entryTime) || 0))
        .slice(offset, offset + limit)
        .map(compactTrade);
    return { total, limit, offset, trades: page };
}

module.exports = {
    DEFAULT_SESSION_RULES,
    classifySession,
    collectTrades,
    enrichTrade,
    compactTrade,
    groupAggregate,
    headlineMetrics,
    DIMENSIONS,
    historyYears,
    historyMonths,
    historyMonthDetail,
    queryTrades,
    MONTH_NAMES
};
