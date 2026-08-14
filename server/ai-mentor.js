'use strict';

// ============================================================================
// 31TRADES — AI Mentor service (Phase 2: server module)
// ----------------------------------------------------------------------------
// The AI Intelligence & Mentorship Layer as a server-side module:
//
//   · mentorBundle(core, accountId, opts)  — the complete mentor dataset,
//     computed from the SAME canonical ledger the rest of the app uses
//     (Trades, Violations, analytics, disciplineState, rule evaluations).
//     Every finding carries evidence (trade ids) and real counts; sample
//     guardrails suppress findings below their minimum evidence; all
//     baselines are the user's OWN (avg risk, own rule set, own tilt
//     episodes) — no generic advice, no manufactured numbers.
//
//   · ai_findings cache (Supabase table + per-user JSON fallback) with
//     dismiss (suppress) and thumbs-up/down (feedback) so the coach learns
//     what is noise for each trader.
//
// The browser page consumes this via GET /api/ai/mentor (see server.js);
// offline it falls back to the same heuristics bundled in ai.html. The
// finding shape (id/type/sev/title/msg/ev/count/cost/confidence) is the
// contract between the two.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.js');

// Data dir is read at call time so tests can isolate it via TRADEMIND_AI_DATA_DIR.
const DATA_DIR = path.join(__dirname, '..', 'data');
const fileFor = userId => path.join(process.env.TRADEMIND_AI_DATA_DIR || DATA_DIR, 'ai-' + userId + '.json');

// ---------------------------------------------------------------------------
// ENGINE — context + heuristics over a core instance (server-side cores expose
// the same API the browser core does: Trades, Accounts, StrategyMaster,
// Violations, analytics, disciplineState, activePolicy, assetSpecFor, fmtPrice,
// TradeService.evaluationsFor).
// ---------------------------------------------------------------------------

const DAY = 86400000;

function inPeriod(ts, period) {
    if (period === 'all') return true;
    const days = period === '90d' ? 90 : 30;
    return (Date.now() - new Date(ts).getTime()) <= days * DAY;
}

function buildContext(core, accountId, period, sinceMs) {
    const account = core.Accounts.find(a => a.id === accountId);
    if (!account) return null;
    const all = core.Trades
        .filter(t => t.account_id === accountId)
        .map(t => ({ ...t, ts: new Date(t.ts) }))
        .sort((a, b) => b.ts - a.ts);                    // newest first
    return {
        accountId,
        account,
        trades: all,                                     // newest first
        period: all.filter(t => sinceMs != null ? t.ts.getTime() >= sinceMs : inPeriod(t.ts, period)),
        a: core.analytics(accountId, {}),
        disc: core.disciplineState(accountId, {}),
        policy: (core.activePolicy && core.activePolicy(accountId)) || null,
        viols: core.Violations.filter(v => v.account_id === accountId)
    };
}

const sumPnl = list => Math.round(list.reduce((s, t) => s + (t.pnl || 0), 0));
const avg = (list, f) => list.length ? list.reduce((s, t) => s + (f(t) || 0), 0) / list.length : 0;

// Stable finding id — deterministic for a given evidence set so suppress /
// feedback survives recomputation: ai-<type>-<count>-<firstEvidenceId>.
// Evidence may be trade objects or id strings; the id must embed the id, not
// the object (which stringifies to [object Object]).
function finding(type, sev, title, msg, ev, cost) {
    const count = ev.length;
    const first = ev[0] && typeof ev[0] !== 'string' ? ev[0].id : ev[0];
    return {
        id: 'ai-' + type + '-' + count + '-' + (first || 'none'),
        type, sev, title, msg,
        ev: ev.slice(0, 8).map(t => (typeof t === 'string' ? t : t.id)),
        count, cost: cost != null ? Math.round(cost) : null,
        confidence: count >= 8 ? 'high' : count >= 4 ? 'medium' : 'low'
    };
}

