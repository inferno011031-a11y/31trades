/* ============================================================================
   31TRADES — Backend server
   ----------------------------------------------------------------------------
   Zero-dependency Node HTTP server that:

     · Serves the static app (same pages, same port as the demo server)
     · Exposes a REST API over the canonical data model (core.js):
         GET  /api/health                      — liveness probe
         GET  /api/state                       — full canonical dump
         POST /api/reset                       — reseed to deterministic defaults
         POST /api/trades                      — the 7-step logTradePipeline
         POST /api/accounts                    — create account
         POST /api/accounts/:id                — update account identity
         POST /api/accounts/:id/limits         — new immutable policy version
         POST /api/accounts/:id/status         — activate / archive
         POST /api/accounts/:id/duplicate      — duplicate account
         POST /api/strategies                  — create strategy
         POST /api/strategies/:id              — update (immutable version bump)
         POST /api/strategies/:id/duplicate    — duplicate strategy
         POST /api/rule-sets/toggle            — toggle a rule (new RuleSet version)
         POST /api/events                      — audit-log entries (manual / tag)

   The SAME shared core package that runs in the browser (src/core/index.js)
   runs here, so the canonical model, the event bus and the 7-step pipeline are
   identical on both sides. State persists to data/db.json with atomic writes;
   a PRISTINE snapshot taken at boot powers /api/reset.

   Run:  npm start   (or  node server.js)   →  http://127.0.0.1:8080
   (Railway: binds 0.0.0.0 on process.env.PORT, default 8080)
   ========================================================================== */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('./server/env.js');
const db = require('./server/db.js');
const auth = require('./server/auth.js');
const Access = require('./server/access.js');
const Admin = require('./server/admin.js');
const AI = require('./server/ai-mentor.js');
const Bot = require('./server/ai-bot.js');
const EcoCal = require('./server/ecocal.js');
const LLM = require('./server/llm.js');
const Notif = require('./server/notifications.js');
const Brokers = require('./server/brokers.js');
const Backtest = require('./server/backtest.js');
const MarketData = require('./server/marketdata.js');
const Replay = require('./server/replay.js');
const Sim = require('./server/backtest-sim.js');
const Practice = require('./server/practice.js');
const Battle = require('./server/battle.js');
const AICoach = require('./server/ai-coach.js');
const BattleWs = require('./server/battle-ws.js');
const Prefs = require('./server/prefs.js');
const Imports = require('./server/imports.js');
const SEO = require('./server/seo.js');
const { PostgresRepository: PostgresRepo, LOCAL_USER_ID } = require('./server/pg-repo.js');

loadEnv();   // reads .env into process.env (real env vars win)

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
// Port priority: process.env.PORT first (Railway injects the real container
// port there — it ALWAYS wins when set) → TRADEMIND_PORT (local dev / tests
// only, never set on Railway) → 8080 default. Falsy values are skipped
// naturally — some sandboxes inject PORT=0, which must not win.
const PORT = Number(process.env.PORT) || Number(process.env.TRADEMIND_PORT) || 8080;

// Auth gate: ON by default. Set TRADEMIND_AUTH=off for dev/testing — the
// server then runs in anonymous mode (single LOCAL_USER partition) so the
// pre-auth flows and sync e2e keep working without signing in.
const AUTH_REQUIRED = process.env.TRADEMIND_AUTH !== 'off';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};

/* ---------------------------------------------------------------------------
   0.5 COMPRESSION + CACHE HELPERS
   ---------------------------------------------------------------------------
   Static text assets get brotli (or gzip fallback) with an in-memory cache
   keyed by path + mtime + encoding, plus ETag/Last-Modified revalidation so
   repeat visits serve 304s instead of re-downloading. JSON API payloads get
   fast gzip when the client accepts it. Only text-like types compress — binary
   (png/jpg/woff2) is already compressed.
   --------------------------------------------------------------------------- */
const zlib = require('zlib');

const COMPRESSIBLE = { '.html': 1, '.js': 1, '.css': 1, '.json': 1, '.svg': 1, '.txt': 1, '.map': 1, '.md': 1 };
const compCache = new Map();          // `${path}|${mtimeMs}|br|${len}` -> Buffer
const COMP_CACHE_MAX = 60;            // bounded memory (a few MB)

function pickEncoding(req) {
    const ae = String(req.headers['accept-encoding'] || '');
    if (ae.includes('br')) return 'br';
    if (ae.includes('gzip')) return 'gzip';
    return null;
}

function compressSync(buf, enc) {
    return enc === 'br'
        ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
        : zlib.gzipSync(buf, { level: 6 });
}

function compressedVariant(file, data, enc) {
    let st;
    try { st = fs.statSync(file); } catch (e) { st = { mtimeMs: 0 }; }
    const key = `${file}|${st.mtimeMs}|${enc}|${data.length}`;
    let out = compCache.get(key);
    if (!out) {
        out = compressSync(data, enc);
        compCache.set(key, out);
        if (compCache.size > COMP_CACHE_MAX) {
            const first = compCache.keys().next().value;
            compCache.delete(first);
        }
    }
    return { buf: out, etag: `"${st.mtimeMs.toString(16)}-${data.length.toString(16)}"` };
}

function gzipJson(res, body, enc) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    if (enc && raw.length > 1024) {
        const out = compressSync(raw, 'gzip');   // fast path for dynamic JSON
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Vary': 'Accept-Encoding',
            'Cache-Control': 'no-store'
        });
        return res.end(out);
    }
    res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    return res.end(raw);
}

/* ---------------------------------------------------------------------------
   1. PER-USER CORE INSTANCES
   ---------------------------------------------------------------------------
   src/core/index.js is a UMD factory with ZERO DOM/localStorage dependencies;
   the server injects only the deterministic demo generator. Each signed-in
   user gets their OWN core instance, hydrated from their slice of Postgres
   (user_id = …) — so Risk/Discipline/Analytics/Journal all read the same
   per-user ledger, and no user can see another user's data.

   Anonymous mode (TRADEMIND_AUTH=off) uses the LOCAL_USER partition so the
   pre-auth flows and the sync e2e keep working without signing in.            */
global.window = { SERVER_MODE: true };
require('./demo-trades.js');          // sets global.window.DemoTrades (deterministic generator)
const createCore = require('./src/core/index.js');

let DB_MODE = false;                  // true once a user state round-trips Postgres
const cores = new Map();              // userId → user core wrapper
const importInFlight = new Set();     // "userId:batchId" — concurrency lock for commits

function serializeCore(core) {
    const cp = o => JSON.parse(JSON.stringify(o));
    return {
        Accounts: cp(core.Accounts),
        ConfigVersions: cp(core.ConfigVersions),
        StrategyAssignments: cp(core.StrategyAssignments),
        Trades: cp(core.Trades),
        StrategyMaster: cp(core.StrategyMaster),
        RuleSetMaster: cp(core.RuleSetMaster),
        TradeEvaluations: cp(core.TradeEvaluations),
        Violations: cp(core.Violations),
        EVENT_LOG: cp(core.getEventLog())
    };
}

function makeUserCore(user) {
    const core = createCore({ demoTrades: global.window.DemoTrades });
    const uid = (user && user.id) || LOCAL_USER_ID;
    const file = () => path.join(DATA_DIR, 'db-' + uid + '.json');

    // Postgres is primary; a per-user JSON file mirrors every write so a
    // transient DB outage never loses data (and file mode needs no DB at all).
    //
    // persist() is async and ALWAYS resolves (never returns null, never throws
    // synchronously). Earlier versions returned null from the file mirror when
    // Postgres was unavailable — scheduleSave's persist().catch(...) then hit
    // null.catch and the uncaught TypeError killed the whole process (the
    // Railway 502: a DB-mode fallback + any mutation = crash).
    const persist = async () => {
        let counts = null;
        if (DB_MODE) {
            try {
                counts = await PostgresRepo.save(serializeCore(core), user);
                console.log('[31trades] saved ' + core.Trades.length + ' trades → Supabase Postgres');
                return counts;
            } catch (err) {
                console.error('[31trades] postgres save failed: ' + err.message + ' — mirroring to ' + file());
            }
        }
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            const tmp = file() + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(serializeCore(core), null, 2));
            fs.renameSync(tmp, file());
            if (counts === null) console.log('[31trades] saved ' + core.Trades.length + ' trades → ' + file());
        } catch (err) {
            console.error('[31trades] save failed: ' + err.message);
        }
        return counts;
    };

    let saveTimer = null;
    const scheduleSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            persist().catch(err => console.error('[31trades] save failed: ' + err.message));
        }, 120);
    };
    const flush = () => {
        clearTimeout(saveTimer);
        return Promise.resolve().then(persist);   // never throw synchronously (shutdown safety)
    };

    const uc = { userId: uid, user, core, serialize: () => serializeCore(core), scheduleSave, flush, pristine: null };
    cores.set(uid, uc);
    return uc;
}

// Load a user's state: Postgres slice first, per-user JSON file as fallback.
async function loadUserState(uc) {
    if (db.status().configured) {
        try {
            const state = await PostgresRepo.load(uc.userId);
            uc.core.hydrate(state);
            DB_MODE = true;
            console.log('[31trades] loaded ' + uc.core.Trades.length + ' trades, ' + uc.core.Accounts.length + ' accounts from Supabase Postgres');
            return;
        } catch (err) {
            console.warn('[31trades] Postgres unavailable (' + err.message + '). Falling back to local files — if the tables are missing, run: npm run db:migrate');
        }
    }
    const f = path.join(DATA_DIR, 'db-' + uc.userId + '.json');
    if (fs.existsSync(f)) {
        try {
            uc.core.hydrate(JSON.parse(fs.readFileSync(f, 'utf8')));
            return;
        } catch (err) {
            console.warn(f + ' unreadable — reseeding (' + err.message + ')');
        }
    }
    if (uc.userId === LOCAL_USER_ID) {
        uc.core.seedDemoAccount(117);   // anonymous dev mode — sample data for API testing
        console.log('[31trades] seeded ' + uc.core.Trades.length + ' demo trades (anonymous mode)');
    } else {
        uc.core.reseed();               // real first-time user — clean first-user state
        logWelcomeEvent(uc, uc.user);   // one-time welcome in their canonical event log
    }
}

async function getUserCore(user) {
    const uid = (user && user.id) || LOCAL_USER_ID;
    let uc = cores.get(uid);
    if (uc) return uc;
    uc = makeUserCore(user);
    await loadUserState(uc);
    uc.core.backfillEvaluations();   // evaluation + violation audit for the whole ledger
    uc.pristine = uc.serialize();
    return uc;
}

// Record the one-time welcome message in the user's canonical event log (it
// flows into System notifications + audit history). Idempotent: if a welcome
// already exists for this user, nothing is logged a second time.
function logWelcomeEvent(uc, user) {
    const Core = uc.core;
    const log = (Core.getEventLog ? Core.getEventLog() : []);
    if (log.some(e => e.entity === '31Trades' && e.what === 'Welcome')) return;
    const name = (user && (user.name || user.email || '')) || '';
    const firstName = String(name).split(/[\s@]/)[0] || 'trader';
    Core.ConfigAPI.logTagEvent(
        '31Trades',
        'Welcome',
        'Welcome to 31Trades, ' + firstName + '! Your journal, risk engine and AI mentor are ready — log your first trade to get started.',
        'Account created'
    );
    uc.scheduleSave();
}

// Record a broker connect/disconnect in the user's canonical event log so it
// shows up in audit history (Strategy Lab → History, /api/audit) and in the
// System notification feed — the same channel as every other config change.
// No secrets: only the registry fields (broker name + state) ever reach the log.
function logBrokerEvent(Core, broker, what) {
    const name = typeof broker === 'string' ? broker : String(broker || 'Broker');
    Core.ConfigAPI.logTagEvent(
        'Broker · ' + name,
        what,
        what + ' · ' + name,
        'Broker state shown in Settings & onboarding checklist'
    );
}

// Record an import lifecycle event in the user's canonical event log (flows
// into audit history + System notifications). Counts only — never trade
// contents or sensitive file data.
function logImportEvent(Core, batch, what, detail) {
    Core.ConfigAPI.logTagEvent(
        'Import · ' + (batch.filename || 'journal'),
        what,
        detail || (what + ' · ' + batch.rowCount + ' rows · ' + batch.importedCount + ' imported'),
        'Canonical ledger updated from a journal import'
    );
}

