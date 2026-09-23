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

// 12 · delivery modes — the chart loads the whole revealed month once, then deltas
//      only. No mode may ever ship an unrevealed (future) candle.
{
    const b = newBattle({ candleWindow: 400 });
    b._ensureSeats();
    b.setCursor(30);
    const full = b.seatState('s1', { full: true });
    ok(full.candles.length === 31 && full.candlesFrom === 0, 'full=1 delivers every revealed bar from bar 0');
    ok(full.candles[full.candles.length - 1].time === b.candles[30].time, 'last delivered bar is the cursor bar');
    ok(full.candlesTotal === 31, 'full delivery reports the revealed count');
    const none = b.seatState('s1', { from: 31 });
    ok(none.candles.length === 0 && none.candlesFrom === 31, 'from=<end> returns nothing when no new bar exists');
    b.setCursor(35);
    const delta = b.seatState('s1', { from: 31 });
    ok(delta.candles.length === 5 && delta.candlesFrom === 31, 'from=N returns only the newly revealed bars');
    ok(delta.candles[0].time === b.candles[31].time, 'delta starts exactly after N');
    const small = b.seatState('s1', { window: 5 });
    ok(small.candles.length === 36 && small.candlesFrom === 0, 'tiny window is floored at 60 bars (never truncates below the floor)');
    const big = newBattle({ candles: makeCandles(200), startIndex: 10, candleWindow: 400 });
    big._ensureSeats();
    big.setCursor(150);
    const tail = big.seatState('s1', { window: 60 });
    ok(tail.candles.length === 60 && tail.candlesFrom === 91, 'explicit window still returns the bounded tail once the month is longer');
    const clamped = b.seatState('s1', { from: 9999 });
    ok(clamped.candles.length === 0 && clamped.candlesFrom === 36, 'from beyond the cursor clamps to the revealed edge');
    const all = b.seatState('s1', { window: 'all' });
    ok(all.candles.length === 36 && all.candlesFrom === 0, 'window=all delivers the whole revealed month');
    const rewound = (function () { b.setCursor(12); return b.seatState('s1', { from: 36 }); })();
    ok(rewound.candles.length === 0 && rewound.candlesFrom === 13, 'rewind clamps delivery to the new revealed edge (no future leak)');
    ok(b.seatState('s1', { full: true }).candles.length === 13, 'full delivery follows the rewound cursor');
}

// 13 · configuration contract — an un-runnable configuration is refused, loudly
{
    const b = newBattle({ config: { settlement: { policy: 'fixed-bars', bars: 10 } } });
    ok(b.policyBlockers.length === 1, 'the engine records why the configuration cannot run');
    ok(b.publicState('u-host').runnable === false, 'public state reports the battle as not runnable');
    ok(b.start().ok === false, 'start() is refused');
    Battle.saveBattle('u-host', b);
    const r = Battle.step('u-host', b.id);
    ok(r.ok === false && /cannot run/.test(r.error), 'the replay driver refuses to advance an un-runnable battle');
    ok(Array.isArray(r.blockers) && r.blockers.length === 1, 'the refusal names the blocker');
    Battle.deleteBattle('u-host', b.id);
    const t = newBattle();
    ok(t.transition('halftime').ok === false, 'an unknown lifecycle state is rejected');
    ok(t.transition('ready').ok === true, 'a declared lifecycle state is accepted');
    ok(t.publicState('u-host').endCondition.policy === 'timeline-exhausted', 'the active ending condition is reported');
    ok(t.config.visibility.policy === 'presence', 'an unconfigured battle stores the presence visibility default');
    // The scoring adapter comes from the contract, not from the caller: passing
    // an explicit null (as the old API client did) must not silently strip the
    // score and leave a completed battle with no ranking at all.
    const nulled = newBattle({ scoringPolicy: null });
    ok(nulled.scoringPolicy && nulled.scoringPolicy.provisional === true, 'a null scoring policy still yields the provisional adapter');
    ok(nulled.publicState('u-host').scoring.status === 'provisional', 'the provisional flag is surfaced to clients');
    nulled._ensureSeats();
    nulled.setCursor(20);
    nulled.enter('s0', { direction: 'long', entry: 104, sl: 103, tp: 107, riskAmount: 25 });
    nulled.setCursor(40);
    nulled.transition('results');
    ok(typeof nulled.leaderboard().seats[0].score === 'number', 'a completed battle still ranks its seats');
}