// ---- pattern detection ------------------------------------------------------
function detectPatterns(ctx) {
    const out = [];
    const T = ctx.period;
    const n = T.length;
    if (n < 5) return out;
    const baseRisk = avg(ctx.trades, t => t.risk) || 0;
    const sel = cond => T.filter(t => cond(t));
    const push = (type, sev, title, msg, ev, cost) => {
        if (ev.length >= 3) out.push(finding(type, sev, title, msg, ev, cost));
    };

    const early = sel(t => t.adherence === 'early exit');
    push('early-exit', 'warning', 'Cutting trades early',
        'You exited early ' + early.length + ' of your last ' + n + ' trades — the same early-exit pattern, ' + early.length + ' times.',
        early, sumPnl(early));

    const revenge = sel(t => t.emotion === 'Revenge');
    push('revenge', 'critical', 'Revenge entries after losses',
        revenge.length + ' trades were marked Revenge — entries taken emotionally right after a loss.',
        revenge, sumPnl(revenge));

    const fomo = sel(t => t.emotion === 'FOMO');
    push('fomo', 'warning', 'FOMO entries',
        fomo.length + ' trades were marked FOMO — chasing the move instead of waiting for your setup.',
        fomo, sumPnl(fomo));

    const movStop = sel(t => t.adherence === 'moving stop');
    push('moving-stop', 'warning', 'Moving the stop',
        'You moved your stop mid-trade ' + movStop.length + ' times — the "moving stop" violation appears again and again.',
        movStop, sumPnl(movStop));

    const noPlan = sel(t => t.adherence === 'no-plan');
    push('no-plan', 'warning', 'Trading without a plan',
        noPlan.length + ' trades were taken with no plan at all.',
        noPlan, sumPnl(noPlan));

    const chrono = T.slice().reverse();
    const escalated = [];
    for (let i = 1; i < chrono.length; i++) {
        const prev = chrono[i - 1], t = chrono[i];
        if (prev.pnl < 0 && (t.risk || 0) > (prev.risk || 0)) escalated.push(t);
    }
    push('risk-escalation', 'critical', 'Risk escalates right after a loss',
        'After ' + escalated.length + ' losses you immediately took MORE risk on the next trade — the escalation signature.',
        escalated, sumPnl(escalated));

    const cutWins = sel(t => t.adherence === 'early exit' && t.pnl > 0);
    push('cut-winners', 'warning', 'Cutting winners short',
        'You closed ' + cutWins.length + ' winning trades early — leaving money on the table.',
        cutWins, null);

    const oversize = sel(t => baseRisk > 0 && (t.risk || 0) > baseRisk * 1.5);
    push('oversize', 'warning', 'Oversized positions',
        oversize.length + ' trades risked more than 1.5× your average $' + Math.round(baseRisk) + ' risk per trade.',
        oversize, sumPnl(oversize));

    const quick = sel(t => t.postLoss && t.delayMin != null && t.delayMin < 30);
    push('quick-reentry', 'warning', 'Re-entering too fast after a loss',
        quick.length + ' times you were back in the market within 30 minutes of a loss.',
        quick, sumPnl(quick));

    return out;
}

