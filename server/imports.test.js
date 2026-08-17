'use strict';

// ============================================================================
// Legacy Journal Import Engine tests (server/imports.js + the HTTP routes)
// ----------------------------------------------------------------------------
//   §1 CSV parsing            — quotes, embedded newlines, delimiter detect, BOM
//   §2 Column detection       — aliases, P&L, date fallback, unmapped/unsupported
//   §3 Normalization          — numbers, dates (ISO/US/EU-ambiguous/serial),
//                               direction, symbol
//   §4 Row validation         — required fields, outcome gate, warnings
//   §5 Duplicate detection    — exact, partial, re-upload fingerprint, in-file
//   §6 CSV injection          — formula-safe export escaping
//   §7 File security          — extension, magic bytes, size, macros
//   §8 XLSX parsing           — structural zip/xml, no formula execution
//   §9 Persistence/isolation  — per-user batches, cross-user reads blocked
//   §10 HTTP end-to-end       — real server: upload → preview → commit → ledger
//                               → duplicate re-upload → double commit → rollback
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

// isolate from any real Postgres config — file-fallback mode only
delete process.env.SUPABASE_DB_URL;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'imports-test-'));
process.env.TRADEMIND_IMPORT_DATA_DIR = path.join(TMP, 'imports');

const I = require('./imports.js');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ok  ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
}

const simpleCtx = (over) => Object.assign({
    accountId: 'acc-1', batchId: 'b1', filename: 't.csv',
    existingTrades: [], strategies: [{ id: 's1', name: 'London FVG' }], batchFps: []
}, over || {});

