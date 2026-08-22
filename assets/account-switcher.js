/* ============================================================================
   account-switcher.js — GLOBAL ACCOUNT SWITCHER (shared, every page)
   Turns the existing topbar #acc-chip into a real account switcher without
   touching the topbar design: same chip, same position, same appearance.
   One implementation for all 20 pages, backed entirely by the canonical core:

       core.Accounts                     — account list (single source of truth)
       core.selectedAccountId()          — current selection
       core.setSelectedAccount(id)       — validates, persists, emits account.changed

   Switching closes the popover, shows a subtle "Switching…" state, then
   reloads the current page so every account-dependent component re-renders
   from the newly selected account (no stale data from the previous one).

   "Add account" / "Manage accounts" reuse the existing Strategy Lab workflow
   (strategy-lab.html?tab=accounts[&new=1]).
   ============================================================================ */
(function () {
    'use strict';

    var STYLE_ID = 'account-switcher-style';
    var POP_ID = 'account-switcher-pop';

    function core() { return window.TradeMindCore; }
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function money(n) {
        if (n == null || isNaN(n)) return '—';
        return (n > 0 ? '+' : '') + '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    var chip = null;
    var pop = null;

    /* ---- styles: Battlex design tokens, injected once ---------------- */
    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = [
            '#account-switcher-pop { position: fixed; z-index: 999; width: min(360px, calc(100vw - 24px));',
            '  background: var(--tm-card-2); border: 1px solid var(--tm-border-2);',
            '  border-radius: 14px; box-shadow: 0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);',
            '  overflow: hidden; font-family: var(--tm-sans); color: var(--tm-text);',
            '  animation: as-in 0.14s ease-out; }',
            '@keyframes as-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }',
            '#account-switcher-pop .as-head { padding: 12px 14px 8px; font-size: 10.5px; font-weight: 700;',
            '  letter-spacing: 0.1em; text-transform: uppercase; color: var(--tm-muted);',
            '  border-bottom: 1px solid var(--tm-border); display: flex; align-items: center; justify-content: space-between; }',
            '#account-switcher-pop .as-group { padding: 8px 6px; }',
            '#account-switcher-pop .as-group-label { padding: 8px 10px 4px; font-size: 9.5px; font-weight: 700;',
            '  letter-spacing: 0.1em; text-transform: uppercase; color: var(--tm-dim); }',
            '#account-switcher-pop .as-row { display: flex; align-items: center; gap: 10px; width: 100%;',
            '  padding: 9px 10px; border-radius: 9px; border: 1px solid transparent; background: transparent;',
            '  color: var(--tm-text); cursor: pointer; text-align: left; font-family: inherit; transition: background 0.12s ease; }',
            '#account-switcher-pop .as-row:hover { background: var(--tm-hover); }',
            '#account-switcher-pop .as-row:focus-visible { outline: 2px solid var(--tm-accent); outline-offset: -2px; }',
            '#account-switcher-pop .as-row.as-active { background: linear-gradient(135deg, rgba(99,102,241,0.16), rgba(52,211,153,0.08));',
            '  border-color: rgba(129,140,248,0.30); box-shadow: inset 2px 0 0 var(--tm-accent); }',
            '#account-switcher-pop .as-check { width: 18px; flex-shrink: 0; color: var(--tm-accent); display: flex; }',
            '#account-switcher-pop .as-check svg { width: 16px; height: 16px; }',
            '#account-switcher-pop .as-body { flex: 1; min-width: 0; }',
            '#account-switcher-pop .as-name { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '#account-switcher-pop .as-meta { font-size: 11px; color: var(--tm-dim); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '#account-switcher-pop .as-meta .as-eq { font-family: var(--tm-mono); font-variant-numeric: tabular-nums; }',
            '#account-switcher-pop .as-status { flex-shrink: 0; font-size: 10px; font-weight: 700; padding: 3px 8px;',
            '  border-radius: 999px; display: inline-flex; align-items: center; gap: 5px; }',
            '#account-switcher-pop .as-status.on { background: rgba(52,211,153,0.12); color: var(--tm-green); }',
            '#account-switcher-pop .as-status.off { background: rgba(148,163,184,0.10); color: var(--tm-muted); }',
            '#account-switcher-pop .as-status .as-dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }',
            '#account-switcher-pop .as-foot { border-top: 1px solid var(--tm-border); padding: 8px 6px; }',
            '#account-switcher-pop .as-foot a { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 10px;',
            '  border-radius: 9px; font-size: 12.5px; font-weight: 600; color: var(--tm-text); text-decoration: none;',
            '  transition: background 0.12s ease; }',
            '#account-switcher-pop .as-foot a:hover { background: var(--tm-hover); }',
            '#account-switcher-pop .as-foot a svg { width: 15px; height: 15px; color: var(--tm-accent); flex-shrink: 0; }',
            '#account-switcher-pop .as-empty { padding: 18px 14px; text-align: center; color: var(--tm-dim); font-size: 12.5px; }',
            '#account-switcher-pop .as-empty a { color: var(--tm-accent); font-weight: 700; text-decoration: none; }',
            '@media (max-width: 640px) { #account-switcher-pop { width: calc(100vw - 24px); } }'
        ].join('\n');
        document.head.appendChild(st);
    }

    /* ---- popover construction ----------------------------------------- */
    function rowHtml(acc, selectedId, isOnly) {
        var active = acc.id === selectedId;
        var status = acc.status === 'Active'
            ? '<span class="as-status on"><span class="as-dot"></span>Active</span>'
            : '<span class="as-status off"><span class="as-dot"></span>' + esc(acc.status || 'Manual') + '</span>';
        // Account model carries no broker linkage — honest manual label.
        var meta = '<span>' + esc(acc.account_type || 'Account') + ' · <span class="as-eq">' + money(acc.current_equity) + '</span></span>';
        if (!isOnly) meta += ' · <span class="as-manual" style="opacity:.75">Manual account</span>';
        return '<button type="button" role="menuitemradio" class="as-row' + (active ? ' as-active' : '') + '" data-acc-id="' + esc(acc.id) + '"' +
            ' aria-checked="' + active + '" tabindex="0">' +
            '<span class="as-check">' + (active ? '<svg data-lucide="check" stroke-width="2.5"></svg>' : '') + '</span>' +
            '<span class="as-body"><span class="as-name">' + esc(acc.name) + '</span>' +
            '<span class="as-meta">' + meta + '</span></span>' +
            status + '</button>';
    }

    function render() {
        var c = core();
        if (!c || !c.Accounts) return;
        var selectedId = (typeof c.selectedAccountId === 'function') ? c.selectedAccountId() : null;
        var accounts = c.Accounts.slice();
        var active = accounts.filter(function (a) { return a.id === selectedId; });
        var others = accounts.filter(function (a) { return a.id !== selectedId; });
        var html = '';
        html += '<div class="as-head"><span>Account</span><span style="opacity:.55">' + accounts.length + '</span></div>';
        if (!accounts.length) {
            html += '<div class="as-empty">No accounts yet.<br><a href="strategy-lab.html?tab=accounts&new=1">Create your first account</a></div>';
        } else {
            if (active.length) {
                html += '<div class="as-group">' + active.map(function (a) { return rowHtml(a, selectedId, accounts.length === 1); }).join('') + '</div>';
            }
            if (others.length) {
                html += '<div class="as-group"><div class="as-group-label">Other accounts</div>' +
                    others.map(function (a) { return rowHtml(a, selectedId, false); }).join('') + '</div>';
            }
        }
        html += '<div class="as-foot">' +
            '<a href="strategy-lab.html?tab=accounts&new=1" role="menuitem"><svg data-lucide="plus-circle"></svg> Add account</a>' +
            '<a href="strategy-lab.html?tab=accounts" role="menuitem"><svg data-lucide="settings-2"></svg> Manage accounts <span style="margin-left:auto;color:var(--tm-dim)">→</span></a>' +
            '</div>';
        pop.innerHTML = html;
        if (window.lucide) lucide.createIcons();
    }

    function position() {
        if (!chip || !pop) return;
        var r = chip.getBoundingClientRect();
        var popH = pop.offsetHeight || 320;
        var w = pop.offsetWidth || 360;
        var top = r.bottom + 8;
        var left = r.right - w;
        // Clamp inside the viewport; flip upward if there is no room below.
        if (top + popH > window.innerHeight - 8) top = Math.max(8, r.top - popH - 8);
        if (left < 8) left = 8;
        if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
        pop.style.top = Math.round(top) + 'px';
        pop.style.left = Math.round(left) + 'px';
    }

    function openPopover() {
        if (!chip || !core()) return;
        render();
        pop.style.display = 'block';
        position();
        chip.setAttribute('aria-expanded', 'true');
        // focus first row
        var first = pop.querySelector('.as-row');
        if (first) first.focus();
    }

    function closePopover(refocus) {
        if (!pop) return;
        pop.style.display = 'none';
        if (chip) chip.setAttribute('aria-expanded', 'false');
        if (refocus && chip) chip.focus();
    }

    function toggle() {
        if (pop && pop.style.display === 'block') closePopover(true);
        else openPopover();
    }

    function onSelect(id) {
        var c = core();
        if (!c) return;
        var cur = (typeof c.selectedAccountId === 'function') ? c.selectedAccountId() : null;
        if (id === cur) { closePopover(true); return; }
        if (!c.setSelectedAccount(id)) { closePopover(true); return; }
        closePopover();
        // subtle loading state, then reload so every account-dependent
        // component renders from the newly selected account.
        if (chip) {
            chip.innerHTML = '<span class="num text-[12px]">…</span><span class="text-[var(--tm-dim)]">·</span><span>Switching…</span>' +
                '<svg data-lucide="chevron-down" class="w-3.5 h-3.5 text-[var(--tm-dim)]"></svg>';
            if (window.lucide) lucide.createIcons();
        }
        setTimeout(function () { window.location.reload(); }, 160);
    }

    function onKey(e) {
        if (!pop || pop.style.display !== 'block') return;
        if (e.key === 'Escape') { e.stopPropagation(); closePopover(true); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        var rows = Array.prototype.slice.call(pop.querySelectorAll('.as-row'));
        if (!rows.length) return;
        var idx = rows.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
        else if (e.key === 'ArrowUp') idx = idx < 0 ? rows.length - 1 : Math.max(0, idx - 1);
        else if (e.key === 'Home') idx = 0;
        else if (e.key === 'End') idx = rows.length - 1;
        if (rows[idx]) rows[idx].focus();
    }

    /* ---- wiring --------------------------------------------------------- */
    function init() {
        chip = $('acc-chip');
        if (!chip) return;
        if (chip.getAttribute('data-as-bound')) return;
        chip.setAttribute('data-as-bound', '1');
        chip.setAttribute('role', 'button');
        chip.setAttribute('aria-haspopup', 'menu');
        chip.setAttribute('aria-expanded', 'false');
        chip.classList.add('cursor-pointer');

        injectStyle();
        pop = document.createElement('div');
        pop.id = POP_ID;
        pop.setAttribute('role', 'menu');
        pop.setAttribute('aria-label', 'Switch account');
        pop.style.display = 'none';
        document.body.appendChild(pop);

        chip.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });

        pop.addEventListener('click', function (e) {
            var row = e.target.closest && e.target.closest('.as-row');
            if (row) { e.stopPropagation(); onSelect(row.getAttribute('data-acc-id')); return; }
            var a = e.target.closest && e.target.closest('a');
            if (a) closePopover(); // navigate via the link
        });

        document.addEventListener('click', function (e) {
            if (pop.style.display === 'block' && e.target !== chip && !(pop.contains && pop.contains(e.target))) closePopover();
        });
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', function () { if (pop.style.display === 'block') position(); });
    }

    function boot() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
        // Late-booting core (auth flow) — retry briefly.
        var tries = 0;
        var iv = setInterval(function () {
            tries += 1;
            if (core() || tries > 25) clearInterval(iv);
            else { /* wait */ }
        }, 200);
    }

    boot();
})();
