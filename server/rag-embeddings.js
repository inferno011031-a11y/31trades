'use strict';

// ============================================================================
// 31TRADES — RAG Embeddings Client
// ----------------------------------------------------------------------------
// Generates vector embeddings for document chunks and user queries.
// Supports both OpenAI/AICredits and Google Gemini.
// If offline, testing, or no keys are configured, it falls back to a 
// deterministic mock vector generator to keep tests 100% reproducible.
// ============================================================================

const crypto = require('node:crypto');

const OPENAI_BASE = process.env.AICREDITS_API_KEY
    ? (process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.aicredits.in/v1')
    : (process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

function apiKey() {
    return process.env.AICREDITS_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || '';
}

function isGemini() {
    return !!process.env.GEMINI_API_KEY && !process.env.AICREDITS_API_KEY && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY;
}

// Generate a deterministic float array of length 1536 based on text hash
// for offline testing and fallback modes.
function mockEmbed(text) {
    const hash = crypto.createHash('sha256').update(text).digest();
    const vec = new Array(1536).fill(0);
    
    // Fill the vector with pseudo-random floats derived from hash bytes
    for (let i = 0; i < 1536; i++) {
        const b1 = hash[i % 32];
        const b2 = hash[(i + 7) % 32];
        const b3 = hash[(i + 13) % 32];
        // Float between -1.0 and 1.0
        vec[i] = ((b1 * b2 * b3) % 1000) / 1000 * (b1 % 2 === 0 ? 1 : -1);
    }
    
    // Normalize vector (L2 norm)
    let sumSq = 0;
    for (let i = 0; i < 1536; i++) sumSq += vec[i] * vec[i];
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < 1536; i++) vec[i] = vec[i] / norm;
    
    return vec;
}

async function embedText(text, opts) {
    const key = apiKey();
    const isMock = (opts && opts.mock) || process.env.NODE_ENV === 'test' || !key;

    if (isMock) {
        return mockEmbed(text);
    }

    const fetchImpl = (opts && opts.fetchImpl) || fetch;
    const timeoutMs = (opts && opts.timeoutMs) || 15000;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);

    try {
        let res;
        if (isGemini()) {
            res = await fetchImpl(`${GEMINI_BASE}/v1/models/text-embedding-004:embedContent?key=${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: { parts: [{ text }] }
                }),
                signal: ctl.signal
            });
        } else {
            // OpenAI / AICredits / OpenRouter
            const modelName = process.env.AICREDITS_API_KEY ? 'text-embedding-3-small' : (process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small');
            res = await fetchImpl(`${OPENAI_BASE.replace(/\/+$/, '')}/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key
                },
                body: JSON.stringify({
                    model: modelName,
                    input: text
                }),
                signal: ctl.signal
            });
        }

        clearTimeout(timer);

        if (!res || !res.ok) {
            console.warn('[RAG] Embeddings API failed. Falling back to deterministic mock embeddings.');
            return mockEmbed(text);
        }

        const data = await res.json();
        let embedding = null;

        if (data.data && Array.isArray(data.data) && data.data[0] && Array.isArray(data.data[0].embedding)) {
            embedding = data.data[0].embedding;
        } else if (data.embedding && Array.isArray(data.embedding.values)) {
            embedding = data.embedding.values;
        }

        if (!embedding || !embedding.length) {
            return mockEmbed(text);
        }

        // Adjust dimensions to match vector(1536) exactly (pad or truncate)
        if (embedding.length === 1536) {
            return embedding;
        }
        
        const adjusted = new Array(1536).fill(0);
        for (let i = 0; i < 1536; i++) {
            adjusted[i] = embedding[i % embedding.length] || 0;
        }
        
        // Normalize the adjusted vector
        let sumSq = 0;
        for (let i = 0; i < 1536; i++) sumSq += adjusted[i] * adjusted[i];
        const norm = Math.sqrt(sumSq) || 1;
        for (let i = 0; i < 1536; i++) adjusted[i] = adjusted[i] / norm;

        return adjusted;

    } catch (err) {
        clearTimeout(timer);
        console.warn(`[RAG] Embedding retrieval threw error: ${err.message}. Falling back to mock embeddings.`);
        return mockEmbed(text);
    }
}

module.exports = { embedText, mockEmbed };
