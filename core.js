/* ============================================================================
   31TRADES — Core: browser shell
   ----------------------------------------------------------------------------
   Thin bootstrap for the SHARED core package (src/core/index.js), which holds
   the canonical data model, event bus and all calculation services with ZERO
   DOM/localStorage dependencies.

   This shell provides the browser-only concerns:
     · a localStorage repository (persistence seam for the shared core) —
       keyed PER USER (31trades.state.v1.<userId>) so two accounts on one
       machine never share data
     · a Supabase Auth session (31trades.session.v1) with sign-up/login wired
       in auth.html; every backend call carries the Bearer token
     · an optional backend mirror (connectBackend / syncToBackend)
     · boot: no session → auth.html (or, on auth.html, wait for sign-up);
       with a session → hydrate the user's localStorage or start at the
       first-user state, then publish 'state.hydrated' / 'config.changed'.

   The core boots lazily via window.TradeMindBoot(): auth.html loads these
   scripts, stays core-less while the visitor is anonymous, and calls
   TradeMindBoot() after sign-up saves the session so the onboarding wizard
   can provision the first account/strategy through the SAME session-scoped
   core every other page uses (mutations replay to the API / get adopted on
   the next page load).

   Pages must load demo-trades.js and src/core/index.js BEFORE core.js:

       <script src="demo-trades.js"></script>
       <script src="src/core/index.js"></script>
       <script src="core.js"></script>
   ========================================================================== */
