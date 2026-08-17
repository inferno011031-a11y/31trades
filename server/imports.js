'use strict';

// ============================================================================
// 31TRADES — Legacy Journal Import Engine
// ----------------------------------------------------------------------------
// Secure ingestion layer that converts heterogeneous historical journal
// formats (CSV, XLSX, Google Sheets exports, Notion exports, pasted tabular
// data) into the existing canonical Battlex trade model.
//
//   UPLOAD → SECURITY VALIDATION → PARSE → COLUMN DETECTION → NORMALIZATION
//   → ROW VALIDATION → DUPLICATE DETECTION → PREVIEW → CONFIRMATION
//   → TRANSACTIONAL IMPORT → CANONICAL LEDGER → IMPORT REPORT
//
// DESIGN RULES
//   · Every uploaded file is untrusted input. Nothing is ever executed —
//     XLSX is parsed structurally (ZIP + worksheet XML via Node's zlib),
//     formulas are never evaluated, macros/embedded objects are rejected.
//   · No fabricated data. Missing emotion/setup/session/notes stay null;
//     a row without a derivable outcome is INVALID, never invented.
//   · Duplicate protection is mandatory and confidence-based.
//   · User isolation: every function takes the authenticated userId and
//     never looks at another user's batches.
//   · Source separation: imported trades are marked source=IMPORT and carry
//     import_batch_id — never confused with manual/broker/backtest trades.
//
// Pure functions (parsing, mapping, validation) are unit-testable without a
// server. Batch persistence is per-user JSON (file-first) with a best-effort
// Supabase mirror (import_batches) — the same DB-first/file-fallback pattern
// as brokers.js.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const db = require('./db.js');

// ---------------------------------------------------------------------------
// LIMITS — protect the server from huge/abusive imports
// ---------------------------------------------------------------------------
const MAX_FILE_SIZE = 2 * 1024 * 1024;        // 2 MB decoded upload cap
const MAX_UPLOAD_BODY = 5 * 1024 * 1024;      // 5 MB JSON body (base64 overhead)
const MAX_ROWS = 5000;                        // rows per import (excl. header)
const MAX_COLUMNS = 200;
const MAX_CELLS = 250000;                     // rows × columns guard
const MAX_WORKSHEETS = 3;
const MAX_DECOMPRESSED = 16 * 1024 * 1024;    // zip-bomb guard (total)
const MAX_ENTRY_SIZE = 8 * 1024 * 1024;       // per zip entry
const MAX_NAME_LEN = 500;                     // symbol / free-text sanity cap

const SOURCE_TYPES = ['CSV', 'XLSX', 'GOOGLE_SHEETS_EXPORT', 'NOTION_EXPORT', 'PASTED_DATA'];

const BATCH_STATUS = [
    'UPLOADED', 'PARSING', 'READY', 'IMPORTING',
    'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'ROLLED_BACK'
];

// ---------------------------------------------------------------------------
// ERROR HELPERS — structured, human-readable, never leak internals
// ---------------------------------------------------------------------------
function importError(code, message, details) {
    const e = new Error(message);
    e.importCode = code;
    e.details = details;
    return e;
}

// ---------------------------------------------------------------------------
// FILE SECURITY VALIDATION
// ---------------------------------------------------------------------------
const ALLOWED_EXT = new Set(['.csv', '.xlsx']);
const ALLOWED_MIME = new Set([
    'text/csv', 'text/plain', 'application/csv', 'text/comma-separated-values',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream', 'application/zip', ''
]);

function extOf(filename) {
    const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? '.' + m[1] : '';
}

// Validate filename, extension, MIME and the actual file signature. Never
// trusts the extension alone — magic bytes are checked.
function validateUpload({ filename, contentType, data }) {
    const name = String(filename || '').trim();
    if (!name) return { ok: false, error: 'filename is required' };
    const ext = extOf(name);
    if (!ALLOWED_EXT.has(ext)) {
        return { ok: false, error: 'unsupported file type "' + ext + '" — upload .csv or .xlsx (formulas/macros are not supported)' };
    }
    const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (mime && !ALLOWED_MIME.has(mime)) {
        return { ok: false, error: 'unsupported content type "' + mime + '"' };
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    if (buf.length === 0) return { ok: false, error: 'file is empty' };
    if (buf.length > MAX_FILE_SIZE) {
        return { ok: false, error: 'file exceeds the ' + Math.round(MAX_FILE_SIZE / 1024 / 1024) + ' MB limit' };
    }
    // Magic bytes: xlsx is a ZIP (PK\x03\x04); csv is text (reject binary junk)
    if (ext === '.xlsx') {
        if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
            return { ok: false, error: 'not a valid .xlsx workbook (missing ZIP signature)' };
        }
        if (buf.indexOf(Buffer.from('vbaProject.bin')) !== -1 || buf.indexOf(Buffer.from('xl/vbaProject')) !== -1) {
            return { ok: false, error: 'macro-enabled workbooks are not supported' };
        }
    } else {
        // CSV must be readable text: reject NUL bytes and non-UTF8-ish content
        if (buf.indexOf(0) !== -1) return { ok: false, error: 'file contains binary data — expected a CSV text file' };
        const sample = buf.slice(0, 4096);
        const decoded = sample.toString('utf8');
        if (decoded.includes('\uFFFD') && sample.includes(Buffer.from([0xff, 0xfe]))) {
            // UTF-16 BOM — decode from utf16le instead of rejecting
            return { ok: true, ext, name, buffer: buf, encoding: 'utf16le' };
        }
    }
    return { ok: true, ext, name, buffer: buf, encoding: 'utf8' };
}

