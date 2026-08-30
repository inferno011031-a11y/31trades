/* ============================================================================
   31TRADES — Dark Mode Enforcer (Pure Dark Aesthetic)
   ============================================================================ */
(function () {
    'use strict';
    var KEY = '31trades.theme';

    try { localStorage.setItem(KEY, 'dark'); } catch (e) {}
    document.documentElement.setAttribute('data-theme', 'dark');

    window.TMTheme = {
        get: function () { return 'dark'; },
        getPref: function () { return 'dark'; },
        set: function () { document.documentElement.setAttribute('data-theme', 'dark'); },
        setPref: function () { document.documentElement.setAttribute('data-theme', 'dark'); return 'dark'; },
        toggle: function () {}
    };

    function hideThemeToggles() {
        document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
            btn.style.display = 'none';
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hideThemeToggles);
    } else {
        hideThemeToggles();
    }
})();
