'use strict';

// ============================================================================
// 31TRADES — Postgres repository (server-only, NEVER served to the browser)
// ----------------------------------------------------------------------------
// Implements the shared core's storage seam ({ load, save }) over the tables
// created by db/migrations (001 + 002). The calculation services in
// src/core/index.js keep their exact signatures — they stay synchronous and
// in-memory; Postgres is where the canonical state lives between restarts.
//
//   · save(state)  rewrites the canonical tables in ONE transaction
//                   (TRUNCATE … CASCADE + INSERT in FK-safe order). This is a
//                   snapshot write — correct and simple at single-user scale;
//                   a row-level incremental layer can replace it later without
//                   touching any service.
//   · load()       reads every canonical table back into the exact shape the
//                   core's hydrate() expects.
//
// Not persisted (by design, this step): users/auth, reviews completion rows,
// tags, daily_snapshots — they arrive with their own features. EVENT_LOG maps
// into audit_log (best-effort) so the History tab survives restarts.
// ============================================================================

const { getPool } = require('./db.js');

// Placeholder owner for pre-auth rows (accounts/strategies require a user) and
// for anonymous mode (TRADEMIND_AUTH=off — dev/testing).
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';
const LOCAL_USER_EMAIL = 'local@31trades.local';

const TABLES = [
    'accounts', 'config_versions', 'strategies', 'rule_sets',
    'assignments', 'trades', 'trade_evaluations', 'violations', 'audit_log'
];

// table → stateToRows batch key
const ROWS_KEY = {
    accounts: 'accounts', config_versions: 'configVersions', strategies: 'strategies', rule_sets: 'ruleSets',
    assignments: 'assignments', trades: 'trades', trade_evaluations: 'tradeEvaluations',
    violations: 'violations', audit_log: 'auditLog'
};

// INSERT column order — also used by the tests to simulate pg row objects.
// user_id scopes every row to its owner (migration 003). accounts/strategies
// carried it from 001.
const TABLE_COLUMNS = {
    accounts: ['id', 'user_id', 'name', 'account_type', 'currency', 'starting_balance', 'style', 'status', 'note', 'current_equity'],
    config_versions: ['id', 'user_id', 'entity_type', 'entity_id', 'version', 'created_at', 'values', 'note'],
    strategies: ['id', 'user_id', 'name', 'description', 'color', 'status'],
    rule_sets: ['id', 'user_id', 'name', 'scope'],
    assignments: ['id', 'user_id', 'account_id', 'strategy_id', 'policy_version_id', 'strategy_version_id', 'active_from'],
    trades: ['id', 'user_id', 'account_id', 'strategy_id', 'config_version_id', 'strategy_version_id', 'ts', 'symbol', 'dir', 'setup', 'session', 'emotion', 'adherence', 'entry', 'exit', 'size', 'risk', 'pnl', 'r', 'stop', 'tp', 'note', 'reviewed', 'adherence_result', 'block_reason', 'evidence', 'created_at', 'updated_at'],
    trade_evaluations: ['trade_id', 'user_id', 'account_id', 'rule_id', 'rule_key', 'rule_label', 'rule_version', 'category', 'severity', 'expected', 'actual', 'state', 'explanation', 'evaluated_at'],
    violations: ['trade_id', 'user_id', 'account_id', 'rule_key', 'rule_label', 'rule_version', 'severity', 'expected', 'actual', 'explanation', 'pnl', 'r', 'review_state', 'ts', 'created_at'],
    audit_log: ['user_id', 'entity_type', 'entity_id', 'action', 'detail', 'new_value', 'created_at']
};

// Every table is scoped by user_id (load filters, save deletes per user).
const USER_SCOPED_TABLES = TABLES;   // all nine round-tripped tables

const v = x => (x === undefined ? null : x);   // undefined → SQL NULL
// pg returns NUMERIC columns as strings — coerce back to JS numbers on load.
const num = x => (x === null || x === undefined || x === '' ? null : Number(x));

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

async function ensureTables(pool) {
    const missing = [];
    for (const t of TABLES) {
        const r = await pool.query('SELECT to_regclass($1) AS rel', [t]);
        if (!r.rows[0].rel) missing.push(t);
    }
    if (missing.length) {
        throw new Error('Supabase tables missing (' + missing.join(', ') + ') — run: npm run db:migrate');
    }
}

async function ensureLocalUser(pool) {
    await pool.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (id) DO NOTHING',
        [LOCAL_USER_ID, LOCAL_USER_EMAIL, '!', 'Local']
    );
}

// Upsert the owner into public.users before their rows are inserted. Signed-in
// users live in auth.users (GoTrue); the public.users row is a lightweight
// mirror needed by the FKs. Password stays in GoTrue — '!' is a placeholder.
async function ensureUser(client, user) {
    const uid = (user && user.id) || LOCAL_USER_ID;
    await client.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (id) DO NOTHING',
        [uid, (user && user.email) || LOCAL_USER_EMAIL, '!', (user && (user.name || user.display_name)) || 'Trader']
    );
}

