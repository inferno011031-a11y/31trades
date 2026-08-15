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
