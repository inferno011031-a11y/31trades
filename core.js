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

        // ---- global search: one client-side search over the canonical data
        // (trades, symbols, accounts, strategies, rule sets, rules). Every page
        // renders a #global-search input; Enter opens a result panel and
        // navigates to the existing destination for each result type. No new
        // backend — this reads the same core data every page already uses.
        const _fm = n => (n == null || isNaN(n) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        const _fd = iso => { try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { return '—'; } };
        window.TM_GLOBAL_SEARCH = function (query) {
            const q = String(query || '').trim().toLowerCase();
            if (!q) return;
            const results = [];
            const push = (type, label, sub, href, extra) => results.push({ type, label, sub, href, extra });

            // trades + symbols
            (core.Trades || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts)).forEach(t => {
                const hay = [t.symbol, t.setup, t.strategy, t.session, t.emotion, t.notes].join(' ').toLowerCase();
                if (hay.indexOf(q) !== -1) {
                    const sym = t.symbol || '—';
                    push('Trade', sym + ' · ' + (t.setup || '—'), _fd(t.ts) + ' · ' + _fm(t.pnl), 'journal.html?trade=' + encodeURIComponent(t.id), { sym: sym.toLowerCase() });
                }
            });
            // accounts → select the account and open the dashboard
            (core.Accounts || []).forEach(a => {
                if ((a.name || '').toLowerCase().indexOf(q) !== -1) {
                    push('Account', a.name, _fm(a.current_equity != null ? a.current_equity : a.starting_balance || 0) + ' equity', null, { selectAccount: a.id });
                }
            });
            // strategies → Strategy Lab
            (core.StrategyMaster || []).forEach(s => {
                if (((s.name || '') + ' ' + (s.desc || '')).toLowerCase().indexOf(q) !== -1) {
                    push('Strategy', s.name, s.desc || '', 'strategy-lab.html?tab=strategies');
                }
            });
            // rule sets + individual rules → Strategy Lab rule sets
            (core.RuleSetMaster || []).forEach(rs => {
                if ((rs.name || '').toLowerCase().indexOf(q) !== -1) {
                    push('Rule set', rs.name, (rs.scope || '') + ' scope', 'strategy-lab.html?tab=rulesets');
                }
            });
            const seenRules = {};
            (core.ConfigVersions || []).forEach(v => {
                (v.rules || []).forEach(r => {
                    const lbl = r.label || r.key || '';
                    if (!lbl || seenRules[lbl]) return;
                    seenRules[lbl] = true;
                    if (lbl.toLowerCase().indexOf(q) !== -1) {
                        push('Rule', lbl, (r.cat || '') + ' · ' + (r.severity || ''), 'strategy-lab.html?tab=rulesets');
                    }
                });
            });

            // symbol shortcut: no direct trade hit, but a known symbol matches
            if (!results.length) {
                const syms = {};
                (core.Trades || []).forEach(t => { syms[(t.symbol || '').toLowerCase()] = t.symbol; });
                if (syms[q]) {
                    const hit = core.Trades.find(t => (t.symbol || '').toLowerCase() === q);
                    if (hit) push('Symbol', syms[q], 'Open the latest ' + syms[q] + ' trade in the Journal', 'journal.html?trade=' + encodeURIComponent(hit.id));
                }
            }

            if (!results.length) {
                window.showToast && window.showToast('No matches for "' + String(query).trim() + '"');
                return;
            }

            const input = document.getElementById('global-search');
            const r = input ? input.getBoundingClientRect() : null;
            const panel = document.createElement('div');
            panel.style.cssText = 'position:fixed;z-index:200;min-width:340px;max-width:440px;max-height:420px;overflow-y:auto;' +
                'background:var(--tm-card);border:1px solid var(--tm-border-2);border-radius:12px;box-shadow:0 18px 40px -14px rgba(0,0,0,0.45);' +
                'font-family:var(--tm-sans);font-size:13px;color:var(--tm-text);' +
                (r ? 'top:' + Math.round(r.bottom + 6) + 'px;left:' + Math.round(r.left) + 'px;' : 'top:70px;left:16px;');
            panel.innerHTML = '<div class="gs-head" style="padding:10px 14px;border-bottom:1px solid var(--tm-border);font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--tm-muted);display:flex;align-items:center;justify-content:space-between;">' +
                '<span>Search results</span><span style="font-weight:600;">' + results.length + '</span></div>' +
                '<div class="gs-list">' + results.slice(0, 14).map((res, i) => {
                    const tagColor = res.type === 'Trade' ? 'rgba(59,130,246,0.14);color:var(--tm-blue)' : res.type === 'Account' ? 'rgba(16,185,129,0.14);color:var(--tm-green)' : res.type === 'Strategy' || res.type === 'Rule set' ? 'rgba(99,102,241,0.14);color:var(--tm-accent-2)' : 'rgba(245,158,11,0.14);color:var(--tm-amber)';
                    return '<div class="gs-row" data-i="' + i + '" style="padding:9px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;transition:background 0.1s;border-bottom:1px solid var(--hairline);" onmouseenter="this.style.background=\'var(--tm-hover)\';" onmouseleave="this.style.background=\'transparent\';">' +
                        '<span style="flex-shrink:0;font-size:9.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:3px 7px;border-radius:5px;background:' + tagColor + '">' + res.type + '</span>' +
                        '<div style="flex:1;min-width:0;"><div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + String(res.label).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) + '</div>' +
                        '<div style="font-size:11px;color:var(--tm-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + String(res.sub || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) + '</div></div>' +
                    '</div>';
                }).join('') + '</div>';
            document.body.appendChild(panel);
            function go(res) {
                if (res.selectAccount && core.setSelectedAccount) core.setSelectedAccount(res.selectAccount);
                if (res.href) { window.location.href = res.href; return; }
                window.location.href = 'dashboard.html';
            }
            panel.querySelectorAll('.gs-row').forEach(row => {
                row.addEventListener('click', () => go(results[Number(row.dataset.i)]));
            });
            function close() { try { document.body.removeChild(panel); } catch (e) {} document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true); }
            function onDoc(e) { if (!panel.contains(e.target) && e.target !== input) close(); }
            function onKey(e) { if (e.key === 'Escape') close(); }
            document.addEventListener('click', onDoc, true);
            document.addEventListener('keydown', onKey, true);
        };

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
