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
const Analytics = require('./backtest-analytics.js');
const { getPool } = require('./db.js');

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

function normalizeExecutionCosts(value) {
    const c = value && typeof value === 'object' ? value : {};
    return {
        spread: Math.max(0, Number(c.spread) || 0),
        slippage: Math.max(0, Number(c.slippage) || 0),
        commissionPerUnit: Math.max(0, Number(c.commissionPerUnit) || 0),
        commissionFixed: Math.max(0, Number(c.commissionFixed) || 0),
        feeBps: Math.max(0, Number(c.feeBps) || 0)
    };
}

function toUnixSec(ts) {
    if (ts == null) return null;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
    if (typeof ts === 'string') {
        const parsed = Date.parse(ts);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }
    return null;
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
        this.executionCosts = normalizeExecutionCosts(o.executionCosts || (o.extensions && o.extensions.executionCosts));
        this.candles = (o.candles || []).map(c => ({ ...c }));              // canonical timeline
        this.startIndex = Math.max(0, Math.min(o.startIndex || 0, this.candles.length - 1));
        this.cursor = o.cursor != null ? Math.max(this.startIndex, Math.min(this.candles.length - 1, o.cursor)) : this.startIndex;
        this.positions = Array.isArray(o.positions)
            ? o.positions.map(p => ({ ...p }))
            : (o.position ? [{ ...o.position }] : []);
        this.position = this.positions[0] || null;                            // legacy primary position view
        this.trades = (o.trades || []).map(t => ({ ...t }));                // closed trades (recorded)
        this.actions = (o.actions || []).map(a => ({ ...a }));              // full audit trail
        this.status = o.status || 'running';
        this.createdAt = o.createdAt || new Date().toISOString();
        this.completedAt = o.completedAt || null;
        this.balance = Number(o.balance != null ? o.balance : this.startingBalance);
        this.peak = Number(o.peak != null ? o.peak : this.startingBalance);

        // Extensibility & historical period tracking
        this.period = o.period || null;
        this.periodLabel = o.periodLabel || null;
        this.blind = !!(o.blind || o.isRandom);
        this.actualPeriod = o.actualPeriod || o.period || null;
        this.actualLabel = o.actualLabel || o.periodLabel || null;
        this.notes = String(o.notes || '');
        this.tags = Array.isArray(o.tags) ? o.tags : [];
        this.checklist = Array.isArray(o.checklist) ? o.checklist : [];
        this.propRules = o.propRules || null;
        this.extensions = o.extensions && typeof o.extensions === 'object' ? { ...o.extensions } : {};
    }

    _syncPositions() {
        this.position = this.positions[0] || null;
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

    /** Move the server cursor to the latest chart timestamp without allowing
     * a browser/timeframe switch to rewind the authoritative replay.
     *
     * When the chart sends its current OHLC bar, that bar is authoritative for
     * execution. This matters when a user changes timeframe: the persisted
     * session may be 15m while the chart is currently 1m/1h. We still advance
     * the server cursor for replay state, but evaluate the supplied chart bar
     * instead of simulating a different timeframe's candle path. */
    syncToTime(timestamp, chartBar) {
        const target = toUnixSec(timestamp);
        if (target == null) return { ok: false, error: 'invalid replay timestamp' };
        let next = this.cursor;
        const currentTime = toUnixSec(this.candles[this.cursor] && this.candles[this.cursor].time);

        // Before the first trade, allow the browser's replay cut to select an
        // earlier point than the default pre-roll cursor. Once a position or a
        // closed trade exists, replay remains forward-only.
        if (!this.position && this.trades.length === 0 && currentTime != null && target < currentTime) {
            next = 0;
            for (let i = 0; i < this.candles.length; i++) {
                const candleTime = toUnixSec(this.candles[i].time);
                if (candleTime == null || candleTime > target) break;
                next = i;
            }
            this.cursor = next;
        } else {
            for (let i = this.cursor + 1; i < this.candles.length; i++) {
                const candleTime = toUnixSec(this.candles[i].time);
                if (candleTime == null || candleTime > target) break;
                next = i;
            }
            // Do not run a second, different timeframe simulation when the
            // client supplied the exact bar currently visible on its chart.
            if (chartBar && this.position) {
                this.cursor = next;
                this._refreshBalance();
            } else {
                this.setCursor(next);
            }
        }

        const before = this.trades.length;
        if (chartBar && this.position) {
            const bar = {
                time: chartBar.time != null ? chartBar.time : timestamp,
                open: Number(chartBar.open),
                high: Number(chartBar.high),
                low: Number(chartBar.low),
                close: Number(chartBar.close),
                volume: Number(chartBar.volume || 0)
            };
            if ([bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) {
                this._simulateBar(bar);
            }
            this._refreshBalance();
        }
        return {
            ok: true,
            cursor: this.cursor,
            closedTrades: this.trades.slice(before)
        };
    }

    _simulateBar(bar) {
        for (const p of this.positions.slice()) {
            // intrabar precedence — conservative: the losing fill happens first
            if (p.dir === 'Long') {
                if (bar.low <= p.sl) this._fillExit(bar, p.sl, 'SL', undefined, p);
                else if (p.tp != null && p.tp > 0 && bar.high >= p.tp) this._fillExit(bar, p.tp, 'TP', undefined, p);
            } else {
                if (bar.high >= p.sl) this._fillExit(bar, p.sl, 'SL', undefined, p);
                else if (p.tp != null && p.tp > 0 && bar.low <= p.tp) this._fillExit(bar, p.tp, 'TP', undefined, p);
            }
        }
    }

    _fillExit(bar, price, reason, opts, positionOverride) {
        const p = positionOverride || this.position;
        if (!p) return;

        const costs = this.executionCosts;
        const slip = costs.slippage * (p.dir === 'Long' ? -1 : 1);
        const fillPrice = price + slip;
        const grossPnl = this._pnlAt(p, fillPrice);
        const commission = costs.commissionFixed
            + (costs.commissionPerUnit * p.size)
            + (costs.feeBps > 0 ? Math.abs(fillPrice * p.size) * (costs.feeBps / 10000) : 0);
        const pnl = grossPnl - commission;
        const r = p.riskAmount > 0 ? pnl / p.riskAmount : 0;
        const exitTime = (opts && opts.exitTime) || (bar && bar.time) || Date.now();
        const trade = {
            id: 'btt_' + this.trades.length + '_' + Math.random().toString(36).slice(2, 6),
            sessionId: this.id,
            userId: this.userId,
            symbol: this.symbol,
            timeframe: this.timeframe,
            strategy: p.strategy || this.strategy || 'Manual practice',
            category: this.category,
            direction: p.dir,
            entryTime: p.openedAt,
            exitTime: exitTime,
            entryIndex: p.openedAtIdx,
            exitIndex: this.cursor,
            entry: p.entry,
            exit: fillPrice,
            requestedExit: price,
            grossPnl: Math.round(grossPnl * 100) / 100,
            executionCost: Math.round(commission * 100) / 100,
            sl: p.sl,
            tp: p.tp,
            size: p.size,
            riskAmount: p.riskAmount,
            riskPct: p.riskPct,
            plannedRR: p.rr,
            realizedR: Math.round(r * 1000) / 1000,
            pnl: Math.round(pnl * 100) / 100,
            result: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be',
            exitReason: reason,
            setup: p.setup || '',
            notes: p.notes || '',
            tags: Array.isArray(p.tags) ? p.tags : [],
            source: p.source || 'BACKTEST',
            origin: p.origin || 'manual',
            clientNonce: p.clientNonce || null,
            session: p.session || sessionOf(p.openedAt),
            period: p.period || this.period || null,
            periodLabel: p.periodLabel || this.periodLabel || null,
            openedAt: new Date().toISOString(),
            closedAt: new Date().toISOString()
        };
        // Analytics dimensions stored on the trade at close time (spec 3) so
        // history queries never re-classify. year/month derived from entryTime.
        try {
            const d = new Date((typeof p.openedAt === 'number'
                ? (p.openedAt > 1e12 ? p.openedAt : p.openedAt * 1000)
                : Date.parse(p.openedAt)));
            if (!Number.isNaN(d.getTime())) {
                trade.year = d.getUTCFullYear();
                trade.month = d.getUTCMonth() + 1;
            }
        } catch (e) { /* legacy-safe: analytics derives from entryTime on read */ }
        this.trades.push(trade);
        this._log('close', { tradeId: trade.id, reason, price: fillPrice, requestedPrice: price, pnl, grossPnl, executionCost: commission, r: trade.realizedR });
        this.positions = this.positions.filter(x => x !== p);
        this._syncPositions();
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
        const opts = o || {};
        if (opts.clientNonce) {
            const duplicate = this.actions.find(a => a.type === 'enter' && a.clientNonce === String(opts.clientNonce));
            if (duplicate) {
                return { ok: true, duplicate: true, position: this.position, trade: this.trades[this.trades.length - 1] || null };
            }
        }
        if (this.position && !this.extensions.allowMultiplePositions) return { ok: false, error: 'position already open' };
        const dir = String(opts.direction || '').toLowerCase();
        if (dir !== 'long' && dir !== 'short') return { ok: false, error: 'direction must be Long or Short' };
        const bar = this.candles[this.cursor];
        if (!bar) return { ok: false, error: 'no candle at replay position' };
        const requestedEntry = opts.entry != null ? Number(opts.entry) : bar.close;
        const costs = this.executionCosts;
        const long = dir === 'long';
        const entrySlip = costs.slippage * (long ? 1 : -1);
        const spreadHalf = costs.spread / 2;
        const entry = requestedEntry + entrySlip + (long ? spreadHalf : -spreadHalf);
        const sl = Number(opts.sl);
        const tp = Number(opts.tp);
        if (!(entry > 0) || !(sl > 0)) return { ok: false, error: 'entry and stop loss are required' };
        if (long && sl >= entry) return { ok: false, error: 'stop loss must be below entry for a long' };
        if (!long && sl <= entry) return { ok: false, error: 'stop loss must be above entry for a short' };
        if (tp > 0) {
            if (long && tp <= entry) return { ok: false, error: 'take profit must be above entry for a long' };
            if (!long && tp >= entry) return { ok: false, error: 'take profit must be below entry for a short' };
        }
        // risk amount: explicit, or % of balance, or derived from size
        let riskAmount = Number(opts.riskAmount);
        const slDist = Math.abs(entry - sl);
        if (!(riskAmount > 0) && opts.riskPct) {
            riskAmount = this.balance * (Number(opts.riskPct) / 100);
        }
        let size = Number(opts.size);
        if (!(riskAmount > 0) && !(size > 0)) {
            // default to the account risk model
            const per = this.riskModel.perTrade || 25;
            riskAmount = this.riskModel.basis === 'pct' ? this.balance * (per / 100) : per;
        }
        if (!(size > 0)) size = sizeFromRisk(long ? 1 : -1, entry, sl, riskAmount);
        if (!(size > 0)) return { ok: false, error: 'cannot size position — check risk and stop distance' };
        if (!(riskAmount > 0)) riskAmount = Math.abs(slDist * size);
        const rr = tp > 0 ? rrOf(entry, sl, tp) : 0;
        const newPosition = {
            id: opts.positionId ? String(opts.positionId) : 'pos_' + this.id + '_' + (this.actions.filter(a => a.type === 'enter').length + 1),
            dir: long ? 'Long' : 'Short',
            entry, requestedEntry, sl, tp: tp > 0 ? tp : null,
            size: Math.round(size * 1e6) / 1e6,
            riskAmount: Math.round(riskAmount * 100) / 100,
            riskPct: this.balance > 0 ? Math.round((riskAmount / this.balance) * 10000) / 100 : 0,
            rr: Math.round(rr * 100) / 100,
            strategy: String(opts.strategy || this.strategy || ''),
            session: String(opts.session || ''),
            setup: String(opts.setup || ''),
            notes: String(opts.notes || ''),
            source: String(opts.source || 'BACKTEST'),
            origin: String(opts.origin || 'manual'),
            clientNonce: opts.clientNonce ? String(opts.clientNonce) : null,
            period: String(opts.period || this.period || ''),
            periodLabel: String(opts.periodLabel || this.periodLabel || ''),
            openedAt: (opts && opts.entryTime) || (bar ? bar.time : Date.now()),
            openedAtIdx: this.cursor
        };
        this.positions.push(newPosition);
        this._syncPositions();
        this._log('enter', { positionId: newPosition.id, direction: newPosition.dir, entry, requestedEntry, sl, tp, size: newPosition.size, riskAmount: newPosition.riskAmount, source: newPosition.source, origin: newPosition.origin, clientNonce: newPosition.clientNonce, executionCosts: this.executionCosts });
        // if SL/TP is inside the entry bar it fills immediately (discipline)
        this._simulateBar(bar);
        return { ok: true, position: newPosition, positions: this.positions.slice() };
    }

    close(o) {
        if (!this.position) return { ok: false, error: 'no open position' };
        const target = o && o.positionId ? this.positions.find(p => p.id === String(o.positionId)) : this.position;
        if (!target) return { ok: false, error: 'unknown position' };
        const bar = this.candles[this.cursor];
        const price = o && o.price != null ? Number(o.price) : (bar ? bar.close : target.entry);
        this._fillExit(bar || { time: (o && o.exitTime) || Date.now(), close: price, low: price, high: price }, price, String((o && o.reason) || 'manual'), o, target);
        return { ok: true, position: this.position, positions: this.positions.slice(), trade: this.trades[this.trades.length - 1] };
    }

    // Active trade management: Break-Even, Partial Close, Dynamic SL/TP modification
    breakEven() {
        if (!this.position) return { ok: false, error: 'no open position' };
        const p = this.position;
        p.sl = p.entry;
        p.beApplied = true;
        this._log('break_even', { sl: p.sl, entry: p.entry });
        return { ok: true, position: p };
    }

    closePartial(fraction, o) {
        if (!this.position) return { ok: false, error: 'no open position' };
        const frac = Math.max(0.05, Math.min(0.95, Number(fraction) || 0.5));
        const p = this.position;
        const bar = this.candles[this.cursor];
        const price = o && o.price != null ? Number(o.price) : (bar ? bar.close : p.entry);
        const closeSize = Math.round(p.size * frac * 1e6) / 1e6;
        if (!(closeSize > 0)) return { ok: false, error: 'cannot calculate partial size' };

        const fillPrice = price + (this.executionCosts.slippage * (p.dir === 'Long' ? -1 : 1));
        const grossPnl = p.dir === 'Long' ? (fillPrice - p.entry) * closeSize : (p.entry - fillPrice) * closeSize;
        const commission = this.executionCosts.commissionFixed
            + (this.executionCosts.commissionPerUnit * closeSize)
            + (this.executionCosts.feeBps > 0 ? Math.abs(fillPrice * closeSize) * (this.executionCosts.feeBps / 10000) : 0);
        const pnl = grossPnl - commission;
        const partialRisk = p.riskAmount * frac;
        const r = partialRisk > 0 ? pnl / partialRisk : 0;

        const trade = {
            id: 'btt_' + this.trades.length + '_' + Math.random().toString(36).slice(2, 6),
            sessionId: this.id,
            userId: this.userId,
            symbol: this.symbol,
            timeframe: this.timeframe,
            strategy: p.strategy || this.strategy,
            category: this.category,
            direction: p.dir,
            entryTime: p.openedAt,
            exitTime: bar ? bar.time : Date.now(),
            entryIndex: p.openedAtIdx,
            exitIndex: this.cursor,
            entry: p.entry,
            exit: fillPrice,
            requestedExit: price,
            grossPnl: Math.round(grossPnl * 100) / 100,
            executionCost: Math.round(commission * 100) / 100,
            sl: p.sl,
            tp: p.tp,
            size: closeSize,
            riskAmount: Math.round(partialRisk * 100) / 100,
            riskPct: Math.round((p.riskPct * frac) * 100) / 100,
            plannedRR: p.rr,
            realizedR: Math.round(r * 1000) / 1000,
            pnl: Math.round(pnl * 100) / 100,
            result: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be',
            exitReason: 'partial_' + Math.round(frac * 100) + '%',
            setup: p.setup || '',
            notes: (p.notes ? p.notes + ' • ' : '') + 'Partial ' + Math.round(frac * 100) + '%',
            source: p.source || 'BACKTEST',
            origin: p.origin || 'manual',
            clientNonce: p.clientNonce || null,
            session: p.session || sessionOf(p.openedAt),
            period: p.period || this.period || null,
            periodLabel: p.periodLabel || this.periodLabel || null,
            openedAt: new Date().toISOString(),
            closedAt: new Date().toISOString()
        };
        this.trades.push(trade);

        p.size = Math.round((p.size - closeSize) * 1e6) / 1e6;
        p.riskAmount = Math.max(0, Math.round((p.riskAmount - partialRisk) * 100) / 100);
        p.riskPct = Math.max(0, Math.round((p.riskPct * (1 - frac)) * 100) / 100);

        this._log('close_partial', { tradeId: trade.id, fraction: frac, price: fillPrice, requestedPrice: price, pnl, grossPnl, executionCost: commission, remainingSize: p.size });
        this._refreshBalance();
        return { ok: true, position: p, trade };
    }

    modify(o) {
        if (!this.position) return { ok: false, error: 'no open position' };
        const p = this.position;
        const nextSl = o && o.sl != null ? Number(o.sl) : p.sl;
        const nextTp = o && o.tp != null ? (Number(o.tp) > 0 ? Number(o.tp) : null) : p.tp;
        if (!(nextSl > 0)) return { ok: false, error: 'stop loss must be positive' };
        if (p.dir === 'Long' && nextSl >= p.entry) return { ok: false, error: 'stop loss must be below entry for a long' };
        if (p.dir === 'Short' && nextSl <= p.entry) return { ok: false, error: 'stop loss must be above entry for a short' };
        if (nextTp != null) {
            if (p.dir === 'Long' && nextTp <= p.entry) return { ok: false, error: 'take profit must be above entry for a long' };
            if (p.dir === 'Short' && nextTp >= p.entry) return { ok: false, error: 'take profit must be below entry for a short' };
        }
        p.sl = nextSl;
        p.tp = nextTp;
        p.rr = p.tp > 0 ? Math.round(rrOf(p.entry, p.sl, p.tp) * 100) / 100 : 0;
        this._log('modify_position', { sl: p.sl, tp: p.tp, rr: p.rr });
        return { ok: true, position: p };
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
            returnPct: this.startingBalance > 0 ? Math.round((net / this.startingBalance) * 10000) / 100 : 0,
            maxDrawdownPct: this.startingBalance > 0 ? Math.round((maxDD / this.startingBalance) * 10000) / 100 : 0,
            period: this.period, periodLabel: this.periodLabel, blind: this.blind,
            actualPeriod: (this.status === 'completed' || !this.blind) ? this.actualPeriod : null,
            actualLabel: (this.status === 'completed' || !this.blind) ? this.actualLabel : null,
            propRules: this.propRules, extensions: this.extensions,
            equity, bySetup, byDirection: byDir, bySession, byTimeOfDay: byTime, byExitReason: byExit
        };
    }

    // ---- persistence ----------------------------------------------------------
    serialize() {
        return {
            id: this.id, userId: this.userId, symbol: this.symbol, timeframe: this.timeframe,
            strategy: this.strategy, category: this.category,
            startingBalance: this.startingBalance, riskModel: this.riskModel, executionCosts: this.executionCosts,
            period: this.period, periodLabel: this.periodLabel, blind: this.blind,
            actualPeriod: this.actualPeriod, actualLabel: this.actualLabel,
            notes: this.notes, tags: this.tags, checklist: this.checklist,
            propRules: this.propRules, extensions: this.extensions,
            candles: this.candles, startIndex: this.startIndex, cursor: this.cursor,
            position: this.position, positions: this.positions, trades: this.trades, actions: this.actions,
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
    // Delegates to the shared configurable classifier (non-overlapping UTC
    // windows incl. New York AM/PM split) so per-trade stored values and
    // analytics aggregation can never disagree.
    return Analytics.classifySession(ts);
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
        let replayedSec = 0;
        if (sess.candles && sess.candles.length) {
            const startC = sess.candles[sess.startIndex || 0];
            const currC = sess.candles[sess.cursor || 0];
            if (startC && currC && currC.time && startC.time && currC.time >= startC.time) {
                replayedSec = currC.time - startC.time;
            }
        }
        return {
            id: sess.id, symbol: sess.symbol, timeframe: sess.timeframe, strategy: sess.strategy,
            category: sess.category, startingBalance: sess.startingBalance,
            period: sess.period, periodLabel: sess.periodLabel, blind: sess.blind,
            status: sess.status, createdAt: sess.createdAt,
            trades: res.trades, net: res.net, winRate: res.winRate,
            balance: sess.balance, open: !!sess.position, cursor: sess.cursor, total: sess.candles.length,
            replayedSec
        };
    });
}
function listFullSessions(userId) {
    return readAll(userId).map(s => BacktestSession.hydrate(s));
}
function getSession(userId, id) {
    const s = readAll(userId).find(x => x.id === id);
    return s ? BacktestSession.hydrate(s) : null;
}
async function mirrorSession(userId, sess) {
    const pool = getPool();
    // Local-first remains authoritative when Supabase is not configured.
    if (!pool || !userId || !/^[0-9a-f-]{36}$/i.test(String(userId))) return;
    try {
        const row = sess.serialize();
        await pool.query(
            `INSERT INTO backtest_sessions (id, user_id, status, period, symbol, timeframe, session, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, period = EXCLUDED.period,
               symbol = EXCLUDED.symbol, timeframe = EXCLUDED.timeframe, session = EXCLUDED.session,
               updated_at = now()`,
            [sess.id, userId, sess.status, sess.period, sess.symbol, sess.timeframe, JSON.stringify(row)]
        );
    } catch (err) {
        // Never make replay fail because the optional database mirror is down.
        console.warn('[Backtest] Supabase session mirror skipped:', err.message);
    }
}
function saveSession(userId, sess) {
    const list = readAll(userId).filter(x => x.id !== sess.id);
    list.push(sess.serialize());
    writeAll(userId, list);
    void mirrorSession(userId, sess);
}
function deleteSession(userId, id) {
    writeAll(userId, readAll(userId).filter(x => x.id !== id));
    const pool = getPool();
    if (pool && /^[0-9a-f-]{36}$/i.test(String(userId))) {
        void pool.query('DELETE FROM backtest_sessions WHERE id = $1 AND user_id = $2', [id, userId])
            .catch(err => console.warn('[Backtest] Supabase session delete skipped:', err.message));
    }
}

