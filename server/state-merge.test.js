'use strict';

// ============================================================================
// 31TRADES — state reconciliation tests (deterministic — no network)
// ----------------------------------------------------------------------------
// Run:  node server/state-merge.test.js
//
// The contract: a client sync must never lose server data, and must never lose
// genuine offline work either. Every case below is a way one of those two could
// break — including the exact regression that reverted a real user's note.
// ============================================================================

const M = require('../src/merge.js');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra === undefined ? '' : extra)));
    if (!cond) failures++;
}

const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-20T11:00:00.000Z';
const T3 = '2026-09-20T12:00:00.000Z';

const trade = (over) => Object.assign({
    id: 'txn-1', ts: '2026-09-17T16:35:00.000Z', symbol: 'EURUSD', dir: 'Long',
    pnl: 100, risk: 40, r: 2.5, note: '', updated_at: T1, created_at: T1
}, over || {});

const state = (over) => Object.assign({
    Accounts: [], ConfigVersions: [], StrategyAssignments: [], Trades: [],
    StrategyMaster: [], RuleSetMaster: [], TradeEvaluations: [], Violations: [],
    EVENT_LOG: [], selectedAccountId: null
}, over || {});

// ---- 1. the real incident --------------------------------------------------
// A stale browser snapshot (note empty, older stamp) must NOT revert the note the
// server has since written. This is the exact data-loss case.
{
    const server = state({ Trades: [trade({ note: 'voice note about size and confluence', updated_at: T2 })] });
    const local = state({ Trades: [trade({ note: '', updated_at: T1 })] });
    const plan = M.mergeStates({ server, local });
    check('stale client cannot clear a newer server note',
        plan.merged.Trades[0].note === 'voice note about size and confluence', JSON.stringify(plan.merged.Trades[0].note));
    check('nothing is pushed when the client is entirely stale', plan.push.length === 0, plan.push.length);
    check('decision is adopt', plan.decision === 'adopted-server', plan.decision);
    check('server record survives the merge', M.mergedCoversServer(plan, server));
}
// Same shape, but with NO stamps at all (legacy rows) — still server wins.
{
    const server = state({ Trades: [trade({ note: 'server note', updated_at: undefined, created_at: undefined })] });
    const local = state({ Trades: [trade({ note: '', updated_at: undefined, created_at: undefined })] });
    const plan = M.mergeStates({ server, local });
    check('unstamped conflict resolves to the server', plan.merged.Trades[0].note === 'server note',
        JSON.stringify(plan.merged.Trades[0].note));
    check('unstamped conflict pushes nothing', plan.push.length === 0, plan.push.length);
}

// ---- 2. genuine offline work still wins ------------------------------------
{
    const server = state({ Trades: [trade({ note: 'old', updated_at: T1 })] });
    const local = state({ Trades: [trade({ note: 'edited offline', updated_at: T3 })] });
    const plan = M.mergeStates({ server, local });
    check('a strictly newer local edit wins', plan.merged.Trades[0].note === 'edited offline', plan.merged.Trades[0].note);
    check('and is pushed', plan.push.length === 1 && plan.push[0].reason === 'local-newer', JSON.stringify(plan.push));
}
{
    const server = state({ Trades: [trade({ id: 'txn-1' })] });
    const local = state({ Trades: [trade({ id: 'txn-1' }), trade({ id: 'txn-2', note: 'logged while offline', updated_at: T3 })] });
    const plan = M.mergeStates({ server, local });
    check('a trade logged offline is kept and pushed', plan.merged.Trades.length === 2 && plan.push.length === 1,
        plan.merged.Trades.length + '/' + plan.push.length);
    check('the offline trade keeps its content',
        plan.merged.Trades.find(t => t.id === 'txn-2').note === 'logged while offline');
}

