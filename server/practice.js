'use strict';

// ============================================================================
// 31TRADES — Practice Data Adapter
// ----------------------------------------------------------------------------
// Bridges the Backtest Simulation Engine into the canonical Analytics/Insights
// services WITHOUT touching live records. Recorded practice trades (per-user,
// data/backtest-<id>.json) are flattened into the same trade shape the shared
// analytics math already consumes, then run through the exact same
// computeAnalytics (exported by the core as `analyticsFrom`). One calculation,
// two sources — LIVE and BACKTEST stay distinguishable, per the architecture.
//
//   Sim sessions ─▶ flattenTrades() ─▶ analyticsFrom(list) ─▶ /api/practice/*
//                                        insightsFrom(list)
// ============================================================================

const Sim = require('./backtest-sim.js');

// map a recorded backtest trade to the canonical analytics trade shape
function toAnalyticsTrade(t) {
    return {
        id: t.id,
        account_id: 'practice',
        source: 'BACKTEST',
        session_id: t.sessionId,
        ts: (t.exitTime != null ? t.exitTime * 1000 : Date.now()),
        symbol: t.symbol,
        dir: t.direction === 'Long' ? 'Long' : 'Short',
        setup: t.setup || 'No setup',
        session: sessionOfTime(t.entryTime),
        strategy_id: t.strategy || 'Manual practice',
        pnl: t.pnl || 0,
        r: t.realizedR || 0,
        risk: t.riskAmount || 0,
        riskPct: t.riskPct || 0,
        holdBars: (t.exitIndex != null && t.entryIndex != null) ? t.exitIndex - t.entryIndex : 0,
        exitReason: t.exitReason || 'manual',
        plannedRR: t.plannedRR || 0,
        emotion: null,
        adherence: null
    };
}

// same session mapping the backtest engine uses for time-of-day breakdowns
function sessionOfTime(ts) {
    if (!ts) return '—';
    const h = new Date(ts * 1000).getUTCHours();
    if (h >= 13 && h < 21) return 'New York';
    if (h >= 7 && h < 13) return 'London';
    if (h >= 23 || h < 9) return 'Asia';
    return 'Sydney';
}

// flatten every recorded practice trade across the user's sessions
function flattenTrades(userId) {
    const out = [];
    for (const s of Sim.listSessions(userId)) {
        const sess = Sim.getSession(userId, s.id);
        if (!sess) continue;
        for (const t of sess.trades) out.push(toAnalyticsTrade(t));
    }
    return out;
}

// ---- canonical analytics over practice data (same math as live) ----
function analytics(userId, core, filters) {
    const f = filters || {};
    let list = flattenTrades(userId);
    if (f.symbol) list = list.filter(t => t.symbol === f.symbol);
    if (f.setup) list = list.filter(t => t.setup === f.setup);
    if (f.session) list = list.filter(t => t.session === f.session);
    if (f.direction) list = list.filter(t => t.dir === f.direction);
    if (f.result) list = list.filter(t => f.result === 'win' ? t.pnl > 0 : f.result === 'loss' ? t.pnl < 0 : t.pnl === 0);
    if (f.from) list = list.filter(t => new Date(t.ts) >= new Date(f.from));
    if (f.to) list = list.filter(t => new Date(t.ts) <= new Date(f.to));
    const base = (core && core.analyticsFrom) ? core.analyticsFrom(list) : null;
    const res = base || emptyAnalytics(list);
    res.source = 'BACKTEST';
    res.list = list;
    return res;
}

function emptyAnalytics(list) {
    return {
        n: list.length, net: 0, grossWin: 0, grossLoss: 0, winRate: 0, avgWin: 0, avgLoss: 0,
        avgTrade: 0, avgR: 0, expectancy: 0, pf: 0, maxDD: 0, recovery: 0, avgRisk: 0,
        curve: [], byStrategy: [], bySetup: [], bySymbol: [], bySession: [], byDirection: [], byRisk: [],
        streaks: { bestWin: 0, bestLoss: 0 }, maxEq: 0, minEq: 0
    };
}