// Compact preview shape for /api/imports responses (rows are trimmed to a
// representative slice; full rows live only inside the stored batch).
function importPreviewOf(batch) {
    const rows = (batch.rows || []).slice(0, 300).map(r => ({
        rowNumber: r.rowNumber, state: r.state, errors: r.errors, warnings: r.warnings,
        dupReason: r.dupReason, values: r.values
    }));
    return {
        batch: {
            id: batch.id, status: batch.status, filename: batch.filename,
            sourceType: batch.sourceType, createdAt: batch.createdAt,
            accountId: batch.accountId, fileSize: batch.fileSize,
            rowCount: batch.rowCount, validCount: batch.validCount,
            warningCount: batch.warningCount, errorCount: batch.errorCount,
            duplicateCount: batch.duplicateCount, possibleDuplicateCount: batch.possibleDuplicateCount,
            importedCount: batch.importedCount, skippedCount: batch.skippedCount,
            errorCode: batch.errorCode || null
        },
        mapping: batch.mapping || [],
        unmappedColumns: batch.unmappedColumns || [],
        unsupportedColumns: batch.unsupportedColumns || [],
        rows
    };
}

// POST /api/imports/upload — validate → parse → detect columns → normalize +
// validate every row → save the batch in READY state → return the preview.
// Nothing is imported until the user confirms via /commit.
async function handleImportUpload(req, res, uc, Core) {
    const rl = Imports.rateLimit(uc.userId, 'import-upload', 10, 60000);
    if (!rl.allowed) return json(res, 429, { error: { code: 'IMPORT_RATE_LIMITED', message: 'Too many uploads — try again shortly.' } });

    let raw;
    try { raw = await readBodyRaw(req, Imports.MAX_UPLOAD_BODY); }
    catch (e) { return json(res, 413, { error: { code: 'IMPORT_TOO_LARGE', message: e.message } }); }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch (e) { return json(res, 400, { error: { code: 'IMPORT_BAD_PAYLOAD', message: 'invalid JSON body' } }); }

    const accountId = String(body.accountId || '');
    if (!accountId) {
        return json(res, 400, { error: { code: 'IMPORT_ACCOUNT_REQUIRED', message: 'Choose a Battlex account to import into.' } });
    }
    if (!Core.Accounts.some(a => a.id === accountId)) {
        return json(res, 404, { error: { code: 'IMPORT_UNKNOWN_ACCOUNT', message: 'Unknown account — create it in Strategy Lab first.' } });
    }

    // data: base64 (binary-safe .xlsx) or plain text (CSV / pasted data)
    let buffer;
    if (typeof body.data === 'string' && body.data) {
        try { buffer = Buffer.from(body.data, 'base64'); }
        catch (e) { return json(res, 400, { error: { code: 'IMPORT_BAD_ENCODING', message: 'Invalid base64 payload.' } }); }
    } else if (typeof body.text === 'string' && body.text) {
        buffer = Buffer.from(body.text, 'utf8');
    } else {
        return json(res, 400, { error: { code: 'IMPORT_NO_DATA', message: 'No file data received.' } });
    }

    const v = Imports.validateUpload({ filename: body.filename, contentType: body.contentType, data: buffer });
    if (!v.ok) return json(res, 400, { error: { code: 'IMPORT_REJECTED', message: v.error } });

    const wantSource = String(body.sourceType || '').toUpperCase();
    const sourceType = Imports.SOURCE_TYPES.includes(wantSource) ? wantSource : (v.ext === '.xlsx' ? 'XLSX' : 'CSV');

    let parsed;
    try {
        if (v.ext === '.xlsx') {
            parsed = Imports.parseXlsx(v.buffer);
        } else {
            const text = v.encoding === 'utf16le' ? v.buffer.toString('utf16le') : v.buffer.toString('utf8');
            parsed = Imports.parseCsv(text);
        }
    } catch (err) {
        return json(res, 400, { error: { code: err.importCode || 'IMPORT_PARSE_FAILED', message: err.message } });
    }
    if (!parsed.headers.length) {
        return json(res, 400, { error: { code: 'IMPORT_EMPTY', message: 'No columns detected — the file appears empty.' } });
    }
    if (!parsed.rows.length) {
        return json(res, 400, { error: { code: 'IMPORT_EMPTY', message: 'No data rows detected — add rows below the header row.' } });
    }

    const mapping = Imports.detectColumns(parsed.headers);
    if (!mapping.mapping.length) {
        return json(res, 400, { error: { code: 'IMPORT_NO_COLUMNS', message: 'Could not map any columns — check that the file has a header row with recognizable fields (date, symbol, direction, entry/exit or P&L).' } });
    }

    const batch = {
        id: Imports.genBatchId(),
        userId: uc.userId,
        accountId,
        sourceType,
        filename: String(body.filename || 'import').slice(0, 255),
        contentType: String(body.contentType || '').slice(0, 200),
        fileHash: Imports.fileHash(v.buffer),
        fileSize: v.buffer.length,
        status: 'READY',
        createdAt: new Date().toISOString(),
        completedAt: null,
        rowCount: parsed.rows.length,
        headers: parsed.headers,
        mapping: mapping.mapping,
        unmappedColumns: mapping.unmappedColumns,
        unsupportedColumns: mapping.unsupportedColumns,
        rows: null,
        fingerprints: [],
        validCount: 0, warningCount: 0, errorCount: 0,
        duplicateCount: 0, possibleDuplicateCount: 0,
        importedCount: 0, skippedCount: 0,
        errorCode: null
    };

    const ctx = {
        accountId, batchId: batch.id, filename: batch.filename,
        existingTrades: Core.Trades,
        strategies: Core.StrategyMaster,
        batchFps: []
    };
    // re-upload detection: fingerprints from batches whose trades actually
    // entered the ledger (COMPLETED/PARTIAL). Rolled-back or cancelled batches
    // keep their record but must NOT block re-importing the same file.
    try {
        const prev = await Imports.listBatches(uc.userId);
        prev.filter(b => b.accountId === accountId
            && (b.status === 'COMPLETED' || b.status === 'PARTIAL')
            && Array.isArray(b.fingerprints))
            .forEach(b => ctx.batchFps.push(...b.fingerprints));
    } catch (e) { /* non-fatal */ }

    const rows = Imports.buildRows(parsed.headers, parsed.rows, mapping.mapping, ctx);
    const stats = Imports.summarize(rows);
    batch.rows = rows;
    batch.rowCount = stats.total;
    batch.validCount = stats.valid;
    batch.warningCount = stats.warning;
    batch.errorCount = stats.error;
    batch.duplicateCount = stats.duplicate;
    batch.possibleDuplicateCount = stats.possibleDuplicate;

    await Imports.saveBatch(uc.userId, batch);
    return json(res, 201, { ok: true, batchId: batch.id, ...importPreviewOf(batch) });
}

function bearerToken(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ---- lightweight email→userId directory (for battle invites) ----------------
// Populated at signup/login when we know the user's email. Lets the host invite
// an email and have the in-app invitation land in that user's feed. Falls back
// gracefully when the directory is empty (auth off / local mode).
const USER_DIR_FILE = () => path.join(DATA_DIR, 'user-directory.json');
function readUserDirectory() {
    try { if (fs.existsSync(USER_DIR_FILE())) return JSON.parse(fs.readFileSync(USER_DIR_FILE(), 'utf8')); } catch (e) { /* ignore */ }
    return {};
}
function writeUserDirectory(map) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(USER_DIR_FILE(), JSON.stringify(map)); } catch (e) { /* ignore */ }
}
function recordUserEmail(user) {
    if (!user || !user.email || !user.id) return;
    const map = readUserDirectory();
    map[String(user.email).toLowerCase()] = user.id;
    writeUserDirectory(map);
}
function userIdByEmail(email) {
    if (!email) return null;
    return readUserDirectory()[String(email).toLowerCase()] || null;
}
function mailtoInvite(emails, link, title, fromName) {
    const to = (emails || []).slice(0, 20).join(',');
    const subject = encodeURIComponent('You are invited to a trading battle: ' + title);
    const body = encodeURIComponent(
        'Hey! You have been invited to join a 31TRADES Online Battle.\n\n' +
        'Battle: ' + title + '\n\n' +
        'Join here: ' + link + '\n\n' +
        'Everyone trades the same market replay — decisions stay private until the end.\n\n— ' + (fromName || '31TRADES')
    );
    return 'mailto:' + to + '?subject=' + subject + '&body=' + body;
}

// Resolve the caller's user core. Throws {code:401} when unauthenticated.
async function coreFor(req) {
    if (!AUTH_REQUIRED) return getUserCore(null);   // anonymous dev mode
    const token = bearerToken(req);
    if (!token) throw Object.assign(new Error('Authentication required — sign in at /auth.html'), { code: 401 });
    const user = await auth.verify(token);          // throws {code:401} on invalid
    return getUserCore(user);
}

// Mask a connection string so secrets never reach the logs — show the
// scheme + user + host, hide the password.
function maskSecret(v) {
    if (!v) return '(empty)';
    const m = String(v).match(/^(postgres(?:ql)?:\/\/)([^:@/]+):([^@/]+)@(.+)$/i);
    if (m) return m[1] + m[2] + ':***@' + m[4];
    return String(v).slice(0, 12) + '…';
}

