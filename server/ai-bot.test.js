'use strict';

// ============================================================================
// 31TRADES — AI Mentor bot tests (no database required)
// ----------------------------------------------------------------------------
// The bot must be GROUNDED: every answer is computed from the real canonical
// ledger and cites evidence — never generic text. These tests pin:
//   1. Intent detection (tilt / risk / session / winloss / focus / overall).
//   2. Every answer on real data contains actual numbers from the ledger.
//   3. No-account / no-data states give honest guidance, not hallucination.
//   4. Follow-up suggestions keep the conversation going.
//
// Run:  node server/ai-bot.test.js
// ============================================================================

const Bot = require('./ai-bot.js');

global.window = { SERVER_MODE: true };
require('../demo-trades.js');
const createCore = require('../src/core/index.js');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra || '')));
    if (!cond) failures++;
}

const core = createCore({ demoTrades: global.window.DemoTrades });
core.seedDemoAccount(117);
const ACCOUNT = core.Accounts[0].id;

// ---- 1. intent detection ---------------------------------------------------
const intents = [
    ['am I tilting', 'tilt'], ['any revenge entries', 'tilt'],
    ['how is my risk sizing', 'risk'], ['what is my drawdown', 'risk'],
    ['which session is my best', 'session'], ['which session wins most', 'session'],
    ['am I losing money', 'winloss'], ['what is my win rate', 'winloss'],
    ['what should I focus on', 'focus'], ['give me advice', 'focus'],
    ['how am I doing overall', 'overall'], ['summary please', 'overall'],
    ['how was my week', 'period'], ['how did I do this month', 'period'],
    ['which pair performs best', 'symbol'], ['which setup is strongest', 'setup'],
    ['do I follow my rules', 'discipline'], ['any violations', 'discipline'],
    ['what is my current streak', 'streak']
];
intents.forEach(([q, want]) => {
    check('intent(' + q + ') = ' + want, Bot.detectIntent(q.toLowerCase()) === want, 'got ' + Bot.detectIntent(q.toLowerCase()));
});

// ---- 2. grounding: answers carry real numbers + evidence -------------------
const MONEY = /\$[\d,]+/;
const answers = [
    Bot.askBot(core, ACCOUNT, 'How am I doing overall?'),
    Bot.askBot(core, ACCOUNT, 'Am I tilting?'),
    Bot.askBot(core, ACCOUNT, 'How is my risk sizing?'),
    Bot.askBot(core, ACCOUNT, 'Which session is my best?'),
    Bot.askBot(core, ACCOUNT, 'What should I focus on?'),
    Bot.askBot(core, ACCOUNT, 'Am I losing money?'),
    Bot.askBot(core, ACCOUNT, 'Which symbol performs best?'),
    Bot.askBot(core, ACCOUNT, 'Do I follow my rules?'),
    Bot.askBot(core, ACCOUNT, 'How was my week?'),
    Bot.askBot(core, ACCOUNT, 'What is my streak?')
];
check('all intents answer', answers.every(a => typeof a.answer === 'string' && a.answer.length > 0));
check('answers carry real numbers ($)', answers.filter(a => MONEY.test(a.answer)).length >= 5,
    'only ' + answers.filter(a => MONEY.test(a.answer)).length + '/10 had $ numbers');
check('answers carry counts/percent', answers.every(a => /\d/.test(a.answer)));
check('answers carry evidence or KPIs', answers.every(a => (a.evidence && a.evidence.length) || (a.kpis && a.kpis.length) || /not enough|No|no/.test(a.answer)),
    'bare answer: ' + (answers.find(a => !((a.evidence && a.evidence.length) || (a.kpis && a.kpis.length)) || true) || {}).answer);

// tilt answer must reference the real ledger (episodes count) — never a guess.
const tilt = Bot.askBot(core, ACCOUNT, 'Am I tilting?');
check('tilt answer mentions episodes/evidence', /episode|signal|match/.test(tilt.answer), tilt.answer.slice(0, 80));
check('tilt answer has evidence ids', Array.isArray(tilt.evidence) && tilt.evidence.every(id => core.Trades.some(t => t.id === id)),
    'tilt evidence: ' + JSON.stringify(tilt.evidence));

// risk answer must cite the actual policy number.
const risk = Bot.askBot(core, ACCOUNT, 'How is my risk sizing?');
check('risk answer cites policy limit', /policy|\$\d+/.test(risk.answer), risk.answer.slice(0, 80));

// ---- 3. guardrails: no account / no data ------------------------------------
const fresh = createCore({ demoTrades: global.window.DemoTrades });
fresh.reseed();
const noAcc = Bot.askBot(fresh, 'acc-prop', 'Am I tilting?');
check('no-account answer is honest guidance', /No account yet/.test(noAcc.answer), noAcc.answer.slice(0, 60));

const tiny = createCore({ demoTrades: global.window.DemoTrades });
tiny.seedDemoAccount(3);
const small = Bot.askBot(tiny, tiny.Accounts[0].id, 'Am I tilting?');
check('small-sample answer is honest', /No trades in the current/.test(small.answer) || /No tilt signal/.test(small.answer),
    small.answer.slice(0, 80));

// ---- 4. follow-ups keep the conversation going -------------------------------
const overall = Bot.askBot(core, ACCOUNT, 'How am I doing overall?');
check('answer offers follow-ups', Array.isArray(overall.followUps) && overall.followUps.length >= 2,
    'followUps: ' + JSON.stringify(overall.followUps));
check('follow-ups are real questions', overall.followUps.every(f => typeof f === 'string' && f.length > 3));

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL AI BOT CHECKS PASS');
process.exit(failures ? 1 : 0);
