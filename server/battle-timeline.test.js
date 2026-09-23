'use strict';

// ============================================================================
// 31TRADES — Two-seat battle timeline end-to-end test
// ----------------------------------------------------------------------------
// Boots the REAL server (scratch data dir, auth off, no DB) and drives TWO seats
// through the REAL battle HTTP surface, on DIFFERENT display timeframes. It
// proves the properties the whole battle foundation rests on:
//
//   §1 the canonical timeline runs at the finest resolution the archive has
//   §2 both seats are told ONE market moment (cutTime) whatever they display
//   §3 every display series is built from REVEALED bars — the bar covering the
//      cut is a forming candle, and nothing past the cut can appear in it
//   §4 the SAME order on both seats produces the SAME fill (fair ordering)
//   §5 different orders stay independent: own position, own trades, own balance,
//      and the other seat's state is never in a projection the policy did not allow
//   §6 seat bar delivery can never pass the cut, in any delivery mode
//
// Run: node server/battle-timeline.test.js   (also part of `npm test`)
//
// ISOLATION: the child server gets TRADEMIND_DATA_DIR + TRADEMIND_BATTLE_DATA_DIR
// pointed at a scratch directory with SUPABASE_DB_URL emptied, so it can never
// touch the real data/ store or the Supabase database.
// ============================================================================

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnv } = require('./env.js');
loadEnv();

const PORT = 8300 + Math.floor(Math.random() * 200);   // avoid stray children
const API = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bxj-btl-timeline-'));

let serverProc = null;
let serverLog = '';

let okCount = 0, failCount = 0;
function ok(cond, label, extra) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label + (extra !== undefined ? '  — ' + extra : '')); }
}

async function api(pathname, opts) {
    const o = opts || {};
    const r = await fetch(API + pathname, {
        method: o.method || 'GET',
        headers: o.body ? { 'Content-Type': 'application/json' } : undefined,
        body: o.body ? JSON.stringify(o.body) : undefined
    });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, d };
}

function startServer() {
    return new Promise((resolve, reject) => {
        serverProc = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: Object.assign({}, process.env, {
                PORT: String(PORT),
                TRADEMIND_PORT: String(PORT),
                TRADEMIND_AUTH: 'off',                 // single local partition
                TRADEMIND_DATA_DIR: SCRATCH,
                TRADEMIND_BATTLE_DATA_DIR: SCRATCH,
                SUPABASE_DB_URL: '',                   // never the real DB
                SUPABASE_URL: '',
                SUPABASE_ANON_KEY: ''
            })
        });
        serverProc.stdout.on('data', c => { serverLog += c.toString(); });
        serverProc.stderr.on('data', c => { serverLog += c.toString(); });
        serverProc.on('error', reject);

        const deadline = Date.now() + 30000;
        (function poll() {
            fetch(API + '/api/backtest/periods').then(r => {
                if (r.ok) return resolve();
                throw new Error('http ' + r.status);
            }).catch(() => {
                if (Date.now() > deadline) return reject(new Error('server did not start:\n' + serverLog.slice(-1500)));
                setTimeout(poll, 400);
            });
        })();
    });
}

function stopServer() {
    if (serverProc && !serverProc.killed) serverProc.kill();
    serverProc = null;
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
}

const TF_MS = { '1m': 60000, '2m': 120000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '1d': 86400000 };