async function boot() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // ---- Supabase environment diagnostic (read live at startup, so Railway
    // runtime logs show instantly whether the config reached the process). ----
    const su = process.env.SUPABASE_URL || '';
    const ak = process.env.SUPABASE_ANON_KEY || '';
    const dbu = process.env.SUPABASE_DB_URL || '';
    console.log('[31trades] ── environment ──');
    console.log('[31trades]   SUPABASE_URL      ' + (su ? '✓ detected  (' + su.replace(/^https?:\/\//, '') + ')' : '✗ MISSING'));
    console.log('[31trades]   SUPABASE_ANON_KEY ' + (ak ? '✓ detected  (' + ak.slice(0, 10) + '…)' : '✗ MISSING'));
    console.log('[31trades]   SUPABASE_DB_URL   ' + (dbu ? '✓ detected  (' + maskSecret(dbu) + ')' : '✗ MISSING'));
    console.log('[31trades]   PORT              ' + (process.env.PORT ? '✓ ' + process.env.PORT + ' (from env)' : '✗ not set → default 8080'));

    // ---- boot-time DB probe: a live ping right here so an unreachable /
    // misconfigured database fails loudly in the runtime logs instead of the
    // app silently falling back to data/db.json. ----
    if (dbu) {
        try {
            const p = await db.ping();
            console.log('[31trades]   database ping      ' + (p.ok
                ? '✓ connected (' + p.latencyMs + 'ms)'
                : '✗ FAILED — ' + p.error));
            if (!p.ok) console.log('[31trades]   → falling back to data/db.json until the database is reachable');
        } catch (err) {
            console.log('[31trades]   database ping      ✗ FAILED — ' + err.message);
            console.log('[31trades]   → falling back to data/db.json until the database is reachable');
        }
    } else {
        console.log('[31trades]   database ping      skipped (SUPABASE_DB_URL missing → data/db.json mode)');
    }

    // Cores load lazily per user; nothing global to hydrate at boot. The
    // Postgres health status is reported on demand by /api/health.
    if (AUTH_REQUIRED) console.log('[31trades] auth: Supabase GoTrue (TRADEMIND_AUTH=off disables it)');
}

/* ---------------------------------------------------------------------------
   3. HTTP HELPERS
   --------------------------------------------------------------------------- */
function json(res, code, body) {
    const req = res._req;   // attached at the API entry point (per-request, race-free)
    if (code === 200 && req && req.headers['accept-encoding']) {
        return gzipJson(res, body, pickEncoding(req));
    }
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 2 * 1024 * 1024) {   // 2 MB cap
                req.destroy();
                reject(new Error('request body too large'));
            }
        });
        req.on('end', () => {
            if (!data) return resolve({});
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

// Binary-safe body reader with a larger cap — used ONLY by the import upload
// route (base64-encoded .xlsx can exceed the 2 MB JSON cap).
function readBodyRaw(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', chunk => {
            total += chunk.length;
            if (total > maxBytes) {
                req.destroy();
                reject(new Error('request body too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/* ---------------------------------------------------------------------------
   4. REST API — thin, stateless wrappers over the canonical ConfigAPI.
      Every mutation persists via save(). Errors are returned as JSON 400s.
   --------------------------------------------------------------------------- */
async function handleApi(req, res, url) {
    res._req = req;   // lets json() gzip large 200 responses without touching 200+ call sites
    const p = url.pathname;
    const q = url.searchParams;

    // ---------- auth + health (no session required) ----------
    if (p === '/api/auth/signup' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) {
            const mockUser = { id: LOCAL_USER_ID, email: b.email || 'trader@battlexjournal.dev', name: b.name || 'Trader' };
            return json(res, 201, { ok: true, session: { access_token: 'local_dev_token', user: mockUser } });
        }
        // Rate limit: per-IP + per-email
        const ipRL = authIPRateLimit(req);
        if (!ipRL.allowed) { res.setHeader('Retry-After', String(ipRL.retryAfter)); return json(res, 429, { error: ipRL.error }); }
        const rlKey = 'signup:' + String(b.email || '').toLowerCase();
        const rl = authRateLimit(rlKey, MAX_SIGNUP_ATTEMPTS);
        if (!rl.allowed) { res.setHeader('Retry-After', String(rl.retryAfter)); return json(res, 429, { error: rl.error }); }
        try {
            const r = await auth.signup({ email: b.email, password: b.password, name: b.name });
            authRLRecord(rlKey, true);
            authRLRecord(ipRLKey(req), true);
            const signupUser = r.user || (r.session && r.session.user);
            if (signupUser) recordUserEmail(signupUser);
            if (r.needsConfirmation) return json(res, 201, { ok: true, needsConfirmation: true, user: r.user });
            if (!r.session) throw Object.assign(new Error('Signup did not return a session'), { code: 500 });
            return json(res, 201, { ok: true, session: r.session });
        } catch (err) { return json(res, err.code || 400, { error: err.message }); }
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) {
            const mockUser = { id: LOCAL_USER_ID, email: b.email || 'trader@battlexjournal.dev', name: 'Trader' };
            return json(res, 200, { ok: true, session: { access_token: 'local_dev_token', user: mockUser } });
        }
        try {
            const r = await auth.login({ email: b.email, password: b.password });
            if (r.session && r.session.user) recordUserEmail(r.session.user);
            return json(res, 200, { ok: true, session: r.session });
        } catch (err) {
            return json(res, err.code || 400, { error: err.message });
        }
    }
    if (p === '/api/auth/oauth/start' && req.method === 'GET') {
        const provider = q.get('provider') || 'google';
        const redirectTo = q.get('redirectTo') || q.get('redirect_to');
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) {
            return json(res, 200, { url: '/auth.html#access_token=local_dev_token&type=oauth' });
        }
        try {
            const r = auth.oauthStart({ provider, redirectTo });
            return json(res, 200, r);
        } catch (err) {
            return json(res, err.code || 500, { error: err.message });
        }
    }
    if (p === '/api/auth/forgot' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) return json(res, 200, { ok: true });
        try {
            await auth.requestPasswordReset({ email: b.email, redirectTo: b.redirectTo });
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, err.code || 400, { error: err.message });
        }
    }
    if (p === '/api/auth/reset-password' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) return json(res, 200, { ok: true });
        try {
            await auth.resetPassword({ token: b.token, password: b.password });
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, err.code || 400, { error: err.message });
        }
    }
    if (p === '/api/auth/change-password' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) return json(res, 200, { ok: true });
        const token = bearerToken(req);
        if (!token) return json(res, 401, { error: 'Authentication required — sign in at /auth.html' });
        try {
            await auth.changePassword({ token, currentPassword: b.currentPassword, newPassword: b.newPassword });
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, err.code || 400, { error: err.message });
        }
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) return json(res, 200, { ok: true });
        await auth.logout(bearerToken(req));
        return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
        if (!AUTH_REQUIRED || !process.env.SUPABASE_URL) {
            return json(res, 200, { user: { id: LOCAL_USER_ID, email: 'trader@battlexjournal.dev', name: 'Trader' } });
        }
        const token = bearerToken(req);
        if (!token) return json(res, 401, { error: 'Authentication required' });
        try { return json(res, 200, { user: await auth.verify(token) }); }
        catch (err) { return json(res, 401, { error: err.message }); }
    }
    // ---------- 60-Member 1-Year Invite Access System ----------
    if (p === '/api/access/status' && req.method === 'GET') {
        let userId = LOCAL_USER_ID;
        if (AUTH_REQUIRED && process.env.SUPABASE_URL) {
            const token = bearerToken(req);
            if (!token) return json(res, 401, { error: 'Authentication required' });
            try {
                const user = await auth.verify(token);
                userId = user.id;
            } catch (err) {
                return json(res, err.code || 401, { error: err.message });
            }
        }
        try {
            const status = await Access.getAccessStatus(userId);
            return json(res, 200, Object.assign({ ok: true }, status));
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    if (p === '/api/access/redeem' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        const token = bearerToken(req);
        let userId = LOCAL_USER_ID;
        if (AUTH_REQUIRED && process.env.SUPABASE_URL) {
            if (!token) return json(res, 401, { error: 'Authentication required — sign in first.' });
            try {
                const user = await auth.verify(token);
                userId = user.id;
            } catch (err) {
                return json(res, 401, { error: err.message });
            }
        }
        try {
            const result = await Access.redeemInviteCode({ userId, code: b.code });
            return json(res, 200, result);
        } catch (err) {
            return json(res, err.code || 400, { ok: false, error: err.message });
        }
    }

    if (p === '/api/admin/invite-stats' && req.method === 'GET') {
        try {
            const stats = await Access.getInviteStats();
            return json(res, 200, Object.assign({ ok: true }, stats));
        } catch (err) {
            return json(res, 500, { error: err.message });
        }
    }

    // ============ BATTLEX ADMIN DASHBOARD & 2FA APIS ============
    if (p === '/api/admin/auth/login' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        try {
            const resData = Admin.adminLogin(b);
            return json(res, 200, resData);
        } catch (err) {
            return json(res, err.code || 401, { ok: false, error: err.message });
        }
    }

    if (p === '/api/admin/auth/verify-2fa' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        try {
            const resData = Admin.adminVerify2FA(b);
            return json(res, 200, resData);
        } catch (err) {
            return json(res, err.code || 401, { ok: false, error: err.message });
        }
    }

    if (p === '/api/admin/auth/logout' && req.method === 'POST') {
        const token = bearerToken(req);
        Admin.adminLogout(token);
        return json(res, 200, { ok: true });
    }

    // Protected Admin Endpoints Gate
    if (p.startsWith('/api/admin/')) {
        const token = bearerToken(req) || req.headers['x-admin-token'];
        const adminSession = Admin.verifyAdminSession(token);
        if (!adminSession) {
            return json(res, 401, { ok: false, error: 'Unauthorized. Admin 2FA authentication required.' });
        }

        if (p === '/api/admin/metrics' && req.method === 'GET') {
            try {
                const range = q.range || '30d';
                const metrics = await Admin.getDashboardMetrics(range);
                return json(res, 200, Object.assign({ ok: true }, metrics));
            } catch (err) {
                return json(res, 500, { error: err.message });
            }
        }

        if (p === '/api/admin/users' && req.method === 'GET') {
            try {
                const page = q.page || 1;
                const limit = q.limit || 25;
                const search = q.search || '';
                const filter = q.filter || 'all';
                const list = await Admin.getUsersList({ page, limit, search, filter });
                return json(res, 200, Object.assign({ ok: true }, list));
            } catch (err) {
                return json(res, 500, { error: err.message });
            }
        }

        if (p.startsWith('/api/admin/user/') && req.method === 'GET') {
            try {
                const uid = p.replace('/api/admin/user/', '').trim();
                const details = await Admin.getUserDetails(uid);
                return json(res, 200, Object.assign({ ok: true }, details));
            } catch (err) {
                return json(res, err.code || 500, { error: err.message });
            }
        }

        if (p === '/api/admin/activity' && req.method === 'GET') {
            try {
                const page = q.page || 1;
                const limit = q.limit || 30;
                const feed = await Admin.getActivityFeed({ page, limit });
                return json(res, 200, Object.assign({ ok: true }, feed));
            } catch (err) {
                return json(res, 500, { error: err.message });
            }
        }
    }

    if (p === '/api/health') {
        return json(res, 200, {
            ok: true, service: '31trades-backend', time: new Date().toISOString(),
            storage: DB_MODE ? 'supabase-postgres' : 'db.json',
            auth: AUTH_REQUIRED ? 'supabase-gotrue' : 'off',
            db: db.status()
        });
    }
    if (p === '/api/health/db') {
        return json(res, 200, { ok: true, db: await db.ping() });
    }

    // ---------- standalone test chatbot (public landing-page widget) ----------
    // Free-form Gemini chat, intentionally NOT grounded in any journal data and
    // NOT tied to any account or user store. Server-side proxy: the API key
    // never leaves the server. Per-IP rate limiting keeps the key from being
    // burned by crawlers/abusers. Session memory is held by the widget in the
    // browser only — nothing is persisted server-side.
    if (p === '/api/chat-test' && req.method === 'POST') {
        const rl = chatRateLimit(req);
        if (!rl.allowed) {
            res.setHeader('Retry-After', String(rl.retryAfter));
            return json(res, 429, { error: rl.error });
        }
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        const message = String(b.message || '').trim();
        if (!message) return json(res, 400, { error: 'message required' });
        if (message.length > 2000) return json(res, 400, { error: 'message too long (max 2000 chars)' });
        // Only accept well-formed history entries; cap at 20 turns.
        const history = (Array.isArray(b.history) ? b.history : [])
            .filter(h => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.length <= 2000)
            .slice(-20);
        if (!process.env.GEMINI_API_KEY) {
            return json(res, 503, { error: 'AI chat is not configured yet — no GEMINI_API_KEY on the server.' });
        }
        const reply = await chatWithGemini(history, message);
        if (!reply) return json(res, 502, { error: 'AI service unreachable — try again in a moment.' });
        return json(res, 200, { ok: true, reply });
    }

    // ---------- everything below requires a user context ----------
    let uc;
    try { uc = await coreFor(req); } catch (err) { return json(res, err.code || 401, { error: err.message }); }
    const Core = uc.core;

    // ---------- read-only endpoints ----------
    if (req.method === 'GET') {
        try {
            if (p === '/api/state') {
                return json(res, 200, Object.assign(uc.serialize(), { serverTime: new Date().toISOString() }));
            }
            if (p === '/api/audit') {
                return json(res, 200, { events: Core.getEventLog() });
            }
            if (p === '/api/trades') {
                let list = Core.Trades.slice();
                if (q.get('accountId')) list = list.filter(t => t.account_id === q.get('accountId'));
                if (q.get('strategyId')) list = list.filter(t => t.strategy_id === q.get('strategyId'));
                if (q.get('symbol')) list = list.filter(t => t.symbol === q.get('symbol'));
                if (q.get('setup')) list = list.filter(t => t.setup === q.get('setup'));
                if (q.get('session')) list = list.filter(t => t.session === q.get('session'));
                if (q.get('direction')) list = list.filter(t => t.dir === q.get('direction'));
                if (q.get('result')) list = list.filter(t => q.get('result') === 'win' ? t.pnl > 0 : q.get('result') === 'loss' ? t.pnl < 0 : t.pnl === 0);
                if (q.get('search')) {
                    const s = q.get('search').toLowerCase();
                    list = list.filter(t => (t.symbol + ' ' + t.setup + ' ' + t.session + ' ' + (t.note || '')).toLowerCase().indexOf(s) !== -1);
                }
                if (q.get('from')) list = list.filter(t => new Date(t.ts) >= new Date(q.get('from')));
                if (q.get('to')) list = list.filter(t => new Date(t.ts) <= new Date(q.get('to')));
                list = list.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
                return json(res, 200, { total: list.length, trades: list });
            }
            let m;
            if ((m = p.match(/^\/api\/trades\/([^/]+)$/))) {
                const t = Core.Trades.find(x => x.id === m[1]);
                if (!t) return json(res, 404, { error: 'unknown trade: ' + m[1] });
                return json(res, 200, {
                    trade: t,
                    evaluations: Core.TradeService.evaluationsFor(t.id),
                    violations: Core.Violations.filter(v => v.tradeId === t.id)
                });
            }
            if (p === '/api/pre-trade-check') {
                const accountId = q.get('accountId');
                if (!accountId) return json(res, 400, { error: 'accountId required' });
                // account ownership — the per-user core only knows this user's
                // accounts, so a foreign id resolves to nothing.
                if (!Core.Accounts.some(a => a.id === accountId)) return json(res, 404, { error: 'unknown account: ' + accountId });
                const draft = { risk: Number(q.get('risk') || 0), session: q.get('session') || undefined, setup: q.get('setup') || undefined, emotion: q.get('emotion') || undefined, strategy_id: q.get('strategyId') || undefined };
                return json(res, 200, Core.preTradeCheck(accountId, draft));
            }
            if (p === '/api/risk') {
                const accountId = q.get('accountId') || (Core.Accounts[0] ? Core.Accounts[0].id : null);
                if (!accountId) return json(res, 200, { snapshot: null, preTrade: null, events: [] });
                if (!Core.Accounts.some(a => a.id === accountId)) return json(res, 404, { error: 'unknown account: ' + accountId });
                return json(res, 200, {
                    snapshot: Core.riskState(accountId),
                    preTrade: Core.preTradeCheck(accountId, { risk: Core.riskState(accountId).recommendedMaxRisk }),
                    events: Core.riskEvents(accountId)
                });
            }
            if (p === '/api/discipline') {
                return json(res, 200, Core.disciplineState(q.get('accountId') || 'acc-prop', { from: q.get('from'), to: q.get('to') }));
            }
            if (p === '/api/discipline/violations') {
                const accountId = q.get('accountId') || 'acc-prop';
                let list = Core.Violations.filter(v => v.account_id === accountId);
                if (q.get('from')) list = list.filter(v => new Date(v.ts) >= new Date(q.get('from')));
                if (q.get('to')) list = list.filter(v => new Date(v.ts) <= new Date(q.get('to')));
                list = list.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts))
                    .map(v => ({ ...v, trade: Core.Trades.find(t => t.id === v.tradeId) || null }));
                return json(res, 200, { total: list.length, violations: list });
            }
            if (p === '/api/analytics') {
                return json(res, 200, Core.analytics(q.get('accountId') || 'acc-prop', {
                    symbol: q.get('symbol'), setup: q.get('setup'), session: q.get('session'),
                    direction: q.get('direction'), result: q.get('result'), emotion: q.get('emotion'),
                    adherence: q.get('adherence'), from: q.get('from'), to: q.get('to')
                }));
            }
            if (p === '/api/insights') {
                return json(res, 200, { findings: Core.insights(q.get('accountId') || 'acc-prop') });
            }
            if (p === '/api/ecocal') {
                const cal = await EcoCal.getCalendar();
                const t = EcoCal.todayBySession(cal);
                if (q.get('session') && t.by[q.get('session')]) {
                    t.filtered = q.get('session');
                    t.events = t.by[q.get('session')].slice();
                }
                if (q.get('impact')) {
                    const want = q.get('impact');
                    t.events = t.events.filter(e => e.impact === want || (want === 'High' ? e.impact === 'High' : e.impact !== 'Low'));
                }
                return json(res, 200, t);
            }
            if (p === '/api/calendar') {
                const year = Number(q.get('year') || new Date().getFullYear());
                const month = Number(q.get('month') === undefined ? new Date().getMonth() : q.get('month'));
                return json(res, 200, Core.calendarMonth(q.get('accountId') || 'acc-prop', year, month));
            }
            if (p === '/api/reviews') {
                return json(res, 200, Core.reviews(q.get('accountId') || 'acc-prop', { period: q.get('period'), date: q.get('date') }));
            }
            // ---------- Notifications (engine module — server-derived) ----------
            if (p === '/api/notifications') {
                // accountId can be null for a brand-new user — the engine still
                // derives the onboarding checklist (account → strategy → trade →
                // review → broker).
                const accountId = q.get('accountId') || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
                const upcoming = await EcoCal.getCalendar().then(c => EcoCal.upcomingHighImpact(c, 12)).catch(() => []);
                const brokerConnected = await Brokers.isConnected(uc.userId);
                const notifications = Notif.buildNotifications(Core, accountId, { upcomingEvents: upcoming, brokerConnected });
                // battle invitations (persisted per-invitee) surface in the feed
                Battle.pendingInvites(uc.userId).forEach(inv => {
                    notifications.unshift({
                        id: inv.id, cat: 'Battles', icon: 'swords', tint: 'indigo',
                        title: 'Battle invitation · ' + inv.title,
                        body: inv.symbol + ' ' + inv.timeframe + ' · ' + inv.taken + '/' + inv.seats + ' seats taken · ' + (inv.free ? inv.free + ' open' : 'full'),
                        href: inv.href, at: inv.createdAt
                    });
                });
                const read = await Notif.readSetOf(uc.userId);
                const unread = notifications.filter(n => !read.has(n.id)).length;
                return json(res, 200, { ok: true, notifications, unread, readIds: [...read], brokerConnected });
            }
            if (p === '/api/brokers') {
                return json(res, 200, { ok: true, brokers: await Brokers.list(uc.userId), connected: await Brokers.isConnected(uc.userId) });
            }
            if (p === '/api/prefs') {
                return json(res, 200, { ok: true, prefs: await Prefs.get(uc.userId) });
            }

            // ---------- Backtesting data (real TradingView OHLCV, cached, synthetic fallback) ----------
            if (p === '/api/backtest/candles') {
                const data = await MarketData.getCandles({
                    symbol: q.get('symbol') || 'EURUSD',
                    timeframe: q.get('timeframe') || '1h',
                    count: Number(q.get('count')) || undefined
                });
                return json(res, 200, data);
            }

            // ---------- Backtest practice sessions (simulation engine) ----------
            if (p === '/api/backtest/sessions' && req.method === 'GET') {
                return json(res, 200, { ok: true, sessions: Sim.listSessions(uc.userId) });
            }
            if ((m = p.match(/^\/api\/backtest\/sessions\/([^/]+)$/))) {
                const s = Sim.getSession(uc.userId, m[1]);
                if (!s) return json(res, 404, { error: 'unknown session' });
                return json(res, 200, { ok: true, state: Sim.stateOf(s) });
            }
            if ((m = p.match(/^\/api\/backtest\/sessions\/([^/]+)\/results$/))) {
                const s = Sim.getSession(uc.userId, m[1]);
                if (!s) return json(res, 404, { error: 'unknown session' });
                return json(res, 200, { ok: true, results: s.results() });
            }

            // ---------- Practice view (same canonical analytics/insights over
            // flattened backtest records — strictly separate from live) ----------
            if (p === '/api/practice/trades') {
                return json(res, 200, { ok: true, trades: Practice.flattenTrades(uc.userId) });
            }
            if (p === '/api/practice/analytics') {
                return json(res, 200, Practice.analytics(uc.userId, Core, {
                    symbol: q.get('symbol'), setup: q.get('setup'), session: q.get('session'),
                    direction: q.get('direction'), result: q.get('result'),
                    from: q.get('from'), to: q.get('to')
                }));
            }
            if (p === '/api/practice/insights') {
                return json(res, 200, { ok: true, findings: Practice.insights(uc.userId, Core) });
            }

            // ---------- AI Backtest Coach (reviews a finished practice session) ----------
            if (p === '/api/ai/backtest-coach') {
                const id = q.get('sessionId');
                const s = id ? Sim.getSession(uc.userId, id) : null;
                if (!s) return json(res, 404, { error: 'unknown practice session' });
                return json(res, 200, AICoach.coach(s));
            }

            // ---------- Online Battles (canonical timeline, private seats) ----------
            if (p === '/api/battles' && req.method === 'GET') {
                return json(res, 200, { ok: true, battles: Battle.listBattles(uc.userId) });
            }
            if (p === '/api/battles/feed' && req.method === 'GET') {
                return json(res, 200, { ok: true, feed: Battle.battlesFeed(uc.userId) });
            }
            if (p === '/api/battles/invites' && req.method === 'GET') {
                return json(res, 200, { ok: true, invites: Battle.pendingInvites(uc.userId) });
            }
            if ((m = p.match(/^\/api\/battles\/invite\/([^/]+)$/))) {
                // resolve a shareable invite code → battle (cross-user via registry)
                const found = Battle.battleByCode(m[1]);
                if (!found) return json(res, 404, { error: 'invite not found or already used' });
                const b = found.battle;
                if (b.status === 'completed') return json(res, 410, { error: 'battle already ended' });
                return json(res, 200, {
                    ok: true,
                    invite: Battle.invitationFor(uc.userId, b.id, b.inviteCode),
                    state: b.publicState()
                });
            }
            if ((m = p.match(/^\/api\/battles\/([^/]+)$/))) {
                const b = Battle.getBattle(uc.userId, m[1]);
                if (!b) return json(res, 404, { error: 'unknown battle' });
                return json(res, 200, { ok: true, state: b.publicState() });
            }
            if ((m = p.match(/^\/api\/battles\/([^/]+)\/seat$/))) {
                const b = Battle.loadActive(uc.userId, m[1]);
                if (!b) return json(res, 404, { error: 'unknown battle' });
                const seat = q.get('seat');
                const s = b.seat(seat);
                if (!s) return json(res, 404, { error: 'unknown seat' });
                // the seat's own userId must match (or host viewing an open seat)
                if (s.userId && s.userId !== uc.userId && s.userId !== 'seat-' + s.id) {
                    return json(res, 403, { error: 'not your seat' });
                }
                return json(res, 200, { ok: true, state: b.seatState(seat) });
            }

            // ---------- Market Replay (bar-by-bar playback sessions) ----------
            if (p === '/api/replay/start') {
                return json(res, 200, await Replay.start({
                    symbol: q.get('symbol') || 'EURUSD',
                    timeframe: q.get('timeframe') || '1h',
                    window: Number(q.get('window')) || undefined,
                    preRoll: Number(q.get('preRoll')) || undefined
                }));
            }
            if (p === '/api/replay/status') {
                return json(res, 200, await Replay.status(q.get('id'), Number(q.get('from')) || 0));
            }


            // ---------- AI Mentor (Phase 2 service layer — server module) ----------
            if (p === '/api/ai/mentor') {
                const accountId = q.get('accountId') || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
                if (!accountId) return json(res, 200, { ok: true, bundle: null });
                const bundle = await AI.mentorWithPrefs(Core, accountId, {
                    period: q.get('period') || '30d',
                    userId: uc.userId,
                    includeSuppressed: q.get('includeSuppressed') === '1'
                });
                // Attach the real upcoming calendar so the UI/AI can warn about
                // trading into scheduled high-impact releases.
                if (bundle) {
                    try {
                        const cal = await EcoCal.getCalendar();
                        bundle.context.upcomingEvents = EcoCal.upcomingHighImpact(cal, 12);
                    } catch (e) { bundle.context.upcomingEvents = []; }
                    if (process.env.GEMINI_API_KEY || process.env.AICREDITS_API_KEY || process.env.OPENAI_API_KEY) {
                        const narrated = await LLM.narrateCoachMessage(bundle);
                        if (narrated) { bundle.coach.message = narrated; bundle.ai = 'aicredits'; }
                    }
                }
                return json(res, 200, { ok: true, bundle });
            }
            if (p === '/api/ai/tilt') {
                const accountId = q.get('accountId') || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
                const ctx = accountId ? AI.buildContext(Core, accountId, 'all') : null;
                return json(res, 200, { ok: true, tilt: ctx ? AI.tiltAnalysis(ctx) : [] });
            }
            if (p === '/api/ai/memory') {
                // Read-only view of the server's persisted conversation memory
                // (data/chat-<userId>-<accountId>.json) so the client can restore
                // the transcript + follow-up context across reloads. The server's
                // persisted memory remains the single authoritative store.
                const accountId = q.get('accountId') || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
                if (!accountId) return json(res, 200, { ok: true, memory: null });
                const memory = await Bot.loadMemory(uc.userId, accountId);
                return json(res, 200, { ok: true, memory });
            }
            if ((m = p.match(/^\/api\/ai\/autopsy\/([^/]+)$/))) {
                const t = Core.Trades.find(x => x.id === m[1]);
                if (!t) return json(res, 404, { error: 'unknown trade: ' + m[1] });
                return json(res, 200, { ok: true, autopsy: AI.autopsy(Core, t) });
            }

            // ---------- Legacy Journal Import (history / preview / errors) ----------
            if (p === '/api/imports') {
                const list = (await Imports.listBatches(uc.userId)).map(b => importPreviewOf(b));
                return json(res, 200, { ok: true, imports: list });
            }
            if ((m = p.match(/^\/api\/imports\/([^/]+)$/))) {
                const b = await Imports.getBatch(uc.userId, m[1]);
                if (!b) return json(res, 404, { error: 'unknown import batch' });
                return json(res, 200, { ok: true, import: importPreviewOf(b) });
            }
            if ((m = p.match(/^\/api\/imports\/([^/]+)\/preview$/))) {
                const b = await Imports.getBatch(uc.userId, m[1]);
                if (!b) return json(res, 404, { error: 'unknown import batch' });
                return json(res, 200, importPreviewOf(b));
            }
            if ((m = p.match(/^\/api\/imports\/([^/]+)\/errors$/))) {
                const b = await Imports.getBatch(uc.userId, m[1]);
                if (!b) return json(res, 404, { error: 'unknown import batch' });
                const errors = (b.rows || [])
                    .filter(r => r.state === 'ERROR')
                    .map(r => ({ rowNumber: r.rowNumber, errors: r.errors }));
                return json(res, 200, { ok: true, total: errors.length, errors });
            }
        } catch (err) {
            console.error('[31trades] GET ' + p + ' failed: ' + err.message);
            return json(res, 400, { error: err.message });
        }
        return json(res, 404, { error: 'unknown endpoint: ' + p });
    }

    // ---------- Journal Import upload (raw body — base64 for binary files) ----------
    if (p === '/api/imports/upload' && req.method === 'POST') {
        return handleImportUpload(req, res, uc, Core);
    }

    // ---------- write endpoints ----------
    let body = {};
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

    try {
        let m;

        // ---- market replay controls ----
        if (p === '/api/replay/control') {
            return json(res, 200, await Replay.control(body.id, body.action, body.speedMs));
        }

        // ---- per-user preferences (theme sync across devices) ----
        if (p === '/api/prefs' && (req.method === 'POST' || req.method === 'PUT')) {
            const theme = String(body.theme || '').toLowerCase();
            if (!Prefs.THEMES.includes(theme)) {
                return json(res, 400, { error: 'theme must be one of ' + Prefs.THEMES.join(', ') });
            }
            return json(res, 200, { ok: true, prefs: await Prefs.set(uc.userId, theme) });
        }

        // ---- backtest practice session lifecycle ----
        if (p === '/api/backtest/sessions' && req.method === 'POST') {
            const symbol = String(body.symbol || 'EURUSD').toUpperCase();
            const timeframe = String(body.timeframe || '1h');
            const window = Math.max(30, Math.min(1500, Number(body.window) || 300));
            const md = await MarketData.getCandles({ symbol, timeframe, count: window });
            if (!md.ok || !md.candles.length) return json(res, 400, { error: 'no candles for ' + symbol });
            const startIndex = Math.max(0, Math.min(Number(body.startBars) || Math.min(30, md.candles.length - 1), md.candles.length - 1));
            const sess = new Sim.BacktestSession({
                userId: uc.userId, symbol, timeframe,
                category: (md.meta && md.meta.category) || 'Other',
                strategy: String(body.strategy || 'Manual practice'),
                startingBalance: Number(body.startingBalance) || 10000,
                riskModel: body.riskModel || { basis: 'money', perTrade: 25 },
                candles: md.candles,
                startIndex
            });
            Sim.saveSession(uc.userId, sess);
            return json(res, 200, { ok: true, session: sess.id, state: Sim.stateOf(sess) });
        }
        if ((m = p.match(/^\/api\/backtest\/sessions\/([^/]+)\/control$/))) {
            const id = m[1];
            if (body.action === 'play') return json(res, 200, Sim.play(uc.userId, id, body.speedMs));
            if (body.action === 'pause') return json(res, 200, Sim.pause(uc.userId, id));
            if (body.action === 'step') return json(res, 200, Sim.stepSession(uc.userId, id));
            if (body.action === 'seek') return json(res, 200, Sim.seekSession(uc.userId, id, Number(body.cursor)));
            if (body.action === 'reset') return json(res, 200, Sim.resetSession(uc.userId, id));
            return json(res, 400, { error: 'unknown control action' });
        }
        if ((m = p.match(/^\/api\/backtest\/sessions\/([^/]+)\/enter$/))) {
            const s = Sim.loadActive(uc.userId, m[1]);
            if (!s) return json(res, 404, { error: 'unknown session' });
            const r = s.enter({
                direction: body.direction, entry: body.entry, sl: body.sl, tp: body.tp,
                riskAmount: body.riskAmount, riskPct: body.riskPct, size: body.size,
                notes: body.notes, setup: body.setup
            });
            if (!r.ok) return json(res, 400, { error: r.error });
            Sim.saveSession(uc.userId, s);
            return json(res, 200, { ok: true, position: r.position, state: Sim.stateOf(s) });
        }
        if ((m = p.match(/^\/api\/backtest\/sessions\/([^/]+)\/close$/))) {
            const s = Sim.loadActive(uc.userId, m[1]);
            if (!s) return json(res, 404, { error: 'unknown session' });
            const r = s.close({ price: body.price, reason: body.reason });
            if (!r.ok) return json(res, 400, { error: r.error });
            Sim.saveSession(uc.userId, s);
            return json(res, 200, { ok: true, trade: r.trade, state: Sim.stateOf(s) });
        }
        if (req.method === 'DELETE' && (m = p.match(/^\/api\/backtest\/sessions\/([^/]+)$/))) {
            Sim.deleteSession(uc.userId, m[1]);
            Sim.pause(uc.userId, m[1]);
            return json(res, 200, { ok: true });
        }

        // ---- Online Battles (write: create / control / enter / close / join) ----
        if (p === '/api/battles' && req.method === 'POST') {
            const symbol = String(body.symbol || 'EURUSD').toUpperCase();
            const timeframe = String(body.timeframe || '1h');
            const window = Math.max(30, Math.min(1500, Number(body.window) || 300));
            const md = await MarketData.getCandles({ symbol, timeframe, count: window });
            if (!md.ok || !md.candles.length) return json(res, 400, { error: 'no candles for ' + symbol });
            const startIndex = Math.max(0, Math.min(Number(body.startBars) || Math.min(30, md.candles.length - 1), md.candles.length - 1));
            const seatNames = Array.isArray(body.seats) ? body.seats.slice(0, 10).map(s => String(s).trim()) : ['Trader 1', 'Trader 2'];
            const teams = Array.isArray(body.teams) && body.teams.length === seatNames.length ? body.teams.map(t => String(t).trim() || null) : null;
            const b = new Battle.Battle({
                hostId: uc.userId,
                title: String(body.title || symbol + ' ' + timeframe + ' battle'),
                symbol, timeframe,
                category: (md.meta && md.meta.category) || 'Other',
                candles: md.candles, startIndex,
                startingBalance: Number(body.startingBalance) || 10000,
                riskModel: body.riskModel || { basis: 'money', perTrade: 25 },
                status: 'lobby',
                seats: seatNames.map((name, i) => ({
                    id: 's' + i, name, team: teams ? teams[i] : null, userId: i === 0 ? uc.userId : null
                }))
            });
            b._ensureSeats();
            Battle.saveBattle(uc.userId, b);
            Battle.emit('created', b);
            return json(res, 200, { ok: true, battle: b.id, hostSeat: b.seats[0].id, state: b.publicState() });
        }
        if ((m = p.match(/^\/api\/battles\/([^/]+)\/invite$/))) {
            // host invites people: returns the shareable link + records an
            // in-app invitation for each invited user
            const b = Battle.getBattle(uc.userId, m[1]);
            if (!b) return json(res, 404, { error: 'unknown battle' });
            if (b.hostId !== uc.userId) return json(res, 403, { error: 'only the host can invite' });
            const emails = Array.isArray(body.emails) ? body.emails.map(e => String(e).trim().toLowerCase()).filter(Boolean) : [];
            // senders may pass a display name for the invitee — used for the mailto body
            const name = String(body.name || 'a fellow trader').trim();
            const code = b.inviteCode || Battle.genInviteCode();
            b.inviteCode = code;
            Battle.saveBattle(uc.userId, b);
            const link = (req.headers.origin ? req.headers.origin : 'http://' + (req.headers.host || 'localhost')) + '/battles.html?invite=' + code;
            if (emails.length) {
                // record an in-app invitation for each email's user (when the
                // account exists) and always return the mailto for real email
                emails.forEach(email => {
                    const invUserId = userIdByEmail(email);
                    if (invUserId) Battle.addInvite(invUserId, b.id, code);
                });
            }
            return json(res, 200, { ok: true, code, link, mailto: mailtoInvite(emails, link, b.title, name) });
        }
        if ((m = p.match(/^\/api\/battles\/invite\/([^/]+)\/accept$/))) {
            // accept an invite: resolve the battle, claim a free seat
            const found = Battle.battleByCode(m[1]);
            if (!found) return json(res, 404, { error: 'invite not found' });
            const b = found.battle;
            if (b.status === 'completed') return json(res, 410, { error: 'battle already ended' });
            const free = b.seats.find(s => !s.userId);
            if (!free) return json(res, 400, { error: 'battle is full' });
            free.userId = uc.userId;
            free.name = String(body.name || free.name || 'Seat');
            Battle.saveBattle(b.hostId, b);
            Battle.emit('status', b);
            return json(res, 200, { ok: true, seat: free.id, state: b.publicState() });
        }
        if (req.method === 'DELETE' && (m = p.match(/^\/api\/battles\/([^/]+)\/invite$/))) {
            // invitee dismisses a pending invite
            Battle.clearInvite(uc.userId, m[1]);
            return json(res, 200, { ok: true });
        }
        if ((m = p.match(/^\/api\/battles\/([^/]+)\/join$/))) {
            const b = Battle.loadActive(uc.userId, m[1]);
            if (!b) return json(res, 404, { error: 'unknown battle' });
            const free = b.seats.find(s => !s.userId);
            if (!free) return json(res, 400, { error: 'battle is full' });
            if (b.status !== 'lobby' && b.status !== 'running') return json(res, 400, { error: 'battle already over' });
            free.userId = uc.userId;
            free.name = String(body.name || free.name);
            Battle.saveBattle(b.hostId, b);
            Battle.emit('status', b);
            return json(res, 200, { ok: true, seat: free.id, state: b.publicState() });
        }
        if ((m = p.match(/^\/api\/battles\/([^/]+)\/control$/))) {
            const id = m[1];
            // only the host drives the canonical replay
            const host = Battle.getBattle(uc.userId, id);
            if (!host || host.hostId !== uc.userId) return json(res, 403, { error: 'only the host can control the replay' });
            if (body.action === 'play') return json(res, 200, Battle.play(uc.userId, id, body.speedMs));
            if (body.action === 'pause') return json(res, 200, Battle.pause(uc.userId, id));
            if (body.action === 'step') return json(res, 200, Battle.step(uc.userId, id));
            if (body.action === 'seek') return json(res, 200, Battle.seek(uc.userId, id, Number(body.cursor)));
            if (body.action === 'reset') return json(res, 200, Battle.reset(uc.userId, id));
            if (body.action === 'complete') return json(res, 200, Battle.complete(uc.userId, id));
            return json(res, 400, { error: 'unknown control action' });
        }
        if ((m = p.match(/^\/api\/battles\/([^/]+)\/enter$/))) {
            const b = Battle.loadActive(uc.userId, m[1]);
            if (!b) return json(res, 404, { error: 'unknown battle' });
            const seat = b.seat(String(body.seat));
            if (!seat) return json(res, 404, { error: 'unknown seat' });
            if (seat.userId && seat.userId !== uc.userId) return json(res, 403, { error: 'not your seat' });
            const r = b.enter(seat.id, {
                direction: body.direction, entry: body.entry, sl: body.sl, tp: body.tp,
                riskAmount: body.riskAmount, riskPct: body.riskPct, size: body.size,
                notes: body.notes, setup: body.setup
            });
            if (!r.ok) return json(res, 400, { error: r.error });
            Battle.saveBattle(b.hostId, b);
            Battle.emit('seat', b);
            return json(res, 200, { ok: true, position: r.position, state: b.seatState(seat.id) });
        }
        if ((m = p.match(/^\/api\/battles\/([^/]+)\/close$/))) {
            const b = Battle.loadActive(uc.userId, m[1]);
            if (!b) return json(res, 404, { error: 'unknown battle' });
            const seat = b.seat(String(body.seat));
            if (!seat) return json(res, 404, { error: 'unknown seat' });
            if (seat.userId && seat.userId !== uc.userId) return json(res, 403, { error: 'not your seat' });
            const r = b.close(seat.id, { price: body.price, reason: body.reason });
            if (!r.ok) return json(res, 400, { error: r.error });
            Battle.saveBattle(b.hostId, b);
            Battle.emit('seat', b);
            return json(res, 200, { ok: true, trade: r.trade, state: b.seatState(seat.id) });
        }
        if (req.method === 'DELETE' && (m = p.match(/^\/api\/battles\/([^/]+)$/))) {
            const b = Battle.getBattle(uc.userId, m[1]);
            if (!b || b.hostId !== uc.userId) return json(res, 403, { error: 'only the host can delete' });
            Battle.pause(uc.userId, m[1]);
            Battle.deleteBattle(uc.userId, m[1]);
            return json(res, 200, { ok: true });
        }

        // ---- notifications read state (engine module) ----
        if (p === '/api/notifications/read') {
            await Notif.markRead(uc.userId, Array.isArray(body.ids) ? body.ids : []);
            return json(res, 200, { ok: true });
        }

        // ---- broker connections (per-user; onboarding checklist depends on it) ----
        if (p === '/api/brokers/connect') {
            const r = await Brokers.connect(uc.userId, body.broker);
            if (!r.ok) return json(res, 400, { error: r.error });
            logBrokerEvent(Core, r.broker.broker, 'Connected');
            uc.scheduleSave();
            return json(res, 200, { ok: true, broker: r.broker });
        }
        if (p === '/api/brokers/disconnect') {
            const r = await Brokers.disconnect(uc.userId, body.broker);
            if (!r.ok) return json(res, 400, { error: r.error });
            logBrokerEvent(Core, body.broker, 'Disconnected');
            uc.scheduleSave();
            return json(res, 200, { ok: true });
        }

        // ---- Journal Import lifecycle (commit / cancel / rollback) ----
        // In-flight lock: Node's single thread makes check-and-set atomic, so
        // two concurrent commits of the same batch can never double-import.
        if ((m = p.match(/^\/api\/imports\/([^/]+)\/commit$/))) {
            const rl = Imports.rateLimit(uc.userId, 'import-commit', 10, 60000);
            if (!rl.allowed) return json(res, 429, { error: { code: 'IMPORT_RATE_LIMITED', message: 'Too many import commits — try again shortly.' } });
            const bid = m[1];
            const batch = await Imports.getBatch(uc.userId, bid);
            if (!batch) return json(res, 404, { error: { code: 'IMPORT_NOT_FOUND', message: 'unknown import batch' } });
            if (batch.status === 'COMPLETED' || batch.status === 'PARTIAL') {
                // idempotent replay — the second press must not duplicate trades
                return json(res, 200, { ok: true, idempotent: true, batchId: bid, status: batch.status, importedCount: batch.importedCount, skippedCount: batch.skippedCount, duplicateCount: batch.duplicateCount });
            }
            if (batch.status === 'IMPORTING') return json(res, 409, { error: { code: 'IMPORT_IN_PROGRESS', message: 'This import is already running.' } });
            if (batch.status !== 'READY') return json(res, 409, { error: { code: 'IMPORT_NOT_IMPORTABLE', message: 'Import is ' + batch.status.toLowerCase() + ' — it can no longer be committed.' } });
            if (importInFlight.has(uc.userId + ':' + bid)) return json(res, 409, { error: { code: 'IMPORT_IN_PROGRESS', message: 'This import is already running.' } });
            importInFlight.add(uc.userId + ':' + bid);
            try {
                batch.status = 'IMPORTING';
                await Imports.saveBatch(uc.userId, batch);
                logImportEvent(Core, batch, 'Import started', 'Preparing ' + batch.validCount + ' valid rows · ' + batch.rowCount + ' total');

                const includeWarnings = body.includeWarnings !== false;
                const skipDuplicates = body.skipDuplicates !== false;
                const includePossibleDuplicates = body.includePossibleDuplicates === true;
                const errors = [];
                let imported = 0;
                let skipped = 0;

                for (const row of (batch.rows || [])) {
                    const importIt = row.state === 'VALID'
                        || (row.state === 'WARNING' && includeWarnings)
                        || (row.state === 'DUPLICATE' && !skipDuplicates)
                        || (row.state === 'POSSIBLE_DUPLICATE' && includePossibleDuplicates);
                    if (!importIt) { skipped++; continue; }
                    try {
                        const trade = {
                            ...row.values,
                            id: 'imp-' + bid + '-' + row.rowNumber,   // deterministic → idempotent replay
                            import_batch_id: bid
                        };
                        Core.logTradePipeline(trade);
                        imported++;
                        batch.fingerprints.push(Imports.fingerprintOf(trade));
                    } catch (err) {
                        skipped++;
                        errors.push({ rowNumber: row.rowNumber, message: err.message });
                    }
                }

                batch.importedCount = imported;
                batch.skippedCount = skipped;
                batch.rowErrors = errors;
                // PARTIAL = some rows imported, some row-level failures
                // COMPLETED = imported (even 0 — an all-duplicates commit is a
                //   clean no-op, not a failure)
                // FAILED = nothing imported AND row-level failures
                batch.status = errors.length && imported ? 'PARTIAL' : (imported || !errors.length ? 'COMPLETED' : 'FAILED');
                if (batch.status === 'FAILED') batch.errorCode = 'IMPORT_ROW_FAILURE';
                batch.completedAt = new Date().toISOString();
                // drop the raw rows — the ledger is now the record; keep counts +
                // fingerprints (for re-upload duplicate detection) + row errors
                batch.rows = null;
                await Imports.saveBatch(uc.userId, batch);
                uc.scheduleSave();
                if (batch.status === 'FAILED') {
                    logImportEvent(Core, batch, 'Import failed', 'No rows could be imported');
                    return json(res, 400, { error: { code: 'IMPORT_ROW_FAILURE', message: 'No rows could be imported.', details: { errors } } });
                }
                logImportEvent(Core, batch, 'Import completed', imported + ' trades imported · ' + skipped + ' skipped · ' + batch.duplicateCount + ' duplicates');
                return json(res, 200, {
                    ok: true, batchId: bid, status: batch.status,
                    importedCount: imported, skippedCount: skipped,
                    duplicateCount: batch.duplicateCount, possibleDuplicateCount: batch.possibleDuplicateCount,
                    totalTrades: Core.Trades.length, errors: errors.slice(0, 50)
                });
            } catch (err) {
                batch.status = 'FAILED';
                batch.errorCode = 'IMPORT_COMMIT_FAILED';
                batch.rows = null;
                await Imports.saveBatch(uc.userId, batch).catch(() => {});
                logImportEvent(Core, batch, 'Import failed', err.message);
                throw err;
            } finally {
                importInFlight.delete(uc.userId + ':' + bid);
            }
        }
        if ((m = p.match(/^\/api\/imports\/([^/]+)\/cancel$/))) {
            const batch = await Imports.getBatch(uc.userId, m[1]);
            if (!batch) return json(res, 404, { error: { code: 'IMPORT_NOT_FOUND', message: 'unknown import batch' } });
            if (batch.status === 'COMPLETED' || batch.status === 'PARTIAL' || batch.status === 'ROLLED_BACK') {
                return json(res, 409, { error: { code: 'IMPORT_NOT_CANCELLABLE', message: 'Import is ' + batch.status.toLowerCase() + ' — it cannot be cancelled.' } });
            }
            batch.status = 'CANCELLED';
            batch.rows = null;
            batch.completedAt = new Date().toISOString();
            await Imports.saveBatch(uc.userId, batch);
            logImportEvent(Core, batch, 'Import cancelled', 'Import discarded before committing');
            return json(res, 200, { ok: true, batchId: m[1], status: batch.status });
        }
        if ((m = p.match(/^\/api\/imports\/([^/]+)\/rollback$/))) {
            const batch = await Imports.getBatch(uc.userId, m[1]);
            if (!batch) return json(res, 404, { error: { code: 'IMPORT_NOT_FOUND', message: 'unknown import batch' } });
            if (batch.status !== 'COMPLETED' && batch.status !== 'PARTIAL') {
                return json(res, 409, { error: { code: 'IMPORT_NOT_ROLLBACKABLE', message: 'Only completed imports can be rolled back.' } });
            }
            const doomed = Core.Trades.filter(t => t.import_batch_id === m[1]);
            let removed = 0;
            for (const t of doomed.slice()) {
                try { Core.TradeService.remove(t.id); removed++; } catch (e) { /* keep going */ }
            }
            batch.status = 'ROLLED_BACK';
            batch.importedCount = 0;
            batch.rows = null;
            batch.completedAt = new Date().toISOString();
            await Imports.saveBatch(uc.userId, batch);
            uc.scheduleSave();
            logImportEvent(Core, batch, 'Import rolled back', removed + ' imported trades removed from the ledger');
            return json(res, 200, { ok: true, batchId: m[1], status: batch.status, removed });
        }

        // ---- reset to the first-user state (zero trades / accounts) ----
        if (p === '/api/reset') {
            Core.reseed();
            Core.backfillEvaluations();
            uc.pristine = uc.serialize();
            uc.scheduleSave();
            return json(res, 200, { ok: true, trades: Core.Trades.length, accounts: Core.Accounts.length });
        }

        // ---- dev/testing: seed a realistic ~30-trade dataset (optional) ----
        if (p === '/api/seed') {
            const c = Number(body.count || q.get('count') || 30);
            const seed = Core.seedDemoAccount(c > 0 ? c : undefined);
            Core.backfillEvaluations();
            uc.scheduleSave();
            return json(res, 200, { ok: true, trades: seed.trades, accounts: seed.accounts, strategies: seed.strategies });
        }

        // ---- adopt the browser's canonical state (client → server sync).
        // The local-first client is authoritative until the backend fully takes
        // over; this wholesale hydrate keeps the server in lockstep with the
        // browser (called on every page boot + on reconnect). ----
        if (req.method === 'POST' && p === '/api/state') {
            if (!body || !Array.isArray(body.Accounts) || !Array.isArray(body.Trades)) {
                return json(res, 400, { error: 'invalid state payload — expected { Accounts, Trades, ... }' });
            }
            Core.hydrate(body);
            Core.backfillEvaluations();
            uc.scheduleSave();
            return json(res, 200, { ok: true, trades: Core.Trades.length, accounts: Core.Accounts.length });
        }

        // ---- the 7-step rule-evaluation pipeline (Log Trade) ----
        if (req.method === 'POST' && p === '/api/trades') {
            const trade = Core.logTradePipeline(body);
            uc.scheduleSave();
            return json(res, 201, { ok: true, trade, adherence: trade.adherence_result });
        }

        // ---- trade edit / delete (full downstream recalculation) ----
        if (req.method === 'PATCH' && (m = p.match(/^\/api\/trades\/([^/]+)$/))) {
            const t = Core.TradeService.update(m[1], body.fields || body);
            uc.scheduleSave();
            return json(res, 200, { ok: true, trade: t });
        }
        if (req.method === 'DELETE' && (m = p.match(/^\/api\/trades\/([^/]+)$/))) {
            const t = Core.TradeService.remove(m[1]);
            uc.scheduleSave();
            return json(res, 200, { ok: true, deleted: t.id });
        }

        // ---- pre-trade check ----
        if (p === '/api/pre-trade-check') {
            const accountId = (body.draft && body.draft.accountId) || body.accountId;
            if (!accountId) return json(res, 400, { error: 'accountId required' });
            if (!Core.Accounts.some(a => a.id === accountId)) return json(res, 404, { error: 'unknown account: ' + accountId });
            return json(res, 200, Core.preTradeCheck(accountId, body.draft || body));
        }

        // ---- reviews ----
        if (p === '/api/reviews/complete') {
            const r = Core.completeReview(body.account_id, body.period || 'daily', body.note);
            uc.scheduleSave();
            return json(res, 200, r);
        }

        // ---- AI Mentor personal bot (grounded Q&A over the ledger) ----
        if (p === '/api/ai/ask') {
            if (AUTH_REQUIRED && process.env.SUPABASE_URL) {
                try {
                    await Access.enforceAiQuota(uc.userId);
                    Admin.logActivity(uc.userId, 'ai_request', { question: (b && b.question ? String(b.question).slice(0, 60) : '') });
                } catch (err) {
                    return json(res, err.code || 403, { ok: false, error: err.message });
                }
            }
            if (!body.question || !String(body.question).trim()) return json(res, 400, { error: 'question required' });
            const accountId = body.accountId || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
            if (!accountId) return json(res, 200, { ok: true, answer: 'No account yet — create one in Strategy Lab and log trades; then I can coach you on your real data.', kpis: [], evidence: [], followUps: [] });
            // Conversation memory: the server's persisted context wins, but the
            // client's remembered context (sent every turn) fills in for a fresh
            // server. Persist the updated context (survives restarts via
            // data/chat-*.json).
            const mem = (await Bot.loadMemory(uc.userId, accountId)) || body.memory || null;
            // Real calendar context feeds the coach: upcoming high/medium events
            // let it warn about trading into a scheduled release.
            // null = provider unreachable (bot says "unavailable"); [] = calendar
            // live but quiet (bot says "no events scheduled"). Never fabricated.
            let events = null;
            try {
                const cal = await EcoCal.getCalendar();
                events = cal.ok ? EcoCal.upcomingHighImpact(cal, 12) : null;
            } catch (e) { /* calendar offline — the bot answers without news */ }
            const r = Bot.askBot(Core, accountId, body.question, { period: body.period || '30d', memory: mem, events });
            if (r.memory) await Bot.saveMemory(uc.userId, accountId, r.memory);
            // AI narration: Gemini rephrases the grounded answer when a key is
            // configured; the grounding guard discards it if any number is
            // altered, and the deterministic answer always remains.
            if (process.env.GEMINI_API_KEY) {
                const narrated = await LLM.narrateBotAnswer(r);
                if (narrated) { r.answer = narrated; r.ai = 'gemini'; }
            }
            return json(res, 200, Object.assign({ ok: true }, r));
        }

        // ---- AI Mentor findings prefs (dismiss / rate a finding) ----
        if (p === '/api/ai/findings/suppress') {
            if (!body.finding_id) return json(res, 400, { error: 'finding_id required' });
            const ok = await AI.setPref(uc.userId, body.finding_id, { suppressed: !!body.suppressed });
            return json(res, 200, { ok: true, finding_id: body.finding_id, suppressed: !!body.suppressed, persisted: ok });
        }
        if (p === '/api/ai/findings/feedback') {
            if (!body.finding_id) return json(res, 400, { error: 'finding_id required' });
            const value = body.value === 1 ? 1 : body.value === -1 ? -1 : null;
            const ok = await AI.setPref(uc.userId, body.finding_id, { feedback: value });
            return json(res, 200, { ok: true, finding_id: body.finding_id, feedback: value, persisted: ok });
        }

        // ---- audit-log entries ----
        if (p === '/api/events') {
            if (body.action === 'tag') {
                Core.ConfigAPI.logTagEvent(body.entity, body.what, body.detail, body.impact);
            } else {
                Core.ConfigAPI.recordManualChange(body.detail || '');
            }
            uc.scheduleSave();
            return json(res, 201, { ok: true });
        }

        // ---- rule sets: toggle / add / edit a rule (new immutable version) ----
        if (p === '/api/rule-sets/toggle') {
            const v = Core.ConfigAPI.toggleRule(body.key);
            if (!v) return json(res, 404, { error: 'rule not found: ' + body.key });
            uc.scheduleSave();
            return json(res, 200, { ok: true, version: v.id });
        }
        if ((m = p.match(/^\/api\/rule-sets\/([^/]+)\/rules\/([^/]+)$/))) {
            const v = Core.ConfigAPI.updateRule(m[1], m[2], body.changes || body);
            if (!v) return json(res, 404, { error: 'rule not found' });
            uc.scheduleSave();
            return json(res, 200, { ok: true, version: v.id });
        }
        if ((m = p.match(/^\/api\/rule-sets\/([^/]+)\/rules$/))) {
            const v = Core.ConfigAPI.addRule(m[1], body.rule || body);
            if (!v) return json(res, 404, { error: 'unknown rule set: ' + m[1] });
            uc.scheduleSave();
            return json(res, 201, { ok: true, version: v.id });
        }

        // ---- accounts ----
        if (p === '/api/accounts') {
            const id = Core.ConfigAPI.createAccount(body.fields || body, body.id);
            uc.scheduleSave();
            return json(res, 201, { ok: true, id });
        }
        if ((m = p.match(/^\/api\/accounts\/([^/]+)\/strategies$/))) {
            const ok = Core.ConfigAPI.assignStrategy(m[1], body.strategy_id);
            if (!ok) return json(res, 404, { error: 'account or strategy not found' });
            uc.scheduleSave();
            return json(res, 200, { ok: true });
        }
        if ((m = p.match(/^\/api\/accounts\/([^/]+)\/limits$/))) {
            const v = Core.ConfigAPI.updateAccountLimits(m[1], body.values || body, body.note);
            if (!v) return json(res, 404, { error: 'unknown account: ' + m[1] });
            uc.scheduleSave();
            return json(res, 200, { ok: true, version: v.id });
        }
        if ((m = p.match(/^\/api\/accounts\/([^/]+)\/status$/))) {
            const a = Core.ConfigAPI.setAccountStatus(m[1], body.status);
            if (!a) return json(res, 404, { error: 'unknown account: ' + m[1] });
            uc.scheduleSave();
            return json(res, 200, { ok: true });
        }
        if ((m = p.match(/^\/api\/accounts\/([^/]+)\/duplicate$/))) {
            const id = Core.ConfigAPI.duplicateAccount(m[1], body.id);
            if (!id) return json(res, 404, { error: 'unknown account: ' + m[1] });
            uc.scheduleSave();
            return json(res, 201, { ok: true, id });
        }
        if ((m = p.match(/^\/api\/accounts\/([^/]+)$/))) {
            const a = Core.ConfigAPI.updateAccount(m[1], body);
            if (!a) return json(res, 404, { error: 'unknown account: ' + m[1] });
            uc.scheduleSave();
            return json(res, 200, { ok: true });
        }

        // ---- strategies ----
        if (p === '/api/strategies') {
            const id = Core.ConfigAPI.createStrategy(body.fields || body, body.id);
            uc.scheduleSave();
            return json(res, 201, { ok: true, id });
        }
        if ((m = p.match(/^\/api\/strategies\/([^/]+)\/duplicate$/))) {
            const id = Core.ConfigAPI.duplicateStrategy(m[1], body.id);
            if (!id) return json(res, 404, { error: 'unknown strategy: ' + m[1] });
            uc.scheduleSave();
            return json(res, 201, { ok: true, id });
        }
        if ((m = p.match(/^\/api\/strategies\/([^/]+)$/))) {
            const v = Core.ConfigAPI.updateStrategy(m[1], body.fields || body, body.note);
            if (!v) return json(res, 404, { error: 'unknown strategy: ' + m[1] });
            uc.scheduleSave();
            return json(res, 200, { ok: true, version: v.id });
        }

        return json(res, 404, { error: 'unknown endpoint: ' + p });
    } catch (err) {
        // Labeled so Railway logs show WHICH endpoint failed, not just a 400.
        console.error('[31trades] ' + req.method + ' ' + p + ' failed: ' + err.message);
        return json(res, 400, { error: err.message });
    }
}

