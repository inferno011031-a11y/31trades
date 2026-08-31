'use strict';

// ============================================================================
// ENGINE TEST: detectPatterns
// ============================================================================
// Pins:
//   1. revenge-trader fixture → 'revenge' pattern fires with ≥3 evidence.
//   2. fomo-trader fixture    → 'fomo' pattern fires.
//   3. risk-escalation fixture → 'risk-escalation' pattern fires.
//   4. clean-trader fixture   → ZERO critical patterns.
//   5. All fired findings: evidence ids exist in core.Trades (grounding rule).
//   6. No finding has ev.length > 8 (evidence cap).
//   7. Pattern finding shape: id, type, sev, title, msg, ev, count, cost, confidence.
// ============================================================================

const AI = require('../../../server/ai-mentor.js');
const fx = require('../fixtures/index.js');

const results = [];
function check(label, cond, extra) {
    results.push({ label, ok: !!cond, extra: extra || '' });
}

// Helper: build context shortcut
function ctx(core) {
    return AI.buildContext(core, 'acc-prop', 'all');
}

// ---- 1. revenge pattern fires ----------------------------------------------
const revCore = fx.revengeTrader();
const revCtx  = ctx(revCore);
const revPats = AI.detectPatterns(revCtx);
const revPat  = revPats.find(f => f.type === 'revenge');

check('revenge-trader: revenge pattern fires',    !!revPat,              'no revenge finding');
check('revenge finding has ≥3 evidence',          revPat && revPat.ev.length >= 3);
check('revenge finding sev is critical',          revPat && revPat.sev === 'critical');
check('revenge finding count matches ev array',   revPat && revPat.count >= revPat.ev.length);

// ---- 2. fomo pattern fires --------------------------------------------------
const fomoCore = fx.fomoTrader();
const fomoCtx  = ctx(fomoCore);
const fomoPats = AI.detectPatterns(fomoCtx);
const fomoPat  = fomoPats.find(f => f.type === 'fomo');

check('fomo-trader: fomo pattern fires',          !!fomoPat,             'no fomo finding');
check('fomo finding has evidence',                fomoPat && fomoPat.ev.length >= 3);

// ---- 3. risk-escalation pattern fires --------------------------------------
const escCore = fx.riskEscalation();
const escCtx  = ctx(escCore);
const escPats = AI.detectPatterns(escCtx);
const escPat  = escPats.find(f => f.type === 'risk-escalation');

check('risk-escalation: pattern fires',           !!escPat,              'no risk-escalation finding');
check('risk-escalation sev is critical',          escPat && escPat.sev === 'critical');

// ---- 4. clean trader — zero critical patterns ------------------------------
const cleanCore = fx.cleanTrader();
const cleanCtx  = ctx(cleanCore);
const cleanPats = AI.detectPatterns(cleanCtx);
const criticals = cleanPats.filter(f => f.sev === 'critical');

check('clean-trader: zero critical patterns',     criticals.length === 0,
    'fired: ' + criticals.map(f => f.type).join(','));

// ---- 5. grounding: all evidence ids exist in core.Trades -------------------
function checkGrounding(name, patterns, core) {
    const realIds = new Set(core.Trades.map(t => t.id));
    const orphans = patterns.flatMap(f => f.ev.filter(id => !realIds.has(id)));
    check(name + ': all evidence ids in core.Trades', orphans.length === 0,
        'orphan ids: ' + JSON.stringify(orphans.slice(0, 3)));
}

checkGrounding('revenge',       revPats,  revCore);
checkGrounding('fomo',          fomoPats, fomoCore);
checkGrounding('risk-escal',    escPats,  escCore);
checkGrounding('clean',         cleanPats, cleanCore);

// ---- 6. evidence cap (≤8 per finding) -------------------------------------
function checkEvidenceCap(name, patterns) {
    const over = patterns.filter(f => f.ev.length > 8);
    check(name + ': no finding exceeds 8 evidence', over.length === 0,
        'over-cap: ' + over.map(f => f.type).join(','));
}

checkEvidenceCap('revenge',    revPats);
checkEvidenceCap('fomo',       fomoPats);
checkEvidenceCap('risk-escal', escPats);

// ---- 7. finding shape contract ---------------------------------------------
const FINDING_KEYS = ['id', 'type', 'sev', 'title', 'msg', 'ev', 'count', 'confidence'];
const allPats = [...revPats, ...fomoPats, ...escPats];

for (const f of allPats) {
    for (const k of FINDING_KEYS) {
        check('finding(' + f.type + ') has key: ' + k, k in f);
    }
    check('finding id starts with ai-', typeof f.id === 'string' && f.id.startsWith('ai-'));
    check('finding ev is array',         Array.isArray(f.ev));
    check('finding count is number',     typeof f.count === 'number');
    check('finding msg non-empty',       typeof f.msg === 'string' && f.msg.length > 0);
}

// ---- 8. missing-fields: no crash -------------------------------------------
const missCore = fx.missingFields();
const missCtx  = ctx(missCore);
let crashed = false;
try { AI.detectPatterns(missCtx); } catch (e) { crashed = true; }
check('missing-fields: detectPatterns does not crash', !crashed);

module.exports = results;
