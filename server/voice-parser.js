'use strict';

// ============================================================================
// BATTLEXJOURNAL — Voice trade parser v3 PREMIUM (spoken → structured JSON)
// ----------------------------------------------------------------------------
// Turns an informal, spoken trade description ("scaled into 1.5 standard lots
// on gold, risked 50 aiming for 150, stopped out, honestly panicked") into
// structured trade attributes + execution analytics.
//
// Two paths, same contract (the project's AI doctrine: deterministic first,
// LLM never trusted):
//   1. LLM extraction (server/llm.js completeJSON) when a provider key is set
//      — output is CLAMPED to the schema by normalizeParsed, so a hallucinating
//      model can never emit a wrong type or an unknown enum.
//   2. Deterministic parser (this file, no network, no key needed) whenever the
//      LLM path is unavailable or returns garbage.
//
// v3 SCHEMA (superset of v2):
//   symbol         'XAUUSD' | null
//   direction      'Long' | 'Short' | null          (loaded/scaled into = Long,
//                  shorting/dumped = Short; ambiguous → null)
//   size           string | null   "5 micro lots", "1.5 lots", "100 shares",
//                  "0.5 lots" (half a lot); shorthand normalized
//   pnl            string | null   "+$120" / "-$180" / "$0" (breakeven, scratch,
//                  "tapped out flat"); "netting +$750"/"$750 total profit" win;
//                  risk/targets are NOT pnl
//   session        'London'|'New York'|'Asia'|'Overnight'|'Premarket' | null
//   setup          'Order Block'|'FVG'|'MSS + FVG'|'Breakout'|'Liquidity Sweep'
//                  |'Opening Range Breakout'|'Silver Bullet'|'Breaker'|'ICT 2022'|null
//   emotion        'confident'|'fomo'|'anxious'|'revenge'|'hesitant'|'neutral'
//                  |'disciplined'|'frustrated'|'panicked'|null
//   confidence     'High'|'Medium'|'Low'|null      (tone words first, emotion fallback)
//   rules_followed true | false | null             (tri-state)
//   notes          string
//   ---- v3 premium additions ----
//   risk           number|null   "$ risked" ("risked $50")
//   risk_pct       number|null   "% of account risked" ("risked 2%")
//   rr             number|null   planned R:R ("1 to 3", "2:1 RR", target/risk,
//                                or |target-entry|/|entry-stop| from prices)
//   entry          number|null   "entered at 2400", "bought at", "sold at"
//   stop           number|null   "stop at 2395", "sl 2395"
//   target         number|null   "target 2420", "tp 2420", "aiming for 150"
//   r_multiple     number|null   realized R ("closed at +2.5R", "-1R")
//   confluences    string[]      canonical confluence tags detected in speech
//   quality        'A+'|'A'|'B'|'C'|'D'|null   deterministic execution grade
//                  (P&L-independent: rules, mistakes, tone, RR discipline)
//   trades         array|null    when the transcript describes 2+ separate
//                  trades, each element is a fully parsed trade object
//   + numeric bridges for the entry form: pnl_number, size_number
// ============================================================================

const LLM = require('./llm.js');

// ---------------------------------------------------------------------------
// Fixed vocabularies — BattleX canonical values only
// ---------------------------------------------------------------------------
const SYMBOL_ALIASES = [
    [/\b(xau\s?usd|xau|gold)\b/i, 'XAUUSD'],
    [/\b(eur\s?usd|euro\s?dollar|euro|eur)\b/i, 'EURUSD'],
    [/\b(gbp\s?usd|cable|pound\s?dollar|pound)\b/i, 'GBPUSD'],
    [/\b(nas\s?100|nasdaq|ustec)\b/i, 'NAS100'],
    [/\b(nas|nq)\b/i, 'NAS100'],
    [/\b(btc\s?usd?t?|bitcoin|btc)\b/i, 'BTCUSD'],
    [/\b(eth\s?usd?t?|ethereum|eth)\b/i, 'ETHUSD'],
    [/\b(us\s?30|dow(?:\s?jones)?|dji)\b/i, 'US30'],
    [/\b(s&p\s?500|spx|us\s?500)\b/i, 'SPX500'],
    [/\b(ger\s?40|dax)\b/i, 'GER40'],
    [/\b(usd\s?jpy|us\s?yen|the\s?yen)\b/i, 'USDJPY'],
    [/\b(xag\s?usd|silver(?!\s?bullet))\b/i, 'XAGUSD'], // "silver bullet" is the setup, not the metal
    [/\b(us\s?oil|wti|crude)\b/i, 'USOIL'],
    [/\b(aapl|apple)\b/i, 'AAPL'],
    [/\b(tsla|tesla)\b/i, 'TSLA'],
    [/\b(nvda|nvidia)\b/i, 'NVDA'],
    [/\b(amzn|amazon)\b/i, 'AMZN'],
    [/\b(msft|microsoft)\b/i, 'MSFT']
];

const SESSIONS = ['London', 'New York', 'Asia', 'Overnight', 'Premarket'];
const SESSION_ALIASES = [
    [/\bpremarket\b|\bpre\s?market\b/i, 'Premarket'],
    [/\bovernight\b|\bafter\s?hours\b/i, 'Overnight'],
    [/\bnew\s?york\b|\bny\b/i, 'New York'],
    [/\b(london|ldn)\b/i, 'London'],
    [/\b(asian?|tokyo)\b/i, 'Asia']
];