// 14 · opponent state sync — the server filters every field by the policy
{
    const px = 100 + 0.2 * 20;
    const preset = { direction: 'short', sl: px + 5, tp: px - 5, riskAmount: 25 };
    const b = newBattle();
    b._ensureSeats();
    b.seat('s1').userId = 'u-sam';       // the opponent has claimed their seat
    b.setCursor(20);
    b.enter('s1', Object.assign({ entry: px }, preset));
    const fromHost = b.participants('u-host');
    const opp = fromHost.find(p => p.id === 's1');
    ok(opp.claimed === true && opp.presence.state === 'active', 'opponent presence is synchronized (they acted on this bar)');
    ok(opp.status === undefined && opp.direction === undefined && opp.equity === undefined && opp.tradeList === undefined,
        'nothing about the opponent position leaks under the default policy');
    ok(Object.keys(opp).sort().join(',') === 'claimed,id,mine,name,presence,team', 'the default projection is identity + presence only');
    ok(fromHost.find(p => p.id === 's0').status === 'flat', 'your own seat is never filtered');
    ok(b.visibility().hidden.indexOf('direction') !== -1 && b.visibility().mode === 'presence', 'the state names what the policy hides');

    const c = newBattle({ config: { visibility: { mode: 'custom', fields: ['presence', 'status', 'direction', 'pnl'] } } });
    c._ensureSeats();
    c.seat('s1').userId = 'u-sam';
    c.setCursor(20);
    c.enter('s1', Object.assign({ entry: px }, preset));
    const opp2 = c.participants('u-host').find(p => p.id === 's1');
    ok(opp2.status === 'in_trade' && opp2.direction === 'Short', 'a custom policy exposes exactly the declared fields');
    ok(opp2.risk === undefined && opp2.tradeList === undefined, 'and nothing it does not declare');
    ok(opp2.equity === 10000 && opp2.trades === 0, 'declared pnl fields are derived server-side from the seat session');

    const f = newBattle({ config: { visibility: { mode: 'full' } } });
    f._ensureSeats();
    const opp3 = f.participants('u-host').find(p => p.id === 's1');
    ok(Array.isArray(opp3.tradeList) && typeof opp3.realized === 'number', 'the full policy can report closed trades and realized P&L');
}

// 15 · presence — derived, spoof-proof, and the only always-synced signal
{
    const b = newBattle();
    b._ensureSeats();
    ok(b.presenceOf(b.seat('s1')).state === 'unclaimed', 'an unclaimed seat reports no presence');
    b.seat('s1').userId = 'u-sam';
    ok(b.presenceOf(b.seat('s1')).state === 'waiting', 'a claimed seat that was never seen is waiting');
    ok(b.markSeatSeen('s1', 'u-sam') === true, 'a seat reading its own state marks it seen');
    ok(b.presenceOf(b.seat('s1')).state === 'online', 'a recent heartbeat reads online');
    ok(b.markSeatSeen('s1', 'u-host') === false, 'another user cannot spoof a seat heartbeat');
    b.setCursor(20);
    b.enter('s1', { direction: 'short', entry: 104, sl: 104.5, tp: 103.5, riskAmount: 25 });
    ok(b.presenceOf(b.seat('s1')).state === 'active', 'acting on the shared cursor marks a seat active');
    b.setCursor(60);
    b.seat('s1').activity.seenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    ok(b.presenceOf(b.seat('s1')).state === 'offline', 'a stale heartbeat reads offline');
}

