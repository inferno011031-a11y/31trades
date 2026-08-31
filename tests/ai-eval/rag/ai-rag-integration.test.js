'use strict';

// ============================================================================
// INTEGRATION TEST: AI + RAG Context Narration & Fact Protection
// ============================================================================
// Asserts:
//   1. askBot attaches ragContext to response object.
//   2. narrateBotAnswer correctly packages ragContext for LLM prompt.
//   3. Fact Protection: Grounding guard enforces deterministic trading facts,
//      rejecting any narrated response where numbers are overridden by RAG content.
// ============================================================================

const Bot = require('../../../server/ai-bot.js');
const LLM = require('../../../server/llm.js');
const fx  = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

async function run() {
    console.log('  Running AI-RAG Integration Tests...');
    const core = fx.mixedRealistic();
    const ACCT = 'acc-prop';

    // Mock RAG context matches RAG context contract
    const mockRagContext = {
        query: 'how is my performance?',
        hasRelevantContext: true,
        results: [
            {
                chunkId: 'chunk-rules-001',
                documentId: 'doc-rules',
                title: 'Risk Guide',
                text: 'Risk management emphasizes predefined loss limits and disciplined sizing.',
                section: 'Sizing Rules',
                source: 'risk-guide.md',
                score: 0.85,
                visibility: 'GLOBAL'
            }
        ]
    };

    // ---- 1. askBot returns RAG Context ----
    const r = Bot.askBot(core, ACCT, 'how is my performance?', { ragContext: mockRagContext });
    check('askBot: attaches ragContext payload', r.ragContext && r.ragContext.hasRelevantContext === true);
    check('askBot: preserves original deterministic answer text', r.answer.length > 0);

    // ---- 2. narrateBotAnswer packages RAG info ----
    // We mock fetchImpl to inspect what prompt is sent to the LLM
    let capturedPrompt = '';
    const mockFetch = async (url, init) => {
        capturedPrompt = JSON.parse(init.body).messages 
            ? JSON.parse(init.body).messages[1].content // OpenAI format
            : JSON.parse(init.body).input; // Gemini format
        return {
            ok: true,
            text: async () => JSON.stringify({
                choices: [{ message: { content: 'This is the rephrased narrated answer with 58% win rate.' } }]
            })
        };
    };

    const answerObj = {
        question: 'how is my performance?',
        intent: 'overall',
        answer: 'You have logged 35 trades with 58% win rate.',
        kpis: [{ label: 'Win rate', value: '58%' }],
        evidence: [],
        ragContext: mockRagContext
    };

    // Temporary set key to enable narration call
    const oldKey = process.env.AICREDITS_API_KEY;
    process.env.AICREDITS_API_KEY = 'sk-mock-key-for-narration-test';
    
    await LLM.narrateBotAnswer(answerObj, { fetchImpl: mockFetch });

    check('narration prompt: contains RAG instruction block', capturedPrompt.includes('PROMPT INJECTION DEFENSE'));
    check('narration prompt: contains RAG context text', capturedPrompt.includes('Risk management emphasizes predefined loss limits'));
    check('narration prompt: contains document title', capturedPrompt.includes('Risk Guide'));

    // ---- 3. Fact Protection (Grounding Guard) -------------------------------
    // We simulate a hallucination or override:
    // Original has '58%'.
    // RAG says '91%'.
    // If narrated text uses RAG's '91%' and drops '58%', the guard MUST fail.
    
    const originalAnswer = 'Your win rate is 58% and net profit is $450.';
    
    const narratedCorrect = 'I see your win rate is 58% and you made $450. According to the Risk Guide, you followed risk rules.';
    check('grounding guard: accepts correct numbers matching original', LLM.guardPassed(originalAnswer, narratedCorrect) === true);

    const narratedHallucinated = 'Your win rate is 91% and you made $450.';
    check('grounding guard: REJECTS override of deterministic facts (winRate 91% vs 58%)', LLM.guardPassed(originalAnswer, narratedHallucinated) === false);

    // Restore env key
    process.env.AICREDITS_API_KEY = oldKey;

    return results;
}

module.exports = run();
