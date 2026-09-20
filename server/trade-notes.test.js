'use strict';

// ============================================================================
// 31TRADES — trade notes domain tests (deterministic — no network, no keys)
// ----------------------------------------------------------------------------
// Run:  node server/trade-notes.test.js
//
// Contract: a journal note is trader-authored content and nothing else.
//   1. Nothing fabricates note text — empty is empty.
//   2. renderMarkdown escapes before it decorates; a note cannot inject markup.
//   3. Tags round-trip through the single TEXT column the DB actually has.
//   4. Coverage/lift refuse to report a number the sample can't support.
// ============================================================================

const N = require('../assets/trade-notes.js');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra === undefined ? '' : extra)));
    if (!cond) failures++;
}

// ---- 1. Taxonomy & tag round-trip -----------------------------------------
check('taxonomy has a mistake/fomo discipline set', N.NOTE_TAGS.length >= 10, N.NOTE_TAGS.length);
check('every tag has key+label+kind+hint',
    N.NOTE_TAGS.every(t => t.key && t.label && t.kind && t.hint));
check('tag keys are unique',
    new Set(N.NOTE_TAGS.map(t => t.key)).size === N.NOTE_TAGS.length);

check('parses comma list', JSON.stringify(N.parseTags('thesis,mistake')) === JSON.stringify(['thesis', 'mistake']),
    JSON.stringify(N.parseTags('thesis,mistake')));
check('parses labels case-insensitively', JSON.stringify(N.parseTags('Moved Stop')) === JSON.stringify(['moved_stop']),
    JSON.stringify(N.parseTags('Moved Stop')));
check('splits on spaces/semicolons/newlines too',
    JSON.stringify(N.parseTags('fomo; revenge\noversized')) === JSON.stringify(['fomo', 'revenge', 'oversized']),
    JSON.stringify(N.parseTags('fomo; revenge\noversized')));
check('dedupes', JSON.stringify(N.parseTags('fomo,fomo,FOMO')) === JSON.stringify(['fomo']),
    JSON.stringify(N.parseTags('fomo,fomo,FOMO')));
check('canonical (taxonomy) order wins over input order',
    JSON.stringify(N.parseTags('lesson,thesis')) === JSON.stringify(['thesis', 'lesson']),
    JSON.stringify(N.parseTags('lesson,thesis')));
check('keeps an unknown custom tag instead of dropping the trader vocabulary',
    JSON.stringify(N.parseTags('london-open')) === JSON.stringify(['london_open']),
    JSON.stringify(N.parseTags('london-open')));
check('formatTags round-trips through parseTags',
    N.formatTags('thesis, fomo') === 'thesis,fomo', N.formatTags('thesis, fomo'));
check('formatTags caps the list', N.parseTags(N.formatTags(N.NOTE_TAGS.map(t => t.key))).length === N.MAX_TAGS,
    N.parseTags(N.formatTags(N.NOTE_TAGS.map(t => t.key))).length);
check('empty input stays empty (never a default tag set)',
    N.parseTags('') .length === 0 && N.parseTags(null).length === 0 && N.formatTags(undefined) === '',
    JSON.stringify([N.parseTags(''), N.formatTags(undefined)]));
check('toggleTag adds then removes',
    N.toggleTag('', 'fomo') === 'fomo' && N.toggleTag('fomo', 'fomo') === '',
    N.toggleTag('', 'fomo') + ' | ' + N.toggleTag('fomo', 'fomo'));
check('toggleTag preserves the others', N.toggleTag('thesis', 'fomo') === 'thesis,fomo',
    N.toggleTag('thesis', 'fomo'));
check('tagInfo describes a custom key', N.tagInfo('london_open').label === 'london open',
    N.tagInfo('london_open').label);

// ---- 2. Markdown safety ----------------------------------------------------
check('escapes HTML before decorating',
    N.renderMarkdown('<img src=x onerror=alert(1)>').indexOf('<img') === -1,
    N.renderMarkdown('<img src=x onerror=alert(1)>'));
check('escapes script tags',
    N.renderMarkdown('<script>alert(1)</script>').indexOf('<script') === -1,
    N.renderMarkdown('<script>alert(1)</script>'));
check('bold renders', N.renderMarkdown('**thesis**').indexOf('<strong>thesis</strong>') !== -1,
    N.renderMarkdown('**thesis**'));
check('italic renders', N.renderMarkdown('*calm*').indexOf('<em>calm</em>') !== -1,
    N.renderMarkdown('*calm*'));
check('inline code renders', N.renderMarkdown('`XAUUSD`').indexOf('<code>XAUUSD</code>') !== -1,
    N.renderMarkdown('`XAUUSD`'));
check('bullets become a list',
    N.renderMarkdown('- waited\n- executed').indexOf('<ul class="nt-ul">') !== -1,
    N.renderMarkdown('- waited\n- executed'));
