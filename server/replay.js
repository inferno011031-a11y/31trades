'use strict';

// ============================================================================
// 31TRADES — Market Replay engine
// ----------------------------------------------------------------------------
// Hosts bar-by-bar replay sessions for the Market Replay page. One API, two
// data paths — both backed by real TradingView candles:
//
//   LIVE  (TRADEMIND_TV_SESSION + TRADEMIND_TV_SIGNATURE set) — the true
//         TradingView replay mode via @mathieuc/tradingview: a replay session
//         is opened at the chosen timestamp and the server steps it one bar
//         at a time (range:1 + replayStep(1)), exactly like the library's
//         ReplayMode example. Requires a TradingView account (replay is a
//         paid feature) and its sessionid/signature cookies.
//
//   LOCAL (default) — pulls the REAL cached TradingView history for the
//         symbol/timeframe through marketdata.js and replays it bar-by-bar
//         with a server timer. Identical UX, honest label, works with no
//         account. Falls back to synthetic estimates only if TradingView is
//         unreachable (marketdata already handles that).
//
// The browser never talks to TradingView: it starts a session, polls status,
// and sends play/pause/step/reset — the server holds the single source of
// truth and streams revealed bars back.
// ============================================================================

const { resolveSymbol, getCandles, TV_TF } = require('./marketdata.js');

const DEFAULT_WINDOW = 400;      // bars in the replay window
const DEFAULT_PREROLL = 30;      // bars visible before playback begins
const SESSION_TTL_MS = 20 * 60 * 1000;   // idle sessions are swept after 20 min
const TICK_MS = 200;             // local-mode timer resolution

const sessions = new Map();
let idSeq = 0;

