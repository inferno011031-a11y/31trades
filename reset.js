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

    // Floating reset button (only on our app pages).
    function addButton() {
        if (document.getElementById('demo-reset-btn')) return;
        var btn = document.createElement('button');
        btn.id = 'demo-reset-btn';
        btn.title = 'Reset local data — returns the app to first-user / zero-trade state (clears saved state and reloads)';
        btn.style.cssText = [
            'position:fixed', 'left:14px', 'bottom:14px', 'z-index:9999',
            'display:flex', 'align-items:center', 'gap:6px',
            'padding:6px 12px', 'border-radius:999px',
            'background:rgba(22,22,26,0.92)', 'border:1px solid #26262B',
            'color:#8A8A93', 'font-family:inherit', 'font-size:11px',
            'font-weight:600', 'letter-spacing:0.02em', 'cursor:pointer',
            'box-shadow:0 6px 20px rgba(0,0,0,0.35)', 'transition:all .15s'
        ].join(';');
        btn.onmouseenter = function () { btn.style.color = '#F87171'; btn.style.borderColor = 'rgba(239,68,68,0.4)'; };
        btn.onmouseleave = function () { btn.style.color = '#8A8A93'; btn.style.borderColor = '#26262B'; };
        btn.innerHTML = '<span style="font-size:12px">⟳</span> Reset local data';
        btn.addEventListener('click', doReset);
        document.body.appendChild(btn);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addButton);
    } else {
        addButton();
    }
})();
