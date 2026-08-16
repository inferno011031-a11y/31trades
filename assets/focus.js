/* ============================================================================
   TMFocus — deterministic Current-Focus derivation for the Improvement Loop.
   ----------------------------------------------------------------------------
   Pure UI-side reader over EXISTING engine outputs. No new formula, no new
   scoring: it reads review focus / weakest dimension / evidence counts the
   same way every other surface reads them, so the Dashboard focus and the
   Improvement Loop page can never disagree.

   Priority (per product spec):
     1. Monthly review weakest dimension
     2. Weekly review focus
     3. Daily review focus
     4. Lowest-scored discipline dimension
     else → low-data state (no fabricated focus)
   ============================================================================ */
(function () {
    'use strict';
    function current(accountId) {
        const core = window.TradeMindCore;
        if (!core) return { state: 'low' };
        const trades = accountId
            ? (core.Trades || []).filter(t => t.account_id === accountId)
            : (core.Trades || []);
        if (!trades.length) return { state: 'empty' };
        if (trades.length < 3) return { state: 'low', trades: trades.length };

        let disc = null;
        try { disc = core.disciplineState(accountId); } catch (e) { disc = null; }

        let monthly = null, weekly = null, daily = null;
        try {
            const r = core.reviews(accountId, { period: 'all' });
            monthly = r.monthly || null;
            weekly = r.weekly || null;
            daily = r.daily || null;
        } catch (e) { /* reviews unavailable — fall through to dims */ }

        let focus = null, source = null;
        if (monthly && monthly.weakest_dim) {
            focus = monthly.weakest_dim;
            source = 'monthly review';
        } else if (weekly && weekly.focus && weekly.focus.indexOf('Focus: ') === 0) {
            focus = weekly.focus.slice(7);
            source = 'weekly review';
        } else if (daily && daily.focus && daily.focus.indexOf('Tighten: ') === 0) {
            focus = daily.focus.slice(9);
            source = 'daily review';
        } else if (disc && disc.dims) {
            const scored = disc.dims.filter(d => d.score != null);
            if (scored.length) {
                const worst = scored.slice().sort((a, b) => a.score - b.score)[0];
                focus = worst.label;
                source = 'discipline dimensions';
            }
        }
        if (!focus) return { state: 'low', trades: trades.length };

        const evidence = {
            score: monthly ? monthly.score : (disc ? disc.score : null),
            violations: monthly ? monthly.violations : (disc ? disc.violations : null),
            cleanDayStreak: monthly ? monthly.cleanDayStreak : (disc ? disc.cleanDayStreak : null),
            weakestDim: monthly ? monthly.weakest_dim : null,
            mostFrequent: weekly ? weekly.most_frequent : null,
            mostCostly: weekly && weekly.most_costly ? weekly.most_costly : null
        };
        return {
            state: 'focus',
            focus: focus,
            source: source,
            subject: String(focus).toLowerCase(),
            evidence: evidence,
            trades: trades.length
        };
    }
    window.TMFocus = { current: current };
})();