// ---- 3. the count heuristic is gone ----------------------------------------
// Local having MORE trades than the server must not, by itself, push anything.
{
    const server = state({ Trades: [trade({ id: 'txn-1', note: 'server', updated_at: T2 })] });
    const local = state({ Trades: [
        trade({ id: 'txn-1', note: 'stale local', updated_at: T1 }),
        trade({ id: 'txn-2', updated_at: T1 }),
        trade({ id: 'txn-3', updated_at: T1 }),
        trade({ id: 'txn-4', updated_at: T1 })
    ] });
    const plan = M.mergeStates({ server, local });
    const pushedIds = plan.push.map(p => p.id);
    check('a larger local count does not re-push existing records',
        pushedIds.indexOf('txn-1') === -1, JSON.stringify(pushedIds));
    check('but records the server never saw are still pushed',
        pushedIds.indexOf('txn-2') !== -1 && pushedIds.indexOf('txn-4') !== -1, JSON.stringify(pushedIds));
    check('the server copy of the conflicting trade is the one kept',
        plan.merged.Trades.find(t => t.id === 'txn-1').note === 'server');
}

// ---- 4. server-only data is never dropped ----------------------------------
{
    const server = state({
        Accounts: [{ id: 'acc-1', name: 'Prop', updated_at: T2 }],
        Trades: [trade({ id: 'txn-1' }), trade({ id: 'txn-9', symbol: 'GBPUSD' })],
        StrategyMaster: [{ id: 'str-1', name: 'Sweep' }],
        EVENT_LOG: [{ entity: 'Account · Prop', what: 'Created', detail: 'x', at: 'Aug 1' }]
    });
    const local = state({ Trades: [trade({ id: 'txn-1' })] });
    const plan = M.mergeStates({ server, local });
    check('a trade only the server has is preserved',
        plan.merged.Trades.some(t => t.id === 'txn-9'), JSON.stringify(plan.merged.Trades.map(t => t.id)));
    check('an account only the server has is preserved', plan.merged.Accounts.length === 1);
    check('a strategy only the server has is preserved', plan.merged.StrategyMaster.length === 1);
    check('audit entries only the server has are preserved', plan.merged.EVENT_LOG.length === 1);
    check('merged covers every server record', M.mergedCoversServer(plan, server));
    check('nothing new to push', plan.push.length === 0, JSON.stringify(plan.push));
}

// ---- 5. first run: nothing on the server -----------------------------------
{
    const local = state({ Trades: [trade({ id: 'a' }), trade({ id: 'b' })], Accounts: [{ id: 'acc-1' }] });
    const plan = M.mergeStates({ server: state({}), local });
    check('an empty server takes the local state', plan.merged.Trades.length === 2 && plan.merged.Accounts.length === 1);
    check('first run pushes everything it has', plan.push.length === 3, plan.push.length);
    check('first run is labelled', plan.decision === 'initial-push', plan.decision);
}
// A brand-new browser (no local data) adopts the server untouched.
{
    const server = state({ Trades: [trade({ id: 'a' })], Accounts: [{ id: 'acc-1' }] });
    const plan = M.mergeStates({ server, local: state({}) });
    check('an empty client adopts the server outright',
        plan.merged.Trades.length === 1 && plan.merged.Accounts.length === 1 && plan.push.length === 0);
}

// ---- 6. accounts / configs follow the same rule ----------------------------
{
    const server = state({
        Accounts: [{ id: 'acc-1', name: 'Old', updated_at: T1 }],
        StrategyMaster: [{ id: 'str-1', name: 'Old strat', updated_at: T1 }],
        StrategyAssignments: [{ id: 'asg-1', account_id: 'acc-1', strategy_id: 'str-1', active_from: T1 }]
    });
    const local = state({
        Accounts: [{ id: 'acc-1', name: 'Renamed offline', updated_at: T3 }],
        StrategyMaster: [{ id: 'str-1', name: 'Old strat', updated_at: T1 }],
        StrategyAssignments: [{ id: 'asg-1', account_id: 'acc-1', strategy_id: 'str-1', active_from: T2 }]
    });
    const plan = M.mergeStates({ server, local });
    check('a newer account rename wins', plan.merged.Accounts[0].name === 'Renamed offline', plan.merged.Accounts[0].name);
    check('an untouched strategy follows the server', plan.merged.StrategyMaster[0].name === 'Old strat');
    check('an assignment with no updated_at falls back to active_from (newer wins)',
        plan.merged.StrategyAssignments[0].active_from === T2, plan.merged.StrategyAssignments[0].active_from);
    check('only the genuinely newer records are pushed',
        plan.push.length === 2 && plan.push.every(p => p.reason === 'local-newer'), JSON.stringify(plan.push));
}

