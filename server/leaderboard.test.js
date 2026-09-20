'use strict';

// ============================================================================
// Social layer · leaderboard tests (server/leaderboard.js)
// ----------------------------------------------------------------------------
// Contract:
//   1. per-day aggregates are built from the LIVE ledger only — practice and
//      backtest records never reach a board
//   2. any range (7d/30d/90d/ytd/quarter season/month/year/all) is computed on
//      read from those aggregates
//   3. a board only ever contains traders who opted in AND expose the metric it
//      is ranked by; hidden metrics come back masked, never leaked
//   4. the sample floor keeps 1-trade flukes off the boards
// No DB, no network — file-only, throwaway directory.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

delete process.env.SUPABASE_DB_URL;          // force the file fallback path

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'leaderboard-test-'));
process.env.TRADEMIND_SOCIAL_DATA_DIR = TMP;

const Leaderboard = require('./leaderboard.js');
const Profiles = require('./profiles.js');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ok  ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
}
const close = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.011 : eps);

// ---- fixtures ---------------------------------------------------------------
const DAY = 864e5;
const ago = d => new Date(Date.now() - d * DAY).toISOString();

// { ago, pnl, r } → a live canonical trade
function mkTrade(i, o) {
    const t = o || {};
    return {
        id: 't' + i, account_id: 'acc-live', source: 'LIVE',
        ts: t.ts || ago(t.ago == null ? 1 : t.ago),
        symbol: 'XAUUSD', dir: t.dir || 'Long', setup: 'FVG', session: 'London',
        pnl: t.pnl, r: t.r, risk: t.risk == null ? 25 : t.risk
    };
}
// a core exposing exactly the surface the leaderboard reads
function mkCore(trades) {
    return { Trades: trades, Accounts: [{ id: 'acc-live' }], disciplineState: () => ({ score: 77 }) };
}
// 12 winning-biased trades on N distinct days
function coreWith(dayOffsets, pnl, r) {
    return mkCore(dayOffsets.map((d, i) => mkTrade(i, { ago: d, pnl, r })));
}
const publicProfile = (userId, handle, visibility) =>
    Profiles.save(userId, { handle, displayName: handle, visibility: visibility || { public: true } });

console.log('\n== Leaderboard ==');