(function () {
    'use strict';

    if (typeof window.createTradeMindCore !== 'function') {
        console.error('[31trades] src/core/index.js must load before core.js — pages are broken');
        return;
    }

    // ---- session: the signed-in Supabase user (set by auth.html) ----
    const SESSION_KEY = '31trades.session.v1';
    function getSession() {
        try {
            const raw = window.localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function setSession(session) {
        try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
    }
    function clearSession() {
        try { window.localStorage.removeItem(SESSION_KEY); } catch (e) {}
    }

    // Tests (Node) inject a bypass to exercise the shell without a real login.
    // A sessionStorage flag ('1') does the same and survives same-tab navigation
    // — handy for local previews without a Supabase account.
    const BYPASS = (typeof window.__TRADEMIND_AUTH_BYPASS__ === 'boolean' && window.__TRADEMIND_AUTH_BYPASS__) ||
        (typeof window.sessionStorage !== 'undefined' && window.sessionStorage.getItem('31trades.auth.bypass') === '1');

    // ---- module-level state owned by the booted core ----
    let core = null;
    let backendOnline = false;
    let _syncChain = Promise.resolve();

    function currentSession() {
        return BYPASS ? null : getSession();
    }

    // ---- backend mirror — ON by default. When the API is reachable, the
    // browser adopts it with a full-state push (local store stays the
    // authoritative offline cache), then every mutation replays to the API in
    // order. Reconnecting after an outage re-adopts, reconciling anything
    // logged while offline. Status is broadcast as 'backend.online' /
    // 'backend.offline' on the bus (the topbar indicator listens).
    // Same-origin in the browser; tests may override via window.__TRADEMIND_API_ROOT__.
    const API_ROOT = (typeof window.__TRADEMIND_API_ROOT__ === 'string' && window.__TRADEMIND_API_ROOT__) || '';

    function authHeaders(extra) {
        const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
        const session = currentSession();
        if (session && session.token && !BYPASS) h.Authorization = 'Bearer ' + session.token;
        return h;
    }

    function sessionExpired() {
        clearSession();
        if (!BYPASS) window.location.replace('auth.html');
    }

    function syncToBackend(path, body, method) {
        if (!backendOnline) return;
        _syncChain = _syncChain
            .then(() => fetch(API_ROOT + path, {
                method: method || 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body || {})
            }))
            .then(r => {
                if (r.status === 401 && currentSession()) sessionExpired();
                if (!r.ok) throw new Error(path + ' → HTTP ' + r.status);
            })
            .catch(err => console.warn('[31trades] backend sync failed: ' + err.message));
    }

    // Push the full canonical state so the server adopts the local store.
    // Resolves to true when the server accepted it.
    function adoptState() {
        return fetch(API_ROOT + '/api/state', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(core.serializeState())
        })
            .then(r => {
                if (r.status === 401 && currentSession()) sessionExpired();
                if (!r.ok) throw new Error('adopt → HTTP ' + r.status);
                console.log('[31trades] backend adopted local state (' + core.Trades.length + ' trades, ' + core.Accounts.length + ' accounts)');
                return true;
            })
            .catch(err => {
                console.warn('[31trades] backend adopt failed: ' + err.message);
                return false;
            });
    }

    function publishConnectivity() {
        core.TradeMindBus.publish(backendOnline ? 'backend.online' : 'backend.offline', { online: backendOnline });
    }

    async function connectBackend() {
        try {
            const r = await fetch(API_ROOT + '/api/health', { headers: { Accept: 'application/json' } });
            if (r.ok) {
                backendOnline = await adoptState();
                if (backendOnline) console.log('[31trades] backend online — mutations replay to the API');
            } else {
                backendOnline = false;
            }
        } catch (err) {
            backendOnline = false;
            console.warn('[31trades] backend offline — local-first mode (' + err.message + ')');
        }
        publishConnectivity();
        return backendOnline;
    }

    // ---- build + boot the session-scoped core. No session → null (auth.html
    // calls this after sign-up saves the session; other pages never get here
    // without one — they're redirected first). Idempotent: second call returns
    // the already-booted core.
    function bootCore() {
        if (core) return core;
        // BYPASS (tests) boots the anonymous partition without a session.
        const session = BYPASS ? { anonymous: true } : currentSession();
        if (!session) return null;

        // ---- persistence: localStorage adapter, keyed per user ----
        const userId = (!BYPASS && session.user && session.user.id) ? session.user.id : 'anon';
        const STORAGE_KEY = '31trades.state.v1' + (BYPASS ? '' : '.' + userId);

        const repo = window.localStorage ? {
            load() {
                try {
                    const raw = window.localStorage.getItem(STORAGE_KEY);
                    return raw ? JSON.parse(raw) : null;
                } catch (e) { console.warn('[31trades] storage read failed: ' + e.message); return null; }
            },
            save(state) {
                try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
                catch (e) { console.warn('[31trades] storage write failed: ' + e.message); return false; }
            },
            clear() { try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {} }
        } : null;

        core = window.createTradeMindCore({
            storage: repo,                 // per-user localStorage persistence
            sync: syncToBackend,           // backend mirror (no-op until connectBackend)
            connectBackend,                // exported back onto window.TradeMindCore
            demoTrades: window.DemoTrades  // deterministic demo generator
        });

        // ---- BOOT — local-first, no backend required.
        // The user's localStorage is the source of truth. First visit =
        // first-user state: zero trades, zero strategies, zero accounts.
        const saved = repo ? repo.load() : null;
        if (saved && saved.Accounts) {
            core.hydrate(saved);
            console.log('[31trades] local store hydrated — ' + core.Trades.length + ' trades, ' + core.Accounts.length + ' accounts');
        } else {
            core.reseed();
            console.log('[31trades] first user — starting with zero trades');
        }
        core.TradeMindBus.publish('state.hydrated', core.serializeState());
        core.TradeMindBus.publish('config.changed', { hydrated: true });

        window.TradeMindCore = core;
        Object.defineProperty(window.TradeMindCore, 'storageKey', { get: () => STORAGE_KEY });
        window.TradeMindCore.isBackendOnline = () => backendOnline;

        // ---- authed fetch for page-level API calls (notifications, settings,
        // backtesting, market replay…). Attaches the session Bearer token so
        // requests work when auth is ON (deployed), and redirects to auth.html
        // on 401 exactly like the core's own sync calls. When auth is off or
        // the core isn't booted it behaves as a plain fetch. ----
        window.TradeMindCore.apiFetch = (url, options) => {
            const opts = options || {};
            const headers = Object.assign({}, opts.headers || {});
            const sess = BYPASS ? null : getSession();
            if (sess && sess.token) headers.Authorization = 'Bearer ' + sess.token;
            if (opts.body && typeof opts.body !== 'string' && !headers['Content-Type']) {
                headers['Content-Type'] = 'application/json';
            }
            return fetch(API_ROOT + url, Object.assign({}, opts, { headers }))
                .then(r => {
                    if (r.status === 401 && !BYPASS && !/auth\.html/.test(window.location.pathname)) {
                        clearSession();
                        window.location.replace('auth.html');
                    }
                    return r;
                });
        };

        // ---- flip the backend mirror ON: adopt the local store when the API
        // is reachable, then replay mutations. Retry every 30s while offline.
        (function connectLoop() {
            connectBackend().then(ok => {
                if (!ok) setTimeout(connectLoop, 30000);
            });
        })();

        // ---- GLOBAL SEARCH / COMMAND CENTER ----
        // One reusable search surface for the whole app. Opens from the topbar
        // search (Enter), the Ctrl/⌘-K shortcut, or TMOpenSearch(). It searches
        // only the authenticated workspace — pages, canonical trades, strategies,
        // accounts, rule sets and rules. No fake entities, no backend calls, no
        // private or other-user data. Recent searches are a local convenience
        // (localStorage only, query strings only).
        const _GS_PAGES = [
            { name: 'Dashboard', href: 'dashboard.html', icon: 'layout-dashboard' },
            { name: 'Journal', href: 'journal.html', icon: 'book-open' },
            { name: 'Review', href: 'review.html', icon: 'clipboard-check' },
            { name: 'Improve', href: 'improve.html', icon: 'refresh-cw' },
            { name: 'Insights', href: 'insights.html', icon: 'sparkles' },
            { name: 'Analytics', href: 'analytics.html', icon: 'bar-chart-3' },
            { name: 'AI Mentor', href: 'ai.html', icon: 'brain-circuit' },
            { name: 'Backtesting', href: 'backtesting.html', icon: 'flask-conical' },
            { name: 'Strategy Lab', href: 'strategy-lab.html', icon: 'beaker' },
            { name: 'Market Replay', href: 'replay.html', icon: 'history' },
            { name: 'Battles', href: 'battles.html', icon: 'swords' },
            { name: 'Risk', href: 'risk.html', icon: 'shield-alert' },
            { name: 'Discipline', href: 'discipline.html', icon: 'target' },
            { name: 'Calendar', href: 'calendar.html', icon: 'calendar-days' },
            { name: 'Community', href: 'community.html', icon: 'users' },
            { name: 'Reports', href: 'reports.html', icon: 'file-text' },
            { name: 'Notifications', href: 'notifications.html', icon: 'bell' },
            { name: 'Settings', href: 'settings.html', icon: 'settings' },
            { name: 'Help', href: 'help.html', icon: 'help-circle' }
        ];
        const _GS_RECENT_KEY = '31trades.search.recent';
        const _gsEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const _gsMoney = n => (n == null || isNaN(n) ? '—' : (n > 0 ? '+' : '') + '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        const _gsDate = iso => { try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { return '—'; } };
        function _gsRecent() { try { return JSON.parse(localStorage.getItem(_GS_RECENT_KEY) || '[]'); } catch (e) { return []; } }
        function _gsPushRecent(q) {
            if (!q) return;
            try {
                const list = _gsRecent().filter(x => x.toLowerCase() !== q.toLowerCase());
                list.unshift(q);
                localStorage.setItem(_GS_RECENT_KEY, JSON.stringify(list.slice(0, 6)));
            } catch (e) { /* storage unavailable — skip */ }
        }
        // result priority: exact page/entity → prefix → partial (never dozens of hits)
        function _gsScore(text, q) {
            const t = String(text || '').toLowerCase();
            if (t === q) return 100;
            if (t.indexOf(q) === 0) return 70;
            const i = t.indexOf(q);
            if (i > 0) return Math.max(10, 40 - i * 2);
            return 0;
        }
        function _gsInjectStyle() {
            if (document.getElementById('tm-gs-style')) return;
            const st = document.createElement('style');
            st.id = 'tm-gs-style';
            st.textContent = '@keyframes tmGsIn{from{opacity:0;transform:translateY(8px) scale(0.985)}to{opacity:1;transform:none}}.tm-gs-row{display:flex;align-items:center;gap:11px;padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--hairline);transition:background 0.08s}.tm-gs-row:last-child{border-bottom:none}.tm-gs-row:hover,.tm-gs-row.sel{background:var(--tm-hover)}@media (max-width:700px){#tm-search-palette{padding:0!important;align-items:stretch!important}#tm-search-palette .tm-gs-panel{max-width:100%!important;max-height:100vh!important;border-radius:0!important;border:none!important}#tm-search-palette input{font-size:16px!important}}';
            document.head.appendChild(st);
        }
        function _gsOpen(seedQuery) {
            _gsInjectStyle();
            const old = document.getElementById('tm-search-palette');
            if (old) old.remove();
            const overlay = document.createElement('div');
            overlay.id = 'tm-search-palette';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(2,6,23,0.52);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:7vh 16px 16px;';
            const panel = document.createElement('div');
            panel.className = 'tm-gs-panel';
            panel.style.cssText = 'width:100%;max-width:640px;max-height:76vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;border:1px solid var(--glass-border-strong);background:var(--tm-card);box-shadow:0 30px 70px -18px rgba(0,0,0,0.55);animation:tmGsIn 0.13s ease;font-family:var(--tm-sans);color:var(--tm-text);';
            overlay.appendChild(panel);
            document.body.appendChild(overlay);

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Search Battlex…  (↑↓ navigate · Enter open · Esc close)';
            input.style.cssText = 'width:100%;background:transparent;border:none;outline:none;font-size:15px;padding:16px 18px;color:var(--tm-text);font-family:var(--tm-mono);letter-spacing:-0.01em;';
            const head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--tm-border);flex-shrink:0;';
            head.innerHTML = '<svg data-lucide="search" class="w-4 h-4 flex-shrink-0" style="margin-left:16px;color:var(--tm-dim)"></svg>';
            head.appendChild(input);
            const kbd = document.createElement('kbd');
            kbd.textContent = 'ESC';
            kbd.style.cssText = 'margin-right:14px;font-size:10px;font-weight:700;color:var(--tm-dim);border:1px solid var(--tm-border-2);border-radius:5px;padding:2px 6px;background:var(--tm-card-2);flex-shrink:0;';
            head.appendChild(kbd);
            panel.appendChild(head);

            const body = document.createElement('div');
            body.style.cssText = 'overflow-y:auto;min-height:120px;';
            panel.appendChild(body);

            let items = [];
            let sel = 0;

            function row(item, i) {
                return '<div class="tm-gs-row' + (i === sel ? ' sel' : '') + '" data-i="' + i + '" onmouseenter="this.classList.add(\'sel\')" onmouseleave="this.classList.remove(\'sel\')">' +
                    '<span class="flex-shrink-0" style="width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--glass-inner);border:1px solid var(--hairline)"><svg data-lucide="' + item.icon + '" class="w-4 h-4" style="color:var(--tm-muted)"></svg></span>' +
                    '<div class="flex-1 min-w-0">' +
                        '<div class="truncate" style="font-size:13.5px;font-weight:700">' + _gsEsc(item.title) + '</div>' +
                        (item.sub ? '<div class="truncate" style="font-size:11.5px;color:var(--tm-dim);margin-top:1px">' + _gsEsc(item.sub) + '</div>' : '') +
                    '</div>' +
                    '<span class="flex-shrink-0" style="font-size:9.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:3px 7px;border-radius:5px;background:var(--glass-inner);border:1px solid var(--hairline);color:var(--tm-muted)">' + item.type + '</span>' +
                '</div>';
            }
            function section(label) {
                return '<div style="padding:9px 14px 4px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--tm-muted)">' + _gsEsc(label) + '</div>';
            }

            function build(qRaw) {
                const q = String(qRaw || '').trim().toLowerCase();
                const rows = [];
                items = [];

                if (!q) {
                    // quick actions + recent searches (local convenience)
                    const recents = _gsRecent();
                    const qa = [
                        { title: 'Log trade', sub: 'Journal · record a decision', href: 'journal.html?log=1', icon: 'plus', type: 'Action' },
                        { title: 'Open Journal', sub: 'Every trade, one ledger', href: 'journal.html', icon: 'book-open', type: 'Action' },
                        { title: 'Open Risk', sub: 'How you protect capital', href: 'risk.html', icon: 'shield-alert', type: 'Action' },
                        { title: 'Open Discipline', sub: 'Did you follow your rules?', href: 'discipline.html', icon: 'target', type: 'Action' },
                        { title: 'Open AI Mentor', sub: 'Investigate your patterns', href: 'ai.html', icon: 'brain-circuit', type: 'Action' },
                        { title: 'Open Strategy Lab', sub: 'Define your system', href: 'strategy-lab.html', icon: 'beaker', type: 'Action' }
                    ];
                    if (recents.length) {
                        rows.push(section('Recent'));
                        recents.forEach(rq => {
                            items.push({ title: rq, type: 'Recent', icon: 'clock', action: () => _gsOpen(rq) });
                            rows.push(row(items[items.length - 1], items.length - 1));
                        });
                    }
                    rows.push(section('Quick actions'));
                    qa.forEach(a => {
                        items.push({ title: a.title, sub: a.sub, type: a.type, icon: a.icon, href: a.href });
                        rows.push(row(items[items.length - 1], items.length - 1));
                    });
                    body.innerHTML = rows.join('');
                    bind();
                    sel = 0; paint();
                    return;
                }

                // PAGES — always searchable, exact/prefix first
                const pageHits = _GS_PAGES.map(p => ({ p, s: _gsScore(p.name, q) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
                if (pageHits.length) {
                    rows.push(section('Pages'));
                    pageHits.forEach(h => {
                        items.push({ title: h.p.name, sub: 'Open ' + h.p.name, type: 'Page', icon: h.p.icon, href: h.p.href });
                        rows.push(row(items[items.length - 1], items.length - 1));
                    });
                }

                // TRADES + SYMBOLS
                const trades = (core.Trades || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
                const tradeHits = [];
                trades.forEach(t => {
                    const hay = (t.symbol || '') + ' ' + (t.setup || '') + ' ' + (t.strategy || '') + ' ' + (t.session || '') + ' ' + (t.dir || '') + ' ' + (t.emotion || '') + ' ' + (t.notes || '');
                    const s = _gsScore(hay, q);
                    if (s > 0) tradeHits.push({ t, s, symExact: (t.symbol || '').toLowerCase() === q });
                });
                tradeHits.sort((a, b) => (b.symExact - a.symExact) || (b.s - a.s));
                const shown = tradeHits.slice(0, 6);
                if (shown.length) {
                    rows.push(section('Trades'));
                    shown.forEach(h => {
                        const t = h.t;
                        items.push({
                            title: (t.symbol || '—') + ' · ' + (t.setup || '—'),
                            sub: (t.dir || '') + ' · ' + (t.session || '') + ' · ' + _gsDate(t.ts) + ' · ' + _gsMoney(t.pnl),
                            type: 'Trade', icon: 'line-chart',
                            href: 'journal.html?trade=' + encodeURIComponent(t.id),
                            recordQuery: true
                        });
                        rows.push(row(items[items.length - 1], items.length - 1));
                    });
                }

                // STRATEGIES
                const stratHits = (core.StrategyMaster || [])
                    .map(s => ({ s, score: Math.max(_gsScore(s.name, q), _gsScore(s.desc || '', q)) }))
                    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
                if (stratHits.length) {
                    rows.push(section('Strategies'));
                    stratHits.forEach(h => {
                        items.push({ title: h.s.name, sub: (h.s.status || '') + (h.s.desc ? ' · ' + h.s.desc : ''), type: 'Strategy', icon: 'beaker', href: 'strategy-lab.html?tab=strategies', recordQuery: true });
                        rows.push(row(items[items.length - 1], items.length - 1));
                    });
                }

                // ACCOUNTS
                const accHits = (core.Accounts || [])
                    .map(a => ({ a, s: _gsScore(a.name, q) }))
                    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
                if (accHits.length) {
                    rows.push(section('Accounts'));
                    accHits.forEach(h => {
                        const a = h.a;
                        items.push({
                            title: a.name,
                            sub: _gsMoney(a.current_equity != null ? a.current_equity : a.starting_balance || 0) + ' equity' + (a.currency ? ' · ' + a.currency : ''),
                            type: 'Account', icon: 'wallet', href: 'strategy-lab.html?tab=accounts',
                            selectAccount: a.id, recordQuery: true
                        });
                        rows.push(row(items[items.length - 1], items.length - 1));
                    });
                }

                // RULE SETS + RULES
                const rsHits = (core.RuleSetMaster || [])
                    .map(rs => ({ rs, s: _gsScore(rs.name, q) }))
                    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
                const seenRules = {};
                const ruleHits = [];
                (core.ConfigVersions || []).forEach(v => {
                    (v.rules || []).forEach(r => {
                        const lbl = r.label || r.key || '';
                        if (!lbl || seenRules[lbl]) return;
                        seenRules[lbl] = true;
                        const s = _gsScore(lbl, q);
                        if (s > 0) ruleHits.push({ lbl, s, cat: r.cat || '' });
                    });
                });
                ruleHits.sort((a, b) => b.s - a.s);
                if (rsHits.length || ruleHits.length) {
                    rows.push(section('Rule sets'));
                    rsHits.forEach(h => {
                        items.push({ title: h.rs.name, sub: (h.rs.scope || '') + ' scope', type: 'Rule set', icon: 'scroll-text', href: 'strategy-lab.html?tab=rulesets', recordQuery: true });
                        rows.push(row(items[items.length - 1], items.length - 1));
                    });
                    ruleHits.slice(0, 3).forEach(h => {
                        items.push({ title: h.lbl, sub: (h.cat || '') + ' rule', type: 'Rule', icon: 'scroll-text', href: 'strategy-lab.html?tab=rulesets', recordQuery: true });
                        rows.push(row(items[items.length - 1], items.length - 1));
                    });
                }

                if (!items.length) {
                    body.innerHTML = '<div style="padding:44px 20px;text-align:center">' +
                        '<svg data-lucide="search-x" class="w-8 h-8 mx-auto" style="color:var(--tm-dim)"></svg>' +
                        '<div style="font-size:15px;font-weight:800;margin-top:10px">No results</div>' +
                        '<div style="font-size:12.5px;color:var(--tm-dim);margin-top:4px">Try a page, symbol, strategy, or account.</div>' +
                    '</div>';
                } else {
                    body.innerHTML = rows.join('');
                }
                bind();
                sel = 0; paint();
            }

            function bind() {
                body.querySelectorAll('.tm-gs-row').forEach(el => {
                    el.addEventListener('click', () => go(Number(el.dataset.i)));
                });
                if (window.lucide) lucide.createIcons();
            }
            function paint() {
                body.querySelectorAll('.tm-gs-row').forEach((el, i) => el.classList.toggle('sel', i === sel));
            }
            function go(i) {
                const item = items[i];
                if (!item) return;
                if (item.recordQuery && input.value.trim()) _gsPushRecent(input.value.trim());
                if (item.selectAccount && core.setSelectedAccount) core.setSelectedAccount(item.selectAccount);
                if (item.href) { window.location.href = item.href; return; }
                if (item.action) { item.action(); return; }
                close();
            }
            function close() { try { document.body.removeChild(overlay); } catch (e) {} }

            input.addEventListener('input', () => build(input.value));
            input.addEventListener('keydown', e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); paint(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + Math.max(1, items.length)) % Math.max(1, items.length); paint(); }
                else if (e.key === 'Enter') { e.preventDefault(); if (items.length) go(sel); }
                else if (e.key === 'Escape') { e.preventDefault(); close(); }
            });
            overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
            document.addEventListener('keydown', function onEsc(e) {
                if (e.key === 'Escape' && document.getElementById('tm-search-palette')) { close(); document.removeEventListener('keydown', onEsc, true); }
            }, true);

            input.value = seedQuery || '';
            build(input.value);
            setTimeout(() => input.focus(), 20);
        }

        window.TMOpenSearch = function (seed) { _gsOpen(seed || ''); };
        window.TM_GLOBAL_SEARCH = function (query) { _gsOpen(String(query || '').trim()); };

        // Ctrl/⌘-K opens the command palette anywhere (seeded from the focused
        // topbar search if that is what the user was typing in).
        document.addEventListener('keydown', function (e) {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                let seed = '';
                try {
                    const gs = document.getElementById('global-search');
                    if (gs && document.activeElement === gs) seed = gs.value;
                } catch (e2) { /* noop */ }
                _gsOpen(seed);
            }
        });

        return core;
    }

    // ---- gate: without a session, non-auth pages go to auth.html. On
    // auth.html we stay and wait — the signup flow boots the core via
    // TradeMindBoot() once the session is saved. BYPASS (tests) always boots
    // the anonymous partition.
    const initialSession = currentSession();
    if (initialSession || BYPASS) {
        bootCore();
    } else if (!/auth\.html($|\?)/.test(window.location.pathname)) {
        window.location.replace('auth.html');
    }

    // session accessors for auth.html / sign-out buttons
    window.TradeMindAuth = { getSession, setSession, clearSession };
    // deferred boot for auth.html (and anything else that signs in later)
    window.TradeMindBoot = bootCore;
})();