const SETUPS = ['Order Block', 'FVG', 'MSS + FVG', 'Breakout', 'Liquidity Sweep', 'Opening Range Breakout', 'Silver Bullet', 'Breaker', 'ICT 2022'];
const SETUP_ALIASES = [
    [/\bmss\s*(?:[+&]|\bplus\b)\s*fvg\b|\bmarket\s+structure\s+shift\s*(?:[+&]|\bplus\b)\s*(?:the\s+)?(?:fvg|fair\s+value\s+gap)\b/i, 'MSS + FVG'],
    [/\bopening\s+range\s+breakout\b|\borb\b/i, 'Opening Range Breakout'],
    [/\bsilver\s?bullet\b/i, 'Silver Bullet'],
    [/\bbreaker\b/i, 'Breaker'],
    [/\b(liquidity\s?sweep|swept|sweep(?:ed)?\s+(?:the\s+)?(?:lows?|highs?|liquidity))\b/i, 'Liquidity Sweep'],
    [/\b(order\s?block|\bob\b)\b/i, 'Order Block'],
    [/\b(fvg|fair\s?value\s?gap)\b/i, 'FVG'],
    [/\b(ict\s?2022|2022\s?model)\b/i, 'ICT 2022'],
    [/\bbreakout\b/i, 'Breakout']
];