// ---- 7. append-only audit log ---------------------------------------------
{
    const server = state({ EVENT_LOG: [{ entity: 'Trade · X', what: 'Edited', detail: 'a', at: '1' }] });
    const local = state({ EVENT_LOG: [
        { entity: 'Trade · X', what: 'Edited', detail: 'a', at: '1' },     // duplicate
        { entity: 'Trade · Y', what: 'Logged', detail: 'b', at: '2' }      // local-only
    ] });
    const plan = M.mergeStates({ server, local });
    check('audit log is unioned without duplicates', plan.merged.EVENT_LOG.length === 2, plan.merged.EVENT_LOG.length);
    check('local-only audit entries are pushed', plan.push.length === 1 && plan.push[0].store === 'EVENT_LOG',
        JSON.stringify(plan.push));
    check('merged covers the server log', M.mergedCoversServer(plan, server));
}

// ---- 8. idempotence & shape ------------------------------------------------
{
    const server = state({ Trades: [trade({ id: 'txn-1', note: 'n', updated_at: T2 })] , Accounts: [{ id: 'acc-1', updated_at: T1 }] });
    const plan1 = M.mergeStates({ server, local: server });
    check('identical states push nothing', plan1.push.length === 0, plan1.push.length);
    check('identical states report the overlap', plan1.stats.serverKept === 2, JSON.stringify(plan1.stats));
    // merging the merged result again is stable
    const plan2 = M.mergeStates({ server, local: plan1.merged });
    check('re-merging the merged state is stable', plan2.push.length === 0, JSON.stringify(plan2.push));
    check('no store key is lost in the merge',
        M.STATE_KEYS.every(k => Array.isArray(plan1.merged[k])), Object.keys(plan1.merged).join(','));
}
// Local-only selection survives; a stale selection pointing at a server record yields the server's.
{
    const server = state({ Accounts: [{ id: 'acc-1' }, { id: 'acc-2' }], selectedAccountId: 'acc-2' });
    const local = state({ Accounts: [{ id: 'acc-1' }, { id: 'acc-2' }], selectedAccountId: 'acc-1' });
    check('the server account selection wins when it still exists',
        M.mergeStates({ server, local }).merged.selectedAccountId === 'acc-2');
    const localOnly = state({ Accounts: [{ id: 'acc-9' }], selectedAccountId: 'acc-9' });
    check('a local-only account selection is kept',
        M.mergeStates({ server: state({ Accounts: [{ id: 'acc-1' }] }), local: localOnly }).merged.selectedAccountId === 'acc-9');
}

// ---- 9. stamp helpers ------------------------------------------------------
check('stampOf prefers updated_at', M.stampOf({ updated_at: T2, created_at: T1 }, ['updated_at', 'created_at']) === new Date(T2).getTime());
check('stampOf falls back to created_at', M.stampOf({ created_at: T1 }, ['updated_at', 'created_at']) === new Date(T1).getTime());
check('stampOf rejects nonsense', isNaN(M.stampOf({ updated_at: 'not-a-date' }, ['updated_at'])));
check('stampOf of nothing is NaN', isNaN(M.stampOf(null, ['updated_at'])) && isNaN(M.stampOf({}, [])));
check('equal stamps are not "local newer"', M.isLocalNewer({ updated_at: T2 }, { updated_at: T2 }, ['updated_at']) === false);
check('missing local stamp is not "local newer"', M.isLocalNewer({}, { updated_at: T2 }, ['updated_at']) === false);
check('missing server stamp is not "local newer"', M.isLocalNewer({ updated_at: T2 }, {}, ['updated_at']) === false);
check('hasData is false for an empty state', M.hasData(state({})) === false);
check('hasData sees a single record', M.hasData(state({ Trades: [{ id: 'x' }] })) === true);

