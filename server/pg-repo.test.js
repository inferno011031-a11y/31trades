'use strict';

// ============================================================================
// 31TRADES — Postgres repository tests (no database required)
// ----------------------------------------------------------------------------
//  1. Builds a realistic canonical state with the REAL shared core.
//  2. stateToRows → rowsToState round-trip: counts + representative fields.
//  3. Cross-checks every INSERT column against the migration's CREATE TABLE
//     columns, so a schema drift fails here instead of on a live DB.
//
// Run:  npm test
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { stateToRows, rowsToState, TABLES, TABLE_COLUMNS, ROWS_KEY } = require('./pg-repo.js');

// Numeric columns — pg returns these as STRINGS (NUMERIC type), which is a real
// source of NaN bugs if not coerced back to numbers on load.
const NUMERIC_COLS = {
    accounts: ['starting_balance', 'current_equity'],
    trades: ['entry', 'exit', 'size', 'risk', 'pnl', 'r', 'stop', 'tp'],
    violations: ['pnl', 'r']
};

// Convert array batches to row objects exactly as the pg driver returns them
// (jsonb columns parsed to JS objects, NUMERIC columns as strings).
function toRowObjects(rows) {
    const out = {};
    Object.keys(rows).forEach(k => {
        out[k] = rows[k].map(vals => {
            const o = {};
            const table = Object.keys(ROWS_KEY).find(t => ROWS_KEY[t] === k);
            TABLE_COLUMNS[table].forEach((c, i) => {
                let val = vals[i];
                if (val && typeof val === 'string' && ['values', 'evidence', 'new_value'].indexOf(c) !== -1) {
                    try { val = JSON.parse(val); } catch (e) { /* keep string */ }
                }
                if (val !== null && val !== undefined && (NUMERIC_COLS[table] || []).indexOf(c) !== -1) {
                    val = String(val);   // pg NUMERIC → string
                }
                o[c] = val;
            });
            return o;
        });
    });
    return out;
}

let failures = 0;
function check(label, cond, extra) {
    if (cond) {
        console.log('  ok   ' + label);
    } else {
        failures++;
        console.log('  FAIL ' + label + (extra ? '  — ' + extra : ''));
    }
}

// ---- 1. build a realistic state with the real core ---------------------------
global.window = { SERVER_MODE: true };
require('../demo-trades.js');
const createCore = require('../src/core/index.js');
const Core = createCore({ demoTrades: global.window.DemoTrades });
Core.seedDemoAccount(12);
Core.ConfigAPI.createAccount({ name: 'Second', start: 2000, dailyLoss: 60, maxDD: 300, risk: 15 }, 'acc-2');
Core.ConfigAPI.createStrategy({ name: 'Sweep', desc: '', color: '#0EA5E9', markets: 'FX', sessions: ['London'], setup: 'Sweep', riskPerTrade: '1%', minRR: 1.5, stopRequired: true, entry: '', exit: '', behavior: [], evidence: [], tags: [] }, 'strat-sweep');
Core.logTradePipeline({ account_id: 'acc-prop', strategy_id: 'strat-lfvg', symbol: 'XAUUSD', dir: 'Short', entry: 2350, exit: 2347.5, size: 0.5, risk: 25, pnl: 125, setup: 'MSS + FVG', session: 'London', emotion: 'Calm', strategy: 'London FVG', adherence: 'followed' });
Core.TradeService.update(Core.Trades[0].id, { risk: 30, note: 'edited' });
Core.ConfigAPI.recordManualChange('test manual change');
const state = Core.serializeState();

console.log('state built — ' + state.Trades.length + ' trades, ' + state.Accounts.length + ' accounts, ' +
    state.ConfigVersions.length + ' config versions, ' + state.TradeEvaluations.length + ' evaluations, ' +
    state.Violations.length + ' violations, ' + state.EVENT_LOG.length + ' events');