const EMOTIONS = ['confident', 'fomo', 'anxious', 'revenge', 'hesitant', 'neutral', 'disciplined', 'frustrated', 'panicked'];
const EMOTION_ALIASES = [
    [/\bdisciplined\b|\bfollowed\s+(?:my|the)\s+(?:rules|plan|checklist)\b|\bstuck\s+to\s+(?:my|the)\s+plan\b/i, 'disciplined'],
    [/\bfom(?:o|o'd|oed)\b|\bfomoed\s+in\b|\bjump(?:ed)?\s+(?:straight\s+)?in\b/i, 'fomo'],
    [/\brevenge\b|\bwanted\s+(?:it|my\s+money)\s+back\b/i, 'revenge'],
    [/\bpanicked?\b|\bpanic\b|\bfroze\b/i, 'panicked'],
    [/\banxious\b|\bnervous\b|\bscared\b|\bafraid\b/i, 'anxious'],
    [/\bhesitant\b|\bh(es)itated\b|\bsecond\s?guess(?:ed)?\b/i, 'hesitant'],
    [/\bfrustrated?\b|\btilted?\b|\bmadder?\b|\bangry\b|\bpissed\b/i, 'frustrated'],
    [/\bconfident\b|\bsure\s+of\s+myself\b/i, 'confident'],
    [/\bcalm\b|\brelaxed\b|\bpatient\b|\bcomposed\b|\bheadspace\b/i, 'neutral']
];

const CONFLUENCES = ['Liquidity Sweep', 'Imbalance', 'Breaker', 'BOS', 'CHoCH', 'Premium', 'Discount', 'Session Open', 'News', 'Trendline', 'Support/Resistance', 'Engulfing', 'FVG', 'Order Block', 'Silver Bullet', 'Opening Range Breakout', 'MSS', 'ICT 2022'];
const CONFLUENCE_ALIASES = [
    [/\b(liquidity\s?sweep|swept|sweep(?:ed)?\s+(?:the\s+)?(?:lows?|highs?|liquidity))\b/i, 'Liquidity Sweep'],
    [/\bimbalance(?:s)?\b/i, 'Imbalance'],
    [/\bbreaker(?:s)?\b/i, 'Breaker'],
    [/\bbos\b|\bbreak\s+of\s+structure\b/i, 'BOS'],
    [/\bchoch\b|\bchange\s+of\s+character\b/i, 'CHoCH'],
    [/\bpremium\b/i, 'Premium'],
    [/\bdiscount\b/i, 'Discount'],
    [/\b(?:session\s+)?open(?:ing)?\s+(?:range|price|candle)?\b|\b9\s?30\b|\b8\s?30\b/i, 'Session Open'],
    [/\bnews\b|\bnfp\b|\bcpi\b|\bfomc\b|\bearnings\b/i, 'News'],
    [/\btrend\s?line(?:s)?\b/i, 'Trendline'],
    [/\b(support|resistance|supply|demand)\b/i, 'Support/Resistance'],
    [/\bengulf(?:ing|ed)?\b/i, 'Engulfing'],
    [/\b(fvg|fair\s?value\s?gap)\b/i, 'FVG'],
    [/\b(order\s?block|\bob\b)\b/i, 'Order Block'],
    [/\bsilver\s?bullet\b/i, 'Silver Bullet'],
    [/\bopening\s+range\s+breakout\b|\borb\b/i, 'Opening Range Breakout'],
    [/\bmss\b|\bmarket\s+structure\s+shift\b/i, 'MSS'],
    [/\b(ict\s?2022|2022\s?model)\b/i, 'ICT 2022']
];

// Tone → confidence
const TONE_HIGH = [
    /\b(textbook|clean(?:est)?|perfect|flawless|a\+|by\s+the\s+book|exactly\s+(?:as|per|like)\s+(?:planned|the\s+plan))\b/i,
    /\b(super|completely|extremely|very|really)\s+(confident|disciplined|clean|patient)\b/i,
    /\b(felt\s+completely\s+disciplined|waited\s+(?:patiently|for\s+(?:the\s+)?(?:confirmation|retest)))\b/i
];
const TONE_LOW = [
    /\b(hesitant|hesitated|second.?guess|unsure|no\s+idea|winged\s+it|winging\s+it|impulsive|chaos|messy|panic(?:ked)?|yolo|knife|guess(?:ed|ing)?)\b/i
];
const TONE_MEDIUM = [
    /\b(okay|ok|decent|alright|fine|meh|satisfied|could\s+be\s+better|not\s+sure\s+if)\b/i
];
const EMOTION_TO_CONFIDENCE = {
    disciplined: 'High', confident: 'High',
    fomo: 'Low', anxious: 'Low', revenge: 'Low', hesitant: 'Low', panicked: 'Low', frustrated: 'Low',
    neutral: 'Medium', calm: 'Medium'
};

const MISTAKES = ['moved_stop', 'revenge_entry', 'fomo', 'chased_price', 'oversized', 'early_exit', 'no_confirmation', 'traded_outside_session'];
const MISTAKE_ALIASES = [
    [/\b(moved?|moving|slid|pushed?)\s+(?:my\s+|the\s+)?stop(?:\s+(?:loss|further|back|against|wider))?/i, 'moved_stop'],
    [/\brevenge\b/i, 'revenge_entry'],
    [/\bfom(?:o|o'd|oed)\b|\bjump(?:ed)?\s+(?:straight\s+)?in\b/i, 'fomo'],
    [/\bchas(?:e|ed|ing)\s+(?:the\s+)?(?:price|move|trade|pump)\b/i, 'chased_price'],
    [/\b(oversized?|over\s?leveraged?|too\s+(?:big|much\s+size|large)\s+(?:a\s+)?(?:position|size)|went\s+too\s+big)\b/i, 'oversized'],
    [/\b(early|too\s+soon|premature)\s+(?:exit|exited?|out|close[d]?)\b|\b(closed?|cut|took)\s+(?:it|the\s+(?:trade|winner|profit))\s+(?:way\s+)?(?:too\s+)?(?:early|soon)\b/i, 'early_exit'],
    [/\b(no|without|didn'?t\s+(?:wait\s+for|get|have))\s+confirmation\b|\bjump(?:ed)?\s+the\s+gun\b|\bdidn'?t\s+wait\b/i, 'no_confirmation'],
    [/\b(outside\s+(?:of\s+)?(?:my\s+|the\s+)?session|off\s?session|not\s+(?:in|during)\s+(?:my\s+|the\s+)?session)\b/i, 'traded_outside_session']
];

// ---------------------------------------------------------------------------
// Spoken numbers → digits
// ---------------------------------------------------------------------------
const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function wordsToNumbers(text) {
    const phrase = /(?:\ba\s+)?\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|point|and)\b(?:\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|point|and)\b)*/gi;
    return String(text).replace(phrase, (m) => {
        const value = parseNumberWords(m);
        return value == null ? m : String(value);
    });
}

function parseNumberWords(phrase) {
    const tokens = String(phrase).toLowerCase().replace(/\band\b/g, ' ').split(/\s+/).filter(Boolean);
    let total = 0, current = 0, sawWord = false, pointSeen = false;
    for (const tok of tokens) {
        if (tok === 'a' || tok === 'an') { if (!sawWord) { current = 1; sawWord = true; } continue; }
        if (tok === 'point') { if (sawWord) pointSeen = true; continue; }
        if (SMALL[tok] !== undefined) {
            if (pointSeen) break;
            sawWord = true; current += SMALL[tok]; continue;
        }
        if (TENS[tok] !== undefined) {
            if (pointSeen) break;
            sawWord = true; current += TENS[tok]; continue;
        }
        if (tok === 'hundred') { if (pointSeen) break; current = (current || 1) * 100; sawWord = true; continue; }
        if (tok === 'thousand') { if (pointSeen) break; total += (current || 1) * 1000; current = 0; sawWord = true; continue; }
        break;
    }
    if (!sawWord) return null;
    let value = total + current;
    if (pointSeen) value = Number(String(value) + '.5'); // "X point five" — the common spoken decimal
    return value;
}

// ---------------------------------------------------------------------------
// Core extractors
// ---------------------------------------------------------------------------
function firstMatch(text, table) {
    let best = null;
    for (const [re, value] of table) {
        const m = text.match(re);
        if (m && (best === null || m.index < best.index)) best = { index: m.index, value };
    }
    return best ? best.value : null;
}

function extractSymbol(text) {
    const hit = firstMatch(text, SYMBOL_ALIASES);
    if (hit) return hit;
    const pair = text.match(/\b([a-z]{3})\s?[\/\s]\s?([a-z]{3})\b/i);
    if (pair) {
        const s = (pair[1] + pair[2]).toUpperCase();
        for (const [re, std] of SYMBOL_ALIASES) if (re.test(s)) return std;
        return s;
    }
    return null;
}

function extractDirection(text) {
    const long = text.match(/\b(long(?:ed)?|buy(?:ing)?|bought|loaded|scale(?:d)?\s+into|calls?)\b/i);
    const short = text.match(/\b(short(?:ed|ing)?|sell(?:ing)?|sold|dump(?:ed)?|puts?)\b/i);
    if (long && short) return long.index < short.index ? 'Long' : 'Short';
    if (long) return 'Long';
    if (short) return 'Short';
    return null;
}

function extractSize(text) {
    // LAST mention wins ("one lot... two contracts actually"); units canonicalized.
    const hits = [];
    const unitRe = /\b(\d+(?:\.\d+)?)\s*(micro\s*lots?|mini\s*lots?|(?:standard\s*)?lots?|contracts?|shares?|micros?|minis?)\b/gi;
    for (const m of text.matchAll(unitRe)) {
        const n = m[1];
        const u = m[2].toLowerCase();
        const unit = /^micro/.test(u) ? 'micro lots'
            : /^mini/.test(u) ? 'mini lots'
            : /contract/.test(u) ? 'contracts'
            : /share/.test(u) ? 'shares'
            : 'lots'; // "lots" and "standard lots" → canonical "lots"
        hits.push({ index: m.index, str: n + ' ' + unit });
    }
    for (const m of text.matchAll(/\b(half|quarter)\s*(?:of\s+)?a?\s*(?:lot|contract|unit|share)\b/gi)) {
        hits.push({ index: m.index, str: /half/i.test(m[1]) ? '0.5 lots' : '0.25 lots' });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.index - b.index);
    return hits[hits.length - 1].str;
}

function sizeToNumber(sizeStr) {
    if (!sizeStr) return null;
    const m = String(sizeStr).match(/^([\d.]+)\s*(.*)$/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!isFinite(n) || n <= 0) return null;
    const unit = m[2];
    if (/^micro/.test(unit) || /^mini/.test(unit)) return n / 10; // 1 micro/mini lot = 0.1 standard
    return n;
}

function extractPnl(text) {
    // Breakeven first — and never let win/loss regexes grab risk/targets.
    if (/\b(break\s?even|breakeven|broke\s+even|scratch(?:ed)?|tapped\s+out\s+flat|(?:closed|ended|out|stopped\s+out)\s+flat)\b/i.test(text)) return '$0';

    const notPnl = /[-+]?[\d,]+(?:\.\d+)?\s*(?:R\b(?!e)|%|pip|pips|point|points)/i;

    // Explicit net totals win: "netting +$750", "$750 total profit", "netted 400"
    const net = text.match(/\b(?:nett?ing|nett?ed)\s*([+-]?\$?\s*[\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*total\s+profit\b/i);
    if (net && !notPnl.test(net[0])) {
        const raw = (net[1] || net[2]).replace(/[$,\s]/g, '');
        const num = Number(raw);
        if (isFinite(num)) {
            const neg = String(net[1] || '').trim()[0] === '-';
            return (neg ? '-$' : '+$') + Math.abs(Math.round(num * 100) / 100);
        }
    }

    const win = text.match(/\b(bagged|made|profit(?:ed)?|won|gained|banked|captured|scored|cashed|up)\s+(?:about\s+|around\s+|like\s+|a\s+)?\$?\s*([\d,]+(?:\.\d+)?)\s*(?:bucks?|dollars?|usd)?\b/i);
    const loss = text.match(/\b(lost|loss|down|blew|burned|wrecked|gave\s+back|gave\s+up|dropped|hit\s+for|cut|stopped\s+out)\s+(?:about\s+|around\s+|like\s+|of\s+|for\s+)*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:bucks?|dollars|usd)?\b/i);
    const signed = text.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(?:bucks?|dollars?|usd)\b/i);

    let value = null, sign = null;
    if (loss) { value = loss[2]; sign = -1; }
    else if (win) { value = win[2]; sign = 1; }
    else if (signed && !notPnl.test(signed[0])) {
        const idx = signed.index;
        const before = text.slice(Math.max(0, idx - 70), idx);
        sign = /\b(lost|loss|down|blew|negative|gave|wrecked|stopped\s+out)\b/i.test(before) ? -1 : 1;
        value = signed[1];
    }
    if (value == null) return null;
    const num = Number(String(value).replace(/,/g, ''));
    if (!isFinite(num)) return null;
    return (sign < 0 ? '-$' : '+$') + (Math.round(num * 100) / 100);
}

function extractRisk(text) {
    // "risked $50" / "$50 risk" / "risking 100 bucks" / plain "risked 50"
    // (guarded against "risk 2 to 3" ratio-speak and "risked 2%")
    const dollar = text.match(/\b(?:risk(?:ed|ing)?)\s*(?:of|was|is|at)?\s*\$\s*([\d,]+(?:\.\d+)?)\b/i)
        || text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:dollars?\s*)?risk\b/i)
        || text.match(/\b(?:risk(?:ed|ing)?)\s+([\d,]+(?:\.\d+)?)\s*(?:bucks?|dollars?)\b/i)
        || text.match(/\b(?:risk(?:ed|ing)?)\s+([\d,]+(?:\.\d+)?)(?!\s*(?:%|percent|:|to\s+\d))\b/i);
    if (dollar) {
        const n = Number(dollar[1].replace(/,/g, ''));
        if (isFinite(n) && n > 0) return { risk: n, risk_pct: null };
    }
    const pct = text.match(/\b(?:risk(?:ed|ing)?)\s+(?:about\s+|around\s+)?([\d.]+)\s*(?:%|percent)/i)
        || text.match(/\b([\d.]+)\s*(?:%|percent)\s*(?:of\s+(?:my|the)\s+)?(?:account|balance)\s+risk\b/i);
    if (pct) {
        const n = Number(pct[1]);
        if (isFinite(n) && n > 0 && n <= 100) return { risk: null, risk_pct: n };
    }
    return { risk: null, risk_pct: null };
}

function extractRr(text, risk, target, entry, stop) {
    // 1) direct ratio: "1 to 3", "2:1 RR", "one to two"
    const ratio = text.match(/\b(\d+(?:\.\d+)?)\s*(?::|to)\s*(\d+(?:\.\d+)?)\s*(?:r\s?r|reward|payout)?\b/i);
    let rr = null;
    if (ratio) {
        const a = Number(ratio[1]), b = Number(ratio[2]);
        if (isFinite(a) && isFinite(b) && a > 0 && b > 0) rr = Math.round((Math.max(a, b) / Math.min(a, b)) * 100) / 100;
    }
    // 2) "3R target" / "at 3R"
    if (rr == null) {
        const rTarget = text.match(/\b(\d+(?:\.\d+)?)\s*R\s+(?:target|reward|move|runner)\b/i);
        if (rTarget) rr = Number(rTarget[1]);
    }
    // 3) target & risk in $ → rr = target / risk
    if (rr == null && target != null && risk != null && risk > 0) rr = Math.round((target / risk) * 100) / 100;
    // 4) full price structure → rr = |target-entry| / |entry-stop|
    if (rr == null && entry != null && stop != null && target != null) {
        const riskDist = Math.abs(entry - stop), rewardDist = Math.abs(target - entry);
        if (riskDist > 0) rr = Math.round((rewardDist / riskDist) * 100) / 100;
    }
    return rr != null && isFinite(rr) && rr > 0 ? rr : null;
}

function extractPrices(text) {
    const NUM = '\\$?\\s*(\\d[\\d,]*(?:\\.\\d+)?)';
    // NOTE: no "scaled into" here — that's a SIZE phrase ("scaled into 1.5 lots"),
    // it would steal the lot count as the entry price.
    const entry = text.match(new RegExp('\\b(?:enter(?:ed)?|entry|filled|got\\s+in(?:to)?|bought\\s+at|long(?:ed)?\\s+at|sold\\s+at|short(?:ed)?\\s+at|sold|shorted|bought)\\s*(?:at|@|around|near)?\\s*' + NUM, 'i'));
    const stop = text.match(new RegExp('\\b(?:stop(?:\\s?loss)?|sl)\\s*(?:at|@|is|was|to|set\\s+(?:at|to))?\\s*' + NUM, 'i'));
    const target = text.match(new RegExp('\\b(?:target|tp|take\\s?profit|aiming\\s+for|aiming\\s+at)\\s*(?:at|@|is|was)?\\s*' + NUM, 'i'));
    const toNum = (m) => { if (!m) return null; const n = Number(String(m[1]).replace(/,/g, '')); return isFinite(n) && n > 0 ? n : null; };
    return { entry: toNum(entry), stop: toNum(stop), target: toNum(target) };
}

function extractRMultiple(text) {
    const m = text.match(/([+-]?\d+(?:\.\d+)?)\s*R\b(?!e)/i);
    if (!m) return null;
    const n = Number(m[1]);
    return isFinite(n) && n !== 0 ? n : null;
}

function extractConfluences(text, setup) {
    const found = [];
    for (const [re, tag] of CONFLUENCE_ALIASES) {
        if (re.test(text) && found.indexOf(tag) === -1) found.push(tag);
    }
    if (setup && found.indexOf(setup) === -1) found.unshift(setup); // the setup itself is a confluence
    return found.slice(0, 8);
}

function gradeQuality(d) {
    // Deterministic execution grade — P&L-independent. Judges the DECISION,
    // not the outcome (a disciplined loss grades higher than a lucky fomo win).
    let score = 0, signal = 0;
    if (d.rules_followed === true) { score += 2; signal++; }
    else if (d.rules_followed === false) { score -= 2; signal++; }
    if (d.mistakes.length) { score -= Math.min(d.mistakes.length, 3); signal++; }
    if (d.emotion === 'disciplined' || d.emotion === 'confident') { score += 1; signal++; }
    else if (d.emotion === 'fomo' || d.emotion === 'revenge' || d.emotion === 'frustrated' || d.emotion === 'panicked') { score -= 1; signal++; }
    if (d.confidence === 'High') { score += 1; signal++; }
    else if (d.confidence === 'Low') { score -= 1; signal++; }
    if (d.rr != null) {
        signal++;
        if (d.rr >= 2) score += 1;
        else if (d.rr < 1) score -= 1;
    }
    if (!signal) return null; // nothing to judge — no invented grade
    if (score >= 4) return 'A+';
    if (score >= 2) return 'A';
    if (score >= 0) return 'B';
    if (score >= -2) return 'C';
    return 'D';
}

function extractSession(text) { return firstMatch(text, SESSION_ALIASES); }
function extractSetup(text) { return firstMatch(text, SETUP_ALIASES); }
function extractEmotion(text) { return firstMatch(text, EMOTION_ALIASES); }

function estimateConfidence(text, emotion) {
    for (const re of TONE_LOW) if (re.test(text)) return 'Low';
    for (const re of TONE_HIGH) if (re.test(text)) return 'High';
    for (const re of TONE_MEDIUM) if (re.test(text)) return 'Medium';
    return emotion ? (EMOTION_TO_CONFIDENCE[emotion] || null) : null;
}

function extractRatings(text) {
    const out = { focus: null, confidence: null, discipline: null };
    for (const metric of Object.keys(out)) {
        const reNumberFirst = new RegExp('\\b(\\d{1,2})\\s*(?:/|out\\s+of)\\s*10\\s+for\\s+(?:my\\s+)?' + metric + '\\b', 'i');
        const reValueFirst = new RegExp('\\b' + metric + '\\D{0,20}?(\\d{1,2})\\b', 'i');
        const m = text.match(reNumberFirst) || text.match(reValueFirst);
        if (m) {
            const n = Number(m[1]);
            if (Number.isInteger(n) && n >= 1 && n <= 10) out[metric] = n;
        }
    }
    return out;
}

function extractSetupNotes(rawTranscript) {
    const sentences = String(rawTranscript)
        .split(/(?:[.!?]+(?:\s+|$)|\n+|\s+(?=\b(?:also|because|but|then|so)\b))/i)
        .map(s => s.trim())
        .filter(Boolean);
    const kw = /\b(entry|entered|confluence|trigger|confirmation|confirmed|bias|level|open|sweep|gap|block|breaker|imbalance|bos|choch|trend|resistance|support|rejection|engulfing|candle|fvg|silver\s?bullet|fib|premium|discount|liquidity|mss|breakout)\b/i;
    const notes = sentences.filter(s => kw.test(s)).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 8);
    return notes.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Multi-trade detection: a transcript describing 2+ separate trades
// ---------------------------------------------------------------------------
function splitTrades(raw) {
    const sentences = String(raw)
        .split(/(?:[.!?]+(?:\s+|$)|\n+|;\s*|\s+(?=\b(?:then|after\s+that|next(?:,\s*)?trade|second\s+trade|first\s+trade|also\s+(?:i|on|in))\b))/i)
        .map(s => s.trim()).filter(s => s.length > 10);
    const interesting = sentences.filter(s =>
        /\b(lost|made|won|bagged|wrecked|gained|banked|breakeven|scratch|short(?:ed|ing)?|long(?:ed)?|bought|sold|dump(?:ed)?|hit\s+for)\b/i.test(s));
    return interesting.length >= 2 ? interesting.slice(0, 5) : null;
}

// ---------------------------------------------------------------------------
// Deterministic parse — single trade
// ---------------------------------------------------------------------------
function parseDeterministic(transcript) {
    const raw = String(transcript || '');
    const text = wordsToNumbers(raw);

    const mistakes = [];
    for (const [re, tag] of MISTAKE_ALIASES) {
        if (re.test(text) && mistakes.indexOf(tag) === -1) mistakes.push(tag);
    }
    const brokeRules = /\b(broke|breaking|violated|ignored)\s+(?:my\s+|the\s+)?(?:rules|plan|checklist)\b/i.test(text);
    const followedPlan = /\b(followed|stuck\s+to|obeyed)\s+(?:my\s+|the\s+)?(?:rules|plan|checklist|process)\b/i.test(text);
    const rules = brokeRules || mistakes.length ? false : (followedPlan ? true : null);

    const emotion = extractEmotion(text);
    const risk = extractRisk(text);
    const prices = extractPrices(text);
    const rr = extractRr(text, risk.risk, prices.target, prices.entry, prices.stop);
    const setup = extractSetup(text);

    const d = {
        symbol: extractSymbol(text),
        direction: extractDirection(text),
        size: extractSize(text),
        pnl: extractPnl(text),
        session: extractSession(text),
        setup,
        emotion,
        confidence: estimateConfidence(text, emotion),
        rules_followed: rules,
        risk: risk.risk,
        risk_pct: risk.risk_pct,
        rr,
        entry: prices.entry,
        stop: prices.stop,
        target: prices.target,
        r_multiple: extractRMultiple(text),
        confluences: extractConfluences(text, setup),
        notes: '',
        mistakes,
        ratings: extractRatings(text),
        setup_notes: extractSetupNotes(raw)
    };
    d.quality = gradeQuality(d);
    return d;
}

// ---------------------------------------------------------------------------
// Schema clamp — every path (LLM or deterministic) exits through here.
// ---------------------------------------------------------------------------
function clampNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s+]/g, ''));
    return isFinite(n) ? n : null;
}

