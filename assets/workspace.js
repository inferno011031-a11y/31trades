/* ============================================================================
   31TRADES — Internal chart workspaces
   ----------------------------------------------------------------------------
   Every timeframe is its own workspace state. Switching 1H → 5M does NOT carry
   drawings, indicators or chart state across — each timeframe restores its own
   saved workspace, and the one you left is preserved for when you return.

   Persistence chain:  user → session → workspace(timeframe) → state
   state = { drawings: [{kind,a,b,color}], indicators: {ema,sma,bb,vwap,rsi,macd},
             chartState: { theme: {bg,text,grid,up,down,crosshair,border,volume},
                           scale: {rightOffset, visibleTime} } }

   Shared by Backtesting (practice) and Battle — both call the same module so
   the workspace behaviour is identical across modes.
   ============================================================================ */
(function () {
    'use strict';
    var PREFIX = '31trades.ws.v1.';
    var CACHE = {};

    function uid() {
        try {
            var s = window.TradeMindAuth && window.TradeMindAuth.getSession && window.TradeMindAuth.getSession();
            if (s && s.user) return s.user.id || s.user.email || 'anon';
        } catch (e) { /* ignore */ }
        try {
            var core = window.TradeMindCore;
            if (core && core.currentUserId) return core.currentUserId();
        } catch (e) { /* ignore */ }
        return 'anon';
    }

    function keyFor(user, sessionId, timeframe) {
        return PREFIX + user + '.' + sessionId + '.' + (timeframe || '?');
    }

    function load(user, sessionId, timeframe) {
        var k = keyFor(user, sessionId, timeframe);
        if (CACHE[k] !== undefined) return CACHE[k];
        var raw = null;
        try { raw = localStorage.getItem(k); } catch (e) { /* ignore */ }
        var ws = raw ? safeParse(raw) : null;
        if (!ws) ws = defaultWorkspace();
        CACHE[k] = ws;
        return ws;
    }

    function save(user, sessionId, timeframe, ws) {
        var k = keyFor(user, sessionId, timeframe);
        CACHE[k] = ws;
        try { localStorage.setItem(k, JSON.stringify(ws)); } catch (e) { /* ignore */ }
    }

    function remove(user, sessionId, timeframe) {
        var k = keyFor(user, sessionId, timeframe);
        delete CACHE[k];
        try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    }

    function safeParse(raw) {
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function defaultWorkspace() {
        return {
            drawings: [],
            indicators: { ema: true, sma: false, bb: true, vwap: false, rsi: true, macd: true },
            chartState: {
                theme: null,           // null = use the app default chart theme
                rightOffset: 4,
                visibleTime: null      // last visible candle time (restored on return)
            }
        };
    }

    // ---- convenience for the practice page (session has one timeframe) ----
    function forSession(sessionId, timeframe) {
        return load(uid(), sessionId, timeframe);
    }
    function saveSession(sessionId, timeframe, ws) {
        save(uid(), sessionId, timeframe, ws);
    }

    window.TMWorkspace = {
        uid: uid,
        get: load,
        set: save,
        remove: remove,
        defaults: defaultWorkspace,
        forSession: forSession,
        saveSession: saveSession,
        keyFor: keyFor
    };
})();
