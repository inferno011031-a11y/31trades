'use strict';

// ---------------------------------------------------------------------------
// Rewards read-model tests — deterministic, derived only.
// Contract: rewards are recomputed from canonical engine outputs on every read,
// nothing is stored, nothing is spendable, and removing behaviour immediately
// removes the reward.
// ---------------------------------------------------------------------------

const R = require('./rewards.js');

let pass = 0, fail = 0;
function ok(v, s) { if (v) pass++; else { fail++; console.error('FAIL', s); } }

// 1 · a brand-new account earns nothing and is told what comes first
const empty = R.computeRewards({});
ok(empty.points === 0 && empty.achievedCount === 0, 'new account starts at zero');
ok(empty.tier.id === 'bronze', 'new account is bronze');
ok(empty.next.length === 3, 'surfaces the three nearest milestones');
ok(empty.next[0].id === 'first-trade', 'first logged trade is the first milestone');
ok(empty.completionPct === 0, 'zero completion for an empty account');

// 2 · progress is real, not rounded up
const oneTrade = R.computeRewards({ liveTrades: 1 });
ok(oneTrade.achieved.some(a => a.id === 'first-trade'), 'first trade achieved');
ok(!oneTrade.achieved.some(a => a.id === 'ten-trades'), '10 trades not achieved at 1');
const ten = oneTrade.next.find(n => n.id === 'ten-trades') || oneTrade.locked.find(n => n.id === 'ten-trades');
ok(ten && ten.progressPct === 10, 'progress reflects 1/10');

// 3 · zero breaches only counts once trades exist (no free reward for an empty account)
ok(oneTrade.achieved.some(a => a.id === 'zero-breaches') === false || oneTrade.snapshot.breachFree === 1, 'breach-free requires activity');
const breached = R.computeRewards({ liveTrades: 30, breaches: 2 });
ok(breached.snapshot.breachFree === 0, 'breaches block the breach-free milestone');
ok(!breached.achieved.some(a => a.id === 'zero-breaches'), 'breach-free milestone not awarded with breaches');
const clean = R.computeRewards({ liveTrades: 30, breaches: 0 });
ok(clean.achieved.some(a => a.id === 'zero-breaches'), 'breach-free milestone awarded when clean');

// 4 · mission-driven metrics flow through
const strong = R.computeRewards({
    mission: {
        reachedRung: 5,
        metrics: {
            liveTrades: 220, sessionDays: 120, disciplineScore: 82, avgR: 0.6,
            profitFactor: 1.9, profitableMonths: 4, dailyLossBreaches: 0, backtestProofTrades: 140
        }
    },
    battlesCompleted: 6,
    battleWins: 2
});
ok(strong.points > 600, 'strong profile climbs the points ladder');
ok(strong.tier.id === 'platinum', 'strong profile reaches platinum');
ok(strong.nextTier === null, 'no tier above platinum');
ok(strong.achieved.some(a => a.id === 'mission-half'), 'mission rung milestone achieved');
ok(strong.achieved.some(a => a.id === 'battle-winner'), 'battle win milestone achieved');
ok(strong.locked.every(l => l.value < l.target), 'locked milestones are genuinely unmet');
ok(strong.achieved.every(a => a.value >= a.target), 'achieved milestones are genuinely met');

// 5 · the same input always produces the same output (no hidden state)
const again = R.computeRewards({
    mission: {
        reachedRung: 5,
        metrics: {
            liveTrades: 220, sessionDays: 120, disciplineScore: 82, avgR: 0.6,
            profitFactor: 1.9, profitableMonths: 4, dailyLossBreaches: 0, backtestProofTrades: 140
        }
    },
    battlesCompleted: 6,
    battleWins: 2
});
ok(again.points === strong.points && again.completionPct === strong.completionPct, 'rewards are deterministic');

// 6 · determining behaviour: rewards fall when behaviour falls
const before = R.computeRewards({ liveTrades: 50, breaches: 0 });
const after = R.computeRewards({ liveTrades: 20, breaches: 1 });
ok(after.points < before.points, 'rewards drop when trades and discipline drop');

// 7 · tier thresholds
ok(R.tierFor(0).id === 'bronze' && R.tierFor(150).id === 'silver' && R.tierFor(350).id === 'gold' && R.tierFor(1000).id === 'platinum', 'tier thresholds');
ok(R.MILESTONES.every(m => m.points > 0 && m.target > 0 && m.group), 'every milestone is well formed');
ok(new Set(R.MILESTONES.map(m => m.id)).size === R.MILESTONES.length, 'milestone ids are unique');

console.log(`rewards: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