// 16 · settlement — the battle becomes a first-class trading dataset
{
    const b = newBattle({ period: '2024-06', periodLabel: 'June 2024' });
    b._ensureSeats();
    b.setCursor(20);
    b.enter('s0', { direction: 'long', entry: 104, sl: 103, tp: 107, riskAmount: 25, setup: 'Breakout' });
    b.setCursor(40);
    const trades = b.canonicalTrades();
    ok(trades.length === 1, 'the battle exposes its trades as a canonical dataset');
    const t = trades[0];
    ok(t.source === 'BATTLE' && t.account_id === 'battle' && t.battle_id === b.id, 'canonical rows are tagged BATTLE and keyed to the battle');
    ok(t.seat === 's0' && t.seat_name === 'Alex' && t.team === 'ICT', 'canonical rows carry seat identity for team/competition analytics');
    ok(t.symbol === 'EURUSD' && t.dir === 'Long' && t.risk === 25 && typeof t.r === 'number' && typeof t.holdBars === 'number',
        'canonical rows use the same shape as practice backtesting');
    ok(t.exitReason === 'TP' && t.pnl > 0 && t.period === '2024-06', 'fills, P&L and the archive month travel with the trade');
    ok(b.canonicalTrades('s1').length === 0, 'a seat-level dataset filter works');

    // end of the canonical timeline → the engine's ending condition is satisfied
    ok(b.endCondition().met === false, 'the ending condition is not met mid-timeline');
    b.setCursor(59);
    ok(b.endCondition().met === true, 'the ending condition is met at the last canonical bar');
    b.transition('results');
    b.completedAt = new Date().toISOString();
    const rec = b.settlementRecord('u-host');
    ok(rec.battle.id === b.id && rec.battle.lifecycle === b.lifecycle, 'the settlement record identifies the battle and its lifecycle');
    ok(rec.market.period === '2024-06' && rec.market.totalBars === 60 && rec.market.revealedBars === 60, 'the record pins the exact market context');
    ok(rec.market.startTimestamp === b.candles[b.startIndex].time && rec.market.endTimestamp === b.candles[b.cursor].time,
        'the record pins the historical start and end timestamps');
    ok(rec.settlement.policy === 'timeline-exhausted' && rec.settlement.reached === true, 'the record states how the battle ended');
    ok(rec.players.length === 3 && rec.players.every(p => p.presence), 'every player is listed with presence');
    ok(rec.players.find(p => p.id === 's0').trades === 1, 'the FINAL record opens the fields the live battle hid');
    ok(rec.results.seats.length === 3 && rec.trades.length === 1 && rec.events.length > 0, 'the record carries results, the dataset and the event log');
    ok(rec.config.visibility.policy === 'presence', 'the record keeps the configuration that produced it');
}