// ---- psychology ---------------------------------------------------------------
function psychologyAnalysis(ctx) {
    const out = [];
    const T = ctx.period;
    const group = (key) => {
        const m = {};
        T.forEach(t => { const k = t[key] || 'Unmarked'; (m[k] = m[k] || []).push(t); });
        return Object.keys(m).map(k => {
            const g = m[k];
            return { key: k, n: g.length, pnl: sumPnl(g), winRate: g.filter(t => t.pnl > 0).length / g.length, avgR: avg(g, t => t.r) };
        }).sort((a, b) => b.pnl - a.pnl);
    };
    if (T.length < 5) return { findings: [], emotionTable: group('emotion') };
    const emotions = group('emotion');

    const emo = k => emotions.find(e => e.key === k);
    const revenge = emo('Revenge');
    if (revenge && revenge.n >= 2) {
        out.push(finding('psych-revenge', 'critical', 'Revenge costs money, not just discipline',
            'Revenge trades netted ' + money(revenge.pnl) + ' with a ' + Math.round(revenge.winRate * 100) + '% win rate across ' + revenge.n + ' trades — your worst emotional state by far.',
            T.filter(t => t.emotion === 'Revenge'), revenge.pnl));
    }
    const fomoE = emo('FOMO');
    if (fomoE && fomoE.n >= 2 && fomoE.pnl < 0) {
        out.push(finding('psych-fomo', 'warning', 'FOMO correlates with losses',
            'FOMO trades netted ' + money(fomoE.pnl) + ' across ' + fomoE.n + ' trades.',
            T.filter(t => t.emotion === 'FOMO'), fomoE.pnl));
    }
    const calm = emo('Calm');
    if (calm && calm.n >= 4) {
        out.push(finding('psych-calm', 'positive', 'Your calm state is your edge',
            'When you traded Calm you netted ' + money(calm.pnl) + ' with a ' + Math.round(calm.winRate * 100) + '% win rate across ' + calm.n + ' trades.',
            T.filter(t => t.emotion === 'Calm'), calm.pnl));
    }
    const noted = T.filter(t => (t.note || t.notes || '').trim().length > 0);
    const unNoted = T.filter(t => !(t.note || t.notes || '').trim().length);
    if (noted.length >= 5 && unNoted.length >= 5) {
        const a = noted.filter(t => t.pnl > 0).length / noted.length;
        const b = unNoted.filter(t => t.pnl > 0).length / unNoted.length;
        if (Math.abs(a - b) > 0.1) {
            out.push(finding('psych-notes', a > b ? 'positive' : 'warning',
                a > b ? 'Writing the thesis helps you win' : 'Trades without a written thesis win more',
                'Trades with a journal note won ' + Math.round(a * 100) + '% (' + noted.length + '), without a note ' + Math.round(b * 100) + '% (' + unNoted.length + ').',
                a > b ? noted : unNoted, null));
        }
    }
    return { findings: out, emotionTable: emotions };
}

// ---- risk ---------------------------------------------------------------------
function riskAnalysis(ctx) {
    const out = [];
    const T = ctx.period;
    const a = ctx.a;
    if (T.length < 5 || !a) return { findings: out, histogram: [] };
    const risks = T.map(t => t.risk || 0).filter(r => r > 0);
    const mean = risks.length ? risks.reduce((s, r) => s + r, 0) / risks.length : 0;
    const sd = risks.length ? Math.sqrt(risks.reduce((s, r) => s + (r - mean) * (r - mean), 0) / risks.length) : 0;
    const cv = mean ? sd / mean : 0;
    if (risks.length >= 5 && cv > 0.45) {
        out.push(finding('risk-inconsistent', 'warning', 'Risk sizing is inconsistent',
            'Your risk per trade swings with a coefficient of variation of ' + Math.round(cv * 100) + '% (avg $' + Math.round(mean) + ', σ $' + Math.round(sd) + ') — same-size risk is what makes your stats readable.',
            T.filter(t => t.risk && Math.abs(t.risk - mean) > sd), null));
    }
    const policy = ctx.policy && ctx.policy.values;
    if (policy && policy.riskPerTrade) {
        const over = T.filter(t => t.risk > policy.riskPerTrade);
        if (over.length >= 2) {
            out.push(finding('risk-over-policy', 'critical', 'Risking more than your own policy',
                over.length + ' trades risked more than your configured $' + policy.riskPerTrade + ' per trade.',
                over, sumPnl(over)));
        }
    }
    const winners = T.filter(t => t.pnl > 0);
    if (winners.length >= 5) {
        const avgWinR = avg(winners, t => t.r);
        if (avgWinR < 1.2) {
            out.push(finding('risk-small-wins', 'warning', 'Winners are too small',
                'Your average winner is ' + avgWinR.toFixed(2) + 'R across ' + winners.length + ' wins — below 1.2R your edge barely survives the losers.',
                winners.slice().sort((x, y) => x.r - y.r).slice(0, 8), null));
        }
    }
    if (a.maxDD > 0) {
        const rec = a.n ? (a.net / a.maxDD) : 0;
        if (rec < 1) {
            out.push(finding('risk-recovery', 'warning', 'Drawdown recovery is slow',
                'Your max drawdown was ' + money(-a.maxDD) + ' and your recovery factor is ' + rec.toFixed(2) + ' — you make back less than the drawdown cost.',
                [], null));
        }
    }
    const hist = {};
    risks.forEach(r => { const b = Math.floor(r / 10) * 10; hist[b] = (hist[b] || 0) + 1; });
    const histogram = Object.keys(hist).sort((x, y) => x - y).map(k => ({ key: '$' + k, count: hist[k] }));
    return { findings: out, histogram, avgRisk: Math.round(mean), riskSd: Math.round(sd) };
}