(async function run() {
    await startServer();

    const SYMBOL = 'XAUUSD';
    const MONTH = '2025-01';       // a real archived month

    // ---- the archive decides the finest resolution, so the test never assumes it
    const cat = (await api('/api/backtest/periods?symbol=' + SYMBOL)).d;
    const month = (cat.years || []).reduce((acc, y) => acc || (y.months || []).find(m => m.period === MONTH), null);
    const monthTfs = (month && month.timeframes) || [];
    const finest = monthTfs.slice().sort((a, b) => TF_MS[a] - TF_MS[b])[0];
    ok(!!finest, 'the archive catalogue lists timeframes for ' + MONTH + ' (' + monthTfs.join('/') + ')');

    // ===================================================================== §1
    console.log('\n== §1 create — the canonical timeline is the finest archived resolution ==');
    const created = await api('/api/battles', {
        method: 'POST',
        body: {
            title: 'Two-seat timeline', symbol: SYMBOL, timeframe: '15m', period: MONTH,
            window: 300, startBars: 30,
            seats: [{ name: 'Alex' }, { name: 'Bree' }]
        }
    });
    ok(created.ok, 'the battle is created', JSON.stringify(created.d).slice(0, 200));
    const id = created.d.battle;
    const hostSeat = created.d.hostSeat;
    const mkt = created.d.config.market;
    ok(mkt.baseTimeframe === finest, 'the battle walks the FINEST archived resolution (' + mkt.baseTimeframe + ')');
    ok(mkt.startingTimeframe === '15m' && mkt.timeframe === '15m', 'the host\'s timeframe became the STARTING (display) timeframe, not a limit');
    ok(mkt.dataset === SYMBOL + ':15m:' + MONTH, 'the dataset identity still describes what the host asked for');
    let tl = created.d.state.timeline;
    ok(tl.cutTime > 1e11, 'cutTime is epoch MILLISECONDS (the charts\' unit), not seconds');
    ok(tl.baseMs === TF_MS[mkt.baseTimeframe], 'the canonical resolution reports its duration');
    ok(tl.revealedBars === created.d.state.startIndex + 1, 'warm-up bars are revealed before the start');
    ok(tl.totalBars > tl.revealedBars, 'the rest of the month stays hidden');
    ok(mkt.startIndex === Math.round(30 * (TF_MS['15m'] / TF_MS[mkt.baseTimeframe])), 'the form\'s warm-up is converted from the starting timeframe into canonical bars');

    await api('/api/battles/' + id + '/control', { method: 'POST', body: { action: 'transition', lifecycle: 'battle' } });
    const joined = await api('/api/battles/' + id + '/join', { method: 'POST', body: { name: 'Bree' } });
    ok(joined.ok && joined.d.seat !== hostSeat, 'a second seat is claimed (' + joined.d.seat + ')');
    const otherSeat = joined.d.seat;

    // reveal some market so the two seats have something to look at
    await api('/api/battles/' + id + '/control', { method: 'POST', body: { action: 'seek', cursor: tl.cutIndex + 40 } });

    // ===================================================================== §2
    console.log('\n== §2 two seats, two display timeframes, ONE market moment ==');
    const baseTf = mkt.baseTimeframe;
    const coarseTf = '1h';
    const seatA = (await api('/api/battles/' + id + '/seat?seat=' + hostSeat + '&tf=' + baseTf + '&full=1')).d.state;
    const seatB = (await api('/api/battles/' + id + '/seat?seat=' + otherSeat + '&tf=' + coarseTf + '&full=1')).d.state;
    ok(seatA && seatB, 'both seats read their own private state');
    ok(seatA.timeline.displayTimeframe === baseTf && seatB.timeline.displayTimeframe === coarseTf, 'each seat records the timeframe IT is displaying');
    ok(seatA.timeline.cutTime === seatB.timeline.cutTime, 'a display choice NEVER changes the market moment');
    ok(seatA.timeline.revealedBars === seatB.timeline.revealedBars && seatA.timeline.revealedBars === seatB.timeline.revealedBars, 'both seats are told the same revealed bar count');
    ok(seatA.timeline.baseTimeframe === baseTf && seatB.timeline.baseTimeframe === baseTf, 'both seats share ONE canonical timeline');
    ok(seatA.cursor === seatB.cursor, 'both seats sit on the same canonical cursor');
    tl = seatA.timeline;

    // the public projection stays viewer-neutral: presence, nothing private
    const pub = (await api('/api/battles/' + id)).d.state;
    ok(!!pub.timeline && pub.timeline.cutTime === tl.cutTime, 'the public state carries the same market moment');
    ok(pub.participants.length === 2, 'both seats are projected to participants');
    ok(pub.participants.every(p => p.id && p.name && p.presence && typeof p.presence.state === 'string'), 'the projection is built from identity + presence');
    ok(pub.participants.some(p => p.presence.state === 'online' || p.presence.state === 'active'), 'presence reflects that both seats are here');
    const withheld = ['status', 'direction', 'risk', 'pnl', 'trades'];
    ok(Array.isArray(pub.visibility.hidden) && withheld.every(f => pub.visibility.hidden.indexOf(f) !== -1),
        'the default policy DECLARES what it withholds (status/direction/risk/pnl/trades) instead of implying idleness');
    // The per-viewer FILTER needs two identities and is pinned in server/battle.test.js
    // (participants('u-host') vs participants('u-other')); an auth-off run owns both
    // seats with one id, so here we pin the policy contract the filter reads.

    // ===================================================================== §3
    console.log('\n== §3 the display series is built from revealed bars only ==');
    const baseSeries = (await api('/api/battles/' + id + '/timeline?timeframe=' + baseTf + '&all=1')).d;
    const coarseSeries = (await api('/api/battles/' + id + '/timeline?timeframe=' + coarseTf + '&all=1')).d;
    ok(baseSeries.ok && coarseSeries.ok, 'the timeline endpoint serves both resolutions');
    ok(baseSeries.timeline.cutTime === coarseSeries.timeline.cutTime, 'both series report the same cut');
    const baseLast = baseSeries.bars[baseSeries.bars.length - 1];
    ok(baseLast.time === baseSeries.timeline.cutTime && baseLast.complete === true, 'the canonical series ends exactly at the cut and is complete');
    ok(baseSeries.complete === baseSeries.total, 'every canonical bar up to the cut is complete');
    const coarseLast = coarseSeries.bars[coarseSeries.bars.length - 1];
    ok(coarseSeries.bars.filter(b => !b.complete).length <= 1, 'at most ONE bar is still forming in a coarser timeframe');
    ok(coarseLast.time <= coarseSeries.timeline.cutTime && coarseSeries.timeline.cutTime < coarseLast.time + TF_MS[coarseTf], 'the forming bar is the one containing the cut');
    const TF = TF_MS[coarseTf], BASE = TF_MS[baseTf];
    const leaked = coarseSeries.bars.filter(b => b.complete && (b.time + TF) > (coarseSeries.timeline.cutTime + BASE));
    ok(leaked.length === 0, 'no completed coarser bar extends past the cut');

    // the forming bar must be EXACTLY the aggregate of the revealed canonical bars
    // inside its window — anything else would be a look into the future.
    const inWindow = baseSeries.bars.filter(b => b.time >= coarseLast.time && b.time < coarseLast.time + TF && b.time <= coarseSeries.timeline.cutTime);
    const expect = inWindow.reduce((acc, b) => ({
        open: acc.open === null ? b.open : acc.open,
        high: Math.max(acc.high === null ? b.high : acc.high, b.high),
        low: Math.min(acc.low === null ? b.low : acc.low, b.low),
        close: b.close,
        volume: acc.volume + (Number(b.volume) || 0)
    }), { open: null, high: null, low: null, close: null, volume: 0 });
    ok(inWindow.length > 0 && coarseLast.baseBars === inWindow.length, 'the forming bar counts exactly the revealed canonical bars in its window (' + coarseLast.baseBars + ')');
    ok(coarseLast.high === expect.high && coarseLast.low === expect.low && coarseLast.close === expect.close,
        'its OHLC is the aggregate of the revealed bars alone — no future leak');
    const refused = await api('/api/battles/' + id + '/timeline?timeframe=9m');
    ok(refused.status === 400 && refused.d.error_code === 'unknown-timeframe', 'an unknown resolution is refused by name');

    // ===================================================================== §4
    console.log('\n== §4 the SAME order on both seats produces the SAME fill ==');
    async function cutBar() {
        const s = (await api('/api/battles/' + id + '/timeline?timeframe=' + baseTf + '&all=1')).d;
        return { bar: s.bars[s.bars.length - 1], timeline: s.timeline };
    }
    let cut = await cutBar();
    const entry = cut.bar.close;
    const order = { direction: 'Long', entry: entry, sl: Math.min(cut.bar.low - 0.05, entry - 0.4), tp: Number((entry + 0.8).toFixed(2)), riskAmount: 25, setup: 'Shared' };
    const enterA = await api('/api/battles/' + id + '/enter', { method: 'POST', body: Object.assign({ seat: hostSeat }, order) });
    const enterB = await api('/api/battles/' + id + '/enter', { method: 'POST', body: Object.assign({ seat: otherSeat }, order) });
    ok(enterA.ok && enterB.ok, 'both seats take the identical order on the same bar', (enterA.d.error || '') + (enterB.d.error || ''));
    ok(enterA.d.position && enterB.d.position && enterA.d.position.entry === enterB.d.position.entry && enterA.d.position.size === enterB.d.position.size,
        'identical inputs produce identical entry and size on both seats');

    // advance until the shared stop/target resolves (deterministic archive data)
    let tradesA = [], tradesB = [];
    for (let i = 0; i < 60 && !(tradesA.length && tradesB.length); i++) {
        const t = (await api('/api/battles/' + id + '/timeline?timeframe=' + baseTf + '&all=1')).d;
        await api('/api/battles/' + id + '/control', { method: 'POST', body: { action: 'seek', cursor: t.timeline.cutIndex + 5 } });
        tradesA = (await api('/api/battles/' + id + '/seat?seat=' + hostSeat)).d.state.trades || [];
        tradesB = (await api('/api/battles/' + id + '/seat?seat=' + otherSeat)).d.state.trades || [];
    }
    ok(tradesA.length === 1 && tradesB.length === 1, 'both seats closed exactly one trade (' + tradesA.length + '/' + tradesB.length + ')');
    const ta = tradesA[0], tb = tradesB[0];
    ok(!!ta && !!tb && ta.entry === tb.entry && ta.exit === tb.exit && ta.exitTime === tb.exitTime,
        'same entry, same exit price and the SAME fill bar — one cursor, fair ordering');
    ok(!!ta && !!tb && ta.pnl === tb.pnl && ta.realizedR === tb.realizedR && ta.exitReason === tb.exitReason,
        'identical P&L and exit reason for identical decisions');

    // ===================================================================== §5
    console.log('\n== §5 different orders stay independent per seat ==');
    const preA = (await api('/api/battles/' + id + '/seat?seat=' + hostSeat)).d.state;
    const preB = (await api('/api/battles/' + id + '/seat?seat=' + otherSeat)).d.state;
    const preBalanceA = preA.balance, preBalanceB = preB.balance;
    ok(preBalanceA === preBalanceB, 'after identical trades both seats hold the SAME balance');
    const sameMoment = await cutBar();
    const px = sameMoment.bar.close;
    const bar = sameMoment.bar;
    // Stops/targets sit OUTSIDE the current bar's range, so neither seat fills on
    // the entry bar (an SL/TP inside it fills immediately — that behaviour has its
    // own coverage in battle.test.js).
    const longA = await api('/api/battles/' + id + '/enter', {
        method: 'POST',
        body: { seat: hostSeat, direction: 'Long', entry: px, sl: Number((bar.low - 0.5).toFixed(2)), tp: Number((bar.high + 1.0).toFixed(2)), riskAmount: 25, setup: 'A-long' }
    });
    const shortB = await api('/api/battles/' + id + '/enter', {
        method: 'POST',
        body: { seat: otherSeat, direction: 'Short', entry: px, sl: Number((bar.high + 0.5).toFixed(2)), tp: Number((bar.low - 1.0).toFixed(2)), riskAmount: 25, setup: 'B-short' }
    });
    ok(longA.ok && shortB.ok, 'both seats may trade the same bar in OPPOSITE directions', (longA.d.error || '') + (shortB.d.error || ''));
    const afterEntryA = longA.d.state, afterEntryB = shortB.d.state;
    ok(afterEntryA.position && afterEntryA.position.direction === 'Long', 'seat A holds its own LONG');
    ok(afterEntryB.position && afterEntryB.position.direction === 'Short', 'seat B holds its own SHORT at the same moment');
    ok(afterEntryA.position.sl !== afterEntryB.position.sl && afterEntryA.position.tp !== afterEntryB.position.tp, 'each seat keeps its own stop and target');
    ok(afterEntryA.balance === preBalanceA && afterEntryB.balance === preBalanceB, 'an open position moves neither seat\'s balance');
    ok(afterEntryA.timeline.cutTime === afterEntryB.timeline.cutTime, 'placing an order does not move the market');

    const seatBState = (await api('/api/battles/' + id + '/seat?seat=' + otherSeat)).d.state;
    ok(seatBState.trades.every(t => t.setup === 'Shared' || t.setup === 'B-short'), 'a seat only ever sees its OWN trades');
    ok(seatBState.trades.every(t => t.setup !== 'A-long'), 'the other seat\'s decision is not in this seat\'s history');
    ok(seatBState.position && seatBState.position.direction === 'Short' && typeof seatBState.balance === 'number', 'the private state is complete for its owner');
    ok(seatBState.trades.length === 1, 'seat B\'s own history is unchanged by seat A\'s open trade');
    const pubAfter = (await api('/api/battles/' + id)).d.state;
    ok(pubAfter.participants.some(p => p.presence.state === 'active'), 'a seat that just traded reports as active, without revealing what it did');

    // ===================================================================== §6
    console.log('\n== §6 bar delivery can never pass the cut ==');
    const full = (await api('/api/battles/' + id + '/seat?seat=' + hostSeat + '&full=1')).d.state;
    const tail = (await api('/api/battles/' + id + '/seat?seat=' + hostSeat + '&window=50')).d.state;
    const delta = (await api('/api/battles/' + id + '/seat?seat=' + hostSeat + '&from=' + Math.max(0, full.candlesTotal - 3))).d.state;
    [['full=1', full], ['tail window', tail], ['from=N', delta]].forEach(([label, st]) => {
        const last = st.candles[st.candles.length - 1];
        ok(!!last && last.time <= st.timeline.cutTime, label + ': never ships a bar past the cut');
    });
    ok(full.candlesTotal === full.timeline.revealedBars, 'the revealed count matches the timeline');
    ok(delta.candles.length === 3 && delta.candles[2].time === full.candles[full.candles.length - 1].time, 'from=N ships only the requested tail, ending at the cut');
    const second = await cutBar();
    const fine = await api('/api/battles/' + id + '/timeline?timeframe=' + baseTf + '&from=' + (second.timeline.revealedBars - 2) + '&limit=2');
    ok(fine.ok && fine.d.bars.length === 2 && fine.d.total === second.timeline.revealedBars, 'from=/limit= slice the display series without changing the total');

    console.log('\n' + (failCount ? 'FAILED: ' + failCount + ' / ' + (okCount + failCount) : 'ALL PASS: ' + okCount + ' checks'));
})().then(() => { stopServer(); process.exit(failCount ? 1 : 0); })
    .catch(e => { console.error('RUN ERROR: ' + (e && e.message)); console.error(serverLog.slice(-1500)); stopServer(); process.exit(1); });
