/* ============================================================================
   31TRADES — Theme toggle (shared)
   ----------------------------------------------------------------------------
   One global switch for the whole app:
     - persists the choice under "31trades.theme" (dark | light)
     - flips <html data-theme="…"> so assets/trademind-theme.css re-points the
       semantic token layer (every page flips at once, no page edits needed)
     - dispatches a "tm:theme" CustomEvent with { mode } so chart instances and
       other JS can re-theme themselves live without a reload
   Any element with [data-theme-toggle] acts as the switch; it is wired here so
   pages only need to include this script and a button.
   ============================================================================ */
(function () {
    'use strict';
    var KEY = '31trades.theme';
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

    function stored() {
        try {
            var v = localStorage.getItem(KEY);
            if (v === 'light' || v === 'dark' || v === 'system') return v;
        } catch (e) { /* ignore */ }
        return null;
    }

    // resolved mode — 'system' follows the OS until the user picks explicitly
    function resolve(pref) {
        if (pref === 'light' || pref === 'dark') return pref;
        return mq && mq.matches ? 'light' : 'dark';
    }

    function current() {
        return resolve(stored());
    }

    function persist(mode) {
        try { localStorage.setItem(KEY, mode); } catch (e) { /* ignore */ }
    }

    function apply(mode, announce) {
        var root = document.documentElement;
        var prev = root.getAttribute('data-theme');
        root.setAttribute('data-theme', mode);
        if (prev !== mode && announce !== false) {
            try {
                document.dispatchEvent(new CustomEvent('tm:theme', { detail: { mode: mode } }));
            } catch (e) { /* ignore */ }
        }
        updateIcons(mode);
    }

    function toggle() {
        var next = current() === 'dark' ? 'light' : 'dark';
        persist(next);
        apply(next);
    }

    // setPref stores the raw preference ('light' | 'dark' | 'system') and
    // applies the resolved mode — used by the Settings Appearance panel and
    // by the server-synced value.
    function setPref(pref) {
        var value = (pref === 'light' || pref === 'dark' || pref === 'system') ? pref : 'dark';
        persist(value);
        apply(resolve(value));
        return value;
    }

    function updateIcons(mode) {
        var light = mode !== 'dark';
        document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
            var ico = btn.querySelector('[data-theme-ico]');
            if (ico) ico.setAttribute('data-lucide', light ? 'moon' : 'sun');
            btn.setAttribute('title', light ? 'Switch to dark mode' : 'Switch to light mode');
            btn.classList.toggle('is-light', light);
        });
        if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    }

    function wire() {
        document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
            btn.addEventListener('click', toggle);
        });
    }

    // initial paint — run as early as possible to avoid a flash
    var initial = current();
    apply(initial, false);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.TMTheme = { get: current, getPref: stored, set: apply, setPref: setPref, toggle: toggle };

    // respect OS preference while the user hasn't picked explicitly (or is on System)
    if (mq && mq.addEventListener) {
        mq.addEventListener('change', function (e) {
            var pref = stored();
            if (!pref || pref === 'system') apply(resolve('system'));
        });
    }
})();