// ---------------------------------------------------------------------------
// MAPPING — canonical state → row batches (pure, unit-testable)
// ---------------------------------------------------------------------------

function stateToRows(state, userId) {
    const uid = userId || LOCAL_USER_ID;
    const rows = {
        accounts: [], configVersions: [], strategies: [], ruleSets: [],
        assignments: [], trades: [], tradeEvaluations: [], violations: [], auditLog: []
    };

    (state.Accounts || []).forEach(a => rows.accounts.push([
        v(a.id), uid, v(a.name), v(a.account_type), v(a.currency),
        v(a.starting_balance), v(a.style), v(a.status || 'Active'), v(a.note), v(a.current_equity)
    ]));

    (state.ConfigVersions || []).forEach(c => rows.configVersions.push([
        v(c.id), uid, v(c.entity_type), v(c.entity_id), v(c.version),
        c.created_at ? new Date(c.created_at) : new Date(),
        JSON.stringify(c.values || {}), v(c.note || '')
    ]));

    (state.StrategyMaster || []).forEach(s => rows.strategies.push([
        v(s.id), uid, v(s.name), v(s.desc), v(s.color), v(s.status || 'Active')
    ]));

    (state.RuleSetMaster || []).forEach(r => rows.ruleSets.push([
        v(r.id), uid, v(r.name), v(r.scope || 'Global')
    ]));

    (state.StrategyAssignments || []).forEach(a => rows.assignments.push([
        v(a.id), uid, v(a.account_id), v(a.strategy_id), v(a.policy_id), v(a.strategy_version_id),
        a.active_from ? new Date(a.active_from) : new Date()
    ]));

    (state.Trades || []).forEach(t => rows.trades.push([
        v(t.id), uid, v(t.account_id), v(t.strategy_id), v(t.config_version_id), v(t.strategy_version_id),
        new Date(t.ts), v(t.symbol), v(t.dir), v(t.setup), v(t.session), v(t.emotion), v(t.adherence),
        v(t.entry), v(t.exit), v(t.size), v(t.risk), v(t.pnl), v(t.r), v(t.stop), v(t.tp),
        v(t.note), v(!!t.reviewed), v(t.adherence_result), v(t.block_reason),
        JSON.stringify(t.evidence || []),
        t.created_at ? new Date(t.created_at) : new Date(t.ts),
        new Date()
    ]));

    (state.TradeEvaluations || []).forEach(e => rows.tradeEvaluations.push([
        v(e.tradeId), uid, v(e.account_id), v(e.ruleId), v(e.ruleKey), v(e.ruleLabel), v(e.ruleVersion),
        v(e.category), v(e.severity), v(e.expected), v(e.actual), v(e.state), v(e.explanation),
        e.evaluatedAt ? new Date(e.evaluatedAt) : new Date()
    ]));

    (state.Violations || []).forEach(x => rows.violations.push([
        v(x.tradeId), uid, v(x.account_id), v(x.ruleKey), v(x.ruleLabel), v(x.ruleVersion),
        v(x.severity), v(x.expected), v(x.actual), v(x.explanation),
        v(x.pnl), v(x.r), v(x.reviewState || 'open'),
        x.ts ? new Date(x.ts) : new Date(), x.createdAt ? new Date(x.createdAt) : new Date()
    ]));

    (state.EVENT_LOG || []).forEach(e => {
        const impact = e.impact ? JSON.stringify({ impact: e.impact }) : null;
        rows.auditLog.push([
            uid, v(e.entity || 'event'), 'event', v(e.what || 'change'),
            v(e.detail), impact, new Date()
        ]);
    });

    return rows;
}

// ---------------------------------------------------------------------------
// MAPPING — row batches → canonical state (pure, unit-testable)
// ---------------------------------------------------------------------------