// ---- discipline coach ------------------------------------------------------------
function disciplineCoach(ctx) {
    const out = [];
    const d = ctx.disc;
    const T = ctx.period;
    const dims = (d && d.dims || []).map(dim => ({ key: dim.key, label: dim.label, score: dim.score, passed: dim.passed, total: dim.total }));
    const rules = (d && d.rules || []).slice(0, 8).map(r => ({ label: r.label, rate: r.rate, passed: r.passed, total: r.total }));
    if (!d || T.length < 5) return { findings: out, dims, rules };
    const viols = ctx.viols;
    const byRule = {};
    viols.forEach(v => {
        (byRule[v.ruleKey] = byRule[v.ruleKey] || { key: v.ruleKey, label: v.ruleLabel, n: 0, cost: 0 });
        byRule[v.ruleKey].n++;
        byRule[v.ruleKey].cost += (v.pnl || 0);
    });
    const ranked = Object.values(byRule).sort((x, y) => y.n - x.n);
    const top = ranked[0];
    if (top && top.n >= 3) {
        out.push(finding('disc-violation', 'critical', 'Your most broken rule: ' + top.label,
            'You broke "' + top.label + '" ' + top.n + ' times — costing ' + money(top.cost) + ' in net P&L. This is the single biggest leak in your process.',
            viols.filter(v => v.ruleKey === top.key).map(v => v.tradeId), top.cost));
    }
    const weakest = rules[rules.length - 1];
    if (weakest && weakest.total >= 5) {
        out.push(finding('disc-weakest', 'warning', 'Weakest rule adherence: ' + weakest.label,
            'Your adherence on "' + weakest.label + '" is ' + weakest.rate + '% over ' + weakest.total + ' checks.',
            [], null));
    }
    if (d.cleanDayStreak > 0) {
        out.push(finding('disc-streak', 'positive', 'Clean streak: ' + d.cleanDayStreak + ' days',
            'You have ' + d.cleanDayStreak + ' clean trading day' + (d.cleanDayStreak === 1 ? '' : 's') + ' in a row — no hard-rule violations. Best ever: ' + d.bestCleanDayStreak + '.',
            [], null));
    }
    return { findings: out, dims, rules };
}