// ---------------------------------------------------------------------------
// CSV / DELIMITED PARSER (RFC-4180-ish: quotes, "" escapes, embedded newlines)
// Used for .csv uploads, Google Sheets / Notion CSV exports and pasted data —
// the SAME pipeline for every textual source.
// ---------------------------------------------------------------------------
function detectDelimiter(text) {
    const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    let inQ = false;
    for (let i = 0; i < first.length; i++) {
        const c = first[i];
        if (c === '"') inQ = !inQ;
        else if (!inQ && counts[c] !== undefined) counts[c]++;
    }
    let best = ',', bestN = 0;
    Object.keys(counts).forEach(k => { if (counts[k] > bestN) { bestN = counts[k]; best = k; } });
    return best;
}

function parseDelimited(text, forcedDelimiter) {
    let s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);          // strip BOM
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!s.trim()) return { headers: [], rows: [] };
    const delim = forcedDelimiter || detectDelimiter(s);

    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQ) {
            if (c === '"') {
                if (s[i + 1] === '"') { field += '"'; i++; }
                else inQ = false;
            } else field += c;
        } else if (c === '"') {
            inQ = true;
        } else if (c === delim) {
            row.push(field); field = '';
        } else if (c === '\n') {
            row.push(field); rows.push(row); row = []; field = '';
        } else {
            field += c;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    // Drop fully-empty trailing rows (stray newlines at EOF)
    while (rows.length && rows[rows.length - 1].every(c => String(c).trim() === '')) rows.pop();

    const headers = (rows.shift() || []).map((h, i) => {
        const t = String(h == null ? '' : h).trim();
        return t || ('column' + (i + 1));
    });
    // dedupe duplicate header names
    const seen = {};
    const uniq = headers.map(h => {
        const key = h.toLowerCase();
        seen[key] = (seen[key] || 0) + 1;
        return seen[key] > 1 ? h + ' (' + seen[key] + ')' : h;
    });
    return { headers: uniq, rows };
}

