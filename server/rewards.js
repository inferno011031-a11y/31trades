'use strict';

// ============================================================================
// 31TRADES — Rewards read model
// ----------------------------------------------------------------------------
// Rewards are DERIVED, never stored: there is no credits ledger and nothing
// spendable, so a user cannot farm or fake progression. Every number comes from
// canonical engines (live trades, discipline state, Mission 100K metrics,
// practice/backtest proof, completed battles).
//
//   GET /api/rewards  → achieved / in-progress / locked milestones + points
//
// Points are a read-only reflection of real behaviour — they are recomputed on
// every read from the source engines, so deleting a trade or losing a streak
// immediately and honestly reflects in rewards.
// ============================================================================

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

// metric → the canonical field it reads from the snapshot built below
const MILESTONES = [
    { id: 'first-trade', label: 'First logged trade', metric: 'liveTrades', target: 1, points: 10, group: 'Journal' },
    { id: 'ten-trades', label: '10 trades journaled', metric: 'liveTrades', target: 10, points: 20, group: 'Journal' },
    { id: 'fifty-trades', label: '50 trades journaled', metric: 'liveTrades', target: 50, points: 40, group: 'Journal' },
    { id: 'two-hundred-trades', label: '200 trades journaled', metric: 'liveTrades', target: 200, points: 80, group: 'Journal' },
    { id: 'twenty-sessions', label: '20 journaled session days', metric: 'sessionDays', target: 20, points: 25, group: 'Consistency' },
    { id: 'hundred-sessions', label: '100 journaled session days', metric: 'sessionDays', target: 100, points: 75, group: 'Consistency' },
    { id: 'clean-discipline', label: 'Discipline score ≥ 70', metric: 'disciplineScore', target: 70, points: 40, group: 'Discipline' },
    { id: 'zero-breaches', label: 'Zero max-daily-loss breaches', metric: 'breachFree', target: 1, points: 50, group: 'Discipline' },
    { id: 'positive-expectancy', label: 'Average R ≥ 0.25', metric: 'avgR', target: 0.25, points: 45, group: 'Edge' },
    { id: 'strong-expectancy', label: 'Average R ≥ 0.5', metric: 'avgR', target: 0.5, points: 90, group: 'Edge' },
    { id: 'profit-factor', label: 'Profit factor ≥ 1.5', metric: 'profitFactor', target: 1.5, points: 60, group: 'Edge' },
    { id: 'backtest-proof', label: '20+ backtest trades recorded', metric: 'backtestProofTrades', target: 20, points: 30, group: 'Proof' },
    { id: 'backtest-sample', label: '100+ backtest trades recorded', metric: 'backtestProofTrades', target: 100, points: 70, group: 'Proof' },
    { id: 'battle-first', label: 'Complete your first battle', metric: 'battlesCompleted', target: 1, points: 30, group: 'Battles' },
    { id: 'battle-five', label: 'Complete 5 battles', metric: 'battlesCompleted', target: 5, points: 60, group: 'Battles' },
    { id: 'battle-winner', label: 'Win a battle', metric: 'battleWins', target: 1, points: 50, group: 'Battles' },
    { id: 'first-profit-month', label: 'One profitable month', metric: 'profitableMonths', target: 1, points: 35, group: 'Mission 100K' },
    { id: 'mission-first-rung', label: 'Reach rung 1 of Mission 100K', metric: 'reachedRung', target: 1, points: 50, group: 'Mission 100K' },
    { id: 'mission-half', label: 'Reach $50K mission progress', metric: 'reachedRung', target: 5, points: 150, group: 'Mission 100K' }
];

const TIERS = [
    { id: 'bronze', label: 'Bronze', min: 0 },
    { id: 'silver', label: 'Silver', min: 150 },
    { id: 'gold', label: 'Gold', min: 350 },
    { id: 'platinum', label: 'Platinum', min: 600 }
];

function tierFor(points) {
    let out = TIERS[0];
    TIERS.forEach(t => { if (points >= t.min) out = t; });
    return out;
}

/**
 * Build the reward snapshot from canonical engine outputs.
 * Everything is optional — a brand-new account simply starts at zero points.
 */
function buildSnapshot(input) {
    const i = input || {};
    const metric = (i.mission && i.mission.metrics) || {};
    const breaches = num(i.breaches != null ? i.breaches : metric.dailyLossBreaches);
    return {
        liveTrades: num(i.liveTrades != null ? i.liveTrades : metric.liveTrades),
        sessionDays: num(i.sessionDays != null ? i.sessionDays : metric.sessionDays),
        disciplineScore: num(i.disciplineScore != null ? i.disciplineScore : metric.disciplineScore),
        avgR: num(i.avgR != null ? i.avgR : metric.avgR),
        profitFactor: num(i.profitFactor != null ? i.profitFactor : metric.profitFactor),
        profitableMonths: num(i.profitableMonths != null ? i.profitableMonths : metric.profitableMonths),
        reachedRung: num(i.reachedRung != null ? i.reachedRung : (i.mission && i.mission.reachedRung)),
        backtestProofTrades: num(i.backtestProofTrades != null ? i.backtestProofTrades : metric.backtestProofTrades),
        battlesCompleted: num(i.battlesCompleted),
        battleWins: num(i.battleWins),
        breachFree: i.liveTrades || metric.liveTrades ? (breaches === 0 ? 1 : 0) : 0
    };
}

function progressOf(value, target) {
    if (!target) return 1;
    return Math.max(0, Math.min(1, value / target));
}

function computeRewards(input) {
    const snapshot = buildSnapshot(input);
    const achieved = [];
    const pending = [];

    MILESTONES.forEach(m => {
        const value = num(snapshot[m.metric]);
        const progress = progressOf(value, m.target);
        const row = {
            id: m.id,
            label: m.label,
            group: m.group,
            points: m.points,
            metric: m.metric,
            target: m.target,
            value: m.target >= 1 && Number.isInteger(m.target) ? Math.round(value) : Math.round(value * 1000) / 1000,
            progressPct: Math.round(progress * 100)
        };
        if (value >= m.target) achieved.push(row); else pending.push(row);
    });

    const points = achieved.reduce((s, r) => s + r.points, 0);
    const totalPoints = MILESTONES.reduce((s, m) => s + m.points, 0);
    const tier = tierFor(points);
    const nextTier = TIERS.find(t => t.min > points) || null;

    // closest unfinished milestone first — that is the honest "what next" hint
    pending.sort((a, b) => b.progressPct - a.progressPct || a.points - b.points);

    return {
        points,
        totalPoints,
        completionPct: Math.round((points / totalPoints) * 100),
        tier: { id: tier.id, label: tier.label, points },
        nextTier: nextTier ? { id: nextTier.id, label: nextTier.label, min: nextTier.min, pointsAway: nextTier.min - points } : null,
        achievedCount: achieved.length,
        totalCount: MILESTONES.length,
        achieved: achieved.sort((a, b) => b.points - a.points),
        next: pending.slice(0, 3),
        locked: pending.slice(3),
        snapshot
    };
}

module.exports = { MILESTONES, TIERS, computeRewards, buildSnapshot, tierFor };