// ---- practice insights — evidence-backed, never manufactured ----
// Uses the SAME grouped numbers as analytics() so findings always match the
// panels. Sample-size floors mirror the live insights service.
function insights(userId, core) {
    const a = analytics(userId, core, {});
    const list = a.list;
    const out = [];
    const push = (type, sev, title, detail, evidence, confidence) => {
        out.push({ id: 'pins-' + out.length + '-' + Math.random().toString(36).slice(2, 5), type, sev, title, detail, evidence, sample: evidence.length, confidence, status: 'open', source: 'BACKTEST' });
    };
    if (a.n < 5) {
        out.push({ id: 'pins-developing', type: 'developing', sev: 'neutral', title: 'Practice data is still developing', detail: 'Complete at least 5 recorded practice trades to unlock practice findings. Currently ' + a.n + '.', evidence: [], sample: a.n, confidence: 0, status: 'open', source: 'BACKTEST' });
        return out;
    }
    // strongest / weakest setup
    const setups = a.bySetup.filter(x => x.n >= 3);
    const best = setups[0];
    if (best) push('strength', 'positive', 'Best setup in practice', best.key + ' — ' + Math.round(best.winRate * 100) + '% win rate, ' + best.pnl + '$ net over ' + best.n + ' trades', list.filter(t => t.setup === best.key).map(t => t.id), 'high');
    const worst = setups.filter(x => x.winRate < 0.4).sort((x, y) => x.pnl - y.pnl)[0];
    if (worst && worst.n >= 3) push('weakness', 'negative', 'Setup to rework', worst.key + ' — ' + Math.round(worst.winRate * 100) + '% win rate, ' + worst.pnl + '$ net over ' + worst.n + ' trades', list.filter(t => t.setup === worst.key).map(t => t.id), 'high');
    // session performance
    const ses = a.bySession.filter(x => x.n >= 3)[0];
    if (ses) push('strength', 'positive', 'Best practice session', ses.key + ' — ' + ses.pnl + '$ net over ' + ses.n + ' trades', list.filter(t => t.session === ses.key).map(t => t.id), 'medium');
    // exit quality — SL dominance
    const slTrades = list.filter(t => t.exitReason === 'SL');
    const slRatio = list.length ? slTrades.length / list.length : 0;
    if (slRatio >= 0.6) {
        const cost = slTrades.reduce((s, t) => s + t.pnl, 0);
        push('risk', 'negative', 'Stops are doing the work', Math.round(slRatio * 100) + '% of practice exits are stop losses (' + cost + '$ net). Review where entries land relative to structure.', slTrades.map(t => t.id), 'high');
    }
    // premature entries — resolved within 2 bars
    const premature = list.filter(t => t.holdBars <= 2 && t.holdBars >= 0);
    if (premature.length >= 3) {
        push('behavior', 'negative', 'Premature entries in practice', premature.length + ' trades resolved within 2 bars of entry — a sign of entering before confirmation.', premature.map(t => t.id), 'high');
    }
    // risk inconsistency
    const risks = list.map(t => t.risk).filter(r => r > 0);
    if (risks.length >= 4) {
        const avg = risks.reduce((s, r) => s + r, 0) / risks.length;
        const sd = Math.sqrt(risks.reduce((s, r) => s + (r - avg) * (r - avg), 0) / risks.length);
        const cv = avg ? sd / avg : 0;
        if (cv > 0.35) push('risk', 'negative', 'Inconsistent risk in practice', 'Risk per trade varies by ' + Math.round(cv * 100) + '% (CV). Range ' + Math.min.apply(null, risks) + '–' + Math.max.apply(null, risks) + '$ over ' + risks.length + ' trades.', list.filter(t => t.risk > 0).map(t => t.id), 'high');
    }
    // after-loss behavior — next trade within 1 bar after a loss
    const bySessionSeq = list.slice().sort((x, y) => x.ts - y.ts);
    const revenge = [];
    for (let i = 1; i < bySessionSeq.length; i++) {
        if (bySessionSeq[i - 1].pnl < 0 && bySessionSeq[i].holdBars <= 1) revenge.push(bySessionSeq[i].id);
    }
    if (revenge.length >= 2) push('behavior', 'negative', 'Re-entry right after a loss', revenge.length + ' trades entered within a bar of a losing trade — check for revenge behavior.', revenge, 'medium');
    // positive: streak or edge
    if (a.streaks.bestWin >= 3) push('strength', 'positive', 'Practice win streak', a.streaks.bestWin + ' consecutive wins in practice — identify what you did differently.', list.filter(t => t.pnl > 0).slice(-a.streaks.bestWin).map(t => t.id), 'medium');
    if (!out.some(x => x.sev === 'positive')) push('strength', 'positive', 'Practice sample is clean', 'No recurring negative patterns in your practice trades yet — keep logging.', list.map(t => t.id), 'low');
    return out;
}

module.exports = { flattenTrades, analytics, insights, toAnalyticsTrade, sessionOfTime };
