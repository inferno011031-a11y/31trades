/* ============================================================================
   31TRADES — Demo Reset Utility
   ----------------------------------------------------------------------------
   Gives testers a one-click way to return every page to its default/zero state.

   How it works:
     · Floating "⟳ Reset demo" button (bottom-left, subtle).
     · Opening any page as  page.html?reset=1  also performs the reset.
     · window.resetDemo()  available from devtools.

   What it does:
     1. Clears any persisted state this app may have stored (localStorage keys
        prefixed with "31trades" / "demo" / "risk" / "sl" — future-proof for
        when you add persistence).
     2. Reloads the page, which rebuilds all in-memory demo state from its
        default seeds. Right now the pages keep everything in memory, so a
        reload IS a full reset.
   ============================================================================ */

(function () {
    'use strict';

    var PREFIXES = ['31trades', 'demo', 'risk', 'sl_', 'stratlab'];

    function clearStoredState() {
        if (!window.localStorage) return;
        var toRemove = [];
        for (var i = 0; i < window.localStorage.length; i++) {
            var key = window.localStorage.key(i) || '';
            if (PREFIXES.some(function (p) { return key.indexOf(p) === 0; })) {
                toRemove.push(key);
            }
        }
        toRemove.forEach(function (k) { window.localStorage.removeItem(k); });
    }

    function resetBackend() {
        // If a backend is serving, reseed its store (fire-and-forget).
        try {
            fetch('/api/reset', { method: 'POST' }).catch(function () { /* static demo server — nothing to reset */ });
        } catch (e) { /* ignore */ }
        // Reset the in-memory canonical store directly (offline demo fallback).
        if (window.TradeMindCore && typeof window.TradeMindCore.reseed === 'function') {
            try { window.TradeMindCore.reseed(); } catch (e) { /* ignore */ }
        }
    }

    function doReset() {
        clearStoredState();
        resetBackend();
        // Any page that exposes a state reset hook gets called first.
        if (typeof window.resetAppState === 'function') {
            try { window.resetAppState(); } catch (e) { /* ignore */ }
        }
        // Full reload rebuilds every in-memory default from its seed data.
        window.location.reload();
    }

    window.resetDemo = doReset;

    // Support  page.html?reset=1  — strip the param and reset.
    if (window.location.search.indexOf('reset=1') !== -1) {
        clearStoredState();
        resetBackend();
        var clean = window.location.pathname + window.location.hash;
        window.history.replaceState(null, '', clean);
        window.location.reload();
        return; // stop here — reload is happening
    }

    // Floating reset button — intentionally NOT rendered for end users.
    // Reset stays available to testers/devs via  page.html?reset=1  and
    // window.resetDemo() from the devtools console.
})();