function normalizeSymbol(v) {
    if (!v || typeof v !== 'string') return null;
    const s = v.toUpperCase().replace(/[\s\/_-]/g, '');
    if (!/^[A-Z0-9]{3,12}$/.test(s)) return null;
    for (const [re, std] of SYMBOL_ALIASES) if (re.test(s)) return std;
    return s;
}

function normalizeSize(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? String(v) + ' lots' : null;
    const s = String(v).toLowerCase().trim();
    const m = s.match(/([\d.]+)\s*(micro\s*lots?|mini\s*lots?|(?:standard\s*)?lots?|contracts?|shares?|micros?|minis?)/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!isFinite(n) || n <= 0) return null;
    const u = m[2];
    const unit = /^micro/.test(u) ? 'micro lots' : /^mini/.test(u) ? 'mini lots'
        : /contract/.test(u) ? 'contracts' : /share/.test(u) ? 'shares' : 'lots';
    return n + ' ' + unit;
}

function normalizePnl(v) {
    if (v == null) return null;
    if (typeof v === 'number') {
        if (v === 0) return '$0';
        return (v < 0 ? '-$' : '+$') + Math.abs(Math.round(v * 100) / 100);
    }
    const s = String(v).trim();
    if (/^(break\s?even|breakeven|scratch|flat)$/i.test(s)) return '$0';
    const m = s.match(/([+-]?)\s*\$?\s*([\d,]+(?:\.\d+)?)/);
    if (!m) return null;
    const num = Number(m[2].replace(/,/g, ''));
    if (!isFinite(num)) return null;
    if (num === 0) return '$0';
    const neg = m[1] === '-' || /^\s*-/i.test(s) || /\b(lost|loss|down|wrecked)\b/i.test(s);
    return (neg ? '-$' : '+$') + (Math.round(num * 100) / 100);
}