// ---------------------------------------------------------------------------
// In-memory registry for live (playing) sessions — timers live here so replay
// playback advances the cursor server-side and saves as it goes.
// ---------------------------------------------------------------------------
const active = new Map();

function loadActive(userId, id) {
    let s = active.get(id);
    if (s && s.userId !== userId) return null;
    if (!s) {
        s = getSession(userId, id);
        if (!s || s.userId !== userId) return null;
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
            completeAtEnd(s);
            saveSession(userId, s);
            return;
        }
        s.setCursor(s.cursor + 1);
        if (s.cursor >= s.candles.length - 1) {
            completeAtEnd(s);
        }
        if (Date.now() - lastSave > 400 || s.status === 'completed') { saveSession(userId, s); lastSave = Date.now(); }
    }, ms);
    return { ok: true };
}

function pause(userId, id) {
    const s = active.get(id);
    if (!s || s.userId !== userId) return { ok: true };
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    saveSession(userId, s);
    return { ok: true };
}

function completeAtEnd(s) {
    if (s.cursor < s.candles.length - 1) return false;
    // A replay cannot finish with an invisible open position. Use the final
    // candle close as the deterministic settlement price so the trade reaches
    // history analytics even when neither SL nor TP was touched.
    while (s.position) s.close({ reason: 'Session end', positionId: s.position.id });
    if (s.status === 'running' || s.status === 'lobby') {
        s.status = 'completed';
        s.completedAt = s.completedAt || new Date().toISOString();
    }
    return true;
}