// ---- 10. stamping this client's own edits -----------------------------------
// A merge can only protect the server if the client can PROVE it edited something.
// The shared core never writes updated_at, so the browser derives the stamps by
// diffing against the last snapshot it held (see stampChanged in src/merge.js).
{
    const previous = state({ Trades: [trade({ id: 't1', note: 'a', updated_at: T1 }), trade({ id: 't2', note: 'b', updated_at: undefined })] });
    const next = state({ Trades: [trade({ id: 't1', note: 'a' }), trade({ id: 't2', note: 'b', updated_at: undefined })] });
    const r = M.stampChanged({ previous, next, now: T3 });
    check('unchanged content keeps its durable stamp', r.state.Trades[0].updated_at === T1, r.state.Trades[0].updated_at);
    check('unchanged and unstamped stays unstamped', r.state.Trades[1].updated_at === undefined, r.state.Trades[1].updated_at);
    check('nothing unchanged is reported as edited', r.stamped.length === 0, JSON.stringify(r.stamped));
}
// The in-memory copy has no stamp (the core never writes one) — content is equal,
// so the durable stamp must be carried across, or every adopted record would look
// stale forever and the server would win every time.
{
    const previous = state({ Trades: [trade({ id: 't1', note: 'a', updated_at: T1 })] });
    const next = state({ Trades: [trade({ id: 't1', note: 'a' })] });
    const r = M.stampChanged({ previous, next, now: T3 });
    check('a durable stamp survives the in-memory copy lacking it', r.state.Trades[0].updated_at === T1, r.state.Trades[0].updated_at);
    check('carrying a stamp is not reported as an edit', r.stamped.length === 0);
}
{
    const previous = state({ Trades: [trade({ id: 't1', note: 'old', updated_at: T1 })] });
    const next = state({ Trades: [trade({ id: 't1', note: 'edited in this browser' })] });
    const r = M.stampChanged({ previous, next, now: T3 });
    check('an edited record is stamped now', r.state.Trades[0].updated_at === T3, r.state.Trades[0].updated_at);
    check('an edited record is reported', r.stamped.length === 1 && r.stamped[0].id === 't1', JSON.stringify(r.stamped));
    check('the edit itself is untouched', r.state.Trades[0].note === 'edited in this browser');
    const r2 = M.stampChanged({ previous: r.state, next: r.state, now: T3 });
    check('stamping is idempotent — a stamp-only diff is not an edit',
        r2.stamped.length === 0 && r2.state.Trades[0].updated_at === T3, JSON.stringify(r2.stamped));
}
{
    const r = M.stampChanged({ previous: state({}), next: state({ Trades: [trade({ id: 'new-1' })] }), now: T3 });
    check('a brand-new record is stamped', r.state.Trades[0].updated_at === T3, r.state.Trades[0].updated_at);
    check('a brand-new record is reported', r.stamped.length === 1 && r.stamped[0].id === 'new-1');
}
// The whole point: an untouched snapshot gains NO fresh stamps, so it cannot
// out-rank the server no matter how stale the browser is.
{
    const stale = state({
        Accounts: [{ id: 'acc-1', name: 'Old name', updated_at: T1 }],
        Trades: [trade({ id: 't1', note: '', r: 2.57, updated_at: T1 })]
    });
    const booted = JSON.parse(JSON.stringify(stale));      // what that browser booted with
    const own = M.stampChanged({ previous: stale, next: booted, now: T3 });
    check('an untouched stale snapshot is never stamped as newer', own.stamped.length === 0, JSON.stringify(own.stamped));
    const server = state({ Trades: [trade({ id: 't1', note: 'server note', r: 0.9, updated_at: T2 })] });
    const plan = M.mergeStates({ server, local: own.state });
    check('…so the server keeps its newer version', plan.merged.Trades[0].note === 'server note', plan.merged.Trades[0].note);
    check('…and nothing is pushed for it', plan.push.filter(p => p.store === 'Trades').length === 0);
    check('…while the same browser having edited it DOES win',
        M.mergeStates({ server, local: M.stampChanged({ previous: stale, next: state({ Trades: [trade({ id: 't1', note: 'my own offline edit', updated_at: T1 })] }), now: T3 }).state })
            .merged.Trades[0].note === 'my own offline edit');
    check('…and that local-only work is pushed',
        M.mergeStates({ server, local: M.stampChanged({ previous: stale, next: state({ Trades: [trade({ id: 't1', note: 'my own offline edit', updated_at: T1 })] }), now: T3 }).state })
            .push.some(p => p.store === 'Trades' && p.id === 't1'));
}
check('recordContent ignores updated_at', M.recordContent({ a: 1, updated_at: T1 }) === M.recordContent({ a: 1, updated_at: T2 }));
check('recordContent ignores key order', M.recordContent({ a: 1, b: 2 }) === M.recordContent({ b: 2, a: 1 }));
check('recordContent still sees real changes', M.recordContent({ a: 1 }) !== M.recordContent({ a: 2 }));
check('recordContent still sees nested changes', M.recordContent({ a: { b: 1 } }) !== M.recordContent({ a: { b: 2 } }));
{
    const r = M.stampChanged({ previous: state({}), next: state({ EVENT_LOG: [{ entity: 'Trade', what: 'Edited', at: T1 }] }), now: T3 });
    check('the append-only log is never stamped', r.stamped.length === 0 && r.state.EVENT_LOG[0].updated_at === undefined);
}