function normalizeParsed(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const direction = String(src.direction || '').toLowerCase() === 'long' ? 'Long'
        : String(src.direction || '').toLowerCase() === 'short' ? 'Short' : null;
    const session = SESSIONS.indexOf(String(src.session || '')) !== -1 ? src.session : null;
    const setup = typeof src.setup === 'string' && src.setup.trim() ? src.setup.trim().slice(0, 60) : null;

    const emotionRaw = typeof src.emotion === 'string' && src.emotion.trim()
        ? src.emotion.trim().toLowerCase() : null;
    const emotion = EMOTIONS.indexOf(emotionRaw) !== -1 ? emotionRaw : null;

    const confRaw = typeof src.confidence === 'string' ? src.confidence.trim().toLowerCase() : '';
    const confidence = confRaw === 'high' || confRaw === 'medium' || confRaw === 'low'
        ? confRaw[0].toUpperCase() + confRaw.slice(1) : null;

    const rules = typeof src.rules_followed === 'boolean' ? src.rules_followed
        : (src.rules_followed === 'true' ? true : src.rules_followed === 'false' ? false : null);

    const mistakes = Array.isArray(src.mistakes)
        ? [...new Set(src.mistakes.filter(m => MISTAKES.indexOf(m) !== -1))]
        : [];

    const ratingsIn = src.ratings && typeof src.ratings === 'object' ? src.ratings : {};
    const ratings = {};
    for (const metric of ['focus', 'confidence', 'discipline']) {
        const n = clampNumber(ratingsIn[metric]);
        ratings[metric] = n != null && Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
    }

    const notes = Array.isArray(src.setup_notes)
        ? src.setup_notes.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim().slice(0, 240)).slice(0, 8)
        : [];

    const confluences = Array.isArray(src.confluences)
        ? [...new Set(src.confluences.filter(c => CONFLUENCES.indexOf(c) !== -1))].slice(0, 8)
        : [];

    const sizeStr = normalizeSize(src.size);
    const pnlStr = normalizePnl(src.pnl);
    const pnlNum = pnlStr === '$0' ? 0
        : pnlStr ? (pnlStr[0] === '-' ? -Number(pnlStr.slice(2)) : Number(pnlStr.slice(2)))
        : null;

    const riskN = clampNumber(src.risk);
    const rrN = clampNumber(src.rr);
    const entryN = clampNumber(src.entry);
    const stopN = clampNumber(src.stop);
    const targetN = clampNumber(src.target);
    const rMultN = clampNumber(src.r_multiple);

    const out = {
        symbol: normalizeSymbol(src.symbol),
        direction,
        size: sizeStr,
        pnl: pnlStr,
        session,
        setup,
        emotion,
        confidence,
        rules_followed: rules,
        notes: typeof src.notes === 'string' ? src.notes.trim().slice(0, 2000) : '',
        risk: riskN != null && riskN > 0 ? riskN : null,
        risk_pct: clampNumber(src.risk_pct),
        rr: rrN != null && rrN > 0 ? rrN : null,
        entry: entryN != null && entryN > 0 ? entryN : null,
        stop: stopN != null && stopN > 0 ? stopN : null,
        target: targetN != null && targetN > 0 ? targetN : null,
        r_multiple: rMultN,
        confluences,
        mistakes,
        ratings,
        setup_notes: notes,
        pnl_number: pnlNum,
        size_number: sizeToNumber(sizeStr)
    };
    // quality: keep an LLM-provided grade only if it's a valid enum; otherwise
    // the deterministic grade (computed in parseDeterministic) is authoritative
    // for the deterministic path — recompute here from the clamped fields so
    // BOTH paths get a consistent grade.
    const llmQuality = typeof src.quality === 'string' ? src.quality.trim().toUpperCase() : null;
    const detGrade = gradeQuality(out);
    out.quality = detGrade || (['A+', 'A', 'B', 'C', 'D'].indexOf(llmQuality) !== -1 ? llmQuality : null);
    return out;
}

