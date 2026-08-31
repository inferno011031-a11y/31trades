'use strict';

// ============================================================================
// CHAT TEST: Intent detection
// ============================================================================
// Pins all 12 intents from the INTENTS array in ai-bot.js.
// Tests 2-4 representative queries per intent, including:
//   - Primary keywords
//   - Edge cases (multi-word, mixed case, partial words)
//   - Boundary cases that should NOT match a wrong intent
//
// Uses Bot.detectIntent() directly — no network, no DB.
// ============================================================================

const Bot = require('../../../server/ai-bot.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

// Helper: detects against lowercased query (matching real code path)
function detect(q) { return Bot.detectIntent(q.toLowerCase()); }

// ---- intent: news -----------------------------------------------------------
const newsQueries = [
    'any upcoming news?',
    'is there economic calendar today?',
    'what are the high impact events?',
    'any CPI release coming?',
    'FOMC is today, should I trade?',
    'is NFP out yet?'
];
for (const q of newsQueries) {
    check('news: "' + q + '"', detect(q) === 'news', 'got: ' + detect(q));
}

// ---- intent: period ---------------------------------------------------------
const periodQueries = [
    'how was my week?',
    'what did I do today?',
    'how am I doing this month?',
    'how was yesterday?',
    'show me this week'
];
for (const q of periodQueries) {
    check('period: "' + q + '"', detect(q) === 'period', 'got: ' + detect(q));
}

// ---- intent: tilt -----------------------------------------------------------
const tiltQueries = [
    'am I tilting?',
    'any revenge entries?',
    'how is my psychology?',
    'am I trading emotionally?',
    'I feel angry, should I trade?'
];
for (const q of tiltQueries) {
    check('tilt: "' + q + '"', detect(q) === 'tilt', 'got: ' + detect(q));
}

// ---- intent: discipline -----------------------------------------------------
const disciplineQueries = [
    'am I following my rules?',
    'how many violations do I have?',
    'what is my discipline score?',
    'am I adhering to the plan?'
];
for (const q of disciplineQueries) {
    check('discipline: "' + q + '"', detect(q) === 'discipline', 'got: ' + detect(q));
}

// ---- intent: streak ---------------------------------------------------------
const streakQueries = [
    'what is my current streak?',
    'how many consecutive losses?',
    'wins in a row?'
];
for (const q of streakQueries) {
    check('streak: "' + q + '"', detect(q) === 'streak', 'got: ' + detect(q));
}

// ---- intent: risk -----------------------------------------------------------
const riskQueries = [
    'how is my risk sizing?',
    'is my sizing correct?',
    'what is my drawdown?',
    'how big is my stop loss?',
    'what is my max DD?'
];
for (const q of riskQueries) {
    check('risk: "' + q + '"', detect(q) === 'risk', 'got: ' + detect(q));
}

// ---- intent: session --------------------------------------------------------
const sessionQueries = [
    'which session is my best?',
    'when do I perform best?',
    'best time of day to trade?',
    'which session wins most?'
];
for (const q of sessionQueries) {
    check('session: "' + q + '"', detect(q) === 'session', 'got: ' + detect(q));
}

// ---- intent: symbol ---------------------------------------------------------
const symbolQueries = [
    'which pair performs best?',
    'how am I doing on forex?',
    'what crypto is working?',
    'which instrument wins most?'
];
for (const q of symbolQueries) {
    check('symbol: "' + q + '"', detect(q) === 'symbol', 'got: ' + detect(q));
}

// ---- intent: setup ----------------------------------------------------------
const setupQueries = [
    'which setup works best?',
    'what is my best strategy?',
    'which entry model is strongest?',
    'what pattern wins most?'
];
for (const q of setupQueries) {
    check('setup: "' + q + '"', detect(q) === 'setup', 'got: ' + detect(q));
}

// ---- intent: winloss --------------------------------------------------------
const winlossQueries = [
    'why am I losing?',
    'what is my win rate?',
    'am I losing money?',
    'what is my profit factor?'
];
for (const q of winlossQueries) {
    check('winloss: "' + q + '"', detect(q) === 'winloss', 'got: ' + detect(q));
}

// ---- intent: focus ----------------------------------------------------------
const focusQueries = [
    'what should I focus on?',
    'how can I improve?',
    'what should I work on?',
    'give me advice',
    'what is my next step?'
];
for (const q of focusQueries) {
    check('focus: "' + q + '"', detect(q) === 'focus', 'got: ' + detect(q));
}

// ---- intent: overall --------------------------------------------------------
const overallQueries = [
    'how am I doing overall?',
    'give me a summary',
    'how is my health score?',
    'overall review please'
];
for (const q of overallQueries) {
    check('overall: "' + q + '"', detect(q) === 'overall', 'got: ' + detect(q));
}

// ---- null / ambiguous (no recognized keyword) --------------------------------
// detectIntent returns null for these — caller defaults to 'overall'
const noMatch = [
    'hello',
    'thanks',
    'interesting'
];
for (const q of noMatch) {
    check('null for ambiguous: "' + q + '"', detect(q) === null, 'got: ' + detect(q));
}

module.exports = results;