function stepSession(userId, id) {
    const s = loadActive(userId, id);
    if (!s) return { ok: false, error: 'unknown session' };
    s.setCursor(s.cursor + 1);
    completeAtEnd(s);
    saveSession(userId, s);
    return { ok: true, state: stateOf(s) };
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
    s.positions = [];
    s._syncPositions();
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
        executionCosts: s.executionCosts,
        cursor: s.cursor, total: s.candles.length, startIndex: s.startIndex,
        candle: bar || null,
        position: pos ? {
            id: pos.id, direction: pos.dir, entry: pos.entry, sl: pos.sl, tp: pos.tp, size: pos.size,
            riskAmount: pos.riskAmount, riskPct: pos.riskPct, rr: pos.rr,
            notes: pos.notes, setup: pos.setup, source: pos.source || 'BACKTEST', origin: pos.origin || 'manual', openedAt: pos.openedAt,
            unrealized: Math.round(unrealized * 100) / 100, unrealizedR: Math.round(unrealizedR * 1000) / 1000
        } : null,
        positions: s.positions.map(p => ({ id: p.id, direction: p.dir, entry: p.entry, sl: p.sl, tp: p.tp, size: p.size, riskAmount: p.riskAmount, riskPct: p.riskPct, rr: p.rr, source: p.source || 'BACKTEST', openedAt: p.openedAt })),
        period: s.period, periodLabel: s.periodLabel, blind: s.blind,
        actualPeriod: (s.status === 'completed' || !s.blind) ? s.actualPeriod : null,
        actualLabel: (s.status === 'completed' || !s.blind) ? s.actualLabel : null,
        propRules: s.propRules, extensions: s.extensions,
        trades: s.trades, actions: s.actions.slice(-60),
        candles: s.visibleCandles()
    };
}

