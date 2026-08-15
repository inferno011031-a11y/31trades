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

    function current() {
        try {
            var v = localStorage.getItem(KEY);
            if (v === 'light' || v === 'dark') return v;
        } catch (e) { /* ignore */ }
        return 'dark';
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

    window.TMTheme = { get: current, set: apply, toggle: toggle };

    // respect OS preference only until the user makes an explicit choice
    if (mq && mq.addEventListener) {
        mq.addEventListener('change', function (e) {
            var stored = null;
            try { stored = localStorage.getItem(KEY); } catch (err) { /* ignore */ }
            if (!stored) apply(e.matches ? 'light' : 'dark');
        });
    }
})();
