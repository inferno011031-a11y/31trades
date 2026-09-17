'use strict';

// ============================================================================
// 31TRADES — voice trade parser v3 PREMIUM tests (no network, no keys)
// ----------------------------------------------------------------------------
// Run:  node server/voice-parser.test.js
// ============================================================================

const VP = require('./voice-parser.js');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra || '')));
    if (!cond) failures++;
}

(async () => {
    // ---- v2 regression suite -------------------------------------------------
    const r1 = await VP.extract('bagged 120 bucks profit on euro dollar, bought the fvg, textbook', { preferLLM: false });
    check('bagged 120 → +$120', r1.parsed.pnl === '+$120', JSON.stringify(r1.parsed.pnl));
    check('euro dollar → EURUSD', r1.parsed.symbol === 'EURUSD', JSON.stringify(r1.parsed.symbol));
    check('bought → Long', r1.parsed.direction === 'Long', JSON.stringify(r1.parsed.direction));
    check('textbook → High', r1.parsed.confidence === 'High', JSON.stringify(r1.parsed.confidence));
    check('FVG confluence present', r1.parsed.confluences.indexOf('FVG') !== -1, JSON.stringify(r1.parsed.confluences));

    const r2 = await VP.extract('wrecked for 180 on gold, fomoed in during london, moved my stop, frustrated', { preferLLM: false });
    check('wrecked for 180 → -$180', r2.parsed.pnl === '-$180', JSON.stringify(r2.parsed.pnl));
    check('fomo + moved_stop', r2.parsed.mistakes.indexOf('fomo') !== -1 && r2.parsed.mistakes.indexOf('moved_stop') !== -1, JSON.stringify(r2.parsed.mistakes));
    check('rules false → grade ≤ C', ['C', 'D'].indexOf(r2.parsed.quality) !== -1, r2.parsed.quality);

    const r3 = await VP.extract('risked 50 aiming for 150 on nas, took two contracts, broke even, decent execution', { preferLLM: false });
    check('breakeven → $0', r3.parsed.pnl === '$0', JSON.stringify(r3.parsed.pnl));
    check('risk 50 extracted', r3.parsed.risk === 50, JSON.stringify(r3.parsed.risk));
    check('target 150 → rr 3', r3.parsed.rr === 3, JSON.stringify(r3.parsed.rr));
    check('pnl bridge $0 → 0', r3.parsed.pnl_number === 0, JSON.stringify(r3.parsed.pnl_number));

    const r4 = await VP.extract('five micros on the dow overnight, sold it, lost 65', { preferLLM: false });
    check('5 micro lots', r4.parsed.size === '5 micro lots', JSON.stringify(r4.parsed.size));
    check('micro bridge 0.5', r4.parsed.size_number === 0.5, JSON.stringify(r4.parsed.size_number));
    check('overnight session', r4.parsed.session === 'Overnight', JSON.stringify(r4.parsed.session));

    // ---- v3 new: direction extras -------------------------------------------
    const d1 = await VP.extract('loaded up on the euro, bought at 1.08', { preferLLM: false });
    check('loaded → Long', d1.parsed.direction === 'Long', JSON.stringify(d1.parsed.direction));
    check('bought at 1.08 → entry', d1.parsed.entry === 1.08, JSON.stringify(d1.parsed.entry));
    const d2 = await VP.extract('shorting the yen, dumped it for a loss of 90', { preferLLM: false });
    check('shorting → Short', d2.parsed.direction === 'Short', JSON.stringify(d2.parsed.direction));
    check('dumped → Short stays Short', d2.parsed.direction === 'Short', JSON.stringify(d2.parsed.direction));

    // ---- v3 new: standard lots / scaled into --------------------------------
    const s1 = await VP.extract('scaled into 1.5 standard lots on gold, entered at 2400, stop at 2395, target 2420', { preferLLM: false });
    check('1.5 standard lots → "1.5 lots"', s1.parsed.size === '1.5 lots', JSON.stringify(s1.parsed.size));
    check('entry 2400', s1.parsed.entry === 2400, JSON.stringify(s1.parsed.entry));
    check('stop 2395', s1.parsed.stop === 2395, JSON.stringify(s1.parsed.stop));
    check('target 2420', s1.parsed.target === 2420, JSON.stringify(s1.parsed.target));
    check('rr from prices = 4', s1.parsed.rr === 4, JSON.stringify(s1.parsed.rr));

    // ---- v3 new: netting / total profit / hit for / tapped out flat ---------
    const p1 = await VP.extract('netting +750 on the week on us30, clean execution', { preferLLM: false });
    check('netting +750 → +$750', p1.parsed.pnl === '+$750', JSON.stringify(p1.parsed.pnl));
    const p2 = await VP.extract('that is 400 total profit on aapl', { preferLLM: false });
    check('400 total profit → +$400', p2.parsed.pnl === '+$400', JSON.stringify(p2.parsed.pnl));
    const p3 = await VP.extract('got hit for 120 on tesla', { preferLLM: false });
    check('hit for 120 → -$120', p3.parsed.pnl === '-$120', JSON.stringify(p3.parsed.pnl));
    const p4 = await VP.extract('gave it a go on the euro, tapped out flat, calm throughout', { preferLLM: false });
    check('tapped out flat → $0', p4.parsed.pnl === '$0', JSON.stringify(p4.parsed.pnl));

    // ---- v3 new: risk percent ------------------------------------------------
    const rk = await VP.extract('risked 2% of account on the pound, lost 65', { preferLLM: false });
    check('risked 2% → risk_pct', rk.parsed.risk_pct === 2, JSON.stringify(rk.parsed.risk_pct));

    // ---- v3 new: R multiple ---------------------------------------------------
    const rm = await VP.extract('closed at +2.5R on silver bullet, flawless execution', { preferLLM: false });
    check('r_multiple +2.5', rm.parsed.r_multiple === 2.5, JSON.stringify(rm.parsed.r_multiple));
    check('silver bullet setup', rm.parsed.setup === 'Silver Bullet', JSON.stringify(rm.parsed.setup));
    check('flawless → High', rm.parsed.confidence === 'High', JSON.stringify(rm.parsed.confidence));

    // ---- v3 new: confluences --------------------------------------------------
    const cf = await VP.extract('long gold, swept the lows into a 4h fvg, breaker + bos, discount zone, nfp news', { preferLLM: false });
    const conf = cf.parsed.confluences;
    check('confluence: Liquidity Sweep', conf.indexOf('Liquidity Sweep') !== -1, JSON.stringify(conf));
    check('confluence: FVG', conf.indexOf('FVG') !== -1, JSON.stringify(conf));
    check('confluence: Breaker', conf.indexOf('Breaker') !== -1, JSON.stringify(conf));
    check('confluence: BOS', conf.indexOf('BOS') !== -1, JSON.stringify(conf));
    check('confluence: Discount', conf.indexOf('Discount') !== -1, JSON.stringify(conf));
    check('confluence: News', conf.indexOf('News') !== -1, JSON.stringify(conf));

    // ---- v3 new: quality grades (P&L-independent) ----------------------------
    const g1 = await VP.extract('followed my checklist perfectly, waited for confirmation, textbook long on eur, lost 100', { preferLLM: false });
    check('disciplined loss still grades A', ['A+', 'A'].indexOf(g1.parsed.quality) !== -1, g1.parsed.quality + ' (pnl was ' + g1.parsed.pnl + ')');
    const g2 = await VP.extract('revenge traded the nq after a loss, chased price, oversized, wrecked for 200', { preferLLM: false });
    check('revenge/messy grades D', g2.parsed.quality === 'D', g2.parsed.quality);

    // ---- v3 new: multi-trade transcript --------------------------------------
    const mt = await VP.extract('First trade, short gold, wrecked for 80. Then long eur, made 120. Clean overall.', { preferLLM: false });
    check('multi-trade detected', mt.trades && mt.trades.length === 2, JSON.stringify(mt.trades && mt.trades.length));
    check('multi: trade1 loss', mt.trades[0].pnl === '-$80', JSON.stringify(mt.trades[0].pnl));
    check('multi: trade2 win', mt.trades[1].pnl === '+$120', JSON.stringify(mt.trades[1].pnl));
    check('multi: meta flag', mt.meta.fields_found.some(f => String(f).indexOf('multi_trade:') === 0), JSON.stringify(mt.meta.fields_found));

    // ---- clamp -----------------------------------------------------------------
    const c = VP.normalizeParsed({
        symbol: 'gold', direction: 'sideways', size: 'huge', pnl: '$1,250.50',
        session: 'Tokyo', setup: 42, emotion: 'FRUSTRATED', confidence: 'certain',
        rules_followed: 'false', mistakes: ['fomo', 'made_up', 'fomo'],
        confluences: ['FVG', 'MadeUp', 'BOS'], risk: '-5', rr: -2, entry: 0,
        ratings: { focus: 11, confidence: '7', discipline: 0 }
    });
    check('clamp: XAUUSD', c.symbol === 'XAUUSD', JSON.stringify(c.symbol));
    check('clamp: bad direction null', c.direction === null, JSON.stringify(c.direction));
    check('clamp: bad size null', c.size === null, JSON.stringify(c.size));
    check('clamp: +$1250.5', c.pnl === '+$1250.5', JSON.stringify(c.pnl));
    check('clamp: unknown session null', c.session === null, JSON.stringify(c.session));
    check('clamp: emotion vocab', c.emotion === 'frustrated', JSON.stringify(c.emotion));
    check('clamp: bad confidence null', c.confidence === null, JSON.stringify(c.confidence));
    check('clamp: "false" → false', c.rules_followed === false, JSON.stringify(c.rules_followed));
    check('clamp: confluences filtered', c.confluences.length === 2 && c.confluences.indexOf('FVG') !== -1 && c.confluences.indexOf('BOS') !== -1, JSON.stringify(c.confluences));
    check('clamp: negative risk dropped', c.risk === null, JSON.stringify(c.risk));
    check('clamp: negative rr dropped', c.rr === null, JSON.stringify(c.rr));
    check('clamp: zero entry dropped', c.entry === null, JSON.stringify(c.entry));

    // ---- LLM fallback path ------------------------------------------------------
    const llmResp = { choices: [{ message: { content: '```json\n{"symbol":"XAUUSD","direction":"Short","pnl":"-$180","quality":"C","notes":"fomo short"}\n```' } }] };
    const r9 = await VP.extract('lost money on gold', {
        fetchImpl: async () => ({ ok: true, json: async () => llmResp }),
        timeoutMs: 500
    });
    check('LLM or fallback path works', ['llm', 'deterministic'].indexOf(r9.meta.parser) !== -1, r9.meta.parser);
    const r10 = await VP.extract('sold us30, lost fifty', { fetchImpl: async () => { throw new Error('down'); }, timeoutMs: 50 });
    check('LLM failure → deterministic', r10.meta.parser === 'deterministic', r10.meta.parser);
    check('fifty → -$50', r10.parsed.pnl === '-$50', JSON.stringify(r10.parsed.pnl));
    const r11 = await VP.extract('   ');
    check('empty → null parsed', r11.parsed === null, JSON.stringify(r11));

    console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nAll voice-parser v3 PREMIUM tests passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Test harness error:', e); process.exit(1); });
