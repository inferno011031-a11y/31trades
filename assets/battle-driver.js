/* ============================================================================
 * 31TRADES — BATTLE DRIVER (runs the BattleX terminal in battle mode)
 * ----------------------------------------------------------------------------
 * Activated ONLY by ?battle=<id>[&seat=<seatId>][&tf=15m][&embed=1] on
 * chart-test.html. Without that parameter this file does nothing at all, so
 * practice backtesting is untouched.
 *
 * A battle is not a second chart. The SAME terminal renders it, and this module
 * supplies the two things that make it a battle:
 *
 *   1. the market series — every timeframe comes from
 *      GET /api/battles/:id/timeline?timeframe=… , which the server builds by
 *      aggregating the bars the shared cursor has REVEALED. Both seats read the
 *      same server slices, so two players can never receive different market
 *      data, and a coarser timeframe can never carry a bar whose interior is
 *      still in the future.
 *   2. the shared market moment — the server-owned `cutTime`. The chart is
 *      re-sliced to it; the local replay engine is never allowed to move the
 *      market, because a seat that could step its own market could see the
 *      future.
 *
 * Orders are NOT re-implemented here: the page's existing BacktestBridge is
 * re-pointed at the battle seat endpoints, so the HUD's order flow, fills, P&L
 * and position lines stay exactly what practice uses.
 * ==========================================================================*/
