/* ============================================================================
   31TRADES — First-time Trader Onboarding (shared)
   ----------------------------------------------------------------------------
   One premium welcome + checklist surface for a brand-new workspace. It reads
   the SAME canonical state the notifications engine uses (Accounts /
   StrategyMaster / Trades / reviewed queue / broker flag), so a step completes
   exactly when the backend's onboarding notification for it would disappear.
   No new state, no fake progress — the derivation mirrors server/notifications.js.

   Steps:
     01 Create your account   → hasAccounts
     02 Define your strategy  → hasStrategies
     03 Log your first trade  → hasTrades
     04 Review your decision  → trades exist && no unreviewed trades
     05 Connect your broker   → broker connected (local mirror of the registry)

   When every step is complete the panel shows SYSTEM READY instead of the
   checklist, and the dashboard stops showing it (returning users never see
   a brand-new welcome again).
   ========================================================================== */
(function () {
    'use strict';

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    function brokerConnected() {
        try { return localStorage.getItem('31trades.broker.connected') === '1'; } catch (e) { return false; }
    }

    // Derivation identical to the backend's onboarding checklist (see
    // server/notifications.js buildNotifications) — never a separate flag.
    function steps() {
        const core = window.TradeMindCore;
        const Accounts = (core && core.Accounts) || [];
        const StrategyMaster = (core && core.StrategyMaster) || [];
        const Trades = (core && core.Trades) || [];
        const hasAccounts = Accounts.length > 0;
        const hasStrategies = StrategyMaster.length > 0;
        const hasTrades = Trades.length > 0;
        const anyUnreviewed = hasTrades && Trades.some(t => !t.reviewed);
        const connected = brokerConnected();

        return [
            {
                id: 'account', num: '01', label: 'Create your account',
                sub: 'Set an account name, size, currency and risk limits — every screen reads from it.',
                href: 'strategy-lab.html?tab=accounts', action: 'Create account',
                icon: 'wallet', complete: hasAccounts
            },
            {
                id: 'strategy', num: '02', label: 'Define your strategy',
                sub: 'Setups, sessions, instruments and risk rules — the rule engine evaluates every trade against it.',
                href: 'strategy-lab.html?tab=strategies', action: 'Create strategy',
                icon: 'beaker', complete: hasStrategies
            },
            {
                id: 'trade', num: '03', label: 'Log your first trade',
                sub: 'One trade activates risk, discipline, analytics, insights and the calendar — all from the same ledger.',
                href: 'journal.html', action: 'Log first trade',
                icon: 'book-open', complete: hasTrades
            },
            {
                id: 'review', num: '04', label: 'Review your decision',
                sub: 'Review your trades while they are fresh — mark them reviewed in the Journal to keep discipline accurate.',
                href: 'journal.html?view=unreviewed', action: 'Review trade',
                icon: 'clipboard-check', complete: hasTrades && !anyUnreviewed
            },
            {
                id: 'broker', num: '05', label: 'Connect your broker',
                sub: 'Bring your workflow into Battlex — connect when you are ready. Manual journaling always works.',
                href: 'settings.html#brokers', action: 'Connect broker',
                icon: 'plug', complete: connected
            }
        ];
    }

    function firstName() {
        try {
            const s = window.TradeMindAuth && window.TradeMindAuth.getSession && window.TradeMindAuth.getSession();
            const u = s && s.user;
            if (u && u.name) return String(u.name).split(/[\s@]/)[0];
            if (u && u.email) return String(u.email).split('@')[0].split(/[._-]/)[0];
        } catch (e) {}
        return 'trader';
    }

    // Renders into target. Returns true when the panel should stay visible
    // (onboarding incomplete), false when the dashboard should hide it.
    function render(target, opts) {
        if (!target) return false;
        const o = opts || {};
        const list = steps();
        const done = list.filter(s => s.complete).length;
        const allDone = done === list.length;

        // a fully built workspace → SYSTEM READY (or the caller hides it)
        const name = esc(firstName());
        const dismissBtn = o.dismissible === false
            ? ''
            : '<button onclick="window.dismissOnboarding && window.dismissOnboarding()" title="Dismiss" class="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--tm-dim)] hover:text-[var(--tm-text)] hover:bg-[var(--tm-hover)] transition-colors border-none bg-transparent cursor-pointer"><svg data-lucide="x" class="w-4 h-4"></svg></button>';
        const tourBtn = '<button onclick="window.startTour && window.startTour()" title="Take a guided tour" class="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--tm-dim)] hover:text-[var(--tm-green)] hover:bg-[var(--tm-hover)] transition-colors border-none bg-transparent cursor-pointer"><svg data-lucide="compass" class="w-4 h-4"></svg></button>';

        if (allDone) {
            target.innerHTML =
                '<div class="glass-strong p-6 relative overflow-hidden fade-up">' +
                    '<div class="absolute top-3 right-3 flex items-center gap-1.5">' + tourBtn + '</div>' +
                    '<div class="flex items-start gap-4">' +
                        '<div class="w-11 h-11 rounded-xl flex-shrink-0 flex items-center justify-center" style="background:linear-gradient(135deg,rgba(16,185,129,0.16),rgba(99,102,241,0.12));border:1px solid rgba(16,185,129,0.35)"><svg data-lucide="check-circle-2" class="w-5 h-5 text-[var(--tm-green)]"></svg></div>' +
                        '<div class="min-w-0">' +
                            '<div class="label-xs text-[var(--tm-green)] mb-1">System ready</div>' +
                            '<div class="text-[17px] font-bold tracking-tight">Your workspace is built, ' + name + '. Now the real work begins.</div>' +
                            '<p class="text-[13px] text-[var(--tm-muted)] mt-1 max-w-2xl leading-relaxed">Your system, journal, reviews and broker are connected. Every screen now reads the same ledger — go make decisions worth repeating.</p>' +
                            '<div class="flex flex-wrap items-center gap-2 mt-4">' +
                                '<a href="dashboard.html" class="btn-primary !py-2 !px-3.5 text-[12.5px]"><svg data-lucide="layout-dashboard" class="w-4 h-4"></svg> Open Dashboard</a>' +
                                '<a href="journal.html" class="btn-ghost !py-2 !px-3.5 text-[12.5px]"><svg data-lucide="book-open" class="w-4 h-4"></svg> Open Journal</a>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            if (window.lucide) lucide.createIcons();
            return false;
        }

        // the first incomplete step is the current focus; everything before it
        // is done, everything after is upcoming
        let currentIdx = list.findIndex(s => !s.complete);
        if (currentIdx === -1) currentIdx = 0;

        const rows = list.map((s, i) => {
            const stateCls = s.complete ? 'done' : (i === currentIdx ? 'current' : 'todo');
            const statusHtml = s.complete
                ? '<span class="tag tag-emerald flex-shrink-0"><svg data-lucide="check" class="w-3.5 h-3.5"></svg> Done</span>'
                : (i === currentIdx
                    ? '<a href="' + esc(s.href) + '" class="btn-primary !py-2 !px-3.5 !text-[12px] flex-shrink-0"><svg data-lucide="' + s.icon + '" class="w-3.5 h-3.5"></svg> ' + esc(s.action) + '</a>'
                    : '<span class="tag tag-gray flex-shrink-0">Up next</span>');
            return '<div class="flex items-start gap-3.5 px-4 py-3 rounded-xl transition-colors ' +
                (stateCls === 'current' ? 'style="background:linear-gradient(135deg,rgba(99,102,241,0.10),rgba(52,211,153,0.06));border:1px solid rgba(129,140,248,0.30)"' : '') +
                (stateCls === 'done' ? ' style="opacity:0.55"' : '') + '>' +
                '<div class="num text-[12px] font-extrabold pt-0.5 flex-shrink-0 ' + (stateCls === 'current' ? 'text-[var(--tm-accent-2)]' : 'text-[var(--tm-dim)]') + '">' + s.num + '</div>' +
                '<div class="flex-1 min-w-0">' +
                    '<div class="text-[13.5px] font-bold ' + (stateCls === 'current' ? '' : '') + '">' + esc(s.label) + '</div>' +
                    '<div class="text-[12px] text-[var(--tm-dim)] mt-0.5 leading-relaxed">' + esc(s.sub) + '</div>' +
                '</div>' +
                statusHtml +
            '</div>';
        }).join('');

        target.innerHTML =
            '<div class="glass-strong p-6 relative overflow-hidden fade-up">' +
                '<div class="absolute top-3 right-3 flex items-center gap-1.5">' + tourBtn + dismissBtn + '</div>' +
                '<div class="flex items-start gap-4">' +
                    '<div class="w-11 h-11 rounded-xl flex-shrink-0 flex items-center justify-center" style="background:linear-gradient(135deg,rgba(99,102,241,0.16),rgba(52,211,153,0.12));border:1px solid rgba(99,102,241,0.32)"><svg data-lucide="sparkles" class="w-5 h-5 text-[var(--tm-accent)]"></svg></div>' +
                    '<div class="min-w-0 flex-1">' +
                        '<div class="label-xs mb-1">Welcome to Battlex</div>' +
                        '<div class="text-[19px] font-extrabold tracking-tight">Your trading isn\'t defined by one trade, <span class="text-[var(--tm-green)]">' + name + '</span>.</div>' +
                        '<p class="text-[13px] text-[var(--tm-muted)] mt-1 max-w-2xl leading-relaxed">It\'s defined by the decisions you repeat. Build your system, log your decisions, and Battlex measures how consistently you follow it.</p>' +
                    '</div>' +
                '</div>' +

                '<div class="flex flex-wrap items-center justify-between gap-2 mt-5 pt-4 border-t border-[var(--hairline)]">' +
                    '<div class="label-xs">Your starting system · <span class="num">' + done + '/' + list.length + '</span></div>' +
                    '<span class="text-[11px] text-[var(--tm-dim)]">' + (done === 0 ? 'Start with the first step below.' : done === list.length - 1 ? 'One step left.' : 'Every step reads from the same ledger.') + '</span>' +
                '</div>' +
                '<div class="progress-track mt-2.5"><div class="progress-fill" style="width:' + Math.round((done / list.length) * 100) + '%"></div></div>' +

                '<div class="flex flex-col gap-2 mt-4">' + rows + '</div>' +
            '</div>';

        if (window.lucide) lucide.createIcons();
        return true;
    }

    window.TMOnboarding = { render, steps, firstName };
})();