// Derived risk events (limit breach / high risk / loss breach / drawdown /
// spikes / blocks) live in the core as Core.riskEvents(accountId) — the SAME
// derivation the Risk page and notifications consume. Single source of truth.

/* ---------------------------------------------------------------------------
   5. STATIC SERVING — public SEO routes + the app pages from the project root
   ---------------------------------------------------------------------------
   Routing order:
     1. /robots.txt + /sitemap.xml     — generated from server/seo.js (registry)
     2. exact-match 301 redirects      — legacy/alternate URL forms
     3. public SEO routes              — canonicalized, registry-injected <head>
     4. private app pages              — X-Robots-Tag noindex + robots-meta rewrite
     5. missing pages                  — branded 404 page (real HTTP 404)
   Public pages never load app bundles; private data stays behind auth-gated APIs.
   --------------------------------------------------------------------------- */
const NOINDEX_DIRECTIVE = 'noindex, nofollow, noarchive';

/* ---------------------------------------------------------------------------
   SECURITY HEADERS
   ---------------------------------------------------------------------------
   Applied to every response — API and static alike. CSP starts in report-only
   mode (set CSP_ENFORCE=true in .env to enforce). These headers close the
   most common browser-side attack vectors without touching application code.
   --------------------------------------------------------------------------- */
