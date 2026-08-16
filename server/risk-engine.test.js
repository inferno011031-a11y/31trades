'use strict';

// ============================================================================
// Risk engine tests — run the REAL core (src/core/index.js) with deterministic
// seeded ledgers. No DB, no network. Pins the exact risk contract every
// surface (Risk page, Dashboard, Journal, notifications) consumes.
// ============================================================================

const path = require('node:path');
const Notif = require('./notifications.js');

global.window = { SERVER_MODE: true };
require('../demo-trades.js');                       // deterministic demo generator
const createCore = require('../src/core/index.js');

let pass = 0, fail = 0;
function ok(cond, name) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name); }
}
function eq(actual, expected, name) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    ok(a === b, name + (a === b ? '' : (' — got ' + a + ', want ' + b)));
}
function throws(fn, name) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    ok(threw, name);
}

// ---- deterministic fixtures -------------------------------------------------

function fresh(limits) {
    const core = createCore({ demoTrades: global.window.DemoTrades });
    const id = 'acc-' + Math.random().toString(36).slice(2, 8);
    core.ConfigAPI.createAccount({
        name: 'Test Account', starting_balance: (limits && limits.balance) || 10000,
        riskPerTrade: (limits && limits.riskPerTrade) || 25,
        dailyRisk: (limits && limits.dailyRisk) || 100,
        dailyLoss: (limits && limits.dailyLoss) || 100,
        maxDD: (limits && limits.maxDD) || 500,
        maxTrades: (limits && limits.maxTrades) || 3,
        maxOpenRisk: (limits && limits.maxOpenRisk) || 50
    }, id);
    return { core, id };
}

function log(core, accId, over) {
    return core.TradeService.create(Object.assign({
        account_id: accId, symbol: 'EURUSD', dir: 'Long', setup: 'FVG', session: 'London',
        entry: 1.1000, exit: 1.1010, size: 0.1, risk: 25, pnl: 10,
        ts: new Date()
    }, over));
}

function serialize(core) {
    const cp = o => JSON.parse(JSON.stringify(o));
    return {
        Accounts: cp(core.Accounts), ConfigVersions: cp(core.ConfigVersions),
        StrategyAssignments: cp(core.StrategyAssignments), Trades: cp(core.Trades),
        StrategyMaster: cp(core.StrategyMaster), RuleSetMaster: cp(core.RuleSetMaster),
        TradeEvaluations: cp(core.TradeEvaluations), Violations: cp(core.Violations),
        EVENT_LOG: cp(core.getEventLog())
    };
}

// ---- 1 · SAFE -----------------------------------------------------------------
{
    console.log('risk-engine · SAFE state');
    const { core, id } = fresh();
    log(core, id, { risk: 25, pnl: 10 });
    const rs = core.riskState(id);
    eq(rs.status, 'NORMAL', 'fresh small trade → NORMAL');
    eq(rs.statusLabel, 'SAFE', 'label SAFE');
    eq(rs.riskUsed, 25, 'risk used 25');
    eq(rs.riskRemaining, 75, 'risk remaining 75 of 100');
}

// ---- 2 · CAUTION ---------------------------------------------------------------
{
    console.log('risk-engine · CAUTION state');
    const { core, id } = fresh();
    log(core, id, { risk: 30 });   // 30/100 = 30%
    log(core, id, { risk: 30 });   // 60/100 = 60% ≥ warn[0]=50
    const rs = core.riskState(id);
    eq(rs.status, 'CAUTION', '60% consumed → CAUTION');
    eq(rs.riskUsed, 60, 'risk used 60');
    eq(rs.riskRemaining, 40, 'risk remaining 40');
}

// ---- 3 · HIGH ------------------------------------------------------------------
{
    console.log('risk-engine · HIGH state');
    const { core, id } = fresh();
    log(core, id, { risk: 45 });   // 45%
    log(core, id, { risk: 45 });   // 90% ≥ warn[2]=90 → HIGH
    const rs = core.riskState(id);
    eq(rs.status, 'HIGH', '90% consumed → HIGH');
    eq(rs.statusLabel, 'HIGH RISK', 'label HIGH RISK');
}

