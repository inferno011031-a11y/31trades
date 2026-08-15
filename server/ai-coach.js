'use strict';

// ============================================================================
// 31TRADES — AI Backtest Coach
// ----------------------------------------------------------------------------
// Reviews a finished practice session through the same evidence-first lens as
// the AI Mentor (server/ai-mentor.js): findings only exist when the data shows
// them, each one carries the exact trades it is based on, and coaching is
// grounded in the user's own recorded decisions — never generic advice.
//
// It reads a backtest session from the Simulation Engine (server/backtest-sim.js)
// — the canonical source of recorded practice trades — and inspects:
//   · premature entries      (resolved within N bars of entry)
//   · weak setups            (setup tags with poor win rate / net)
//   · inconsistent risk      (risk-per-trade variance, oversized risk %)
//   · exit quality           (SL dominance, poor targets)
//   · revenge behavior       (new trade right after a loss)
//   · strong conditions      (setups/sessions that actually worked)
// ============================================================================

const Sim = require('./backtest-sim.js');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const avg = (list, f) => list.length ? list.reduce((s, x) => s + (f(x) || 0), 0) / list.length : 0;

// stable id — deterministic per finding so dismissal/prefs can key on it later
function finding(type, sev, title, detail, evidence, confidence) {
    const first = evidence[0] || 'none';
    return {
        id: 'btc-' + type + '-' + evidence.length + '-' + first,
        type, sev, title, detail,
        evidence: evidence.slice(0, 10),
        count: evidence.length,
        confidence: confidence || (evidence.length >= 6 ? 'high' : evidence.length >= 3 ? 'medium' : 'low')
    };
}