(async () => {

// ---- 1 · day aggregates -----------------------------------------------------
{
    const days = Leaderboard.daysFromTrades([
        mkTrade(1, { ts: '2026-03-02T09:00:00.000Z', pnl: 100, r: 1 }),
        mkTrade(2, { ts: '2026-03-02T14:00:00.000Z', pnl: -40, r: -0.5 }),
        mkTrade(3, { ts: '2026-03-03T09:00:00.000Z', pnl: 60, r: 0.6 }),
        mkTrade(4, { ts: 'not-a-date', pnl: 999, r: 9 })
    ]);
    ok(Object.keys(days).length === 2, 'aggregates group by UTC day, unparseable ts dropped');
    ok(days['2026-03-02'].n === 2 && days['2026-03-02'].w === 1 && days['2026-03-02'].l === 1, 'wins/losses counted per day');
    ok(close(days['2026-03-02'].net, 60) && close(days['2026-03-02'].gW, 100) && close(days['2026-03-02'].gL, 40), 'day net + gross win/loss stored separately');
    ok(close(days['2026-03-03'].rS, 0.6) && close(days['2026-03-03'].rk, 25), 'R and risk are summed');
    ok(Leaderboard.dayKeyOf('2026-03-02T23:59:00.000Z') === '2026-03-02', 'dayKeyOf is UTC');
}

// ---- 2 · range windows ------------------------------------------------------
{
    const now = new Date('2026-09-20T12:00:00.000Z');
    ok(Leaderboard.rangeWindow('all', now) === null, 'all-time has no window');
    ok(Leaderboard.rangeWindow('30d', now).from.toISOString().slice(0, 10) === '2026-08-21', '30d window starts 30 days back');
    ok(Leaderboard.rangeWindow('ytd', now).from.toISOString().slice(0, 10) === '2026-01-01', 'ytd starts Jan 1');
    ok(Leaderboard.rangeWindow('season', now).from.toISOString().slice(0, 10) === '2026-07-01', 'current season = calendar quarter');
    ok(Leaderboard.rangeWindow('2026-Q1', now).from.toISOString().slice(0, 10) === '2026-01-01', 'explicit quarter parses');
    ok(Leaderboard.rangeWindow('2025-11', now).to.toISOString().slice(0, 10) === '2025-12-01', 'explicit month parses with an exclusive end');
    ok(Leaderboard.rangeWindow('2025', now).to.toISOString().slice(0, 10) === '2026-01-01', 'explicit year parses');
    ok(Leaderboard.seasonId(now) === '2026-Q3', 'seasonId labels the live quarter');
    ok(Leaderboard.validRange('30d') && Leaderboard.validRange('2024-Q2') && !Leaderboard.validRange('banana'), 'range validation');
}

// ---- 3 · metrics ------------------------------------------------------------
{
    const days = Leaderboard.daysFromTrades([
        mkTrade(1, { ts: '2026-03-01T10:00:00.000Z', pnl: 100, r: 1 }),
        mkTrade(2, { ts: '2026-03-02T10:00:00.000Z', pnl: -50, r: -1 }),
        mkTrade(3, { ts: '2026-03-03T10:00:00.000Z', pnl: 150, r: 1.5 }),
        mkTrade(4, { ts: '2026-03-05T10:00:00.000Z', pnl: -100, r: -1 })
    ]);
    const m = Leaderboard.metricsFromDays(days);
    ok(m.n === 4 && m.wins === 2 && m.losses === 2, 'trade counts');
    ok(close(m.net, 100), 'net P&L summed');
    ok(close(m.winRate, 50), 'win rate is a 0–100 percentage');
    ok(close(m.avgR, 0.125, 0.002), 'avg R = ΣR / n');
    ok(close(m.pf, 1.67, 0.01), 'profit factor = gross win / gross loss');
    ok(close(m.maxDD, 100), 'max drawdown comes from the daily equity curve');
    ok(close(m.recovery, 1), 'recovery factor = net / maxDD');
    ok(m.activeDays === 4 && m.curve.length === 4, 'active days + curve exposed');
    ok(m.streak.type === 'loss' && m.streak.len === 1, 'current day-streak detected');
    ok(m.bestDayStreak === 1, 'best day-streak tracked');
    ok(m.bestDay.net === 150 && m.worstDay.net === -100, 'best/worst day identified');
    ok(Leaderboard.metricsFromDays({}).n === 0, 'empty aggregate is safe');
}

// ---- 4 · bxScore ------------------------------------------------------------
{
    const strong = Leaderboard.metricsFromDays({ '2026-03-01': { n: 12, w: 9, l: 3, gW: 900, gL: 150, rS: 9, rk: 300, net: 750 } });
    const weak = Leaderboard.metricsFromDays({ '2026-03-01': { n: 12, w: 4, l: 8, gW: 200, gL: 600, rS: -4, rk: 300, net: -400 } });
    const tiny = Leaderboard.metricsFromDays({ '2026-03-01': { n: 2, w: 2, l: 0, gW: 500, gL: 0, rS: 4, rk: 50, net: 500 } });
    const s = Leaderboard.bxScore(strong, 10), w = Leaderboard.bxScore(weak, 10);
    ok(s && s.score > w.score, 'better execution scores higher');
    ok(s.score <= 1000 && w.score >= 0, 'score stays inside 0–1000');
    ok(Leaderboard.bxScore(tiny, 10) === null, 'a 2-trade fluke scores null under the floor');
    ok(Leaderboard.bxScore(tiny, 2).score > 0, 'a lower floor admits the same trades');
    ok(s.comps && typeof s.comps.activity === 'number' && s.comps.activity <= 1, 'component breakdown exposed for the UI');
}

// ---- 5 · publish — live ledger only -----------------------------------------
{
    const core = mkCore([
        mkTrade(1, { ago: 1, pnl: 120, r: 1.2 }),
        mkTrade(2, { ago: 2, pnl: -60, r: -0.6 }),
        { ...mkTrade(3, { ago: 3, pnl: 5000, r: 5 }), source: 'BACKTEST' },
        { ...mkTrade(4, { ago: 4, pnl: 5000, r: 5 }), account_id: 'practice' }
    ]);
    const r = await Leaderboard.publish('lb-live', { core, profile: await Profiles.get('lb-live'), force: true });
    ok(r.ok === true, 'publish succeeds');
    ok(Object.keys(r.entry.days).length === 2, 'practice + backtest trades are excluded from the snapshot');
    ok(close(r.summary.metrics.net, 60), 'published net counts live trades only');
    ok(r.entry.discipline === 77, 'discipline score snapshotted from the core');
    ok(r.entry.squadId === null, 'no squad by default');

    const again = await Leaderboard.publish('lb-live', { core, profile: await Profiles.get('lb-live') });
    ok(again.skipped === true, 'a repeat publish inside the throttle window is skipped');

    const forced = await Leaderboard.publish('lb-live', { core, profile: await Profiles.get('lb-live'), force: true });
    ok(!forced.skipped, 'force bypasses the throttle');
    ok((await Leaderboard.publish('lb-nocore', { core: null })).ok === false, 'publish without core state is refused');
}

// ---- 6 · boards: opt-in, floor, ranking, masking ----------------------------
{
    // alpha: 12 trades, strong. beta: 12 trades, weak. gamma: private, strong.
    // delta: 4 trades (under the floor), publicly visible.
    await publicProfile('lb-alpha', 'alpha', { public: true });
    await publicProfile('lb-beta', 'beta', { public: true });
    await publicProfile('lb-gamma', 'gamma-private', { public: false });
    await publicProfile('lb-delta', 'delta', { public: true });

    const alphaDays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    await Leaderboard.publish('lb-alpha', { core: coreWith(alphaDays, 100, 1), force: true });
    await Leaderboard.publish('lb-beta', { core: mkCore(alphaDays.map((d, i) => mkTrade(i, { ago: d, pnl: i % 3 === 0 ? 20 : -30, r: i % 3 === 0 ? 0.2 : -0.3 }))), force: true });
    await Leaderboard.publish('lb-gamma', { core: coreWith(alphaDays, 500, 4), force: true });
    await Leaderboard.publish('lb-delta', { core: coreWith([1, 2, 3, 4], 900, 6), force: true });

    const board = await Leaderboard.board({ metric: 'bxScore', range: 'all', minTrades: 10, limit: 100 });
    const ids = board.rows.map(r => r.userId);
    ok(ids.indexOf('lb-alpha') !== -1 && ids.indexOf('lb-beta') !== -1, 'public traders past the floor are listed');
    ok(ids.indexOf('lb-gamma') === -1, 'a private trader never appears on a board');
    ok(ids.indexOf('lb-delta') === -1, 'a trader under the sample floor is not listed');
    ok(board.rows[0].userId === 'lb-alpha' && board.rows[0].rank === 1, 'stronger execution ranks first');
    ok(board.total === 2 && board.limit === 100, 'board reports its own size');
    ok(board.season === Leaderboard.seasonId(), 'board labels the live season');

    const netBoard = await Leaderboard.board({ metric: 'net', range: 'all', minTrades: 10 });
    ok(netBoard.rows[0].userId === 'lb-alpha' && close(netBoard.rows[0].metrics.net, 1200), 'net board ranks by realised P&L');
    ok((await Leaderboard.board({ metric: 'banana' })).metric === 'bxScore', 'an unknown metric falls back to bxScore');
    ok((await Leaderboard.board({ range: 'banana' })).range === '30d', 'an unknown range falls back to 30d');
}

// ---- 7 · ranges slice the same snapshot ------------------------------------
{
    // epsilon: 6 recent trades + 6 old ones
    await publicProfile('lb-eps', 'epsilon', { public: true });
    const trades = [
        [2, 200], [3, 200], [4, 200], [5, 200], [6, 200], [7, 200],
        [70, 50], [71, 50], [72, 50], [73, 50], [74, 50], [75, 50]
    ].map(([d, pnl], i) => mkTrade(i, { ago: d, pnl, r: pnl / 100 }));
    await Leaderboard.publish('lb-eps', { core: mkCore(trades), force: true });

    const all = await Leaderboard.board({ metric: 'net', range: 'all', minTrades: 5 });
    const recent = await Leaderboard.board({ metric: 'net', range: '30d', minTrades: 5 });
    const allRow = all.rows.find(r => r.userId === 'lb-eps');
    const recentRow = recent.rows.find(r => r.userId === 'lb-eps');
    ok(allRow && close(allRow.metrics.net, 1500), 'all-time window sums everything');
    ok(recentRow && close(recentRow.metrics.net, 1200), '30d window excludes the 70-day-old trades');
    ok(recentRow.metrics.trades === 6, '30d window trade count is right');

    const old = await Leaderboard.board({ metric: 'net', range: '2026-01', minTrades: 1 });
    ok(old.ok === true, 'an arbitrary month range is accepted');
}

// ---- 8 · per-metric privacy masks the boards -------------------------------
{
    await publicProfile('lb-quiet', 'quiet', { public: true, showNet: false, showDiscipline: false });
    await Leaderboard.publish('lb-quiet', { core: coreWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 300, 3), force: true });

    const netBoard = await Leaderboard.board({ metric: 'net', range: 'all', minTrades: 10 });
    ok(netBoard.rows.every(r => r.userId !== 'lb-quiet'), 'a trader hiding net is absent from the net board');

    const wr = await Leaderboard.board({ metric: 'winRate', range: 'all', minTrades: 10 });
    const row = wr.rows.find(r => r.userId === 'lb-quiet');
    ok(!!row, 'the same trader still appears on the win-rate board');
    ok(row.metrics.net === null && row.metrics.pf === null && row.metrics.maxDD === null, 'hidden profit metrics come back masked');
    ok(row.metrics.winRate === 100 && row.metrics.trades === 12, 'visible metrics are intact');
    ok(row.discipline === null, 'hidden discipline is masked');
    ok(JSON.stringify(row).indexOf('@') === -1, 'no email-shaped data in a board row');
}

// ---- 9 · myRank explains the position --------------------------------------
{
    const me = await Leaderboard.myRank('lb-alpha', { metric: 'bxScore', range: 'all', minTrades: 10 });
    ok(me.ranked === true && me.rank >= 1 && me.percentile > 0, 'ranked trader gets a rank + percentile');
    ok(me.metrics && me.metrics.n === 12, 'own metrics are returned even when the row is masked on the board');
    ok(me.reasons.length === 0, 'no blockers for an eligible trader');

    const priv = await Leaderboard.myRank('lb-gamma', { metric: 'bxScore', range: 'all', minTrades: 10 });
    ok(priv.ranked === false && priv.rank === null, 'a private trader is unranked');
    ok(priv.reasons.some(r => /private/i.test(r)), 'the reason names the privacy switch');

    const quiet = await Leaderboard.myRank('lb-quiet', { metric: 'net', range: 'all', minTrades: 10 });
    ok(quiet.ranked === false && quiet.reasons.some(r => /hide/i.test(r)), 'the reason names the hidden metric');

    const small = await Leaderboard.myRank('lb-delta', { metric: 'bxScore', range: 'all', minTrades: 10 });
    ok(small.ranked === false && small.reasons.some(r => /at least 10/.test(r)), 'the reason quotes the sample floor');
}

// ---- 10 · persistence -------------------------------------------------------
{
    const f = path.join(TMP, 'leaderboard.json');
    ok(fs.existsSync(f), 'standings are mirrored to the per-store JSON file');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok(raw['lb-alpha'] && Object.keys(raw['lb-alpha'].days).length === 12, 'day aggregates persist per trader');
    const reloaded = require('./leaderboard.js');
    const rows = await reloaded.readAll();
    ok(rows.length > 0, 'standings survive a module reload');
}

console.log('\n' + (fail === 0 ? 'ALL LEADERBOARD CHECKS PASS' : fail + ' LEADERBOARD CHECKS FAILED') + ' (' + pass + ' ok)\n');
process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('LEADERBOARD TEST CRASH:', err); process.exit(1); });