// ---- session intelligence ---------------------------------------------------------
function sessionIntel(ctx) {
    const out = [];
    const T = ctx.period;
    if (T.length < 10) return { findings: out, tables: {} };
    const rank = key => {
        const m = {};
        T.forEach(t => { const k = t[key] || '—'; (m[k] = m[k] || []).push(t); });
        return Object.keys(m).map(k => {
            const g = m[k];
            return { key: k, n: g.length, pnl: sumPnl(g), winRate: g.filter(t => t.pnl > 0).length / g.length, avgR: avg(g, t => t.r) };
        }).filter(r => r.n >= 5).sort((x, y) => y.avgR - x.avgR);
    };
    const bySession = rank('session');
    const bySetup = rank('setup');
    const bySymbol = rank('symbol');
    const byDirection = rank('dir');
    if (bySession.length) {
        const best = bySession[0], worst = bySession[bySession.length - 1];
        if (best.avgR > 0 && best.n >= 5) {
            out.push(finding('ses-best', 'positive', 'Your edge is the ' + best.key + ' session',
                best.key + ' is your best session — ' + Math.round(best.winRate * 100) + '% win rate, ' + best.avgR.toFixed(2) + 'R average across ' + best.n + ' trades (' + money(best.pnl) + ').',
                T.filter(t => t.session === best.key), best.pnl));
        }
        if (worst.avgR < 0 && worst.key !== best.key && worst.n >= 5) {
            out.push(finding('ses-worst', 'warning', 'The ' + worst.key + ' session drains you',
                worst.key + ' averages ' + worst.avgR.toFixed(2) + 'R across ' + worst.n + ' trades (' + money(worst.pnl) + ') — your worst session by expectancy.',
                T.filter(t => t.session === worst.key), worst.pnl));
        }
    }
    if (bySetup.length) {
        const best = bySetup[0];
        if (best.avgR > 0 && best.n >= 5) {
            out.push(finding('setup-best', 'positive', best.key + ' is your highest-conviction setup',
                best.key + ': ' + Math.round(best.winRate * 100) + '% win rate, ' + best.avgR.toFixed(2) + 'R across ' + best.n + ' trades.',
                T.filter(t => t.setup === best.key), best.pnl));
        }
    }
    if (bySymbol.length) {
        const best = bySymbol[0], worst = bySymbol[bySymbol.length - 1];
        if (best.avgR > 0 && worst.avgR < 0 && best.key !== worst.key) {
            out.push(finding('sym-spread', 'observation', best.key + ' vs ' + worst.key + ': a ' + (best.avgR - worst.avgR).toFixed(2) + 'R expectancy spread',
                best.key + ' averages ' + best.avgR.toFixed(2) + 'R (' + best.n + ' trades) while ' + worst.key + ' averages ' + worst.avgR.toFixed(2) + 'R (' + worst.n + ' trades). The data is telling you where to concentrate.',
                [...T.filter(t => t.symbol === best.key), ...T.filter(t => t.symbol === worst.key)], null));
        }
    }
    return { findings: out, tables: { session: bySession, setup: bySetup, symbol: bySymbol, dir: byDirection } };
}

// ---- tilt detection (the user's OWN episodes are the baseline) -------------------
function tiltAnalysis(ctx) {
    const T = ctx.trades;                                   // newest first, full history
    if (T.length < 8) return [];
    const chrono = T.slice().reverse();
    const baseRisk = avg(T, t => t.risk) || 1;

    const episodes = [];
    for (let i = 0; i + 3 <= chrono.length; i++) {
        const win = chrono.slice(i, i + 3);
        const losses = win.filter(t => t.pnl < 0).length;
        let escal = 0;
        for (let j = 1; j < win.length; j++) if (win[j - 1].pnl < 0 && win[j].risk > win[j - 1].risk) escal++;
        const emo = win.some(t => t.emotion === 'Revenge' || t.emotion === 'FOMO');
        if (losses >= 2 && (escal > 0 || emo)) {
            episodes.push({ trades: win, losses, riskMult: avg(win, t => t.risk) / baseRisk, pnl: sumPnl(win), escal, emo });
        }
    }
    const recent = T.slice(0, Math.min(5, T.length));
    const recentLosses = recent.filter(t => t.pnl < 0).length;
    let recentEscal = 0;
    for (let i = 0; i + 1 < recent.length; i++) if (recent[i + 1].pnl < 0 && recent[i].risk > recent[i + 1].risk) recentEscal++;
    const recentEmo = recent.some(t => t.emotion === 'Revenge' || t.emotion === 'FOMO');
    const recentRiskMult = avg(recent, t => t.risk) / baseRisk;
    const inTilt = recentLosses >= 2 && (recentEscal > 0 || recentEmo || recentRiskMult > 1.15);
    const avgEpPnl = episodes.length ? avg(episodes, e => e.pnl) : 0;
    const avgEpRisk = episodes.length ? avg(episodes, e => e.riskMult) : 0;

    const msg = inTilt
        ? 'Your last ' + recent.length + ' trades match your tilt signature: ' + recentLosses + ' losses, ' + (recentEscal ? 'risk escalation' : 'emotional entries') + (recentRiskMult > 1.15 ? ', ' + Math.round(recentRiskMult * 100) + '% of your normal risk' : '') + '. You have ' + episodes.length + ' similar episode' + (episodes.length === 1 ? '' : 's') + ' in your history' + (episodes.length ? ' averaging ' + money(avgEpPnl) + ' and ' + Math.round(avgEpRisk * 100) + '% risk — this is how your bad periods look before they happen.' : '.') + ' Step away or cut size to your minimum.'
        : (episodes.length
            ? 'No active tilt signal in your last ' + recent.length + ' trades. You have ' + episodes.length + ' historical tilt episode' + (episodes.length === 1 ? '' : 's') + ' (avg ' + money(avgEpPnl) + ', ' + Math.round(avgEpRisk * 100) + '% risk) — the current calm is the right state to protect.'
            : 'No tilt episodes detected in your history yet — keep logging; the mentor learns your signature as your sample grows.');
    const ev = (episodes.length ? episodes.slice(-3).flatMap(e => e.trades) : recent).slice(0, 8);
    return [{
        id: 'ai-tilt-' + T.length + '-' + (ev[0] ? ev[0].id : 'none'),
        type: 'tilt', sev: inTilt ? 'critical' : 'positive',
        title: inTilt ? 'Tilt pattern active — this is how your bad periods start' : 'Tilt watch: ' + episodes.length + ' historical episode' + (episodes.length === 1 ? '' : 's') + ' on record',
        msg, ev: ev.map(t => t.id), count: recent.length,
        cost: episodes.length ? Math.round(avgEpPnl) : null,
        confidence: episodes.length >= 3 ? 'high' : 'medium'
    }];
}