// 17 · challenges — availability → matching → lobby, with no invented rules
{
    const ch = Battle.createChallenge('u-a', 'u-b', { market: { symbol: 'XAUUSD', timeframe: '15m', period: '2024-06' } }, { message: 'NY open' });
    ok(ch.ok === true && ch.challenge.status === 'pending', 'a pending challenge is created');
    ok(ch.challenge.config.market.policy === 'archive-month' && ch.challenge.config.market.period === '2024-06', 'the challenge carries a validated configuration');
    ok(Battle.getAvailability('u-a').status === 'available', 'challenging marks the challenger available (discovery → matching)');
    ok(Battle.pendingChallengesFor('u-b').incoming.length === 1, 'the offer is incoming for the challenged player');
    ok(Battle.pendingChallengesFor('u-a').outgoing.length === 1, 'and outgoing for the challenger');
    ok(Battle.resolveChallenge('u-a', ch.challenge.id, 'accept').ok === false, 'the challenger cannot accept their own offer');
    ok(Battle.createChallenge('u-a', 'u-a', {}).ok === false, 'self-challenge is refused');
    const bad = Battle.createChallenge('u-a', 'u-b', { settlement: { policy: 'fixed-bars' } });
    ok(bad.ok === false && /not implemented/.test(bad.error), 'a challenge cannot carry an unimplemented policy');
    const ch2 = Battle.createChallenge('u-a', 'u-b', {});
    ok(Battle.getChallenge(ch.challenge.id).status === 'superseded', 'a newer offer supersedes the older one');
    const acc = Battle.resolveChallenge('u-b', ch2.challenge.id, 'accept');
    ok(acc.ok === true && acc.challenge.status === 'accepted', 'the challenged player accepts');
    ok(Battle.getAvailability('u-a').status === 'in_battle' && Battle.getAvailability('u-b').status === 'in_battle', 'accepting commits BOTH players to a battle');
    ok(Battle.linkChallengeBattle(ch2.challenge.id, 'btl_linked') === true && Battle.getChallenge(ch2.challenge.id).battleId === 'btl_linked', 'the created battle is linked back to the challenge');
    ok(Battle.resolveChallenge('u-b', ch2.challenge.id, 'decline').ok === false, 'a resolved challenge cannot be re-answered');

    // an expired offer disappears from both inboxes
    const ch3 = Battle.createChallenge('u-a', 'u-b', {});
    const cfile = path.join(TMP, 'battle-challenges.json');
    const map = JSON.parse(fs.readFileSync(cfile, 'utf8'));
    map[ch3.challenge.id].expiresAt = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(cfile, JSON.stringify(map));
    ok(Battle.pendingChallengesFor('u-b').incoming.every(x => x.id !== ch3.challenge.id), 'an expired challenge is dropped from the inbox');
    ok(Battle.getChallenge(ch3.challenge.id).status === 'expired', 'and is marked expired rather than silently deleted');

    // quick battle — placeholder picker, longest-waiting player first
    Battle.setAvailability('u-c1', 'available');
    await new Promise(r => setTimeout(r, 8));
    Battle.setAvailability('u-c2', 'available');
    ok(Battle.pickQuickOpponent('u-a') === 'u-c1', 'quick battle picks the longest-waiting available player');
    ok(Battle.pickQuickOpponent('u-c1') !== 'u-c1', 'you are never matched with yourself');
    ok(Battle.availableOpponents('u-a').every(r => r.status === 'available'), 'the picker only considers players who said they are available');
}

// 18 · battle history — not time-boxed, and only battles you are part of
{
    const done = newBattle({ title: 'Historic win' });
    done._ensureSeats();
    done.setCursor(20);
    done.enter('s0', { direction: 'long', entry: 104, sl: 103, tp: 107, riskAmount: 25, setup: 'Breakout' });
    done.setCursor(40);
    done.transition('results');
    done.completedAt = new Date().toISOString();
    Battle.saveBattle('u-host', done);
    const h = Battle.battleHistory('u-host', { limit: 50 });
    const row = h.battles.find(x => x.id === done.id);
    ok(!!row, 'a completed battle appears in my history');
    ok(row.mySeat === 's0' && row.myTrades === 1 && typeof row.myScore === 'number', 'history carries my own row from the final leaderboard');
    ok(row.winner && row.winner.name === 'Alex' && row.scoring.status === 'provisional', 'history names the winner and flags provisional scoring');
    ok(typeof h.total === 'number' && h.total >= 1, 'history reports a total');
    const foreign = newBattle({
        status: 'completed', completedAt: new Date().toISOString(), hostId: 'u-other',
        seats: [{ id: 's0', name: 'Someone else', userId: 'u-someone' }, { id: 's1', name: 'Another', userId: 'u-another' }]
    });
    Battle.saveBattle('u-other', foreign);
    ok(Battle.battleHistory('u-host', { limit: 50 }).battles.every(x => x.id !== foreign.id), 'battles I am not part of are excluded from my history');
    ok(Battle.battleHistory('u-host', { status: 'running', limit: 50 }).battles.every(x => x.status === 'running'), 'history can be filtered by status');
    Battle.deleteBattle('u-host', done.id);
    Battle.deleteBattle('u-other', foreign.id);
}