// ---- 10b. content baseline: reconciling with NO usable timestamps -----------
// This is the real-world case — Postgres writes updated_at but never maps it back
// on read, and the JSON mirror only keeps what a client sent. "The server changed
// it" has to be provable from content alone.
{
    const base = state({ Trades: [trade({ id: 't1', note: 'as the server had it', updated_at: undefined })] });
    const baseline = M.hashState(base);
    check('hashState is a hash map per store', typeof baseline.Trades.t1 === 'string' && baseline.Trades.t1.length > 0);
    check('hashState ignores updated_at', M.hashState(state({ Trades: [trade({ id: 't1', note: 'x', updated_at: T1 })] })).Trades.t1
        === M.hashState(state({ Trades: [trade({ id: 't1', note: 'x', updated_at: T2 })] })).Trades.t1);
    check('hashState changes with content', M.hashState(state({ Trades: [trade({ id: 't1', note: 'a' })] })).Trades.t1
        !== M.hashState(state({ Trades: [trade({ id: 't1', note: 'b' })] })).Trades.t1);

    // This client edited it, the server did not. NEITHER side has a usable stamp.
    const edited = state({ Trades: [trade({ id: 't1', note: 'my offline edit', updated_at: undefined })] });
    const plan = M.mergeStates({ server: base, local: edited, baseline });
    check('a local edit wins on content alone (no timestamps at all)',
        plan.merged.Trades[0].note === 'my offline edit', plan.merged.Trades[0].note);
    check('…and it is pushed', plan.push.some(p => p.store === 'Trades' && p.id === 't1'));
    check('…classified as a local edit', plan.stats.localEdited === 1, JSON.stringify(plan.stats));

    // The server changed it (another machine) and this client did not.
    const serverMoved = state({ Trades: [trade({ id: 't1', note: 'written on another machine', updated_at: undefined })] });
    const stalePlan = M.mergeStates({ server: serverMoved, local: base, baseline });
    check('a server change beats a stale copy on content alone',
        stalePlan.merged.Trades[0].note === 'written on another machine', stalePlan.merged.Trades[0].note);
    check('…and nothing is pushed', stalePlan.push.length === 0);
    check('…classified as a server change', stalePlan.stats.serverEdited === 1, JSON.stringify(stalePlan.stats));

    // Both changed → a genuine conflict. Unusable stamps keep the SERVER.
    const conflict = M.mergeStates({
        server: state({ Trades: [trade({ id: 't1', note: 'server edit', updated_at: undefined })] }),
        local: state({ Trades: [trade({ id: 't1', note: 'local edit', updated_at: undefined })] }),
        baseline
    });
    check('an unprovable conflict keeps the server copy', conflict.merged.Trades[0].note === 'server edit');
    check('…and is reported as such', conflict.stats.conflictServerWon === 1, JSON.stringify(conflict.stats));
    // …but a strictly newer stamp settles it for this client
    const settled = M.mergeStates({
        server: state({ Trades: [trade({ id: 't1', note: 'server edit', updated_at: T1 })] }),
        local: state({ Trades: [trade({ id: 't1', note: 'local edit', updated_at: T2 })] }),
        baseline
    });
    check('a conflict with a newer local stamp goes to the client', settled.merged.Trades[0].note === 'local edit');
    check('…and is pushed', settled.push.some(p => p.store === 'Trades' && p.id === 't1'));

    // A record the baseline has never seen (legacy store): stays conservative.
    const noBase = M.mergeStates({
        server: state({ Trades: [trade({ id: 't9', note: 'server', updated_at: undefined })] }),
        local: state({ Trades: [trade({ id: 't9', note: 'local', updated_at: undefined })] }),
        baseline
    });
    check('a record without a baseline entry keeps the server copy', noBase.merged.Trades[0].note === 'server');
    check('…and is reported as unproven', noBase.stats.unproven === 1, JSON.stringify(noBase.stats));
}

