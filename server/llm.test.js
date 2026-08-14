'use strict';

// ============================================================================
// 31TRADES — AI narration layer tests (no real network required)
// ----------------------------------------------------------------------------
// The LLM layer's contract: it only rephrases already-grounded answers, and a
// grounding guard throws away any narration that alters the numbers. Tests:
//   1. numericFacts extracts $/%/R facts from an answer.
//   2. guardPassed keeps faithful narration, rejects altered numbers.
//   3. parseResponse extracts the model_output step from the Interactions API.
//   4. narrate: builds the prompt with ONLY the given facts, honors an
//      injectable fetch (200/401/timeout → null, never throws), and falls
//      back to null when the key is missing.
//
// Run:  node server/llm.test.js
// ============================================================================

const LLM = require('./llm.js');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra || '')));
    if (!cond) failures++;
}

// ---- 1. numericFacts ---------------------------------------------------------
const A = 'Overall you have 40 trades in range: +$319 net with a 43% win rate and +0.11R average. Biggest leak: "Revenge entries after losses" — 5 occurrences costing +$22.';
const facts = LLM.numericFacts(A);
check('extracts $ amounts', facts.includes('+$319') && facts.includes('+$22'), JSON.stringify(facts));
check('extracts percentages', facts.includes('43%'), JSON.stringify(facts));
check('extracts R multiples', facts.includes('+0.11R'), JSON.stringify(facts));

// ---- 2. guardPassed -----------------------------------------------------------
const faithful = 'Great news on the overall picture — 40 trades in range, +$319 net with a 43% win rate and +0.11R average. The biggest leak right now: "Revenge entries after losses" at 5 occurrences costing +$22.';
check('guard keeps faithful narration', LLM.guardPassed(A, faithful) === true);
const altered = 'Great news — 42 trades in range, +$500 net with a 50% win rate.';
check('guard rejects altered numbers', LLM.guardPassed(A, altered) === false);
const dropped = 'You have 40 trades in range, looking good overall.';
check('guard rejects dropped numbers', LLM.guardPassed(A, dropped) === false);
const noNums = LLM.guardPassed('No account yet — create one first.', 'No account yet, so start by creating one!');
check('guard passes when original has no numbers', noNums === true);

// ---- 3. parseResponse ----------------------------------------------------------
// NOTE: the narration must preserve EVERY number from the original answer,
// or the grounding guard (correctly) rejects it. So the mock model output
// below rephrases A while keeping all its figures verbatim.
const FAITHFUL_NARRATION = 'Great news on the overall picture — 40 trades in range, +$319 net with a 43% win rate and +0.11R average. The biggest leak right now: "Revenge entries after losses" at 5 occurrences costing +$22.';
const goodResp = {
    status: 'completed',
    steps: [
        { type: 'user_input', status: 'done', content: [{ type: 'text', text: 'hi' }] },
        { type: 'model_output', status: 'done', content: [{ type: 'text', text: FAITHFUL_NARRATION }] }
    ]
};
check('parses model_output text', LLM.parseResponse(goodResp) === FAITHFUL_NARRATION);
check('null on non-completed', LLM.parseResponse({ status: 'failed', steps: [] }) === null);
check('null on missing steps', LLM.parseResponse({ status: 'completed' }) === null);

// ---- 4. narrate with injectable fetch ------------------------------------------
(async () => {
    // 4a. no key → null (never throws, never calls fetch)
    delete process.env.GEMINI_API_KEY;
    const noKey = await LLM.narrate('coach', { answer: A });
    check('no key → null', noKey === null);

    // 4b. key + faithful 200 response → narrated text, prompt carries facts
    process.env.GEMINI_API_KEY = 'test-key';
    let seenBody = null;
    const okFetch = async (url, opts) => {
        seenBody = JSON.parse(opts.body);
        return { ok: true, text: async () => JSON.stringify(goodResp) };
    };
    const narrated = await LLM.narrate('coach', { answer: A }, { fetchImpl: okFetch });
    check('faithful response → narrated text', narrated === FAITHFUL_NARRATION);
    // A contains double quotes, which JSON.stringify escapes — so check the
    // unescaped inner text + the hard-rules line instead of raw A.
    check('prompt contains the facts', seenBody && seenBody.input && seenBody.input.indexOf('Overall you have 40 trades in range: +$319 net with a 43% win rate') !== -1 && seenBody.input.indexOf('NEVER invent') !== -1);
    check('uses Interactions endpoint shape', seenBody && seenBody.model && seenBody.store === false);

    // 4c. 401 → null
    const badFetch = async () => ({ ok: false, status: 401, text: async () => '{}' });
    check('401 → null', (await LLM.narrate('coach', { answer: A }, { fetchImpl: badFetch })) === null);

    // 4d. server error body → null
    const errFetch = async () => ({ ok: true, text: async () => JSON.stringify({ status: 'failed', steps: [] }) });
    check('failed status → null', (await LLM.narrate('coach', { answer: A }, { fetchImpl: errFetch })) === null);

    // 4e. model alters numbers → grounding guard discards, returns null
    const lyingFetch = async () => ({ ok: true, text: async () => JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', status: 'done', content: [{ type: 'text', text: 'You made $500 on 42 trades.' }] }] }) });
    check('altered numbers → null (guard)', (await LLM.narrate('coach', { answer: A }, { fetchImpl: lyingFetch })) === null);

    // 4f. narrateBotAnswer wrapper builds facts + role from the answer object
    const wrapped = await LLM.narrateBotAnswer({ question: 'How am I doing?', intent: 'overall', answer: A, kpis: [{ label: 'Net', value: '+$319' }], evidence: ['txn-1'] }, { fetchImpl: okFetch });
    check('wrapper narrates', wrapped === FAITHFUL_NARRATION);
    check('wrapper passes kpis+evidence as facts', seenBody && seenBody.input && seenBody.input.indexOf('+$319') !== -1 && seenBody.input.indexOf('txn-1') !== -1);

    // 4g. real API shape: model_output steps have NO status field — must parse
    const realShapeResp = { status: 'completed', steps: [{ type: 'thought', signature: 'x' }, { type: 'model_output', content: [{ type: 'text', text: FAITHFUL_NARRATION }] }] };
    const realShapeFetch = async () => ({ ok: true, text: async () => JSON.stringify(realShapeResp) });
    const realNarrated = await LLM.narrate('coach', { answer: A }, { fetchImpl: realShapeFetch });
    check('parses real API shape (no step status)', realNarrated === FAITHFUL_NARRATION);

    // 4h. timeout → null (fetch that never resolves; AbortController fires)
    const hangFetch = (url, opts) => new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ ok: false, status: 0 }));
    });
    const t0 = Date.now();
    const timedOut = await LLM.narrate('coach', { answer: A }, { fetchImpl: hangFetch, timeoutMs: 300 });
    check('timeout → null within budget', timedOut === null && (Date.now() - t0) < 5000);

    delete process.env.GEMINI_API_KEY;
    console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL LLM CHECKS PASS');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness error: ' + e.stack); process.exit(1); });
