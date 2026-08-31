'use strict';

// ============================================================================
// CHAT TEST: resolveAsk context resolution
// ============================================================================
// Tests that resolveAsk correctly:
//   1. Passes explicit intents through without modification.
//   2. Carries prev intent on follow-up phrases ("and this week?").
//   3. Overrides carried intent with explicit new intent.
//   4. Extracts symbol/session/setup from question as subject.
//   5. Carries prev subject + subjKind on "tell me more".
//   6. Sets window on time phrases.
//   7. Handles null prev gracefully.
// ============================================================================

const Bot = require('../../../server/ai-bot.js');
const fx  = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

// Build a core so knownSubjects can find real symbols/sessions/setups
const core  = fx.mixedRealistic();
const ACCT  = 'acc-prop';

// Helper
function resolve(q, prev) {
    return Bot.resolveAsk(q, prev || null, core, ACCT);
}

// ---- 1. Explicit intents pass through without prev -------------------------
check('explicit tilt: intent=tilt',        resolve('am I tilting?').intent        === 'tilt');
check('explicit risk: intent=risk',        resolve('how is my risk?').intent      === 'risk');
check('explicit session: intent=session',  resolve('which session is best?').intent === 'session');
check('explicit focus: intent=focus',      resolve('what should I focus on?').intent === 'focus');
check('explicit winloss: intent=winloss',  resolve('am I losing money?').intent   === 'winloss');
check('explicit discipline: intent=discipline', resolve('do I follow rules?').intent === 'discipline');
check('explicit streak: intent=streak',    resolve('what is my streak?').intent   === 'streak');

// ---- 2. Follow-up phrase carries prev intent --------------------------------
const prevTilt = { intent: 'tilt', subject: null, subjKind: null, window: null };

const r1 = resolve('and this week?', prevTilt);
check('follow-up "and this week?": carries tilt intent', r1.intent === 'tilt', 'intent: ' + r1.intent);
check('follow-up "and this week?": sets window',          r1.window === 'this week', 'window: ' + r1.window);
check('follow-up "and this week?": flagged as followUp',  r1.followUp === true);

const r2 = resolve('tell me more', prevTilt);
check('"tell me more": carries prev intent',  r2.intent === 'tilt', 'intent: ' + r2.intent);
check('"tell me more": flagged as followUp',  r2.followUp === true);

const r3 = resolve('and what about my risk?', prevTilt);
// "and" is a followup prefix, but "risk" is an explicit intent — explicit wins
check('"and what about my risk?": new explicit intent overrides', r3.intent === 'risk', 'intent: ' + r3.intent);

// ---- 3. Window extraction ---------------------------------------------------
check('"today" sets window=today',       resolve('how did I do today?').window === 'today');
check('"yesterday" sets window',         resolve('how was yesterday?').window  === 'yesterday');
check('"this week" sets window',         resolve('how was this week?').window  === 'this week');
check('"last week" sets window',         resolve('last week performance?').window === 'last week');
check('"this month" sets window',        resolve('this month results?').window === 'this month');

// ---- 4. Subject extraction from core's known symbols/sessions/setups --------
// Known symbols from mixedRealistic: EURUSD, GBPUSD, NAS100
// Known sessions: London, New York, Asia
// Known setups: BOS, FVG, MSS

const rSym = resolve('what about EURUSD?');
check('EURUSD detected as subject',     rSym.subject    === 'EURUSD' || rSym.subject === 'eurusd', 'subject: ' + rSym.subject);
check('EURUSD sets intent=symbol',      rSym.intent     === 'symbol', 'intent: ' + rSym.intent);
check('EURUSD sets subjKind=symbol',    rSym.subjKind   === 'symbol', 'subjKind: ' + rSym.subjKind);

// Session subject
const rSes = resolve('how about the London session?');
const sesMatch = rSes.subject && rSes.subject.toLowerCase() === 'london';
check('London detected as subject',     sesMatch, 'subject: ' + rSes.subject);

// ---- 5. Carry subject on follow-up -----------------------------------------
const prevSymbol = { intent: 'symbol', subject: 'EURUSD', subjKind: 'symbol', window: null };
const r4 = resolve('and last week?', prevSymbol);
check('"and last week?" carries EURUSD subject', r4.subject === 'EURUSD', 'subject: ' + r4.subject);
check('"and last week?" carries symbol intent',  r4.intent  === 'symbol' || r4.intent === 'period', 'intent: ' + r4.intent);
check('"and last week?" sets window=last week',  r4.window  === 'last week', 'window: ' + r4.window);

// ---- 6. Null prev is safe ---------------------------------------------------
let crashed = false;
try { resolve('hello', null); } catch (e) { crashed = true; }
check('null prev: resolveAsk does not crash', !crashed);

const r5 = resolve('how am I doing?', null);
check('null prev: returns intent string',  typeof r5.intent === 'string');
check('null prev: subject is null',        r5.subject === null || r5.subject === undefined);

// ---- 7. No match → overall -------------------------------------------------
const r6 = resolve('hmm', null);
check('no-match → overall', r6.intent === 'overall', 'intent: ' + r6.intent);

module.exports = results;