// ---------------------------------------------------------------------------
// LLM path — v3 extraction prompt
// ---------------------------------------------------------------------------
const SCHEMA_HINT = '{"symbol":"XAUUSD|null","direction":"Long|Short|null","size":"5 micro lots|1.5 lots|100 shares|null","pnl":"+$120|-$180|$0|null","session":"London|New York|Asia|Overnight|Premarket|null","setup":"Order Block|FVG|MSS + FVG|Breakout|Liquidity Sweep|Opening Range Breakout|Silver Bullet|Breaker|ICT 2022|null","emotion":"confident|fomo|anxious|revenge|hesitant|neutral|disciplined|frustrated|panicked|null","confidence":"High|Medium|Low|null","rules_followed":true,"risk":50,"risk_pct":2,"rr":3,"entry":2400,"stop":2395,"target":2420,"r_multiple":2.5,"confluences":["Liquidity Sweep","FVG"],"quality":"A+|A|B|C|D|null","notes":"..."}';

function buildUserPrompt(transcript) {
    return 'You are an expert trading data extraction engine for BattleXJournal.\n' +
        'Parse the raw, natural-language voice transcript from a trader and extract structured trade attributes into a strict JSON object.\n\n' +
        '### EXTRACTION RULES:\n' +
        '1. symbol: Ticker (XAUUSD, NAS100, US30...). "gold"->XAUUSD, "nasdaq"->NAS100, "dow"->US30. null if absent.\n' +
        '2. direction: "Long" (long/longed/buy/bought/buying/loaded/scaled into/calls) or "Short" (short/shorted/shorting/sell/sold/dumped/puts). Ambiguous -> null.\n' +
        '3. size: position size with units, normalized ("5 micros" -> "5 micro lots", "1.5 standard lots" -> "1.5 lots", "half a lot" -> "0.5 lots"). null if absent.\n' +
        '4. pnl: ACTUAL net realized result as signed string. "bagged 120 bucks"->"+$120"; "lost 65"/"wrecked for 180"/"hit for 180"->"-$180"; breakeven/scratch/"tapped out flat"->"$0"; "netting +$750"->"+$750"; "$750 total profit"->"+$750". Risk and targets are NOT pnl: "risked 50 aiming for 150 and broke even"->"$0". null if absent.\n' +
        '5. session: "London"|"New York"|"Asia"|"Overnight"|"Premarket"|null.\n' +
        '6. setup: "Order Block"|"FVG"|"MSS + FVG"|"Breakout"|"Liquidity Sweep"|"Opening Range Breakout"|"Silver Bullet"|"Breaker"|"ICT 2022"|null. Standardize acronyms (fair value gap->FVG, market structure shift->MSS).\n' +
        '7. emotion: "confident"|"fomo"|"anxious"|"revenge"|"hesitant"|"neutral"|"disciplined"|"frustrated"|"panicked"|null.\n' +
        '8. confidence: tone estimate — "High" (textbook/clean/perfect/super confident/completely disciplined), "Medium" (decent/okay/calm/satisfied), "Low" (hesitant/anxious/fomo/panicked/revenge/winged it/knife), or null.\n' +
        '9. rules_followed: false if revenge/moved stop/chasing/fomo/broke max loss; true if rules/plan followed stated; null otherwise.\n' +
        '10. risk: dollar amount risked ("risked $50" -> 50). risk_pct: percent of account risked ("risked 2%" -> 2). null if absent.\n' +
        '11. rr: planned risk-reward as a number ("1 to 3"->3, "2:1 RR"->2, "3R target"->3, target $150 with $50 risk -> 3). null if absent.\n' +
        '12. entry/stop/target: prices ("entered at 2400", "stop at 2395", "target 2420", "aiming for 150"). null if absent.\n' +
        '13. r_multiple: realized R ("closed at +2.5R" -> 2.5, "-1R" -> -1). null if absent.\n' +
        '14. confluences: array from ONLY these tags: Liquidity Sweep, Imbalance, Breaker, BOS, CHoCH, Premium, Discount, Session Open, News, Trendline, Support/Resistance, Engulfing, FVG, Order Block, Silver Bullet, Opening Range Breakout, MSS, ICT 2022.\n' +
        '15. quality: execution grade judging the DECISION not the outcome — "A+" (flawless discipline), "A" (clean, rules followed), "B" (ok, minor issues), "C" (sloppy, mistakes), "D" (revenge/panic/multiple mistakes). null if too little info.\n' +
        '16. notes: one or two sentences summarizing the trade in the trader\'s own words.\n\n' +
        'OUTPUT FORMAT: Return ONLY a valid JSON object matching this schema. No markdown, no code fences, no conversational preamble.\n' +
        'Schema: ' + SCHEMA_HINT + '\n\n' +
        'Transcript:\n"""' + String(transcript).slice(0, 4000) + '"""';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function extract(transcript, opts) {
    const options = opts || {};
    const t = String(transcript || '').trim();
    if (!t) return { parsed: null, meta: { parser: 'none', error: 'empty transcript' } };

    // Multi-trade detection happens on the deterministic side (sentence split);
    // the LLM path stays single-trade (it narrates the dominant trade).
    const parts = splitTrades(t);
    const multi = parts && parts.length > 1;

    let parsed = null;
    let parser = 'deterministic';
    if (!multi && options.preferLLM !== false && LLM.hasKey()) {
        try {
            const raw = await LLM.completeJSON(
                'You are the BattleXJournal voice trade parser. You return only valid JSON.',
                buildUserPrompt(t),
                { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs }
            );
            if (raw && typeof raw === 'object') {
                parsed = normalizeParsed(raw);
                parser = 'llm';
            }
        } catch (e) { /* deterministic fallback below */ }
    }

    let trades = null;
    if (multi) {
        parser = 'deterministic';
        trades = parts.map(p => normalizeParsed(parseDeterministic(p)));
        parsed = trades[0];
    }
    if (!parsed) parsed = normalizeParsed(parseDeterministic(t));

    const fields = ['symbol', 'direction', 'size', 'pnl', 'session', 'setup', 'emotion', 'confidence',
        'risk', 'risk_pct', 'rr', 'entry', 'stop', 'target', 'r_multiple', 'quality']
        .filter(k => parsed[k] != null)
        .concat(parsed.rules_followed !== null ? ['rules_followed'] : [])
        .concat(parsed.mistakes.length ? ['mistakes'] : [])
        .concat(parsed.confluences.length ? ['confluences'] : [])
        .concat(parsed.setup_notes.length ? ['setup_notes'] : [])
        .concat(trades ? ['multi_trade:' + trades.length] : []);

    return { parsed, trades, meta: { parser, fields_found: fields, transcript_length: t.length } };
}

module.exports = {
    extract,
    parseDeterministic,
    normalizeParsed,
    wordsToNumbers,
    MISTAKES,
    SESSIONS,
    SETUPS,
    EMOTIONS,
    CONFLUENCES
};
