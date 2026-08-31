'use strict';

// ============================================================================
// 31TRADES — RAG Orchestration Engine
// ----------------------------------------------------------------------------
// Manages the RAG Ingestion Pipeline and Semantic/Hybrid Retrieval.
// Generates document chunks, fetches embeddings, coordinates database/local
// vector storage operations, and performs relevance ranking + thresholding.
// ============================================================================

const crypto = require('node:crypto');
const parser = require('./rag-parser.js');
const embeddings = require('./rag-embeddings.js');
const storage = require('./rag-storage.js');

// --- Helper: Semantic Chunking ----------------------------------------------
function chunkText(text, maxChars = 800, overlap = 100) {
    const sections = text.split(/\n(?:[ \t]*\n)+/);
    const chunks = [];
    let currentChunk = '';
    let currentHeading = null;

    for (const section of sections) {
        const trimmed = section.trim();
        if (!trimmed) continue;

        // Trace markdown heading
        const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/m);
        if (headingMatch) {
            currentHeading = headingMatch[2];
        }

        // If the section itself is larger than the max character count, split it by sentence
        if (trimmed.length > maxChars) {
            // Push any existing chunk first
            if (currentChunk.trim()) {
                chunks.push({ text: currentChunk.trim(), heading: currentHeading });
                currentChunk = currentChunk.slice(-overlap);
            }
            
            const sentences = trimmed.split(/(?<=[.?!])\s+/);
            for (const sentence of sentences) {
                if ((currentChunk.length + sentence.length) > maxChars) {
                    if (currentChunk.trim()) {
                        chunks.push({ text: currentChunk.trim(), heading: currentHeading });
                    }
                    currentChunk = currentChunk.slice(-overlap) + ' ' + sentence;
                } else {
                    currentChunk += (currentChunk ? ' ' : '') + sentence;
                }
            }
        } else if ((currentChunk.length + trimmed.length) > maxChars) {
            if (currentChunk.trim()) {
                chunks.push({ text: currentChunk.trim(), heading: currentHeading });
            }
            currentChunk = currentChunk.slice(-overlap) + '\n\n' + trimmed;
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
        }
    }

    if (currentChunk.trim()) {
        chunks.push({ text: currentChunk.trim(), heading: currentHeading });
    }

    return chunks;
}

// --- Ingestion Pipeline -----------------------------------------------------
async function ingestDocument(userId, filename, mimeType, buffer, visibility = 'USER_PRIVATE') {
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const docId = 'doc-' + crypto.randomUUID();

    // 1. Idempotency Check: check if the exact same document already exists for this scope
    const existing = await storage.getDocumentByChecksum(checksum, userId);
    if (existing) {
        if (existing.status === 'complete') {
            console.log(`[RAG] Document ${filename} already exists and is indexed (id: ${existing.id}). Bypassing ingestion.`);
            return existing;
        }
        // If it failed previously, clean up old chunks and allow re-ingestion
        await storage.deleteDocument(existing.id, userId);
    }

    const docMeta = {
        id: docId,
        userId: visibility === 'GLOBAL' ? null : userId,
        title: filename,
        source: filename,
        sourceType: mimeType,
        visibility,
        mimeType,
        version: 1,
        status: 'indexing',
        checksum,
        chunkCount: 0,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString()
    };

    // Save initial metadata
    await storage.saveDocument(docMeta);

    try {
        // 2. Extract Text
        const text = await parser.extractText(buffer, mimeType, filename);
        
        // 3. Chunk
        const rawChunks = chunkText(text);
        if (!rawChunks.length) {
            throw new Error('Document contains no extractable text segments');
        }

        // 4. Generate Embeddings & Assemble Chunk Objects
        const chunks = [];
        for (let i = 0; i < rawChunks.length; i++) {
            const rc = rawChunks[i];
            const embedding = await embeddings.embedText(rc.text);
            chunks.push({
                id: `chunk-${docId}-${i}`,
                document_id: docId,
                text: rc.text,
                chunk_index: i,
                heading: rc.heading || null,
                metadata: { source: filename, length: rc.text.length },
                embedding,
                document_version: 1
            });
        }

        // 5. Upsert to Vector Storage
        await storage.saveChunks(chunks);

        // 6. Complete Ingestion
        docMeta.status = 'complete';
        docMeta.chunkCount = chunks.length;
        docMeta.updated_at = new Date().toISOString();
        await storage.saveDocument(docMeta);

        console.log(`[RAG] Ingestion completed: ${filename} (${chunks.length} chunks indexed).`);
        return docMeta;

    } catch (err) {
        console.error(`[RAG] Ingestion failed for ${filename}: ${err.message}`);
        // Clean up partial chunks/metadata
        docMeta.status = 'failed';
        docMeta.updated_at = new Date().toISOString();
        await storage.saveDocument(docMeta);
        
        // Return useful error
        throw err;
    }
}