function manageSession(userId, id, action, payload) {        const s = loadActive(userId, id);
        if (!s) return { ok: false, error: 'unknown session' };
        const p = payload || {};
    let r;
    if (action === 'be' || action === 'breakeven') {
        r = s.breakEven();
    } else if (action === 'partial') {
        r = s.closePartial(p.fraction || 0.5, p);
    } else if (action === 'modify') {
        r = s.modify(p);
    } else if (action === 'sync') {
        r = s.syncToTime(p.time, p.bar);
    } else if (action === 'complete') {
        // Replay finished: first advance through the remaining candles so SL/TP
        // can fill on their actual bar; completeAtEnd then settles anything still
        // open at the final candle close and marks the session completed.
        s.setCursor(s.candles.length - 1);
        completeAtEnd(s);
        saveSession(userId, s);
        return { ok: true, state: stateOf(s), results: s.results() };
    } else {
        return { ok: false, error: 'unknown management action' };
    }
    if (r.ok) saveSession(userId, s);
    return { ...r, state: stateOf(s) };
}

module.exports = {
    BacktestSession, listSessions, listFullSessions, getSession, saveSession, deleteSession, sizeFromRisk, rrOf,
    stateOf, play, pause, stepSession, seekSession, resetSession, loadActive, manageSession
};
