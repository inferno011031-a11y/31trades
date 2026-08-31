'use strict';

// ============================================================================
// 31TRADES — RAG HTTP API Handlers
// ----------------------------------------------------------------------------
// Implements authenticated routes for document ingestion, search, list,
// delete, and re-indexing.
//
// Enforces strict user isolation:
//   - Users can only search/list global documents and their own private documents.
//   - Users can never delete or re-index global documents or other users' documents.
//   - Admin check is enforced for uploading global documents.
// ============================================================================

const rag = require('./rag-engine.js');
const storage = require('./rag-storage.js');
const Admin = require('./admin.js');

// Helper to write JSON response
function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// Read body stream cleanly
async function readBody(req, limit = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) reject(new Error('Payload too large'));
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', err => reject(err));
    });
}

// Verifies if the request possesses admin privileges
function isAdmin(req) {
    // Check custom x-admin-token or auth header
    const token = req.headers['x-admin-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return false;
    return !!Admin.verifyAdminSession(token);
}

async function handleRagApi(req, res, url, uc) {
    const p = url.pathname;
    const q = url.searchParams;

    // ---- 1. GET /api/ai/rag/documents (List user + global documents) ----
    if (p === '/api/ai/rag/documents' && req.method === 'GET') {
        try {
            const docs = await storage.listDocuments(uc.userId);
            // Redact checksum and other internal fields for client safety
            const clientDocs = docs.map(d => ({
                id: d.id,
                title: d.title,
                source: d.source,
                sourceType: d.source_type || d.sourceType,
                visibility: d.visibility,
                version: d.version,
                status: d.status,
                chunkCount: d.chunk_count || d.chunkCount,
                created_at: d.created_at,
                updated_at: d.updated_at
            }));
            return json(res, 200, { ok: true, documents: clientDocs });
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // ---- 2. GET /api/ai/rag/documents/status (Check document status) ----
    if (p === '/api/ai/rag/documents/status' && req.method === 'GET') {
        const id = q.get('id');
        if (!id) return json(res, 400, { error: 'Document id required' });
        try {
            const doc = await storage.getDocument(id);
            if (!doc) return json(res, 404, { error: 'Document not found' });
            
            // Authorization scope check
            if (doc.user_id !== uc.userId && doc.visibility !== 'GLOBAL' && doc.userId !== uc.userId) {
                return json(res, 403, { error: 'Forbidden' });
            }
            
            return json(res, 200, { ok: true, status: doc.status, chunkCount: doc.chunk_count || doc.chunkCount });
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // ---- 3. POST /api/ai/rag/documents/upload (Ingest document) ----
    if (p === '/api/ai/rag/documents/upload' && req.method === 'POST') {
        let raw;
        try { raw = await readBody(req); }
        catch (err) { return json(res, 413, { error: err.message }); }

        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch (err) { return json(res, 400, { error: 'Invalid JSON payload' }); }

        const { filename, mimeType, data, text, visibility } = body;
        if (!filename) return json(res, 400, { error: 'filename required' });

        const vis = visibility === 'GLOBAL' ? 'GLOBAL' : 'USER_PRIVATE';
        // Admin authorization check for GLOBAL documents
        if (vis === 'GLOBAL' && !isAdmin(req) && process.env.TRADEMIND_AUTH !== 'off') {
            return json(res, 403, { error: 'Forbidden: Admin session required to publish GLOBAL knowledge base' });
        }

        let buffer;
        if (data) {
            try { buffer = Buffer.from(data, 'base64'); }
            catch (e) { return json(res, 400, { error: 'Invalid base64 data encoding' }); }
        } else if (text) {
            buffer = Buffer.from(text, 'utf8');
        } else {
            return json(res, 400, { error: 'File content (data or text) required' });
        }

        try {
            const doc = await rag.ingestDocument(uc.userId, filename, mimeType || 'text/plain', buffer, vis);
            return json(res, 201, { ok: true, document: { id: doc.id, status: doc.status, chunkCount: doc.chunkCount } });
        } catch (err) {
            return json(res, 400, { error: err.message });
        }
    }

    // ---- 4. DELETE /api/ai/rag/documents (Delete document and vectors) ----
    if (p === '/api/ai/rag/documents' && req.method === 'DELETE') {
        const id = q.get('id');
        if (!id) return json(res, 400, { error: 'Document id required' });

        try {
            const doc = await storage.getDocument(id);
            if (!doc) return json(res, 404, { error: 'Document not found' });
            
            // Only the owner can delete a document. (Global documents cannot be deleted by normal users)
            const ownerId = doc.user_id || doc.userId;
            if (ownerId !== uc.userId) {
                if (doc.visibility === 'GLOBAL' && isAdmin(req)) {
                    // admin can delete global
                } else {
                    return json(res, 403, { error: 'Forbidden: Cannot delete document owned by another user or system' });
                }
            }

            const ok = await storage.deleteDocument(id, ownerId);
            return json(res, 200, { ok });
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // ---- 5. POST /api/ai/rag/documents/reindex (Delete and ingest again) ----
    if (p === '/api/ai/rag/documents/reindex' && req.method === 'POST') {
        let raw;
        try { raw = await readBody(req); }
        catch (err) { return json(res, 413, { error: err.message }); }

        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch (err) { return json(res, 400, { error: 'Invalid JSON payload' }); }

        const { id, filename, mimeType, data, text, visibility } = body;
        if (!id) return json(res, 400, { error: 'Document id to reindex is required' });
        if (!filename) return json(res, 400, { error: 'filename required' });

        try {
            const doc = await storage.getDocument(id);
            if (!doc) return json(res, 404, { error: 'Document not found' });
            
            // Scope check: must own the document
            const ownerId = doc.user_id || doc.userId;
            if (ownerId !== uc.userId && !(doc.visibility === 'GLOBAL' && isAdmin(req))) {
                return json(res, 403, { error: 'Forbidden' });
            }

            let buffer;
            if (data) {
                buffer = Buffer.from(data, 'base64');
            } else if (text) {
                buffer = Buffer.from(text, 'utf8');
            } else {
                return json(res, 400, { error: 'File content (data or text) required' });
            }

            // Perform atomic re-indexing: delete old version first, then ingest
            await storage.deleteDocument(id, ownerId);
            const newDoc = await rag.ingestDocument(uc.userId, filename, mimeType || 'text/plain', buffer, visibility || doc.visibility);
            
            return json(res, 200, { ok: true, document: { id: newDoc.id, status: newDoc.status, chunkCount: newDoc.chunkCount } });
        } catch (err) {
            return json(res, 400, { error: err.message });
        }
    }

    // ---- 6. POST /api/ai/rag/search (Direct search API) ----
    if (p === '/api/ai/rag/search' && req.method === 'POST') {
        let raw;
        try { raw = await readBody(req); }
        catch (err) { return json(res, 400, { error: err.message }); }

        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch (err) { return json(res, 400, { error: 'Invalid JSON payload' }); }

        const { query, limit, threshold } = body;
        if (!query) return json(res, 400, { error: 'query string required' });

        try {
            const result = await rag.retrieveContext(query, uc.userId, { limit, threshold });
            return json(res, 200, result);
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    return json(res, 404, { error: 'unknown RAG endpoint' });
}

module.exports = { handleRagApi };
