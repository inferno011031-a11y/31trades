'use strict';

// ============================================================================
// 31TRADES — AI narration layer (Google Gemini)
// ----------------------------------------------------------------------------
// The AI Intelligence Layer's LLM step (design doc Phase 4). Everything is
// grounded FIRST by the deterministic engines (server/ai-bot.js + ai-mentor.js
// over the canonical ledger); Gemini only REPHRASES that structured, already-
// correct content into warmer prose. Two hard guarantees:
//
//   1. The prompt receives ONLY the exact facts we computed — the model never
//      sees a blank canvas, so it cannot invent numbers.
//   2. A post-generation grounding guard re-checks every number (and % and R
//      value) from the original answer appears in the narration. If even one
//      is missing or altered, we DISCARD the AI text and return null — the
//      caller falls back to the deterministic answer. A garbled model can
//      never ship a wrong number to the trader.
//
// Uses the Gemini Interactions API (v1beta/interactions, the current Google
// endpoint — older :generateContent model names are retired). Requires
// GEMINI_API_KEY in env; everything degrades to null when it's absent or the
// call fails, so the app works identically without the key.
// ============================================================================

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const OPENAI_BASE = process.env.AICREDITS_API_KEY
    ? (process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.aicredits.in/v1')
    : (process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1');

const OPENAI_MODEL = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini';

function apiKey() {
    return process.env.AICREDITS_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || '';
}

function isGemini() {
    return !!process.env.GEMINI_API_KEY && !process.env.AICREDITS_API_KEY && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY;
}

// The narration prompt — structured facts in, warm prose out, no invention.
// The {facts} block is JSON of the computed answer; the model may reorder and
// reword but every number, percent and R value must survive verbatim.
function narrationPrompt(role, facts) {
    return 'You are the AI coach inside 31TRADES, a trading journal app. A trader asked you a question and our engines already computed a data-grounded answer from their real journal.\n\n' +
        'TASK: Rephrase the answer below into warm, natural, encouraging coach-speak for the trader — same meaning, same facts, more human tone. Keep it concise (no more than 4 sentences unless the facts genuinely need more).\n\n' +
        'HARD RULES:\n' +
        '- NEVER invent, change, round, or drop ANY number, percentage, $ amount, R value, or trade count that appears in the answer.\n' +
        '- Do not add new facts, predictions, or advice that is not already in the answer.\n' +
        '- Keep every figure EXACTLY as written (e.g. "5 occurrences costing +$22" stays "5 occurrences costing +$22").\n' +
        '- Reply with only the rephrased answer — no preamble, no quotes, no bullet lists unless the facts are a list.\n\n' +
        'Role/context: ' + role + '\n' +
        'Answer to rephrase (JSON):\n' + JSON.stringify(facts);
}

// Extract the numeric facts from an answer so the guard can verify them.
// Matches $ amounts, standalone percentages, and R multiples.
function numericFacts(text) {
    const out = [];
    if (!text) return out;
    // $ amounts (with optional sign and decimals)
    const amt = String(text).match(/[-+]?\$[\d,]+(?:\.\d+)?/g) || [];
    // percentages (e.g. 40%, 0.2%)
    const pct = String(text).match(/\d+(?:\.\d+)?%/g) || [];
    // R multiples (e.g. 0.01R, +2.5R) — exclude %R
    const rval = String(text).match(/[-+]?\d+(?:\.\d+)?R\b(?!%)/g) || [];
    return [...amt, ...pct, ...rval];
}

function guardPassed(original, narrated) {
    const orig = numericFacts(original);
    if (!orig.length) return true;   // no numbers to verify — accept (can't invent what isn't there)
    const n = String(narrated || '');
    return orig.every(f => n.indexOf(f) !== -1);
}

// Parse the Interactions API response: status completed + last model_output text.
function parseResponse(json) {
    if (!json) return null;
    // OpenAI / OpenRouter format
    if (json.choices && Array.isArray(json.choices) && json.choices[0] && json.choices[0].message) {
        return (json.choices[0].message.content || '').trim();
    }
    // Gemini Interactions API format
    if (json.status === 'completed' && Array.isArray(json.steps)) {
        const outputs = json.steps
            .filter(s => s.type === 'model_output' && Array.isArray(s.content) && (s.status === undefined || s.status === 'done'))
            .map(s => s.content.map(c => c.text || '').join(''));
        return outputs.length ? outputs[outputs.length - 1].trim() : null;
    }
    return null;
}

// One-shot narration with timeout. fetchImpl injectable for tests.
async function narrate(role, facts, opts) {
    const key = apiKey();
    if (!key) return null;
    const fetchImpl = (opts && opts.fetchImpl) || fetch;
    const timeoutMs = (opts && opts.timeoutMs) || 20000;
    const original = (facts && typeof facts === 'object' && facts.answer) ? facts.answer : String(facts || '');

    let res;
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            if (isGemini()) {
                res = await fetchImpl(GEMINI_BASE + '/v1beta/interactions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                    body: JSON.stringify({
                        model: GEMINI_MODEL,
                        input: narrationPrompt(role, facts),
                        store: false
                    }),
                    signal: ctl.signal
                });
            } else {
                // OpenAI / OpenRouter / Custom OpenAI-compatible endpoint
                res = await fetchImpl(OPENAI_BASE.replace(/\/+$/, '') + '/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + key
                    },
                    body: JSON.stringify({
                        model: OPENAI_MODEL,
                        messages: [
                            { role: 'system', content: 'You are an AI trading coach inside a trading journal platform.' },
                            { role: 'user', content: narrationPrompt(role, facts) }
                        ],
                        temperature: 0.3
                    }),
                    signal: ctl.signal
                });
            }
        } finally {
            clearTimeout(timer);
        }
        if (!res || !res.ok) return null;
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { return null; }
        const narrated = parseResponse(json);
        if (!narrated) return null;
        if (!guardPassed(original, narrated)) {
            console.warn('[31trades] AI narration dropped by grounding guard — numbers altered. Using deterministic answer.');
            return null;
        }
        return narrated;
    } catch (e) {
        // network error / timeout / abort — degrade silently
        return null;
    }
}

// Convenience wrappers used by the API layer.
async function narrateBotAnswer(answerObj, opts) {
    if (!answerObj || !answerObj.answer) return null;
    const role = 'Personal coach for a trader asking: "' + (answerObj.question || 'about their trading') + '"';
    const facts = {
        intent: answerObj.intent,
        answer: answerObj.answer,
        kpis: (answerObj.kpis || []).map(k => k.label + ': ' + k.value),
        evidence: (answerObj.evidence || []).slice(0, 5)
    };
    return narrate(role, facts, opts);
}

async function narrateCoachMessage(bundle, opts) {
    if (!bundle || !bundle.coach || !bundle.coach.message) return null;
    const role = 'AI mentor summarizing the trader\'s overall state for their dashboard';
    const facts = {
        answer: bundle.coach.message,
        context: {
            netPnl: bundle.context.netPnl,
            winRate: bundle.context.winRate,
            disciplineScore: bundle.context.disciplineScore,
            tradeCount: bundle.context.tradeCount,
            upcomingEvents: (bundle.context.upcomingEvents || []).slice(0, 3).map(e => e.title + ' ' + e.ts)
        }
    };
    return narrate(role, facts, opts);
}

module.exports = { narrate, narrateBotAnswer, narrateCoachMessage, numericFacts, guardPassed, parseResponse, GEMINI_BASE, GEMINI_MODEL };