function coach(session) {
    const out = [];
    if (!session) return { ok: false, error: 'unknown session' };
    const trades = (session.trades || []).slice().sort((a, b) => a.exitIndex - b.exitIndex);
    const n = trades.length;
    const push = (type, sev, title, detail, ev, conf) => {
        if (ev.length >= (type === 'strength' ? 2 : 1)) out.push(finding(type, sev, title, detail, ev, conf));
    };

    // summary for the header
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const net = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = n ? wins.length / n : 0;

    // 1 · premature entries — resolved within 2 bars of entry
    const premature = trades.filter(t => (t.exitIndex != null && t.entryIndex != null) && (t.exitIndex - t.entryIndex) <= 2);
    if (premature.length >= 2) {
        const cost = premature.reduce((s, t) => s + t.pnl, 0);
        push('premature-entry', 'warning', 'Premature entries',
            premature.length + ' of ' + n + ' trades resolved within 2 bars of entry' + (cost <= 0 ? ' — net ' + cost.toFixed(0) + '$ on these.' : '.'),
            premature.map(t => t.id), 'high');
    }

    // 2 · weak setups — tags with < 40% win rate and ≥ 3 trades
    const bySetup = {};
    trades.forEach(t => { (bySetup[t.setup || 'No setup'] = bySetup[t.setup || 'No setup'] || []).push(t); });
    Object.keys(bySetup).forEach(k => {
        const g = bySetup[k];
        if (g.length < 3) return;
        const wr = g.filter(t => t.pnl > 0).length / g.length;
        const netG = g.reduce((s, t) => s + t.pnl, 0);
        if (wr < 0.4) {
            push('weak-setup', 'warning', 'Setup to rework: ' + k,
                k + ' won ' + Math.round(wr * 100) + '% of ' + g.length + ' practice trades — ' + netG.toFixed(0) + '$ net. ' + (netG < 0 ? 'Consider skipping or re-entering this setup.' : 'Edge is thin — tighten the entry.'),
                g.map(t => t.id), 'medium');
        } else if (wr >= 0.6 && g.length >= 4) {
            push('strength', 'positive', 'Strong setup: ' + k,
                k + ' won ' + Math.round(wr * 100) + '% across ' + g.length + ' trades for ' + netG.toFixed(0) + '$ — this is your edge in practice.',
                g.map(t => t.id), 'high');
        }
    });

    // 3 · inconsistent risk — CV of risk per trade + oversized risk %
    const amounts = trades.map(t => t.riskAmount).filter(r => r > 0);
    if (amounts.length >= 3) {
        const mean = avg(amounts, x => x);
        const sd = Math.sqrt(avg(amounts, x => (x - mean) * (x - mean)));
        const cv = mean ? sd / mean : 0;
        if (cv > 0.35) {
            push('risk-inconsistency', 'warning', 'Inconsistent risk per trade',
                'Risk varied by ' + Math.round(cv * 100) + '% (CV) — from ' + Math.min.apply(null, amounts) + '$ to ' + Math.max.apply(null, amounts) + '$ across ' + amounts.length + ' trades. Consistency is how drawdowns stay controlled.',
                trades.filter(t => t.riskAmount > 0).map(t => t.id), 'high');
        }
    }
    const oversized = trades.filter(t => t.riskPct > 1);
    if (oversized.length) {
        push('oversizing', 'warning', 'Oversized risk',
            oversized.length + ' trade(s) risked more than 1% of balance (up to ' + Math.max.apply(null, oversized.map(t => t.riskPct)).toFixed(2) + '%).',
            oversized.map(t => t.id), 'medium');
    }

    // 4 · exit quality — SL dominance / TP rate
    if (n >= 3) {
        const sl = trades.filter(t => t.exitReason === 'SL').length;
        const tp = trades.filter(t => t.exitReason === 'TP').length;
        if (sl / n >= 0.6) {
            push('stop-dominant', 'warning', 'Stops are doing the exits',
                Math.round(sl / n * 100) + '% of exits were stop losses (TP only ' + Math.round(tp / n * 100) + '%). Entries may be too early relative to the setup.',
                trades.filter(t => t.exitReason === 'SL').map(t => t.id), 'medium');
        }
        // planned RR vs realized: are winners cut short?
        const winsRealized = wins.filter(t => t.exitReason === 'manual');
        if (winsRealized.length >= 2 && tp === 0) {
            push('early-exit', 'warning', 'Winners closed manually before target',
                winsRealized.length + ' winning trades were closed by hand instead of hitting the target — check if you are cutting winners short.',
                winsRealized.map(t => t.id), 'low');
        }
    }

    // 5 · revenge behavior — new trade within a bar after a loss
    const revenge = [];
    for (let i = 1; i < trades.length; i++) {
        if (trades[i - 1].pnl <= 0 && (trades[i].entryIndex - trades[i - 1].exitIndex) <= 1) revenge.push(trades[i].id);
    }
    if (revenge.length >= 2) {
        push('revenge', 'warning', 'Re-entry right after a loss',
            revenge.length + ' trades entered within a bar of a losing trade — the classic revenge pattern.',
            revenge, 'medium');
    }

    // 6 · session performance (strongest condition)
    const bySession = {};
    trades.forEach(t => {
        const k = sessionOfTime(t.entryTime);
        (bySession[k] = bySession[k] || []).push(t);
    });
    const best = Object.keys(bySession).map(k => ({ k, g: bySession[k] }))
        .filter(x => x.g.length >= 3)
        .sort((a, b) => b.g.reduce((s, t) => s + t.pnl, 0) - a.g.reduce((s, t) => s + t.pnl, 0))[0];
    if (best) {
        const netB = best.g.reduce((s, t) => s + t.pnl, 0);
        if (netB > 0) {
            push('strength', 'positive', 'Best session: ' + best.k,
                best.k + ' produced ' + netB.toFixed(0) + '$ over ' + best.g.length + ' trades in practice — prioritize these hours.',
                best.g.map(t => t.id), 'medium');
        }
    }

    // 7 · risk-reward discipline — planned RR vs realized
    const avgRR = avg(trades, t => t.plannedRR);
    if (n >= 3 && avgRR < 1.5) {
        push('rr-thin', 'info', 'Thin reward profile',
            'Average planned R:R is ' + avgRR.toFixed(2) + 'R — targets below 1.5R make it hard to stay profitable through normal losses.',
            trades.map(t => t.id), 'low');
    }

    const summary = {
        sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe,
        strategy: session.strategy, trades: n, wins: wins.length, losses: losses.length,
        winRate: Math.round(winRate * 10000) / 100, net: Math.round(net * 100) / 100,
        startingBalance: session.startingBalance, endingBalance: session.balance,
        status: session.status
    };
    return { ok: true, summary, findings: out };
}

function sessionOfTime(ts) {
    if (!ts) return '—';
    const h = new Date(ts * 1000).getUTCHours();
    if (h >= 13 && h < 21) return 'New York';
    if (h >= 7 && h < 13) return 'London';
    if (h >= 23 || h < 9) return 'Asia';
    return 'Sydney';
}

module.exports = { coach, sessionOfTime };