check('numbered lines become an ol',
    N.renderMarkdown('1. thesis\n2. execution').indexOf('<ol class="nt-ol">') !== -1,
    N.renderMarkdown('1. thesis\n2. execution'));
check('an unterminated list still closes',
    (N.renderMarkdown('- one').match(/<ul/g) || []).length === (N.renderMarkdown('- one').match(/<\/ul>/g) || []).length,
    N.renderMarkdown('- one'));
check('headings render as h4/h5 (page keeps its h1)',
    N.renderMarkdown('## Session').indexOf('<h4') !== -1, N.renderMarkdown('## Session'));
check('links get rel=noopener',
    N.renderMarkdown('see https://example.com/x').indexOf('rel="noopener noreferrer"') !== -1,
    N.renderMarkdown('see https://example.com/x'));
check('javascript: URLs are not linkified',
    N.renderMarkdown('javascript:alert(1)').indexOf('<a href="javascript') === -1,
    N.renderMarkdown('javascript:alert(1)'));
check('empty note renders empty string', N.renderMarkdown('') === '' && N.renderMarkdown(null) === '',
    JSON.stringify([N.renderMarkdown(''), N.renderMarkdown(null)]));
check('plain text stays plain (no markdown invented)', N.renderMarkdown('today was flat').indexOf('<p class="nt-p">today was flat</p>') === 0,
    N.renderMarkdown('today was flat'));

// ---- 3. Stats --------------------------------------------------------------
const st = N.noteStats('Waited for the retest\n- entry at the OB\n- stop below the wick');
check('counts words across markdown syntax', st.words === 12, st.words);
check('counts bullet lines', st.bullets === 2, st.bullets);
check('counts lines', st.lines === 3, st.lines);
check('reports empty for whitespace only', N.noteStats('   \n  ').empty === true);
check('zero words for empty', N.noteStats('').words === 0);

// ---- 4. Quality ------------------------------------------------------------
const thin = N.noteStats('meh');
check('a one-word note is thin', N.noteQuality('meh').band === 'thin', N.noteQuality('meh').band);
check('empty note scores 0', N.noteQuality('').score === 0, N.noteQuality('').score);
const strongNote = 'Thesis: waiting for the London sweep of the Asian low into the 1h FVG with the 15m MSS as confluence, ' +
    'entry 2398.5 after the retest, stop 2392 below the wick, target the 2410 high. I felt calm going in and did not move the stop. ' +
    'Exited at 2409 for 2.1R on 0.5 lots. Next time I should hold the runner past the first target instead of closing at the level.';
const strong = N.noteQuality(strongNote);
check('a structured narrative scores strong', strong.band === 'strong', strong.score + ' ' + strong.band);
check('quality names its signals (self-explaining meter)',
    strong.signals.indexOf('thesis') !== -1 && strong.signals.indexOf('lesson') !== -1 && strong.signals.indexOf('numbers') !== -1,
    JSON.stringify(strong.signals));
check('quality never exceeds 100', N.noteQuality(strongNote + ' ' + strongNote).score <= 100,
    N.noteQuality(strongNote + ' ' + strongNote).score);
check('bullets alone do not fake a strong note', N.noteQuality('- one\n- two').band !== 'strong',
    N.noteQuality('- one\n- two').band);

// ---- 5. Coverage ----------------------------------------------------------
const trades = [
    { pnl: 100, note: 'Thesis: swept the low, entry on the retest, calm, next time hold longer', reflection_tags: 'thesis,patience' },
    { pnl: -50, note: 'Fomo entry, chased the breakout, moved stop, lesson: wait for retest', reflection_tags: 'fomo,moved_stop' },
    { pnl: 200, note: 'Textbook silver bullet, followed plan', reflection_tags: 'plan,textbook' },
    { pnl: -30, note: 'Revenge after the loss', reflection_tags: 'revenge' },
    { pnl: 40, note: 'Good', reflection_tags: '' },            // too short to count as documentation
    { pnl: -10, note: '' },
    { pnl: 60, note: '' },
    { pnl: -20, note: '' }
];
const cov = N.coverage(trades);
check('counts total', cov.total === 8, cov.total);
check('a 4-char note is not documentation', N.isDocumented({ note: 'Good' }) === false, N.isDocumented({ note: 'Good' }));
check('counts documented (>=8 chars, real content)', cov.documented === 4, cov.documented);
check('counts undocumented', cov.undocumented === 4, cov.undocumented);
check('pct is rounded', cov.pct === 50, cov.pct);
check('avg words only over documented notes', cov.avgWords > 3 && cov.avgWords < 20, cov.avgWords);
check('every reflection tag is counted', cov.tags.length === 7, JSON.stringify(cov.tags.map(t => t.key + ':' + t.count)));
check('tag ranking is by count, descending', (() => {
    const many = N.coverage([
        { pnl: 1, note: 'real note one here', reflection_tags: 'fomo' },
        { pnl: 1, note: 'real note two here', reflection_tags: 'fomo,thesis' },
        { pnl: 1, note: 'real note three here', reflection_tags: 'thesis' }
    ]);
    return many.tags[0].key === 'fomo' && many.tags[0].count === 2 && many.tags[1].count === 2;
})(), JSON.stringify(N.coverage([]).tags));
check('topTag exposed', cov.topTag && cov.topTag.count === 1, JSON.stringify(cov.topTag));
check('empty ledger is all zeros, not NaN',
    (c => c.pct === 0 && c.avgWords === 0 && c.lift === null && c.winRateDocumented === null)(N.coverage([])),
    JSON.stringify(N.coverage([])));