let TV = null;
try { TV = require('@mathieuc/tradingview'); } catch (e) { /* optional */ }
const liveAvailable = () => !!(
    TV != null &&
    process.env.TRADEMIND_TV_SESSION &&
    process.env.TRADEMIND_TV_SIGNATURE &&
    process.env.TRADEMIND_TV !== 'off'
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function normalizePeriod(p) {
    const t = Number(p.time);
    const time = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
    return {
        time,
        open: p.open,
        high: p.max != null ? p.max : Math.max(p.open, p.close),
        low: p.min != null ? p.min : Math.min(p.open, p.close),
        close: p.close,
        volume: Math.round((p.volume || 0) * 100) / 100
    };
}

// ---------------------------------------------------------------------------
// LIVE path — real TradingView replay session
// ---------------------------------------------------------------------------
function openLiveReplay(tvSymbol, timeframe, startTimeSec) {
    return new Promise((resolve, reject) => {
        let client = null, chart = null, settled = false;
        const finish = (err, handle) => {
            if (settled) return; settled = true;
            if (err) { try { if (chart) chart.delete(); } catch (e) {} try { if (client) client.end(); } catch (e) {} reject(err); }
            else resolve(handle);
        };
        const timer = setTimeout(() => finish(new Error('TradingView replay timeout')), 15000);
        try {
            client = new TV.Client({
                token: process.env.TRADEMIND_TV_SESSION,
                signature: process.env.TRADEMIND_TV_SIGNATURE
            });
            chart = new client.Session.Chart();
            chart.onError((...errs) => {
                const msg = errs.map(e => typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e)).join(' ');
                finish(new Error('TradingView replay error: ' + msg.slice(0, 160)));
            });
            chart.onReplayLoaded(() => {
                clearTimeout(timer);
                finish(null, {
                    chart,
                    step: async n => { try { await chart.replayStep(n || 1); } catch (e) {} },
                    stop: async () => { try { await chart.replayStop(); } catch (e) {} },
                    close: () => { try { chart.delete(); } catch (e) {} try { client.end(); } catch (e) {} }
                });
            });
            chart.onReplayEnd(() => { /* handled by the session wrapper */ });
            chart.setMarket(tvSymbol, {
                timeframe: TV_TF[timeframe] || '60',
                replay: startTimeSec * 1000,   // replay cursor is ms in the protocol
                range: 1
            });
        } catch (e) {
            clearTimeout(timer);
            finish(e);
        }
    });
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
function createSession(opts) {
    const o = opts || {};
    const symbol = String(o.symbol || 'EURUSD').toUpperCase();
    const timeframe = String(o.timeframe || '1h');
    const window = Math.max(20, Math.min(1500, Number(o.window) || DEFAULT_WINDOW));
    const preRoll = Math.min(window - 10, Math.max(5, Number(o.preRoll) || DEFAULT_PREROLL));

    const id = 'rp_' + (++idSeq) + '_' + Math.random().toString(36).slice(2, 8);
    const session = {
        id, symbol, timeframe,
        preRoll,
        mode: 'local',         // 'local' (server timer) | 'live' (TradingView replay)
        source: null,          // 'tradingview-replay' | 'history-local' | 'synthetic'
        all: [],               // full bar list (local mode) — normalized, ascending
        bars: [],              // revealed bars (live mode accumulates here)
        position: 0,           // revealed count (local mode: index into `all`)
        playing: false,
        ended: false,
        error: null,
        timer: null,
        live: null,            // live replay handle
        lastActive: Date.now(),
        close() {
            session.playing = false;
            if (session.timer) { clearInterval(session.timer); session.timer = null; }
            if (session.live) { try { session.live.close(); } catch (e) {} session.live = null; }
            sessions.delete(id);
        }
    };
    session.bump = () => { session.lastActive = Date.now(); };

    // setup is async; `ready` resolves when the bar source is live
    session.ready = (async () => {
        const r = await resolveSymbol(symbol);
        // LIVE path: real TradingView replay with account cookies
        if (liveAvailable() && r.tv) {
            try {
                const pre = await getCandles({ symbol, timeframe, count: window });
                const startTime = pre.candles[Math.max(0, pre.candles.length - window + preRoll)].time;
                const handle = await openLiveReplay(r.tv, timeframe, startTime);
                session.mode = 'live';
                session.live = handle;
                session.source = 'tradingview-replay';
                session.bars = pre.candles.slice(Math.max(0, pre.candles.length - preRoll));
                handle.chart.onUpdate(() => {
                    session.bump();
                    const p = handle.chart.periods[0];
                    if (p && (!session.bars.length || p.time !== session.bars[session.bars.length - 1].time)) {
                        session.bars.push(normalizePeriod(p));
                    }
                });
                handle.chart.onReplayEnd(() => { session.ended = true; session.playing = false; session.bump(); });
                return session;
            } catch (e) {
                console.log('[replay] live path failed (' + e.message + ') — falling back to local replay');
                if (session.live) { try { session.live.close(); } catch (e2) {} session.live = null; }
                session.mode = 'local';
            }
        }
        // LOCAL path: real (cached) history replayed bar-by-bar server-side
        const data = await getCandles({ symbol, timeframe, count: window });
        session.mode = 'local';
        session.all = data.candles.slice();
        session.position = Math.min(preRoll, session.all.length);
        session.source = (data.meta && data.meta.source === 'tradingview') || (data.meta && data.meta.source === 'cache')
            ? 'history-local' : 'synthetic';
        return session;
    })();

    return session;
}

// ---- revealed bars for the given mode -----------------------------------------
function revealedBars(s, fromIdx) {
    if (s.mode === 'live') return s.bars.slice(fromIdx);
    return s.all.slice(Math.min(fromIdx, s.position), s.position);
}

// ---- local-mode timer tick: reveal the next bar --------------------------------
async function tickLocal(session) {
    session.bump();
    if (!session.playing || session.ended) return;
    if (session.mode === 'live') {
        if (session.live) { try { await session.live.step(1); } catch (e) {} }
        return;
    }
    if (session.position < session.all.length) {
        session.position++;
        if (session.position >= session.all.length) {
            session.playing = false;
            session.ended = true;
        }
    } else {
        session.playing = false;
        session.ended = true;
    }
}

async function control(id, action, speedMs) {
    const s = sessions.get(id);
    if (!s) return { ok: false, error: 'unknown session' };
    await s.ready.catch(() => {});
    s.bump();
    const ms = Math.max(50, Number(speedMs) || 400);

    if (action === 'play') {
        s.playing = true; s.ended = false;
        if (s.timer) clearInterval(s.timer);
        s.timer = setInterval(() => tickLocal(s), ms);
        return { ok: true, state: await status(id) };
    }
    if (action === 'pause') {
        s.playing = false;
        if (s.timer) { clearInterval(s.timer); s.timer = null; }
        if (s.live) { try { await s.live.stop(); } catch (e) {} }
        return { ok: true, state: await status(id) };
    }
    if (action === 'step') {
        s.playing = false;
        if (s.timer) { clearInterval(s.timer); s.timer = null; }
        // reveal exactly one bar, regardless of play state
        if (s.mode === 'live') {
            if (s.live) { try { await s.live.step(1); } catch (e) {} }
        } else if (s.position < s.all.length) {
            s.position++;
            if (s.position >= s.all.length) s.ended = true;
        }
        return { ok: true, state: await status(id) };
    }
    if (action === 'reset') {
        s.playing = false;
        s.ended = false;
        if (s.timer) { clearInterval(s.timer); s.timer = null; }
        if (s.mode === 'live' && s.live) {
            // live replay can't rewind — close it and fall back to a local replay
            try { s.live.close(); } catch (e) {}
            s.live = null; s.mode = 'local';
            const data = await getCandles({ symbol: s.symbol, timeframe: s.timeframe, count: DEFAULT_WINDOW });
            s.all = data.candles.slice();
            s.position = Math.min(DEFAULT_PREROLL, s.all.length);
            s.source = (data.meta && data.meta.source === 'tradingview') || (data.meta && data.meta.source === 'cache')
                ? 'history-local' : 'synthetic';
        } else {
            s.position = Math.min(s.preRoll || DEFAULT_PREROLL, s.all.length);
        }
        s.bars = [];
        return { ok: true, state: await status(id) };
    }
    if (action === 'close') {
        s.close();
        return { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

// ---- status: bars revealed since index `from` (browser appends) ---------------
async function status(id, from) {
    const s = sessions.get(id);
    if (!s) return { ok: false, error: 'unknown session' };
    await s.ready.catch(() => {});
    s.bump();
    const fromIdx = Math.max(0, Number(from) || 0);
    const revealed = revealedBars(s, fromIdx);
    return {
        ok: true,
        id: s.id, symbol: s.symbol, timeframe: s.timeframe,
        source: s.source, playing: s.playing, ended: s.ended,
        position: s.mode === 'live' ? s.bars.length : s.position,
        total: s.mode === 'live' ? (s.position || s.bars.length) : s.all.length,
        from: fromIdx,
        bars: revealed,
        error: s.error
    };
}

// ---- idle sweep ---------------------------------------------------------------
setInterval(() => {
    const now = Date.now();
    sessions.forEach(s => { if (now - s.lastActive > SESSION_TTL_MS) { try { s.close(); } catch (e) {} } });
}, 60 * 1000).unref();

// ---- public -------------------------------------------------------------------
async function start(opts) {
    const s = createSession(opts);
    sessions.set(s.id, s);
    await s.ready.catch(() => {});
    if (!(s.all.length || s.bars.length)) {
        s.error = 'no data available for ' + s.symbol;
        s.close();
        return { ok: false, error: s.error };
    }
    return { ok: true, state: await status(s.id) };
}

module.exports = { start, control, status, sessions, DEFAULT_WINDOW, DEFAULT_PREROLL, liveAvailable };