// 19 · extensibility seam — a new ending condition needs TWO explicit steps
{
    ok(Battle.registerEndCondition('bars-remaining', bb => ({ met: bb.cursor >= bb.startIndex + 2 })) === true, 'an ending-condition evaluator can be registered');
    const b = newBattle({ config: { settlement: { policy: 'bars-remaining' } } });
    ok(b.endCondition().policy === 'bars-remaining', 'the config selects the new policy');
    ok(b.endCondition().met === false, 'it does not fire early');
    b.cursor = b.startIndex + 2;
    ok(b.endCondition().met === true, 'it fires exactly where its own rule says');
    ok(Battle.runnable(b).ok === false, 'the engine STILL refuses to run it: registering an evaluator is not the same as declaring a policy implemented');
    delete Battle.END_CONDITIONS['bars-remaining'];
    const unknown = newBattle({ config: { settlement: { policy: 'specify-later' } } });
    ok(unknown.endCondition().met === false && /not implemented/.test(unknown.endCondition().error), 'an unimplemented ending condition can never silently end (or never end) a battle');
    ok(unknown.policyBlockers.length === 1, 'and it blocks the battle');
    const cap = Battle.capabilities();
    ok(cap.version === Battle.BattleConfig.CONFIG_VERSION && cap.specified === false, 'the API catalogue is served from the same contract');
}

// 20 · the timeline model — one canonical resolution, one shared cut time, free
// display timeframes. The backend must never dictate what a seat may look at.
{
    const t0 = Date.UTC(2024, 5, 17, 10, 0, 0);
    const mins = [];
    for (let i = 0; i < 40; i++) {
        const px = 100 + i;
        mins.push({ time: t0 + i * 60000, open: px, high: px + 2, low: px - 2, close: px + 1, volume: 10 });
    }
    const b = newBattle({ candles: mins, baseTimeframe: '1m', startingTimeframe: '15m', startIndex: 0, cursor: 17 });
    b._ensureSeats();

    // canonical times are normalized once, at the boundary (the market-data layer
    // hands out epoch SECONDS; the timeline maths needs milliseconds)
    const hourly = newBattle();
    ok(hourly.candles[0].time > 1e11, 'canonical candle times are milliseconds even when the source is seconds');
    ok(hourly.candles[1].time - hourly.candles[0].time === 3600000, 'normalization preserves the interval');

    const tl = b.timelineState();
    ok(tl.baseTimeframe === '1m' && tl.baseMs === 60000, 'the battle reports its canonical resolution');
    ok(tl.startingTimeframe === '15m', 'and the timeframe the chart opens on');
    ok(tl.cutTime === t0 + 17 * 60000, 'cutTime is the open time of the canonical bar at the cursor');
    ok(tl.revealedBars === 18 && tl.totalBars === 40, 'revealed vs total bars are reported');
    ok(b.publicState('u-host').timeline.cutTime === tl.cutTime, 'public state exposes the same market moment');

    // display series: complete bars carry real OHLC, the bar at the cut is forming
    const q = b.seriesAt('15m');
    ok(q.ok && q.timeframeMs === 900000, 'any COARSER timeframe can be built from the canonical bars');
    ok(q.total === 2 && q.complete === 1 && q.forming === true, 'the completed bars are counted separately from the forming one');
    const first = q.bars[0], forming = q.bars[1];
    ok(first.time === t0 && first.complete === true && first.baseBars === 15, 'a complete bar aggregates its whole window');
    ok(first.high === 116 && first.low === 98 && first.close === 115, 'and reports the real high/low/close of that window');
    ok(forming.time === t0 + 900000 && forming.complete === false && forming.baseBars === 3, 'the bar covering the cut is marked forming');
    // the leak this guards: the FULL 15m window would top out at 131 (a price 12
    // minutes into the future). A forming bar may only know what was revealed.
    ok(forming.high === 119 && forming.high < 131, 'a forming bar is built ONLY from revealed bars — no future leak');
    ok(forming.time <= tl.cutTime && tl.cutTime < forming.time + 900000, 'the forming bar contains the market moment');

    // the canonical resolution itself is fully revealed bar by bar
    const oneMin = b.seriesAt('1m');
    ok(oneMin.total === 18 && oneMin.complete === 18 && oneMin.forming === false, 'the canonical series is complete up to the cut');
    ok(oneMin.bars[oneMin.bars.length - 1].time === tl.cutTime, 'and its last bar IS the market moment');
    const tail = b.seriesAt('1m', { from: 15 });
    ok(tail.from === 15 && tail.bars.length === 3 && tail.total === 18, 'from= ships only the new bars while still reporting the total');

    // a finer resolution is refused by name, not silently substituted
    const finer = newBattle({ baseTimeframe: '15m', startingTimeframe: '15m' });
    const refused = finer.seriesAt('1m');
    ok(refused.ok === false && refused.error_code === 'finer-than-canonical', 'a timeframe finer than the canonical timeline is refused explicitly');
    ok(b.seriesAt('9m').error_code === 'unknown-timeframe', 'an unknown timeframe is refused');

    // two seats, two different display timeframes, ONE market moment
    const a = b.seatState('s0', { tf: '1m' });
    const c = b.seatState('s1', { tf: '15m' });
    ok(a.timeline.displayTimeframe === '1m' && c.timeline.displayTimeframe === '15m', 'each seat records its own display timeframe');
    ok(a.timeline.cutTime === c.timeline.cutTime && a.timeline.revealedBars === c.timeline.revealedBars, 'a display choice NEVER changes the market moment');
    ok(a.timeline.baseTimeframe === c.timeline.baseTimeframe && a.timeline.baseTimeframe === '1m', 'both seats share one canonical timeline');
    ok(b.seatState('s0', { tf: '4h' }).timeline.displayTimeframe === '4h', 'a seat may switch timeframe mid-battle');
    ok(b.seatState('s0', { tf: '7x' }).timeline.displayTimeframe === '4h', 'an unknown display timeframe is ignored rather than stored');
    const ser = b.serialize();
    ok(ser.baseTimeframe === '1m' && ser.startingTimeframe === '15m', 'the resolution survives persistence');
    ok(Battle.Battle.hydrate(ser).timelineState().cutTime === tl.cutTime, 'a hydrated battle keeps the same market moment');
}