const SITE_URL = (process.env.SITE_URL || 'https://31trades-production.up.railway.app').replace(/\/+$/, '');
const CSP_ENFORCE = process.env.CSP_ENFORCE === 'true';

function securityHeaders(res) {
    const csp = [
        "default-src 'self'",
        "script-src 'self' https://fonts.googleapis.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests"
    ].join('; ');

    // Default is REPORT-ONLY (the app uses inline scripts on many pages, so an
    // enforced CSP would break them). Set CSP_ENFORCE=true in .env only after
    // inline scripts are migrated to external files / hashed.
    res.setHeader(CSP_ENFORCE ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', csp + "; report-uri /api/csp-report");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (SITE_URL.startsWith('https://')) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
}

/* ---------------------------------------------------------------------------
   AUTH RATE LIMITING
   ---------------------------------------------------------------------------
   Per-email + per-IP sliding-window counters for login, signup, forgot and
   change-password endpoints. Prevents brute-force, credential stuffing and
   password-reset flooding without any external dependency.
   --------------------------------------------------------------------------- */
const authAttempts = new Map(); // key → { attempts: [{ ts, ok }], lockedUntil }
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15-minute sliding window
const MAX_LOGIN_ATTEMPTS = 8;
const MAX_SIGNUP_ATTEMPTS = 5;
const MAX_FORGOT_ATTEMPTS = 3;
const LOCKOUT_MS = 15 * 60 * 1000; // 15-minute lockout
const GLOBAL_IP_LIMIT = 120; // max auth requests per IP per window

function _authRLTrim(entry) {
    const cutoff = Date.now() - AUTH_WINDOW_MS;
    entry.attempts = entry.attempts.filter(a => a.ts > cutoff);
}

function authRateLimit(key, maxAttempts) {
    let entry = authAttempts.get(key);
    if (!entry) { entry = { attempts: [], lockedUntil: 0 }; authAttempts.set(key, entry); }
    if (entry.lockedUntil > Date.now()) {
        const waitSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
        return { allowed: false, retryAfter: waitSec, error: 'Too many attempts. Try again in ' + Math.ceil(waitSec / 60) + ' minute(s).' };
    }
    _authRLTrim(entry);
    if (entry.attempts.length >= maxAttempts) {
        entry.lockedUntil = Date.now() + LOCKOUT_MS;
        authAttempts.set(key, entry);
        return { allowed: false, retryAfter: Math.ceil(LOCKOUT_MS / 1000), error: 'Account temporarily locked due to repeated failures.' };
    }
    return { allowed: true };
}

function authRLRecord(key, success) {
    let entry = authAttempts.get(key);
    if (!entry) { entry = { attempts: [], lockedUntil: 0 }; authAttempts.set(key, entry); }
    entry.attempts.push({ ts: Date.now(), ok: success });
    if (success) entry.lockedUntil = 0; // clear lockout on success
    _authRLTrim(entry);
}

function ipRLKey(req) { return 'ip:' + (req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }
function authIPRateLimit(req) {
    const key = ipRLKey(req);
    return authRateLimit(key, GLOBAL_IP_LIMIT);
}

// Periodic cleanup to prevent memory leak from abandoned keys
setInterval(() => {
    const cutoff = Date.now() - AUTH_WINDOW_MS * 2;
    for (const [k, v] of authAttempts) {
        if (v.lockedUntil < cutoff || (v.attempts.length === 0 && v.lockedUntil < Date.now())) {
            authAttempts.delete(k);
        }
    }
}, 5 * 60 * 1000);

/* ---------------------------------------------------------------------------
   STANDALONE TEST CHATBOT (public /api/chat-test)
   ---------------------------------------------------------------------------
   Per-IP sliding-window limiter for the landing-page widget. The endpoint is
   deliberately unauthenticated (the page is public), so this IP limit is the
   only abuse protection for the shared Gemini key.
   --------------------------------------------------------------------------- */
const chatAttempts = new Map(); // ip → [timestamps]
const CHAT_WINDOW_MS = 15 * 60 * 1000; // 15-minute sliding window
const MAX_CHAT_PER_WINDOW = 30; // messages per IP per window

function chatRateLimit(req) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const now = Date.now();
    let arr = (chatAttempts.get(ip) || []).filter(t => t > now - CHAT_WINDOW_MS);
    if (arr.length >= MAX_CHAT_PER_WINDOW) {
        const waitSec = Math.ceil((arr[0] + CHAT_WINDOW_MS - now) / 1000);
        chatAttempts.set(ip, arr);
        return { allowed: false, retryAfter: waitSec, error: 'Chat limit reached — try again in ' + Math.ceil(waitSec / 60) + ' minute(s).' };
    }
    arr.push(now);
    chatAttempts.set(ip, arr);
    return { allowed: true };
}

// Free-form Gemini call for the test chatbot. Reuses the Interactions API
// (+ parseResponse) from server/llm.js. Multi-turn context is folded into the
// prompt text; nothing is persisted. Returns null on any failure (network,
// timeout, non-200, malformed/empty response) — the endpoint maps that to a
// friendly 502.
async function chatWithGemini(history, message) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const turns = (history || []).map(h => (h.role === 'model' ? 'Assistant: ' : 'User: ') + h.text).join('\n');
    const input =
        'You are the AI assistant for BattlexJournal, a trading journal app. You are a friendly, concise assistant ' +
        'having a free-form conversation (this is a testing chat, not connected to any user data). ' +
        'Answer helpfully and keep replies under ~150 words.\n\n' +
        (turns ? turns + '\n' : '') +
        'User: ' + message + '\nAssistant:';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
        const res = await fetch(LLM.GEMINI_BASE + '/v1beta/interactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ model: LLM.GEMINI_MODEL, input, store: false }),
            signal: ctl.signal
        });
        if (!res || !res.ok) return null;
        const json = await res.json();
        return LLM.parseResponse(json);
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function sendRedirect(res, location) {
    res.writeHead(301, {
        'Location': location,
        'Cache-Control': 'public, max-age=3600'
    });
    res.end();
}

