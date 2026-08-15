'use strict';

// ============================================================================
// 31TRADES — Market Replay engine tests
// Exercised entirely on the local replay path (TRADEMIND_TV=off + no account
// cookies), so nothing touches the network. The live TradingView replay path
// requires SESSION/SIGNATURE cookies and is exercised manually.
// ============================================================================

process.env.TRADEMIND_AUTH = 'off';
process.env.TRADEMIND_TV = 'off';
delete process.env.TRADEMIND_TV_SESSION;
delete process.env.TRADEMIND_TV_SIGNATURE;
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '31trades-rp-'));
process.env.TRADEMIND_TV_DATA_DIR = TMP;

const R = require('./replay.js');

let okCount = 0, failCount = 0;
function ok(cond, label) {
    if (cond) { okCount++; console.log('  PASS  ' + label); }
    else { failCount++; console.log('  FAIL  ' + label); }
}

(async function run() {

// 1 · start creates a local replay session with pre-roll bars
{
    const s = await R.start({ symbol: 'EURUSD', timeframe: '1h', window: 100, preRoll: 10 });
    ok(s.ok === true, 'start returns ok');
    ok(s.state.source === 'history-local' || s.state.source === 'synthetic', 'local replay source (' + s.state.source + ')');
    ok(s.state.position === 10, 'pre-roll of 10 bars revealed');
    ok(s.state.total === 100, 'total window is 100 bars');
    ok(s.state.bars.length === 10, 'status returns the revealed bars');
    await R.control(s.state.id, 'close');
}

// 2 · step reveals one bar at a time
{
    const s = await R.start({ symbol: 'XAUUSD', timeframe: '1h', window: 80, preRoll: 8 });
    const id = s.state.id;
    const b1 = await R.control(id, 'step');
    ok(b1.state.position === 9, 'step 1 → position 9');
    const b3 = await R.control(id, 'step');
    const b5 = await R.control(id, 'step');
    ok(b5.state.position === 11, 'three steps → position 11');
    // incremental: fetch only the bars after the pre-roll
    const inc = await R.status(id, 8);
    ok(inc.bars.length === 3, 'incremental status returns exactly the 3 new bars');
    ok(inc.bars[0].time < inc.bars[2].time, 'revealed bars are ascending');
    await R.control(id, 'close');
}

// 3 · play advances bars over time and pause freezes
{
    const s = await R.start({ symbol: 'BTC', timeframe: '1h', window: 60, preRoll: 6 });
    const id = s.state.id;
    await R.control(id, 'play', 60);
    await new Promise(r => setTimeout(r, 500));
    const mid = await R.status(id);
    ok(mid.playing === true, 'playing after start');
    ok(mid.position > 6, 'position advanced while playing (' + mid.position + ')');
    await R.control(id, 'pause');
    const p1 = (await R.status(id)).position;
    await new Promise(r => setTimeout(r, 400));
    const p2 = (await R.status(id)).position;
    ok(p1 === p2, 'pause freezes the position');
    await R.control(id, 'close');
}

// 4 · play runs to the end and marks ended
{
    const s = await R.start({ symbol: 'EURUSD', timeframe: '5m', window: 30, preRoll: 5 });
    const id = s.state.id;
    await R.control(id, 'play', 50);
    // 25 bars at ~50ms/tick → ~1.3s; give it 3s of headroom
    await new Promise(r => setTimeout(r, 3000));
    const st = await R.status(id);
    ok(st.ended === true, 'replay ends when the last bar is reached');
    ok(st.playing === false, 'playing stops at the end');
    await R.control(id, 'close');
}

// 5 · reset rewinds to the pre-roll point
{
    const s = await R.start({ symbol: 'NAS100', timeframe: '1h', window: 90, preRoll: 12 });
    const id = s.state.id;
    await R.control(id, 'play', 50);
    await new Promise(r => setTimeout(r, 500));
    const advanced = (await R.status(id)).position;
    ok(advanced > 12, 'advanced past pre-roll (' + advanced + ')');
    const r = await R.control(id, 'reset');
    ok(r.state.position === 12, 'reset rewinds to pre-roll (12)');
    ok(r.state.ended === false, 'reset clears ended state');
    await R.control(id, 'close');
}

// 6 · close removes the session; unknown ids error cleanly
{
    const s = await R.start({ symbol: 'EURUSD', timeframe: '1h', window: 60, preRoll: 6 });
    const id = s.state.id;
    await R.control(id, 'close');
    ok(R.sessions.size === 0, 'close removes the session');
    const st = await R.status('rp_nope');
    ok(st.ok === false, 'unknown session → clean error');
}

// 7 · live path is not taken without cookies
{
    ok(R.liveAvailable() === false, 'live replay unavailable without TRADEMIND_TV_SESSION/SIGNATURE');
}

console.log('\nALL REPLAY CHECKS PASS (' + okCount + ' ok' + (failCount ? ', ' + failCount + ' FAIL' : '') + ')\n');
process.exit(failCount ? 1 : 0);
})();
