'use strict';

// ============================================================================
// 31TRADES — Trade Notes domain (browser + Node)
// ----------------------------------------------------------------------------
// The single source of truth for everything a journal note is made of:
//
//   · NOTE_TAGS / parseTags / formatTags  — the canonical reflection taxonomy
//     stored in the `trades.reflection_tags` TEXT column (comma-separated).
//   · renderMarkdown()                    — a deliberately tiny, SAFE renderer.
//     Input is escaped FIRST, so a note can never inject markup. Supports
//     **bold**, *italic*, `code`, "- " bullets, "1." lists, "## headings" and
//     bare http(s) links. Anything else stays literal text.
//   · noteStats() / noteQuality()         — how much was written and whether it
//     actually contains a thesis, an outcome and a lesson. Feeds the editor
//     meter and the mentor's "documented trades win more" finding.
//   · coverage()                          — the note-coverage analytics behind
//     the Trade Log strip: documented %, avg words, tag leaders, and the
//     win-rate lift of documented vs undocumented trades.
//   · filterTrades() / excerpt()          — search across notes and tags.
//   · autosaveLabel()                     — the status chip state machine.
//
// NO fabrication: a missing note is '', never sample text. Any code that
// invents journal content is a bug — see 013 notes + the imports contract.
// ============================================================================

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;   // Node / tests
    if (root) root.TradeNotes = api;                                          // Browser
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {

    // ---- Reflection taxonomy -------------------------------------------------
    // `key` is what gets stored; `label` is what the trader reads.
    // kind drives the chip colour: good / watch / neutral.
    const NOTE_TAGS = [
        { key: 'thesis',    label: 'Thesis',        kind: 'neutral', hint: 'Why this trade existed before you clicked' },
        { key: 'plan',      label: 'Followed plan', kind: 'good',    hint: 'Entry, stop and size were as planned' },
        { key: 'patience',  label: 'Patience',      kind: 'good',    hint: 'Waited for the setup to come to you' },
        { key: 'fomo',      label: 'FOMO',          kind: 'watch',   hint: 'Chased price or entered early' },
        { key: 'moved_stop', label: 'Moved stop',   kind: 'watch',   hint: 'Stop was widened after entry' },
        { key: 'revenge',   label: 'Revenge',       kind: 'watch',   hint: 'Taken to make back a loss' },
        { key: 'oversized', label: 'Oversized',     kind: 'watch',   hint: 'Risk above the plan' },
        { key: 'early_exit', label: 'Early exit',   kind: 'watch',   hint: 'Closed before the target logic played out' },
        { key: 'mistake',   label: 'Mistake',       kind: 'watch',   hint: 'Execution error worth counting' },
        { key: 'lesson',    label: 'Lesson',        kind: 'good',    hint: 'Something to carry into the next session' },
        { key: 'emotional', label: 'Emotional',     kind: 'neutral', hint: 'Emotion drove part of the decision' },
        { key: 'textbook',  label: 'Textbook',      kind: 'good',    hint: 'A+ execution worth repeating' }
    ];

    const TAG_BY_KEY = NOTE_TAGS.reduce((m, t) => (m[t.key] = t, m), {});
    const TAG_BY_LABEL = NOTE_TAGS.reduce((m, t) => (m[String(t.label).toLowerCase().replace(/[^a-z0-9]+/g, '')] = t, m), {});
    const MAX_TAGS = 8;

    function canonicalKey(raw) {
        const s = String(raw == null ? '' : raw).trim().toLowerCase();
        if (!s) return '';
        if (TAG_BY_KEY[s]) return s;
        const squashed = s.replace(/^#/, '').replace(/[^a-z0-9]+/g, '');
        if (TAG_BY_LABEL[squashed]) return TAG_BY_LABEL[squashed].key;
        // Unknown tag: keep it as a sanitized custom key rather than dropping
        // the trader's own vocabulary.
        const custom = s.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
        return custom || '';
    }

    // "Thesis, moved stop" → ['thesis','moved_stop'] — canonical order, deduped.
    function parseTags(raw) {
        if (raw == null || raw === '') return [];
        const parts = Array.isArray(raw) ? raw : String(raw).split(/[,;|\n]+/);
        const seen = new Set();
        parts.forEach(p => { const k = canonicalKey(p); if (k) seen.add(k); });
        return NOTE_TAGS.filter(t => seen.has(t.key)).map(t => t.key)
            .concat([...seen].filter(k => !TAG_BY_KEY[k]).sort());
    }

    function formatTags(raw) {
        return parseTags(raw).slice(0, MAX_TAGS).join(',');
    }

    function toggleTag(raw, key) {
        const k = canonicalKey(key);
        const list = parseTags(raw);
        const i = list.indexOf(k);
        if (i === -1) list.push(k); else list.splice(i, 1);
        return formatTags(list);
    }

    function tagInfo(key) {
        const k = canonicalKey(key);
        return TAG_BY_KEY[k] || { key: k, label: k.replace(/_/g, ' '), kind: 'neutral', hint: '' };
    }

    // ---- Safe markdown-lite --------------------------------------------------
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Escapes first, then decorates. Output is safe for innerHTML.
    function renderMarkdown(text) {
        const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
        if (!src.trim()) return '';
        const out = [];
        const lines = src.split('\n');
        let listType = null;   // 'ul' | 'ol' | null

        const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };

        const inline = (line) => escapeHtml(line)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

        lines.forEach(rawLine => {
            const line = rawLine.replace(/\s+$/, '');
            if (!line.trim()) { closeList(); out.push('<div class="nt-gap"></div>'); return; }

            const heading = line.match(/^(#{1,3})\s+(.*)$/);
            if (heading) {
                closeList();
                const level = heading[1].length + 2;   // ## → h4, keeps page h1 clean
                out.push('<h' + level + ' class="nt-h">' + inline(heading[2]) + '</h' + level + '>');
                return;
            }

            const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
            if (bullet) {
                if (listType !== 'ul') { closeList(); out.push('<ul class="nt-ul">'); listType = 'ul'; }
                out.push('<li>' + inline(bullet[1]) + '</li>');
                return;
            }

            const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (numbered) {
                if (listType !== 'ol') { closeList(); out.push('<ol class="nt-ol">'); listType = 'ol'; }
                out.push('<li>' + inline(numbered[1]) + '</li>');
                return;
            }

            closeList();
            out.push('<p class="nt-p">' + inline(line) + '</p>');
        });

        closeList();
        return out.join('');
    }

    // ---- Stats & quality -----------------------------------------------------
    function stripMarkdown(text) {
        return String(text == null ? '' : text)
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*\n]+)\*/g, '$1')
            .replace(/^#{1,3}\s+/gm, '')
            .replace(/^\s*[-*•]\s+/gm, '')
            .replace(/^\s*\d+[.)]\s+/gm, '');
    }

    function words(text) {
        const t = stripMarkdown(text).trim();
        return t ? t.split(/\s+/).length : 0;
    }

    function noteStats(text) {
        const raw = String(text == null ? '' : text);
        const w = words(raw);
        return {
            chars: raw.length,
            words: w,
            lines: raw.trim() ? raw.trim().split(/\n+/).length : 0,
            bullets: (raw.match(/^\s*[-*•]\s+/gm) || []).length,
            readSec: w ? Math.max(1, Math.round(w / 4)) : 0,   // ~240 wpm
            empty: !raw.trim()
        };
    }

    // A note is "useful" when it says WHY, WHAT happened, and WHAT'S NEXT.
    // Signals are reported so the meter can explain itself instead of scoring
    // the trader out of nowhere.
    const QUALITY_SIGNALS = [
        { key: 'thesis',  label: 'Entry thesis',   test: /thesis|setup|why|reason|bias|confluence|level|zone/i },
        { key: 'result',  label: 'Execution/result', test: /entry|exit|stop|target|filled|closed|scaled|took profit|breakeven|stop.?out/i },
        { key: 'emotion', label: 'Psychology',     test: /\bfelt|emotion|anxious|calm|nervous|frustrat|impatient|confiden|hesita|revenge|fomo\b/i },
        { key: 'lesson',  label: 'Lesson / next step', test: /next time|lesson|remember|avoid|should have|would have|repeat|rule for/i },
        { key: 'numbers', label: 'Size & risk',    test: /\d+(\.\d+)?\s*(lot|lots|contract|contracts|share|shares|%|r\b|usd|\$)/i }
    ];

    function noteQuality(text) {
        const raw = String(text == null ? '' : text);
        const st = noteStats(raw);
        if (st.empty) return { score: 0, signals: [], detail: st, band: 'empty' };
        const hits = QUALITY_SIGNALS.filter(s => s.test.test(raw)).map(s => s.key);
        // Depth: 120+ words is a full reflection, 40+ is adequate.
        const depth = st.words >= 120 ? 1 : st.words >= 40 ? 0.6 : st.words >= 12 ? 0.3 : 0;
        const breadth = hits.length / QUALITY_SIGNALS.length;
        const score = Math.round(Math.min(100, (breadth * 70 + depth * 30)));
        const band = score >= 70 ? 'strong' : score >= 40 ? 'fair' : 'thin';
        return { score, signals: hits, detail: st, band };
    }

    // ---- Templates -----------------------------------------------------------
    const TEMPLATES = [
        {
            key: 'full', label: 'Full review',
            body: '**Thesis**\n- \n\n**Execution**\n- Entry:\n- Stop:\n- Exit:\n\n**Psychology**\n- \n\n**Lesson**\n- '
        },
        { key: 'thesis', label: 'Entry thesis', body: '**Thesis**\n- Why this trade existed:\n- Confluence:\n- Invalidation:' },
        { key: 'mistake', label: 'Mistake review', body: '**What went wrong**\n- \n\n**What I should have done**\n- \n\n**Rule for next time**\n- ' },
        { key: 'emotion', label: 'Psychology check', body: '**State going in**\n- \n\n**State after the loss/win**\n- \n\n**What drove the decision**\n- ' },
        { key: 'session', label: 'Session recap', body: '**Session**\n- \n\n**Best trade**\n- \n\n**Worst trade**\n- \n\n**Carry into tomorrow**\n- ' }
    ];

    // ---- Coverage analytics --------------------------------------------------
    function isDocumented(t) {
        return !!(t && String(t.note || '').trim().length >= 8);
    }

    function winRate(list) {
        const decided = list.filter(t => Number(t.pnl || 0) !== 0);
        if (!decided.length) return null;
        return Math.round((decided.filter(t => Number(t.pnl || 0) > 0).length / decided.length) * 1000) / 10;
    }

    function coverage(trades) {
        const list = Array.isArray(trades) ? trades : [];
        const documented = list.filter(isDocumented);
        const undocumented = list.filter(t => !isDocumented(t));
        const tagCounts = new Map();
        documented.forEach(t => parseTags(t.reflection_tags).forEach(k => tagCounts.set(k, (tagCounts.get(k) || 0) + 1)));
        const tags = [...tagCounts.entries()]
            .map(([key, count]) => ({ key, label: tagInfo(key).label, kind: tagInfo(key).kind, count }))
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        const wordTotal = documented.reduce((n, t) => n + words(t.note), 0);
        const withRate = winRate(documented);
        const withoutRate = winRate(undocumented);
        return {
            total: list.length,
            documented: documented.length,
            undocumented: undocumented.length,
            pct: list.length ? Math.round((documented.length / list.length) * 100) : 0,
            avgWords: documented.length ? Math.round(wordTotal / documented.length) : 0,
            tags,
            topTag: tags.length ? tags[0] : null,
            winRateDocumented: withRate,
            winRateUndocumented: withoutRate,
            // Positive = documenting correlates with better outcomes. Null when
            // either side is too thin to mean anything (honest, never invented).
            lift: (withRate != null && withoutRate != null && documented.length >= 5 && undocumented.length >= 5)
                ? Math.round((withRate - withoutRate) * 10) / 10
                : null
        };
    }

    // ---- Search / list helpers ----------------------------------------------
    function excerpt(text, max) {
        const lim = max || 90;
        const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();
        if (flat.length <= lim) return flat;
        return flat.slice(0, lim - 1).trimEnd() + '…';
    }

    function filterTrades(trades, opts) {
        const o = opts || {};
        const q = String(o.query || '').trim().toLowerCase();
        const tags = parseTags(o.tags);
        return (Array.isArray(trades) ? trades : []).filter(t => {
            if (o.documented === 'yes' && !isDocumented(t)) return false;
            if (o.documented === 'no' && isDocumented(t)) return false;
            if (tags.length) {
                const mine = parseTags(t.reflection_tags);
                if (!tags.some(k => mine.indexOf(k) !== -1)) return false;
            }
            if (!q) return true;
            const hay = [t.symbol, t.note, t.setup, t.session, t.emotion, t.reflection_tags]
                .map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
            return hay.indexOf(q) !== -1;
        });
    }

    // ---- Autosave chip -------------------------------------------------------
    // state: 'empty' | 'clean' | 'dirty' | 'saving' | 'saved' | 'error'
    function autosaveLabel(state, meta) {
        const m = meta || {};
        switch (state) {
            case 'saving':  return { text: 'Saving…', tone: 'busy', dot: '#38bdf8' };
            case 'saved':   return { text: m.at ? 'Saved ' + m.at : 'Saved', tone: 'ok', dot: '#22c55e' };
            case 'dirty':   return { text: 'Unsaved changes', tone: 'warn', dot: '#f59e0b' };
            case 'error':   return { text: 'Not saved — retry', tone: 'bad', dot: '#ef4444' };
            case 'empty':   return { text: 'No note yet', tone: 'muted', dot: '#475569' };
            default:        return { text: m.at ? 'Saved ' + m.at : 'Autosave on', tone: 'muted', dot: '#475569' };
        }
    }

    function relativeTime(ts, now) {
        if (!ts) return '';
        const then = new Date(ts).getTime();
        if (isNaN(then)) return '';
        const diff = Math.max(0, ((now ? new Date(now) : new Date()).getTime() - then) / 1000);
        if (diff < 45) return 'just now';
        if (diff < 3600) return Math.round(diff / 60) + 'm ago';
        if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
        return Math.round(diff / 86400) + 'd ago';
    }

    return {
        NOTE_TAGS, MAX_TAGS, TEMPLATES, QUALITY_SIGNALS,
        parseTags, formatTags, toggleTag, tagInfo,
        escapeHtml, renderMarkdown, stripMarkdown, words,
        noteStats, noteQuality,
        isDocumented, coverage, winRate,
        excerpt, filterTrades,
        autosaveLabel, relativeTime
    };
});