check('win rate ignores zero-P&L scratches',
    N.winRate([{ pnl: 0 }, { pnl: 0 }]) === null, N.winRate([{ pnl: 0 }, { pnl: 0 }]));

// lift must stay null on a thin sample rather than implying a finding
const thinSample = [{ pnl: 10, note: 'a real note about the thesis and the entry' }, { pnl: -5, note: '' }];
check('lift is null when the sample is too small', N.coverage(thinSample).lift === null,
    N.coverage(thinSample).lift);
const fatSample = [];
for (let i = 0; i < 12; i++) fatSample.push({ pnl: 100, note: 'thesis, entry, calm, lesson for next time here' });
for (let i = 0; i < 12; i++) fatSample.push({ pnl: -100, note: '' });
const fat = N.coverage(fatSample);
check('lift computed when both sides have >=5', fat.lift === 100, fat.lift);
check('documented win rate is honest', fat.winRateDocumented === 100 && fat.winRateUndocumented === 0,
    fat.winRateDocumented + '/' + fat.winRateUndocumented);

// ---- 6. Search ------------------------------------------------------------
check('filters by note text', N.filterTrades(trades, { query: 'chased' }).length === 1,
    N.filterTrades(trades, { query: 'chased' }).length);
check('filters by tag', N.filterTrades(trades, { tags: 'fomo' }).length === 1,
    N.filterTrades(trades, { tags: 'fomo' }).length);
check('filters undocumented only (incl. the too-short note)', N.filterTrades(trades, { documented: 'no' }).length === 4,
    N.filterTrades(trades, { documented: 'no' }).length);
check('filters documented only', N.filterTrades(trades, { documented: 'yes' }).length === 4,
    N.filterTrades(trades, { documented: 'yes' }).length);
check('empty query returns everything', N.filterTrades(trades, {}).length === 8,
    N.filterTrades(trades, {}).length);
check('a query with no hits returns nothing (no fuzzy fabrication)',
    N.filterTrades(trades, { query: 'zzzz' }).length === 0, N.filterTrades(trades, { query: 'zzzz' }).length);

check('excerpt flattens markdown and truncates',
    N.excerpt('**Thesis**\n- swept the low', 20) === 'Thesis swept the low', JSON.stringify(N.excerpt('**Thesis**\n- swept the low', 20)));
check('excerpt of empty is empty', N.excerpt('') === '', N.excerpt(''));

// ---- 7. Autosave chip ------------------------------------------------------
const label = (s, m) => N.autosaveLabel(s, m).text;
check('saving copy', label('saving') === 'Saving…', label('saving'));
check('dirty copy warns', label('dirty') === 'Unsaved changes', label('dirty'));
check('error copy is not a success message', /not saved/i.test(label('error')), label('error'));
check('saved copy carries the time', label('saved', { at: '14:02' }) === 'Saved 14:02', label('saved', { at: '14:02' }));
check('no time yet does not invent one', label('saved', {}) === 'Saved', label('saved', {}));
check('empty note says so', label('empty') === 'No note yet', label('empty'));
check('tones are distinct', new Set(['saving', 'saved', 'dirty', 'error', 'empty'].map(s => N.autosaveLabel(s).tone)).size === 5);

check('relativeTime renders minutes', N.relativeTime(Date.now() - 5 * 60000, Date.now()) === '5m ago',
    N.relativeTime(Date.now() - 5 * 60000, Date.now()));
check('relativeTime renders just now', N.relativeTime(Date.now() - 3000, Date.now()) === 'just now',
    N.relativeTime(Date.now() - 3000, Date.now()));
check('relativeTime of nothing is empty', N.relativeTime(null) === '' && N.relativeTime('nonsense') === '',
    N.relativeTime('nonsense'));

// ---- 8. Templates ----------------------------------------------------------
check('templates exist and are non-empty',
    N.TEMPLATES.length >= 3 && N.TEMPLATES.every(t => t.key && t.label && t.body.trim().length > 20),
    N.TEMPLATES.map(t => t.key).join(','));
check('every template carries a heading or bullet so it renders as structure',
    N.TEMPLATES.every(t => /\*\*|^- /m.test(t.body)), N.TEMPLATES.map(t => t.key).join(','));

console.log('\ntrade-notes: ' + (failures ? failures + ' FAILED' : 'all checks passed'));
process.exit(failures ? 1 : 0);