// ---- trade autopsy ---------------------------------------------------------------
function autopsy(core, trade) {
    const t = { ...trade, ts: new Date(trade.ts) };
    const spec = core.assetSpecFor ? core.assetSpecFor(t.symbol) : null;
    const strat = core.StrategyMaster.find(m => m.id === t.strategy_id);
    const evals = (core.TradeService && core.TradeService.evaluationsFor)
        ? core.TradeService.evaluationsFor(t.id)
        : [];
    const fails = evals.filter(e => e.state === 'FAIL');
    const verdict = t.adherence_result === 'BLOCK' ? 'Blocked'
        : fails.length ? 'Violation' : 'Followed plan';
    return {
        tradeId: t.id, symbol: t.symbol, dir: t.dir, ts: t.ts.toISOString(),
        pnl: t.pnl, r: t.r, risk: t.risk, entry: t.entry, exit: t.exit, size: t.size,
        unit: spec ? spec.unit : 'units', sizeLabel: spec ? spec.sizeLabel : 'units',
        assetClass: spec ? spec.assetClass : 'Other',
        adherence: t.adherence, emotion: t.emotion, session: t.session, setup: t.setup,
        strategy: strat ? strat.name : (t.strategy || '—'),
        note: t.note || '', verdict, fails: fails.map(f => f.explanation),
        rules: evals.map(e => ({ label: e.ruleLabel || e.ruleKey, expected: e.expected, actual: e.actual, state: e.state }))
    };
}

