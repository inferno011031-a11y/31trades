/* ============================================================================
   31TRADES — Battle mode module (runs inside backtesting.html?mode=battle)
   ----------------------------------------------------------------------------
   The Online Battle workstation: canonical shared timeline, private seats,
   host replay controls, WebSocket live sync, blended scoring. This is the SAME
   engine as before (server/battle.js + server/backtest-sim.js) — only the DOM
   wiring moved here so Practice / Battle / Replay all share one page and one
   chart experience. All ids are bl- prefixed to live beside the practice page.
   Exposes window.BattleMode = { boot(), destroy() }.
   ============================================================================ */
(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const apiFetch = (window.TradeMindCore && window.TradeMindCore.apiFetch) || ((url, options) => fetch(url, options));

    // ---- state ----
    let battles = [];
    let battle = null;        // public state
    let seat = null;          // my seat id (localStorage per battle)
    let seatState = null;     // my private state
    let chart = null, candleSeries = null, volumeSeries = null, posLines = [];
    let pollTimer = null;
    let ws = null, wsTimer = null;
    let playing = false;
    let speedMs = 300;
    let currentDir = 'long';
    let booted = false;

    const CHART_LIGHT = { bg: '#FFFFFF', text: '#475569', grid: '#E2E8F0', border: '#CBD5E1', up: '#059669', down: '#DC2626' };
    const CHART_DARK = { bg: '#0F0F11', text: '#B4B4BD', grid: '#1A1A1E', border: '#1F1F23', up: '#10B981', down: '#EF4444' };
    function chartTheme() {
        const root = document.documentElement;
        return root && root.getAttribute('data-theme') === 'light' ? CHART_LIGHT : CHART_DARK;
    }

    function toast(msg) { if (window.showToast) window.showToast(msg); }

    async function api(url, options) {
        const res = await apiFetch(url, options);
        if (!res.ok) {
            let msg = 'HTTP ' + res.status;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
            throw new Error(msg);
        }
        return res.json();
    }

    function priceFmt(p) {
        if (p == null) return '—';
        const prec = p < 1 ? 6 : p < 100 ? 3 : p < 1000 ? 2 : 1;
        return p.toLocaleString('en-US', { minimumFractionDigits: prec, maximumFractionDigits: prec });
    }
    function seatKey(id) { return '31trades.battle.seat.' + id; }
    function mySeatFor(id) { try { return localStorage.getItem(seatKey(id)); } catch (e) { return null; } }

    // ---- loading ----
    async function loadBattles() {
        try {
            const r = await api('/api/battles');
            battles = r.battles || [];
            renderBattleSelect();
            if (!battle) {
                const pick = battles.find(b => b.status !== 'completed') || battles[battles.length - 1];
                if (pick) await loadBattle(pick.id);
            }
        } catch (e) { toast('Could not load battles: ' + e.message); }
    }

    async function loadBattle(id) {
        stopPoll();
        stopWs();
        playing = false;
        try {
            const r = await api('/api/battles/' + id);
            battle = r.state;
            const saved = mySeatFor(id);
            if (saved) await loadSeat(saved); else { seat = null; seatState = null; }
            renderAll();
            connectWs();
        } catch (e) { toast('Could not load battle: ' + e.message); }
    }

    async function loadSeat(seatId) {
        try {
            const r = await api('/api/battles/' + battle.id + '/seat?seat=' + encodeURIComponent(seatId));
            seatState = r.state;
            if (!seat) {
                seat = seatId;
                try { localStorage.setItem(seatKey(battle.id), seatId); } catch (e) {}
            }
        } catch (e) { seatState = null; }
    }

    // ---- render ----
    function renderBattleSelect() {
        const sel = $('bl-select');
        if (!sel) return;
        let html = '<option value="" disabled>' + (battles.length ? 'Switch battle…' : 'No battles yet') + '</option>';
        battles.forEach(b => {
            html += '<option value="' + b.id + '"' + (battle && b.id === battle.id ? ' selected' : '') + '>' + b.title + ' · ' + b.symbol + ' ' + b.timeframe + ' · ' + b.status + ' · ' + b.taken + '/' + b.seats + '</option>';
        });
        sel.innerHTML = html;
    }

    function renderMeta() {
        const el = $('bl-meta');
        if (!el) return;
        if (!battle) { el.innerHTML = '<span class="text-[#6E6E78]">No battle yet — host one to start.</span>'; return; }
        el.innerHTML =
            '<div class="flex items-center gap-2">' +
            '<span class="status-badge" style="background:' + (battle.status === 'completed' ? 'rgba(245,158,11,0.12);color:#FBBF24' : battle.status === 'running' ? 'rgba(16,185,129,0.12);color:#34D399' : 'rgba(99,102,241,0.12);color:#818CF8') + '">' + battle.status + '</span>' +
            '<span class="status-badge" style="background:rgba(255,255,255,0.06);color:#B4B4BD;">' + battle.symbol + ' · ' + battle.timeframe + '</span></div>' +
            '<div class="text-[#6E6E78]">' + battle.title + '</div>' +
            '<div class="text-[#6E6E78]">Seats <b class="text-white">' + battle.seats.filter(s => s.taken).length + '/' + battle.seats.length + '</b></div>' +
            '<div class="text-[#6E6E78]">Replay <b class="num text-white">' + (battle.cursor + 1) + ' / ' + battle.total + '</b></div>' +
            '<div class="text-[#6E6E78]">Risk <b class="num text-white">' + (battle.riskModel.basis === 'pct' ? battle.riskModel.perTrade + '%' : '$' + battle.riskModel.perTrade) + '</b> / trade</div>';
        const sb = $('bl-seat-badge');
        if (sb) sb.textContent = seat ? 'Your seat: ' + seat : 'Observer';
    }

    function renderSeats() {
        const list = $('bl-seats');
        if (!list) return;
        if (!battle) { list.innerHTML = ''; return; }
        list.innerHTML = battle.seats.map(s => {
            const mine = s.id === seat;
            const badge = s.taken
                ? '<span class="status-badge" style="background:' + (mine ? 'rgba(16,185,129,0.14);color:#34D399' : 'rgba(255,255,255,0.06);color:#B4B4BD') + '">' + (mine ? 'You' : 'Taken') + '</span>'
                : '<button class="btn-ghost !py-1 !px-2.5 !text-[11px]" data-join="' + s.id + '"><svg data-lucide="log-in" class="w-3 h-3"></svg> Join</button>';
            return '<div class="seat-row">' +
                '<span class="num text-[11px] font-bold text-white">' + s.name + '</span>' +
                (s.team ? '<span class="status-badge" style="background:rgba(99,102,241,0.12);color:#818CF8;">' + s.team + '</span>' : '') +
                '<span class="flex-1"></span>' + badge + '</div>';
        }).join('');
        list.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', async () => {
            try {
                const r = await api('/api/battles/' + battle.id + '/join', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Trader ' + b.dataset.join })
                });
                seat = r.seat;
                try { localStorage.setItem(seatKey(battle.id), seat); } catch (e) {}
                toast('Joined as ' + b.dataset.join);
                await loadBattle(battle.id);
            } catch (e) { toast('Join failed: ' + e.message); }
        }));
        const hint = $('bl-hint');
        if (hint) {
            hint.textContent = battle.status === 'lobby'
                ? 'Battle is in the lobby — the host starts the replay when everyone is seated. Join a free seat to trade.'
                : battle.status === 'running'
                    ? 'Replay is live. Your ticket trades the current bar only; everyone sees the same candles. Decisions stay private.'
                    : "Battle over — the leaderboard reveals every seat's trades.";
        }
        if (window.lucide) lucide.createIcons();
    }

    function buildChart() {
        const el = $('bl-chart');
        if (!el || chart) return;
        const t = chartTheme();
        chart = LightweightCharts.createChart(el, {
            height: 440,
            layout: { background: { type: 'solid', color: t.bg }, textColor: t.text, fontFamily: "'JetBrains Mono', monospace" },
            grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
            rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
            timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
            crosshair: { mode: 0 }
        });
        candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
            upColor: t.up, downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up, wickDownColor: t.down
        });
        volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
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
    }

    function renderChart() {
        buildChart();
        if (!chart) return;
        const st = seatState;
        const candles = (st && st.candles) || (battle && battle.candle ? [battle.candle] : []);
        if (!candles.length) return;
        candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
        volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? chartTheme().up : chartTheme().down })));
        posLines.forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
        posLines = [];
        const p = st && st.position;
        if (p && candles.length) {
            const add = (price, color, dash) => {
                if (!(price > 0)) return;
                try {
                    const s = chart.addSeries(LightweightCharts.LineSeries, { color, lineWidth: 1, lineStyle: dash ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
                    s.setData(candles.map(c => ({ time: c.time, value: price })));
                    posLines.push(s);
                } catch (e) {}
            };
            add(p.entry, p.direction === 'Long' ? chartTheme().up : chartTheme().down, false);
            add(p.sl, '#F87171', true);
            if (p.tp) add(p.tp, '#34D399', true);
        }
        const tEl = $('bl-title'), sEl = $('bl-sub');
        if (tEl) tEl.textContent = battle ? battle.title : '—';
        if (sEl) sEl.textContent = battle ? battle.symbol + ' · ' + battle.timeframe + ' · shared timeline · cursor ' + (battle.cursor + 1) + ' / ' + battle.total : '—';
        const last = candles[candles.length - 1];
        const leg = $('bl-legend');
        if (leg && last) {
            leg.innerHTML =
                '<span class="legend-item num">O <b>' + priceFmt(last.open) + '</b></span>' +
                '<span class="legend-item num">H <b>' + priceFmt(last.high) + '</b></span>' +
                '<span class="legend-item num">L <b>' + priceFmt(last.low) + '</b></span>' +
                '<span class="legend-item num">C <b>' + priceFmt(last.close) + '</b></span>';
        }
        const pp = $('bl-pos-text');
        if (pp) pp.textContent = (battle ? battle.cursor + 1 : 0) + ' / ' + (battle ? battle.total : 0);
        const scr = $('bl-scrub');
        if (scr) { scr.max = Math.max(1, (battle ? battle.total : 1) - 1); scr.value = battle ? battle.cursor : 0; }
    }

    function renderPositionBanner() {
        const el = $('bl-pos');
        if (!el) return;
        const p = seatState && seatState.position;
        if (!p) { el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        el.classList.toggle('short', p.direction === 'Short');
        const uCol = p.unrealized >= 0 ? '#34D399' : '#F87171';
        el.innerHTML =
            '<span class="status-badge" style="background:' + (p.direction === 'Long' ? 'rgba(16,185,129,0.14);color:#34D399' : 'rgba(239,68,68,0.14);color:#F87171') + '">' + (p.direction === 'Long' ? '▲ LONG' : '▼ SHORT') + '</span>' +
            '<div class="pos-field"><div class="k">Entry</div><div class="v num">' + priceFmt(p.entry) + '</div></div>' +
            '<div class="pos-field"><div class="k">SL</div><div class="v num text-[#F87171]">' + priceFmt(p.sl) + '</div></div>' +
            '<div class="pos-field"><div class="k">TP</div><div class="v num text-[#34D399]">' + (p.tp ? priceFmt(p.tp) : '—') + '</div></div>' +
            '<div class="pos-field"><div class="k">Risk</div><div class="v num">$' + Number(p.riskAmount).toLocaleString() + '</div></div>' +
            '<div class="pos-field"><div class="k">Unrealized</div><div class="v num" style="color:' + uCol + '">' + (p.unrealized >= 0 ? '+' : '') + '$' + Math.round(p.unrealized).toLocaleString() + ' · ' + (p.unrealizedR >= 0 ? '+' : '') + p.unrealizedR.toFixed(2) + 'R</div></div>' +
            '<button class="btn-ghost !py-1.5 !px-3 !text-[12px] ml-auto" id="bl-close-btn"><svg data-lucide="log-out" class="w-3.5 h-3.5"></svg> Close at market</button>';
        const cb = $('bl-close-btn');
        if (cb) cb.addEventListener('click', closePosition);
        if (window.lucide) lucide.createIcons();
    }

    function renderTicket() {
        const box = $('bl-ticket');
        if (!box) return;
        if (!battle) { box.innerHTML = '<p class="text-[12px] text-[#6E6E78]">Host a battle first.</p>'; return; }
        if (!seat) {
            box.innerHTML = '<p class="text-[12px] text-[#6E6E78]">Join a seat above to place orders. Your trades stay private until the battle ends.</p>';
            return;
        }
        const pos = seatState && seatState.position;
        if (battle.status === 'completed') {
            box.innerHTML = '<p class="text-[12px] text-[#34D399]">Battle over — your trades are on the leaderboard.</p>';
            return;
        }
        box.innerHTML =
            '<div class="flex gap-2 mb-3">' +
            '<button class="dir-btn long active" id="bl-dir-long"><svg data-lucide="trending-up" class="w-4 h-4"></svg> Long</button>' +
            '<button class="dir-btn short" id="bl-dir-short"><svg data-lucide="trending-down" class="w-4 h-4"></svg> Short</button></div>' +
            '<div class="grid grid-cols-2 gap-3 mb-3">' +
            '<div><div class="ticket-label">Entry</div><input type="number" step="any" id="bl-t-entry" class="ticket-input" placeholder="current bar"></div>' +
            '<div><div class="ticket-label">Stop loss</div><input type="number" step="any" id="bl-t-sl" class="ticket-input" placeholder="required"></div>' +
            '<div><div class="ticket-label">Take profit</div><input type="number" step="any" id="bl-t-tp" class="ticket-input" placeholder="optional"></div>' +
            '<div><div class="ticket-label">Risk $</div><input type="number" step="any" id="bl-t-risk" class="ticket-input" value="' + (battle.riskModel.perTrade || 25) + '"></div>' +
            '<div class="col-span-2"><div class="ticket-label">Setup tag</div><input type="text" id="bl-t-setup" class="ticket-input !font-[inherit]" placeholder="e.g. Liquidity sweep"></div>' +
            '</div>' +
            (pos
                ? '<button class="btn-ghost w-full justify-center" id="bl-enter-btn" disabled>Position open — SL/TP will fill on the shared replay</button>'
                : '<button class="btn-primary w-full justify-center" id="bl-enter-btn"><svg data-lucide="log-in" class="w-4 h-4"></svg> Enter ' + (currentDir === 'long' ? 'LONG' : 'SHORT') + '</button>') +
            '<p class="text-[11px] text-[#55555E] mt-2 leading-relaxed">Entry must be within the current bar — the server enforces it. Your decisions are invisible to other seats until the end.</p>';
        const de = $('bl-dir-long'), ds = $('bl-dir-short');
        if (de) de.addEventListener('click', () => { currentDir = 'long'; de.classList.add('active'); ds.classList.remove('active'); const eb = $('bl-enter-btn'); if (eb) eb.innerHTML = '<svg data-lucide="log-in" class="w-4 h-4"></svg> Enter LONG'; if (window.lucide) lucide.createIcons(); });
        if (ds) ds.addEventListener('click', () => { currentDir = 'short'; ds.classList.add('active'); de.classList.remove('active'); const eb = $('bl-enter-btn'); if (eb) eb.innerHTML = '<svg data-lucide="log-in" class="w-4 h-4"></svg> Enter SHORT'; if (window.lucide) lucide.createIcons(); });
        const eb = $('bl-enter-btn');
        if (eb && !pos) eb.addEventListener('click', enterPosition);
        const cur = battle.candle;
        const entryEl = $('bl-t-entry');
        if (cur && entryEl && (!entryEl.value || entryEl.dataset.sym !== battle.symbol)) {
            entryEl.value = priceFmt(cur.close);
            entryEl.dataset.sym = battle.symbol;
        }
    }

    async function enterPosition() {
        const body = {
            seat,
            direction: currentDir,
            entry: $('bl-t-entry').value ? parseFloat($('bl-t-entry').value) : undefined,
            sl: parseFloat($('bl-t-sl').value),
            tp: $('bl-t-tp').value ? parseFloat($('bl-t-tp').value) : undefined,
            riskAmount: parseFloat($('bl-t-risk').value) || undefined,
            setup: $('bl-t-setup').value.trim()
        };
        try {
            const r = await api('/api/battles/' + battle.id + '/enter', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            seatState = r.state;
            const last = r.state.trades && r.state.trades[r.state.trades.length - 1];
            if (r.position) {
                toast('Entered ' + (currentDir === 'long' ? 'LONG' : 'SHORT') + ' @ ' + priceFmt(r.position.entry));
            } else if (last) {
                toast('Filled instantly ' + (last.pnl >= 0 ? '+' : '') + '$' + Math.round(Math.abs(last.pnl)).toLocaleString() + ' (' + last.exitReason + ')');
            } else {
                toast('Order placed');
            }
            renderAll();
        } catch (e) { toast('Entry rejected: ' + e.message); }
    }

    async function closePosition() {
        try {
            const r = await api('/api/battles/' + battle.id + '/close', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seat, reason: 'manual' })
            });
            seatState = r.state;
            toast('Closed @ ' + priceFmt(r.trade.exit) + ' · ' + (r.trade.pnl >= 0 ? '+' : '') + '$' + Math.round(r.trade.pnl).toLocaleString());
            renderAll();
        } catch (e) { toast('Close failed: ' + e.message); }
    }

    function renderLeaderboard() {
        const lb = battle && battle.leaderboard;
        const note = $('bl-note');
        const lbEl = $('bl-lb'), teamEl = $('bl-team');
        if (!note || !lbEl || !teamEl) return;
        if (!lb) {
            note.textContent = 'Available once the battle ends';
            lbEl.innerHTML = ''; teamEl.innerHTML = '';
            return;
        }
        note.textContent = "Revealed after the battle — every seat's trades shown";
        lbEl.innerHTML = lb.seats.map((r, i) =>
            '<div class="seat-row">' +
            '<span class="num text-[12px] font-bold ' + (i === 0 ? 'text-[#FBBF24]' : 'text-[#6E6E78]') + '">#' + (i + 1) + '</span>' +
            '<span class="num text-[12px] font-bold text-white">' + r.name + '</span>' +
            (r.team ? '<span class="status-badge" style="background:rgba(99,102,241,0.12);color:#818CF8;">' + r.team + '</span>' : '') +
            '<span class="flex-1"></span>' +
            '<span class="num text-[11px] text-[#6E6E78]">' + r.detail.trades + 'T</span>' +
            '<span class="num text-[11px] text-[#6E6E78]">' + (r.detail.winRate || 0) + '%</span>' +
            '<span class="num text-[11px] text-[#6E6E78]">' + ((r.detail.avgR || 0) >= 0 ? '+' : '') + (r.detail.avgR || 0) + 'R</span>' +
            '<span class="num text-[11px] text-[#6E6E78]">DD $' + Math.round(r.detail.maxDD || 0) + '</span>' +
            '<span class="num text-[13px] font-bold" style="color:' + (r.score >= 600 ? '#34D399' : r.score >= 400 ? '#FBBF24' : '#F87171') + '">' + r.score + '</span>' +
            '</div>'
        ).join('');
        const teams = lb.byTeam;
        teamEl.innerHTML = teams.length
            ? '<div class="mt-3 pt-3 border-t border-[#17171A]"><div class="text-[12px] font-bold text-white mb-2">Teams</div>' + teams.map((t, i) =>
                '<div class="seat-row"><span class="num text-[12px] font-bold text-white">' + t.team + '</span>' +
                '<span class="flex-1"></span>' +
                '<span class="num text-[11px] text-[#6E6E78]">' + t.members + ' seats · ' + t.trades + 'T</span>' +
                '<span class="num text-[13px] font-bold" style="color:' + (i === 0 ? '#34D399' : '#F87171') + '">' + t.score + '</span></div>').join('') + '</div>'
            : '';
    }

    function renderAll() {
        renderBattleSelect();
        renderMeta();
        renderSeats();
        renderChart();
        renderPositionBanner();
        renderTicket();
        renderLeaderboard();
    }

    // ---- replay updates: WebSocket pushes (fallback: slow poll) ----
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function connectWs() {
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
        try {
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            let uid = '';
            try { const s = window.TradeMindAuth && window.TradeMindAuth.getSession(); if (s && s.user) uid = s.user.id || s.user.email || ''; } catch (e) {}
            ws = new WebSocket(proto + '://' + location.host + '/ws?battle=' + encodeURIComponent(battle.id) + '&user=' + encodeURIComponent(uid));
        } catch (e) { ws = null; return; }
        ws.onopen = () => {};
        ws.onmessage = async (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.type === 'battle.cursor') {
                if (battle && m.battle === battle.id && m.cursor != null) {
                    battle.cursor = m.cursor; battle.status = m.status;
                    if (seat) await loadSeat(seat);
                    renderChart(); renderMeta(); renderSeats(); renderPositionBanner(); renderTicket(); renderLeaderboard();
                    if (battle.status === 'completed') { stopPoll(); playing = false; updatePlayIco(); }
                }
            } else if (m.type === 'battle.status') {
                if (battle && m.battle === battle.id && m.state) {
                    battle = m.state;
                    if (seat) await loadSeat(seat);
                    renderAll();
                    if (battle.status === 'completed') { stopPoll(); playing = false; updatePlayIco(); }
                }
            }
        };
        ws.onclose = () => { ws = null; };
        ws.onerror = () => { try { ws.close(); } catch (e) {} };
        wsTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 20000);
    }
    function stopWs() {
        if (wsTimer) { clearInterval(wsTimer); wsTimer = null; }
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    }
    function updatePlayIco() {
        const ico = $('bl-play-ico');
        if (ico) { ico.setAttribute('data-lucide', playing ? 'pause' : 'play'); if (window.lucide) lucide.createIcons(); }
    }
    function startPoll() {
        stopPoll();
        playing = true;
        updatePlayIco();
        connectWs();
        pollTimer = setInterval(async () => {
            try {
                const r = await api('/api/battles/' + battle.id);
                battle = r.state;
                if (seat) await loadSeat(seat);
                renderChart(); renderMeta(); renderSeats(); renderPositionBanner(); renderTicket(); renderLeaderboard();
                if (battle.status === 'completed') { stopPoll(); playing = false; updatePlayIco(); }
            } catch (e) {}
        }, 3000);
    }
    async function hostControl(action, extra) {
        try {
            await api('/api/battles/' + battle.id + '/control', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action }, extra || {}))
            });
            const r = await api('/api/battles/' + battle.id);
            battle = r.state;
            if (seat) await loadSeat(seat);
            renderAll();
        } catch (e) { toast(e.message); }
    }

    // ---- modal ----
    let modalTF = '1h';
    function openModal() {
        $('bl-modal').classList.remove('hidden');
        buildModalSymbols();
        if (window.lucide) lucide.createIcons();
    }
    function buildModalSymbols() {
        const sel = $('bl-m-symbol');
        if (!sel) return;
        if (!window.TMAssets || !window.TMAssets.SYMBOLS || sel.options.length) return;
        let html = '';
        window.TMAssets.CATEGORIES.forEach(cat => {
            const syms = window.TMAssets.SYMBOLS.filter(s => s.cat === cat);
            if (!syms.length) return;
            html += '<optgroup label="' + cat + '">' + syms.map(s => '<option value="' + s.sym + '">' + s.sym + ' — ' + s.name + '</option>').join('') + '</optgroup>';
        });
        sel.innerHTML = html;
    }
    async function createBattle() {
        const lines = $('bl-m-seats').value.split('\n').map(s => s.trim()).filter(Boolean);
        const seats = lines.map(l => { const [name, team] = l.split(':'); return { name: name.trim() || 'Trader', team: team ? team.trim() : null }; });
        const body = {
            title: $('bl-m-title').value.trim() || 'Battle',
            symbol: $('bl-m-symbol').value,
            timeframe: modalTF,
            window: Number($('bl-m-window').value),
            startingBalance: Number($('bl-m-balance').value) || 10000,
            riskModel: { basis: $('bl-m-basis').value, perTrade: Number($('bl-m-pertrade').value) || 25 },
            seats: seats.map(s => s.name),
            teams: seats.map(s => s.team)
        };
        const btn = $('bl-m-create');
        btn.disabled = true; btn.style.opacity = 0.5;
        try {
            const r = await api('/api/battles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            $('bl-modal').classList.add('hidden');
            seat = r.hostSeat;
            try { localStorage.setItem(seatKey(r.battle), seat); } catch (e) {}
            toast('Battle hosted — ' + body.title);
            await loadBattles();
            await loadBattle(r.battle);
        } catch (e) { toast('Create failed: ' + e.message); }
        finally { btn.disabled = false; btn.style.opacity = 1; }
    }

    // ---- invites ----
    async function openInviteModal() {
        if (!battle) { toast('Select a battle first'); return; }
        const t = $('bl-inv-title');
        if (t) t.textContent = battle.title + ' · ' + battle.symbol + ' ' + battle.timeframe;
        const em = $('bl-inv-emails');
        if (em) em.value = '';
        $('bl-inv-modal').classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
        try {
            const r = await api('/api/battles/' + battle.id + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const link = $('bl-inv-link');
            if (link) link.value = r.link;
            const mt = $('bl-inv-mailto');
            if (mt) mt.href = r.mailto;
        } catch (e) { toast('Invite failed: ' + e.message); }
    }
    async function sendInvites() {
        const emails = $('bl-inv-emails').value.split(/[,\s]+/).map(e => e.trim()).filter(Boolean);
        try {
            const r = await api('/api/battles/' + battle.id + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails }) });
            const link = $('bl-inv-link');
            if (link) link.value = r.link;
            const mt = $('bl-inv-mailto');
            if (mt) mt.href = r.mailto;
            toast(emails.length ? 'Invites sent — link ready to share' : 'Link ready — share it with your squad');
            if (emails.length) $('bl-inv-emails').value = '';
        } catch (e) { toast('Invite failed: ' + e.message); }
    }
    function copyInviteLink() {
        const v = $('bl-inv-link').value;
        if (!v) return;
        (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(
            () => toast('Invite link copied'),
            () => { const t = document.createElement('textarea'); t.value = v; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast('Invite link copied'); } catch (e) {} document.body.removeChild(t); }
        );
    }

    // join-by-link landing: ?invite=CODE resolves the battle and offers a seat
    async function resolveInviteParam() {
        const code = new URLSearchParams(location.search).get('invite');
        if (!code) return;
        let waited = 0;
        while (!battle && waited < 5000) { await new Promise(r => setTimeout(r, 150)); waited += 150; }
        if (!battle) return;
        try {
            const r = await api('/api/battles/invite/' + encodeURIComponent(code));
            if (r.state && r.state.id !== battle.id) await loadBattle(r.state.id);
            toast('Invite found — ' + (r.state.title || 'join the battle'));
            history.replaceState(null, '', location.pathname + '?mode=battle');
        } catch (e) { toast('Invite unavailable: ' + e.message); }
    }

    // ---- boot / destroy ----
    function boot() {
        if (booted) return;
        booted = true;
        const collapse = $('collapse-btn');
        if (collapse) collapse.addEventListener('click', () => document.body.classList.toggle('collapsed'));
        const b = $('bl-new');
        if (b) b.addEventListener('click', openModal);
        const inv = $('bl-invite-btn');
        if (inv) inv.addEventListener('click', openInviteModal);
        const ic = $('bl-inv-close');
        if (ic) ic.addEventListener('click', () => $('bl-inv-modal').classList.add('hidden'));
        const im = $('bl-inv-modal');
        if (im) im.addEventListener('click', e => { if (e.target === im) im.classList.add('hidden'); });
        const iCopy = $('bl-inv-copy');
        if (iCopy) iCopy.addEventListener('click', copyInviteLink);
        const iSend = $('bl-inv-send');
        if (iSend) iSend.addEventListener('click', sendInvites);
        const mc = $('bl-modal-close');
        if (mc) mc.addEventListener('click', () => $('bl-modal').classList.add('hidden'));
        const bm = $('bl-modal');
        if (bm) bm.addEventListener('click', e => { if (e.target === bm) bm.classList.add('hidden'); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { const m = $('bl-modal'); if (m) m.classList.add('hidden'); } });
        const mtf = $('bl-m-tf');
        if (mtf) mtf.querySelectorAll('.tf-btn').forEach(btn => btn.addEventListener('click', () => {
            mtf.querySelectorAll('.tf-btn').forEach(x => x.classList.remove('active'));
            btn.classList.add('active'); modalTF = btn.dataset.tf;
        }));
        const mCreate = $('bl-m-create');
        if (mCreate) mCreate.addEventListener('click', createBattle);
        const sel = $('bl-select');
        if (sel) sel.addEventListener('change', e => { if (e.target.value) loadBattle(e.target.value); });

        const play = $('bl-play');
        if (play) play.addEventListener('click', () => {
            if (playing) { hostControl('pause'); stopPoll(); playing = false; updatePlayIco(); }
            else { hostControl('play', { speedMs }).then(() => startPoll()); }
        });
        const step = $('bl-step');
        if (step) step.addEventListener('click', () => hostControl('step'));
        const reset = $('bl-reset');
        if (reset) reset.addEventListener('click', () => hostControl('reset'));
        const end = $('bl-end');
        if (end) end.addEventListener('click', async () => {
            try {
                await api('/api/battles/' + battle.id + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'complete' }) });
                const r = await api('/api/battles/' + battle.id);
                battle = r.state;
                if (seat) await loadSeat(seat);
                renderAll();
                toast('Battle ended — leaderboard revealed');
            } catch (e) { toast(e.message); }
        });
        const speedBar = $('bl-speed');
        if (speedBar) speedBar.querySelectorAll('.speed-btn').forEach(btn => btn.addEventListener('click', () => {
            speedBar.querySelectorAll('.speed-btn').forEach(x => x.classList.remove('active'));
            btn.classList.add('active'); speedMs = Number(btn.dataset.ms);
        }));
        const scr = $('bl-scrub');
        if (scr) scr.addEventListener('input', async () => {
            stopPoll(); playing = false; updatePlayIco();
            try { await hostControl('seek', { cursor: Number(scr.value) }); } catch (e) {}
        });

        if (window.lucide) lucide.createIcons();
        loadBattles();
        resolveInviteParam();
        // deep link: backtesting.html?mode=battle&battle=ID (old full-page links)
        const bid = new URLSearchParams(location.search).get('battle');
        if (bid) loadBattle(bid);
    }

    function destroy() {
        booted = false;
        stopPoll();
        stopWs();
        playing = false;
        if (chart) { try { chart.remove(); } catch (e) {} chart = null; candleSeries = null; volumeSeries = null; posLines = []; }
        const el = $('bl-chart');
        if (el) el.innerHTML = '';
        battle = null; seat = null; seatState = null;
    }

    document.addEventListener('tm:theme', () => applyChartTheme());

    window.BattleMode = { boot, destroy };
})();