// ---- 4 · LIMIT ------------------------------------------------------------------
{
    console.log('risk-engine · LIMIT breach');
    const { core, id } = fresh();
    log(core, id, { risk: 40 });
    log(core, id, { risk: 40 });
    log(core, id, { risk: 30 });   // 110 > 100 budget
    const rs = core.riskState(id);
    eq(rs.status, 'LIMIT', '110% consumed → LIMIT');
    eq(rs.statusLabel, 'LIMIT BREACHED', 'label LIMIT BREACHED');
    eq(rs.riskRemaining, 0, 'remaining clamped at 0');
}

// ---- 5/6 · daily risk consumed + remaining --------------------------------------
{
    console.log('risk-engine · daily risk consumed / remaining');
    const { core, id } = fresh({ dailyRisk: 100, dailyLoss: 100 });
    log(core, id, { risk: 25, pnl: 15 });
    log(core, id, { risk: 35, pnl: -20 });
    log(core, id, { risk: 10, pnl: 5 });
    const rs = core.riskState(id);
    eq(rs.riskUsed, 70, 'risk consumed = 25+35+10');
    eq(rs.riskRemaining, 30, 'risk remaining = 100-70');
}

// ---- 7 · daily loss --------------------------------------------------------------
{
    console.log('risk-engine · daily loss calculation');
    const { core, id } = fresh({ dailyRisk: 100, dailyLoss: 100 });
    log(core, id, { pnl: -40, risk: 25 });
    log(core, id, { pnl: -30, risk: 25 });
    log(core, id, { pnl: 20, risk: 25 });
    const rs = core.riskState(id);
    eq(rs.lossUsed, 70, 'loss used = abs(-40 + -30) = 70');
    eq(rs.lossRemaining, 30, 'loss remaining = 100-70');
}

// ---- 8 · drawdown ---------------------------------------------------------------
{
    console.log('risk-engine · drawdown');
    const { core, id } = fresh();
    log(core, id, { pnl: -300, risk: 25, ts: new Date(Date.now() - 2 * 864e5) });
    log(core, id, { pnl: 100, risk: 25, ts: new Date(Date.now() - 1 * 864e5) });
    log(core, id, { pnl: -250, risk: 25 });   // today
    const rs = core.riskState(id);
    eq(rs.currentDrawdown, 450, 'current drawdown = 10000 - 9550');
    eq(rs.maxDrawdown, 450, 'max historical drawdown = 450');
    eq(rs.drawdownRemaining, 50, 'buffer = 500 - 450');
}

// ---- 9/10 · max trade risk + open-risk cap ----------------------------------------
{
    console.log('risk-engine · maximum allowed risk');
    const { core, id } = fresh({ riskPerTrade: 25, dailyRisk: 100, dailyLoss: 100, maxDD: 500, maxOpenRisk: 50 });
    const rs0 = core.riskState(id);
    eq(rs0.maxAllowedRisk, 25, 'min(25,100,100,500,50) = 25');
    // consume daily risk so the remaining budget binds
    log(core, id, { risk: 90, pnl: -30 });
    const rs1 = core.riskState(id);
    eq(rs1.riskRemaining, 10, 'risk remaining 10 after 90');
    eq(rs1.maxAllowedRisk, 10, 'max allowed now = remaining 10');
    // open-risk cap binds when it is the smallest
    const b = fresh({ riskPerTrade: 25, dailyRisk: 100, dailyLoss: 100, maxDD: 500, maxOpenRisk: 8 });
    eq(b.core.riskState(b.id).maxAllowedRisk, 8, 'max open risk 8 binds max allowed');
    eq(b.core.riskState(b.id).maxOpenRiskLimit, 8, 'snapshot exposes maxOpenRiskLimit');
}