// ---------------------------------------------------------------------------
// XLSX PARSER — structural, safe. ZIP via Node zlib, worksheet XML only.
// Never evaluates formulas; macro/embedded content is rejected earlier.
// ---------------------------------------------------------------------------
function findEOCD(buf) {
    const min = 22;
    const start = Math.max(0, buf.length - 65557);
    for (let i = buf.length - min; i >= start; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
}

function zipEntries(buf) {
    const eocd = findEOCD(buf);
    if (eocd < 0) throw importError('IMPORT_MALFORMED', 'invalid .xlsx: ZIP end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count < 1 || count > 500) throw importError('IMPORT_MALFORMED', 'invalid .xlsx: implausible entry count');
    const entries = {};
    let off = cdOffset;
    for (let n = 0; n < count; n++) {
        if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
        const method = buf.readUInt16LE(off + 10);
        const csize = buf.readUInt32LE(off + 20);
        const usize = buf.readUInt32LE(off + 24);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        entries[name] = { method, csize, usize, localOff };
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function readZipEntry(buf, entry) {
    const { method, csize, usize, localOff } = entry;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
        throw importError('IMPORT_MALFORMED', 'invalid .xlsx: corrupt local header');
    }
    const nameLen = buf.readUInt16LE(localOff + 26);
    const extraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + nameLen + extraLen;
    const compressed = buf.slice(dataStart, dataStart + csize);
    let out;
    if (method === 0) {
        out = compressed.slice(0, Math.min(usize, MAX_ENTRY_SIZE));
    } else if (method === 8) {
        try {
            out = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_SIZE });
        } catch (e) {
            throw importError('IMPORT_MALFORMED', 'invalid .xlsx: entry failed to decompress (possible zip bomb)');
        }
    } else {
        throw importError('IMPORT_MALFORMED', 'invalid .xlsx: unsupported compression method ' + method);
    }
    return out;
}

function xmlDecode(s) {
    return String(s == null ? '' : s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function colIndex(ref) {
    const m = String(ref || '').match(/^([A-Z]+)/);
    if (!m) return -1;
    let n = 0;
    for (let i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
}

function parseSharedStrings(xml) {
    const out = [];
    const siRe = /<\s*si\b[^>]*>([\s\S]*?)<\/\s*si\s*>/g;
    const tRe = /<\s*t\b[^>]*>([\s\S]*?)<\/\s*t\s*>/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
        let text = '';
        let tm;
        tRe.lastIndex = 0;
        while ((tm = tRe.exec(m[1])) !== null) text += tm[1];
        out.push(xmlDecode(text));
    }
    return out;
}

function parseWorksheet(xml, shared) {
    const headers = [];
    const rows = [];
    let cellCount = 0;

    const rowRe = /<\s*row\b[^>]*>([\s\S]*?)<\/\s*row\s*>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
        const rowXml = rm[1];
        const cells = [];
        const cRe = /<\s*c\b([^>]*)>([\s\S]*?)<\/\s*c\s*>/g;
        let cm;
        while ((cm = cRe.exec(rowXml)) !== null) {
            const attrs = cm[1];
            const body = cm[2];
            const t = (attrs.match(/\bt="([^"]*)"/) || [])[1] || '';
            const ref = (attrs.match(/\br="([^"]*)"/) || [])[1] || '';
            let value = '';
            if (t === 'inlineStr') {
                const is = body.match(/<\s*is\b[^>]*>([\s\S]*?)<\/\s*is\s*>/);
                if (is) {
                    const tRe = /<\s*t\b[^>]*>([\s\S]*?)<\/\s*t\s*>/g;
                    let tm; let s = '';
                    while ((tm = tRe.exec(is[1])) !== null) s += tm[1];
                    value = xmlDecode(s);
                }
            } else {
                const v = body.match(/<\s*v\b[^>]*>([\s\S]*?)<\/\s*v\s*>/);
                if (v) {
                    const raw = v[1];
                    if (t === 's') value = (shared[Number(raw)] != null ? shared[Number(raw)] : '');
                    else if (t === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
                    else if (t === 'e') value = '';
                    else value = xmlDecode(raw);
                }
            }
            const idx = colIndex(ref);
            if (idx >= 0) cells[idx] = value;
            cellCount++;
            if (cellCount > MAX_CELLS) throw importError('IMPORT_TOO_LARGE', 'workbook exceeds the cell limit');
        }
        // Normalize row width to the longest row seen so far
        const rowArr = [];
        for (let i = 0; i < cells.length; i++) rowArr[i] = cells[i] == null ? '' : String(cells[i]);
        if (rowArr.length > MAX_COLUMNS) throw importError('IMPORT_TOO_LARGE', 'workbook exceeds the ' + MAX_COLUMNS + ' column limit');
        rows.push(rowArr);
    }

    if (!rows.length) return { headers: [], rows: [] };
    // First non-empty row = header
    const width = Math.max(...rows.map(r => r.length));
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].some(c => String(c).trim() !== '')) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return { headers: [], rows: [] };
    headers.push(...rows[headerIdx].map((h, i) => {
        const t = String(h == null ? '' : h).trim() || ('column' + (i + 1));
        return t;
    }));
    const dataRows = rows.slice(headerIdx + 1).filter(r => r.some(c => String(c).trim() !== ''));
    if (dataRows.length > MAX_ROWS) throw importError('IMPORT_TOO_LARGE', 'workbook exceeds the ' + MAX_ROWS + ' row limit');
    return { headers, rows: dataRows };
}

function parseXlsx(buffer) {
    const entries = zipEntries(buffer);
    const worksheetNames = Object.keys(entries).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    if (!worksheetNames.length) throw importError('IMPORT_MALFORMED', 'invalid .xlsx: no worksheet found');
    if (worksheetNames.length > MAX_WORKSHEETS) throw importError('IMPORT_TOO_LARGE', 'workbook has too many worksheets');
    // Parse only the first worksheet; more complex books are out of scope.
    worksheetNames.sort((a, b) => {
        const na = Number(a.match(/sheet(\d+)\.xml$/)[1]);
        const nb = Number(b.match(/sheet(\d+)\.xml$/)[1]);
        return na - nb;
    });

    let shared = [];
    if (entries['xl/sharedStrings.xml']) {
        const ssXml = readZipEntry(buffer, entries['xl/sharedStrings.xml']).toString('utf8');
        shared = parseSharedStrings(ssXml);
    }
    const sheetXml = readZipEntry(buffer, entries[worksheetNames[0]]).toString('utf8');
    return parseWorksheet(sheetXml, shared);
}

// ---------------------------------------------------------------------------
// COLUMN DETECTION — conservative alias matching. No aggressive fuzzy mapping:
// ambiguous headers stay unmapped and are surfaced in the preview for the user
// to confirm. Confidence: exact alias = high, token match = medium.
// ---------------------------------------------------------------------------
const ALIASES = {
    date: ['date', 'trade date', 'entry date', 'opened', 'open date', 'timestamp', 'datetime', 'opened at', 'entry datetime', 'close date', 'closed at', 'exit date', 'closed'],
    time: ['time', 'entry time', 'open time', 'exit time', 'close time', 'trade time'],
    symbol: ['symbol', 'ticker', 'instrument', 'asset', 'pair', 'market', 'fx pair', 'contract'],
    direction: ['direction', 'side', 'position', 'buy/sell', 'long/short', 'order side', 'type side', 'trade side'],
    entry: ['entry', 'entry price', 'open price', 'price in', 'buy price', 'avg entry', 'average entry', 'entry px'],
    exit: ['exit', 'exit price', 'close price', 'price out', 'sell price', 'avg exit', 'average exit', 'exit px'],
    size: ['size', 'qty', 'quantity', 'lots', 'contracts', 'shares', 'volume', 'position size', 'units', 'amount'],
    pnl: ['pnl', 'p&l', 'profit', 'profit/loss', 'profit loss', 'net profit', 'net pnl', 'realized pnl', 'total pnl', 'gross pnl', 'result pnl', 'net result', 'profit/loss usd'],
    risk: ['risk', 'risk $', 'risk amount', 'risk dollars', '$ risk', 'risked', 'amount risked', 'risk usd', 'dollar risk', 'risk per trade'],
    r: ['r', 'r multiple', 'r-multiple', 'risk reward result', 'rr', 'result r', 'r multiple result', 'multiple', 'r result'],
    setup: ['setup', 'pattern', 'setup type', 'setup name', 'entry setup', 'trade setup', 'pattern type'],
    strategy: ['strategy', 'system', 'strategy name', 'algo', 'method', 'trading system'],
    session: ['session', 'trading session', 'market session', 'time session'],
    emotion: ['emotion', 'feelings', 'mood', 'state of mind', 'psychology', 'emotional state'],
    notes: ['notes', 'note', 'comment', 'comments', 'journal', 'remarks', 'thoughts', 'summary', 'trade notes', 'reflection'],
    timeframe: ['timeframe', 'time frame', 'tf', 'chart timeframe', 'period', 'chart period'],
    stopLoss: ['stop loss', 'stop', 'sl', 'stoploss', 'initial stop', 'stop loss price'],
    takeProfit: ['take profit', 'target', 'tp', 'take profit price', 'target price', 'profit target'],
    externalRef: ['order id', 'ticket', 'ticket id', 'deal id', 'position id', 'reference', 'external id', 'broker id', 'trade id', 'ref', 'order', 'order number']
};

// Columns that are DETECTED but intentionally NOT mapped (the canonical model
// has no field for them). Surfaced as unsupported so nothing is silently lost.
const UNSUPPORTED = {
    fees: ['fees', 'commission', 'commissions', 'costs', 'swap', 'financing', 'slippage'],
    account: ['account', 'account name', 'account id', 'broker account'],
    balance: ['balance', 'equity', 'account balance', 'net liq'],
    tags: ['tags', 'labels', 'category', 'categories'],
    closedAt: ['closed at', 'exit date', 'close date', 'closed']
};

function normHeader(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// 'P&L' → 'pl' · 'Profit/Loss' → 'profitloss' · 'Stop Loss' → 'stoploss'.
// Punctuation (including & and /) is dropped entirely so journal variants of
// the same field compare equal.
const compact = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

function detectColumn(header) {
    const norm = normHeader(header);
    if (!norm) return { targetField: null, confidence: 'low' };
    const c = compact(norm);
    // exact alias match (punctuation-insensitive)
    for (const field of Object.keys(ALIASES)) {
        if (ALIASES[field].some(a => compact(a) === c)) return { targetField: field, confidence: 'high' };
    }
    // token match: any significant token equals a single-word alias
    const tokens = norm.split(' ').filter(t => t.length > 2);
    for (const field of Object.keys(ALIASES)) {
        if (ALIASES[field].some(a => a.indexOf(' ') === -1 && tokens.includes(a))) {
            return { targetField: field, confidence: 'medium' };
        }
    }
    return { targetField: null, confidence: 'low' };
}

// Build the mapping proposal. Date handling is two-pass: an explicit open-date
// column wins; a close/exit date column is used only when no open-date column
// exists (both feed ts). A 'trade time' column feeds the time-of-day instead.
const PRIMARY_DATE = new Set(['date', 'trade date', 'entry date', 'opened', 'open date', 'timestamp', 'datetime', 'opened at', 'entry datetime']);
const FALLBACK_DATE = new Set(['close date', 'closed at', 'exit date', 'closed']);

function detectColumns(headers) {
    const mapping = [];
    const unmappedColumns = [];
    const unsupportedColumns = [];
    const dateCols = [];

    // pass 1: bucket date columns (open-date vs close-date), map everything
    // else that has a recognized target; unmapped/unsupported are surfaced
    headers.forEach((h, i) => {
        const norm = normHeader(h);
        const det = detectColumn(h);
        if (det.targetField === 'date') {
            dateCols.push({ index: i, sourceColumn: h, primary: PRIMARY_DATE.has(norm) });
        } else if (det.targetField === 'time') {
            mapping.push({ index: i, sourceColumn: h, targetField: 'time', confidence: det.confidence });
        } else if (det.targetField) {
            mapping.push({ index: i, sourceColumn: h, targetField: det.targetField, confidence: det.confidence });
        } else {
            let unsupported = false;
            for (const key of Object.keys(UNSUPPORTED)) {
                if (UNSUPPORTED[key].includes(norm)) { unsupportedColumns.push({ index: i, sourceColumn: h, reason: key }); unsupported = true; break; }
            }
            if (!unsupported) unmappedColumns.push({ index: i, sourceColumn: h });
        }
    });

    // pass 2: one date column wins (open-date first, else the first close-date)
    const primary = dateCols.filter(d => d.primary);
    const chosen = primary.length ? primary : dateCols.slice(0, 1);
    const chosenIndexes = new Set(chosen.map(c => c.index));
    dateCols.forEach(c => {
        if (chosenIndexes.has(c.index)) {
            mapping.push({ index: c.index, sourceColumn: c.sourceColumn, targetField: 'date', confidence: 'high' });
        } else {
            unmappedColumns.push({ index: c.index, sourceColumn: c.sourceColumn });
        }
    });

    return { mapping, unmappedColumns, unsupportedColumns };
}

// ---------------------------------------------------------------------------
// FIELD NORMALIZATION — conservative, never guesses
// ---------------------------------------------------------------------------
function parseNumber(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    let s = String(raw).trim();
    if (!s) return null;
    const neg = s.startsWith('(') && s.endsWith(')');
    s = s.replace(/[()]/g, '').replace(/[$€£¥\s]/g, '');
    const hasPct = s.endsWith('%');
    s = s.replace(/%/g, '').replace(/,/g, '');
    if (!s) return null;
    const n = Number(s);
    if (isNaN(n) || !isFinite(n)) return null;
    const v = neg ? -Math.abs(n) : n;
    return hasPct ? v : v;
}

// Excel serial date (days since 1899-12-30) — only in a plausible range.
function excelSerialToDate(n) {
    if (n >= 20000 && n <= 80000) {
        const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
        if (!isNaN(d.getTime())) return { date: d, serial: true };
    }
    return null;
}

// Returns { ts, ambiguous } or null. Ambiguous = MM/DD vs DD/MM both valid.
function parseDateValue(raw) {
    if (raw == null) return null;
    if (raw instanceof Date && !isNaN(raw.getTime())) return { ts: raw, ambiguous: false };
    const s = String(raw).trim();
    if (!s) return null;

    // ISO date-only (YYYY-MM-DD): JS parses bare dates as UTC midnight, which
    // shifts the local hour — parse to LOCAL NOON so fingerprints stay
    // consistent with the other date branches (hour/minute must not drift).
    const isoDate = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (isoDate) {
        const d = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 12, 0, 0);
        if (!isNaN(d.getTime())) return { ts: d, ambiguous: false };
    }
    // full ISO timestamps (date + time, possibly with timezone) keep JS parsing
    let d = new Date(s);
    if (!isNaN(d.getTime()) && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}[T\s]/.test(s)) {
        return { ts: d, ambiguous: false };
    }
    // Excel serial
    const num = Number(s);
    if (/^\d+(\.\d+)?$/.test(s) && !isNaN(num)) {
        const serial = excelSerialToDate(num);
        if (serial) return { ts: serial.date, ambiguous: false, serial: true };
        // numeric but not serial → not a date
        return null;
    }
    // Month/Day[/Year] or Day/Month[/Year]
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (m) {
        let a = Number(m[1]), b = Number(m[2]);
        let year = m[3] ? Number(m[3]) : new Date().getFullYear();
        if (year < 100) year += 2000;
        const mmdd = (a >= 1 && a <= 12 && b >= 1 && b <= 31);
        const ddmm = (b >= 1 && b <= 12 && a >= 1 && a <= 31);
        let ts = null, ambiguous = false;
        if (mmdd && !ddmm) {
            ts = new Date(year, a - 1, b, 12, 0, 0);
        } else if (ddmm && !mmdd) {
            ts = new Date(year, b - 1, a, 12, 0, 0);
        } else if (mmdd && ddmm) {
            // both valid → ambiguous; default to US MM/DD, flagged for review
            ts = new Date(year, a - 1, b, 12, 0, 0);
            ambiguous = true;
        } else {
            return null;
        }
        if (isNaN(ts.getTime())) return null;
        return { ts, ambiguous };
    }
    // Month-name dates: "Aug 4, 2026" / "04 Aug 2026"
    d = new Date(s);
    if (!isNaN(d.getTime()) && /[a-z]/i.test(s)) return { ts: d, ambiguous: false };
    return null;
}

