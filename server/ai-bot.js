'use strict';

// ============================================================================
// 31TRADES — AI Mentor bot (personal trading coach)
// ----------------------------------------------------------------------------
// A grounded question-answer engine: it reads the user's REAL canonical data
// (the mentor bundle + the trade ledger) and answers natural-language
// questions with actual numbers, evidence and suggestions. It never
// hallucinates — every answer is computed from the same data the rest of the
// app shows, and every answer cites the trades behind it.
//
//   askBot(core, accountId, question, { period })  →  { answer, kpis, ... }
//
// Intent detection is deterministic (keyword/regex over the question); a
// later LLM phase may narrate the same payload, but the numbers always come
// from here. Exposed as POST /api/ai/ask (see server.js).
// ============================================================================

const { mentorBundle } = require('./ai-mentor.js');

const DAY = 86400000;

// ---------------------------------------------------------------------------
// Small canonical helpers — all computed from the REAL ledger.
// ---------------------------------------------------------------------------
function tradesIn(core, accountId, sinceMs) {
    return core.Trades.filter(t =>
        t.account_id === accountId &&
        (sinceMs == null || new Date(t.ts).getTime() >= sinceMs));
}
function statsOf(list) {
    const n = list.length;
    const wins = list.filter(t => t.pnl > 0).length;
    const losses = list.filter(t => t.pnl < 0).length;
    const grossProfit = list.reduce((s, t) => s + (t.pnl > 0 ? t.pnl : 0), 0);
    const grossLoss = -list.reduce((s, t) => s + (t.pnl < 0 ? t.pnl : 0), 0);
    const risks = list.map(t => t.risk || 0).filter(r => r > 0);
    return {
        n, wins, losses,
        winRate: n ? wins / n : 0,
        net: list.reduce((s, t) => s + (t.pnl || 0), 0),
        grossProfit, grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
        avgR: n ? list.reduce((s, t) => s + (t.r || 0), 0) / n : 0,
        avgRisk: risks.length ? risks.reduce((s, r) => s + r, 0) / risks.length : 0,
        maxRisk: risks.length ? Math.max(...risks) : 0
    };
}
function money(n) {
    if (n == null || isNaN(n)) return '—';
    return (n >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
}
function rankBy(list, key, minN) {
    const m = {};
    list.forEach(t => { const k = t[key] || '—'; (m[k] = m[k] || []).push(t); });
    return Object.keys(m).map(k => ({ key: k, ...statsOf(m[k]) }))
        .filter(r => r.n >= (minN || 5))
        .sort((a, b) => b.avgR - a.avgR);
}

function allFindings(b) {
    return b ? [].concat(b.patterns, b.psychology.findings, b.risk.findings,
        b.discipline.findings, b.sessions.findings, b.tilt) : [];
}

// ---------------------------------------------------------------------------
// Answer builders — each returns { text, kpis, evidence, followUps }.
// ---------------------------------------------------------------------------
function overallAnswer(b, s) {
    const top = b.coach.patterns.find(f => !f.suppressed);
    const strength = b.coach.strengths.find(f => !f.suppressed);
    const parts = [];
    parts.push('Overall, you have ' + s.n + ' trade' + (s.n === 1 ? '' : 's') + ' in range: ' +
        money(s.net) + ' net with a ' + Math.round(s.winRate * 100) + '% win rate and ' +
        (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R average.');
    if (s.n >= 10) parts.push('Your profit factor is ' + (s.profitFactor === Infinity ? '∞ (no losing trades)' : s.profitFactor.toFixed(2)) + '.');
    if (top) parts.push('Biggest leak right now: "' + top.title + '" — ' + top.count + ' occurrence' + (top.count === 1 ? '' : 's') + ' costing ' + money(top.cost) + '.');
    if (strength) parts.push('What works: ' + strength.title + '.');
    const tilt = b.tilt[0];
    if (tilt && tilt.sev === 'critical') parts.push('⚠ Tilt detector is flashing — this is how your bad periods start.');
    return {
        text: parts.join(' '),
        kpis: [
            { label: 'Net P&L', value: money(s.net), cls: s.net >= 0 ? 'text-[#34D399]' : 'text-[#F87171]' },
            { label: 'Win rate', value: Math.round(s.winRate * 100) + '%', cls: 'text-white' },
            { label: 'Expectancy', value: (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R', cls: 'text-white' },
            { label: 'Discipline', value: b.context.disciplineScore != null ? b.context.disciplineScore + '/100' : '—', cls: 'text-white' }
        ],
        evidence: top ? top.ev : (tilt ? tilt.ev : [])
    };
}

function winLossAnswer(b, s, q, list) {
    const isLoss = /\b(loss|losing|why|lose|bleed)\b/.test(q);
    if (isLoss && s.n >= 5) {
        const costly = allFindings(b).filter(f => (f.cost || 0) < 0).sort((a, c) => a.cost - c.cost)[0];
        const afterLoss = rankBy(list, 'emotion', 0).find(r => r.key === 'Revenge') || null;
        const parts = [];
        parts.push('You lost ' + s.losses + ' of your ' + s.n + ' trades — gross loss ' + money(-s.grossLoss) + ', average loser ' +
            (s.losses ? money(-s.grossLoss / s.losses) : '—') + ' (' + (s.losses ? (s.losses ? (s.grossLoss / s.losses) : 0) : 0) + ' per loser).');
        if (costly) parts.push('The most expensive pattern is "' + costly.title + '" — ' + costly.count + ' occurrence' + (costly.count === 1 ? '' : 's') + ' at ' + money(costly.cost) + '.');
        if (afterLoss && afterLoss.n >= 2) parts.push('You marked ' + afterLoss.n + ' trades as Revenge — entries right after a loss. That is the classic tilt tell.');
        return {
            text: parts.join(' '),
            kpis: [
                { label: 'Gross loss', value: money(-s.grossLoss), cls: 'text-[#F87171]' },
                { label: 'Avg loser', value: s.losses ? money(-s.grossLoss / s.losses) : '—', cls: 'text-[#F87171]' },
                { label: 'Loss rate', value: Math.round(s.losses / s.n * 100) + '%', cls: 'text-white' },
                { label: 'Profit factor', value: s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2), cls: s.profitFactor >= 1 ? 'text-[#34D399]' : 'text-[#F87171]' }
            ],
            evidence: costly ? costly.ev : []
        };
    }
    const parts = [];
    parts.push('You won ' + s.wins + ' of your ' + s.n + ' trades (' + Math.round(s.winRate * 100) + '% win rate). Gross profit ' +
        money(s.grossProfit) + ', average winner ' + (s.wins ? money(s.grossProfit / s.wins) : '—') + '.');
    if (s.profitFactor === Infinity) parts.push('No losing trades in range — strong run.');
    else parts.push('Profit factor ' + s.profitFactor.toFixed(2) + (s.profitFactor >= 1.5 ? ' — a healthy edge.' : ' — below 1.5, the losers eat your winners.'));
    return {
        text: parts.join(' '),
        kpis: [
            { label: 'Win rate', value: Math.round(s.winRate * 100) + '%', cls: 'text-white' },
            { label: 'Gross profit', value: money(s.grossProfit), cls: 'text-[#34D399]' },
            { label: 'Avg winner', value: s.wins ? money(s.grossProfit / s.wins) : '—', cls: 'text-[#34D399]' },
            { label: 'Profit factor', value: s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2), cls: s.profitFactor >= 1 ? 'text-[#34D399]' : 'text-[#F87171]' }
        ],
        evidence: []
    };
}

function riskAnswer(b, s) {
    const c = b.context;
    const over = b.risk.findings.find(f => f.type === 'risk-over-policy');
    const parts = [];
    if (s.n >= 5) {
        parts.push('Your average risk per trade is $' + Math.round(s.avgRisk) + ' (max $' + Math.round(s.maxRisk) + ').');
    }
    if (c.policyRiskPerTrade) {
        parts.push('Your policy allows $' + c.policyRiskPerTrade + ' per trade.');
        if (over) parts.push('⚠ You exceeded it on ' + over.count + ' trade' + (over.count === 1 ? '' : 's') + ' — that is your riskiest behavior.');
        else parts.push('You stayed inside the policy in this range.');
    }
    const inc = b.risk.findings.find(f => f.type === 'risk-inconsistent');
    if (inc) parts.push(inc.msg);
    const dd = b.risk.findings.find(f => f.type === 'risk-recovery');
    if (dd) parts.push(dd.msg);
    const rec = b.risk.findings.find(f => f.type === 'risk-small-wins');
    if (rec) parts.push(rec.msg);
    return {
        text: parts.join(' '),
        kpis: [
            { label: 'Avg risk', value: s.n ? '$' + Math.round(s.avgRisk) : '—', cls: 'text-white' },
            { label: 'Policy limit', value: c.policyRiskPerTrade ? '$' + c.policyRiskPerTrade : '—', cls: 'text-white' },
            { label: 'Max drawdown', value: money(-c.maxDD), cls: 'text-[#F87171]' },
            { label: 'Recovery factor', value: c.recovery ? c.recovery.toFixed(2) : '—', cls: c.recovery >= 1 ? 'text-[#34D399]' : 'text-[#F87171]' }
        ],
        evidence: over ? over.ev : []
    };
}

function tiltAnswer(b) {
    const t = b.tilt[0];
    if (!t) return { text: 'No tilt signal yet — I need at least 8 trades to learn your signature (risk multiple, re-entry speed, emotional tags). Keep journaling.', kpis: [], evidence: [] };
    return {
        text: t.msg,
        kpis: [
            { label: 'Status', value: t.sev === 'critical' ? 'ACTIVE' : 'WATCH', cls: t.sev === 'critical' ? 'text-[#F87171]' : 'text-[#34D399]' },
            { label: 'Episodes', value: String(t.count), cls: 'text-white' },
            { label: 'Avg episode cost', value: t.cost != null ? money(t.cost) : '—', cls: 'text-[#F87171]' }
        ],
        evidence: t.ev
    };
}

function disciplineAnswer(b) {
    const c = b.context;
    const top = b.discipline.findings.find(f => f.type === 'disc-violation');
    const parts = [];
    if (c.disciplineScore != null) parts.push('Your discipline score is ' + c.disciplineScore + '/100 — process adherence, not profit.');
    if (top) parts.push(top.msg);
    const weakest = b.discipline.findings.find(f => f.type === 'disc-weakest');
    if (weakest) parts.push(weakest.msg);
    if (c.cleanStreak > 0) parts.push('Clean streak: ' + c.cleanStreak + ' day' + (c.cleanStreak === 1 ? '' : 's') + ' (best ' + c.bestCleanStreak + ').');
    const rules = (b.discipline.rules || []).slice(0, 3);
    if (rules.length) parts.push('Best adherence: ' + rules[0].label + ' at ' + rules[0].rate + '%.');
    return {
        text: parts.join(' '),
        kpis: [
            { label: 'Discipline', value: c.disciplineScore != null ? c.disciplineScore + '/100' : '—', cls: c.disciplineScore >= 70 ? 'text-[#34D399]' : c.disciplineScore >= 45 ? 'text-[#FBBF24]' : 'text-[#F87171]' },
            { label: 'Violations', value: String(c.violations), cls: c.violations ? 'text-[#F87171]' : 'text-[#34D399]' },
            { label: 'Clean streak', value: String(c.cleanStreak), cls: c.cleanStreak >= 3 ? 'text-[#34D399]' : 'text-white' }
        ],
        evidence: top ? top.ev : []
    };
}

function sessionAnswer(b) {
    const t = b.sessions.tables || {};
    const byS = t.session || [];
    const bySetup = t.setup || [];
    const bySym = t.symbol || [];
    const parts = [];
    if (byS.length) {
        const best = byS[0], worst = byS[byS.length - 1];
        parts.push('Your best session is ' + best.key + ' (' + Math.round(best.winRate * 100) + '% win rate, ' + best.avgR.toFixed(2) + 'R, ' + best.n + ' trades, ' + money(best.pnl) + ').');
        if (worst.key !== best.key) parts.push('Your worst is ' + worst.key + ' (' + worst.avgR.toFixed(2) + 'R, ' + worst.n + ' trades, ' + money(worst.pnl) + ').');
    } else parts.push('Not enough data per session yet (needs ≥5 trades per group, 10+ in range).');
    if (bySetup.length) {
        parts.push('Strongest setup: ' + bySetup[0].key + ' at ' + bySetup[0].avgR.toFixed(2) + 'R.');
    }
    if (bySym.length) {
        parts.push('Best instrument: ' + bySym[0].key + ' (' + bySym[0].avgR.toFixed(2) + 'R).');
    }
    return {
        text: parts.join(' '),
        kpis: byS.length ? [
            { label: 'Best session', value: byS[0].key, cls: 'text-[#34D399]' },
            { label: 'Best setup', value: bySetup.length ? bySetup[0].key : '—', cls: 'text-white' },
            { label: 'Best symbol', value: bySym.length ? bySym[0].key : '—', cls: 'text-white' }
        ] : [],
        evidence: []
    };
}

function focusAnswer(b) {
    const top = b.coach.patterns.find(f => !f.suppressed);
    const strength = b.coach.strengths.find(f => !f.suppressed);
    const parts = [];
    if (top) parts.push('Your #1 fix: stop "' + top.title + '" — ' + top.count + ' occurrence' + (top.count === 1 ? '' : 's') + ' costing ' + money(top.cost) + '. One less leak beats any new indicator.');
    if (strength) parts.push('Simultaneously, double down on what works: ' + strength.title + '.');
    if (b.tilt[0] && b.tilt[0].sev === 'critical') parts.push('And respect the tilt detector — it is flashing right now. Today is a capital-protection day.');
    if (!top && !strength) parts.push('No strong signal yet. Log more trades with emotion + adherence tags and I can give you a sharper focus.');
    return {
        text: parts.join(' '),
        kpis: [],
        evidence: top ? top.ev : []
    };
}

function streakAnswer(b, core, accountId) {
    const all = tradesIn(core, accountId, null).sort((x, y) => new Date(x.ts) - new Date(y.ts));
    let curWin = 0, curLoss = 0, bestWin = 0, bestLoss = 0;
    all.forEach(t => {
        if (t.pnl > 0) { curWin++; curLoss = 0; }
        else if (t.pnl < 0) { curLoss++; curWin = 0; }
        else { curWin = 0; curLoss = 0; }
        bestWin = Math.max(bestWin, curWin);
        bestLoss = Math.max(bestLoss, curLoss);
    });
    const parts = [];
    if (!all.length) parts.push('No trades logged yet.');
    else {
        parts.push('You are on a ' + (curWin ? curWin + '-trade winning' : curLoss ? curLoss + '-trade losing' : 'flat') + ' streak right now.');
        parts.push('Best win streak ' + bestWin + ', worst losing streak ' + bestLoss + '.');
        if (curLoss >= 2) parts.push('Losing streaks of 2+ are where tilt episodes start for you — keep size at minimum until the red stops.');
    }
    return { text: parts.join(' '), kpis: [], evidence: [] };
}

function periodAnswer(q, core, accountId) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const wStart = new Date(today); wStart.setDate(today.getDate() - today.getDay());
    const mStart = new Date(today.getFullYear(), today.getMonth(), 1);
    let since, label;
    if (/\btoday\b/.test(q)) { since = today.getTime(); label = 'today'; }
    else if (/\byesterday\b/.test(q)) { since = today.getTime() - DAY; label = 'yesterday'; }
    else if (/\bthis week\b/.test(q)) { since = wStart.getTime(); label = 'this week'; }
    else if (/\blast week\b/.test(q)) { since = wStart.getTime() - 7 * DAY; label = 'last week'; }
    else { since = mStart.getTime(); label = 'this month'; }
    const s = statsOf(tradesIn(core, accountId, since));
    const parts = [];
    if (!s.n) parts.push('No trades ' + label + ' yet.');
    else parts.push(label[0].toUpperCase() + label.slice(1) + ' you have ' + s.n + ' trade' + (s.n === 1 ? '' : 's') + ' — ' + money(s.net) + ' net, ' + Math.round(s.winRate * 100) + '% win rate, ' + (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R average.');
    return {
        text: parts.join(' '),
        kpis: [
            { label: label + ' P&L', value: money(s.net), cls: s.net >= 0 ? 'text-[#34D399]' : 'text-[#F87171]' },
            { label: 'Trades', value: String(s.n), cls: 'text-white' },
            { label: 'Win rate', value: Math.round(s.winRate * 100) + '%', cls: 'text-white' }
        ],
        evidence: []
    };
}

// ---------------------------------------------------------------------------
// Intent detection + dispatch. Order matters: specific intents first.
// ---------------------------------------------------------------------------
const INTENTS = [
    { id: 'period', re: /\b(today|yesterday|this week|last week|this month|(my )?week|(my )?month)\b/ },
    { id: 'tilt', re: /\b(tilt\w*|revenge|fomo|emotion\w*|psycholog\w*|angr\w*|frustrat\w*|panic\w*)\b/ },
    { id: 'discipline', re: /\b(disciplin\w*|violat\w*|rules?|adher\w*|clean|follow\w* (my|the) plan)\b/ },
    { id: 'streak', re: /\b(streak|consecutive|in a row)\b/ },
    { id: 'risk', re: /\b(risk|oversiz|size|sizing|stop.?loss|drawdown|dd)\b/ },
    { id: 'session', re: /\b(session|when do i|best time|time of day|which session)\b/ },
    { id: 'symbol', re: /\b(symbol|pair|instrument|market|currency|forex|crypto|stocks?|indices)\b/ },
    { id: 'setup', re: /\b(setup|strategy|entry model|which strategy|pattern)\b/ },
    { id: 'winloss', re: /\b(win|loss|lose|losing|winner|profit factor|made money|bleed)\b/ },
    { id: 'focus', re: /\b(focus|improve|work on|do better|fix|next step|what should i|advice|suggest)\b/ },
    { id: 'overall', re: /\b(overall|how am i doing|status|summary|health|score|good|review)\b/ }
];

function detectIntent(q) {
    for (const it of INTENTS) if (it.re.test(q)) return it.id;
    return 'overall';
}

function askBot(core, accountId, question, opts) {
    const period = (opts && opts.period) || '30d';
    const b = mentorBundle(core, accountId, { period });
    const q = String(question || '').trim();

    if (!b) {
        return { question: q, intent: 'none', answer: 'No account yet — create one in Strategy Lab and log trades; then I can coach you on your real data.', kpis: [], evidence: [], followUps: ['How do I create an account?'] };
    }
    const sinceMs = period === 'all' ? null : Date.now() - (period === '90d' ? 90 : 30) * DAY;
    const s = statsOf(tradesIn(core, accountId, sinceMs));
    const intent = detectIntent(q.toLowerCase());

    if (!s.n && intent !== 'tilt') {
        return {
            question: q, intent, period,
            answer: 'No trades in the current ' + period + ' range yet — log a few and I will start coaching from real evidence. (You have ' + b.context.totalTrades + ' total on this account.)',
            kpis: [], evidence: [], followUps: ['How am I doing overall?', 'Which session is my best?']
        };
    }

    let r;
    switch (intent) {
        case 'period': r = periodAnswer(q, core, accountId); break;
        case 'tilt': r = tiltAnswer(b); break;
        case 'discipline': r = disciplineAnswer(b); break;
        case 'streak': r = streakAnswer(b, core, accountId); break;
        case 'risk': r = riskAnswer(b, s); break;
        case 'session': r = sessionAnswer(b); break;
        case 'symbol': {
            const bySym = (b.sessions.tables.symbol || []);
            if (bySym.length) {
                const best = bySym[0], worst = bySym[bySym.length - 1];
                r = {
                    answer: 'By instrument: ' + best.key + ' leads at ' + best.avgR.toFixed(2) + 'R (' + best.n + ' trades, ' + money(best.pnl) + ') while ' + worst.key + ' trails at ' + worst.avgR.toFixed(2) + 'R (' + worst.n + ' trades).',
                    kpis: [
                        { label: 'Best symbol', value: best.key, cls: 'text-[#34D399]' },
                        { label: 'Worst symbol', value: worst.key, cls: 'text-[#F87171]' },
                        { label: 'Spread', value: (best.avgR - worst.avgR).toFixed(2) + 'R', cls: 'text-white' }
                    ],
                    evidence: []
                };
            } else r = { answer: 'Not enough trades per instrument yet (needs ≥5 per symbol).', kpis: [], evidence: [] };
            break;
        }
        case 'setup': {
            const bySetup = (b.sessions.tables.setup || []);
            if (bySetup.length) r = { answer: 'Your highest-conviction setup is ' + bySetup[0].key + ' (' + Math.round(bySetup[0].winRate * 100) + '% win rate, ' + bySetup[0].avgR.toFixed(2) + 'R, ' + bySetup[0].n + ' trades).', kpis: [{ label: 'Best setup', value: bySetup[0].key, cls: 'text-[#34D399]' }], evidence: [] };
            else r = { answer: 'Not enough trades per setup yet (needs ≥5 per setup).', kpis: [], evidence: [] };
            break;
        }
        case 'winloss': r = winLossAnswer(b, s, q, tradesIn(core, accountId, sinceMs)); break;
        case 'focus': r = focusAnswer(b); break;
        default: r = overallAnswer(b, s);
    }
    if (r.text && !r.answer) r.answer = r.text;   // builders may use either key
    return Object.assign({ question: q, intent, period }, r, {
        followUps: r.followUps || ['Am I tilting?', 'What should I focus on?', 'How is my risk sizing?']
    });
}

module.exports = { askBot, detectIntent, statsOf, rankBy, tradesIn };
