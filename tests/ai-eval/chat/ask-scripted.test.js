'use strict';

// ============================================================================
// CHAT TEST: askBot scripted end-to-end QA
// ============================================================================
// 12 scripted question-answer pairs against the mixed-realistic fixture
// (35 trades — enough for most engines to produce real findings).
//
// Pins for each answer:
//   · typeof answer === 'string' && answer.length > 0   (never undefined)
//   · answer contains actual data (numbers, $ amounts, specific words)
//   · kpis is an array (may be empty for some intents)
//   · followUps is an array with ≥1 entry
//   · memory is an object with intent field
//   · No answer contains 'undefined' or '[object Object]'
// ============================================================================

const Bot = require('../../../server/ai-bot.js');
const fx  = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

const core  = fx.mixedRealistic();
const ACCT  = 'acc-prop';

function ask(q, opts) { return Bot.askBot(core, ACCT, q, opts || {}); }

// Common answer validators
function validateAnswer(r, label) {
    check(label + ': answer is non-empty string',
        typeof r.answer === 'string' && r.answer.length > 0,
        'got: ' + typeof r.answer + ' = ' + String(r.answer).slice(0, 30));
    check(label + ': no "undefined" in answer',
        !r.answer.includes('undefined'),
        'answer: ' + r.answer.slice(0, 60));
    check(label + ': no "[object Object]" in answer',
        !r.answer.includes('[object Object]'));
    check(label + ': kpis is array',
        Array.isArray(r.kpis));
    check(label + ': followUps is array with entries',
        Array.isArray(r.followUps) && r.followUps.length >= 1,
        'followUps: ' + JSON.stringify(r.followUps));
    check(label + ': memory has intent',
        r.memory && typeof r.memory.intent === 'string');
    check(label + ': answer contains at least one digit',
        r.intent === 'news' || /\d/.test(r.answer),
        'answer: ' + r.answer.slice(0, 60));
}

// ---- 1. Overall summary ------------------------------------------------------
const r1 = ask('How am I doing overall?');
validateAnswer(r1, 'overall');
check('overall: answer contains $ (net P&L)', /\$[\d,]+/.test(r1.answer), r1.answer.slice(0, 80));
check('overall: intent=overall', r1.intent === 'overall');

// ---- 2. Tilt -----------------------------------------------------------------
const r2 = ask('Am I tilting?');
validateAnswer(r2, 'tilt');
check('tilt: answer mentions episode or signal or calm',
    /(episode|signal|match|calm|tilt)/i.test(r2.answer), r2.answer.slice(0, 80));
check('tilt: evidence is array',  Array.isArray(r2.evidence));
check('tilt: intent=tilt',        r2.intent === 'tilt');

// ---- 3. Risk sizing ----------------------------------------------------------
const r3 = ask('How is my risk sizing?');
validateAnswer(r3, 'risk');
check('risk: answer contains $ amount', /\$[\d,]+/.test(r3.answer), r3.answer.slice(0, 80));
check('risk: intent=risk', r3.intent === 'risk');

// ---- 4. Best session ---------------------------------------------------------
const r4 = ask('Which session is my best?');
validateAnswer(r4, 'session');
// May say "not enough" if < 10 trades per session, or name a session
check('session: answer mentions session name or "enough"',
    /(London|New York|Asia|enough|not enough)/i.test(r4.answer), r4.answer.slice(0, 80));
check('session: intent=session', r4.intent === 'session');

// ---- 5. Focus / improve ------------------------------------------------------
const r5 = ask('What should I focus on?');
validateAnswer(r5, 'focus');
check('focus: intent=focus', r5.intent === 'focus');

// ---- 6. Losing analysis ------------------------------------------------------
const r6 = ask('Why am I losing money?');
validateAnswer(r6, 'winloss');
check('winloss: answer contains loss count or rate', /loss|win|%|\$/.test(r6.answer), r6.answer.slice(0, 80));
check('winloss: intent=winloss', r6.intent === 'winloss');

// ---- 7. This month -----------------------------------------------------------
const r7 = ask('How did I do this month?');
validateAnswer(r7, 'period');
check('period: answer mentions "month" or trade count',
    /month|trade|\d+/.test(r7.answer), r7.answer.slice(0, 80));
check('period: intent=period', r7.intent === 'period');

// ---- 8. Streak ---------------------------------------------------------------
const r8 = ask('What is my current streak?');
validateAnswer(r8, 'streak');
check('streak: answer mentions streak',    /streak|win|loss/i.test(r8.answer), r8.answer.slice(0, 80));
check('streak: intent=streak',            r8.intent === 'streak');

// ---- 9. Discipline -----------------------------------------------------------
const r9 = ask('Do I follow my rules?');
validateAnswer(r9, 'discipline');
check('discipline: answer mentions score/rules/discipline',
    /disciplin|score|rule|violat/i.test(r9.answer), r9.answer.slice(0, 80));
check('discipline: intent=discipline', r9.intent === 'discipline');

// ---- 10. Setup performance ---------------------------------------------------
const r10 = ask('Which setup wins most?');
validateAnswer(r10, 'setup');
check('setup: intent=setup', r10.intent === 'setup');
// May name a setup or say "not enough"
check('setup: answer mentions setup name or "enough"',
    /(BOS|FVG|MSS|setup|enough)/i.test(r10.answer), r10.answer.slice(0, 80));

// ---- 11. News (no events supplied) ------------------------------------------
const r11 = ask('Any news today?', { events: null });
validateAnswer(r11, 'news-null');
check('news null: answer mentions calendar/unavailable',
    /calendar|unavailable|provider/i.test(r11.answer), r11.answer.slice(0, 80));
check('news: intent=news', r11.intent === 'news');

// events=[] — quiet calendar
const r11b = ask('Any upcoming high-impact events?', { events: [] });
validateAnswer(r11b, 'news-empty');
check('news empty: answer mentions quiet or no events',
    /quiet|no scheduled|0/i.test(r11b.answer), r11b.answer.slice(0, 80));

// ---- 12. Follow-ups always non-empty ----------------------------------------
const r12 = ask('How am I doing?');
check('follow-ups: ≥2 suggestions', r12.followUps && r12.followUps.length >= 2, JSON.stringify(r12.followUps));
check('follow-ups: all strings',    r12.followUps && r12.followUps.every(f => typeof f === 'string' && f.length > 3));

// ---- 13. Conversation memory carries between turns --------------------------
const m1   = ask('Am I tilting?');
const m2   = ask('and this week?', { memory: m1.memory });
check('memory carry: m2.intent = tilt', m2.intent === 'tilt', 'intent: ' + m2.intent);
check('memory carry: m2.window = this week', m2.window === 'this week', 'window: ' + m2.window);
check('memory carry: memory.history exists', Array.isArray(m2.memory && m2.memory.history));

// ---- 14. No-trades-in-range gives honest guidance (not crash) ---------------
const tiny  = fx.smallSample(3);
const rTiny = Bot.askBot(tiny, 'acc-prop', 'How am I doing?');
check('tiny: answer is string (no crash)', typeof rTiny.answer === 'string');
check('tiny: answer mentions trades or sample',
    /trade|sample|small|log/i.test(rTiny.answer), rTiny.answer.slice(0, 80));

// ---- 15. Unknown account returns honest guidance ----------------------------
const rNoAcc = Bot.askBot(core, 'acc-does-not-exist', 'Am I tilting?');
check('unknown account: answer mentions No account', /No account/i.test(rNoAcc.answer), rNoAcc.answer.slice(0, 60));

module.exports = results;