// Apply a parsed time (HH:MM[:SS]) onto a date.
function applyTime(ts, raw) {
    const s = String(raw == null ? '' : raw).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return ts;
    let h = Number(m[1]), min = Number(m[2]), sec = Number(m[3] || 0);
    if (/pm/i.test(m[4]) && h < 12) h += 12;
    if (/am/i.test(m[4]) && h === 12) h = 0;
    if (h > 23 || min > 59 || sec > 59) return ts;
    const d = new Date(ts);
    d.setHours(h, min, sec, 0);
    return d;
}

function normalizeSymbol(raw) {
    let s = String(raw == null ? '' : raw).trim().toUpperCase();
    // conservative: strip FX pair separators so EUR/USD → EURUSD (the canonical
    // form the asset spec engine recognizes); nothing else is rewritten.
    s = s.replace(/[\\/]/g, '');
    if (!s || s.length > MAX_NAME_LEN) return null;
    return s;
}

// BUY/LONG/L/1 → LONG · SELL/SHORT/S/-1 → SHORT. Numeric mappings are only
// accepted with the widely-used 1/-1 convention and are flagged as assumed.
function normalizeDirection(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return { dir: null, assumed: false };
    if (['buy', 'long', 'l', 'b', 'long (buy)'].includes(s)) return { dir: 'Long', assumed: false };
    if (['sell', 'short', 's', 'sh', 'short (sell)'].includes(s)) return { dir: 'Short', assumed: false };
    if (s === '1' || s === '+1') return { dir: 'Long', assumed: true };
    if (s === '-1') return { dir: 'Short', assumed: true };
    if (s === '0') return { dir: null, assumed: false };
    return { dir: null, assumed: false };
}

