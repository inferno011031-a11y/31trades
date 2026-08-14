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
const AI = require('./server/ai-mentor.js');
const Bot = require('./server/ai-bot.js');
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
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};

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

function bearerToken(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
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

/* ---------------------------------------------------------------------------
   4. REST API — thin, stateless wrappers over the canonical ConfigAPI.
      Every mutation persists via save(). Errors are returned as JSON 400s.
   --------------------------------------------------------------------------- */
async function handleApi(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;

    // ---------- auth + health (no session required) ----------
    if (p === '/api/auth/signup' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        try {
            const r = await auth.signup({ email: b.email, password: b.password, name: b.name });
            if (r.needsConfirmation) return json(res, 201, { ok: true, needsConfirmation: true, user: r.user });
            if (!r.session) throw Object.assign(new Error('Signup did not return a session'), { code: 500 });
            return json(res, 201, { ok: true, session: r.session });
        } catch (err) { return json(res, err.code || 400, { error: err.message }); }
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
        let b = {};
        try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        try {
            const r = await auth.login({ email: b.email, password: b.password });
            return json(res, 200, { ok: true, session: r.session });
        } catch (err) { return json(res, err.code || 400, { error: err.message }); }
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
        await auth.logout(bearerToken(req));
        return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
        const token = bearerToken(req);
        if (!token) return json(res, 401, { error: 'Authentication required' });
        try { return json(res, 200, { user: await auth.verify(token) }); }
        catch (err) { return json(res, 401, { error: err.message }); }
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
                const draft = { risk: Number(q.get('risk') || 0), session: q.get('session') || undefined, setup: q.get('setup') || undefined, emotion: q.get('emotion') || undefined, strategy_id: q.get('strategyId') || undefined };
                return json(res, 200, Core.preTradeCheck(accountId, draft));
            }
            if (p === '/api/risk') {
                const accountId = q.get('accountId') || 'acc-prop';
                return json(res, 200, {
                    snapshot: Core.riskState(accountId),
                    preTrade: Core.preTradeCheck(accountId, { risk: Core.riskState(accountId).recommendedMaxRisk }),
                    events: RiskEvents(Core, accountId)
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
            if (p === '/api/calendar') {
                const year = Number(q.get('year') || new Date().getFullYear());
                const month = Number(q.get('month') === undefined ? new Date().getMonth() : q.get('month'));
                return json(res, 200, Core.calendarMonth(q.get('accountId') || 'acc-prop', year, month));
            }
            if (p === '/api/reviews') {
                return json(res, 200, Core.reviews(q.get('accountId') || 'acc-prop', { period: q.get('period'), date: q.get('date') }));
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
                return json(res, 200, { ok: true, bundle });
            }
            if (p === '/api/ai/tilt') {
                const accountId = q.get('accountId') || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
                const ctx = accountId ? AI.buildContext(Core, accountId, 'all') : null;
                return json(res, 200, { ok: true, tilt: ctx ? AI.tiltAnalysis(ctx) : [] });
            }
            if ((m = p.match(/^\/api\/ai\/autopsy\/([^/]+)$/))) {
                const t = Core.Trades.find(x => x.id === m[1]);
                if (!t) return json(res, 404, { error: 'unknown trade: ' + m[1] });
                return json(res, 200, { ok: true, autopsy: AI.autopsy(Core, t) });
            }
        } catch (err) {
            console.error('[31trades] GET ' + p + ' failed: ' + err.message);
            return json(res, 400, { error: err.message });
        }
        return json(res, 404, { error: 'unknown endpoint: ' + p });
    }

    // ---------- write endpoints ----------
    let body = {};
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

    try {
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
        let m;
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
            return json(res, 200, Core.preTradeCheck(body.accountId, body.draft || body));
        }

        // ---- reviews ----
        if (p === '/api/reviews/complete') {
            const r = Core.completeReview(body.account_id, body.period || 'daily', body.note);
            uc.scheduleSave();
            return json(res, 200, r);
        }

        // ---- AI Mentor personal bot (grounded Q&A over the ledger) ----
        if (p === '/api/ai/ask') {
            if (!body.question || !String(body.question).trim()) return json(res, 400, { error: 'question required' });
            const accountId = body.accountId || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
            if (!accountId) return json(res, 200, { ok: true, answer: 'No account yet — create one in Strategy Lab and log trades; then I can coach you on your real data.', kpis: [], evidence: [], followUps: [] });
            const r = Bot.askBot(Core, accountId, body.question, { period: body.period || '30d' });
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

// Derived risk events (limit breach / high risk / loss breach) — same ledger
// + policy math as RiskService.state, listed as an event feed.
function RiskEvents(core, accountId) {
    const account = core.Accounts.find(a => a.id === accountId);
    if (!account) return [];
    const policy = core.activePolicy(accountId);
    const v = policy ? policy.values : {};
    const limRisk = v.maxDailyRisk || v.maxDailyLoss || 0;
    const limLoss = v.maxDailyLoss || 0;
    const days = {};
    core.Trades.filter(t => t.account_id === accountId).forEach(t => {
        const d = new Date(t.ts);
        const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        (days[k] = days[k] || []).push(t);
    });
    const events = [];
    Object.keys(days).sort().forEach(k => {
        const g = days[k];
        const risk = g.reduce((s, t) => s + (t.risk || 0), 0);
        const loss = Math.abs(g.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
        if (limRisk && risk > limRisk) events.push({ day: k, type: 'risk-breach', severity: 'critical', detail: 'Risk used $' + risk + ' > $' + limRisk + ' daily budget' });
        else if (limRisk && risk / limRisk >= 0.7) events.push({ day: k, type: 'high-risk', severity: 'warning', detail: 'Risk used $' + risk + ' (' + Math.round(risk / limRisk * 100) + '% of budget)' });
        if (limLoss && loss > limLoss) events.push({ day: k, type: 'loss-breach', severity: 'critical', detail: 'Realized loss $' + loss + ' > $' + limLoss + ' daily loss limit' });
    });
    return events.reverse().slice(0, 20);
}

/* ---------------------------------------------------------------------------
   5. STATIC SERVING — the app pages, unchanged, from the project root
   --------------------------------------------------------------------------- */
function serveStatic(res, urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath); } catch (e) { return json(res, 400, { error: 'bad path' }); }
    if (p === '/') p = '/index.html';

    const file = path.normalize(path.join(ROOT, p));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        return json(res, 403, { error: 'forbidden' });
    }

    fs.readFile(file, (err, data) => {
        if (err) return json(res, 404, { error: 'not found: ' + p });
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
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
    http.createServer((req, res) => {
        let url;
        try { url = new URL(req.url, 'http://127.0.0.1:' + PORT); } catch (e) { return json(res, 400, { error: 'bad url' }); }

        if (url.pathname.startsWith('/api/')) {
            handleApi(req, res, url).catch(err => json(res, 500, { error: err.message }));
            return;
        }
        serveStatic(res, url.pathname);
    // 0.0.0.0 — Railway (and other hosts) route external traffic to the
    // container this way; loopback clients (127.0.0.1) are still served.
    }).listen(PORT, '0.0.0.0', () => {
        console.log('31Trades backend listening on http://0.0.0.0:' + PORT + '  (db: ' + (db.status().configured ? 'Supabase Postgres' : 'data/db.json (SUPABASE_DB_URL not configured)') + ')');
    });
}).catch(err => {
    console.error('[31trades] boot failed: ' + err.message);
    process.exit(1);
});