async function main() {
    // -----------------------------------------------------------------------
    // §1 · CSV parsing
    // -----------------------------------------------------------------------
    console.log('\n§1 CSV parsing');
    {
        const p = I.parseCsv('Date,Symbol,Side,Entry,Exit,P&L\n2026-01-05,EURUSD,Buy,1.10,1.11,100\n');
        ok(p.headers.length === 6 && p.rows.length === 1, 'basic csv parses header + 1 row');
        ok(p.rows[0][5] === '100', 'row values aligned to columns');

        const q = I.parseCsv('a,b\n"hello, world","line1\nline2"\n');
        ok(q.rows[0][0] === 'hello, world' && q.rows[0][1] === 'line1\nline2', 'quoted commas + embedded newlines');

        const esc = I.parseCsv('a,b\n"say ""hi""",x\n');
        ok(esc.rows[0][0] === 'say "hi"', 'escaped double quotes');

        const tab = I.parseCsv('Date\tSymbol\tP&L\n2026-01-05\tEURUSD\t100\n');
        ok(tab.headers[1] === 'Symbol', 'tab-delimited detected');

        const semi = I.parseCsv('Date;Symbol\n2026-01-05;EURUSD\n');
        ok(semi.headers[1] === 'Symbol', 'semicolon-delimited detected');

        const bom = I.parseCsv('\uFEFFDate,Symbol\n2026-01-05,EURUSD\n');
        ok(bom.headers[0] === 'Date', 'BOM stripped');

        const dup = I.parseCsv('a,a,b\n1,2,3\n');
        ok(dup.headers[1] === 'a (2)', 'duplicate headers deduped');
    }

    // -----------------------------------------------------------------------
    // §2 · Column detection
    // -----------------------------------------------------------------------
    console.log('\n§2 Column detection');
    {
        const m = I.detectColumns(['Date', 'Symbol', 'Side', 'Entry', 'Exit', 'P&L', 'Size', 'Strategy', 'Notes', 'Timeframe', 'Stop Loss', 'Order ID', 'Commission']);
        const by = Object.fromEntries(m.mapping.map(x => [x.sourceColumn, x.targetField]));
        ok(by['Date'] === 'date' && by['Symbol'] === 'symbol' && by['Side'] === 'direction', 'core columns mapped');
        ok(by['P&L'] === 'pnl', 'P&L maps to pnl (punctuation-insensitive)');
        ok(by['Entry'] === 'entry' && by['Exit'] === 'exit' && by['Size'] === 'size', 'entry/exit/size mapped');
        ok(by['Strategy'] === 'strategy' && by['Notes'] === 'notes', 'strategy + notes mapped');
        ok(by['Timeframe'] === 'timeframe', 'timeframe mapped');
        ok(by['Stop Loss'] === 'stopLoss' && by['Order ID'] === 'externalRef', 'stopLoss + externalRef mapped');
        ok(m.unsupportedColumns.some(c => c.sourceColumn === 'Commission' && c.reason === 'fees'), 'fees flagged unsupported (not silently dropped)');
        ok(m.mapping.every(x => x.confidence === 'high'), 'all exact alias matches are high confidence');

        const close = I.detectColumns(['Close Date', 'Symbol']);
        ok(close.mapping.some(x => x.sourceColumn === 'Close Date' && x.targetField === 'date'), 'close date used when no open date exists');
        const both = I.detectColumns(['Entry Date', 'Close Date', 'Symbol']);
        ok(both.mapping.some(x => x.sourceColumn === 'Entry Date' && x.targetField === 'date'), 'open date wins when both exist');
        ok(both.mapping.every(x => x.sourceColumn !== 'Close Date'), 'close date not mapped when open date exists');

        const t = I.detectColumns(['Date', 'Time', 'Symbol']);
        ok(t.mapping.some(x => x.targetField === 'time'), 'time column detected separately');
    }

    // -----------------------------------------------------------------------
    // §3 · Normalization
    // -----------------------------------------------------------------------
    console.log('\n§3 Normalization');
    {
        ok(I.parseNumber('$1,250.50') === 1250.5, 'currency + commas parsed');
        ok(I.parseNumber('(1,250.50)') === -1250.5, 'parenthesized negative parsed');
        ok(I.parseNumber('-125.50') === -125.5, 'plain negative parsed');
        ok(I.parseNumber('') === null && I.parseNumber('abc') === null, 'empty/garbage → null');
        ok(I.parseNumber('1.250') === 1.25, 'decimal not misread as thousands');

        const iso = I.parseDateValue('2026-01-05');
        ok(iso && !iso.ambiguous && iso.ts.getFullYear() === 2026 && iso.ts.getMonth() === 0 && iso.ts.getDate() === 5, 'ISO date parsed');
        const us = I.parseDateValue('01/06/2026');
        ok(us && us.ambiguous === true, '01/06/2026 flagged ambiguous (US + EU both valid)');
        const eu = I.parseDateValue('25/12/2026');
        ok(eu && !eu.ambiguous && eu.ts.getDate() === 25, '25/12/2026 unambiguous → day 25');
        const serial = I.parseDateValue('46000');
        ok(serial && serial.serial && serial.ts.getUTCFullYear() === 2025, 'Excel serial date parsed');
        ok(I.parseDateValue('not-a-date') === null, 'garbage date → null');

        ok(I.normalizeDirection('Buy').dir === 'Long' && I.normalizeDirection('SELL').dir === 'Short', 'Buy/Sell normalized');
        ok(I.normalizeDirection('L').dir === 'Long' && I.normalizeDirection('S').dir === 'Short', 'L/S normalized');
        ok(I.normalizeDirection('1').dir === 'Long' && I.normalizeDirection('-1').dir === 'Short', '1/-1 numeric convention');
        ok(I.normalizeDirection('1').assumed === true, 'numeric direction flagged as assumed');
        ok(I.normalizeDirection('?').dir === null, 'ambiguous direction rejected');
    }

    // -----------------------------------------------------------------------
    // §4 · Row validation
    // -----------------------------------------------------------------------
    console.log('\n§4 Row validation');
    {
        const csv = 'Date,Symbol,Side,Entry,Exit,P&L,Size,Notes\n' +
            '2026-01-05,EURUSD,Buy,1.10,1.11,100,1,good\n' +
            'bad,EURUSD,Buy,1.10,1.11,100,1,bad date\n' +
            '2026-01-06,,Buy,1.10,1.11,100,1,no symbol\n' +
            '2026-01-07,EURUSD,?,1.10,1.11,100,1,bad direction\n' +
            '2026-01-08,EURUSD,Buy,,,,1,no outcome\n';
        const p = I.parseCsv(csv);
        const m = I.detectColumns(p.headers);
        const rows = I.buildRows(p.headers, p.rows, m.mapping, simpleCtx());
        ok(rows[0].state === 'VALID' && rows[0].values.pnl === 100, 'valid row → VALID with pnl');
        ok(rows[1].state === 'ERROR' && rows[1].errors.some(e => e.field === 'date'), 'bad date → ERROR');
        ok(rows[2].state === 'ERROR' && rows[2].errors.some(e => e.field === 'symbol'), 'missing symbol → ERROR');
        ok(rows[3].state === 'ERROR' && rows[3].errors.some(e => e.field === 'direction'), 'bad direction → ERROR');
        ok(rows[4].state === 'ERROR' && rows[4].errors.some(e => e.field === 'pnl'), 'missing outcome → ERROR (never fabricated)');
        const st = I.summarize(rows);
        ok(st.valid === 1 && st.error === 4, 'summarize counts states');

        const csv2 = 'Date,Symbol,Side,Entry,Exit,Size\n2026-01-09,EURUSD,Buy,1.10,1.11,1\n';
        const p2 = I.parseCsv(csv2);
        const m2 = I.detectColumns(p2.headers);
        const rows2 = I.buildRows(p2.headers, p2.rows, m2.mapping, simpleCtx());
        ok(rows2[0].state === 'VALID', 'entry+exit+size accepted as derivable outcome');
    }

    // -----------------------------------------------------------------------
    // §5 · Duplicate detection
    // -----------------------------------------------------------------------
    console.log('\n§5 Duplicate detection');
    {
        const csv = 'Date,Symbol,Side,Entry,Exit,P&L,Size\n' +
            '2026-01-05,EURUSD,Buy,1.10,1.11,100,1\n' +
            '2026-01-05,EURUSD,Buy,1.10,1.11,100,1\n' +
            '2026-01-05,EURUSD,Buy,1.10,1.11,101,1\n' +
            '2026-01-06,EURUSD,Buy,1.10,1.11,100,1\n';
        const p = I.parseCsv(csv);
        const m = I.detectColumns(p.headers);
        const existing = [{
            id: 'txn-1', account_id: 'acc-1', ts: new Date('2026-01-06T12:00:00'), symbol: 'EURUSD',
            dir: 'Long', entry: 1.1, exit: 1.11, size: 1, pnl: 100
        }];
        const rows = I.buildRows(p.headers, p.rows, m.mapping, simpleCtx({ existingTrades: existing }));
        ok(rows[0].state === 'VALID', 'first row NEW');
        ok(rows[1].state === 'DUPLICATE', 'identical in-file row → DUPLICATE');
        ok(rows[2].state === 'VALID', 'different P&L (100 vs 101) is NOT a duplicate');
        ok(rows[3].state === 'DUPLICATE', 'matches existing journal trade exactly → DUPLICATE');

        const csv2 = 'Date,Symbol,Side,P&L\n2026-01-06,EURUSD,Buy,100\n';
        const p2 = I.parseCsv(csv2);
        const m2 = I.detectColumns(p2.headers);
        const rows2 = I.buildRows(p2.headers, p2.rows, m2.mapping, simpleCtx({ existingTrades: existing }));
        ok(rows2[0].state === 'POSSIBLE_DUPLICATE', 'same symbol+day but missing prices → POSSIBLE_DUPLICATE');

        const csv3 = 'Date,Symbol,Side,P&L\n2026-02-01,EURUSD,Buy,50\n';
        const p3 = I.parseCsv(csv3);
        const m3 = I.detectColumns(p3.headers);
        const r3 = I.buildRows(p3.headers, p3.rows, m3.mapping, simpleCtx());
        const fp = I.fingerprintOf(r3[0].values);
        const r3b = I.buildRows(p3.headers, p3.rows, m3.mapping, simpleCtx({ batchFps: [fp] }));
        ok(r3b[0].state === 'DUPLICATE', 'row already imported in a previous batch → DUPLICATE');
    }

    // -----------------------------------------------------------------------
    // §6 · CSV injection
    // -----------------------------------------------------------------------
    console.log('\n§6 CSV injection');
    {
        ok(I.csvEscapeCell('=HYPERLINK("http://evil")', false) === '\'=HYPERLINK(""http://evil"")\'', 'leading = escaped (quotes doubled for CSV safety)');
        ok(I.csvEscapeCell('+cmd', false) === '\'+cmd\'', 'leading + escaped');
        ok(I.csvEscapeCell('-1+1', false) === '\'-1+1\'', 'leading - expression escaped');
        ok(I.csvEscapeCell('@SUM(A1)', false) === '\'@SUM(A1)\'', 'leading @ escaped');
        ok(I.csvEscapeCell('-125.50', false) === '"-125.50"', 'plain negative number NOT escaped');
        ok(I.csvEscapeCell('-125.50', true) === '"-125.50"', 'numeric negative left untouched');
        ok(I.csvEscapeCell('EURUSD', false) === '"EURUSD"', 'plain text quoted, not escaped');
        ok(I.csvEscapeCell('he said "hi"', false) === '"he said ""hi"""', 'quotes doubled inside cells');
    }

    // -----------------------------------------------------------------------
    // §7 · File security
    // -----------------------------------------------------------------------
    console.log('\n§7 File security');
    {
        const csvBuf = Buffer.from('Date,Symbol\n2026-01-05,EURUSD\n', 'utf8');
        ok(I.validateUpload({ filename: 'j.csv', contentType: 'text/csv', data: csvBuf }).ok, 'csv accepted');
        ok(!I.validateUpload({ filename: 'j.xlsm', contentType: '', data: csvBuf }).ok, '.xlsm rejected (macros)');
        ok(!I.validateUpload({ filename: 'j.exe', contentType: '', data: csvBuf }).ok, '.exe rejected');
        ok(!I.validateUpload({ filename: 'j.csv', contentType: '', data: Buffer.alloc(0) }).ok, 'empty file rejected');
        ok(!I.validateUpload({ filename: 'j.csv', contentType: '', data: Buffer.alloc(I.MAX_FILE_SIZE + 1) }).ok, 'oversized file rejected');
        ok(!I.validateUpload({ filename: 'j.xlsx', contentType: '', data: Buffer.from('not a zip') }).ok, 'xlsx without ZIP magic rejected');
        ok(!I.validateUpload({ filename: 'j.csv', contentType: '', data: Buffer.from([0, 1, 2, 3]) }).ok, 'binary CSV rejected (NUL bytes)');
        const macro = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('junk vbaProject.bin junk')]);
        ok(!I.validateUpload({ filename: 'j.xlsx', contentType: '', data: macro }).ok, 'macro reference inside xlsx rejected');
    }

    // -----------------------------------------------------------------------
    // §8 · XLSX parsing (structural — no formula execution)
    // -----------------------------------------------------------------------
    console.log('\n§8 XLSX parsing');
    {
        const colName = n => { let s = ''; n++; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
        const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        function buildXlsx(headers, rows) {
            // every string cell (headers AND data) must exist in sharedStrings
            const shared = [...new Set([...headers, ...rows.flat()].filter(v => typeof v === 'string'))];
            const ssXml = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + shared.length + '">' +
                shared.map(s => '<si><t>' + xmlEsc(s) + '</t></si>').join('') + '</sst>';
            const all = [headers, ...rows];
            const sheetXml = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
                all.map((row, ri) => '<row r="' + (ri + 1) + '">' +
                    row.map((v, ci) => {
                        const t = typeof v === 'string' ? ' t="s"' : '';
                        const val = typeof v === 'string' ? String(shared.indexOf(v)) : String(v);
                        return '<c r="' + colName(ci) + (ri + 1) + '"' + t + '><v>' + val + '</v></c>';
                    }).join('') + '</row>').join('') + '</sheetData></worksheet>';
            const wbXml = '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
            const entries = [
                { name: 'xl/workbook.xml', data: Buffer.from(wbXml) },
                { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml) },
                { name: 'xl/sharedStrings.xml', data: Buffer.from(ssXml) }
            ];
            const chunks = [], central = [];
            let offset = 0;
            for (const e of entries) {
                const nb = Buffer.from(e.name, 'utf8');
                const lfh = Buffer.alloc(30);
                lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4);
                lfh.writeUInt16LE(0, 8); lfh.writeUInt32LE(e.data.length, 18);
                lfh.writeUInt32LE(e.data.length, 22); lfh.writeUInt16LE(nb.length, 26);
                chunks.push(lfh, nb, e.data);
                central.push({ nb, size: e.data.length, offset });
                offset += 30 + nb.length + e.data.length;
            }
            const cdStart = offset, cd = [];
            for (const c of central) {
                const h = Buffer.alloc(46);
                h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 6);
                h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
                h.writeUInt16LE(c.nb.length, 28); h.writeUInt32LE(c.offset, 42);
                cd.push(h, c.nb);
            }
            const cdBuf = Buffer.concat(cd);
            const eocd = Buffer.alloc(22);
            eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8);
            eocd.writeUInt16LE(central.length, 10); eocd.writeUInt32LE(cdBuf.length, 12);
            eocd.writeUInt32LE(cdStart, 16);
            return Buffer.concat([...chunks, cdBuf, eocd]);
        }

        const xlsx = buildXlsx(['Date', 'Symbol', 'Side', 'P&L'], [['2026-01-05', 'EURUSD', 'Buy', 100]]);
        ok(I.validateUpload({ filename: 'j.xlsx', contentType: '', data: xlsx }).ok, 'built xlsx passes file validation');
        const p = I.parseXlsx(xlsx);
        ok(p.headers[0] === 'Date' && p.headers[1] === 'Symbol', 'xlsx headers read');
        ok(p.rows[0][1] === 'EURUSD' && p.rows[0][3] === '100', 'shared strings + numbers read from sheet');

        const m = I.detectColumns(p.headers);
        const rows = I.buildRows(p.headers, p.rows, m.mapping, simpleCtx());
        ok(rows[0].state === 'VALID' && rows[0].values.symbol === 'EURUSD' && rows[0].values.pnl === 100, 'xlsx rows flow through the same pipeline');

        let threw = false;
        try { I.parseXlsx(Buffer.from('garbage')); } catch (e) { threw = true; }
        ok(threw, 'malformed xlsx throws (no crash)');
    }

    // -----------------------------------------------------------------------
    // §9 · Persistence + user isolation
    // -----------------------------------------------------------------------
    console.log('\n§9 Persistence + user isolation');
    {
        const b = { id: 'imp-test-1', userId: 'u-alice', accountId: 'acc-1', status: 'READY', createdAt: new Date().toISOString(), rows: [{ rowNumber: 2 }], fingerprints: ['fp-1'], mapping: [], unmappedColumns: [], unsupportedColumns: [] };
        await I.saveBatch('u-alice', b);
        const got = await I.getBatch('u-alice', 'imp-test-1');
        ok(got && got.id === 'imp-test-1' && got.fingerprints[0] === 'fp-1', 'batch persisted + reloaded');
        ok(await I.getBatch('u-bob', 'imp-test-1') === null, 'another user cannot read the batch (isolation)');
        const list = await I.listBatches('u-alice');
        ok(list.length === 1 && list[0].id === 'imp-test-1', 'listBatches scoped to user');
        ok((await I.listBatches('u-bob')).length === 0, 'listBatches empty for other user');
        await I.deleteBatch('u-alice', 'imp-test-1');
        ok(await I.getBatch('u-alice', 'imp-test-1') === null, 'batch deleted');
    }

    // -----------------------------------------------------------------------
    // §10 · HTTP end-to-end (real server, anonymous mode)
    // -----------------------------------------------------------------------
    console.log('\n§10 HTTP end-to-end');
    const root = path.join(__dirname, '..');
    const PORT = 8100 + Math.floor(Math.random() * 300);
    const API = 'http://127.0.0.1:' + PORT;
    const LOCAL_DB = path.join(root, 'data', 'db-00000000-0000-0000-0000-000000000000.json');
    const backup = fs.existsSync(LOCAL_DB) ? fs.readFileSync(LOCAL_DB, 'utf8') : null;

    let serverProc = null;
    let serverLog = '';
    const startServer = () => new Promise((resolve, reject) => {
        serverProc = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { ...process.env, TRADEMIND_PORT: String(PORT), TRADEMIND_AUTH: 'off', TRADEMIND_IMPORT_DATA_DIR: path.join(TMP, 'e2e') },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        serverProc.stdout.on('data', d => { serverLog += d; });
        serverProc.stderr.on('data', d => { serverLog += d; });
        const t0 = Date.now();
        const poll = async () => {
            try {
                const r = await fetch(API + '/api/health');
                if (r.ok) return resolve();
            } catch (e) { /* not up yet */ }
            if (Date.now() - t0 > 25000) return reject(new Error('server boot timeout: ' + serverLog.slice(-500)));
            setTimeout(poll, 400);
        };
        poll();
    });
    const stopServer = () => new Promise(resolve => {
        if (!serverProc) return resolve();
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        serverProc.on('exit', finish);
        serverProc.kill('SIGTERM');
        setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch (e) {} finish(); }, 6000);
    });
    const restoreLedger = () => {
        try {
            if (backup !== null) fs.writeFileSync(LOCAL_DB, backup);
            else if (fs.existsSync(LOCAL_DB)) fs.unlinkSync(LOCAL_DB);
        } catch (e) { console.log('  note: ledger restore failed: ' + e.message); }
    };

    await startServer();
    try {
        const j = async (method, p, body) => {
            const r = await fetch(API + p, {
                method,
                headers: body ? { 'Content-Type': 'application/json' } : {},
                body: body ? JSON.stringify(body) : undefined
            });
            let data = null;
            try { data = await r.json(); } catch (e) { /* empty */ }
            return { status: r.status, data };
        };

        const acc = await j('POST', '/api/accounts', {
            name: 'Import Test', type: 'Personal', start: 10000, dailyLoss: 100, maxDD: 500, risk: 25
        });
        ok(acc.status === 201 && acc.data.id, 'account created for import');
        const accountId = acc.data.id;

        const csv = 'Date,Symbol,Side,Entry,Exit,P&L,Size,Strategy,Notes\n' +
            '2026-01-05,EURUSD,Buy,1.1000,1.1100,100,1,London FVG,first\n' +
            '2026-01-06,GBPUSD,SELL,1.2500,1.2400,-50,2,,second\n' +
            'bad-date,XAUUSD,Buy,2300,2310,85,1,,bad date row\n';
        const upload = await j('POST', '/api/imports/upload', {
            accountId, filename: 'history.csv', contentType: 'text/csv', text: csv
        });
        ok(upload.status === 201 && upload.data.batchId, 'upload returns a batch');
        ok(upload.data.batch.rowCount === 3 && upload.data.batch.validCount === 2 && upload.data.batch.errorCount === 1, 'preview counts valid/error rows');
        const batchId = upload.data.batchId;

        const preview = await j('GET', '/api/imports/' + batchId + '/preview');
        ok(preview.status === 200 && preview.data.rows.length === 3, 'preview lists rows');
        const errs = await j('GET', '/api/imports/' + batchId + '/errors');
        ok(errs.data.total === 1 && errs.data.errors[0].rowNumber === 4, 'errors endpoint reports invalid row 4');

        const commit = await j('POST', '/api/imports/' + batchId + '/commit', {});
        ok(commit.status === 200 && commit.data.importedCount === 2 && commit.data.status === 'COMPLETED', 'commit imports valid rows only');
        const trades = await j('GET', '/api/trades?accountId=' + accountId);
        ok(trades.data.trades.length === 2, 'exactly 2 canonical trades in the ledger');
        ok(trades.data.trades.every(t => t.source === 'IMPORT' && t.import_batch_id === batchId), 'trades carry source=IMPORT + import_batch_id');
        const withNote = trades.data.trades.find(t => t.note === 'first');
        ok(!!withNote, 'trade notes preserved from the source');

        const again = await j('POST', '/api/imports/' + batchId + '/commit', {});
        ok(again.status === 200 && again.data.idempotent === true && again.data.importedCount === 2, 'double commit is idempotent (no duplicates)');
        const after = await j('GET', '/api/trades?accountId=' + accountId);
        ok(after.data.trades.length === 2, 'still exactly 2 trades after double commit');

        const reup = await j('POST', '/api/imports/upload', {
            accountId, filename: 'history.csv', contentType: 'text/csv', text: csv
        });
        ok(reup.data.batch.duplicateCount === 2, 're-upload preview flags both rows as duplicates');
        const recommit = await j('POST', '/api/imports/' + reup.data.batchId + '/commit', {});
        ok(recommit.data.importedCount === 0 && recommit.data.status === 'COMPLETED', 're-upload commit imports 0 new trades');
        const after2 = await j('GET', '/api/trades?accountId=' + accountId);
        ok(after2.data.trades.length === 2, 'ledger unchanged after re-upload');

        const cancelUp = await j('POST', '/api/imports/upload', { accountId, filename: 'x.csv', text: 'Date,Symbol,Side\n2026-02-01,EURUSD,Buy\n' });
        const cancel = await j('POST', '/api/imports/' + cancelUp.data.batchId + '/cancel', {});
        ok(cancel.status === 200 && cancel.data.status === 'CANCELLED', 'uncommitted batch cancelled');
        const cancelCommit = await j('POST', '/api/imports/' + cancelUp.data.batchId + '/commit', {});
        ok(cancelCommit.status === 409, 'cancelled batch cannot be committed');

        const unknown = await j('GET', '/api/imports/imp-nope');
        ok(unknown.status === 404, 'unknown batch → 404');

        const rb = await j('POST', '/api/imports/' + batchId + '/rollback', {});
        ok(rb.status === 200 && rb.data.removed === 2, 'rollback removes the 2 imported trades');
        const afterRb = await j('GET', '/api/trades?accountId=' + accountId);
        ok(afterRb.data.trades.length === 0, 'ledger empty after rollback');

        // rolled-back batches must NOT block re-importing the same file
        const rup = await j('POST', '/api/imports/upload', { accountId, filename: 'a.csv', text: csv });
        ok(rup.status === 201 && rup.data.batch.validCount === 2 && rup.data.batch.duplicateCount === 0, 're-upload after rollback is valid, not flagged duplicate');
        const rupCommit = await j('POST', '/api/imports/' + rup.data.batchId + '/commit', {});
        ok(rupCommit.status === 200 && rupCommit.data.importedCount === 2, 're-import after rollback succeeds');
        const afterRup = await j('GET', '/api/trades?accountId=' + accountId);
        ok(afterRup.data.trades.length === 2, 'ledger has the re-imported trades');

        const acc2 = await j('POST', '/api/accounts', { name: 'Analytics Test', type: 'Personal', start: 10000, dailyLoss: 100, maxDD: 500, risk: 25 });
        const csv2 = 'Date,Symbol,Side,P&L\n2026-03-01,EURUSD,Buy,150\n2026-03-02,EURUSD,Buy,-50\n';
        const up2 = await j('POST', '/api/imports/upload', { accountId: acc2.data.id, filename: 'a.csv', text: csv2 });
        await j('POST', '/api/imports/' + up2.data.batchId + '/commit', {});
        const an = await j('GET', '/api/analytics?accountId=' + acc2.data.id);
        ok(an.data.n === 2 && an.data.net === 100, 'imported trades flow into the existing analytics engine');

        const audit = await j('GET', '/api/audit');
        ok(audit.data.events.some(e => e.entity.indexOf('Import') === 0), 'import events recorded in the canonical audit log');
    } finally {
        await stopServer();
        restoreLedger();
    }

    console.log('\n' + (fail === 0 ? 'ALL IMPORT CHECKS PASS' : fail + ' IMPORT CHECKS FAILED') + ' (' + pass + ' ok)\n');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('IMPORT TEST CRASH:', err.stack || err);
    process.exit(1);
});