function sendText(req, res, body, contentType, cacheControl) {
    const raw = Buffer.from(body, 'utf8');
    const enc = pickEncoding(req);
    const headers = {
        'Content-Type': contentType,
        'Cache-Control': cacheControl || 'public, max-age=3600',
        'Vary': 'Accept-Encoding'
    };
    if (enc) {
        headers['Content-Encoding'] = enc;
        res.writeHead(200, headers);
        return res.end(compressSync(raw, enc));
    }
    res.writeHead(200, headers);
    res.end(raw);
}

// Branded 404 page with a REAL 404 status (never a soft-200), for page-like
// requests. Assets/APIs keep the compact JSON 404.
function serveNotFound(req, res, p) {
    const ext = path.extname(p).toLowerCase();
    const wantsHtml = ext === '' || ext === '.html';
    if (!wantsHtml) return json(res, 404, { error: 'not found: ' + p });
    fs.readFile(path.join(ROOT, '404.html'), (err, data) => {
        if (err) return json(res, 404, { error: 'not found: ' + p });
        res.writeHead(404, {
            'Content-Type': MIME['.html'],
            'Cache-Control': 'no-cache',
            'X-Robots-Tag': 'noindex, nofollow'
        });
        res.end(data);
    });
}

// Serve a registered public page: inject the registry-driven SEO head and
// breadcrumb nav into the static template, then serve (compressed, ETagged).
function servePublicPage(req, res, pub) {
    const file = path.join(ROOT, pub.entry.file);
    fs.stat(file, (serr, st) => {
        if (serr) return serveNotFound(req, res, pub.route);
        const etag = `"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`;
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheFor('.html') });
            return res.end();
        }
        fs.readFile(file, (err, data) => {
            if (err) return serveNotFound(req, res, pub.route);
            const html = data.toString('utf8')
                .replace('<!-- SEO:META -->', SEO.seoHead(pub.route))
                .replace('<!-- SEO:BREADCRUMB -->', SEO.breadcrumbNav(pub.route));
            data = Buffer.from(html, 'utf8');
            const enc = COMPRESSIBLE['.html'] ? pickEncoding(req) : null;
            const headers = {
                'Content-Type': MIME['.html'],
                'Cache-Control': cacheFor('.html'),
                'ETag': etag,
                'Vary': 'Accept-Encoding'
            };
            if (enc) {
                const { buf } = compressedVariant(file, data, enc);
                headers['Content-Encoding'] = enc;
                res.writeHead(200, headers);
                return res.end(buf);
            }
            res.writeHead(200, headers);
            res.end(data);
        });
    });
}

