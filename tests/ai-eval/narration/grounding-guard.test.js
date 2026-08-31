'use strict';

// ============================================================================
// NARRATION TEST: Grounding Guard Contract
// ============================================================================
// OFFLINE STUB — does NOT call the real Gemini API.
//
// Tests the architecture contract:
//   Deterministic Facts → (Optional) LLM Narration → Grounding Guard
//                                                          ↓
//                                        Narration OR Deterministic Fallback
//
// The guard must:
//   1. Accept narration that only references numbers/facts in the bundle.
//   2. Reject narration containing invented $ numbers not in the bundle.
//   3. Reject narration referencing hallucinated finding ids.
//   4. Fall back to deterministic text when LLM throws.
//   5. Fall back when LLM returns empty/null.
//   6. Never propagate the hallucination to the caller.
//
// This test implements a minimal grounding guard stub inline, then validates
// the contract. When a real grounding guard module exists, swap the stub.
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const fx = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

// ---- Inline grounding guard stub -------------------------------------------
// In production, this would live in server/llm.js or a dedicated guard module.
// We define the contract here so the test is self-contained.

function extractNumbers(text) {
    return (text.match(/\$[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%?\s*R\b/g) || [])
        .map(s => s.replace(/[\$,%\s]/g, '').replace(/,/g, ''));
}

function extractFindingIds(text) {
    return (text.match(/ai-[\w-]+-\d+-[\w-]+/g) || []);
}

// Build the ground truth from the bundle
function buildBundleGroundTruth(bundle) {
    const ctx    = bundle.context;
    const nums   = new Set();
    // Collect all $ numbers from the deterministic text
    const srcText = JSON.stringify(bundle);
    extractNumbers(srcText).forEach(n => nums.add(n));
    // All real finding ids
    const allFindings = [
        ...bundle.patterns,
        ...bundle.psychology.findings,
        ...bundle.risk.findings,
        ...bundle.discipline.findings,
        ...bundle.sessions.findings,
        ...bundle.tilt
    ];
    const findingIds = new Set(allFindings.map(f => f.id));
    return { nums, findingIds, text: srcText };
}

// The guard: returns narration if grounded, else returns deterministic fallback.
async function groundedNarrate(bundle, llmFn) {
    const gt = buildBundleGroundTruth(bundle);
    const fallback = bundle.coach.message;   // deterministic fallback
    try {
        const narration = await llmFn(bundle);
        if (!narration || typeof narration !== 'string' || narration.trim().length === 0) {
            return { text: fallback, source: 'deterministic-fallback', reason: 'empty-llm' };
        }
        // Check for invented $ numbers
        const narNums = extractNumbers(narration);
        const invented = narNums.filter(n => !gt.nums.has(n));
        if (invented.length > 0) {
            return { text: fallback, source: 'deterministic-fallback', reason: 'hallucinated-numbers:' + invented.join(',') };
        }
        // Check for hallucinated finding ids
        const narIds = extractFindingIds(narration);
        const fakeIds = narIds.filter(id => !gt.findingIds.has(id));
        if (fakeIds.length > 0) {
            return { text: fallback, source: 'deterministic-fallback', reason: 'hallucinated-finding-ids:' + fakeIds.join(',') };
        }
        return { text: narration, source: 'llm', reason: 'grounded' };
    } catch (e) {
        return { text: fallback, source: 'deterministic-fallback', reason: 'llm-threw:' + e.message };
    }
}

// ---- Build a real bundle ---------------------------------------------------
const core   = fx.mixedRealistic();
const bundle = AI.mentorBundle(core, 'acc-prop', { period: 'all' });
const gt     = buildBundleGroundTruth(bundle);

// ---- Tests -----------------------------------------------------------------

// Test 1: Grounded narration is accepted
(async () => {
    // LLM returns text that only uses numbers already in the bundle
    const grounded = bundle.coach.message + ' Focus on your biggest pattern.';
    const r = await groundedNarrate(bundle, async () => grounded);
    check('grounded narration: accepted (source=llm)', r.source === 'llm', 'source: ' + r.source + ', reason: ' + r.reason);
    check('grounded narration: text returned',          typeof r.text === 'string' && r.text.length > 0);
})().then(() => {});

// Test 2: Narration with invented dollar amount → rejected
(async () => {
    const hallucinated = 'You made $9,999,999 last month — incredible performance!';
    const r = await groundedNarrate(bundle, async () => hallucinated);
    check('hallucinated $: rejected (fallback)', r.source === 'deterministic-fallback', 'source: ' + r.source);
    check('hallucinated $: reason mentions hallucinated-numbers', r.reason.startsWith('hallucinated-numbers'), 'reason: ' + r.reason);
    check('hallucinated $: text is deterministic fallback', r.text === bundle.coach.message);
})().then(() => {});

// Test 3: Narration referencing fake finding id → rejected
(async () => {
    const fakeId = 'ai-fake-finding-99-synth-xxxx';
    const hallucinated = 'Your finding ' + fakeId + ' shows serious risk.';
    const r = await groundedNarrate(bundle, async () => hallucinated);
    check('fake finding id: rejected', r.source === 'deterministic-fallback', 'source: ' + r.source);
    check('fake finding id: reason mentions ids', r.reason.startsWith('hallucinated-finding-ids'), 'reason: ' + r.reason);
})().then(() => {});

// Test 4: LLM throws → fallback, no propagation
(async () => {
    const r = await groundedNarrate(bundle, async () => { throw new Error('API timeout'); });
    check('llm-throws: fallback used',     r.source === 'deterministic-fallback', 'source: ' + r.source);
    check('llm-throws: text is string',    typeof r.text === 'string' && r.text.length > 0);
    check('llm-throws: reason mentions threw', r.reason.startsWith('llm-threw'), 'reason: ' + r.reason);
})().then(() => {});

// Test 5: LLM returns null → fallback
(async () => {
    const r = await groundedNarrate(bundle, async () => null);
    check('llm-null: fallback used',   r.source === 'deterministic-fallback', 'source: ' + r.source);
    check('llm-null: reason=empty-llm', r.reason === 'empty-llm', 'reason: ' + r.reason);
})().then(() => {});

// Test 6: LLM returns empty string → fallback
(async () => {
    const r = await groundedNarrate(bundle, async () => '');
    check('llm-empty-string: fallback used', r.source === 'deterministic-fallback', 'source: ' + r.source);
})().then(() => {});

// Test 7: Deterministic fallback is always a non-empty string
check('deterministic fallback is non-empty string',
    typeof bundle.coach.message === 'string' && bundle.coach.message.length > 0,
    'fallback: ' + bundle.coach.message.slice(0, 40));

// Test 8: Ground truth extraction produces numbers
check('ground truth extracts numbers from bundle',
    gt.nums.size > 0, 'nums: 0');

// Test 9: Guard works when bundle has no findings (n < 5)
(async () => {
    const coreSmall  = fx.smallSample(3);
    const bundleSmall = AI.mentorBundle(coreSmall, 'acc-prop', { period: 'all' });
    if (bundleSmall) {
        const r = await groundedNarrate(bundleSmall, async () => bundleSmall.coach.message);
        check('small-bundle: guard does not crash', typeof r.text === 'string');
    } else {
        check('small-bundle: null bundle handled', true);
    }
})().then(() => {});

module.exports = results;