// ---------------------------------------------------------------------------
// BUNDLE — the normalized mentor dataset the API returns and ai.html renders
// ---------------------------------------------------------------------------
function mentorBundle(core, accountId, opts) {
    const period = (opts && opts.period) || '30d';
    const sinceMs = opts && opts.sinceMs;
    const ctx = buildContext(core, accountId, period, sinceMs);
    if (!ctx) return null;

    const patterns = detectPatterns(ctx);
    const psychology = psychologyAnalysis(ctx);
    const risk = riskAnalysis(ctx);
    const discipline = disciplineCoach(ctx);
    const sessions = sessionIntel(ctx);
    const tilt = tiltAnalysis(ctx);

    const T = ctx.period;
    const a = ctx.a, d = ctx.disc;
    const criticals = patterns.filter(f => f.sev === 'critical');
    const warnings = patterns.filter(f => f.sev === 'warning');
    const strengths = patterns.filter(f => f.sev === 'positive').concat(discipline.findings.filter(f => f.sev === 'positive'));
    const top = criticals.concat(warnings).slice(0, 3);

    const coachMsg = T.length < 10
        ? 'Your sample is still small (' + T.length + ' trades in range). Keep journaling — evidence-backed findings unlock at 10+.'
        : (top.length ? 'Your biggest leak right now: "' + top[0].title + '" — ' + top[0].count + ' occurrences in the current range. ' + (tilt[0] && tilt[0].sev === 'critical' ? 'And the tilt detector is flashing. Today is a day to protect capital.' : 'Fix this one thing and your process improves more than any other change.') : 'No critical patterns in range. ' + (strengths.length ? 'Double down on what works: ' + strengths[0].title + '.' : 'Keep logging.'));

    const autopsies = ctx.trades.slice(0, Math.min(3, ctx.trades.length)).map(t => autopsy(core, t));

    return {
        accountId,
        period,
        generatedAt: new Date().toISOString(),
        account: { name: ctx.account.name, equity: ctx.account.current_equity },
        context: {
            tradeCount: T.length,
            totalTrades: ctx.trades.length,
            netPnl: Math.round(a.net), winRate: a.n ? Math.round(a.winRate * 100) : 0,
            expectancy: Math.round(a.expectancy * 100) / 100,
            maxDD: Math.round(a.maxDD), recovery: a.maxDD ? Math.round(a.recovery * 100) / 100 : 0,
            disciplineScore: d && d.score != null ? d.score : null,
            violations: ctx.viols.length,
            cleanStreak: d ? d.cleanDayStreak : 0, bestCleanStreak: d ? d.bestCleanDayStreak : 0,
            avgRisk: risk.avgRisk, riskSd: risk.riskSd,
            policyRiskPerTrade: (ctx.policy && ctx.policy.values && ctx.policy.values.riskPerTrade) || null
        },
        coach: { message: coachMsg, patterns: top, strengths: strengths.slice(0, 2) },
        patterns,
        psychology: { findings: psychology.findings, emotionTable: psychology.emotionTable },
        risk: { findings: risk.findings, histogram: risk.histogram },
        discipline: { findings: discipline.findings, dims: discipline.dims, rules: discipline.rules },
        sessions: { findings: sessions.findings, tables: sessions.tables },
        tilt,
        autopsies
    };
}

// ---------------------------------------------------------------------------
// AI_FINDINGS CACHE — user-scoped prefs (suppressed / feedback) persisted to
// Supabase (ai_findings table, migration 008) with a per-user JSON fallback.
// ---------------------------------------------------------------------------
async function loadPrefs(userId) {
    const pool = db.getPool();
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT finding_id, suppressed, feedback FROM ai_findings WHERE user_id = $1', [userId]);
            const map = {};
            r.rows.forEach(row => { map[row.finding_id] = { suppressed: !!row.suppressed, feedback: row.feedback == null ? null : Number(row.feedback) }; });
            return map;
        } catch (e) { /* DB unavailable → file fallback */ }
    }
    try {
        const f = fileFor(userId);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { /* ignore */ }
    return {};
}

