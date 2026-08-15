'use strict';

// ============================================================================
// 31TRADES — Online Battle Engine tests
// One canonical timeline, server-owned cursor, private per-seat decisions,
// anti-cheat (no future entries), blended scoring, team aggregation and the
// post-battle reveal. No network — fully local.
// ============================================================================

process.env.TRADEMIND_AUTH = 'off';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '31trades-btl-'));
process.env.TRADEMIND_BATTLE_DATA_DIR = TMP;

const Battle = require('./battle.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

function makeCandles(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const close = 100 + 0.2 * i;
        out.push({ time: 1700000000 + i * 3600, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 1000 + i * 10 });
    }
    return out;
}

function newBattle(overrides) {
    return new Battle.Battle(Object.assign({
        hostId: 'u-host', title: 'ICT vs SMC', symbol: 'EURUSD', timeframe: '1h',
        category: 'Forex', candles: makeCandles(60), startIndex: 10,
        startingBalance: 10000, riskModel: { basis: 'money', perTrade: 25 },
        status: 'running',
        seats: [
            { id: 's0', name: 'Alex', team: 'ICT', userId: 'u-host' },
            { id: 's1', name: 'Sam', team: 'SMC' },
            { id: 's2', name: 'Jordan', team: 'SMC' }
        ]
    }, overrides || {}));
}