(function () {
    'use strict';

    var qs = new URLSearchParams(location.search);
    var battleId = qs.get('battle');
    if (!battleId) return;

    var POLL_MS = 1500;
    var TF_MS = {
        '1m': 60000, '2m': 120000, '3m': 180000, '5m': 300000, '15m': 900000,
        '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000,
        '6h': 21600000, '1d': 86400000, 'w': 604800000, 'm': 2592000000
    };

    function token() {
        try {
            var s = JSON.parse(localStorage.getItem('31trades.session.v1') || '{}');
            return s.access_token || s.token || '';
        } catch (e) { return ''; }
    }
    function headers(json) {
        var h = json ? { 'Content-Type': 'application/json' } : {};
        var t = token();
        if (t) h['Authorization'] = 'Bearer ' + t;
        return h;
    }
    async function api(path, opts) {
        opts = opts || {};
        var r = await fetch(path, {
            method: opts.method || 'GET',
            headers: headers(!!opts.body),
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
    }
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    function tfLabel(ms) {
        if (!ms) return '—';
        var d = new Date(ms);
        return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    }
    function resolutionTf(resolution) {
        var map = window.BX_RESOLUTION_MAP || {};
        return map[String(resolution).toUpperCase()] || '15m';
    }

    // ---------------------------------------------------------------------
    // state
    // ---------------------------------------------------------------------
    var B = window.BX_BATTLE = {
        active: true,
        id: battleId,
        seatId: qs.get('seat') || null,
        timeline: null,
        seat: null,
        participants: null,
        cache: {},                  // tf -> { cut, bars }
        appliedCut: null,
        appliedBars: 0,
        lastError: null,
        ready: false
    };

    // ---------------------------------------------------------------------
    // 1 · the series (the chart's datafeed delegates here — see getBars hook)
    // ---------------------------------------------------------------------
    B.getBars = async function (symbolInfo, resolution, periodParams, onResult, onError) {
        try {
            var tf = resolutionTf(resolution);
            var res = await api('/api/battles/' + encodeURIComponent(battleId) + '/timeline?timeframe=' + encodeURIComponent(tf) + '&all=1');
            if (!res.ok || !Array.isArray(res.bars)) { onResult([], { noData: true }); return; }
            var bars = res.bars.map(function (b) {
                return {
                    time: b.time, open: Number(b.open), high: Number(b.high), low: Number(b.low),
                    close: Number(b.close), volume: Number(b.volume) || 0,
                    // the last bar of a coarser timeframe is a live, PARTIAL candle
                    // built from the revealed canonical bars only
                    complete: b.complete !== false
                };
            });
            B.deliveredBars = true;
            B.chartUnavailable = null;
            B.cache[tf] = { cut: res.timeline && res.timeline.cutTime, bars: bars };
            B.timeline = res.timeline || B.timeline;
            window.historicalBars = bars;
            window._barsGeneration = (window._barsGeneration || 0) + 1;
            window._lastBarsLoadForSymbol = symbolInfo.name;
            window.replayCursor = bars.length;
            try {
                document.dispatchEvent(new CustomEvent('bx-bars-loaded', {
                    detail: { symbol: symbolInfo.name, tf: tf, count: bars.length, battle: battleId, forming: !!(res.forming) }
                }));
            } catch (e) {}
            onResult(bars, { noData: false });
        } catch (e) {
            B.lastError = e.message;
            if (typeof onError === 'function') onError(e.message);
            else onResult([], { noData: true });
        }
    };

    // ---------------------------------------------------------------------
    // 2 · the shared market moment
    // ---------------------------------------------------------------------
    // TradingView's free widget has no activeChart(); reading it blindly threw and
    // killed the whole cut application (observed), so it is guarded here.
    function activeChart() {
        try {
            var w = window.tvWidget;
            if (!w) return null;
            if (typeof w.activeChart === 'function') return w.activeChart();
            if (typeof w.chart === 'function') return w.chart();
        } catch (e) {}
        return null;
    }

    async function applyCut() {
        var t = B.timeline;
        if (!t || t.cutTime == null) return;
        var chart = activeChart();
        var moved = B.appliedCut !== t.cutTime;
        window.isBacktestMode = true;              // enables the HUD order ticket
        window._replayCutTimeMs = t.cutTime;        // every other code path reads this
        if (!moved && B.appliedBars === t.revealedBars) return;
        var first = B.appliedCut == null;
        B.appliedCut = t.cutTime;
        B.appliedBars = t.revealedBars;
        if (!chart) return;
        try {
            // the datafeed slices per timeframe, so the series must be refetched
            if (typeof window._onResetCacheNeeded === 'function') window._onResetCacheNeeded();
            if (typeof chart.resetData === 'function') chart.resetData();
        } catch (e) { B.lastError = 'resetData: ' + e.message; }
        // centre the view on the market moment only while it is being found, so a
        // player who scrolled back is never yanked forward every second
        if (first) {
            setTimeout(function () {
                try {
                    var cutSec = Math.floor(t.cutTime / 1000);
                    var tfMs = TF_MS[(window._chartResolution && resolutionTf(window._chartResolution)) || '15m'] || 900000;
                    var stepSec = tfMs / 1000;
                    chart.setVisibleRange({ from: cutSec - Math.round(60 * stepSec), to: cutSec + Math.round(8 * stepSec) });
                } catch (e) {}
            }, 160);
        }
    }

    // ---------------------------------------------------------------------
    // 3 · polling: seat state (private) + participants (policy-filtered)
    // ---------------------------------------------------------------------
    async function poll() {
        try {
            if (B.seatId) {
                var tf = (window._chartResolution && resolutionTf(window._chartResolution)) || '15m';
                var s = await api('/api/battles/' + encodeURIComponent(battleId) + '/seat?seat=' + encodeURIComponent(B.seatId) + '&tf=' + encodeURIComponent(tf));
                B.seat = s.state;
                if (B.seat && B.seat.timeline) B.timeline = B.seat.timeline;
            } else {
                var p0 = await api('/api/battles/' + encodeURIComponent(battleId));
                B.timeline = p0.state.timeline;
                B.pub = p0.state;
            }
            var p = await api('/api/battles/' + encodeURIComponent(battleId) + '/participants');
            B.participants = p;
            // a structural problem (no charting library) is NOT an error that a
            // successful poll should erase — it stays until the page can chart again
            if (!B.chartUnavailable) B.lastError = null;
            // the page's own title/label globals describe the battle's dataset, not a
            // practice month (the practice datafeed is bypassed in battle mode)
            if (B.seat) {
                if (B.seat.period) { window.currentBacktestPeriod = B.seat.period; window.currentBacktestPeriodLabel = B.seat.periodLabel || B.seat.period; }
                if (B.seat.timeline && B.seat.timeline.startingTimeframe) window.currentBacktestTimeframe = B.seat.timeline.startingTimeframe;
            }
            render();
            await applyCut();
        } catch (e) {
            B.lastError = e.message;
            render();
        }
    }

    // ---------------------------------------------------------------------
    // 4 · the battle strip (the competitive information AROUND the chart)
    // ---------------------------------------------------------------------
    function strip() {
        var el = document.getElementById('bx-battle-strip');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'bx-battle-strip';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:14px;' +
            'flex-wrap:wrap;padding:6px 14px;font:600 11.5px/1.5 Inter,system-ui,sans-serif;letter-spacing:.02em;' +
            'background:linear-gradient(90deg,#0b0f16 0%,#111827 60%,#0b0f16 100%);color:#e5e7eb;border-bottom:1px solid #1f2937';
        document.body.appendChild(el);
        document.body.style.paddingTop = '68px';
        return el;
    }

    function render() {
        var t = B.timeline || {};
        var seat = B.seat || {};
        var me = B.participants && B.participants.participants ? B.participants.participants.filter(function (x) { return x.mine; })[0] : null;
        var others = B.participants && B.participants.participants ? B.participants.participants.filter(function (x) { return !x.mine; }) : [];
        var opponent = others.length ? others.map(function (o) {
            var dot = o.presence === 'active' ? '#22c55e' : (o.presence === 'online' || o.presence === 'waiting' ? '#eab308' : '#6b7280');
            var bits = [esc(o.presence || 'unknown')];
            if (o.status) bits.push(esc(o.status));
            if (o.direction) bits.push(esc(o.direction));
            return '<span style="display:inline-flex;align-items:center;gap:5px"><i style="width:7px;height:7px;border-radius:50%;background:' + dot + ';display:inline-block"></i>' +
                esc(o.name || 'Opponent') + ' · ' + bits.join(' · ') + '</span>';
        }).join('<span style="opacity:.35;margin:0 6px">|</span>') : '<span style="opacity:.6">no opponent seated yet</span>';
        var hidden = B.participants && B.participants.visibility && B.participants.visibility.hidden ? B.participants.visibility.hidden.join(', ') : '';
        var status = (B.pub && B.pub.status) || (seat.battle && seat.battle.status) || '—';
        var lifecycle = (B.pub && B.pub.lifecycle) || (seat.battle && seat.battle.lifecycle) || '—';
        var forming = B.cache && Object.keys(B.cache).length ? !B.cache[(window._chartResolution && resolutionTf(window._chartResolution)) || '15m'] : null;

        strip().innerHTML =
            '<span style="color:#93c5fd">BATTLE</span>' +
            '<span style="opacity:.75">' + esc(battleId) + '</span>' +
            '<span style="opacity:.35">|</span>' +
            '<span>Market moment <b style="color:#fbbf24">' + esc(tfLabel(t.cutTime)) + '</b></span>' +
            '<span style="opacity:.65">' + (t.baseTimeframe ? 'canonical ' + esc(t.baseTimeframe) : '') + '</span>' +
            '<span style="opacity:.65">' + (t.revealedBars != null ? t.revealedBars + ' / ' + t.totalBars + ' bars revealed' : '') + '</span>' +
            '<span style="opacity:.35">|</span>' +
            '<span>' + esc(status) + ' · ' + esc(lifecycle) + '</span>' +
            '<span style="opacity:.35">|</span>' +
            '<span>' + opponent + '</span>' +
            (hidden ? '<span style="opacity:.5">(hidden: ' + esc(hidden) + ')</span>' : '') +
            '<span style="margin-left:auto"></span>' +
            (B.chartUnavailable
                ? '<span style="color:#fbbf24;max-width:46%;white-space:normal">⚠ ' + esc(B.lastError || 'this page cannot chart the battle timeline') + '</span>'
                : (B.lastError
                    ? '<span style="color:#fca5a5">' + esc(B.lastError) + '</span>'
                    : '<span style="opacity:.6">Market is server-owned — the host drives it</span>'));
    }

    // ---------------------------------------------------------------------
    // 5 · the existing order bridge, pointed at the battle seat
    // ---------------------------------------------------------------------
    function linkBridge() {
        var br = window.BacktestBridge;
        if (!br || br.__bxLinked) return false;
        br.__bxLinked = true;
        br.mode = 'battle';
        br.battleId = battleId;
        br.seatId = B.seatId || (B.pub && B.pub.seats && B.pub.seats.length ? B.pub.seats[0].id : null);
        br.apiBase = '/api/battles/' + encodeURIComponent(battleId);
        br.sessionId = null;            // a battle seat is not a practice session
        // the market is server-driven: never sync bars into a backend session
        br.syncReplayBar = async function () { return; };
        console.log('[BattleX Bridge] battle mode →', br.apiBase, 'seat', br.seatId);
        // adopt the seat's balance for the HUD (best effort, same as practice)
        try { br.preflight(); } catch (e) {}
        return true;
    }

    function hideLocalReplay() {
        // The dock's play/step belong to the practice replay engine. In a battle
        // the market moves only when the server moves it, so they are hidden
        // rather than left there looking like they do something.
        var dock = document.getElementById('tv_replay_dock');
        if (dock) dock.style.display = 'none';
        var hud = document.querySelector('.hud-header');
        if (hud) hud.style.marginTop = '34px';
    }

    // ---------------------------------------------------------------------
    // boot
    // ---------------------------------------------------------------------
    function boot() {
        try {
            // the page's own globals: title/HUD read them
            // no archive month of our own: the battle's dataset arrives with the
            // first seat poll (poll() writes period/periodLabel/startingTimeframe)
            window.currentBacktestTimeframe = window.currentBacktestTimeframe || qs.get('tf') || '15m';
        } catch (e) {}
        B.ready = true;
        render();
        hideLocalReplay();
        poll();
        setInterval(poll, POLL_MS);
        setInterval(linkBridge, 1000);   // the bridge is created by page scripts
    }

    // LOUD FAILURE GUARD: if the page is running TradingView's free iframe widget
    // instead of the Charting Library (the library_path fallback), the datafeed is
    // never called and the chart would simply stay empty with no explanation.
    // The battle data itself is fine — say so, and say why it cannot be charted.
    function watchForSilentChart() {
        if (B.deliveredBars) return;
        var isFreeWidget = !!(window.tvWidget && window.tvWidget._iFrame);
        B.chartUnavailable = isFreeWidget ? 'tradingview-fallback-widget' : 'datafeed-not-called';
        B.lastError = isFreeWidget
            ? 'This page fell back to TradingView\'s free widget, which charts its OWN data — the battle timeline cannot be drawn there. Serve the Charting Library (token proxy or charting_library/) and reload.'
            : 'the chart never requested its datafeed — the battle timeline is ready but nothing is rendering it';
        console.warn('[Battle driver]', B.lastError);
        render();
    }
    setTimeout(watchForSilentChart, 12000);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // the chart's timeframe switches must re-slice at the SAME cut: poll applies it
    document.addEventListener('bx-bars-loaded', function () { setTimeout(applyCut, 60); });
})();
