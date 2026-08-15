/* ============================================================================
   31TRADES — Market Replay mode module (runs inside backtesting.html?mode=replay)
   ----------------------------------------------------------------------------
   Bar-by-bar playback of real historical candles streamed from the server
   (/api/replay/*). Same engine as the old replay.html page — ported here so
   Practice / Battle / Replay all share ONE page and ONE chart experience.
   Latency: a client-side dataset cache (per symbol+timeframe+window) renders
   instantly when you come back to a market you already opened this session.
   Exposes window.ReplayMode = { boot(), destroy() }.
   ============================================================================ */
(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const apiFetch = (window.TradeMindCore && window.TradeMindCore.apiFetch) || ((url, options) => fetch(url, options));

    const CHART_LIGHT = { bg: '#FFFFFF', text: '#475569', grid: '#E2E8F0', border: '#CBD5E1', up: '#059669', down: '#DC2626' };
    const CHART_DARK = { bg: '#0F0F11', text: '#B4B4BD', grid: '#1A1A1E', border: '#1F1F23', up: '#10B981', down: '#EF4444' };
    function chartTheme() {
        const root = document.documentElement;
        return root && root.getAttribute('data-theme') === 'light' ? CHART_LIGHT : CHART_DARK;
    }

    function toast(msg) { if (window.showToast) window.showToast(msg); }

    // ---- state ----
    let sessionId = null;
    let bars = [];
    let playing = false;
    let speedMs = 400;
    let pollTimer = null;
    let currentSymbol = 'EURUSD', currentTF = '1h', currentWin = 400;
    let chart = null, candleSeries = null, volumeSeries = null;
    let pricePrecision = 5;
    let booted = false;

    // dataset cache: 'symbol|tf|window' -> { bars, total, source, at }
    const datasetCache = new Map();
    const CACHE_TTL = 5 * 60 * 1000;
    function cacheKey() { return currentSymbol + '|' + currentTF + '|' + currentWin; }
    function cachedDataset() {
        const c = datasetCache.get(cacheKey());
        if (!c) return null;
        if (Date.now() - c.at > CACHE_TTL) { datasetCache.delete(cacheKey()); return null; }
        return c;
    }

    // ---- chart ----
    function buildChart() {
        const el = $('rp-chart');
        if (!el || chart) return;
        const t = chartTheme();
        chart = LightweightCharts.createChart(el, {
            height: 470,
            layout: { background: { type: 'solid', color: t.bg }, textColor: t.text, fontFamily: "'JetBrains Mono', monospace" },
            grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
            rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
            timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            localization: { priceFormatter: p => p == null ? '—' : p.toLocaleString('en-US', { minimumFractionDigits: pricePrecision, maximumFractionDigits: pricePrecision }) }
        });
        candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
            upColor: t.up, downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up, wickDownColor: t.down
        });
        volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
        chart.subscribeCrosshairMove(param => {
            const d = param && param.seriesData && param.seriesData.get(candleSeries);
            renderLegend(d);
        });
        new ResizeObserver(() => { if (chart) chart.applyOptions({ width: el.clientWidth }); }).observe(el);
    }

    function applyChartTheme() {
        if (!chart) return;
        const t = chartTheme();
        chart.applyOptions({
            layout: { background: { type: 'solid', color: t.bg }, textColor: t.text },
            grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
            rightPriceScale: { borderColor: t.border }, timeScale: { borderColor: t.border }
        });
        if (candleSeries) candleSeries.applyOptions({ upColor: t.up, downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up, wickDownColor: t.down });
        renderChart();
    }

    let lastRenderedTime = 0;
    function renderChart() {
        buildChart();
        if (!chart) return;
        const data = bars.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
        candleSeries.setData(data);
        const t = chartTheme();
        volumeSeries.setData(data.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? t.up : t.down })));
        renderLegend(null);
        if (data.length && data[data.length - 1].time > lastRenderedTime) {
            chart.timeScale().scrollToRealTime();
            lastRenderedTime = data[data.length - 1].time;
        }
    }

    function renderLegend(bar) {
        const el = $('rp-legend');
        if (!el) return;
        const b = bar || (bars.length ? bars[bars.length - 1] : null);
        if (!b) { el.innerHTML = ''; return; }
        const t = chartTheme();
        const col = b.close >= b.open ? t.up : t.down;
        const f = p => p.toLocaleString('en-US', { minimumFractionDigits: pricePrecision, maximumFractionDigits: pricePrecision });
        el.innerHTML =
            '<span class="legend-item"><span class="sw" style="background:' + col + '"></span>O <b>' + f(b.open) + '</b></span>' +
            '<span class="legend-item"><span class="sw" style="background:' + col + '"></span>H <b>' + f(b.high) + '</b></span>' +
            '<span class="legend-item"><span class="sw" style="background:' + col + '"></span>L <b>' + f(b.low) + '</b></span>' +
            '<span class="legend-item"><span class="sw" style="background:' + col + '"></span>C <b>' + f(b.close) + '</b></span>';
    }

    function setSource(src) {
        const badge = $('rp-src'), label = $('rp-src-label');
        if (!badge || !label) return;
        if (src === 'tradingview-replay') { label.textContent = 'TradingView · live replay'; badge.classList.remove('amber'); }
        else if (src === 'history-local') { label.textContent = 'TradingView · local replay'; badge.classList.remove('amber'); }
        else { label.textContent = 'estimated · offline'; badge.classList.add('amber'); }
    }

    function updatePlayIco() {
        const ico = $('rp-play-ico');
        if (ico) { ico.setAttribute('data-lucide', playing ? 'pause' : 'play'); if (window.lucide) lucide.createIcons(); }
    }

    async function startSession() {
        stopPoll(); playing = false; updatePlayIco();
        const sub = $('rp-sub');
        if (sub) sub.textContent = 'Starting replay for ' + currentSymbol + ' · ' + currentTF + '…';
        // fast path: reuse the cached dataset so the chart paints instantly
        const cached = cachedDataset();
        if (cached) {
            bars = cached.bars.map(b => ({ ...b }));
            pricePrecision = bars.length && bars[0].close < 1 ? 6 : bars.length && bars[0].close < 100 ? 3 : bars.length && bars[0].close < 1000 ? 2 : 1;
            buildChart();
            renderChart();
            setSource(cached.source);
            if (sub) sub.textContent = (cached.source === 'history-local' || cached.source === 'tradingview-replay' ? 'Real TradingView history' : 'Offline estimate') + ' · ' + cached.total + ' bars · cached';
            const pp = $('rp-pos');
            if (pp) pp.textContent = cached.total + ' / ' + cached.total;
            renderAssetBadge();
            const title = $('rp-title');
            if (title) title.textContent = currentSymbol + ' · ' + currentTF;
            chart.timeScale().fitContent();
        }
        try {
            const res = await apiFetch('/api/replay/start?symbol=' + encodeURIComponent(currentSymbol) + '&timeframe=' + currentTF + '&window=' + currentWin);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const d = await res.json();
            if (!d.ok) throw new Error(d.error || 'start failed');
            sessionId = d.state.id;
            bars = (d.state.bars || []).map(b => ({ ...b }));
            setSource(d.state.source);
            pricePrecision = bars.length && bars[0].close < 1 ? 6 : bars.length && bars[0].close < 100 ? 3 : bars.length && bars[0].close < 1000 ? 2 : 1;
            datasetCache.set(cacheKey(), { bars: bars.map(b => ({ ...b })), total: d.state.total, source: d.state.source, at: Date.now() });
            buildChart();
            renderChart();
            const title = $('rp-title');
            if (title) title.textContent = currentSymbol + ' · ' + currentTF;
            if (sub) sub.textContent = (d.state.source === 'history-local' || d.state.source === 'tradingview-replay'
                ? 'Real TradingView history · ' + d.state.total + ' bars in window'
                : 'Offline estimate · ' + d.state.total + ' bars in window');
            const pp = $('rp-pos');
            if (pp) pp.textContent = d.state.position + ' / ' + (d.state.total || '?');
            renderAssetBadge();
            chart.timeScale().fitContent();
            toast('Replay ready — press play');
        } catch (e) {
            if (sub) sub.textContent = 'Failed to start replay: ' + e.message;
            toast('Could not start replay — is the server running?');
        }
    }

    function updatePos(pos, total) {
        const pp = $('rp-pos');
        if (pp) pp.textContent = pos + ' / ' + (total || '?');
        const last = bars[bars.length - 1];
        const pt = $('rp-time');
        if (pt) pt.textContent = last ? '· ' + new Date(last.time * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    }

    async function poll() {
        if (!sessionId) return;
        try {
            const res = await apiFetch('/api/replay/status?id=' + encodeURIComponent(sessionId) + '&from=' + bars.length);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const d = await res.json();
            if (!d.ok) { toast(d.error || 'replay session lost'); stopPoll(); playing = false; updatePlayIco(); return; }
            if (d.bars && d.bars.length) {
                bars.push(...d.bars.map(b => ({ ...b })));
                renderChart();
            }
            setSource(d.source);
            updatePos(d.position, d.total);
            if (d.ended) {
                playing = false; updatePlayIco();
                if (d.bars && d.bars.length) toast('Replay complete — reached the latest bar');
            }
            if (d.playing && !d.ended) pollTimer = setTimeout(poll, 200);
            else if (!d.playing && playing) { playing = false; updatePlayIco(); }
        } catch (e) {
            stopPoll(); playing = false; updatePlayIco();
            toast('Replay connection lost: ' + e.message);
        }
    }
    function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

    async function control(action) {
        if (!sessionId) return;
        try {
            const res = await apiFetch('/api/replay/control', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: sessionId, action, speedMs })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const d = await res.json();
            if (!d.ok) throw new Error(d.error);
            if (d.state) {
                setSource(d.state.source);
                updatePos(d.state.position, d.state.total);
                if (d.state.bars && d.state.bars.length) {
                    bars = d.state.bars;
                    renderChart();
                }
            }
            return true;
        } catch (e) { toast('Control failed: ' + e.message); return false; }
    }

    async function togglePlay() {
        if (!sessionId) return;
        if (playing) {
            playing = false; updatePlayIco(); stopPoll();
            await control('pause');
        } else {
            playing = true; updatePlayIco();
            await control('play');
            poll();
        }
    }
    async function stepFwd() { playing = false; updatePlayIco(); stopPoll(); const ok = await control('step'); if (ok) poll(); }
    async function stepBack() { playing = false; updatePlayIco(); stopPoll(); await control('reset'); }

    function buildSymbolPicker() {
        const sel = $('rp-symbol');
        if (!sel || !window.TMAssets || !window.TMAssets.SYMBOLS) return;
        let html = '';
        window.TMAssets.CATEGORIES.forEach(cat => {
            const syms = window.TMAssets.SYMBOLS.filter(s => s.cat === cat);
            if (!syms.length) return;
            html += '<optgroup label="' + cat + '">' + syms.map(s => '<option value="' + s.sym + '">' + s.sym + ' — ' + s.name + '</option>').join('') + '</optgroup>';
        });
        sel.innerHTML = html;
        sel.value = currentSymbol;
        sel.addEventListener('change', () => { currentSymbol = sel.value; startSession(); });
    }
    function renderAssetBadge() {
        const el = $('rp-badge');
        if (!el) return;
        el.innerHTML = '';
        try {
            const id = window.TMAssets && window.TMAssets.identityFor(currentSymbol);
            if (id && id.badge) { el.innerHTML = id.badge; return; }
        } catch (e) {}
        el.innerHTML = '<span class="num text-[13px] font-bold text-white">' + currentSymbol + '</span>';
    }

    // ---- boot / destroy ----
    function boot() {
        if (booted) return;
        booted = true;
        const collapse = $('collapse-btn');
        if (collapse) collapse.addEventListener('click', () => document.body.classList.toggle('collapsed'));

        const tfBar = $('rp-tf');
        if (tfBar) tfBar.querySelectorAll('.tf-btn').forEach(b => b.addEventListener('click', () => {
            tfBar.querySelectorAll('.tf-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            currentTF = b.dataset.tf;
            startSession();
        }));
        document.querySelectorAll('#rp-win-bar [data-win]').forEach(b => b.addEventListener('click', () => {
            document.querySelectorAll('#rp-win-bar [data-win]').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            currentWin = Number(b.dataset.win);
            startSession();
        }));
        const speedBar = $('rp-speed');
        if (speedBar) speedBar.querySelectorAll('.speed-btn').forEach(b => b.addEventListener('click', () => {
            speedBar.querySelectorAll('.speed-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            speedMs = Number(b.dataset.speed);
        }));
        const play = $('rp-play');
        if (play) play.addEventListener('click', togglePlay);
        const sf = $('rp-step-fwd');
        if (sf) sf.addEventListener('click', stepFwd);
        const reset = $('rp-reset');
        if (reset) reset.addEventListener('click', stepBack);
        const sb = $('rp-step-back');
        if (sb) sb.addEventListener('click', stepBack);
        const ns = $('rp-new');
        if (ns) ns.addEventListener('click', startSession);

        buildSymbolPicker();
        renderAssetBadge();
        if (window.lucide) lucide.createIcons();
        startSession();
        window.addEventListener('beforeunload', () => {
            if (sessionId) {
                try { navigator.sendBeacon('/api/replay/control', JSON.stringify({ id: sessionId, action: 'close' })); } catch (e) {}
            }
        });
    }

    function destroy() {
        booted = false;
        stopPoll();
        playing = false;
        if (sessionId) {
            try { navigator.sendBeacon('/api/replay/control', JSON.stringify({ id: sessionId, action: 'close' })); } catch (e) {}
            sessionId = null;
        }
        if (chart) { try { chart.remove(); } catch (e) {} chart = null; candleSeries = null; volumeSeries = null; }
        const el = $('rp-chart');
        if (el) el.innerHTML = '';
        bars = [];
    }

    document.addEventListener('tm:theme', () => applyChartTheme());

    window.ReplayMode = { boot, destroy };
})();