// ---------------------------------------------------------------------------
// ROW VALIDATION — VALID / WARNING / ERROR / DUPLICATE / POSSIBLE_DUPLICATE
// ---------------------------------------------------------------------------
function fingerprintOf(values) {
    const num = v => (v == null || v === '' || isNaN(v) ? '' : Math.round(Number(v) * 1e6) / 1e6);
    const ts = values.ts instanceof Date ? values.ts : new Date(values.ts);
    const tsKey = isNaN(ts.getTime()) ? '' : ts.getFullYear() + '-' + (ts.getMonth() + 1) + '-' + ts.getDate() + ' ' + ts.getHours() + ':' + ts.getMinutes();
    return [
        values.account_id || '', String(values.symbol || '').toUpperCase(), values.dir || '', tsKey,
        num(values.entry), num(values.exit), num(values.size), num(values.pnl)
    ].join('|');
}

function partialKey(values) {
    const ts = values.ts instanceof Date ? values.ts : new Date(values.ts);
    const day = isNaN(ts.getTime()) ? '' : ts.getFullYear() + '-' + (ts.getMonth() + 1) + '-' + ts.getDate();
    return [values.account_id || '', String(values.symbol || '').toUpperCase(), values.dir || '', day].join('|');
}

function fingerprintTrade(t) {
    const ts = t.ts instanceof Date ? t.ts : new Date(t.ts);
    const tsKey = isNaN(ts.getTime()) ? '' : ts.getFullYear() + '-' + (ts.getMonth() + 1) + '-' + ts.getDate() + ' ' + ts.getHours() + ':' + ts.getMinutes();
    const num = v => (v == null || v === '' || isNaN(v) ? '' : Math.round(Number(v) * 1e6) / 1e6);
    return [t.account_id || '', String(t.symbol || '').toUpperCase(), t.dir || '', tsKey,
        num(t.entry), num(t.exit), num(t.size), num(t.pnl)].join('|');
}