// 21 · execution is pinned to the canonical timeline, so a seat's display
// timeframe can never widen (or narrow) what it is allowed to trade
{
    const t0 = Date.UTC(2024, 5, 17, 10, 0, 0);
    const mins = [];
    for (let i = 0; i < 20; i++) {
        const px = 100 + i;
        mins.push({ time: t0 + i * 60000, open: px, high: px + 2, low: px - 2, close: px + 1, volume: 10 });
    }
    const b = newBattle({ candles: mins, baseTimeframe: '1m', startingTimeframe: '15m', startIndex: 0, cursor: 17 });
    b._ensureSeats();
    const live = b.candles[b.cursor];
    ok(live.time === t0 + 17 * 60000 && live.high === 119, 'the canonical bar at the cut is the execution window');
    // 110 sits inside the 10:00 15m candle (98–116) that a 15m chart is showing,
    // but the canonical bar at the cut is 115–119: the display cannot buy there.
    const wide = b.enter('s0', { direction: 'long', entry: 110, sl: 105, tp: 120, riskAmount: 25 });
    ok(wide.ok === false && /within the current bar/.test(wide.error), 'an entry inside a coarser display bar but outside the canonical bar is refused');
    const fair = b.enter('s0', { direction: 'long', entry: live.close, sl: 115, tp: 125, riskAmount: 25 });
    ok(fair.ok === true, 'an entry at the market moment is accepted for every seat alike');
}

console.log('\n' + (failCount ? 'FAILED: ' + failCount + ' / ' + (okCount + failCount) : 'ALL PASS: ' + okCount + ' checks'));
process.exit(failCount ? 1 : 0);

})().catch(e => { console.error('RUN ERROR: ' + e.message); process.exit(1); });
