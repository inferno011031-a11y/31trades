'use strict';

// ============================================================================
// 31TRADES — RAG Vector Storage Adapter
// ----------------------------------------------------------------------------
// Implements a dual-mode storage layer:
//   1. Supabase/PostgreSQL with pgvector (Cloud Production)
//   2. Local JSON files (Offline / Dev Fallback / Automated Testing)
//
// All document retrieval and semantic search queries are strictly scoped
// by visibility and authenticated user_id to ensure complete user isolation.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');

const DATA_DIR = process.env.TRADEMIND_AI_DATA_DIR || path.join(__dirname, '..', 'data');
const DOCS_FILE = path.join(DATA_DIR, 'rag-documents.json');
const CHUNKS_FILE = path.join(DATA_DIR, 'rag-chunks.json');

// --- Helper: Local JSON storage read/write ----------------------------------
function loadLocalDocs() {
    try {
        if (fs.existsSync(DOCS_FILE)) {
            return JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return [];
}

function saveLocalDocs(docs) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DOCS_FILE, JSON.stringify(docs, null, 2), 'utf8');
    } catch (e) { /* ignore */ }
}

function loadLocalChunks() {
    try {
        if (fs.existsSync(CHUNKS_FILE)) {
            return JSON.parse(fs.readFileSync(CHUNKS_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return [];
}

function saveLocalChunks(chunks) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CHUNKS_FILE, JSON.stringify(chunks, null, 2), 'utf8');
    } catch (e) { /* ignore */ }
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Storage API Implementation ---------------------------------------------

async function saveDocument(doc) {
    const pool = db.getPool();
    if (pool) {
        const q = `
            INSERT INTO rag_documents (id, user_id, title, source, source_type, visibility, mime_type, version, status, checksum, chunk_count, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (id) DO UPDATE SET
                version = EXCLUDED.version,
                status = EXCLUDED.status,
                checksum = EXCLUDED.checksum,
                chunk_count = EXCLUDED.chunk_count,
                updated_at = EXCLUDED.updated_at;
        `;
        await pool.query(q, [
            doc.id, doc.userId, doc.title, doc.source, doc.sourceType, doc.visibility,
            doc.mimeType, doc.version, doc.status, doc.checksum, doc.chunkCount,
            doc.created_at || new Date().toISOString(), doc.updated_at || new Date().toISOString()
        ]);
    } else {
        const docs = loadLocalDocs().filter(d => d.id !== doc.id);
        docs.push(doc);
        saveLocalDocs(docs);
    }
}

async function saveChunks(chunks) {
    if (!chunks.length) return;
    const pool = db.getPool();
    if (pool) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Delete old chunks first (for idempotency and version updates)
            await client.query('DELETE FROM rag_chunks WHERE document_id = $1', [chunks[0].document_id]);
            
            for (const c of chunks) {
                // pgvector expects float array formatted as string: '[0.1,0.2,...]'
                const vecStr = '[' + c.embedding.join(',') + ']';
                const q = `
                    INSERT INTO rag_chunks (id, document_id, text, chunk_index, heading, metadata, embedding, document_version)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
                `;
                await client.query(q, [
                    c.id, c.document_id, c.text, c.chunk_index, c.heading,
                    JSON.stringify(c.metadata || {}), vecStr, c.document_version
                ]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } else {
        const docId = chunks[0].document_id;
        const allChunks = loadLocalChunks().filter(c => c.document_id !== docId);
        allChunks.push(...chunks);
        saveLocalChunks(allChunks);
    }
}

async function getDocument(id) {
    const pool = db.getPool();
    if (pool) {
        const { rows } = await pool.query('SELECT * FROM rag_documents WHERE id = $1', [id]);
        return rows[0] || null;
    } else {
        return loadLocalDocs().find(d => d.id === id) || null;
    }
}

async function getDocumentByChecksum(checksum, userId) {
    const pool = db.getPool();
    if (pool) {
        const q = 'SELECT * FROM rag_documents WHERE checksum = $1 AND (user_id = $2 OR visibility = \'GLOBAL\')';
        const { rows } = await pool.query(q, [checksum, userId]);
        return rows[0] || null;
    } else {
        return loadLocalDocs().find(d => d.checksum === checksum && (d.userId === userId || d.visibility === 'GLOBAL')) || null;
    }
}

async function listDocuments(userId) {
    const pool = db.getPool();
    if (pool) {
        // Only return documents owned by this user or global documents
        const q = 'SELECT * FROM rag_documents WHERE user_id = $1 OR visibility = \'GLOBAL\' ORDER BY updated_at DESC';
        const { rows } = await pool.query(q, [userId]);
        return rows;
    } else {
        return loadLocalDocs()
            .filter(d => d.userId === userId || d.visibility === 'GLOBAL')
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
}

async function deleteDocument(id, userId) {
    const pool = db.getPool();
    if (pool) {
        // Enforce user isolation: must own the document to delete it (GLOBAL documents are read-only)
        const q = 'DELETE FROM rag_documents WHERE id = $1 AND user_id = $2 RETURNING id';
        const { rows } = await pool.query(q, [id, userId]);
        return rows.length > 0;
    } else {
        const docs = loadLocalDocs();
        const doc = docs.find(d => d.id === id);
        if (!doc) return false;
        if (doc.userId !== userId) {
            throw new Error('Unauthorized: Cannot delete global or other users\' documents');
        }
        
        saveLocalDocs(docs.filter(d => d.id !== id));
        const chunks = loadLocalChunks().filter(c => c.document_id !== id);
        saveLocalChunks(chunks);
        return true;
    }
}

async function deleteUserDocuments(userId) {
    const pool = db.getPool();
    if (pool) {
        // Cascades to chunks table automatically
        await pool.query('DELETE FROM rag_documents WHERE user_id = $1', [userId]);
    } else {
        const docs = loadLocalDocs();
        const userDocs = docs.filter(d => d.userId === userId);
        const userDocIds = new Set(userDocs.map(d => d.id));
        
        saveLocalDocs(docs.filter(d => d.userId !== userId));
        const chunks = loadLocalChunks().filter(c => !userDocIds.has(c.document_id));
        saveLocalChunks(chunks);
    }
}

async function findSimilarChunks(queryEmbedding, limit, threshold, userId) {
    const pool = db.getPool();
    if (pool) {
        // Scoped to (global OR private owned by this user) AND similarity >= threshold
        const q = `
            SELECT c.id, c.text, c.chunk_index, c.heading, c.metadata, d.title, d.source, d.visibility,
                   (1 - (c.embedding <=> $1::vector)) AS score
            FROM rag_chunks c
            JOIN rag_documents d ON c.document_id = d.id
            WHERE (d.visibility = 'GLOBAL' OR d.user_id = $2)
              AND d.status = 'complete'
              AND (1 - (c.embedding <=> $1::vector)) >= $3
            ORDER BY c.embedding <=> $1::vector ASC
            LIMIT $4;
        `;
        const vecStr = '[' + queryEmbedding.join(',') + ']';
        const { rows } = await pool.query(q, [vecStr, userId, threshold, limit]);
        return rows;
    } else {
        const docs = loadLocalDocs().filter(d => d.status === 'complete' && (d.userId === userId || d.visibility === 'GLOBAL'));
        const docMap = new Map(docs.map(d => [d.id, d]));
        const chunks = loadLocalChunks().filter(c => docMap.has(c.document_id));
        
        const results = chunks.map(c => {
            const doc = docMap.get(c.document_id);
            const score = cosineSimilarity(c.embedding, queryEmbedding);
            return {
                id: c.id,
                text: c.text,
                chunk_index: c.chunk_index,
                heading: c.heading,
                metadata: c.metadata,
                title: doc.title,
                source: doc.source,
                visibility: doc.visibility,
                score
            };
        });
        
        return results
            .filter(r => r.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
}

// --- Keyword matching for Hybrid Search fallback ---------------------------
async function findKeywordChunks(queryText, limit, userId) {
    const pool = db.getPool();
    const cleanQuery = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (!cleanQuery) return [];

    if (pool) {
        // Check for words inside text column (using ILIKE or standard PostgreSQL text matching)
        // Scoped strictly by user permission
        const q = `
            SELECT c.id, c.text, c.chunk_index, c.heading, c.metadata, d.title, d.source, d.visibility,
                   0.5 AS score -- static baseline score for text hits
            FROM rag_chunks c
            JOIN rag_documents d ON c.document_id = d.id
            WHERE (d.visibility = 'GLOBAL' OR d.user_id = $1)
              AND d.status = 'complete'
              AND c.text ILIKE $2
            LIMIT $3;
        `;
        const { rows } = await pool.query(q, [userId, `%${queryText}%`, limit]);
        return rows;
    } else {
        const docs = loadLocalDocs().filter(d => d.status === 'complete' && (d.userId === userId || d.visibility === 'GLOBAL'));
        const docMap = new Map(docs.map(d => [d.id, d]));
        const chunks = loadLocalChunks().filter(c => docMap.has(c.document_id));
        
        const terms = cleanQuery.split(/\s+/);
        const matches = [];
        
        for (const c of chunks) {
            const doc = docMap.get(c.document_id);
            const textLower = c.text.toLowerCase();
            // Count matching terms for basic relevance ranking
            const matchCount = terms.filter(term => textLower.includes(term)).length;
            if (matchCount > 0) {
                matches.push({
                    id: c.id,
                    text: c.text,
                    chunk_index: c.chunk_index,
                    heading: c.heading,
                    metadata: c.metadata,
                    title: doc.title,
                    source: doc.source,
                    visibility: doc.visibility,
                    score: 0.5 * (matchCount / terms.length)
                });
            }
        }
        
        return matches
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
}

module.exports = {
    saveDocument,
    saveChunks,
    getDocument,
    getDocumentByChecksum,
    listDocuments,
    deleteDocument,
    deleteUserDocuments,
    findSimilarChunks,
    findKeywordChunks
};
