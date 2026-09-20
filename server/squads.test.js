'use strict';

// ============================================================================
// Social layer · squads tests (server/squads.js)
// ----------------------------------------------------------------------------
// Contract:
//   · one squad per trader; tag + name are validated and tags are unique
//   · a squad code is the only way in, and it is only readable by members
//   · squad totals aggregate the whole team, while member rows expose ONLY what
//     each trader's profile allows — a private member is "Private trader"
//   · the owner leaving hands the squad over; the last member out dissolves it
// No DB, no network — file-only, throwaway directory.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

delete process.env.SUPABASE_DB_URL;          // force the file fallback path

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'squads-test-'));
process.env.TRADEMIND_SOCIAL_DATA_DIR = TMP;

const Squads = require('./squads.js');
const Profiles = require('./profiles.js');
const Leaderboard = require('./leaderboard.js');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ok  ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
}
const close = (a, b) => Math.abs(a - b) <= 0.011;

const DAY = 864e5;
const mkCore = (nWins, pnl, r) => ({
    Trades: Array.from({ length: 12 }, (_, i) => ({
        id: 't' + i, account_id: 'acc-live', source: 'LIVE',
        ts: new Date(Date.now() - (i + 1) * DAY).toISOString(),
        symbol: 'XAUUSD', dir: 'Long', pnl: i < nWins ? pnl : -Math.abs(pnl) / 2, r: i < nWins ? r : -r / 2, risk: 25
    })),
    Accounts: [{ id: 'acc-live' }],
    disciplineState: () => ({ score: 70 })
});

// make a trader public (or private) and publish their standings
async function trader(userId, handle, isPublic, nWins, pnl, r) {
    await Profiles.save(userId, {
        handle, displayName: handle,
        visibility: { public: isPublic === true }
    });
    await Leaderboard.publish(userId, {
        core: mkCore(nWins, pnl, r),
        profile: await Profiles.get(userId),
        force: true
    });
}

console.log('\n== Squads ==');