async function saveFindings(userId, findings) {
    const pool = db.getPool();
    if (pool) {
        try {
            for (const f of findings) {
                await pool.query(
                    `INSERT INTO ai_findings (user_id, finding_id, finding_type, severity, title, message, evidence, cost, confidence, first_seen, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9, now(), now())
                     ON CONFLICT (user_id, finding_id) DO UPDATE SET
                       finding_type = EXCLUDED.finding_type, severity = EXCLUDED.severity,
                       title = EXCLUDED.title, message = EXCLUDED.message, evidence = EXCLUDED.evidence,
                       cost = EXCLUDED.cost, confidence = EXCLUDED.confidence, updated_at = now()`,
                    [userId, f.id, f.type, f.sev, f.title, f.msg, JSON.stringify(f.ev || []), f.cost, f.confidence]);
            }
            return;
        } catch (e) { /* fall through to file */ }
    }
    try {
        const f = fileFor(userId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        let prefs = {};
        if (fs.existsSync(f)) prefs = JSON.parse(fs.readFileSync(f, 'utf8'));
        findings.forEach(fd => { prefs[fd.id] = prefs[fd.id] || { suppressed: false, feedback: null }; });
        fs.writeFileSync(f, JSON.stringify(prefs, null, 2));
    } catch (e) { /* cache write failure is non-fatal */ }
}

async function setPref(userId, findingId, patch) {
    const pool = db.getPool();
    if (pool) {
        try {
            if (patch.suppressed !== undefined) {
                await pool.query('UPDATE ai_findings SET suppressed = $3, updated_at = now() WHERE user_id = $1 AND finding_id = $2',
                    [userId, findingId, !!patch.suppressed]);
            }
            if (patch.feedback !== undefined) {
                await pool.query('UPDATE ai_findings SET feedback = $3, updated_at = now() WHERE user_id = $1 AND finding_id = $2',
                    [userId, findingId, patch.feedback == null ? null : Number(patch.feedback)]);
            }
            return true;
        } catch (e) { /* fall through to file */ }
    }
    try {
        const f = fileFor(userId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        let prefs = {};
        if (fs.existsSync(f)) prefs = JSON.parse(fs.readFileSync(f, 'utf8'));
        prefs[findingId] = Object.assign(prefs[findingId] || { suppressed: false, feedback: null }, patch);
        fs.writeFileSync(f, JSON.stringify(prefs, null, 2));
        return true;
    } catch (e) { return false; }
}

// The request path: compute → merge cached prefs → persist → return (with
// suppressed findings filtered out so the user's dismissals actually hide).
async function mentorWithPrefs(core, accountId, opts) {
    const bundle = mentorBundle(core, accountId, opts);
    if (!bundle) return null;
    const userId = (opts && opts.userId) || 'anon';
    const prefs = await loadPrefs(userId);
    const all = [
        ...bundle.patterns, ...bundle.psychology.findings, ...bundle.risk.findings,
        ...bundle.discipline.findings, ...bundle.sessions.findings, ...bundle.tilt
    ];
    const attach = f => {
        const p = prefs[f.id];
        if (p) { f.suppressed = p.suppressed; f.feedback = p.feedback; }
        return f;
    };
    const hidden = f => !!(attach(f).suppressed);
    // Finding arrays live at different depths: patterns/tilt are top-level,
    // psychology/risk/discipline/sessions nest under .findings.
    const FINDING_SECTIONS = [
        ['patterns', null], ['tilt', null],
        ['psychology', 'findings'], ['risk', 'findings'],
        ['discipline', 'findings'], ['sessions', 'findings']
    ];
    const section = ([a, b]) => (b ? bundle[a][b] : bundle[a]);
    // The dismissed-findings management view needs EVERYTHING (suppressed ones
    // included, flagged); the normal coach view filters them out so a
    // dismissal really hides the finding. Both attach prefs and persist.
    const keepAll = !!(opts && opts.includeSuppressed);
    FINDING_SECTIONS.forEach(([a, b]) => {
        const arr = section([a, b]);
        const out = keepAll ? arr.map(attach) : arr.filter(f => !hidden(f));
        if (b) bundle[a][b] = out; else bundle[a] = out;
    });
    bundle.coach.patterns = keepAll ? bundle.coach.patterns.map(attach) : bundle.coach.patterns.filter(f => !hidden(f));
    bundle.coach.strengths = keepAll ? bundle.coach.strengths.map(attach) : bundle.coach.strengths.filter(f => !hidden(f));
    await saveFindings(userId, all);
    return bundle;
}

function money(n) {
    return (n >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
}

module.exports = {
    mentorBundle,
    mentorWithPrefs,
    autopsy,
    buildContext,
    detectPatterns,
    psychologyAnalysis,
    riskAnalysis,
    disciplineCoach,
    sessionIntel,
    tiltAnalysis,
    loadPrefs,
    saveFindings,
    setPref
};
