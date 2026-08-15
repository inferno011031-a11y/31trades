/* ============================================================================
   31TRADES — First-run tour
   ----------------------------------------------------------------------------
   A lightweight spotlight tour that walks a brand-new user through the
   sidebar screens. Works on every page: it reads the sidebar's .nav-item
   links, highlights each in turn, and shows a tooltip with a description.

   API:
     window.startTour()              — begin (or resume) the tour
     window.tourActive()             — is the tour currently open?
     window.dismissTour()            — finish/close without completing

   Persistence: '31trades.tour.done.v1' in localStorage — once the tour is
   completed it won't auto-start again. Dismissing early just closes it; the
   user can restart from the Dashboard hero ("Take a tour" link).

   Style: dark, matches the app shell. No external deps.
   ========================================================================== */
(function () {
    'use strict';

    var DONE_KEY = '31trades.tour.done.v1';

    // Screen descriptions keyed by nav label (shown in the tooltip).
    var DESCRIPTIONS = {
        'Dashboard': 'Your command center — today\'s P&L, risk meter, equity curve and the AI daily brief.',
        'Journal': 'Log, edit and review every trade. Filter, search, and open the fast or detailed entry form.',
        'Insights': 'Findings from your data — strongest setups, costly rule breaks, and what to focus on.',
        'Analytics': 'Deep performance breakdowns: equity, drawdown, distribution, strategy, session and streaks.',
        'AI Mentor': 'Your personal coach — trade autopsies, pattern detection, tilt warnings and grounded Q&A.',
        'Backtesting': 'Test a strategy against historical data before risking real capital.',
        'Strategy Lab': 'Create accounts, strategies and rule sets. Versioned, immutable configurations.',
        'Market Replay': 'Replay market conditions to study setups and practice execution.',
        'Risk': 'Your live risk engine — daily budget, drawdown, and what the next trade can risk.',
        'Discipline': 'Process adherence — violations, score, strongest and weakest rules, clean streaks.',
        'Calendar': 'A monthly view of P&L, trade counts, discipline and risk, aggregated from the same ledger.',
        'Community': 'Connect with other traders, compare setups and share the journey.',
        'Reports': 'Export and share your performance.',
        'Notifications': 'Alerts, breaches, review reminders and market events — all derived from your data.'
    };

    var state = { active: false, idx: 0, items: [] };
    var overlay = null, tooltip = null;

    function $(s, root) { return (root || document).querySelector(s); }
    function $$(s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); }

    // The sidebar nav links (skip the "Help"/"Settings"/placeholder '#' items
    // that aren't real screens yet, keep the tour to shipped sections).
    function collectItems() {
        var nav = $('nav');
        if (!nav) return [];
        return $$('a.nav-item', nav).filter(function (a) {
            var label = a.textContent.trim();
            if (!label || label.indexOf('NEW') !== -1) return false;
            if (label === 'Help' || label === 'Settings') return false;
            var href = a.getAttribute('href');
            // Dashboard keeps href="#" only on its own page (active marker) —
            // still a real screen, keep it. Other '#' links are placeholders.
            if ((!href || href === '#') && label !== 'Dashboard') return false;
            return true;
        }).map(function (a) {
            var label = a.textContent.trim();
            var href = a.getAttribute('href');
            // nav-item contains an svg + label span; strip the svg text
            var span = a.querySelector('.nav-label');
            if (span) label = span.textContent.trim();
            return { el: a, label: label, href: href, desc: DESCRIPTIONS[label] || ('Open the ' + label + ' screen.') };
        });
    }

    function buildOverlay() {
        overlay = document.createElement('div');
        overlay.id = 'tm-tour-overlay';
        overlay.innerHTML =
            '<div id="tm-tour-backdrop"></div>' +
            '<div id="tm-tour-card" role="dialog" aria-label="Tour">' +
                '<button id="tm-tour-close" title="End tour" aria-label="End tour"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
                '<div class="tm-tour-kicker">STEP <span id="tm-tour-step">1</span> OF <span id="tm-tour-total">1</span></div>' +
                '<div class="tm-tour-title" id="tm-tour-title"></div>' +
                '<div class="tm-tour-desc" id="tm-tour-desc"></div>' +
                '<div class="tm-tour-actions">' +
                    '<button id="tm-tour-prev" class="tm-tour-btn-ghost" type="button">Back</button>' +
                    '<div class="tm-tour-dots" id="tm-tour-dots"></div>' +
                    '<button id="tm-tour-next" class="tm-tour-btn" type="button">Next</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        $('#tm-tour-close', overlay).addEventListener('click', closeTour);
        $('#tm-tour-prev', overlay).addEventListener('click', function () { goto(state.idx - 1); });
        $('#tm-tour-next', overlay).addEventListener('click', function () {
            if (state.idx >= state.items.length - 1) { completeTour(); return; }
            goto(state.idx + 1);
        });
        document.addEventListener('keydown', function (e) {
            if (!state.active) return;
            if (e.key === 'Escape') closeTour();
            else if (e.key === 'ArrowRight') { if (state.idx >= state.items.length - 1) completeTour(); else goto(state.idx + 1); }
            else if (e.key === 'ArrowLeft') goto(state.idx - 1);
        });
    }

    function position() {
        var item = state.items[state.idx];
        if (!item) return;
        var r = item.el.getBoundingClientRect();
        var card = $('#tm-tour-card', overlay);
        var cardR = card.getBoundingClientRect();
        var pad = 14;

        // backplate behind the nav item
        var bp = $('#tm-tour-spot', overlay) || document.createElement('div');
        bp.id = 'tm-tour-spot';
        bp.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
            'border-radius:10px;box-shadow:0 0 0 4px rgba(16,185,129,0.55),0 0 24px rgba(16,185,129,0.35);z-index:1001;pointer-events:none;transition:all .25s ease;';
        if (!bp.parentNode) overlay.insertBefore(bp, card);

        // tooltip to the right of the sidebar (or below on narrow screens)
        var cardW = cardR.width;
        var left = Math.min(r.right + pad, window.innerWidth - cardW - 12);
        var top = Math.min(Math.max(r.top + r.height / 2 - cardR.height / 2, 8), window.innerHeight - cardR.height - 8);
        card.style.left = left + 'px';
        card.style.top = top + 'px';
    }

    function render() {
        var item = state.items[state.idx];
        if (!item) return;
        $('#tm-tour-step', overlay).textContent = String(state.idx + 1);
        $('#tm-tour-total', overlay).textContent = String(state.items.length);
        $('#tm-tour-title', overlay).textContent = item.label;
        $('#tm-tour-desc', overlay).textContent = item.desc;
        $('#tm-tour-next', overlay).textContent = state.idx >= state.items.length - 1 ? 'Finish' : 'Next';
        $('#tm-tour-prev', overlay).style.visibility = state.idx === 0 ? 'hidden' : 'visible';

        var dots = $('#tm-tour-dots', overlay);
        dots.innerHTML = state.items.map(function (_, i) {
            return '<span class="tm-tour-dot' + (i === state.idx ? ' active' : '') + '"></span>';
        }).join('');

        position();
    }

    function goto(i) {
        if (i < 0 || i >= state.items.length) return;
        state.idx = i;
        render();
    }

    function completeTour() {
        try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
        closeTour();
    }

    function closeTour() {
        state.active = false;
        if (overlay) overlay.remove();
        overlay = null;
        document.body.classList.remove('tm-tour-lock');
    }

    function startTour() {
        state.items = collectItems();
        if (!state.items.length) return;
        state.idx = 0;
        state.active = true;
        if (!overlay) buildOverlay();
        document.body.classList.add('tm-tour-lock');
        render();
        requestAnimationFrame(position);
        window.setTimeout(position, 60);   // after fonts/lucide settle
    }

    window.startTour = startTour;
    window.tourActive = function () { return state.active; };
    window.dismissTour = closeTour;
    window.tourCompleted = function () {
        try { return localStorage.getItem(DONE_KEY) === '1'; } catch (e) { return false; }
    };
})();