(async () => {

// ---- 1 · creation rules -----------------------------------------------------
{
    ok((await Squads.create('s-owner', { name: 'A', tag: 'ALPHA' })).ok === false, 'a 1-char name is refused');
    ok((await Squads.create('s-owner', { name: 'Alpha Desk', tag: 'X' })).ok === false, 'a 1-char tag is refused');
    ok((await Squads.create('s-owner', { name: 'Alpha Desk', tag: '?!' })).ok === false, 'a non-alphanumeric tag is refused');

    const r = await Squads.create('s-owner', { name: 'Alpha Desk', tag: 'alp' });
    ok(r.ok === true, 'a valid squad is created');
    ok(r.view.squad.tag === 'ALP', 'the tag is normalized to upper case');
    ok(/^[A-Z0-9]{6}$/.test(r.view.squad.inviteCode || r.view.inviteCode), 'a 6-char invite code is generated');
    ok(r.view.squad.ownerId === 's-owner' && r.view.isOwner === true, 'the creator owns the squad');
    ok(r.view.squad.memberCount === 1, 'the creator is the first member');

    const dupeTag = await Squads.create('s-other', { name: 'Beta Desk', tag: 'alp' });
    ok(dupeTag.ok === false && /tag/i.test(dupeTag.error), 'a duplicate tag is refused');

    const mineAgain = await Squads.create('s-owner', { name: 'Second', tag: 'SEC' });
    ok(mineAgain.ok === false && /already in a squad/i.test(mineAgain.error), 'a trader cannot create a second squad');
}

// ---- 2 · join / leave / capacity -------------------------------------------
{
    const code = (await Squads.mine('s-owner')).inviteCode;
    const bad = await Squads.join('s-bob', 'NOPE99');
    ok(bad.ok === false && /invalid squad code/i.test(bad.error), 'an unknown code is refused');

    const joined = await Squads.join('s-bob', code.toLowerCase());
    ok(joined.ok === true && joined.view.squad.memberCount === 2, 'a trader can join with a case-insensitive code');
    ok(joined.view.isMember === true && joined.view.isOwner === false, 'the joiner is a member, not the owner');
    ok(/^[A-Z0-9]{6}$/.test(joined.view.inviteCode), 'a member can read the invite code');
    ok((await Squads.view((await Squads.mine('s-owner')).id, {})).inviteCode === null, 'an anonymous view never leaks the code');

    const twice = await Squads.join('s-bob', code);
    ok(twice.ok === false, 'joining twice is refused');

    const left = await Squads.leave('s-bob');
    ok(left.ok === true, 'leaving succeeds');
    ok((await Squads.mine('s-bob')) === null, 'the leaver holds no squad');
    ok((await Squads.membersOf((await Squads.mine('s-owner')).id)).length === 1, 'the squad is back to one member');

    // capacity: fill to MAX_MEMBERS then refuse the next joiner
    const id = (await Squads.mine('s-owner')).id;
    for (let i = 1; i < Squads.MAX_MEMBERS; i++) {
        const r = await Squads.join('fill-' + i, code);
        if (!r.ok) { ok(false, 'filling member ' + i + ' failed: ' + r.error); break; }
    }
    ok((await Squads.membersOf(id)).length === Squads.MAX_MEMBERS, 'the squad fills to the cap');
    const over = await Squads.join('fill-over', code);
    ok(over.ok === false && /full/i.test(over.error), 'a full squad refuses new members');
}

// ---- 3 · standings: totals include the team, member rows respect privacy ----
{
    // fresh squad for clean numbers
    await Squads.leave('s-owner');
    for (let i = 1; i < Squads.MAX_MEMBERS; i++) await Squads.leave('fill-' + i);

    const created = await Squads.create('std-owner', { name: 'Standings Test', tag: 'STD' });
    const code = created.view.inviteCode;
    await trader('std-owner', 'std-owner', true, 9, 100, 1);
    await trader('std-pub', 'std-mate', true, 9, 100, 1);
    await trader('std-priv', 'std-hidden', false, 12, 100, 1);
    await Squads.join('std-pub', code);
    await Squads.join('std-priv', code);

    const v = await Squads.view(created.view.squad.id, { userId: 'std-owner', range: 'all', minTrades: 3 });
    ok(v.squad.memberCount === 3, 'all three members are counted');
    ok(v.totals.trades === 36, 'squad totals aggregate every member\'s ledger (36 trades)');
    // std-owner + std-pub: 9 wins × $100 − 3 losses × $50 = +$750 each
    // std-priv: 12 wins × $100 = +$1,200 → team total $2,700
    ok(close(v.totals.net, 2700), 'squad net P&L is the team total');
    ok(v.bxScore > 0, 'the squad carries its own blended score');

    const priv = v.members.find(m => m.userId === 'std-priv');
    ok(priv.public === false && priv.handle === null, 'a private member is anonymous');
    ok(priv.displayName === 'Private trader', 'a private member is labelled, not named');
    ok(priv.metrics === null && priv.bxScore === null, 'a private member exposes no metrics');
    ok(JSON.stringify(v.members).indexOf('std-hidden') === -1, 'a private member\'s handle never appears');

    const pub = v.members.find(m => m.userId === 'std-pub');
    ok(pub.public === true && pub.handle === 'std-mate' && pub.metrics.trades === 12, 'a public member exposes their masked metrics');
    ok(v.members.filter(m => m.role === 'owner').length === 1, 'exactly one owner is reported');
    ok(v.leader && v.leader.public === true, 'the squad leader is a public member');

    // a member that hides net is respected inside the squad too
    await Profiles.save('std-pub', { visibility: { public: true, showNet: false } });
    const v2 = await Squads.view(created.view.squad.id, { userId: 'std-owner', range: 'all', minTrades: 3 });
    ok(v2.members.find(m => m.userId === 'std-pub').metrics.net === null, 'a member hiding net shows no net inside the squad');
    ok(close(v2.totals.net, 2700), 'the team total still reflects the ledger');
}

// ---- 4 · owner handover + dissolution --------------------------------------
{
    const id = (await Squads.mine('std-owner')).id;
    const left = await Squads.leave('std-owner');
    ok(left.ok === true, 'the owner can leave');
    ok(left.ownerHandedTo === 'std-pub', 'ownership is handed to the remaining member');
    const after = await Squads.mine('std-pub');
    ok(after && after.ownerId === 'std-pub', 'the handed-over owner is persisted');

    await Squads.leave('std-pub');   // last member out of a 2-member squad after priv leaves
    await Squads.leave('std-priv');
    ok((await Squads.byId(id)) === null, 'the squad dissolves when the last member leaves');
    ok((await Leaderboard.entryFor('std-owner')).squadId === null, 'leaving clears the standings squad pointer');
}

// ---- 5 · disband is owner-only ---------------------------------------------
{
    const created = await Squads.create('db-owner', { name: 'Disband Me', tag: 'DBD' });
    const id = created.view.squad.id;
    await Squads.join('db-mate', created.view.inviteCode);
    const denied = await Squads.disband('db-mate', id);
    ok(denied.ok === false && /owner/i.test(denied.error), 'a member cannot disband the squad');

    const done = await Squads.disband('db-owner', id);
    ok(done.ok === true && done.released === 2, 'the owner disbands and members are released');
    ok((await Squads.byId(id)) === null, 'the disbanded squad is gone');
    ok((await Squads.mine('db-mate')) === null, 'released members hold no squad');
    ok((await Squads.byId('sqd_nope')) === null, 'an unknown id resolves to null');
}

// ---- 6 · directory + persistence -------------------------------------------
{
    const created = await Squads.create('dir-owner', { name: 'Directory Desk', tag: 'DIR' });
    const listing = await Squads.list('dir-owner');
    ok(listing.mine && listing.mine.tag === 'DIR', 'the directory reports the caller\'s own squad');
    ok(listing.squads.some(s => s.tag === 'DIR' && s.members === 1), 'the directory lists squads with member counts');
    ok(!('inviteCode' in listing.squads[0]), 'the public directory never exposes invite codes');

    const f = path.join(TMP, 'squads.json');
    ok(fs.existsSync(f), 'squads are mirrored to the per-store JSON file');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok(raw.squads[created.view.squad.id] && raw.members['dir-owner'] === created.view.squad.id, 'squad + membership persist');
    const reloaded = require('./squads.js');
    ok(!!(await reloaded.byCode(created.view.inviteCode)), 'a squad survives a module reload (lookup by code)');
}

console.log('\n' + (fail === 0 ? 'ALL SQUAD CHECKS PASS' : fail + ' SQUAD CHECKS FAILED') + ' (' + pass + ' ok)\n');
process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('SQUAD TEST CRASH:', err); process.exit(1); });