// ---- 2. migration column consistency -----------------------------------------
console.log('\n[2] migration column consistency');
const migDir = path.join(__dirname, '..', 'db', 'migrations');
const migText = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
    .map(f => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');

const tableCols = {};
const re = /CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
let m;
while ((m = re.exec(migText))) {
    const cols = [];
    m[2].split('\n').forEach(line => {
        const t = line.trim();
        if (!t || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|REFERENCES|CREATE|ALTER|UNIQUE)/.test(t)) return;
        const name = t.split(/\s+/)[0].replace(/[",]/g, '');
        if (name && t.startsWith(name + ' ')) cols.push(name);
    });
    tableCols[m[1]] = cols;
}
// migration 003 adds user_id via ALTER TABLE … ADD COLUMN — fold those in too.
const reAlter = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/g;
while ((m = reAlter.exec(migText))) {
    (tableCols[m[1]] = tableCols[m[1]] || []).push(m[2]);
}
check('parsed ' + Object.keys(tableCols).length + ' tables from migrations', Object.keys(tableCols).length >= 10, JSON.stringify(Object.keys(tableCols)));
check('has assignments (002 relaxed)', !!tableCols.assignments);
check('has daily_snapshots', !!tableCols.daily_snapshots);

// Single source of truth for INSERT columns is the repo's own TABLE_COLUMNS.
Object.keys(TABLE_COLUMNS).forEach(table => {
    const unknown = TABLE_COLUMNS[table].filter(c => !(tableCols[table] || []).includes(c));
    check(table + ': every INSERT column exists in migration', unknown.length === 0,
        'unknown columns: ' + unknown.join(', '));
});
check('all repo tables exist in migrations', TABLES.every(t => tableCols[t]), TABLES.filter(t => !tableCols[t]).join(','));

// ---- 3. stateToRows counts ---------------------------------------------------
console.log('\n[3] stateToRows counts');
const TEST_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const rows = stateToRows(state, TEST_USER);
const rowObjects = toRowObjects(rows);   // simulate pg SELECT rows
check('every row batch is scoped to the user', ['accounts', 'configVersions', 'strategies', 'ruleSets', 'assignments', 'trades', 'tradeEvaluations', 'violations', 'auditLog']
    .every(k => rows[k].every(r => r[1] === TEST_USER || r[0] === TEST_USER)), 'user_id column populated');
check('accounts', rows.accounts.length === state.Accounts.length, rows.accounts.length + ' vs ' + state.Accounts.length);
check('configVersions', rows.configVersions.length === state.ConfigVersions.length);
check('strategies', rows.strategies.length === state.StrategyMaster.length);
check('ruleSets', rows.ruleSets.length === state.RuleSetMaster.length);
check('assignments', rows.assignments.length === state.StrategyAssignments.length);
check('trades', rows.trades.length === state.Trades.length);
check('tradeEvaluations', rows.tradeEvaluations.length === state.TradeEvaluations.length);
check('violations', rows.violations.length === state.Violations.length);
check('auditLog (EVENT_LOG)', rows.auditLog.length === state.EVENT_LOG.length);

// ---- 4. round-trip field fidelity --------------------------------------------
console.log('\n[4] rowsToState round-trip');
const S2 = rowsToState(rowObjects);
check('same table counts', S2.Trades.length === state.Trades.length && S2.Accounts.length === state.Accounts.length);

const t0 = state.Trades[0], t1 = S2.Trades.find(x => x.id === t0.id);
check('trade id', !!t1);
check('trade symbol/dir', t1 && t1.symbol === t0.symbol && t1.dir === t0.dir);
check('trade risk/pnl', t1 && Number(t1.risk) === Number(t0.risk) && Number(t1.pnl) === Number(t0.pnl));
check('trade numerics are numbers (pg string coercion)', t1 && typeof t1.risk === 'number' && typeof t1.pnl === 'number' && typeof t1.entry === 'number');
check('account equity is a number', S2.Accounts[0] && typeof S2.Accounts[0].current_equity === 'number');
check('trade versions frozen', t1 && t1.config_version_id === t0.config_version_id && t1.strategy_version_id === t0.strategy_version_id);
check('trade ts preserved', t1 && new Date(t1.ts).getTime() === new Date(t0.ts).getTime());
check('trade reviewed bool', t1 && !!t1.reviewed === !!t0.reviewed);

const c0 = state.ConfigVersions.find(c => c.entity_type === 'RiskPolicy');
const c1 = S2.ConfigVersions.find(c => c.id === c0.id);
check('config values preserved', c1 && JSON.stringify(c1.values) === JSON.stringify(c0.values));

const a0 = state.StrategyAssignments[0], a1 = S2.StrategyAssignments.find(a => a.id === a0.id);
check('assignment policy mapping (policy_version_id → policy_id)', a1 && a1.policy_id === a0.policy_id && a1.account_id === a0.account_id);

const e0 = state.TradeEvaluations[0], e1 = S2.TradeEvaluations.find(e => e.ruleKey === e0.ruleKey && e.tradeId === e0.tradeId);
check('evaluation rule fields', e1 && e1.state === e0.state && e1.severity === e0.severity);

const v0 = state.Violations[0], v1 = S2.Violations.find(v => v.tradeId === v0.tradeId && v.ruleKey === v0.ruleKey);
check('violation fields', v1 && v1.reviewState === v0.reviewState && Number(v1.pnl) === Number(v0.pnl));
check('violation pnl is a number', v1 && typeof v1.pnl === 'number');

const lg0 = state.EVENT_LOG[0], lg1 = S2.EVENT_LOG.find(e => e.detail === lg0.detail);
check('audit → event log (entity/what/detail)', lg1 && lg1.entity === lg0.entity && lg1.what === lg0.what && lg1.detail === lg0.detail);

// ---- summary -----------------------------------------------------------------
console.log('');
if (failures) {
    console.log('RESULT: ' + failures + ' check(s) FAILED');
    process.exit(1);
}
console.log('RESULT: all checks passed');
process.exit(0);
