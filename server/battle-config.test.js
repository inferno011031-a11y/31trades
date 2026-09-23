'use strict';

// ============================================================================
// 31TRADES — Battle configuration contract tests
// The contract exists so future Battle modes/rules can be added WITHOUT
// rebuilding the replay or execution layers. These tests pin the guard rails:
// unspecified or unknown configurations are refused loudly, never silently
// replaced by a default that nobody asked for.
// ============================================================================

const C = require('./battle-config.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

// 1 · defaults — an unconfigured battle keeps today's behaviour
{
    const n = C.normalize(null);
    ok(n.errors.length === 0, 'empty input normalizes without errors');
    ok(n.config.market.policy === 'archive-month', 'market defaults to archive-month');
    ok(n.config.replay.policy === 'host-driven', 'replay defaults to host-driven');
    ok(n.config.execution.policy === 'market-on-bar', 'execution defaults to market-on-bar');
    ok(n.config.settlement.policy === 'timeline-exhausted', 'settlement defaults to timeline-exhausted');
    ok(n.config.scoring.policy === 'legacy-compat', 'scoring stays on the provisional legacy adapter');
    ok(n.config.visibility.policy === 'presence', 'opponent information defaults to presence only');
    ok(C.canRun(n.config).ok === true, 'defaults are runnable');
    ok(C.participantFields(n.config).join(',') === 'presence', 'default visibility exposes presence alone');
}

// 2 · unimplemented policies are refused, not faked
{
    const n = C.normalize({ settlement: { policy: 'fixed-bars', bars: 200 } });
    ok(n.errors.length === 1 && /not implemented/.test(n.errors[0]), 'a registered-but-unimplemented policy is an error');
    ok(n.config.settlement.bars === 200, 'the declared placeholder value is still preserved for the future spec');
    ok(C.canRun(n.config).ok === false && /not implemented/.test(C.blockers(n.config)[0]), 'canRun reports why it cannot run');
    const unknown = C.normalize({ execution: { policy: 'time-machine' } });
    ok(unknown.errors.length === 1 && /unknown/.test(unknown.errors[0]), 'an unknown policy name is an error');
}

// 3 · every slot's default is implemented, so nothing silently un-implements
{
    const cat = C.capabilities();
    const broken = cat.slots.filter(s => !s.policies.some(p => p.policy === s.default && p.implemented));
    ok(broken.length === 0, 'each slot default maps to an implemented policy');
    ok(cat.specified === false, 'the catalogue states plainly that mechanics are not specified yet');
    ok(cat.lifecycle.join('>') === 'discovery>matching>lobby>ready>battle>settlement>results>analytics', 'lifecycle is the eight-stage pipeline');
    ok(cat.availability.length === 5 && cat.availability.indexOf('spectating') !== -1, 'availability states are exposed for the presence UI');
}

// 4 · unknown keys survive verbatim, with a warning
{
    const n = C.normalize({ tournament: { id: 'x' }, market: { symbol: 'xauusd', timeframe: '5m', period: '2024-06' } });
    ok(n.config.extra && n.config.extra.tournament.id === 'x', 'unknown config keys are preserved under extra');
    ok(n.warnings.some(w => /tournament/.test(w)), 'unknown keys warn');
    ok(n.config.market.symbol === 'XAUUSD' && n.config.market.timeframe === '5m' && n.config.market.period === '2024-06', 'declared market fields land in the market slot');
    ok(n.warnings.every(w => !/market/.test(w)), 'a fully declared market slot does not warn');
}

// 5 · legacy flat fields (what the current UI posts) fold into the slot
{
    const n = C.normalize({ asset: 'eurusd', timeframe: '1h', session: 'New York' });
    ok(n.config.market.symbol === 'EURUSD' && n.config.market.session === 'New York', 'flat legacy fields fold in');
    ok(n.errors.length === 0, 'flat legacy fields produce no errors');
}

// 6 · re-normalizing an already-normalized config is lossless and silent
{
    const first = C.normalize({ visibility: { mode: 'custom', fields: ['presence', 'status', 'pnl'] }, replay: { policy: 'auto-timed', speedMs: 250 } });
    const second = C.normalize(first.config);
    ok(second.errors.length === 0 && second.warnings.length === 0, 're-normalization adds no errors or warnings');
    ok(JSON.stringify(second.config.visibility) === JSON.stringify(first.config.visibility), 'visibility round-trips');
    ok(second.config.replay.speedMs === 250, 'declared numeric values round-trip');
}

// 7 · visibility — the opponent-information policy
{
    const custom = C.normalize({ visibility: { mode: 'custom', fields: ['presence', 'direction', 'nonsense'] } });
    ok(custom.errors.length === 1 && /unknown visibility field/.test(custom.errors[0]), 'unknown participant fields are rejected');
    ok(custom.config.visibility.fields.join(',') === 'presence,direction', 'known fields survive, unknown ones are dropped');
    const full = C.normalize({ visibility: { mode: 'full' } });
    ok(C.participantFields(full.config).length === Object.keys(C.PARTICIPANT_FIELDS).length, 'full exposes every tracked participant field');
    const modeAlias = C.normalize({ visibility: { mode: 'custom', fields: ['trades'] } });
    ok(C.visibilityMode(modeAlias.config) === 'custom', '`mode` is accepted as the visibility policy name');
    ok(C.participantFields(modeAlias.config).join(',') === 'presence,trades', 'presence is always included alongside requested fields');
}

// 8 · replay speed is bounded, never trusted raw
{
    ok(C.normalize({ replay: { speedMs: 1 } }).config.replay.speedMs === 40, 'absurdly fast replay is floored');
    ok(C.normalize({ replay: { speedMs: 10 ** 9 } }).config.replay.speedMs === 600000, 'absurdly slow replay is capped');
    ok(C.normalize({ replay: { speedMs: 'fast' } }).errors.length === 1, 'a non-numeric speed is an error');
}

// 9 · market sanity
{
    const bad = C.normalize({ market: { startIndex: -5 } });
    ok(bad.errors.length === 1 && /startIndex/.test(bad.errors[0]), 'a negative warm-up index is an error');
    const conflict = C.normalize({ market: { policy: 'live-window', period: '2024-06' } });
    ok(conflict.warnings.some(w => /live-window/.test(w)), 'an explicit live-window policy with an archive month warns');
    const explicit = C.normalize({ market: { policy: 'archive-month' } });
    ok(explicit.errors.length === 0, 'pinning archive-month without a period is accepted (the create path resolves one)');
    ok(explicit.warnings.length === 0, 'an unresolved archive month is not treated as a contradiction');
    ok(C.normalize({}).warnings.length === 0, 'the implicit default does not warn');
}

// 10 · the timeline resolution contract (canonical base resolution + the display set)
// A battle walks ONE resolution; the chart may display that one or any coarser
// resolution. This is what stops the backend from dictating the battle's timeframe.
{
    const Backtest = require('./backtest.js');
    const shared = Object.keys(Backtest.TIMEFRAMES).filter(tf => C.TIMEFRAME_MS[tf] != null);
    const drift = shared.filter(tf => C.TIMEFRAME_MS[tf] !== Backtest.TIMEFRAMES[tf] * 1000);
    ok(shared.length >= 8, 'the resolution table shares ids with the backtest service');
    ok(drift.length === 0, 'every shared resolution means the same duration in both tables' + (drift.length ? ' (drift: ' + drift.join(',') + ')' : ''));

    ok(C.resolveBaseTimeframe(null, ['15m', '1m', '4h']).baseTimeframe === '1m', 'an unrequested canonical resolution is the FINEST the archive has');
    ok(C.resolveBaseTimeframe(null, ['1h', '5m']).baseTimeframe === '5m', 'it picks the finest of whatever that month actually has');
    const want = C.resolveBaseTimeframe('15m', ['1m', '15m']);
    ok(want.ok && want.baseTimeframe === '15m' && want.requested === true, 'a host may pin the canonical resolution');
    const missing = C.resolveBaseTimeframe('5m', ['1m', '15m']);
    ok(missing.ok === false && /no 5m/.test(missing.error), 'pinning a resolution the dataset lacks is refused, never silently swapped');
    ok(C.resolveBaseTimeframe('7x', ['1m']).ok === false, 'an unknown resolution is refused');
    ok(C.resolveBaseTimeframe(null, []).baseTimeframe === '1m', 'an empty archive catalogue still yields a usable default (reported as a warning)');

    const disp = C.displayTimeframes('15m');
    ok(disp[0] === '15m' && disp.indexOf('1m') === -1, 'the display set starts at the canonical resolution and never refines below it');
    ok(disp.indexOf('1h') !== -1 && disp.indexOf('1d') !== -1, 'every coarser resolution is displayable');

    const n = C.normalize({ market: { symbol: 'XAUUSD', timeframe: '15m' } });
    ok(n.config.market.timeframe === '15m' && n.config.market.startingTimeframe === '15m', 'the legacy timeframe becomes the starting timeframe');
    ok(n.config.market.baseTimeframe === '15m', 'without a canonical resolution the engine keeps its previous behaviour');
    const canon = C.normalize({ market: { timeframe: '15m', baseTimeframe: '1m' } });
    ok(canon.config.market.baseTimeframe === '1m' && canon.config.market.startingTimeframe === '15m', 'a finer canonical timeline leaves the starting timeframe alone');
    ok(canon.warnings.length === 0, 'a chart opening on a timeframe coarser than the canonical timeline is normal, not a warning');
    const backwards = C.normalize({ market: { timeframe: '5m', baseTimeframe: '1h' } });
    ok(backwards.config.market.startingTimeframe === '1h' && backwards.warnings.some(w => /finer/.test(w)), 'a starting timeframe finer than the canonical timeline is corrected and warned about');
    ok(C.normalize({ market: { timeframe: '9m' } }).errors.some(e => /unknown market.timeframe/.test(e)), 'an unknown timeframe is an error');
    ok(C.normalize({ market: { displayTimeframes: ['1m', 'nope'] } }).errors.some(e => /displayTimeframes/.test(e)), 'an unknown display resolution is an error');
    ok(C.capabilities().timeframes.order[0] === '1m', 'the capability catalogue publishes the resolution order');
}

console.log('\n' + (failCount ? 'FAILED: ' + failCount + ' / ' + (okCount + failCount) : 'ALL PASS: ' + okCount + ' checks'));
process.exit(failCount ? 1 : 0);
