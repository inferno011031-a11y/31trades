'use strict';

// ============================================================================
// 31TRADES — RAG Document Parser
// ----------------------------------------------------------------------------
// Extracts plain text from various file formats (TXT, Markdown, CSV, DOCX, PDF).
// Uses jszip for DOCX and native parsing for others.
// Validates file headers/MIME types and handles extraction failures.
// ============================================================================

const JSZip = require('jszip');

function extractTxt(buffer) {
    const text = buffer.toString('utf8').trim();
    if (!text) throw new Error('Document is empty');
    return text;
}

function extractCsv(buffer) {
    const text = buffer.toString('utf8').trim();
    if (!text) throw new Error('CSV document is empty');
    return text;
}

async function extractDocx(buffer) {
    try {
        const zip = await JSZip.loadAsync(buffer);
        const docXmlFile = zip.file('word/document.xml');
        if (!docXmlFile) {
            throw new Error('Invalid DOCX: missing word/document.xml');
        }
        const xmlText = await docXmlFile.async('text');
        
        // Extract text from <w:t> tags
        const matches = xmlText.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
        const text = matches
            .map(m => m.replace(/<w:t[^>]*>|<\/w:t>/g, ''))
            .join(' ')
            .trim();
            
        if (!text) throw new Error('DOCX document contains no text content');
        return text;
    } catch (err) {
        throw new Error('Failed to parse DOCX document: ' + err.message);
    }
}

function extractPdf(buffer) {
    try {
        const content = buffer.toString('binary');
        // Basic regex to find uncompressed PDF text blocks, e.g., (text) Tj or TJ
        const matches = content.match(/\(([^)]+)\)\s*(?:Tj|TJ|T\*)/g) || [];
        if (!matches.length) {
            throw new Error('No uncompressed text streams found. PDF may be compressed or scanned.');
        }
        const text = matches
            .map(m => {
                const sub = m.match(/\(([^)]+)\)/);
                return sub ? sub[1] : '';
            })
            .filter(Boolean)
            .join(' ')
            .replace(/\\([()])/g, '$1') // unescape parenthesis
            .trim();

        if (!text) throw new Error('PDF document contains no readable text content');
        return text;
    } catch (err) {
        throw new Error('Failed to parse PDF document: ' + err.message);
    }
}

async function extractText(buffer, mimeType, filename) {
    if (!buffer || buffer.length === 0) {
        throw new Error('File buffer is empty');
    }

    const type = String(mimeType || '').toLowerCase();
    const ext = String(filename || '').split('.').pop().toLowerCase();

    // 1. Validate file content signatures (mime sniffing)
    if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
        // Zip signature — likely DOCX
        return extractDocx(buffer);
    }
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        // PDF signature
        return extractPdf(buffer);
    }

    // 2. Fall back to mime type / extension check
    if (type === 'text/plain' || type === 'text/markdown' || ext === 'txt' || ext === 'md') {
        return extractTxt(buffer);
    }
    if (type === 'text/csv' || ext === 'csv') {
        return extractCsv(buffer);
    }
    if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
        return extractDocx(buffer);
    }
    if (type === 'application/pdf' || ext === 'pdf') {
        return extractPdf(buffer);
    }

    throw new Error(`Unsupported file type: ${mimeType || ext || 'unknown'}`);
}

module.exports = { extractText };
