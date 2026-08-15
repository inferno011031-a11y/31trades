'use strict';

// ============================================================================
// 31TRADES — Online Battle Engine
// ----------------------------------------------------------------------------
// A layer on top of the Backtest Simulation Engine (NOT a second simulator).
// One canonical historical timeline is shared by every seat: the server owns
// the replay cursor, so no participant can see future candles. Each seat keeps
// its OWN position/trades/balance — decisions stay private during the battle.
// When the canonical cursor advances, the shared engine simulates SL/TP fills
// for every seat on the same bar (fair event ordering). At the end, a scoring
// engine ranks seats by execution quality + risk + consistency — deliberately
// NOT raw profit alone, so oversizing is never rewarded.
//
//   one candles[] array ─▶ Battle (cursor owner) ─▶ seats[] (BacktestSession)
//                              │                          │  private state
//                              └──── scoring() ───────────┘
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const { BacktestSession, stateOf } = require('./backtest-sim.js');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Scoring — blended 0–1000, favoring process over profit
// ---------------------------------------------------------------------------
function scoreSeat(seat) {
    const r = seat.session.results();
    const minTrades = 2;
    const n = r.trades;
    if (!n) return { score: 0, detail: { trades: 0 } };
    const activity = clamp(n / minTrades, 0, 1);           // ≥2 trades = full credit
    const winRateComp = r.winRate / 100;                   // 0..1
    const avgRComp = clamp((r.avgR + 1) / 3, 0, 1);        // -1R → 0, +2R → 1
    const ddRatio = seat.session.startingBalance > 0 ? r.maxDrawdown / (seat.session.startingBalance * 0.06) : 1;
    const riskComp = clamp(1 - ddRatio, 0, 1);             // ≤6% drawdown = full credit
    const risks = r.trades ? null : null;
    // consistency = how uniform risk per trade was (CV of risk amounts)
    const amounts = (seat.session.trades || []).map(t => t.riskAmount).filter(x => x > 0);
    let cv = 0;
    if (amounts.length >= 2) {
        const avg = amounts.reduce((s, x) => s + x, 0) / amounts.length;
        const sd = Math.sqrt(amounts.reduce((s, x) => s + (x - avg) * (x - avg), 0) / amounts.length);
        cv = avg ? sd / avg : 0;
    }
    const consistencyComp = clamp(1 - cv * 0.9, 0, 1);
    const raw = (0.30 * winRateComp + 0.30 * avgRComp + 0.20 * riskComp + 0.20 * consistencyComp);
    const score = Math.round(1000 * raw * activity);
    return {
        score,
        detail: {
            trades: n, wins: r.wins, losses: r.losses, net: r.net, winRate: Math.round(r.winRate * 1000) / 10,
            avgR: Math.round(r.avgR * 1000) / 1000, maxDD: Math.round(r.maxDrawdown * 100) / 100,
            riskCV: Math.round(cv * 1000) / 1000,
            comps: {
                winRate: Math.round(winRateComp * 1000) / 1000,
                avgR: Math.round(avgRComp * 1000) / 1000,
                risk: Math.round(riskComp * 1000) / 1000,
                consistency: Math.round(consistencyComp * 1000) / 1000,
                activity: Math.round(activity * 1000) / 1000
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Battle
// ---------------------------------------------------------------------------
class Battle {
    constructor(opts) {
        const o = opts || {};
        this.id = o.id || 'btl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        this.hostId = o.hostId || 'anon';
        this.title = String(o.title || 'Battle');
        this.symbol = String(o.symbol || 'EURUSD').toUpperCase();
        this.timeframe = String(o.timeframe || '1h');
        this.category = o.category || 'Other';
        this.candles = (o.candles || []).map(c => ({ ...c }));   // the ONE canonical timeline
        this.startIndex = Math.max(0, Math.min(o.startIndex || 0, this.candles.length - 1));
        this.cursor = o.cursor != null ? Math.max(this.startIndex, Math.min(this.candles.length - 1, o.cursor)) : this.startIndex;
        this.startingBalance = Number(o.startingBalance) > 0 ? Number(o.startingBalance) : 10000;
        this.riskModel = o.riskModel || { basis: 'money', perTrade: 25 };
        this.status = o.status || 'lobby';                       // lobby → running → completed
        this.seats = (o.seats || []).map(s => ({
            id: s.id, name: s.name || 'Seat', team: s.team || null,
            userId: s.userId || null,
            session: s.session ? BacktestSession.hydrate(s.session) : null
        }));
        this.createdAt = o.createdAt || new Date().toISOString();
        this.completedAt = o.completedAt || null;
        this.actions = (o.actions || []).map(a => ({ ...a }));
        this.timer = null;
    }

    seat(seatId) {
        return this.seats.find(s => s.id === seatId) || null;
    }

    _ensureSeats() {
        this.seats.forEach((s, i) => {
            if (!s.session) {
                s.session = new BacktestSession({
                    id: 'btls_' + this.id + '_' + i,
                    userId: s.userId || 'seat-' + i,
                    symbol: this.symbol, timeframe: this.timeframe,
                    category: this.category, strategy: s.name,
                    startingBalance: this.startingBalance, riskModel: this.riskModel,
                    candles: this.candles, startIndex: this.startIndex,
                    cursor: this.cursor
                });
            }
        });
    }

    // ---- canonical replay: the server moves ONE cursor for every seat ----
    setCursor(idx) {
        const next = Math.max(this.startIndex, Math.min(this.candles.length - 1, idx));
        if (next === this.cursor) return;
        if (next < this.cursor) { this.cursor = next; return; }   // rewind: no re-simulation
        this._ensureSeats();
        while (this.cursor < next && this.cursor < this.candles.length - 1) {
            this.cursor++;
            for (const s of this.seats) if (s.session) s.session.setCursor(this.cursor);
        }
    }

    start() {
        if (this.status === 'lobby') this.status = 'running';
    }

    // ---- private seat actions ----
    enter(seatId, o) {
        const s = this.seat(seatId);
        if (!s) return { ok: false, error: 'unknown seat' };
        if (this.status === 'completed') return { ok: false, error: 'battle is over' };
        this._ensureSeats();
        const bar = this.candles[this.cursor];
        if (!bar) return { ok: false, error: 'no candle at replay position' };
        // anti-cheat: entries must reference the current (visible) bar only
        const entry = o.entry != null ? Number(o.entry) : bar.close;
        if (entry < bar.low * 0.999 || entry > bar.high * 1.001) {
            return { ok: false, error: 'entry must be within the current bar (' + bar.low + '–' + bar.high + ')' };
        }
        const r = s.session.enter(Object.assign({}, o, { entry }));
        if (!r.ok) return r;
        // an entry can fill instantly when SL/TP sit inside the entry bar — the
        // seat is then flat with a recorded trade; log accordingly
        this._log('enter', { seat: seatId, direction: r.position ? r.position.direction : o.direction, entry: r.position ? r.position.entry : entry });
        return r;
    }

    close(seatId, o) {
        const s = this.seat(seatId);
        if (!s) return { ok: false, error: 'unknown seat' };
        this._ensureSeats();
        const r = s.session.close(o);
        if (r.ok) this._log('close', { seat: seatId, reason: r.trade.exitReason, pnl: r.trade.pnl });
        return r;
    }

    _log(type, payload) {
        this.actions.push({ type, at: new Date().toISOString(), cursor: this.cursor, ...payload });
    }

    // ---- public (no private positions) vs private (one seat) ----
    publicState() {
        return {
            id: this.id, title: this.title, symbol: this.symbol, timeframe: this.timeframe,
            category: this.category, status: this.status, createdAt: this.createdAt,
            cursor: this.cursor, total: this.candles.length, startIndex: this.startIndex,
            startingBalance: this.startingBalance, riskModel: this.riskModel,
            seats: this.seats.map(s => ({
                id: s.id, name: s.name, team: s.team, taken: !!s.userId, userId: s.userId || null
            })),
            leaderboard: this.status === 'completed' ? this.leaderboard() : null,
            candle: this.candles[this.cursor] || null
        };
    }

    seatState(seatId) {
        const s = this.seat(seatId);
        if (!s) return null;
        this._ensureSeats();
        const st = stateOf(s.session);
        st.candles = this.candles.slice(0, this.cursor + 1);   // shared canonical visibility
        st.cursor = this.cursor;
        st.battle = { id: this.id, title: this.title, status: this.status, seat: s.id, name: s.name, team: s.team };
        return st;
    }

    leaderboard() {
        const rows = this.seats.map(s => {
            const sc = scoreSeat(s);
            return {
                seat: s.id, name: s.name, team: s.team, userId: s.userId,
                score: sc.score, detail: sc.detail,
                trades: s.session ? s.session.trades.map(t => ({
                    direction: t.direction, entry: t.entry, exit: t.exit, sl: t.sl, tp: t.tp,
                    entryTime: t.entryTime, exitTime: t.exitTime, exitReason: t.exitReason,
                    riskAmount: t.riskAmount, realizedR: t.realizedR, pnl: t.pnl, setup: t.setup
                })) : []
            };
        }).sort((a, b) => b.score - a.score);
        // team aggregation
        const teams = {};
        rows.forEach(r => {
            if (!r.team) return;
            (teams[r.team] = teams[r.team] || []).push(r);
        });
        const byTeam = Object.keys(teams).map(t => {
            const g = teams[t];
            return {
                team: t,
                score: Math.round(g.reduce((s, r) => s + r.score, 0) / g.length),
                trades: g.reduce((s, r) => s + r.detail.trades, 0),
                winRate: Math.round(g.reduce((s, r) => s + r.detail.winRate, 0) / g.length * 10) / 10,
                avgR: Math.round(g.reduce((s, r) => s + r.detail.avgR, 0) / g.length * 1000) / 1000,
                maxDD: Math.round(g.reduce((s, r) => s + r.detail.maxDD, 0) / g.length * 100) / 100,
                members: g.length
            };
        }).sort((a, b) => b.score - a.score);
        return { seats: rows, byTeam };
    }

    serialize() {
        return {
            id: this.id, hostId: this.hostId, title: this.title, symbol: this.symbol,
            timeframe: this.timeframe, category: this.category,
            candles: this.candles, startIndex: this.startIndex, cursor: this.cursor,
            startingBalance: this.startingBalance, riskModel: this.riskModel,
            status: this.status, seats: this.seats.map(s => ({
                id: s.id, name: s.name, team: s.team, userId: s.userId,
                session: s.session ? s.session.serialize() : null
            })),
            createdAt: this.createdAt, completedAt: this.completedAt, actions: this.actions
        };
    }
    static hydrate(obj) {
        return new Battle(obj);
    }
}

// ---------------------------------------------------------------------------
// Persistence — per-host file (same local-first pattern as backtest sessions)
// ---------------------------------------------------------------------------
function fileFor(hostId) {
    return path.join(process.env.TRADEMIND_BATTLE_DATA_DIR || path.join(__dirname, '..', 'data'), 'battle-' + hostId + '.json');
}
function readAll(hostId) {
    try {
        const f = fileFor(hostId);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { /* ignore */ }
    return [];
}
function writeAll(hostId, list) {
    try {
        const f = fileFor(hostId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(list));
    } catch (e) { /* ignore */ }
}
function listBattles(hostId) {
    return readAll(hostId).map(b => {
        const x = Battle.hydrate(b);
        return {
            id: x.id, title: x.title, symbol: x.symbol, timeframe: x.timeframe,
            status: x.status, createdAt: x.createdAt, cursor: x.cursor, total: x.candles.length,
            seats: x.seats.length, taken: x.seats.filter(s => s.userId).length,
            teams: [...new Set(x.seats.map(s => s.team).filter(Boolean))]
        };
    });
}
function getBattle(hostId, id) {
    const b = readAll(hostId).find(x => x.id === id);
    return b ? Battle.hydrate(b) : null;
}
function saveBattle(hostId, b) {
    const list = readAll(hostId).filter(x => x.id !== b.id);
    list.push(b.serialize());
    writeAll(hostId, list);
}
function deleteBattle(hostId, id) {
    writeAll(hostId, readAll(hostId).filter(x => x.id !== id));
}

// ---------------------------------------------------------------------------
// Active registry (play timers live here)
// ---------------------------------------------------------------------------
const active = new Map();

function loadActive(hostId, id) {
    let b = active.get(id);
    if (!b) {
        b = getBattle(hostId, id);
        if (!b) return null;
        active.set(id, b);
    }
    return b;
}

function play(hostId, id, speedMs) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    if (b.status === 'lobby') b.start();
    const ms = Math.max(40, Number(speedMs) || 300);
    if (b.timer) clearInterval(b.timer);
    b.timer = setInterval(() => {
        if (b.cursor >= b.candles.length - 1) {
            clearInterval(b.timer); b.timer = null;
            if (b.status === 'running') { b.status = 'completed'; b.completedAt = new Date().toISOString(); }
            saveBattle(hostId, b);
            return;
        }
        b.setCursor(b.cursor + 1);
        saveBattle(hostId, b);
    }, ms);
    return { ok: true };
}
function pause(hostId, id) {
    const b = active.get(id);
    if (b && b.timer) { clearInterval(b.timer); b.timer = null; }
    if (b) saveBattle(hostId, b);
    return { ok: true };
}
function step(hostId, id) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    if (b.status === 'lobby') b.start();
    b.setCursor(b.cursor + 1);
    if (b.cursor >= b.candles.length - 1) {
        if (b.status === 'running') { b.status = 'completed'; b.completedAt = new Date().toISOString(); }
    }
    saveBattle(hostId, b);
    return { ok: true };
}
function seek(hostId, id, idx) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    const n = Number(idx);
    if (!(n >= 0) || isNaN(n)) return { ok: false, error: 'invalid cursor' };
    b.setCursor(Math.round(n));
    saveBattle(hostId, b);
    return { ok: true };
}
function reset(hostId, id) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    if (b.timer) { clearInterval(b.timer); b.timer = null; }
    b.cursor = b.startIndex;
    b.status = 'running';
    b.completedAt = null;
    b.seats.forEach(s => {
        if (s.session) {
            s.session.cursor = b.startIndex;
            s.session.position = null;
            s.session.trades = [];
            s.session.balance = s.session.startingBalance;
            s.session.peak = s.session.startingBalance;
            s.session.status = 'running';
        }
    });
    saveBattle(hostId, b);
    return { ok: true };
}
function complete(hostId, id) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    if (b.timer) { clearInterval(b.timer); b.timer = null; }
    b.setCursor(b.candles.length - 1);
    b.status = 'completed';
    b.completedAt = b.completedAt || new Date().toISOString();
    saveBattle(hostId, b);
    return { ok: true, leaderboard: b.leaderboard() };
}

module.exports = {
    Battle, listBattles, getBattle, saveBattle, deleteBattle,
    play, pause, step, seek, reset, complete, loadActive, scoreSeat
};