// ---- 11 · pre-trade CLEAR ----------------------------------------------------------
{
    console.log('risk-engine · pre-trade CLEAR');
    const { core, id } = fresh();
    const r = core.preTradeCheck(id, {
        risk: 25, entry: 1.1000, stop: 1.0990, tp: 1.1030,  // rr = 3.0
        evidence: { screenshot: 'https://img/x.png' }, note: 'plan', reviewed: true
    });
    eq(r.status, 'CLEAR', 'complete draft → CLEAR');
    eq(r.state, 'CLEAR', 'state alias CLEAR');
    eq(r.riskRequested, 25, 'riskRequested 25');
    eq(r.maxAllowedRisk, 25, 'maxAllowedRisk 25');
    ok(Array.isArray(r.warnings) && r.warnings.length === 0, 'no warnings');
    ok(Array.isArray(r.violations) && r.violations.length === 0, 'no violations');
    ok(Array.isArray(r.blocks) && r.blocks.length === 0, 'no blocks');
}

// ---- 12 · pre-trade CAUTION --------------------------------------------------------
{
    console.log('risk-engine · pre-trade CAUTION');
    const { core, id } = fresh();
    const r = core.preTradeCheck(id, { risk: 25 });   // minRR + evidence soft fails
    eq(r.status, 'CAUTION', 'soft-only fails → CAUTION');
    ok(r.warnings.length > 0, 'warnings populated');
    eq(r.violations.length, 0, 'no hard violations');
}

// ---- 13 · pre-trade VIOLATION ------------------------------------------------------
{
    console.log('risk-engine · pre-trade VIOLATION');
    const { core, id } = fresh();
    const r = core.preTradeCheck(id, { risk: 25, stop: '' });   // stopRequired Hard fails
    eq(r.status, 'VIOLATION', 'hard fail (stop) → VIOLATION');
    ok(r.violations.some(v => /stop/i.test(v)), 'violation mentions stop loss');
    eq(r.blocks.length, 0, 'no blocks (stop is not a blocking key)');
}

// ---- 14 · pre-trade BLOCKED --------------------------------------------------------
{
    console.log('risk-engine · pre-trade BLOCKED');
    const { core, id } = fresh();
    const r = core.preTradeCheck(id, { risk: 120 });
    eq(r.status, 'BLOCKED', 'risk 120 vs 100 budget → BLOCKED');
    ok(r.blocks.length > 0, 'blocks populated');
    ok(r.blocking_rules.length > 0, 'blocking_rules populated');
    ok(r.blocks.some(b => /Daily risk budget/.test(b)), 'block reason names the budget');
}

// ---- 15 · account isolation --------------------------------------------------------
{
    console.log('risk-engine · account isolation');
    const a = fresh();
    const b = fresh();
    log(a.core, a.id, { risk: 80, pnl: -50 });
    // the other core cannot see A's trades
    eq(b.core.riskState(b.id).riskUsed, 0, 'other core sees zero risk');
    // foreign ids throw in both directions
    throws(() => a.core.riskState(b.id), 'A cannot read B account');
    throws(() => b.core.riskState('acc-does-not-exist'), 'unknown account throws');
}

// ---- 16 · policy update ------------------------------------------------------------
{
    console.log('risk-engine · policy update (immutable versions)');
    const { core, id } = fresh();
    eq(core.ConfigAPI.getVersionChain(id).length, 1, 'one version before edit');
    const v2 = core.ConfigAPI.updateAccountLimits(id, { riskPerTrade: 50, maxDailyRisk: 200 });
    eq(core.ConfigAPI.getVersionChain(id).length, 2, 'edit creates a second immutable version');
    eq(core.activePolicy(id).values.riskPerTrade, 50, 'active policy reads new limit');
    eq(core.activePolicy(id).id, v2.id, 'assignment re-pointed to new version');
}