// Defense in depth on private pages: rewrite any index,follow robots meta to
// noindex at serve time, so even a stale cached page never says "index".
function rewriteRobotsMeta(html) {
    return html
        .replace(/<meta name="robots" content="index, follow">/g, '<meta name="robots" content="' + NOINDEX_DIRECTIVE + '">')
        .replace(/<meta name="robots" content="index,follow">/g, '<meta name="robots" content="' + NOINDEX_DIRECTIVE + '">');
}

function serveStatic(req, res, urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath); } catch (e) { return json(res, 400, { error: 'bad path' }); }

    // ---- 1. registry-generated SEO endpoints ----
    if (p === '/robots.txt') return sendText(req, res, SEO.robotsTxt(), 'text/plain; charset=utf-8', 'public, max-age=86400');
    if (p === '/sitemap.xml') return sendText(req, res, SEO.sitemapXml(), 'application/xml; charset=utf-8', 'public, max-age=3600');

    // ---- 2. exact-match 301 redirects (no chains — every target is final) ----
    const redir = SEO.redirectFor(p);
    if (redir) return sendRedirect(res, redir);

    // ---- 3. public SEO routes (trailing-slash/case canonicalization + injection) ----
    const pub = SEO.publicRouteFor(p);
    if (pub) {
        if (pub.redirect) return sendRedirect(res, pub.redirect);
        return servePublicPage(req, res, pub);
    }

    // ---- 4. private app pages: noindex headers ----
    const privatePath = SEO.isPrivatePath(p);

    // ---- 4b. never serve storage/source trees or dotfiles over HTTP. The app
    // only loads /src and /assets; /data (per-user trade mirrors), /db, /server
    // and .env must stay off the wire regardless of robots.txt. ----
    const firstSeg = p.replace(/^\/+/, '').split('/')[0].toLowerCase();
    const dotSeg = (p.split('/')[1] || '').toLowerCase();
    if (firstSeg === 'data' || firstSeg === 'db' || firstSeg === 'server' || (dotSeg && dotSeg.startsWith('.') && dotSeg !== '.well-known')) {
        return json(res, 403, { error: 'forbidden' });
    }

    if (p === '/') p = '/index.html';
    if (p === '/admin' || p === '/admin/') p = '/admin.html';
    if (p === '/activate' || p === '/activate/') p = '/activate.html';

    const file = path.normalize(path.join(ROOT, p));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        return json(res, 403, { error: 'forbidden' });
    }

    fs.stat(file, (serr, st) => {
        if (serr) return serveNotFound(req, res, p);
        const ext = path.extname(file).toLowerCase();
        const etag = `"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`;

        // Revalidation: if the browser already has this exact version, send 304.
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheFor(ext) });
            return res.end();
        }

        fs.readFile(file, (err, data) => {
            if (err) return serveNotFound(req, res, p);
            // assets/logo.svg is a binary image (PNG/JPEG — the logo asset is
            // dropped in under a .svg name); sniff the real type so the header
            // <img> and the favicon render instead of failing an SVG parse, and
            // skip brotli/gzip (binary images are already compressed).
            let logoType = null;
            if (p === '/assets/logo.svg' && ext === '.svg' && data.length > 3) {
                if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) logoType = 'image/png';
                else if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) logoType = 'image/jpeg';
            }
            const enc = COMPRESSIBLE[ext] && !logoType ? pickEncoding(req) : null;
            const headers = {
                'Content-Type': logoType || (MIME[ext] || 'application/octet-stream'),
                'Cache-Control': cacheFor(ext),
                'ETag': etag,
                'Vary': 'Accept-Encoding'
            };
            if (privatePath && ext === '.html') {
                headers['X-Robots-Tag'] = NOINDEX_DIRECTIVE;
                data = Buffer.from(rewriteRobotsMeta(data.toString('utf8')), 'utf8');
            }
            if (enc) {
                const { buf } = compressedVariant(file, data, enc);
                headers['Content-Encoding'] = enc;
                res.writeHead(200, headers);
                return res.end(buf);
            }
            res.writeHead(200, headers);
            res.end(data);
        });
    });
}

