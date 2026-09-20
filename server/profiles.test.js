'use strict';

// ============================================================================
// Social layer · public profile tests (server/profiles.js)
// ----------------------------------------------------------------------------
// Contract: a trader is invisible until they opt in; handles are unique, clean
// and never reserved; every metric can be hidden individually; nothing but
// identity ever leaves the module (no email, no user id, no auth material).
// No DB, no network — the module runs file-only against a throwaway directory.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

delete process.env.SUPABASE_DB_URL;          // force the file fallback path

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
process.env.TRADEMIND_SOCIAL_DATA_DIR = TMP;

const Profiles = require('./profiles.js');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ok  ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
}

console.log('\n== Profiles ==');

(async () => {

// ---- 1 · a brand-new trader is private and handle-less ----------------------
{
    const p = await Profiles.get('u-new');
    ok(p.visibility.public === false, 'new profile defaults to private');
    ok(p.handle === null, 'new profile has no handle');
    ok(Profiles.metricAllowed(p, 'net') === false, 'private profile is eligible for no metric');
    const allowed = Profiles.allowedMetrics(p);
    ok(Object.values(allowed).every(v => v === false), 'allowedMetrics all false while private');
}

// ---- 2 · handle validation --------------------------------------------------
{
    const bad = ['ab', '---', '__', 'admin', 'support', 'root'];
    for (const h of bad) {
        const r = await Profiles.save('u-bad', { handle: h });
        ok(r.ok === false, 'handle rejected: ' + JSON.stringify(h));
    }
    // messy but salvageable input is normalized, not refused
    const messy = await Profiles.save('u-bad', { handle: '  @Gold Trader  ' });
    ok(messy.ok === true && messy.profile.handle === 'gold-trader', 'messy handle is normalized to a clean slug');
    // over-long input is clamped to the 24-char limit
    const long = await Profiles.save('u-bad', { handle: 'z'.repeat(30) });
    ok(long.ok === true && long.profile.handle.length === Profiles.LIMITS.handle, 'over-long handle is clamped to 24 chars');
    ok(Profiles.handleError('ab') !== null, 'handleError flags a short handle');
    ok(Profiles.handleError('admin') !== null, 'handleError flags a reserved handle');
    ok(Profiles.handleError('gold-trader') === null, 'handleError accepts a clean handle');
    ok(Profiles.normalizeHandle('  @Gold Trader  ') === 'gold-trader', 'normalizeHandle strips @/spaces/case');
    ok(Profiles.slugFromName('Sri Ram') === 'sri-ram', 'slugFromName slugs a display name');
}

// ---- 3 · publishing requires a handle, then works --------------------------
{
    const noHandle = await Profiles.save('u-pub', { displayName: '', visibility: { public: true } });
    ok(noHandle.ok === false, 'cannot go public without a usable handle');

    const r = await Profiles.save('u-pub', { handle: 'alpha', displayName: 'Alpha', bio: 'London FVG only', country: 'in', avatar: '#22d3ee', links: { x: 'https://x.com/alpha' } });
    ok(r.ok === true && r.profile.handle === 'alpha', 'save accepts a clean handle');
    ok(r.profile.country === 'IN', 'country is normalized to ISO-2 upper case');
    ok(r.profile.avatar === '#22d3ee', 'avatar keeps a valid accent hex');

    const r2 = await Profiles.save('u-pub', { visibility: { public: true } });
    ok(r2.ok === true && r2.profile.visibility.public === true, 'trader can opt in');
    ok(Profiles.metricAllowed(r2.profile, 'net') === true, 'public trader is eligible for net');
    ok(r2.profile.displayName === 'Alpha', 'patch save does not wipe the display name');
}

// ---- 4 · handle uniqueness across traders ----------------------------------
{
    const clash = await Profiles.save('u-other', { handle: 'alpha' });
    ok(clash.ok === false, 'a taken handle is refused');
    const mine = await Profiles.save('u-pub', { handle: 'alpha' });
    ok(mine.ok === true, 'the owner can re-save their own handle');
    const hit = await Profiles.byHandle('ALPHA');
    ok(hit && hit.userId === 'u-pub', 'byHandle is case-insensitive');
}

// ---- 5 · per-metric privacy flags ------------------------------------------
{
    const r = await Profiles.save('u-priv', { handle: 'quiet-one', visibility: { public: true, showNet: false, showDiscipline: false } });
    ok(r.ok === true, 'saved partial visibility');
    ok(Profiles.metricAllowed(r.profile, 'net') === false, 'showNet:false hides net');
    ok(Profiles.metricAllowed(r.profile, 'pf') === false, 'hiding net also hides profit factor');
    ok(Profiles.metricAllowed(r.profile, 'winRate') === true, 'win rate stays visible');
    ok(Profiles.metricAllowed(r.profile, 'bxScore') === true, 'process score needs no profit data');
    ok(Profiles.metricAllowed(r.profile, 'discipline') === false, 'showDiscipline:false hides discipline');
    ok(r.profile.visibility.public === true, 'merging flags kept the public switch');
}

// ---- 6 · public projection leaks nothing -----------------------------------
{
    const p = await Profiles.byHandle('alpha');
    const view = Profiles.publicProfile(p);
    const json = JSON.stringify(view);
    ok(view.handle === 'alpha', 'public view exposes the handle');
    ok(!('userId' in view), 'public view has no user id');
    ok(!/email|password|token|secret/i.test(json), 'public view contains no auth material');
    ok(view.allowed && typeof view.allowed.net === 'boolean', 'public view carries the allowed-metric map');
}

// ---- 7 · persistence + isolation ------------------------------------------
{
    const file = path.join(TMP, 'social-profiles.json');
    ok(fs.existsSync(file), 'profile store is written to the per-store JSON file');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(raw.byHandle && raw.byHandle.alpha === 'u-pub', 'handle index is persisted');
    const reloaded = require('./profiles.js');
    const again = await reloaded.byHandle('quiet-one');
    ok(again && again.userId === 'u-priv', 'profiles survive a module reload');
    ok((await Profiles.get('u-new')).visibility.public === false, 'other traders stay untouched');
}

// ---- 8 · input hardening ----------------------------------------------------
{
    const r = await Profiles.save('u-hard', { handle: 'hard-one', displayName: 'x'.repeat(200), bio: 'y\n\u0000z'.repeat(50) });
    ok(r.ok === true && r.profile.displayName.length <= Profiles.LIMITS.displayName, 'display name is clamped');
    ok(r.profile.bio.length <= Profiles.LIMITS.bio, 'bio is clamped');
    ok(!/[\u0000\n]/.test(r.profile.bio), 'control characters are stripped from the bio');
    ok((await Profiles.save('u-hard', { avatar: 'javascript:alert(1)' })).profile.avatar === null, 'a bogus avatar is rejected');
    ok((await Profiles.save('u-hard', { country: 'INDIA' })).profile.country === null, 'a bogus country is rejected');
}

console.log('\n' + (fail === 0 ? 'ALL PROFILE CHECKS PASS' : fail + ' PROFILE CHECKS FAILED') + ' (' + pass + ' ok)\n');
process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('PROFILE TEST CRASH:', err); process.exit(1); });