// ---- 17 · historical policy/version preservation -------------------------------------
{
    console.log('risk-engine · historical version preservation');
    const { core, id } = fresh({ riskPerTrade: 25, dailyRisk: 100, dailyLoss: 100 });
    const t1 = log(core, id, { risk: 25, pnl: 10 });
    const v1 = t1.config_version_id;
    core.ConfigAPI.updateAccountLimits(id, { riskPerTrade: 50, maxDailyRisk: 200 });
    // old trade keeps the version it was evaluated under
    eq(t1.config_version_id, v1, 'old trade keeps config_version_id v1');
    const oldEvals = core.TradeService.evaluationsFor(t1.id);
    const oldPerTrade = oldEvals.find(e => e.ruleKey === 'riskPerTrade');
    eq(oldPerTrade.expected, '$25', 'old trade still evaluated at $25 limit');
    // a new trade picks up v2
    const t2 = log(core, id, { risk: 25, pnl: 10 });
    eq(t2.config_version_id === v1, false, 'new trade uses a different version');
    const newEvals = core.TradeService.evaluationsFor(t2.id);
    eq(newEvals.find(e => e.ruleKey === 'riskPerTrade').expected, '$50', 'new trade evaluated at $50 limit');
}

// ---- 18 · risk notification triggering -----------------------------------------------
{
    console.log('risk-engine · risk notifications trigger');
    const { core, id } = fresh({ dailyRisk: 100, dailyLoss: 80, maxDD: 500 });
    log(core, id, { risk: 40, pnl: -30 });
    log(core, id, { risk: 40, pnl: -30 });
    log(core, id, { risk: 30, pnl: -30 });   // risk 110 > 100 · loss 90 > 80 → LIMIT
    eq(core.riskState(id).status, 'LIMIT', 'state is LIMIT');
    const n1 = Notif.buildNotifications(core, id, {});
    const riskIds = n1.filter(n => n.cat === 'Risk').map(n => n.id);
    ok(riskIds.includes('risk-limit'), 'risk-limit notification fires');
    ok(riskIds.includes('risk-loss-limit'), 'risk-loss-limit notification fires');
    // risk events derive from the same canonical state (section 7)
    const evs = core.riskEvents(id);
    ok(evs.some(e => e.type === 'risk-breach'), 'risk-breach event derived');
    ok(evs.some(e => e.type === 'loss-breach'), 'loss-breach event derived');
    ok(evs.every(e => e.trade_ids || e.trade_id), 'events carry trade deep-links');
}

// ---- 19 · notification stability -----------------------------------------------------
{
    console.log('risk-engine · notification id stability');
    const { core, id } = fresh({ dailyRisk: 100, dailyLoss: 100 });
    log(core, id, { risk: 95, pnl: -40 });   // 95% ≥ warn[2]=90 → HIGH
    const ids1 = Notif.buildNotifications(core, id, {}).filter(n => n.cat === 'Risk').map(n => n.id);
    const ids2 = Notif.buildNotifications(core, id, {}).filter(n => n.cat === 'Risk').map(n => n.id);
    eq(ids1.sort(), ids2.sort(), 'risk ids identical across derivations (no duplication)');
    ok(ids1.includes('risk-high'), 'risk-high present in HIGH state');
}

// ---- 20 · persistence / reload -------------------------------------------------------
{
    console.log('risk-engine · persistence round-trip');
    const { core, id } = fresh({ dailyRisk: 100, dailyLoss: 100 });
    log(core, id, { risk: 60, pnl: -25 });
    log(core, id, { risk: 30, pnl: 15 });
    const before = core.riskState(id);
    const snap = serialize(core);
    const core2 = createCore({ demoTrades: global.window.DemoTrades });
    core2.hydrate(snap);
    const after = core2.riskState(id);
    eq(after.riskUsed, before.riskUsed, 'riskUsed survives reload');
    eq(after.riskRemaining, before.riskRemaining, 'riskRemaining survives reload');
    eq(after.status, before.status, 'status survives reload');
    eq(after.currentDrawdown, before.currentDrawdown, 'drawdown survives reload');
    eq(after.policyVersion, before.policyVersion, 'policy version survives reload');
}

// ---- summary -------------------------------------------------------------------------
console.log('\n' + (fail ? 'FAILED: ' : 'ALL PASS: ') + pass + ' checks, ' + fail + ' failures');
process.exit(fail ? 1 : 0);