// HTML revalidates (fast 304s); fingerprint-able subresources cache hard.
function cacheFor(ext) {
    return 'no-store, no-cache, must-revalidate, proxy-revalidate';
}

/* ---------------------------------------------------------------------------
   6. BOOT
   --------------------------------------------------------------------------- */
function shutdown(signal) {
    console.log('[31trades] ' + signal + ' — flushing pending writes…');
    const done = () => process.exit(0);
    setTimeout(done, 4000).unref();   // never hang shutdown
    const flushes = [...cores.values()].map(uc => uc.flush());
    Promise.all(flushes).then(done).catch(done);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Safety net: a single bad query / malformed row / failed write must NEVER take
// the whole server down (that's the 502). Log it and keep serving — the next
// request still answers. Uncaught errors are still visible in Railway logs.
process.on('uncaughtException', err => {
    console.error('[31trades] UNCAUGHT EXCEPTION (kept alive): ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', err => {
    console.error('[31trades] UNHANDLED REJECTION (kept alive): ' + (err && err.stack ? err.stack : err));
});

boot().then(() => {
    const server = http.createServer((req, res) => {
        let url;
        try { url = new URL(req.url, 'http://127.0.0.1:' + PORT); } catch (e) { return json(res, 400, { error: 'bad url' }); }

        // Security headers on EVERY response (API + static)
        securityHeaders(res);

        // CORS for API requests
        if (url.pathname.startsWith('/api/')) {
            const origin = req.headers.origin || '';
            if (origin && origin === SITE_URL) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                res.setHeader('Access-Control-Max-Age', '86400');
            }
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                return res.end();
            }
            handleApi(req, res, url).catch(err => json(res, 500, { error: err.message }));
            return;
        }
        serveStatic(req, res, url.pathname);
    // 0.0.0.0 — Railway (and other hosts) route external traffic to the
    // container this way; loopback clients (127.0.0.1) are still served.
    });
    // Real-time battle pushes (cursor/status/feed) — same HTTP server, /ws path
    try { BattleWs.attach(server); } catch (e) { console.error('[31trades] ws attach failed: ' + e.message); }
    server.listen(PORT, '0.0.0.0', () => {
        console.log('31Trades backend listening on http://0.0.0.0:' + PORT + '  (db: ' + (db.status().configured ? 'Supabase Postgres' : 'data/db.json (SUPABASE_DB_URL not configured)') + ')' + '  (ws: ' + (BattleWs ? 'on /ws' : 'off') + ')');
    });
}).catch(err => {
    console.error('[31trades] boot failed: ' + err.message);
    process.exit(1);
});