// --- Retrieval Pipeline -----------------------------------------------------
async function retrieveContext(queryText, userId, opts) {
    const limit = (opts && opts.limit) || 3;
    const threshold = (opts && opts.threshold) || Number(process.env.RAG_RELEVANCE_THRESHOLD) || 0.70;
    const latencyStart = Date.now();

    // 1. Normalize Query
    const normalizedQuery = String(queryText || '').trim();
    if (!normalizedQuery) {
        return { query: queryText, results: [], hasRelevantContext: false };
    }

    try {
        // 2. Generate Query Embedding
        const queryEmbedding = await embeddings.embedText(normalizedQuery);

        // 3. Perform Hybrid Retrieval
        // Fetch candidate vectors (semantic similarity) and candidate texts (keyword matching) in parallel
        const [semanticCandidates, keywordCandidates] = await Promise.all([
            storage.findSimilarChunks(queryEmbedding, limit * 2, threshold, userId),
            storage.findKeywordChunks(normalizedQuery, limit * 2, userId)
        ]);

        // 4. Combine and Rank Results
        const chunkMap = new Map();
        
        // Add semantic candidates
        for (const c of semanticCandidates) {
            chunkMap.set(c.id, c);
        }

        // Add or boost keyword candidates
        for (const c of keywordCandidates) {
            if (chunkMap.has(c.id)) {
                // If found in both, boost score slightly
                const existing = chunkMap.get(c.id);
                existing.score = Math.max(existing.score, c.score) + 0.05;
            } else {
                chunkMap.set(c.id, c);
            }
        }

        // Sort combined results by score descending
        const combined = Array.from(chunkMap.values())
            .sort((a, b) => b.score - a.score);

        // Apply relevance thresholding & deduplication
        const finalResults = [];
        const seenTexts = new Set();

        for (const c of combined) {
            if (finalResults.length >= limit) break;
            
            // Skip duplicates (similar text content)
            const textSig = c.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
            if (seenTexts.has(textSig)) continue;

            if (c.score >= threshold) {
                finalResults.push({
                    chunkId: c.id,
                    documentId: c.document_id || c.documentId,
                    title: c.title,
                    text: c.text,
                    section: c.heading || null,
                    source: c.source,
                    score: parseFloat(c.score.toFixed(4)),
                    visibility: c.visibility
                });
                seenTexts.add(textSig);
            }
        }

        const hasRelevantContext = finalResults.length > 0;
        const latency = Date.now() - latencyStart;

        // Logging & Observability (strict safety - no content logging)
        console.log(`[RAG] Query: "${normalizedQuery.slice(0, 50)}..." | candidates: ${semanticCandidates.length} semantic, ${keywordCandidates.length} keyword | selected: ${finalResults.length} chunks | latency: ${latency}ms | hasContext: ${hasRelevantContext}`);

        return {
            query: queryText,
            results: finalResults,
            hasRelevantContext
        };

    } catch (err) {
        console.error(`[RAG] Retrieval failed: ${err.message}`);
        // Degrade gracefully - return empty context
        return {
            query: queryText,
            results: [],
            hasRelevantContext: false
        };
    }
}

module.exports = {
    ingestDocument,
    retrieveContext,
    chunkText
};
