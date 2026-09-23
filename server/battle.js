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
const BattleConfig = require('./battle-config.js');
const Practice = require('./practice.js');

// Battle is intentionally a foundation, not a ruleset. The lifecycle, the
// availability states and every configurable policy slot live in
// server/battle-config.js: a policy that is registered but NOT implemented is a
// blocker, so the engine refuses to run an unspecified mode instead of
// inventing one.
const LIFECYCLE = BattleConfig.LIFECYCLE;
const AVAILABILITY = BattleConfig.AVAILABILITY;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Epoch seconds (what the market-data layer returns) or epoch milliseconds (what
// the charts and the timeline aggregation use)? Anything below ~1973 in ms is
// really seconds.
const TS_MS_THRESHOLD = 1e11;
function tsMs(t) {
    const n = Number(t);
    if (!isFinite(n)) return n;
    return n > TS_MS_THRESHOLD ? n : n * 1000;
}

// ---------------------------------------------------------------------------
// End-condition registry — the seam for "when does this battle stop".
// `timeline-exhausted` is the behaviour the engine already has; a future
// specification registers more here WITHOUT touching the replay cursor loop.
// ---------------------------------------------------------------------------
const END_CONDITIONS = {
    'timeline-exhausted': b => ({ met: b.cursor >= b.candles.length - 1 })
};
function registerEndCondition(name, fn) {
    if (!name || typeof fn !== 'function') return false;
    END_CONDITIONS[name] = fn;
    return true;
}

// A battle may only be driven while every configured policy is implemented.
function runnable(b) {
    const c = BattleConfig.canRun(b.config);
    if (!c.ok) return { ok: false, error: 'battle configuration cannot run yet: ' + c.blockers.join('; '), blockers: c.blockers };
    return { ok: true };
}

// short, copy-friendly invite code (no ambiguous chars)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genInviteCode(len) {
    const n = len || 8;
    let out = '';
    for (let i = 0; i < n; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return out;
}

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
        // Historical archive identity. A battle replays a real archived month
        // exactly like practice backtesting — `period` is the YYYY-MM folder and
        // `periodLabel` is the human label shown in the UI.
        this.period = o.period || null;
        this.periodLabel = o.periodLabel || null;
        // Chart delivery window: the canonical timeline is the FULL archive, but
        // each seat poll only ships the tail window of visible bars so a month of
        // 1m candles never becomes a multi-megabyte response.
        this.candleWindow = Math.max(60, Math.min(2000, Number(o.candleWindow) || 400));
        // The ONE canonical timeline. Times are normalized to MILLISECONDS here,
        // because that is what the timeline aggregation and every chart client work
        // in — the market-data layer still hands out epoch SECONDS (chart-test.html
        // converts with `t > 1e11 ? t : t * 1000`). Normalizing once, at the
        // boundary, is what keeps cutTime / bucket maths / WS payloads consistent.
        this.candles = (o.candles || []).map(c => ({ ...c, time: tsMs(c.time) }));
        this.startIndex = Math.max(0, Math.min(o.startIndex || 0, this.candles.length - 1));
        this.cursor = o.cursor != null ? Math.max(this.startIndex, Math.min(this.candles.length - 1, o.cursor)) : this.startIndex;
        this.startingBalance = Number(o.startingBalance) > 0 ? Number(o.startingBalance) : 10000;
        this.riskModel = o.riskModel || { basis: 'money', perTrade: 25 };
        this.inviteCode = o.inviteCode || genInviteCode();
        this.status = o.status || 'lobby';                       // compatibility alias for lifecycle
        this.lifecycle = LIFECYCLE.includes(o.lifecycle) ? o.lifecycle : (this.status === 'running' ? 'battle' : this.status === 'completed' ? 'results' : 'lobby');
        // Extensible configuration, normalized through the policy contract: an
        // unimplemented mode is reported explicitly, never silently guessed at.
        const cfg = BattleConfig.normalize(o.config);
        this.config = cfg.config;
        this.configMeta = { version: cfg.version, errors: cfg.errors.slice(), warnings: cfg.warnings.slice() };
        this.policyBlockers = cfg.errors.length ? cfg.errors.slice() : BattleConfig.blockers(this.config);
        // ---- canonical timeline resolution (book: 06_… § battle timeline model) ----
        // The battle WALKS these candles: fills, entry validation and the ending
        // condition all happen on this resolution, which is what makes two seats
        // comparable. `timeframe` is only the resolution the chart OPENS on — the
        // display may be any COARSER resolution, aggregated from these bars, and a
        // seat's display choice can never change anyone's execution.
        const _mkt = (this.config && this.config.market) || {};
        this.startingTimeframe = String(o.startingTimeframe || _mkt.startingTimeframe || _mkt.timeframe || this.timeframe);
        if (BattleConfig.timeframeMs(this.startingTimeframe) == null) this.startingTimeframe = String(_mkt.timeframe || this.timeframe);
        this.baseTimeframe = String(o.baseTimeframe || _mkt.baseTimeframe || this.startingTimeframe);
        if (BattleConfig.timeframeMs(this.baseTimeframe) == null) this.baseTimeframe = this.startingTimeframe;
        // a chart can only display the canonical resolution or coarser
        if (BattleConfig.timeframeMs(this.startingTimeframe) < BattleConfig.timeframeMs(this.baseTimeframe)) this.startingTimeframe = this.baseTimeframe;
        this.baseMs = BattleConfig.timeframeMs(this.baseTimeframe);
        this.displayTimeframes = (Array.isArray(o.displayTimeframes) && o.displayTimeframes.length)
            ? o.displayTimeframes.filter(tf => BattleConfig.timeframeMs(tf) != null)
            : BattleConfig.displayTimeframes(this.baseTimeframe);
        this.timeframe = this.startingTimeframe;   // compatibility alias
        this.replay = o.replay && typeof o.replay === 'object' ? { ...o.replay } : {};
        this.execution = o.execution && typeof o.execution === 'object' ? { ...o.execution } : {};
        this.settlement = o.settlement && typeof o.settlement === 'object' ? { ...o.settlement } : {};
        this.marketDataVersion = String(o.marketDataVersion || 'historical-ohlcv-v1');
        this.stateRevision = Number(o.stateRevision) || 0;
        this.events = Array.isArray(o.events) ? o.events.map(e => ({ ...e })) : [];
        // The scoring adapter comes from the configuration contract; an explicit
        // policy object overrides it. Either way the result is flagged as
        // PROVISIONAL while no final scoring model exists, and every surface that
        // renders a score says so — a battle must never look officially scored.
        this.scoringPolicy = (o.scoringPolicy && typeof o.scoringPolicy === 'object')
            ? { ...o.scoringPolicy }
            : BattleConfig.scoringOf(this.config);
        this.seats = (o.seats || []).map(s => ({
            id: s.id, name: s.name || 'Seat', team: s.team || null,
            userId: s.userId || null,
            // Per-seat activity trail. Presence is derived from it and is the one
            // competitor signal that is always synchronized — it reveals nothing
            // about what a seat is doing, only that it is here and working.
            activity: s.activity && typeof s.activity === 'object' ? { ...s.activity } : null,
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
    seatOfUser(userId) {
        return this.seats.find(s => s.userId === userId) || null;
    }

    // -----------------------------------------------------------------------
    // Seat activity + presence
    // -----------------------------------------------------------------------
    _markActivity(seat, kind) {
        if (!seat) return;
        const now = new Date().toISOString();
        const prev = seat.activity || {};
        seat.activity = {
            kind: kind || 'seen',
            cursor: this.cursor,
            seenAt: now,
            actedAt: kind && kind !== 'seen' ? now : (prev.actedAt || null),
            seq: (prev.seq || 0) + 1
        };
    }
    // A seat reading its own private state is a cheap, server-verified "I am
    // here" signal. It never expands what OTHER seats can see — that stays the
    // visibility policy's decision.
    markSeatSeen(seatId, userId) {
        const s = this.seat(seatId);
        if (!s || !s.userId || s.userId !== userId) return false;
        this._markActivity(s, 'seen');
        return true;
    }
    presenceOf(seat) {
        if (!seat) return { state: 'unknown' };
        if (!seat.userId) return { state: 'unclaimed' };
        const a = seat.activity || {};
        const now = Date.now();
        const seen = a.seenAt ? new Date(a.seenAt).getTime() : 0;
        const acted = a.actedAt ? new Date(a.actedAt).getTime() : 0;
        const barsSinceAction = a.cursor != null ? Math.max(0, this.cursor - a.cursor) : null;
        let state = 'waiting';
        if (seen) state = 'online';
        if (acted && (barsSinceAction == null || barsSinceAction <= 2)) state = 'active';
        if (seen && now - seen > 5 * 60 * 1000) state = 'offline';
        return {
            state,
            lastSeenAt: a.seenAt || null,
            lastActionAt: a.actedAt || null,
            lastActionKind: a.actedAt ? (a.kind || null) : null,
            barsSinceAction
        };
    }

    // -----------------------------------------------------------------------
    // Participant projections — the opponent-state channel.
    // What a viewer may know about another seat is decided HERE, server-side, by
    // the battle's `visibility` policy. A viewer's own seat is never filtered.
    // `opts.fields` is an internal widening hook (used by the settlement record
    // once a battle has ended) and is never reachable from a client request.
    // -----------------------------------------------------------------------
    participants(viewerId, opts) {
        const o = opts || {};
        const allowed = new Set(BattleConfig.participantFields(this.config));
        if (Array.isArray(o.fields)) o.fields.forEach(f => allowed.add(String(f)));
        return this.seats.map(s => {
            const mine = !!viewerId && s.userId === viewerId;
            const wide = mine || allowed.has('*');
            const row = { id: s.id, name: s.name, team: s.team, claimed: !!s.userId, mine, presence: this.presenceOf(s) };
            const session = s.session;
            if (!session) return row;
            const pos = session.position || null;
            if (wide || allowed.has('status')) row.status = pos ? 'in_trade' : 'flat';
            if (wide || allowed.has('direction')) row.direction = pos ? pos.dir : null;
            if (wide || allowed.has('risk')) row.risk = pos ? pos.riskAmount : 0;
            if (wide || allowed.has('pnl')) {
                const realized = (session.trades || []).reduce((sum, t) => sum + (t.pnl || 0), 0);
                const bar = session.candles[session.cursor] || null;
                const unrealized = pos ? session._pnlAt(pos, bar ? bar.close : pos.entry) : 0;
                row.realized = Math.round(realized * 100) / 100;
                row.unrealized = Math.round(unrealized * 100) / 100;
                row.equity = Math.round((session.balance + unrealized) * 100) / 100;
                row.trades = (session.trades || []).length;
            }
            if (wide || allowed.has('trades')) row.tradeList = (session.trades || []).slice();
            return row;
        });
    }
    // What the current policy hides — so the UI can explain an empty field as
    // "not specified yet" instead of implying the opponent did nothing.
    visibility() {
        const mode = BattleConfig.visibilityMode(this.config);
        const fields = BattleConfig.participantFields(this.config);
        return {
            mode,
            fields,
            hidden: Object.keys(BattleConfig.PARTICIPANT_FIELDS).filter(f => fields.indexOf(f) === -1),
            note: mode === 'presence'
                ? 'Opponent information is limited to presence until the battle rules specify more.'
                : null
        };
    }

    // -----------------------------------------------------------------------
    // Ending condition (server-authoritative, policy-driven)
    // -----------------------------------------------------------------------
    endCondition() {
        const policy = BattleConfig.policyOf(this.config.settlement, 'settlement');
        const fn = END_CONDITIONS[policy];
        if (!fn) return { met: false, policy, error: 'ending condition is not implemented: ' + policy };
        let r = {};
        try { r = fn(this) || {}; } catch (e) { return { met: false, policy, error: e.message }; }
        return { met: !!r.met, policy };
    }

    // -----------------------------------------------------------------------
    // Canonical dataset — battle trades in the SAME shape practice backtesting
    // feeds to analytics, so a battle becomes a first-class trading dataset
    // rather than an isolated game record.
    // -----------------------------------------------------------------------
    canonicalTrades(seatId) {
        this._ensureSeats();
        const seats = seatId ? [this.seat(seatId)].filter(Boolean) : this.seats;
        const out = [];
        seats.forEach(s => {
            if (!s.session) return;
            (s.session.trades || []).forEach(t => {
                const row = Practice.toAnalyticsTrade(t);
                row.source = 'BATTLE';
                row.account_id = 'battle';
                row.battle_id = this.id;
                row.seat = s.id;
                row.seat_name = s.name;
                row.team = s.team || null;
                row.period = this.period;
                row.periodLabel = this.periodLabel;
                out.push(row);
            });
        });
        out.sort((a, b) => a.ts - b.ts);
        return out;
    }
    // The settlement record: exact market context, configuration, players, their
    // trade histories and the event log. Derived on read so there is no second
    // store to drift; the server only releases it once the battle has ended.
    settlementRecord(viewerId) {
        this._ensureSeats();
        const first = this.candles[this.startIndex] || null;
        const last = this.candles[this.cursor] || null;
        const ec = this.endCondition();
        const allFields = Object.keys(BattleConfig.PARTICIPANT_FIELDS);
        return {
            battle: {
                id: this.id, title: this.title, hostId: this.hostId, status: this.status,
                lifecycle: this.lifecycle, stateRevision: this.stateRevision,
                createdAt: this.createdAt, completedAt: this.completedAt
            },
            market: {                    symbol: this.symbol, timeframe: this.baseTimeframe, category: this.category,
                // the identity of the archive slice this battle replayed
                dataset: (this.config.market && this.config.market.dataset) || null,
                dataVersion: this.marketDataVersion,
                period: this.period, periodLabel: this.periodLabel,
                startTimestamp: first ? first.time : null, endTimestamp: last ? last.time : null,
                totalBars: this.candles.length, revealedBars: this.cursor + 1
            },
            config: this.config,
            configBlockers: this.policyBlockers.slice(),
            replay: { ...this.replay },
            execution: { ...this.execution },
            settlement: Object.assign({}, this.settlement, { policy: ec.policy, reached: ec.met, at: this.completedAt }),
            players: this.seats.map(s => {
                const row = this.participants(viewerId, { fields: allFields }).find(p => p.id === s.id);
                return Object.assign(row || { id: s.id, name: s.name }, { userId: s.userId });
            }),
            results: this.leaderboard(),
            trades: this.canonicalTrades(),
            events: this.events.slice()
        };
    }

    _ensureSeats() {
        this.seats.forEach((s, i) => {
            if (!s.session) {
                s.session = new BacktestSession({
                    id: 'btls_' + this.id + '_' + i,
                    userId: s.userId || 'seat-' + i,
                    symbol: this.symbol, timeframe: this.baseTimeframe,
                    baseTimeframe: this.baseTimeframe, startingTimeframe: this.startingTimeframe,
                    displayTimeframes: this.displayTimeframes.slice(),
                    cutTime: this.cutTime(),
                    category: this.category, strategy: s.name,
                    startingBalance: this.startingBalance, riskModel: this.riskModel,
                    period: this.period, periodLabel: this.periodLabel,
                    candles: this.candles, startIndex: this.startIndex,
                    cursor: this.cursor
                });
            }
        });
    }

    // ---- the shared market moment -------------------------------------------
    // `cutTime` is the ONE value clients are told about the market: the open time
    // of the base bar at the cursor. Every display timeframe is built from the
    // bars at or before it, so two seats looking at different timeframes are still
    // at the same market moment, and nothing past it can ever be rendered.
    cutTime() {
        const bar = this.candles[this.cursor];
        return bar ? bar.time : null;
    }

    timelineState() {
        return {
            baseTimeframe: this.baseTimeframe,
            baseMs: this.baseMs,
            startingTimeframe: this.startingTimeframe,
            displayTimeframes: this.displayTimeframes.slice(),
            cutTime: this.cutTime(),
            cutIndex: this.cursor,
            revealedBars: this.cursor + 1,
            totalBars: this.candles.length,
            stateRevision: this.stateRevision
        };
    }

    // ---- display series for ANY timeframe -----------------------------------
    // Built by aggregating the REVEALED base bars only, so a coarser timeframe can
    // never carry a bar whose interior contains candles the cursor has not reached
    // (the leak plain "time <= cut" slicing has). The bar covering the cut is
    // marked `complete: false` — a live, forming candle built from what has
    // actually been shown, which is what a real chart displays.
    // A resolution FINER than the canonical timeline cannot be built this way and
    // is refused (`finer-than-canonical`): the canonical timeline is already the
    // finest resolution the archive has for this dataset.
    seriesAt(timeframe, opts) {
        const tf = String(timeframe || this.startingTimeframe);
        const tfMs = BattleConfig.timeframeMs(tf);
        if (tfMs == null) return { ok: false, error: 'unknown timeframe "' + tf + '"', error_code: 'unknown-timeframe' };
        if (tfMs < this.baseMs) {
            return {
                ok: false, error_code: 'finer-than-canonical',
                error: 'the canonical timeline for this battle runs at ' + this.baseTimeframe + ' — ' + tf + ' is finer than the battle dataset',
                baseTimeframe: this.baseTimeframe
            };
        }
        const o = opts || {};
        const revealed = this.candles.slice(0, this.cursor + 1);
        const cut = this.cutTime();
        const bars = [];
        let cur = null;
        for (let i = 0; i < revealed.length; i++) {
            const b = revealed[i];
            const bucket = Math.floor(b.time / tfMs) * tfMs;
            if (!cur || cur.time !== bucket) {
                if (cur) bars.push(cur);
                cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: Number(b.volume) || 0, baseBars: 1 };
            } else {
                cur.high = Math.max(cur.high, b.high);
                cur.low = Math.min(cur.low, b.low);
                cur.close = b.close;
                cur.volume += Number(b.volume) || 0;
                cur.baseBars += 1;
            }
        }
        if (cur) bars.push(cur);
        // a bar is complete only when the revealed run covers its whole window
        const completeThrough = (typeof cut === 'number' ? cut : 0) + this.baseMs;
        bars.forEach(b => { b.complete = (b.time + tfMs) <= completeThrough; });
        const total = bars.length;
        const fromIdx = (o.from != null && o.from !== '') ? Math.max(0, Math.min(total, Math.round(Number(o.from) || 0))) : 0;
        const limit = (o.limit != null && o.limit !== '') ? Math.max(1, Math.min(5000, Math.round(Number(o.limit)))) : (o.all ? total : Math.max(0, total - fromIdx));
        const out = fromIdx === 0 && limit >= total ? bars : bars.slice(fromIdx, fromIdx + limit);
        return {
            ok: true,
            timeframe: tf,
            timeframeMs: tfMs,
            from: fromIdx,
            total,
            complete: bars.filter(b => b.complete).length,
            forming: bars.length && !bars[bars.length - 1].complete,
            bars: out
        };
    }

    setCursor(idx) {
        const next = Math.max(this.startIndex, Math.min(this.candles.length - 1, idx));
        if (next === this.cursor) return;
        if (next < this.cursor) {
            // A seek never re-simulates history. Keep every seat on the same
            // authoritative cursor; mode-specific rewind/reset semantics belong
            // to a future replay policy, not to the chart client.
            this.cursor = next;
            this.seats.forEach(s => { if (s.session) s.session.cursor = next; });
            this._touch('replay.seek', { cursor: next, rewind: true });
            emit('cursor', this);
            return;
        }
        this._ensureSeats();
        while (this.cursor < next && this.cursor < this.candles.length - 1) {
            this.cursor++;
            for (const s of this.seats) if (s.session) s.session.setCursor(this.cursor);
        }
        this.stateRevision += 1;
        emit('cursor', this);
    }

    start() {
        const gate = runnable(this);
        if (!gate.ok) return gate;
        if (this.status === 'lobby') this.status = 'running';
        this.lifecycle = 'battle';
        this._touch('battle.started', {});
        emit('status', this);
        return { ok: true };
    }

    transition(next, meta) {
        if (!LIFECYCLE.includes(next)) return { ok: false, error: 'unknown battle lifecycle state' };
        this.lifecycle = next;
        this.status = next === 'battle' ? 'running' : next === 'results' || next === 'analytics' ? 'completed' : (next === 'lobby' || next === 'ready' ? 'lobby' : this.status);
        this._touch('lifecycle.changed', { lifecycle: next, ...(meta || {}) });
        emit('status', this);
        return { ok: true, lifecycle: this.lifecycle };
    }

    _touch(type, payload) {
        this.stateRevision += 1;
        const event = { id: 'be_' + this.stateRevision, type, revision: this.stateRevision, cursor: this.cursor, at: new Date().toISOString(), ...(payload || {}) };
        this.events.push(event);
        this.actions.push({ type, cursor: this.cursor, at: event.at, ...(payload || {}) });
    }

    // ---- private seat actions ----
    enter(seatId, o) {
        const s = this.seat(seatId);
        if (!s) return { ok: false, error: 'unknown seat' };
        if (this.status === 'completed' || this.lifecycle !== 'battle') return { ok: false, error: 'battle is not accepting orders' };
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
        this._markActivity(s, 'enter');
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
        if (r.ok) {
            this._markActivity(s, 'close');
            this._log('close', { seat: seatId, reason: r.trade.exitReason, pnl: r.trade.pnl });
        }
        return r;
    }

    _log(type, payload) {
        this.actions.push({ type, at: new Date().toISOString(), cursor: this.cursor, ...payload });
        this.stateRevision += 1;
    }

    // ---- public (no private positions) vs private (one seat) ----
    publicState(viewerId) {
        return {
            id: this.id, title: this.title, symbol: this.symbol, timeframe: this.timeframe,
            category: this.category, status: this.status, createdAt: this.createdAt,
            period: this.period, periodLabel: this.periodLabel, candleWindow: this.candleWindow,
            cursor: this.cursor, total: this.candles.length, startIndex: this.startIndex,
            timeline: this.timelineState(),
            lifecycle: this.lifecycle, marketDataVersion: this.marketDataVersion,
            stateRevision: this.stateRevision,
            config: this.config, replay: this.replay, execution: this.execution,
            configBlockers: this.policyBlockers.slice(),
            runnable: this.policyBlockers.length === 0,
            endCondition: this.endCondition(),
            visibility: this.visibility(),
            settlement: { status: this.settlement.status || 'not_started' },
            scoring: this.scoringPolicy ? { status: this.scoringPolicy.provisional ? 'provisional' : 'configured', id: this.scoringPolicy.id || null } : { status: 'not_configured' },
            startingBalance: this.startingBalance, riskModel: this.riskModel,
            seats: this.seats.map(s => ({
                id: s.id, name: s.name, team: s.team, taken: !!s.userId,
                mine: !!viewerId && s.userId === viewerId
            })),
            // policy-filtered opponent state (presence only until a mode raises it)
            participants: this.participants(viewerId),
            leaderboard: this.status === 'completed' ? this.leaderboard() : null,
            candle: this.candles[this.cursor] || null
        };
    }

    seatState(seatId, opts) {
        const s = this.seat(seatId);
        if (!s) return null;
        this._ensureSeats();
        const o = opts || {};
        const st = stateOf(s.session);
        // Shared canonical visibility, with three delivery modes — the future is
        // ALWAYS hidden, so no mode can leak unrevealed candles:
        //   · full=1 / window=all → every visible bar (bar 0 → cursor). Used once
        //     when a seat opens, so the chart really holds the whole month so far.
        //   · from=N             → only bars after N (incremental poll: the chart
        //     already holds everything before N, so a 30k-bar 1m month never
        //     ships again on every cursor tick).
        //   · default            → bounded tail window (back-compat for old clients).
        const visible = this.cursor + 1;
        const wantFull = o.full === true || o.full === 1 || o.full === '1' || o.full === 'true' || o.window === 'all';
        const fromIdx = (o.from != null && o.from !== '') ? Math.max(0, Math.min(visible, Number(o.from) || 0)) : null;
        const tailWindow = Math.max(60, Math.min(2000, Number(o.window) || this.candleWindow));
        const start = fromIdx != null ? fromIdx : (wantFull ? 0 : Math.max(0, visible - tailWindow));
        st.candles = this.candles.slice(start, visible);
        st.candlesFrom = start;
        st.candlesTotal = visible;
        st.candleWindow = (fromIdx != null || wantFull) ? visible : tailWindow;
        st.cursor = this.cursor;
        // the seat's DISPLAY timeframe is recorded on the seat (metadata for the
        // opponent/spectator views) — never used to change execution.
        if (o.tf && BattleConfig.timeframeMs(o.tf) != null && this.displayTimeframes.indexOf(String(o.tf)) !== -1) s.displayTimeframe = String(o.tf);
        st.timeline = this.timelineState();
        if (s.displayTimeframe) st.timeline.displayTimeframe = s.displayTimeframe;
        st.period = this.period;
        st.periodLabel = this.periodLabel;
        st.battle = { id: this.id, title: this.title, status: this.status, lifecycle: this.lifecycle, seat: s.id, name: s.name, team: s.team, period: this.period, periodLabel: this.periodLabel, stateRevision: this.stateRevision };
        // opponent state, filtered by the visibility policy (own seat is never
        // filtered; hidden fields are listed so the UI can explain the gap)
        st.participants = this.participants(s.userId || null);
        st.visibility = this.visibility();
        st.you = { presence: this.presenceOf(s) };
        return st;
    }

    leaderboard() {
        this._ensureSeats();   // hydrated battles may not have sessions yet
        const rows = this.seats.map(s => {
            const sc = this.scoringPolicy ? scoreSeat(s) : { score: null, detail: { trades: s.session ? s.session.trades.length : 0, status: 'scoring_not_configured' } };
            return {
                seat: s.id, name: s.name, team: s.team, userId: s.userId,
                score: sc.score, detail: sc.detail,
                trades: s.session ? s.session.trades.map(t => ({
                    direction: t.direction, entry: t.entry, exit: t.exit, sl: t.sl, tp: t.tp,
                    entryTime: t.entryTime, exitTime: t.exitTime, exitReason: t.exitReason,
                    riskAmount: t.riskAmount, realizedR: t.realizedR, pnl: t.pnl, setup: t.setup
                })) : []
            };
        }).sort((a, b) => (b.score == null ? -1 : a.score == null ? 1 : b.score - a.score));
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
                score: g.some(r => r.score == null) ? null : Math.round(g.reduce((s, r) => s + r.score, 0) / g.length),
                trades: g.reduce((s, r) => s + r.detail.trades, 0),
                winRate: g.every(r => r.detail.winRate != null) ? Math.round(g.reduce((s, r) => s + r.detail.winRate, 0) / g.length * 10) / 10 : null,
                avgR: g.every(r => r.detail.avgR != null) ? Math.round(g.reduce((s, r) => s + r.detail.avgR, 0) / g.length * 1000) / 1000 : null,
                maxDD: g.every(r => r.detail.maxDD != null) ? Math.round(g.reduce((s, r) => s + r.detail.maxDD, 0) / g.length * 100) / 100 : null,
                members: g.length
            };
        }).sort((a, b) => (b.score == null ? -1 : a.score == null ? 1 : b.score - a.score));
        return { seats: rows, byTeam };
    }

    serialize() {
        return {
            id: this.id, hostId: this.hostId, title: this.title, symbol: this.symbol,
            timeframe: this.timeframe, category: this.category,
            startingTimeframe: this.startingTimeframe, baseTimeframe: this.baseTimeframe,
            displayTimeframes: this.displayTimeframes.slice(),
            candles: this.candles, startIndex: this.startIndex, cursor: this.cursor,
            lifecycle: this.lifecycle, config: this.config, replay: this.replay,
            execution: this.execution, settlement: this.settlement,
            marketDataVersion: this.marketDataVersion, stateRevision: this.stateRevision,
            events: this.events, scoringPolicy: this.scoringPolicy,
            startingBalance: this.startingBalance, riskModel: this.riskModel,
            inviteCode: this.inviteCode,
            period: this.period, periodLabel: this.periodLabel, candleWindow: this.candleWindow,
            status: this.status, configMeta: this.configMeta, policyBlockers: this.policyBlockers,
            seats: this.seats.map(s => ({
                id: s.id, name: s.name, team: s.team, userId: s.userId,
                activity: s.activity ? { ...s.activity } : null,
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
// ---------------------------------------------------------------------------
// Cross-user invite registry — battles live in the HOST's file, but invitees
// need to resolve them. A tiny registry maps battleId → hostId so any
// authenticated user can load a battle they were invited to.
// ---------------------------------------------------------------------------
function registryFile() {
    return path.join(process.env.TRADEMIND_BATTLE_DATA_DIR || path.join(__dirname, '..', 'data'), 'battle-registry.json');
}
function readRegistry() {
    try { if (fs.existsSync(registryFile())) return JSON.parse(fs.readFileSync(registryFile(), 'utf8')); } catch (e) { /* ignore */ }
    return {};
}
function writeRegistry(map) {
    try { fs.mkdirSync(path.dirname(registryFile()), { recursive: true }); fs.writeFileSync(registryFile(), JSON.stringify(map)); } catch (e) { /* ignore */ }
}
function listBattles(hostId) {
    return readAll(hostId).map(b => {
        const x = Battle.hydrate(b);
        return {
            id: x.id, title: x.title, symbol: x.symbol, timeframe: x.timeframe,
            period: x.period, periodLabel: x.periodLabel,
            status: x.status, createdAt: x.createdAt, cursor: x.cursor, total: x.candles.length,
            seats: x.seats.length, taken: x.seats.filter(s => s.userId).length,
            teams: [...new Set(x.seats.map(s => s.team).filter(Boolean))],
            invite: x.inviteCode || null
        };
    });
}
function getBattle(hostId, id) {
    // own file first, then the invite registry (a battle I was invited to)
    let b = readAll(hostId).find(x => x.id === id);
    if (b) return Battle.hydrate(b);
    const reg = readRegistry();
    const realHost = reg[id];
    if (realHost && realHost !== hostId) {
        b = readAll(realHost).find(x => x.id === id);
        if (b) return Battle.hydrate(b);
    }
    return null;
}
function saveBattle(hostId, b) {
    const list = readAll(hostId).filter(x => x.id !== b.id);
    list.push(b.serialize());
    writeAll(hostId, list);
    // keep the registry in sync so invitees can find it
    const reg = readRegistry();
    reg[b.id] = hostId;
    writeRegistry(reg);
}
function deleteBattle(hostId, id) {
    writeAll(hostId, readAll(hostId).filter(x => x.id !== id));
    const reg = readRegistry();
    if (reg[id]) { delete reg[id]; writeRegistry(reg); }
}

// ---------------------------------------------------------------------------
// Event bus — the WS hub subscribes here so battle changes are pushed to
// connected clients in real time instead of them polling.
// ---------------------------------------------------------------------------
const listeners = new Set();
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, b) {
    listeners.forEach(fn => { try { fn(type, b); } catch (e) { /* never break the battle */ } });
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
    const gate = runnable(b);
    if (!gate.ok) return gate;
    if (b.status === 'lobby') { const s = b.start(); if (s && s.ok === false) return s; }
    const ms = Math.max(40, Number(speedMs) || 300);
    if (b.timer) clearInterval(b.timer);
    b.timer = setInterval(() => {
        const ec = b.endCondition();
        if (ec.error) { clearInterval(b.timer); b.timer = null; saveBattle(hostId, b); emit('status', b); return; }
        if (ec.met) {
            clearInterval(b.timer); b.timer = null;
            settle(b);
            saveBattle(hostId, b);
            emit('status', b);
            return;
        }
        b.setCursor(b.cursor + 1);
        saveBattle(hostId, b);
    }, ms);
    return { ok: true, endCondition: b.endCondition() };
}
function pause(hostId, id) {
    const b = active.get(id);
    if (b && b.timer) { clearInterval(b.timer); b.timer = null; }
    if (b) { saveBattle(hostId, b); emit('status', b); }
    return { ok: true };
}
// Settlement: the ending condition was reached. Records HOW it ended so the
// result record is self-describing; the derived numbers come from the sessions.
function settle(b) {
    if (b.status === 'running' || b.status === 'lobby') {
        const ec = b.endCondition();
        const at = new Date().toISOString();
        b.status = 'completed';
        b.lifecycle = 'results';
        b.settlement = Object.assign({}, b.settlement, { status: 'ready', policy: ec.policy, reached: ec.met, at });
        b.completedAt = b.completedAt || at;
        b._touch('battle.completed', {});
    }
    return b;
}
function step(hostId, id) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    const gate = runnable(b);
    if (!gate.ok) return gate;
    if (b.status === 'lobby') { const s = b.start(); if (s && s.ok === false) return s; }
    const ec = b.endCondition();
    if (ec.error) return { ok: false, error: ec.error };
    if (ec.met) settle(b); else b.setCursor(b.cursor + 1);
    if (b.endCondition().met) settle(b);
    saveBattle(hostId, b);
    emit('status', b);
    return { ok: true, endCondition: b.endCondition() };
}
function transition(hostId, id, lifecycle, meta) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    const r = b.transition(lifecycle, meta);
    if (r.ok) saveBattle(hostId, b);
    return r;
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
    b.lifecycle = 'battle';
    b.completedAt = null;
    b.settlement = { ...b.settlement, status: 'not_started' };
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
    emit('status', b);
    return { ok: true };
}
function complete(hostId, id) {
    const b = loadActive(hostId, id);
    if (!b) return { ok: false, error: 'unknown battle' };
    if (b.timer) { clearInterval(b.timer); b.timer = null; }
    b.setCursor(b.candles.length - 1);
    settle(b);
    saveBattle(hostId, b);
    emit('status', b);
    return { ok: true, leaderboard: b.leaderboard(), settlement: b.settlement };
}

// ---------------------------------------------------------------------------
// Invite resolution — a code points to a battle owned by whoever hosts it.
// The registry is scanned because invites may point at any user's file.
// ---------------------------------------------------------------------------
function battleByCode(code) {
    if (!code) return null;
    const c = String(code).trim().toUpperCase();
    const reg = readRegistry();
    for (const battleId of Object.keys(reg)) {
        const hostId = reg[battleId];
        const b = readAll(hostId).find(x => x.id === battleId && x.inviteCode === c);
        if (b) return { hostId, battle: Battle.hydrate(b) };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Per-user pending battle invitations (in-app notification feed). Stored as a
// small file per invitee so the notifications engine can surface them without
// touching the host's battle file.
// ---------------------------------------------------------------------------
function invitesFileFor(userId) {
    return path.join(process.env.TRADEMIND_BATTLE_DATA_DIR || path.join(__dirname, '..', 'data'), 'battle-invites-' + userId + '.json');
}
function readInvites(userId) {
    try {
        const f = invitesFileFor(userId);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { /* ignore */ }
    return [];
}
function writeInvites(userId, list) {
    try {
        const f = invitesFileFor(userId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(list));
    } catch (e) { /* ignore */ }
}
// createInvitation(hostId, code) → returns the full invitation rows for a user
function invitationFor(userId, battleId, code) {
    const found = battleByCode(code);
    if (!found || found.battle.id !== battleId) return null;
    const b = found.battle;
    const free = b.seats.filter(s => !s.userId).length;
    const taken = b.seats.length - free;
    return {
        id: 'inv_' + b.id, battleId: b.id, code,
        title: b.title, symbol: b.symbol, timeframe: b.timeframe, status: b.status,
        hostId: found.hostId, seats: b.seats.length, taken, free,
        createdAt: b.createdAt, href: 'backtesting.html?mode=battle&invite=' + code
    };
}
function pendingInvites(userId) {
    return readInvites(userId).map(i => invitationFor(userId, i.battleId, i.code)).filter(Boolean);
}
function addInvite(userId, battleId, code) {
    const list = readInvites(userId).filter(x => !(x.battleId === battleId));
    list.push({ battleId, code, at: new Date().toISOString() });
    writeInvites(userId, list);
    const found = battleByCode(code);
    if (found) emit('status', found.battle);
}
function clearInvite(userId, battleId) {
    writeInvites(userId, readInvites(userId).filter(x => x.battleId !== battleId));
}

// ---------------------------------------------------------------------------
// Presence/availability is deliberately separate from matching. It is a small
// capability registry now; future matchmaking can consume it without coupling
// player presence to a battle record or inventing queue rules. The state list
// itself lives in battle-config.js so the contract has one home.
// ---------------------------------------------------------------------------
function availabilityFile() {
    return path.join(process.env.TRADEMIND_BATTLE_DATA_DIR || path.join(__dirname, '..', 'data'), 'battle-availability.json');
}
function readAvailability() {
    try { if (fs.existsSync(availabilityFile())) return JSON.parse(fs.readFileSync(availabilityFile(), 'utf8')); } catch (e) {}
    return {};
}
function writeAvailability(map) {
    try { fs.mkdirSync(path.dirname(availabilityFile()), { recursive: true }); fs.writeFileSync(availabilityFile(), JSON.stringify(map)); } catch (e) {}
}
function setAvailability(userId, status, meta) {
    if (!userId || !AVAILABILITY.includes(status)) return { ok: false, error: 'invalid availability status' };
    const map = readAvailability();
    map[userId] = { userId, status, updatedAt: new Date().toISOString(), meta: meta && typeof meta === 'object' ? { ...meta } : {} };
    writeAvailability(map);
    return { ok: true, presence: { ...map[userId] } };
}
function getAvailability(userId) {
    const row = readAvailability()[userId];
    return row || { userId, status: 'offline', updatedAt: null, meta: {} };
}
function listAvailability() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    return Object.values(readAvailability()).filter(row => row && new Date(row.updatedAt).getTime() >= cutoff).map(row => ({ ...row }));
}

// ---------------------------------------------------------------------------
// Challenges — the availability → matching → lobby handshake.
// A challenge is NOT a game mode: it is a named offer that carries a battle
// CONFIGURATION. Accepting it creates a real Battle in the lobby state with both
// players seated, through the same creation path as POST /api/battles. No
// ratings, queues or matchmaking rules live here.
// ---------------------------------------------------------------------------
const CHALLENGE_TTL_MS = 15 * 60 * 1000;
function challengesFile() {
    return path.join(process.env.TRADEMIND_BATTLE_DATA_DIR || path.join(__dirname, '..', 'data'), 'battle-challenges.json');
}
function readChallenges() {
    try { if (fs.existsSync(challengesFile())) return JSON.parse(fs.readFileSync(challengesFile(), 'utf8')); } catch (e) { /* ignore */ }
    return {};
}
function writeChallenges(map) {
    try { fs.mkdirSync(path.dirname(challengesFile()), { recursive: true }); fs.writeFileSync(challengesFile(), JSON.stringify(map)); } catch (e) { /* ignore */ }
}
function challengeId() {
    return 'chl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}
function publicChallenge(row) {
    return {
        id: row.id, fromUserId: row.fromUserId, toUserId: row.toUserId, status: row.status,
        createdAt: row.createdAt, expiresAt: row.expiresAt, acceptedAt: row.acceptedAt || null,
        battleId: row.battleId || null, message: row.message || null,
        config: row.config || null, configWarnings: row.configWarnings || []
    };
}
function createChallenge(fromUserId, toUserId, configInput, meta) {
    if (!fromUserId || !toUserId) return { ok: false, error: 'a challenge needs two players' };
    if (fromUserId === toUserId) return { ok: false, error: 'you cannot challenge yourself' };
    const m = meta || {};
    const n = BattleConfig.normalize(configInput);
    if (n.errors.length) return { ok: false, error: n.errors.join('; '), errors: n.errors };
    const map = readChallenges();
    // one pending offer per pair — a newer challenge supersedes the older one
    Object.keys(map).forEach(k => {
        const row = map[k];
        if (row.status === 'pending' && row.fromUserId === fromUserId && row.toUserId === toUserId) row.status = 'superseded';
    });
    const id = challengeId();
    map[id] = {
        id, fromUserId, toUserId, status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
        config: n.config, configWarnings: n.warnings,
        message: m.message ? String(m.message).slice(0, 200) : null,
        battleId: null
    };
    writeChallenges(map);
    // the challenger is waiting for a match: discovery → matching
    setAvailability(fromUserId, 'available', { waiting: 'challenge', challengeId: id });
    emit('challenges', { id: 'challenges' });
    return { ok: true, challenge: publicChallenge(map[id]) };
}
function getChallenge(id) {
    return readChallenges()[id] || null;
}
function pendingChallengesFor(userId) {
    const now = Date.now();
    const map = readChallenges();
    let dirty = false;
    const incoming = [];
    const outgoing = [];
    Object.keys(map).forEach(k => {
        const row = map[k];
        if (row.status === 'pending' && row.expiresAt && new Date(row.expiresAt).getTime() < now) { row.status = 'expired'; dirty = true; }
        if (row.status !== 'pending') return;
        if (row.toUserId === userId) incoming.push(publicChallenge(row));
        else if (row.fromUserId === userId) outgoing.push(publicChallenge(row));
    });
    if (dirty) writeChallenges(map);
    incoming.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    outgoing.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { incoming, outgoing };
}
// decision: 'accept' | 'decline'. Only the challenged player may answer.
function resolveChallenge(userId, id, decision) {
    const map = readChallenges();
    const row = map[id];
    if (!row) return { ok: false, error: 'unknown challenge' };
    if (row.toUserId !== userId) return { ok: false, error: 'this challenge was not sent to you' };
    if (row.status !== 'pending') return { ok: false, error: 'challenge is already ' + row.status };
    if (decision === 'decline') {
        row.status = 'declined';
        row.resolvedAt = new Date().toISOString();
        writeChallenges(map);
        emit('challenges', { id: 'challenges' });
        return { ok: true, challenge: publicChallenge(row) };
    }
    if (decision !== 'accept') return { ok: false, error: 'unknown decision' };
    row.status = 'accepted';
    row.acceptedAt = new Date().toISOString();
    writeChallenges(map);
    // both players are now committed to a battle record
    setAvailability(row.fromUserId, 'in_battle', { challengeId: id });
    setAvailability(row.toUserId, 'in_battle', { challengeId: id });
    emit('challenges', { id: 'challenges' });
    return { ok: true, challenge: publicChallenge(row) };
}
function linkChallengeBattle(id, battleId) {
    const map = readChallenges();
    if (!map[id]) return false;
    map[id].battleId = battleId;
    writeChallenges(map);
    return true;
}
// PLACEHOLDER opponent picker for Quick Battle: the longest-waiting player who
// is currently marked available. This is NOT matchmaking — ratings, queues and
// formats are unspecified — and it is isolated here so the real matcher can
// replace this function without touching the challenge flow.
function availableOpponents(userId) {
    return listAvailability()
        .filter(r => r.status === 'available' && r.userId !== userId && r.userId)
        .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
}
function pickQuickOpponent(userId) {
    const list = availableOpponents(userId);
    return list.length ? list[0].userId : null;
}

// ---------------------------------------------------------------------------
// Battle history — the same records as the feed, but not time-boxed to a week,
// and with the caller's own row from the final leaderboard attached. A battle a
// player was invited to lives in the HOST's file, so the registry is scanned.
// ---------------------------------------------------------------------------
function battleHistory(userId, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(200, Number(o.limit) || 25));
    const offset = Math.max(0, Number(o.offset) || 0);
    const seen = new Set();
    const rows = [];
    const push = b => {
        if (!b || seen.has(b.id)) return;
        seen.add(b.id);
        const mine = b.seats.find(s => s.userId === userId);
        if (!mine && b.hostId !== userId) return;
        if (o.status && b.status !== o.status) return;
        const lb = b.leaderboard();
        const myRow = mine ? lb.seats.find(r => r.seat === mine.id) : null;
        const winner = lb.seats.find(r => r.score != null) || null;
        rows.push({
            id: b.id, title: b.title, symbol: b.symbol, timeframe: b.timeframe,
            period: b.period, periodLabel: b.periodLabel, category: b.category,
            status: b.status, lifecycle: b.lifecycle,
            createdAt: b.createdAt, completedAt: b.completedAt,
            cursor: b.cursor, total: b.candles.length,
            seats: b.seats.length, taken: b.seats.filter(s => s.userId).length,
            mySeat: mine ? mine.id : null,
            myScore: myRow ? myRow.score : null,
            myTrades: myRow ? myRow.detail.trades : null,
            myNet: myRow ? myRow.detail.net : null,
            myAvgR: myRow ? myRow.detail.avgR : null,
            winner: winner ? { name: winner.name, team: winner.team, score: winner.score } : null,
            scoring: b.scoringPolicy ? { status: b.scoringPolicy.provisional ? 'provisional' : 'configured', id: b.scoringPolicy.id || null } : { status: 'not_configured' }
        });
    };
    readAll(userId).forEach(raw => push(Battle.hydrate(raw)));
    const reg = readRegistry();
    Object.keys(reg).forEach(id => {
        if (reg[id] === userId) return;
        const raw = readAll(reg[id]).find(x => x.id === id);
        if (raw) push(Battle.hydrate(raw));
    });
    rows.sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));
    return { total: rows.length, battles: rows.slice(offset, offset + limit) };
}

// ---------------------------------------------------------------------------
// Dashboard feed — active battles, joinable invites, and the last 7 days of
// completed results (all derived from the same canonical battle records).
// ---------------------------------------------------------------------------
function battlesFeed(hostId) {
    const all = readAll(hostId).map(x => Battle.hydrate(x));
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    const active = [], invites = [], results = [];
    all.forEach(x => {
        const taken = x.seats.filter(s => s.userId).length;
        const mySeat = x.seats.find(s => s.userId === hostId);
        const free = x.seats.some(s => !s.userId);
        const base = {
            id: x.id, title: x.title, symbol: x.symbol, timeframe: x.timeframe,
            period: x.period, periodLabel: x.periodLabel,
            status: x.status, createdAt: x.createdAt, completedAt: x.completedAt,
            cursor: x.cursor, total: x.candles.length,
            seats: x.seats.length, taken, teams: [...new Set(x.seats.map(s => s.team).filter(Boolean))]
        };
        if (x.status === 'lobby' || x.status === 'running') {
            if (mySeat) {
                base.mySeat = mySeat.id;
                // live own-seat readout: balance, realized + unrealized P&L, and
                // rank vs the other seated participants (all derived from the
                // canonical session results — no separate calculations)
                const st = x.seatState(mySeat.id);
                const realized = (st.trades || []).reduce((s, t) => s + t.pnl, 0);
                const unrealized = (st.position && st.position.unrealized) || 0;
                const equity = st.balance + unrealized;
                // rank: my equity vs every seated session's equity (sessions the
                // server owns; we only expose the rank, never their trades)
                let above = 1;
                x.seats.forEach(s => {
                    if (!s.userId || s.id === mySeat.id) return;
                    if (!s.session) return;
                    const o = s.session.results();
                    const oUn = s.session.position ? s.session._pnlAt(s.session.position, (s.session.candles[s.cursor] || s.session.position).close) : 0;
                    if (o.balance + oUn > equity + 0.0001) above++;
                });
                base.myStats = {
                    balance: Math.round(st.balance * 100) / 100,
                    realized: Math.round(realized * 100) / 100,
                    unrealized: Math.round(unrealized * 100) / 100,
                    equity: Math.round(equity * 100) / 100,
                    trades: (st.trades || []).length,
                    wins: (st.trades || []).filter(t => t.pnl > 0).length,
                    rank: above,
                    seated: x.seats.filter(s => s.userId).length
                };
                active.push(base);
            }
            else if (free) { base.canJoin = true; invites.push(base); }
            else active.push(base);
        } else if (x.status === 'completed') {
            if (x.completedAt && now - new Date(x.completedAt).getTime() <= week) {
                const lb = x.leaderboard();
                const winner = lb.seats.find(row => row.score != null) || null;
                results.push(Object.assign(base, {
                    winner: winner ? { name: winner.name, team: winner.team, score: winner.score, detail: winner.detail } : null,
                    leaderboard: lb
                }));
            }
        }
    });
    results.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    return { active, invites, results };
}

module.exports = {
    Battle, LIFECYCLE, AVAILABILITY, BattleConfig, capabilities: BattleConfig.capabilities,
    listBattles, getBattle, saveBattle, deleteBattle,
    play, pause, step, seek, reset, complete, transition, loadActive, scoreSeat,
    subscribe, emit, battlesFeed, genInviteCode, battleByCode,
    invitationFor, pendingInvites, addInvite, clearInvite,
    setAvailability, getAvailability, listAvailability,
    createChallenge, getChallenge, pendingChallengesFor, resolveChallenge, linkChallengeBattle,
    availableOpponents, pickQuickOpponent, battleHistory,
    END_CONDITIONS, registerEndCondition, runnable
};
