'use strict';

// ============================================================================
// RAG TEST: Document Ingestion, Hybrid Retrieval & Security Isolation
// ============================================================================

const JSZip = require('jszip');
const rag = require('../../../server/rag-engine.js');
const storage = require('../../../server/rag-storage.js');
const parser = require('../../../server/rag-parser.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

async function run() {
    console.log('  Running RAG Base Tests...');
    const userA = 'user-alice-111';
    const userB = 'user-bob-222';

    // Cleanup any leftovers from previous test aborts
    await storage.deleteUserDocuments(userA);
    await storage.deleteUserDocuments(userB);

    // ---- 1. Document Extraction & Parser Tests ------------------------------
    try {
        const txtText = await parser.extractText(Buffer.from('Hello world txt', 'utf8'), 'text/plain', 'test.txt');
        check('parser: extract plain text', txtText === 'Hello world txt', txtText);

        const mdText = await parser.extractText(Buffer.from('## Hello md', 'utf8'), 'text/markdown', 'test.md');
        check('parser: extract markdown', mdText === '## Hello md', mdText);

        const csvText = await parser.extractText(Buffer.from('col1,col2\nval1,val2', 'utf8'), 'text/csv', 'test.csv');
        check('parser: extract CSV', csvText.includes('val1'), csvText);

        // DOCX mock creation
        const zip = new JSZip();
        zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello world docx</w:t></w:r></w:p></w:body></w:document>');
        const docxBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        const docxText = await parser.extractText(docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'test.docx');
        check('parser: extract DOCX', docxText === 'Hello world docx', docxText);

        // PDF mock creation (uncompressed text stream)
        const pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\nstream\n(Hello world pdf) Tj\nendstream\nendobj', 'binary');
        const pdfText = await parser.extractText(pdfBuffer, 'application/pdf', 'test.pdf');
        check('parser: extract PDF', pdfText === 'Hello world pdf', pdfText);
    } catch (err) {
        check('parser: failed during extraction tests', false, err.message);
    }

    // ---- 2. Empty / Malformed Validation Checks -----------------------------
    try {
        await parser.extractText(Buffer.alloc(0), 'text/plain', 'empty.txt');
        check('validation: accept empty files', false, 'Allowed empty buffer');
    } catch (err) {
        check('validation: reject empty files', err.message.includes('empty'));
    }

    try {
        await parser.extractText(Buffer.from('corrupt zip'), 'application/docx', 'corrupt.docx');
        check('validation: parse corrupt docx', false, 'Allowed corrupt docx');
    } catch (err) {
        check('validation: reject corrupt docx', err.message.includes('DOCX') || err.message.includes('Zip'));
    }

    // ---- 3. Ingestion Pipeline & Checksum Idempotency ----------------------
    const txtBuffer = Buffer.from('Trading rules: always set a predefined stop loss.', 'utf8');
    
    let docA1;
    try {
        docA1 = await rag.ingestDocument(userA, 'rules.txt', 'text/plain', txtBuffer, 'USER_PRIVATE');
        check('ingest: first time', docA1 && docA1.status === 'complete', JSON.stringify(docA1));
        check('ingest: chunks created', docA1.chunkCount > 0, 'chunks: ' + docA1.chunkCount);
    } catch (err) {
        check('ingest: failed first time', false, err.message);
    }

    // Secondary ingestion of identical document (idempotent checksum detection)
    try {
        const docA2 = await rag.ingestDocument(userA, 'rules.txt', 'text/plain', txtBuffer, 'USER_PRIVATE');
        check('ingest idempotency: returns identical document ID', docA2.id === docA1.id, `A1: ${docA1.id}, A2: ${docA2.id}`);
        check('ingest idempotency: did not duplicate database records', docA2.chunkCount === docA1.chunkCount);
    } catch (err) {
        check('ingest idempotency: failed', false, err.message);
    }

    // ---- 4. Hybrid Retrieval & Relevance Thresholding -----------------------
    // Retrieve using exact keyword hit
    const retKeyword = await rag.retrieveContext('stop loss', userA, { limit: 2, threshold: 0.10 });
    check('retrieve: keyword match returns candidates', retKeyword.hasRelevantContext === true);
    check('retrieve: keyword match returns correct document reference', retKeyword.results[0].title === 'rules.txt');

    // Retrieve using similarity matching
    const retSemantic = await rag.retrieveContext('predefined risk limit', userA, { limit: 2, threshold: 0.10 });
    check('retrieve: semantic match returns candidates', retSemantic.hasRelevantContext === true);

    // Retrieve with strict thresholding (irrelevant query should return no context)
    const retThreshold = await rag.retrieveContext('unrelated quantum mechanics astrophysics', userA, { limit: 2, threshold: 0.85 });
    check('retrieve threshold: rejects irrelevant matches', retThreshold.hasRelevantContext === false);

    // ---- 5. Cross-User Security Isolation (Mandatory) -----------------------
    // Upload private file as User B
    const docB = await rag.ingestDocument(userB, 'secret-plan.txt', 'text/plain', Buffer.from('User B secret trading plan details.', 'utf8'), 'USER_PRIVATE');
    
    // Search as User A for User B's secret plan
    const searchAsA = await rag.retrieveContext('secret trading plan', userA, { limit: 5, threshold: 0.10 });
    const hasSecretB = searchAsA.results.some(r => r.title === 'secret-plan.txt');
    check('security isolation: User A cannot retrieve User B private document', hasSecretB === false, 'User A saw: ' + JSON.stringify(searchAsA.results));

    // Search as User B for User B's secret plan
    const searchAsB = await rag.retrieveContext('secret trading plan', userB, { limit: 5, threshold: 0.10 });
    const hasSecretBForB = searchAsB.results.some(r => r.title === 'secret-plan.txt');
    check('security isolation: User B can retrieve User B private document', hasSecretBForB === true);

    // ---- 6. Global vs Private Knowledge Base --------------------------------
    // Upload global file
    const docGlobal = await rag.ingestDocument(userA, 'global-lexicon.txt', 'text/plain', Buffer.from('Battlex terminology: MSS refers to Market Structure Shift.', 'utf8'), 'GLOBAL');
    
    // Search as User B for Global information
    const searchGlobalAsB = await rag.retrieveContext('Market Structure Shift', userB, { limit: 5, threshold: 0.10 });
    const hasGlobalForB = searchGlobalAsB.results.some(r => r.title === 'global-lexicon.txt');
    check('visibility: User B can retrieve GLOBAL document', hasGlobalForB === true);

    // ---- 7. Deletion & Cleanup ----------------------------------------------
    const delOk = await storage.deleteDocument(docA1.id, userA);
    check('delete: owner can delete private document', delOk === true);

    const docAfterDel = await storage.getDocument(docA1.id);
    check('delete: document metadata removed', docAfterDel === null);

    const searchAfterDel = await rag.retrieveContext('stop loss', userA, { limit: 5, threshold: 0.10 });
    const hasAAfterDel = searchAfterDel.results.some(r => r.title === 'rules.txt');
    check('delete: associated vector chunks removed', hasAAfterDel === false);

    // Try deleting global document as User B
    try {
        await storage.deleteDocument(docGlobal.id, userB);
        check('delete protection: other user cannot delete GLOBAL document', false, 'Allowed User B to delete Global');
    } catch (err) {
        check('delete protection: rejects unauthorized delete on GLOBAL', err.message.includes('Unauthorized') || err.message.includes('Forbidden'));
    }

    // Clean up
    await storage.deleteUserDocuments(userA);
    await storage.deleteUserDocuments(userB);

    return results;
}

module.exports = run();