// Classify duplicates for one row against (a) earlier rows in the same file,
// (b) the account's existing canonical trades, (c) previously imported batches.
// Returns { state, reason }.
function classifyRow(row, ctx, seen) {
    const { existingByFp, existingByPartial, batchFps } = ctx;
    const fp = fingerprintOf(row.values);
    const pk = partialKey(row.values);

    if (seen.has(fp) || (batchFps && batchFps.has(fp))) {
        return { state: 'DUPLICATE', reason: 'Identical trade already in this import or a previous import.' };
    }
    if (existingByFp.has(fp)) {
        return { state: 'DUPLICATE', reason: 'Matches a trade already in the journal for this account.' };
    }
    if (existingByPartial.has(pk)) {
        return { state: 'POSSIBLE_DUPLICATE', reason: 'Same symbol, direction and date as an existing journal trade — verify before importing.' };
    }
    return { state: 'NEW', reason: '' };
}

// Build the full per-row processing: normalize → validate → classify.
// ctx = { accountId, strategies (names), existingTrades, batchFps }
function buildRows(headers, rawRows, mapping, ctx) {
    const byField = {};
    mapping.forEach(m => { byField[m.sourceColumn] = m.targetField; });

    const existingByFp = new Map();
    const existingByPartial = new Map();
    (ctx.existingTrades || []).forEach(t => {
        if (t.account_id !== ctx.accountId) return;
        existingByFp.set(fingerprintTrade(t), true);
        const ts = t.ts instanceof Date ? t.ts : new Date(t.ts);
        if (!isNaN(ts.getTime())) {
            const day = ts.getFullYear() + '-' + (ts.getMonth() + 1) + '-' + ts.getDate();
            existingByPartial.set([ctx.accountId, String(t.symbol || '').toUpperCase(), t.dir || '', day].join('|'), true);
        }
    });
    const batchFps = new Set(ctx.batchFps || []);
    const seen = new Set();
    const strategies = new Map((ctx.strategies || []).map(s => [String(s.name || '').toLowerCase(), s]));

    const out = [];
    rawRows.forEach((rawRow, idx) => {
        const rowNumber = idx + 2; // +1 for header; source row numbering starts at 2
        const errors = [];
        const warnings = [];
        const values = { account_id: ctx.accountId };

        let dateRaw = null, timeRaw = null;
        const fieldOf = (target) => {
            for (const k of Object.keys(byField)) {
                if (byField[k] === target) return k;
            }
            return null;
        };
        const rawOf = (target) => {
            const col = fieldOf(target);
            if (col == null) return undefined;
            const i = mapping.find(m => m.sourceColumn === col).index;
            return rawRow[i];
        };
        const set = (target, fn) => {
            const col = fieldOf(target);
            if (col == null) return;
            const i = mapping.find(m => m.sourceColumn === col).index;
            const raw = rawRow[i];
            if (raw == null || String(raw).trim() === '') return;
            const r = fn(raw);
            if (r != null) values[target] = r;
        };

        // ---- date + time (required) ----
        dateRaw = rawOf('date');
        timeRaw = rawOf('time');
        let parsed = null;
        if (dateRaw != null && String(dateRaw).trim() !== '') {
            parsed = parseDateValue(dateRaw);
            if (!parsed) errors.push({ field: 'date', problem: 'Unrecognized date format "' + String(dateRaw).slice(0, 40) + '"' });
            else if (parsed.ambiguous) warnings.push({ field: 'date', problem: 'Date "' + String(dateRaw) + '" is ambiguous (MM/DD vs DD/MM) — imported as US MM/DD. Confirm before importing.' });
        }
        if (!parsed) {
            errors.push({ field: 'date', problem: 'Date is required for every trade' });
        } else {
            values.ts = parsed.ts;
            if (timeRaw != null && String(timeRaw).trim() !== '') {
                const nt = applyTime(parsed.ts, timeRaw);
                if (nt.getTime() !== parsed.ts.getTime()) values.ts = nt;
            }
        }

    // ---- symbol (required) — kept as-is (identifiable, never rewritten) ----
    const symbolRaw = rawOf('symbol');
    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) errors.push({ field: 'symbol', problem: 'Symbol is required' });
    else values.symbol = symbol;

        // ---- direction (required) ----
        const dirRaw = rawOf('direction');
        const dir = normalizeDirection(dirRaw);
        if (!dir.dir) {
            errors.push({ field: 'direction', problem: 'Direction must be Long/Buy or Short/Sell (got "' + String(dirRaw == null ? '' : dirRaw).slice(0, 20) + '")' });
        } else {
            values.dir = dir.dir;
            if (dir.assumed) warnings.push({ field: 'direction', problem: 'Numeric direction "' + String(dirRaw) + '" assumed 1=Long / -1=Short.' });
        }

        // ---- numeric outcome fields ----
        set('entry', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'entry', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        set('exit', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'exit', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        set('size', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'size', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        set('pnl', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'pnl', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        set('risk', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'risk', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        set('r', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'r', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        set('stopLoss', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'stopLoss', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        set('takeProfit', v => { const n = parseNumber(v); if (n == null) { errors.push({ field: 'takeProfit', problem: 'Invalid number "' + String(v).slice(0, 20) + '"' }); } return n; });
        if (values.stopLoss != null) values.stop = values.stopLoss;
        if (values.takeProfit != null) values.tp = values.takeProfit;

        // outcome gate: pnl OR (entry+exit+size) must exist — never fabricate
        const hasOutcome = values.pnl != null || (values.entry != null && values.exit != null && values.size != null && values.size > 0);
        if (!hasOutcome) {
            errors.push({ field: 'pnl', problem: 'No trade outcome — provide P&L, or entry + exit + size so it can be derived.' });
        }

        // ---- optional text fields ----
        set('setup', v => String(v).trim().slice(0, MAX_NAME_LEN));
        set('session', v => String(v).trim().slice(0, 100));
        set('emotion', v => String(v).trim().slice(0, 100));
        set('notes', v => String(v).trim().slice(0, 5000));
        set('timeframe', v => String(v).trim().toUpperCase().slice(0, 20));
        set('strategy', v => {
            const name = String(v).trim();
            const match = strategies.get(name.toLowerCase());
            if (match) return match.id;
            warnings.push({ field: 'strategy', problem: 'Strategy "' + name.slice(0, 40) + '" not found in Battlex — trade will use the account\'s default strategy.' });
            return null;
        });
        set('externalRef', v => String(v).trim().slice(0, 200));

        // ---- warnings for fields the source HAD but left blank ----
        ['setup', 'session', 'emotion'].forEach(f => {
            if (fieldOf(f) != null && (values[f] == null || values[f] === '')) {
                warnings.push({ field: f, problem: f.charAt(0).toUpperCase() + f.slice(1) + ' was blank in the source — left unknown.' });
            }
        });

        // ---- build canonical trade draft ----
        const draft = {
            id: null,
            account_id: ctx.accountId,
            ts: values.ts,
            symbol: values.symbol,
            dir: values.dir,
            entry: values.entry != null ? values.entry : undefined,
            exit: values.exit != null ? values.exit : undefined,
            size: values.size != null ? values.size : undefined,
            pnl: values.pnl != null ? values.pnl : undefined,
            risk: values.risk != null ? values.risk : undefined,
            r: values.r != null ? values.r : undefined,
            setup: values.setup || undefined,
            session: values.session || undefined,
            emotion: values.emotion || undefined,
            note: values.notes || undefined,
            timeframe: values.timeframe || undefined,
            stop: values.stop,
            tp: values.tp,
            strategy_id: values.strategy || undefined,
            source: 'IMPORT',
            import_batch_id: ctx.batchId,
            import_meta: {
                source_row: rowNumber,
                external_ref: values.externalRef || null,
                filename: ctx.filename || null
            }
        };

        let state = errors.length ? 'ERROR' : (warnings.length ? 'WARNING' : 'VALID');
        let dupReason = '';
        if (state !== 'ERROR') {
            const dup = classifyRow({ values: draft }, { existingByFp, existingByPartial, batchFps }, seen);
            if (dup.state !== 'NEW') {
                state = dup.state;
                dupReason = dup.reason;
            } else {
                seen.add(fingerprintOf(draft));
            }
        }

        out.push({ rowNumber, state, values: draft, errors, warnings, dupReason });
    });
    return out;
}

// ---------------------------------------------------------------------------
// PREVIEW SUMMARY + CSV-INJECTION-SAFE EXPORT ESCAPING
// ---------------------------------------------------------------------------
function summarize(rows) {
    const stats = { total: rows.length, valid: 0, warning: 0, error: 0, duplicate: 0, possibleDuplicate: 0 };
    rows.forEach(r => { stats[r.state.toLowerCase()] = (stats[r.state.toLowerCase()] || 0) + 1; });
    return stats;
}

// CSV injection protection: cells whose text starts with = + - @ can become
// executable formulas when re-opened in Excel. A '-' is only treated as safe
// when the whole cell is a plain number (-125.50); '-1+1' is an expression and
// gets escaped. Numbers passed with isNumeric=true are never touched.
function csvEscapeCell(value, isNumeric) {
    const s = value == null ? '' : String(value);
    if (isNumeric) return '"' + s.replace(/"/g, '""') + '"';
    const t = s.trim();
    const isPlainNumber = /^-?\d+(\.\d+)?$/.test(t);
    if (/^[=+@]/.test(t) || (/^-/.test(t) && !isPlainNumber)) {
        return "'" + s.replace(/"/g, '""') + "'"
    }
    return '"' + s.replace(/"/g, '""') + '"';
}

// ---------------------------------------------------------------------------
// PERSISTENCE — per-user batch store. File-first, best-effort Supabase mirror
// (import_batches table, jsonb payload) — same pattern as brokers.js.
// ---------------------------------------------------------------------------
function dataDir() {
    return process.env.TRADEMIND_IMPORT_DATA_DIR || path.join(__dirname, '..', 'data');
}

function fileFor(userId) {
    return path.join(dataDir(), 'imports-' + userId + '.json');
}

function readFile(userId) {
    try {
        const f = fileFor(userId);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { /* ignore */ }
    return [];
}

function writeFile(userId, list) {
    try {
        const f = fileFor(userId);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(list));
        fs.renameSync(tmp, f);
    } catch (e) { /* ignore */ }
}

async function listBatches(userId) {
    const pool = db.getPool();
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT data FROM import_batches WHERE user_id = $1 ORDER BY (data->>\'createdAt\') DESC', [userId]);
            if (r.rows.length) return r.rows.map(x => x.data);
        } catch (e) { /* table missing / db down → file fallback */ }
    }
    return readFile(userId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getBatch(userId, id) {
    const pool = db.getPool();
    if (pool) {
        try {
            const r = await pool.query('SELECT data FROM import_batches WHERE user_id = $1 AND id = $2', [userId, id]);
            if (r.rows.length) return r.rows[0].data;
        } catch (e) { /* fallback */ }
    }
    return readFile(userId).find(b => b.id === id) || null;
}

async function saveBatch(userId, batch) {
    // file mirror always (single source of truth for the full batch object)
    const list = readFile(userId);
    const i = list.findIndex(b => b.id === batch.id);
    if (i >= 0) list[i] = batch; else list.push(batch);
    writeFile(userId, list);

    // best-effort DB mirror (summary + full jsonb payload)
    const pool = db.getPool();
    if (pool) {
        try {
            await pool.query(
                'INSERT INTO import_batches (id, user_id, account_id, status, fingerprint, data) VALUES ($1, $2, $3, $4, $5, $6) ' +
                'ON CONFLICT (id) DO UPDATE SET account_id = EXCLUDED.account_id, status = EXCLUDED.status, ' +
                'fingerprint = EXCLUDED.fingerprint, data = EXCLUDED.data',
                [batch.id, userId, batch.accountId || '', batch.status || 'UPLOADED', batch.fileHash || null, batch]);
        } catch (e) { /* db unavailable — file mirror is authoritative */ }
    }
    return batch;
}

async function deleteBatch(userId, id) {
    const list = readFile(userId).filter(b => b.id !== id);
    writeFile(userId, list);
    const pool = db.getPool();
    if (pool) {
        try { await pool.query('DELETE FROM import_batches WHERE user_id = $1 AND id = $2', [userId, id]); } catch (e) { /* ignore */ }
    }
}

function genBatchId() {
    return 'imp-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function fileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// RATE LIMITING — cheap in-memory guard against repeated expensive operations
// ---------------------------------------------------------------------------
const rateBuckets = new Map();   // `${userId}:${action}` → { windowStart, count }
function rateLimit(userId, action, limit, windowMs) {
    const key = userId + ':' + action;
    const now = Date.now();
    const b = rateBuckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
        rateBuckets.set(key, { windowStart: now, count: 1 });
        return { allowed: true, remaining: limit - 1 };
    }
    b.count++;
    return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count) };
}
function resetRateLimits() { rateBuckets.clear(); }

module.exports = {
    // limits & types
    SOURCE_TYPES, BATCH_STATUS, MAX_FILE_SIZE, MAX_UPLOAD_BODY, MAX_ROWS, MAX_COLUMNS, MAX_CELLS, MAX_WORKSHEETS,
    // security + parsing
    validateUpload, parseDelimited, parseCsv: parseDelimited, parseXlsx, detectColumns,
    // normalization + validation + duplicates
    parseNumber, parseDateValue, normalizeDirection, normalizeSymbol, fingerprintOf, classifyRow,
    buildRows, summarize,
    // csv injection safety
    csvEscapeCell,
    // persistence
    listBatches, getBatch, saveBatch, deleteBatch, genBatchId, fileHash,
    // rate limiting
    rateLimit, resetRateLimits,
    importError, extOf
};
