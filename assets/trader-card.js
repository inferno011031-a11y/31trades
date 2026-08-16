/* ============================================================================
   31TRADES — Battlex Trader Card (shared)
   ----------------------------------------------------------------------------
   One premium identity card used across Settings (full), Discipline (compact
   top), and the Community identity hero's visual language. Everything on the
   card comes from the EXISTING canonical data:
     · identity      → TradeMindAuth.getSession()  (name + Supabase trader id)
     · discipline    → TradeMindCore.disciplineState(selectedAccountId())
   No new formulas: score, six dimensions, clean streaks and violations are
   the exact values the discipline engine already computes. No public profile,
   no reputation, no XP, no achievements. Download/Copy only export what the
   trader already sees on the card (client-side, never published).
   ========================================================================== */
(function () {
    'use strict';

    function identity() {
        try {
            const s = window.TradeMindAuth && window.TradeMindAuth.getSession && window.TradeMindAuth.getSession();
            const u = (s && s.user) || null;
            return {
                name: (u && u.name) || 'Trader',
                id: (u && u.id) || '00000000-0000-0000-0000-000000000000',
                email: (u && u.email) || ''
            };
        } catch (e) {
            return { name: 'Trader', id: '00000000-0000-0000-0000-000000000000', email: '' };
        }
    }

    function discipline() {
        try {
            const core = window.TradeMindCore;
            if (!core || typeof core.disciplineState !== 'function') return null;
            const acc = (core.selectedAccountId && core.selectedAccountId()) || (core.Accounts && core.Accounts[0] && core.Accounts[0].id);
            if (!acc) return null;
            return core.disciplineState(acc);
        } catch (e) { return null; }
    }

    function scoredDims(d) {
        if (!d || !Array.isArray(d.dims)) return [];
        return d.dims.filter(x => x && x.score != null);
    }
    function strongest(d) { const ds = scoredDims(d); return ds.length ? ds.reduce((a, b) => (b.score > a.score ? b : a)) : null; }
    function weakest(d) { const ds = scoredDims(d); return ds.length ? ds.reduce((a, b) => (b.score < a.score ? b : a)) : null; }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function shortId(id) {
        const s = String(id || '');
        return s.length > 18 ? s.slice(0, 8) + '…' + s.slice(-8) : s;
    }

    // ---------- shared helpers used by both the DOM card and the PNG export ----------
    function cardModel() {
        const id = identity();
        const d = discipline();
        // show all six canonical dimensions (RISK, STRATEGY, EXECUTION, FREQUENCY,
        // SESSION, BEHAVIOR) in their engine order — unscored dims render '—'
        const dims = (d && Array.isArray(d.dims)) ? d.dims.slice(0, 6) : [];
        const strong = strongest(d);
        const weak = weakest(d);
        return { id, d, dims, strong, weak };
    }

    // ---------- canvas export (client-side only, nothing is published) ----------
    function downloadCard() {
        const m = cardModel();
        const W = 720, H = 560, R = 18, PAD = 26;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const c = cv.getContext('2d');
        const dim = m.dims;

        // surface
        const bg = c.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#f4f6fb');
        c.fillStyle = bg;
        c.beginPath(); c.roundRect(0, 0, W, H, R); c.fill();
        c.strokeStyle = '#e2e8f0'; c.lineWidth = 1; c.stroke();

        const ink = '#0f172a', mut = '#64748b', green = '#059669', amber = '#b45309', indigo = '#4f46e5';

        // header
        c.fillStyle = mut; c.font = '700 12px system-ui, sans-serif';
        c.fillText('BATTLEX TRADER', PAD, 52);
        c.font = '700 26px system-ui, sans-serif'; c.fillStyle = ink;
        c.fillText(m.id.name, PAD, 84);
        c.font = '500 13px ui-monospace, monospace'; c.fillStyle = mut;
        c.fillText('ID ' + shortId(m.id.id), PAD, 106);

        // divider
        c.strokeStyle = '#e2e8f0'; c.beginPath(); c.moveTo(PAD, 124); c.lineTo(W - PAD, 124); c.stroke();

        // discipline score block
        const score = m.d && m.d.score != null ? m.d.score : null;
        c.fillStyle = mut; c.font = '600 11px system-ui, sans-serif';
        c.fillText('DISCIPLINE', PAD, 158);
        c.fillStyle = ink; c.font = '800 52px ui-monospace, monospace';
        c.fillText(score != null ? String(score) : '—', PAD, 214);
        c.fillStyle = mut; c.font = '500 12px system-ui, sans-serif';
        c.fillText(score != null ? '/ 100 · weighted across evaluated rules' : 'Log trades to build your discipline profile', PAD, 238);

        // dimensions 2 cols x 3 rows
        const cols = 2, rowH = 44, x0 = PAD, x1 = W / 2 + 10, y0 = 262;
        dim.slice(0, 6).forEach((d, i) => {
            const x = i % cols === 0 ? x0 : x1;
            const y = y0 + Math.floor(i / cols) * rowH;
            c.fillStyle = mut; c.font = '600 11px system-ui, sans-serif';
            c.fillText(String(d.label).toUpperCase(), x, y);
            c.fillStyle = ink; c.font = '700 16px ui-monospace, monospace';
            c.fillText(d.score != null ? String(d.score) : '—', x + 150, y);
            // mini bar (only when the dimension has been evaluated)
            c.fillStyle = '#e2e8f0';
            c.beginPath(); c.roundRect(x + 190, y - 10, 96, 6, 3); c.fill();
            if (d.score != null) {
                c.fillStyle = green;
                c.beginPath(); c.roundRect(x + 190, y - 10, Math.max(4, 96 * (d.score / 100)), 6, 3); c.fill();
            }
        });

        // streaks row
        const sy = y0 + 3 * rowH + 8;
        c.strokeStyle = '#e2e8f0'; c.beginPath(); c.moveTo(PAD, sy); c.lineTo(W - PAD, sy); c.stroke();
        const streak = m.d && m.d.cleanDayStreak != null ? m.d.cleanDayStreak : null;
        const best = m.d && m.d.bestCleanDayStreak != null ? m.d.bestCleanDayStreak : null;
        const viol = m.d && m.d.violations != null ? m.d.violations : null;
        c.fillStyle = mut; c.font = '600 11px system-ui, sans-serif';
        c.fillText('CLEAN STREAK', PAD, sy + 26);
        c.fillStyle = ink; c.font = '800 22px ui-monospace, monospace';
        c.fillText(streak != null ? streak + ' days' : '—', PAD, sy + 50);
        c.fillStyle = mut; c.font = '600 11px system-ui, sans-serif';
        c.fillText('BEST STREAK', W / 2, sy + 26);
        c.fillStyle = ink; c.font = '800 22px ui-monospace, monospace';
        c.fillText(best != null ? best + ' days' : '—', W / 2, sy + 50);
        c.fillStyle = mut; c.font = '600 11px system-ui, sans-serif';
        c.fillText('VIOLATIONS', W - 190, sy + 26);
        c.fillStyle = ink; c.font = '800 22px ui-monospace, monospace';
        c.fillText(viol != null ? String(viol) : '—', W - 190, sy + 50);

        // focus line
        if (m.weak) {
            c.strokeStyle = '#e2e8f0'; c.beginPath(); c.moveTo(PAD, sy + 66); c.lineTo(W - PAD, sy + 66); c.stroke();
            c.fillStyle = amber; c.font = '700 11px system-ui, sans-serif';
            c.fillText('FOCUS · ' + String(m.weak.label).toUpperCase(), PAD, sy + 90);
            c.fillStyle = mut; c.font = '500 12.5px system-ui, sans-serif';
            c.fillText('Your biggest improvement opportunity is ' + m.weak.label + '.', PAD, sy + 112);
        }

        const a = document.createElement('a');
        a.download = 'battlex-trader-card.png';
        a.href = cv.toDataURL('image/png');
        document.body.appendChild(a); a.click(); a.remove();
    }

    function copyCard() {
        const m = cardModel();
        const dimsLine = m.dims.map(d => d.label + ' ' + d.score).join(' · ');
        const text = [
            'BATTLEX TRADER CARD',
            'Name: ' + m.id.name,
            'Trader ID: ' + m.id.id,
            'Discipline: ' + (m.d && m.d.score != null ? m.d.score + '/100' : '—'),
            dimsLine,
            'Clean streak: ' + (m.d && m.d.cleanDayStreak != null ? m.d.cleanDayStreak + ' days' : '—') + ' · Best: ' + (m.d && m.d.bestCleanDayStreak != null ? m.d.bestCleanDayStreak + ' days' : '—'),
            'Violations: ' + (m.d && m.d.violations != null ? m.d.violations : '—'),
            'Focus: ' + (m.weak ? m.weak.label : '—')
        ].join('\n');
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
            else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        } catch (e) { /* clipboard unavailable */ }
        if (window.showToast) window.showToast('Trader card copied');
    }

    // ---------- DOM render ----------
    // opts: { viewHref: string (default 'discipline.html'), viewLabel: string }
    function render(target, opts) {
        if (!target) return;
        const o = opts || {};
        const m = cardModel();
        const score = m.d && m.d.score != null ? m.d.score : null;
        const dims = m.dims.slice(0, 6);
        const streak = m.d && m.d.cleanDayStreak != null ? m.d.cleanDayStreak : null;
        const best = m.d && m.d.bestCleanDayStreak != null ? m.d.bestCleanDayStreak : null;
        const viol = m.d && m.d.violations != null ? m.d.violations : null;

        const dimCells = dims.map(d =>
            '<div>' +
                '<div class="flex items-center justify-between mb-1">' +
                    '<span class="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--tm-muted)]">' + esc(d.label) + '</span>' +
                    '<span class="num text-[12.5px] font-extrabold text-[var(--tm-text)]">' + (d.score != null ? d.score : '—') + '</span>' +
                '</div>' +
                '<div class="h-[5px] rounded-full bg-[var(--tm-border-2)] overflow-hidden">' +
                    (d.score != null
                        ? '<div class="h-full rounded-full" style="width:' + Math.max(4, Math.round(d.score)) + '%;background:linear-gradient(90deg,var(--tm-accent-2),var(--tm-green))"></div>'
                        : '') +
                '</div>' +
            '</div>').join('');

        target.innerHTML =
            '<div class="glass-strong p-6 relative overflow-hidden fade-up" style="max-width:560px">' +
                '<div class="label-xs mb-1">Battlex trader</div>' +
                '<div class="flex flex-wrap items-center gap-4 mt-2">' +
                    '<div class="avatar !w-12 !h-12 !rounded-xl !text-[16px]">' + esc((m.id.name || 'T').slice(0, 2).toUpperCase()) + '</div>' +
                    '<div class="flex-1 min-w-0">' +
                        '<div class="text-[17px] font-extrabold leading-tight truncate">' + esc(m.id.name) + '</div>' +
                        '<div class="flex items-center gap-1.5 mt-0.5">' +
                            '<code class="num text-[11px] text-[var(--tm-dim)] bg-[var(--tm-card)] border border-[var(--tm-border-2)] rounded px-1.5 py-0.5 truncate max-w-[180px]">' + esc(shortId(m.id.id)) + '</code>' +
                            '<button class="btn-mini !py-0.5 !px-1.5 !text-[10px]" data-card-copy-id title="Copy trader ID"><svg data-lucide="copy" class="w-3 h-3"></svg></button>' +
                        '</div>' +
                    '</div>' +
                    '<span class="tag tag-emerald">Trader</span>' +
                '</div>' +

                '<div class="mt-5 pt-4 border-t border-[var(--hairline)]">' +
                    '<div class="label-xs mb-1">Discipline</div>' +
                    '<div class="flex items-end gap-2">' +
                        '<span class="num text-[44px] font-extrabold leading-none tracking-tight">' + (score != null ? score : '—') + '</span>' +
                        '<span class="text-[12px] text-[var(--tm-dim)] mb-1">/ 100</span>' +
                    '</div>' +
                    '<div class="text-[11.5px] text-[var(--tm-dim)] mt-1">' + (score != null ? 'Weighted across evaluated rules — from disciplineState().' : 'Log trades to build your discipline profile.') + '</div>' +
                '</div>' +

                (dims.length
                    ? '<div class="grid grid-cols-2 gap-x-5 gap-y-3 mt-5 pt-4 border-t border-[var(--hairline)]">' + dimCells + '</div>'
                    : '') +

                '<div class="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-[var(--hairline)]">' +
                    '<div><div class="label-xs mb-1">Clean streak</div><div class="num text-[15px] font-extrabold">' + (streak != null ? streak + 'd' : '—') + '</div></div>' +
                    '<div><div class="label-xs mb-1">Best streak</div><div class="num text-[15px] font-extrabold">' + (best != null ? best + 'd' : '—') + '</div></div>' +
                    '<div><div class="label-xs mb-1">Violations</div><div class="num text-[15px] font-extrabold ' + ((viol || 0) > 0 ? 'text-[var(--tm-red)]' : '') + '">' + (viol != null ? viol : '—') + '</div></div>' +
                '</div>' +

                (m.weak || m.strong
                    ? '<div class="mt-4 p-3 rounded-lg" style="background:var(--tm-bg);border:1px solid var(--tm-border-2)">' +
                        '<div class="flex flex-wrap items-center gap-x-5 gap-y-1">' +
                            (m.strong ? '<div><span class="label-xs">Strongest</span><div class="text-[13px] font-bold text-[var(--tm-green)] mt-0.5">' + esc(m.strong.label) + '</div></div>' : '') +
                            (m.weak ? '<div><span class="label-xs">Weakest</span><div class="text-[13px] font-bold text-[var(--tm-amber)] mt-0.5">' + esc(m.weak.label) + '</div></div>' : '') +
                        '</div>' +
                        (m.weak ? '<p class="text-[11.5px] text-[var(--tm-dim)] mt-2">Your biggest improvement opportunity is ' + esc(m.weak.label) + '.</p>' : '') +
                      '</div>'
                    : '') +

                '<div class="flex flex-wrap items-center gap-2 mt-5 pt-4 border-t border-[var(--hairline)]">' +
                    '<button class="btn-primary !py-2 !px-3.5 !text-[12px]" data-card-download><svg data-lucide="download" class="w-3.5 h-3.5"></svg> Download card</button>' +
                    '<button class="btn-ghost !py-2 !px-3.5 !text-[12px]" data-card-copy><svg data-lucide="copy" class="w-3.5 h-3.5"></svg> Copy card</button>' +
                    '<a class="btn-ghost !py-2 !px-3.5 !text-[12px] ml-auto" href="' + esc(o.viewHref || 'discipline.html') + '">' +
                        '<svg data-lucide="target" class="w-3.5 h-3.5"></svg> ' + esc(o.viewLabel || 'View full discipline') +
                    '</a>' +
                '</div>' +
            '</div>';

        const q = target.querySelector.bind(target);
        const dl = q('[data-card-download]'); if (dl) dl.addEventListener('click', downloadCard);
        const cp = q('[data-card-copy]'); if (cp) cp.addEventListener('click', copyCard);
        const cid = q('[data-card-copy-id]');
        if (cid) cid.addEventListener('click', () => {
            try { navigator.clipboard.writeText(m.id.id); } catch (e) { /* noop */ }
            if (window.showToast) window.showToast('Trader ID copied');
        });
        if (window.lucide) lucide.createIcons();
    }

    window.TMTraderCard = { render, downloadCard, copyCard, identity, discipline };
})();