(async function run() {

// 1 · canonical timeline — every seat sees the same candles & cursor
{
    const b = newBattle();
    b._ensureSeats();
    ok(b.seats.every(s => s.session.candles.length === 60), 'every seat holds the full canonical timeline');
    b.setCursor(30);
    ok(b.cursor === 30, 'cursor moves to 30');
    ok(b.seats.every(s => s.session.cursor === 30), 'ALL seats advance together');
    ok(b.seatState('s0').candles.length === 31, 'seat sees only revealed candles (no future)');
}

// 2 · private decisions — seat A trades, seat B waits; B is untouched
{
    const b = newBattle();
    b._ensureSeats();
    b.setCursor(20);
    const r = b.enter('s0', { direction: 'long', entry: 104, sl: 103, tp: 107, riskAmount: 25, setup: 'Breakout' });
    ok(r.ok === true, 'host enters long at bar 20');
    const st1 = b.seatState('s1');
    ok(st1.position === null && st1.trades.length === 0, 'other seat has no position and no trades');
    ok(b.seatState('s0').position !== null, 'entering seat shows its own position');
    // advance — host fills via TP, Sam still flat
    b.setCursor(40);
    ok(b.seatState('s0').trades.length === 1, 'host trade filled on the shared advance');
    ok(b.seatState('s1').trades.length === 0, 'Sam stayed flat through the same advance');
}

// 3 · anti-cheat — entries must reference the current visible bar
{
    const b = newBattle();
    b._ensureSeats();
    b.setCursor(20);
    const bar = b.candles[20];
    const cheat = b.enter('s1', { direction: 'long', entry: bar.close * 10, sl: bar.low, tp: bar.close * 10 + 1, riskAmount: 25 });
    ok(cheat.ok === false && /current bar/.test(cheat.error), 'future/off-bar entry rejected');
    // SL above the bar's high so it does not fill inside the entry bar
    const okEntry = b.enter('s1', { direction: 'short', entry: bar.close, sl: bar.high + 0.1, tp: bar.low - 0.1, riskAmount: 25 });
    ok(okEntry.ok === true && okEntry.position !== null, 'entry within the current bar accepted (position open)');
}

// 4 · scoring — blended, rewards process not oversizing
{
    // seat A: two 2R winners, consistent $25 risk → net $100
    // seat B: a 5R winner on $100 then a -1R loss on $200 → net $300 (higher!)
    //        but inconsistent risk + drawdown → blended score must still rank A higher
    const b = newBattle();
    b._ensureSeats();
    b.setCursor(20);
    b.enter('s0', { direction: 'long', entry: 104, sl: 103, tp: 106, riskAmount: 25 });
    b.enter('s1', { direction: 'long', entry: 104, sl: 103, tp: 109, riskAmount: 100 });
    b.setCursor(45);   // A TP@106 (bar 28) + B TP@109 (bar 43) both hit
    b.enter('s0', { direction: 'long', entry: 109, sl: 108, tp: 111, riskAmount: 25 });
    b.enter('s1', { direction: 'short', entry: 109, sl: 110.5, tp: 106, riskAmount: 200 });
    b.setCursor(55);   // A TP@111 (bar 53); B SL@110.5 (bar 50)
    b.status = 'completed'; b.completedAt = new Date().toISOString();
    const lb = b.leaderboard();
    const a = lb.seats.find(r => r.seat === 's0'), c = lb.seats.find(r => r.seat === 's1');
    ok(a.detail.trades === 2 && c.detail.trades === 2, 'both seats recorded two trades');
    ok(c.detail.net > a.detail.net, 'oversized seat has higher net ($' + c.detail.net + ' vs $' + a.detail.net + ')');
    ok(a.detail.riskCV < c.detail.riskCV, 'consistent-risk seat has lower risk CV');
    ok(a.score > c.score, 'blended score ranks the consistent seat ABOVE the oversized one (' + a.score + ' vs ' + c.score + ')');
}

// 5 · teams + leaderboard reveal
{
    const b = newBattle();
    b._ensureSeats();
    b.setCursor(25);
    b.enter('s0', { direction: 'long', entry: 105, sl: 104, tp: 108, riskAmount: 25 });
    b.setCursor(40);
    b.status = 'completed'; b.completedAt = new Date().toISOString();
    const lb = b.leaderboard();
    ok(lb.seats[0].trades.length === 1, 'leaderboard reveals the seat trades after completion');
    ok(lb.byTeam.some(t => t.team === 'ICT') && lb.byTeam.some(t => t.team === 'SMC'), 'both teams aggregated');
    ok(lb.byTeam.every(t => typeof t.score === 'number'), 'team scores computed');
    // private state hides opponent trades before completion
    const pre = newBattle();
    pre._ensureSeats();
    pre.setCursor(25);
    pre.enter('s0', { direction: 'long', entry: 105, sl: 104, tp: 108, riskAmount: 25 });
    const st1 = pre.seatState('s1');
    ok(st1.trades.length === 0, 'opponent trades stay hidden while the battle runs');
}

// 6 · persistence — save / reload / delete
{
    const b = newBattle({ status: 'lobby' });
    Battle.saveBattle('u-host', b);
    ok(Battle.listBattles('u-host').length === 1, 'battle listed');
    const r = Battle.getBattle('u-host', b.id);
    ok(r && r.title === 'ICT vs SMC' && r.seats.length === 3, 'battle reloaded with seats');
    Battle.deleteBattle('u-host', b.id);
    ok(Battle.listBattles('u-host').length === 0, 'battle deleted');
}

// 7 · event bus — mutations notify subscribers (the WS hub listens here)
{
    const seen = [];
    const unsub = Battle.subscribe((type, b) => seen.push(type + ':' + b.id));
    const b = newBattle({ status: 'lobby' });
    Battle.saveBattle('u-host', b);
    Battle.play('u-host', b.id, 60);
    await new Promise(r => setTimeout(r, 250));
    Battle.pause('u-host', b.id);
    Battle.complete('u-host', b.id);
    unsub();
    ok(seen.length >= 3, 'event bus delivered cursor/status events (' + seen.length + ')')
    ok(seen.some(s => s.indexOf('cursor:') === 0), 'cursor events emitted');
    ok(seen.some(s => s.indexOf('status:') === 0), 'status events emitted');
    Battle.deleteBattle('u-host', b.id);
}

// 8 · dashboard feed — active / invites / last-7-days results, all derived
{
    const b1 = newBattle({ status: 'lobby', title: 'Lobby Battle' });
    const b2 = newBattle({ status: 'running', title: 'Running Battle' });
    const b3 = newBattle({ status: 'completed', title: 'Done Battle', completedAt: new Date().toISOString() });
    Battle.saveBattle('u-host', b1);
    Battle.saveBattle('u-host', b2);
    Battle.saveBattle('u-host', b3);
    const feed = Battle.battlesFeed('u-host');
    ok(Array.isArray(feed.active) && Array.isArray(feed.invites) && Array.isArray(feed.results), 'feed shape (active/invites/results)');
    ok(feed.active.some(x => x.id === b1.id) || feed.invites.some(x => x.id === b1.id), 'lobby battle appears in feed');
    ok(feed.active.some(x => x.id === b2.id) || feed.invites.some(x => x.id === b2.id), 'running battle appears in feed');
    const done = feed.results.find(x => x.id === b3.id);
    ok(!!done && !!done.winner, 'completed battle has a winner in results');
    ok(done.winner.name === 'Alex', 'winner is the top-scoring seat');
    // a battle the user hosts but is NOT seated in (free seats) shows as an invite
    const b4 = newBattle({ status: 'running', title: 'Open Seats', seats: [
        { id: 's0', name: 'Alex', team: 'ICT' },
        { id: 's1', name: 'Sam', team: 'SMC' }
    ] });
    Battle.saveBattle('u-host', b4);
    const feed3 = Battle.battlesFeed('u-host');
    ok(feed3.invites.some(x => x.id === b4.id), 'free-seat battle without my seat surfaces as an invite');
    Battle.deleteBattle('u-host', b4.id);
}

// 9 · invites — codes resolve cross-user and surface as pending invitations
{
    const b = newBattle({ status: 'lobby', title: 'Invite Battle' });
    Battle.saveBattle('u-host', b);
    ok(b.inviteCode && b.inviteCode.length >= 6, 'battle has a shareable invite code');
    const found = Battle.battleByCode(b.inviteCode);
    ok(found && found.hostId === 'u-host' && found.battle.id === b.id, 'invite code resolves to the battle via registry');
    ok(Battle.battleByCode('NOPE123') === null, 'unknown code resolves to null');
    // invitation record for a guest
    Battle.addInvite('u-guest', b.id, b.inviteCode);
    const invs = Battle.pendingInvites('u-guest');
    ok(invs.length === 1 && invs[0].battleId === b.id, 'pending invitation recorded for the guest');
    ok(invs[0].free === 2, 'invitation reports open seats');
    // persistence round-trip
    const invs2 = Battle.pendingInvites('u-guest');
    ok(invs2.length === 1, 'invitations persist across reads');
    Battle.clearInvite('u-guest', b.id);
    ok(Battle.pendingInvites('u-guest').length === 0, 'invitation dismissed');
    Battle.deleteBattle('u-host', b.id);
}

console.log('\n' + (failCount ? 'FAILED: ' + failCount + ' / ' + (okCount + failCount) : 'ALL PASS: ' + okCount + ' checks'));
process.exit(failCount ? 1 : 0);

})().catch(e => { console.error('RUN ERROR: ' + e.message); process.exit(1); });