function rowsToState(rows) {
    return {
        Accounts: (rows.accounts || []).map(r => ({
            id: r.id, name: r.name, account_type: r.account_type, currency: r.currency,
            starting_balance: num(r.starting_balance), style: r.style, status: r.status,
            note: r.note, current_equity: num(r.current_equity)
        })),
        ConfigVersions: (rows.configVersions || []).map(r => ({
            id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, version: r.version,
            created_at: r.created_at, values: r.values || {}, note: r.note || ''
        })),
        StrategyMaster: (rows.strategies || []).map(r => ({
            id: r.id, name: r.name, desc: r.description, color: r.color, status: r.status
        })),
        RuleSetMaster: (rows.ruleSets || []).map(r => ({ id: r.id, name: r.name, scope: r.scope })),
        StrategyAssignments: (rows.assignments || []).map(r => ({
            id: r.id, account_id: r.account_id, strategy_id: r.strategy_id,
            policy_id: r.policy_version_id, strategy_version_id: r.strategy_version_id,
            active_from: r.active_from
        })),
        Trades: (rows.trades || []).map(r => ({
            id: r.id, ts: r.ts, account_id: r.account_id, strategy_id: r.strategy_id,
            config_version_id: r.config_version_id, strategy_version_id: r.strategy_version_id,
            symbol: r.symbol, dir: r.dir, setup: r.setup, session: r.session,
            emotion: r.emotion, adherence: r.adherence,
            entry: num(r.entry), exit: num(r.exit), size: num(r.size),
            risk: num(r.risk), pnl: num(r.pnl), r: num(r.r),
            stop: num(r.stop), tp: num(r.tp), note: r.note, reviewed: !!r.reviewed,
            adherence_result: r.adherence_result, block_reason: r.block_reason,
            evidence: r.evidence || [], created_at: r.created_at
        })),
        TradeEvaluations: (rows.tradeEvaluations || []).map(r => ({
            id: r.id, tradeId: r.trade_id, account_id: r.account_id, ruleId: r.rule_id,
            ruleKey: r.rule_key, ruleLabel: r.rule_label, ruleVersion: r.rule_version,
            category: r.category, severity: r.severity, expected: r.expected, actual: r.actual,
            state: r.state, explanation: r.explanation, evaluatedAt: r.evaluated_at
        })),
        Violations: (rows.violations || []).map(r => ({
            id: r.id, tradeId: r.trade_id, account_id: r.account_id, ruleKey: r.rule_key,
            ruleLabel: r.rule_label, ruleVersion: r.rule_version, severity: r.severity,
            expected: r.expected, actual: r.actual, explanation: r.explanation,
            pnl: num(r.pnl), r: num(r.r), reviewState: r.review_state, ts: r.ts, createdAt: r.created_at
        })),
        EVENT_LOG: (rows.auditLog || []).map(r => ({
            entity: r.entity_type, what: r.action, detail: r.detail,
            at: (r.created_at ? new Date(r.created_at) : new Date()).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            }),
            impact: (r.new_value && r.new_value.impact) || ''
        }))
    };
}

// ---------------------------------------------------------------------------
// REPOSITORY — the storage seam
// ---------------------------------------------------------------------------

const PostgresRepository = {
    // Load ONLY this user's rows (user_id = $1).
    async load(userId) {
        const pool = getPool();
        if (!pool) throw new Error('Postgres not configured (SUPABASE_DB_URL missing)');
        await ensureTables(pool);
        const uid = userId || LOCAL_USER_ID;

        const q = async (table, orderBy) => {
            const r = await pool.query('SELECT * FROM ' + table + ' WHERE user_id = $1' + (orderBy ? ' ORDER BY ' + orderBy : ''), [uid]);
            return r.rows;
        };
        const rows = {
            accounts: await q('accounts', 'created_at, id'),
            configVersions: await q('config_versions', 'created_at, id'),
            strategies: await q('strategies', 'id'),
            ruleSets: await q('rule_sets', 'id'),
            assignments: await q('assignments', 'active_from, id'),
            trades: await q('trades', 'ts, id'),
            tradeEvaluations: await q('trade_evaluations', 'evaluated_at, id'),
            violations: await q('violations', 'created_at, id'),
            auditLog: await q('audit_log', 'created_at DESC')
        };
        return rowsToState(rows);
    },

    // Rewrite ONLY this user's rows in one transaction: delete their slice of
    // each table, then insert the new snapshot. Other users' rows are
    // untouched (no more global TRUNCATE — that would wipe everyone).
    async save(state, user) {
        const pool = getPool();
        if (!pool) throw new Error('Postgres not configured (SUPABASE_DB_URL missing)');
        await ensureTables(pool);
        const uid = (user && user.id) || LOCAL_USER_ID;

        const b = stateToRows(state, uid);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await ensureUser(client, user);

            // children first (FK-safe): trades/evaluations/violations reference
            // accounts/strategies/config_versions; assignments reference all three;
            // audit_log may reference config_versions via version_id.
            const deleteOrder = ['trade_evaluations', 'violations', 'trades', 'assignments', 'audit_log', 'config_versions', 'rule_sets', 'strategies', 'accounts'];
            for (const t of deleteOrder) {
                await client.query('DELETE FROM ' + t + ' WHERE user_id = $1', [uid]);
            }

            for (const t of TABLES) {
                await insertBatch(client, t, TABLE_COLUMNS[t], b[ROWS_KEY[t]]);
            }

            await client.query('COMMIT');
            const counts = {};
            Object.keys(b).forEach(k => { counts[k] = b[k].length; });
            return counts;
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (e) { /* connection may be gone */ }
            throw err;
        } finally {
            client.release();
        }
    }
};

// INSERT n rows in one parameterized statement.
async function insertBatch(client, table, columns, rows) {
    if (!rows.length) return;
    const colSql = columns.join(', ');
    const params = [];
    const tuples = rows.map(r => {
        const parts = [];
        r.forEach((val, i) => {
            params.push(val);
            parts.push('$' + params.length);
        });
        return '(' + parts.join(', ') + ')';
    });
    await client.query('INSERT INTO ' + table + ' (' + colSql + ') VALUES ' + tuples.join(', '), params);
}

module.exports = { PostgresRepository, stateToRows, rowsToState, LOCAL_USER_ID, TABLES, TABLE_COLUMNS, ROWS_KEY };