// The full exchange must SETTLE: once the push has happened the merge is a no-op,
// otherwise every page load would push the whole state again.
{
    const serverV1 = state({ Accounts: [{ id: 'acc-1', name: 'Main' }], Trades: [trade({ id: 't1', note: '', updated_at: undefined })] });
    let baseline = M.hashState(serverV1);
    const localEdited = state({ Accounts: [{ id: 'acc-1', name: 'Main' }], Trades: [trade({ id: 't1', note: 'edited', updated_at: undefined })] });

    const first = M.mergeStates({ server: serverV1, local: localEdited, baseline });
    check('cycle 1: the local edit is pushed', first.push.length === 1, JSON.stringify(first.push));

    // the push succeeded → the server now holds `first.merged` → new baseline
    const second = M.mergeStates({ server: first.merged, local: localEdited, baseline: M.hashState(first.merged) });
    check('cycle 2: nothing left to decide', second.stats.identical === 2, JSON.stringify(second.stats));
    check('cycle 2: nothing is pushed (the exchange settled)', second.push.length === 0, JSON.stringify(second.push));

    // a stale snapshot in a second browser still cannot revert it
    const third = M.mergeStates({
        server: first.merged,
        local: state({ Accounts: [{ id: 'acc-1', name: 'Main' }], Trades: [trade({ id: 't1', note: '', updated_at: undefined })] }),
        baseline: M.hashState(serverV1)
    });
    check('cycle 3: a stale browser keeps the pushed edit', third.merged.Trades[0].note === 'edited', third.merged.Trades[0].note);
    check('cycle 3: and pushes nothing', third.push.length === 0, JSON.stringify(third.push));
}

// ---- 11. wiring: the shell must actually use all of this ---------------------
// Guards against a quiet revert to the trade-count heuristic, and against a page
// shipping without the module that makes reconciliation safe.
{
    const fsMod = require('fs');
    const pathMod = require('path');
    const rootDir = pathMod.join(__dirname, '..');
    const shell = fsMod.readFileSync(pathMod.join(rootDir, 'core.js'), 'utf8');
    check('the shell no longer compares trade counts',
        !/serverTradeCount/.test(shell) && !/localTradeCount/.test(shell));
    check('the shell reconciles through src/merge.js', /Merge\.mergeStates\(/.test(shell));
    check('the shell pushes only the reconciled plan', /JSON\.stringify\(plan\.merged\)/.test(shell));
    check('the shell stamps its own edits against a baseline',
        /stampChanged\(\{ previous: lastSaved/.test(shell));
    check('the shell reconciles against the persisted content baseline',
        /baseline: syncBaseline/.test(shell) && /hashState\(state\)/.test(shell));
    check('the shell only records a baseline after the server has the state',
        /saveBaseline\(plan\.merged\)/.test(shell));

    const pages = fsMod.readdirSync(rootDir).filter(f => f.endsWith('.html'));
    const missing = [];
    const outOfOrder = [];
    pages.forEach(page => {
        const src = fsMod.readFileSync(pathMod.join(rootDir, page), 'utf8');
        if (src.indexOf('src/core/index.js') < 0) return;      // no shell on this page
        const mergeAt = src.indexOf('src/merge.js');
        const coreAt = src.indexOf('src/core/index.js');
        if (mergeAt < 0) missing.push(page);
        else if (mergeAt > coreAt) outOfOrder.push(page);
    });
    check('every shell page loads src/merge.js before the shared core',
        missing.length === 0 && outOfOrder.length === 0,
        'missing: ' + missing.join(', ') + ' out of order: ' + outOfOrder.join(', '));

    const sw = fsMod.readFileSync(pathMod.join(rootDir, 'sw.js'), 'utf8');
    check('the service worker precaches src/merge.js', sw.indexOf('/src/merge.js') >= 0);
}

console.log('\nstate-merge: ' + (failures ? failures + ' FAILED' : 'all checks passed'));
process.exit(failures ? 1 : 0);
