/* ============================================================================
   profile-meta.js — Sidebar profile footer meta line (shared)
   One implementation for every page. Fills the small line under the trader
   name with REAL data — the selected account's account_type — instead of the
   hardcoded "Free plan" label, which claimed a subscription system the backend
   does not implement. Falls back to the neutral "Battlex Trader" when no
   account is selected. The trader name/avatar are owned by each page's own
   account render; this script only manages the meta line.
   ============================================================================ */
(function () {
    'use strict';

    function update() {
        var core = window.TradeMindCore;
        var el = document.getElementById('profile-meta');
        if (!el || !core) return;

        var label = 'Battlex Trader';
        try {
            // Check if user has active tester entitlement
            var isTester = false;
            try {
                var rawEnt = localStorage.getItem('31trades.tester_entitlement.v1');
                if (rawEnt) {
                    var ent = JSON.parse(rawEnt);
                    if (ent && ent.isTester && ent.expiresAt && new Date(ent.expiresAt).getTime() > Date.now()) {
                        isTester = true;
                    }
                }
                if (!isTester) {
                    var rawSess = localStorage.getItem('31trades.session.v1');
                    if (rawSess) {
                        var sess = JSON.parse(rawSess);
                        if (sess && sess.user && sess.user.access_plan === 'tester') {
                            isTester = true;
                        }
                    }
                }
            } catch (err) {}

            var id = (typeof core.selectedAccountId === 'function') ? core.selectedAccountId() : null;
            var acc = (id && core.ConfigAPI && typeof core.ConfigAPI.getAccount === 'function')
                ? core.ConfigAPI.getAccount(id)
                : null;
            
            if (isTester) {
                label = (acc && acc.account_type && acc.account_type !== 'Standard') ? ('Tester · ' + acc.account_type) : 'Tester Account';
            } else if (acc && acc.account_type) {
                label = acc.account_type;
            }
        } catch (e) { /* keep the neutral fallback */ }

        if (el.textContent !== label) el.textContent = label;
    }

    function subscribe() {
        var core = window.TradeMindCore;
        if (core && core.TradeMindBus && typeof core.TradeMindBus.subscribe === 'function') {
            core.TradeMindBus.subscribe('account.changed', update);
            core.TradeMindBus.subscribe('state.hydrated', update);
            core.TradeMindBus.subscribe('config.changed', update);
            return true;
        }
        return false;
    }

    function boot() {
        update();
        if (!subscribe()) {
            // Core boots lazily after DOMContentLoaded (auth flow) — retry briefly.
            var tries = 0;
            var iv = setInterval(function () {
                tries += 1;
                if (subscribe() || tries > 25) clearInterval(iv);
                else update();
            }, 200);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
