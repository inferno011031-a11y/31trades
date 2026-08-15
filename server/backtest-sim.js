'use strict';

// ============================================================================
// 31TRADES — Backtest Simulation Engine (battle-reusable)
// ----------------------------------------------------------------------------
// The PRD's core layer: a practice environment where every simulated decision
// is recorded, kept strictly separate from LIVE/Journal records. This module
// owns the replay position, order validation, SL/TP simulation, risk-based
// position sizing, trade recording, and derived results — and is deliberately
// free of any page/API logic so the same engine can drive Online Battles later
// (one canonical timeline, all participants at the same replay position).
//
//   Timeline (OHLCV) ──▶ BacktestSession ──▶ enter/close orders ──▶ trades[]
//                              │                      │
//                              └── results() ◀────────┘  (pure derivation)
//
// Persistence is per-user JSON (data/backtest-<userId>.json), the same
// local-first pattern as brokers/notifications. Backtest trades NEVER touch
// the canonical live Trades collection.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Risk / sizing helpers
// ---------------------------------------------------------------------------
// Given a direction and SL distance, derive position size (units) from a risk
// amount so P&L and R are consistent: units = risk / slDistance.
function sizeFromRisk(dir, entry, sl, riskAmount) {
    const dist = Math.abs(entry - sl);
    if (!(dist > 0)) return 0;
    return riskAmount / dist;
}
function rrOf(entry, sl, tp) {
    const slDist = Math.abs(entry - sl);
    const tpDist = Math.abs(tp - entry);
    return slDist > 0 ? tpDist / slDist : 0;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
class BacktestSession {
    constructor(opts) {
        const o = opts || {};
        this.id = o.id || 'bt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        this.userId = o.userId || 'anon';
        this.symbol = String(o.symbol || 'EURUSD').toUpperCase();
        this.timeframe = String(o.timeframe || '1h');
        this.strategy = o.strategy || 'Manual practice';
        this.category = o.category || 'Forex';
        this.startingBalance = Number(o.startingBalance) > 0 ? Number(o.startingBalance) : 10000;
        this.riskModel = o.riskModel || { basis: 'money', perTrade: 25 };   // { basis: 'money'|'pct', perTrade }
        this.candles = (o.candles || []).map(c => ({ ...c }));              // canonical timeline
        this.startIndex = Math.max(0, Math.min(o.startIndex || 0, this.candles.length - 1));
        this.cursor = o.cursor != null ? Math.max(this.startIndex, Math.min(this.candles.length - 1, o.cursor)) : this.startIndex;
        this.position = o.position || null;                                 // open position or null
        this.trades = (o.trades || []).map(t => ({ ...t }));                // closed trades (recorded)
        this.actions = (o.actions || []).map(a => ({ ...a }));              // full audit trail
        this.status = o.status || 'running';
        this.createdAt = o.createdAt || new Date().toISOString();
        this.completedAt = o.completedAt || null;
        this.balance = Number(o.balance != null ? o.balance : this.startingBalance);
        this.peak = Number(o.peak != null ? o.peak : this.startingBalance);
    }

    balanceAt(idx) {
        let bal = this.startingBalance;
        for (const t of this.trades) {
            if (t.exitIndex != null && (idx == null || t.exitIndex <= idx)) bal += t.pnl;
        }
        return bal;
    }

    // ---- replay controls ---------------------------------------------------
    visibleCandles() {
        return this.candles.slice(0, this.cursor + 1);
    }

    setCursor(idx) {
        const next = Math.max(this.startIndex, Math.min(this.candles.length - 1, idx));
        if (next < this.cursor) { this.cursor = next; return; }   // rewinding never re-simulates
        // advance bar by bar so SL/TP fills happen on the exact bar
        while (this.cursor < next && this.cursor < this.candles.length - 1) {
            this.cursor++;
            this._simulateBar(this.candles[this.cursor]);
        }
        this._refreshBalance();
    }

    _simulateBar(bar) {
        const p = this.position;
        if (!p) return;
        // intrabar precedence — conservative: the losing fill happens first
        if (p.dir === 'Long') {
            if (bar.low <= p.sl) return this._fillExit(bar, p.sl, 'SL');
            if (bar.high >= p.tp) return this._fillExit(bar, p.tp, 'TP');
        } else {
            if (bar.high >= p.sl) return this._fillExit(bar, p.sl, 'SL');
            if (bar.low <= p.tp) return this._fillExit(bar, p.tp, 'TP');
        }
    }

    _fillExit(bar, price, reason) {
        const p = this.position;
        const pnl = this._pnlAt(p, price);
        const r = p.riskAmount > 0 ? pnl / p.riskAmount : 0;
        const trade = {
            id: 'btt_' + this.trades.length + '_' + Math.random().toString(36).slice(2, 6),
            sessionId: this.id,
            userId: this.userId,
            symbol: this.symbol,
            timeframe: this.timeframe,
            strategy: this.strategy,
            category: this.category,
            direction: p.dir,
            entryTime: p.openedAt,
            exitTime: bar.time,
            entryIndex: p.openedAtIdx,
            exitIndex: this.cursor,
            entry: p.entry,
            exit: price,
            sl: p.sl,
            tp: p.tp,
            size: p.size,
            riskAmount: p.riskAmount,
            riskPct: p.riskPct,
            plannedRR: p.rr,
            realizedR: Math.round(r * 1000) / 1000,
            pnl: Math.round(pnl * 100) / 100,
            result: pnl >= 0 ? 'win' : 'loss',
            exitReason: reason,
            setup: p.setup || '',
            notes: p.notes || '',
            openedAt: new Date().toISOString(),
            closedAt: new Date().toISOString()
        };
        this.trades.push(trade);
        this._log('close', { tradeId: trade.id, reason, price, pnl, r: trade.realizedR });
        this.position = null;
        this._refreshBalance();
    }

    _pnlAt(p, price) {
        return p.dir === 'Long' ? (price - p.entry) * p.size : (p.entry - price) * p.size;
    }

    _refreshBalance() {
        this.balance = this.balanceAt();
        if (this.balance > this.peak) this.peak = this.balance;
    }

    _log(type, payload) {
        this.actions.push({ type, at: new Date().toISOString(), cursor: this.cursor, ...payload });
    }

    // ---- orders ------------------------------------------------------------
    // @param {object} o { direction: 'Long'|'Short', entry, sl, tp,
    //                      riskAmount?, riskPct?, size?, notes, setup }
    enter(o) {
        if (this.position) return { ok: false, error: 'position already open' };
        const dir = String(o.direction || '').toLowerCase();
        if (dir !== 'long' && dir !== 'short') return { ok: false, error: 'direction must be Long or Short' };
        const bar = this.candles[this.cursor];
        if (!bar) return { ok: false, error: 'no candle at replay position' };
        const entry = o.entry != null ? Number(o.entry) : bar.close;
        const sl = Number(o.sl);
        const tp = Number(o.tp);
        if (!(entry > 0) || !(sl > 0)) return { ok: false, error: 'entry and stop loss are required' };
        const long = dir === 'long';
        if (long && sl >= entry) return { ok: false, error: 'stop loss must be below entry for a long' };
        if (!long && sl <= entry) return { ok: false, error: 'stop loss must be above entry for a short' };
        if (tp > 0) {
            if (long && tp <= entry) return { ok: false, error: 'take profit must be above entry for a long' };
            if (!long && tp >= entry) return { ok: false, error: 'take profit must be below entry for a short' };
        }
        // risk amount: explicit, or % of balance, or derived from size
        let riskAmount = Number(o.riskAmount);
        const slDist = Math.abs(entry - sl);
        if (!(riskAmount > 0) && o.riskPct) {
            riskAmount = this.balance * (Number(o.riskPct) / 100);
        }
        let size = Number(o.size);
        if (!(riskAmount > 0) && !(size > 0)) {
            // default to the account risk model
            const per = this.riskModel.perTrade || 25;
            riskAmount = this.riskModel.basis === 'pct' ? this.balance * (per / 100) : per;
        }
        if (!(size > 0)) size = sizeFromRisk(long ? 1 : -1, entry, sl, riskAmount);
        if (!(size > 0)) return { ok: false, error: 'cannot size position — check risk and stop distance' };
        if (!(riskAmount > 0)) riskAmount = Math.abs(slDist * size);
        const rr = tp > 0 ? rrOf(entry, sl, tp) : 0;
        this.position = {
            dir: long ? 'Long' : 'Short',
            entry, sl, tp: tp > 0 ? tp : null,
            size: Math.round(size * 1e6) / 1e6,
            riskAmount: Math.round(riskAmount * 100) / 100,
            riskPct: this.balance > 0 ? Math.round((riskAmount / this.balance) * 10000) / 100 : 0,
            rr: Math.round(rr * 100) / 100,
            notes: String(o.notes || ''),
            setup: String(o.setup || ''),
            openedAt: bar.time,
            openedAtIdx: this.cursor
        };
        this._log('enter', { direction: this.position.dir, entry, sl, tp, size: this.position.size, riskAmount: this.position.riskAmount });
        // if SL is inside the entry bar it fills immediately (discipline)
        this._simulateBar(bar);
        return { ok: true, position: this.position };
    }

    close(o) {
        if (!this.position) return { ok: false, error: 'no open position' };
        const bar = this.candles[this.cursor];
        const price = o && o.price != null ? Number(o.price) : (bar ? bar.close : this.position.entry);
        this._fillExit(bar || { time: Date.now(), close: price, low: price, high: price }, price, String((o && o.reason) || 'manual'));
        return { ok: true, position: null, trade: this.trades[this.trades.length - 1] };
    }

    // ---- results (pure derivation) -------------------------------------------
    results() {
        const t = this.trades;
        const wins = t.filter(x => x.pnl > 0);
        const losses = t.filter(x => x.pnl <= 0);
        const net = t.reduce((a, x) => a + x.pnl, 0);
        const grossP = wins.reduce((a, x) => a + x.pnl, 0);
        const grossL = Math.abs(losses.reduce((a, x) => a + x.pnl, 0));
        const winRate = t.length ? wins.length / t.length : 0;
        const profitFactor = grossL ? grossP / grossL : (grossP > 0 ? Infinity : 0);
        const expectancy = t.length ? t.reduce((a, x) => a + x.realizedR, 0) / t.length : 0;
        const avgR = t.length ? t.reduce((a, x) => a + x.realizedR, 0) / t.length : 0;
        const avgWinner = wins.length ? wins.reduce((a, x) => a + x.pnl, 0) / wins.length : 0;
        // avgLoser is a magnitude (like grossLoss) — consumers render the sign
        const avgLoser = losses.length ? Math.abs(losses.reduce((a, x) => a + x.pnl, 0) / losses.length) : 0;
        // equity curve + max drawdown
        const equity = [{ idx: 0, balance: this.startingBalance }];
        let bal = this.startingBalance, peak = this.startingBalance, maxDD = 0;
        t.forEach(x => {
            bal += x.pnl; equity.push({ idx: x.exitIndex, balance: Math.round(bal * 100) / 100 });
            if (bal > peak) peak = bal;
            maxDD = Math.max(maxDD, peak - bal);
        });
        // best / worst
        const sorted = t.slice().sort((a, b) => b.pnl - a.pnl);
        // streaks (consecutive wins/losses by close order)
        let bestStreak = 0, curStreak = 0, worstStreak = 0, curLoss = 0;
        t.forEach(x => {
            if (x.pnl > 0) { curStreak++; curLoss = 0; bestStreak = Math.max(bestStreak, curStreak); }
            else { curLoss++; curStreak = 0; worstStreak = Math.max(worstStreak, curLoss); }
        });
        // breakdowns
        const bySetup = groupBy(t, x => x.setup || 'No setup');
        const byDir = groupBy(t, x => x.direction);
        const bySession = groupBy(t, x => sessionOf(x.entryTime));
        const byTime = groupBy(t, x => hourOf(x.entryTime));
        const byExit = groupBy(t, x => x.exitReason);
        return {
            id: this.id, symbol: this.symbol, timeframe: this.timeframe, strategy: this.strategy,
            status: this.status, createdAt: this.createdAt, completedAt: this.completedAt,
            startingBalance: this.startingBalance, endingBalance: Math.round((this.startingBalance + net) * 100) / 100,
            balance: Math.round(this.balance * 100) / 100, peak: Math.round(this.peak * 100) / 100,
            trades: t.length, wins: wins.length, losses: losses.length,
            net: Math.round(net * 100) / 100, grossProfit: Math.round(grossP * 100) / 100,
            grossLoss: Math.round(grossL * 100) / 100,
            winRate: Math.round(winRate * 10000) / 100, profitFactor: profitFactor === Infinity ? Infinity : Math.round(profitFactor * 100) / 100,
            expectancy: Math.round(expectancy * 1000) / 1000, avgR: Math.round(avgR * 1000) / 1000,
            avgWinner: Math.round(avgWinner * 100) / 100, avgLoser: Math.round(avgLoser * 100) / 100,
            maxDrawdown: Math.round(maxDD * 100) / 100,
            bestTrade: sorted[0] || null, worstTrade: sorted[sorted.length - 1] || null,
            bestWinStreak: bestStreak, worstLossStreak: worstStreak,
            equity, bySetup, byDirection: byDir, bySession, byTimeOfDay: byTime, byExitReason: byExit
        };
    }

    // ---- persistence ----------------------------------------------------------
    serialize() {
        return {
            id: this.id, userId: this.userId, symbol: this.symbol, timeframe: this.timeframe,
            strategy: this.strategy, category: this.category,
            startingBalance: this.startingBalance, riskModel: this.riskModel,
            candles: this.candles, startIndex: this.startIndex, cursor: this.cursor,
            position: this.position, trades: this.trades, actions: this.actions,
            status: this.status, createdAt: this.createdAt, completedAt: this.completedAt,
            balance: this.balance, peak: this.peak
        };
    }
    static hydrate(obj) {
        const s = new BacktestSession(obj);
        return s;
    }
}

// ---- grouping helpers -------------------------------------------------------
function groupBy(arr, keyFn) {
    const out = {};
    arr.forEach(x => {
        const k = keyFn(x);
        out[k] = out[k] || { trades: 0, wins: 0, net: 0, avgR: 0 };
        const g = out[k];
        g.trades++; if (x.pnl > 0) g.wins++;
        g.net = Math.round((g.net + x.pnl) * 100) / 100;
        g.avgR = Math.round((g.avgR + x.realizedR) * 1000) / 1000;
    });
    Object.keys(out).forEach(k => {
        const g = out[k];
        g.winRate = g.trades ? Math.round((g.wins / g.trades) * 10000) / 100 : 0;
        g.avgR = g.trades ? Math.round((g.avgR / g.trades) * 1000) / 1000 : 0;
    });
    return out;
}
function sessionOf(ts) {
    if (!ts) return '—';
    const h = new Date(ts * 1000).getUTCHours();
    if (h >= 13 && h < 21) return 'New York';
    if (h >= 7 && h < 13) return 'London';
    if (h >= 23 || h < 9) return 'Asia';
    return 'Sydney';
}
function hourOf(ts) {
    if (!ts) return '—';
    const h = new Date(ts * 1000).getUTCHours();
    return h + ':00';
}

// ---------------------------------------------------------------------------
// Persistence (per-user, local-first; DB swap later behind same functions)
// ---------------------------------------------------------------------------
function fileFor(userId) {
    return path.join(process.env.TRADEMIND_BACKTEST_DATA_DIR || path.join(__dirname, '..', 'data'), 'backtest-' + userId + '.json');
}
function readAll(userId) {
    try {
        const f = fileFor(userId);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { /* ignore */ }
    return [];
}
function writeAll(userId, list) {
    try {
        const f = fileFor(userId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(list));
    } catch (e) { /* ignore */ }
}
function listSessions(userId) {
    return readAll(userId).map(s => {
        const r = s && s.trades ? null : null;
        const sess = BacktestSession.hydrate(s);
        const res = sess.results();
        return {
            id: sess.id, symbol: sess.symbol, timeframe: sess.timeframe, strategy: sess.strategy,
            status: sess.status, createdAt: sess.createdAt,
            trades: res.trades, net: res.net, winRate: res.winRate,
            balance: sess.balance, open: !!sess.position, cursor: sess.cursor, total: sess.candles.length
        };
    });
}
function getSession(userId, id) {
    const s = readAll(userId).find(x => x.id === id);
    return s ? BacktestSession.hydrate(s) : null;
}
function saveSession(userId, sess) {
    const list = readAll(userId).filter(x => x.id !== sess.id);
    list.push(sess.serialize());
    writeAll(userId, list);
}
function deleteSession(userId, id) {
    writeAll(userId, readAll(userId).filter(x => x.id !== id));
}

// ---------------------------------------------------------------------------
// In-memory registry for live (playing) sessions — timers live here so replay
// playback advances the cursor server-side and saves as it goes.
// ---------------------------------------------------------------------------
const active = new Map();

function loadActive(userId, id) {
    let s = active.get(id);
    if (!s) {
        s = getSession(userId, id);
        if (!s) return null;
        active.set(id, s);
    }
    return s;
}

function play(userId, id, speedMs) {
    const s = loadActive(userId, id);
    if (!s) return { ok: false, error: 'unknown session' };
    const ms = Math.max(40, Number(speedMs) || 300);
    if (s.timer) clearInterval(s.timer);
    let lastSave = Date.now();
    s.timer = setInterval(() => {
        if (s.cursor >= s.candles.length - 1) {
            clearInterval(s.timer); s.timer = null;
            s.status = s.status === 'running' ? 'completed' : s.status;
            s.completedAt = s.completedAt || new Date().toISOString();
            saveSession(userId, s);
            return;
        }
        s.setCursor(s.cursor + 1);
        if (Date.now() - lastSave > 400) { saveSession(userId, s); lastSave = Date.now(); }
    }, ms);
    return { ok: true };
}

function pause(userId, id) {
    const s = active.get(id);
    if (!s) return { ok: true };
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    saveSession(userId, s);
    return { ok: true };
}

function stepSession(userId, id) {
    const s = loadActive(userId, id);
    if (!s) return { ok: false, error: 'unknown session' };
    s.setCursor(s.cursor + 1);
    if (s.cursor >= s.candles.length - 1) {
        s.status = s.status === 'running' ? 'completed' : s.status;
        s.completedAt = s.completedAt || new Date().toISOString();
    }
    saveSession(userId, s);
    return { ok: true };
}

function seekSession(userId, id, idx) {
    const s = loadActive(userId, id);
    if (!s) return { ok: false, error: 'unknown session' };
    const n = Number(idx);
    if (!(n >= 0) || isNaN(n)) return { ok: false, error: 'invalid cursor' };
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    s.setCursor(Math.round(n));
    saveSession(userId, s);
    return { ok: true };
}

function resetSession(userId, id) {
    const s = loadActive(userId, id);
    if (!s) return { ok: false, error: 'unknown session' };
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    s.position = null;
    s.cursor = s.startIndex;
    s.trades = [];
    s.balance = s.startingBalance;
    s.peak = s.startingBalance;
    s.status = 'running';
    s.completedAt = null;
    saveSession(userId, s);
    return { ok: true };
}

function stateOf(s) {
    const pos = s.position;
    const bar = s.candles[s.cursor];
    let unrealized = 0, unrealizedR = 0;
    if (pos) {
        unrealized = s._pnlAt(pos, bar ? bar.close : pos.entry);
        unrealizedR = pos.riskAmount > 0 ? unrealized / pos.riskAmount : 0;
    }
    return {
        id: s.id, symbol: s.symbol, timeframe: s.timeframe, strategy: s.strategy, category: s.category,
        status: s.status, createdAt: s.createdAt, completedAt: s.completedAt,
        startingBalance: s.startingBalance, balance: Math.round(s.balance * 100) / 100,
        riskModel: s.riskModel,
        cursor: s.cursor, total: s.candles.length, startIndex: s.startIndex,
        candle: bar || null,
        position: pos ? {
            direction: pos.dir, entry: pos.entry, sl: pos.sl, tp: pos.tp, size: pos.size,
            riskAmount: pos.riskAmount, riskPct: pos.riskPct, rr: pos.rr,
            notes: pos.notes, setup: pos.setup, openedAt: pos.openedAt,
            unrealized: Math.round(unrealized * 100) / 100, unrealizedR: Math.round(unrealizedR * 1000) / 1000
        } : null,
        trades: s.trades, actions: s.actions.slice(-60),
        candles: s.visibleCandles()
    };
}

module.exports = {
    BacktestSession, listSessions, getSession, saveSession, deleteSession, sizeFromRisk, rrOf,
    stateOf, play, pause, stepSession, seekSession, resetSession, loadActive
};
