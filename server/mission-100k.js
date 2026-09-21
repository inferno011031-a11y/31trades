'use strict';

// Mission 100K is a read model, never a second trade ledger. It consumes the
// account's canonical trades and engine snapshots and returns deterministic
// rung/checkpoint progress.
const RUNG_GATES = [
    { rung: 1, target: 10000, label: '$10K', gates: ['50+ journaled trades', 'discipline score ≥ 70'] },
    { rung: 2, target: 20000, label: '$20K', gates: ['max drawdown < 15% of peak equity'] },
    { rung: 3, target: 30000, label: '$30K', gates: ['profit factor ≥ 1.5 across the rung'] },
    { rung: 4, target: 40000, label: '$40K', gates: ['one full month with zero rule violations'] },
    { rung: 5, target: 50000, label: '$50K', gates: ['100 journaled session days', 'backtest proof of edge'] },
    { rung: 6, target: 60000, label: '$60K', gates: ['average R ≥ 0.4'] },
    { rung: 7, target: 70000, label: '$70K', gates: ['two consecutive profitable months'] },
    { rung: 8, target: 80000, label: '$80K', gates: ['zero max-daily-loss breaches'] },
    { rung: 9, target: 90000, label: '$90K', gates: ['full season review'] },
    { rung: 10, target: 100000, label: '$100K', gates: ['mission complete'] }
];

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function monthKey(t) {
    const d = new Date(t && typeof t === 'number' && t < 1e12 ? t * 1000 : t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
}
function computeMission({ account, trades, discipline, risk, backtestTrades } = {}) {
    const live = Array.isArray(trades) ? trades.filter(t => !t.source || t.source === 'LIVE') : [];
    const all = Array.isArray(trades) ? trades : [];
    const pnl = live.reduce((sum, t) => sum + num(t.pnl), 0);
    const target = 100000;
    const equityStart = num(account && (account.starting_balance || account.startingBalance));
    const equity = equityStart + pnl;
    const peak = Math.max(equityStart, equity, ...(all.map(t => equityStart + num(t.pnl))));
    let running = equityStart, maxDrawdown = 0;
    for (const t of live) { running += num(t.pnl); maxDrawdown = Math.max(maxDrawdown, peak - running); }
    const wins = live.filter(t => num(t.pnl) > 0);
    const losses = live.filter(t => num(t.pnl) < 0);
    const grossWin = wins.reduce((s, t) => s + num(t.pnl), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + num(t.pnl), 0));
    const profitFactor = grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : 0);
    const avgR = live.length ? live.reduce((s, t) => s + num(t.r), 0) / live.length : 0;
    const months = new Map();
    for (const t of live) { const k = monthKey(t.ts || t.created_at); if (k) months.set(k, (months.get(k) || 0) + num(t.pnl)); }
    const profitableMonths = [...months.values()].filter(v => v > 0).length;
    const sessionDays = new Set(live.map(t => String(t.ts || t.created_at || '').slice(0, 10)).filter(Boolean)).size;
    const disciplineScore = num(discipline && (discipline.score != null ? discipline.score : discipline.total));
    const drawdownPct = peak > 0 ? (maxDrawdown / peak) * 100 : 0;
    const breaches = num(risk && (risk.dailyLossBreaches != null ? risk.dailyLossBreaches : risk.breaches));
    const gates = {
        trades50: live.length >= 50,
        discipline70: disciplineScore >= 70,
        drawdown15: drawdownPct < 15,
        profitFactor15: profitFactor >= 1.5,
        avgR04: avgR >= 0.4,
        sessionDays100: sessionDays >= 100,
        profitableMonths2: profitableMonths >= 2,
        zeroBreaches: breaches === 0,
        backtestProof: Array.isArray(backtestTrades) && backtestTrades.length >= 20
    };
    const reachedRung = Math.max(0, Math.min(10, Math.floor(Math.max(0, pnl) / 10000)));
    const next = RUNG_GATES.find(r => r.rung > reachedRung) || RUNG_GATES[RUNG_GATES.length - 1];
    return {
        accountId: account && account.id || null,
        target,
        netPnl: Math.round(pnl * 100) / 100,
        equity: Math.round(equity * 100) / 100,
        progressPct: Math.max(0, Math.min(100, Math.round((pnl / target) * 10000) / 100)),
        reachedRung,
        nextCheckpoint: next,
        metrics: { liveTrades: live.length, sessionDays, disciplineScore, drawdownPct: Math.round(drawdownPct * 100) / 100, profitFactor: profitFactor === Infinity ? null : Math.round(profitFactor * 100) / 100, avgR: Math.round(avgR * 1000) / 1000, profitableMonths, dailyLossBreaches: breaches, backtestProofTrades: Array.isArray(backtestTrades) ? backtestTrades.length : 0 },
        gateStatus: gates,
        rungs: RUNG_GATES.map(r => ({ ...r, reached: r.rung <= reachedRung }))
    };
}

module.exports = { RUNG_GATES, computeMission };
