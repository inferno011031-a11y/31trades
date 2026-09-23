'use strict';

// ============================================================================
// 31TRADES — Battle Configuration Contract (the extensibility seam)
// ----------------------------------------------------------------------------
// A Battle is a competitive layer over the SAME backtesting engine, and the
// detailed mechanics / rules / scoring / modes are still to be specified. This
// module exists so those can arrive later WITHOUT rebuilding the replay,
// synchronization or execution layers.
//
// How it works
//   · Every axis a Battle mode may configure is a named SLOT: market, replay,
//     execution, risk, settlement, scoring, visibility.
//   · Each slot declares the FIELDS a mode may set and the named POLICIES the
//     engine can honour. A policy flagged `implemented: false` is registered but
//     NOT built yet.
//   · Requesting an unimplemented policy is a hard ERROR on create and a BLOCKER
//     on start — the engine refuses to run rather than inventing behaviour that
//     nobody has specified. That is the guard against fake mechanics.
//   · Unknown keys are preserved verbatim under `extra` with a warning, so a
//     future specification can read them without a schema migration.
//
// Nothing here decides a rule. It records what a battle IS configured to do and
// what the engine is currently able to do about it.
// ============================================================================

const CONFIG_VERSION = 'battle-config-v1';

// ---------------------------------------------------------------------------
// Timeline resolutions
// ---------------------------------------------------------------------------
// A battle's canonical timeline runs at ONE resolution (`baseTimeframe`); the
// chart may display any resolution at or coarser than it, built by aggregating
// the revealed base bars. These ids are the same ids the rest of the app already
// uses (backtest.js TIMEFRAMES, marketdata ARCHIVE_TIMEFRAMES, the chart's
// RESOLUTION_MAP) — this table only has to agree on the millisecond value of
// every id they share, and `battle-config.test.js` pins that agreement.
const TIMEFRAME_MS = Object.freeze({
    '1m': 60 * 1000, '2m': 2 * 60 * 1000, '3m': 3 * 60 * 1000, '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000, '30m': 30 * 60 * 1000, '1h': 60 * 60 * 1000, '2h': 2 * 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000, '1d': 24 * 60 * 60 * 1000,
    'w': 7 * 24 * 60 * 60 * 1000, 'm': 30 * 24 * 60 * 60 * 1000
});
// finest → coarsest, which is also the order the UI lists them in
const TIMEFRAME_ORDER = Object.freeze(Object.keys(TIMEFRAME_MS));

function timeframeMs(tf) { return TIMEFRAME_MS[String(tf || '')] || null; }
function isTimeframe(tf) { return timeframeMs(tf) != null; }

// which timeframes a battle whose canonical timeline runs at `base` can display:
// the base itself and anything coarser. Refining below the base is impossible —
// the base IS the finest resolution the archive has for that dataset.
function displayTimeframes(base) {
    const b = timeframeMs(base);
    if (b == null) return TIMEFRAME_ORDER.slice();
    return TIMEFRAME_ORDER.filter(tf => TIMEFRAME_MS[tf] >= b);
}

// ---------------------------------------------------------------------------
// resolveBaseTimeframe — the create path's data-availability decision.
// The canonical timeline should be the FINEST resolution the archive actually
// has for that symbol+month, so fills are precise and every coarser timeframe is
// available as a view. `available` is the list straight from the archive
// catalogue (/api/backtest/periods). A host asking for a specific base gets it
// when the archive has it, and an explicit error when it does not — never a
// silent fallback to a different dataset.
// ---------------------------------------------------------------------------
function resolveBaseTimeframe(requested, available) {
    const list = (Array.isArray(available) ? available : []).filter(isTimeframe);
    const ordered = list.slice().sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
    const want = requested ? String(requested) : null;
    if (want) {
        if (!isTimeframe(want)) return { ok: false, error: 'unknown timeframe "' + want + '"', available: ordered };
        if (ordered.length && ordered.indexOf(want) === -1) {
            return { ok: false, error: 'the archive has no ' + want + ' data for this dataset', available: ordered };
        }
        return { ok: true, baseTimeframe: want, available: ordered, requested: true };
    }
    if (!ordered.length) return { ok: true, baseTimeframe: '1m', available: ordered, requested: false, warning: 'no archive timeframe list was supplied — assuming 1m' };
    return { ok: true, baseTimeframe: ordered[0], available: ordered, requested: false };
}

// Battle lifecycle. Extensible by adding a state here; the engine's `transition`
// accepts any of these and nothing else, so an unknown state fails loudly.
const LIFECYCLE = Object.freeze([
    'discovery', 'matching', 'lobby', 'ready', 'battle',
    'settlement', 'results', 'analytics'
]);

// Player availability — deliberately separate from matching and from battle
// rules. A challenge consumes `available`; seating a player moves them to
// `in_battle`; watching without a seat is `spectating`.
const AVAILABILITY = Object.freeze(['online', 'available', 'in_battle', 'spectating', 'offline']);

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------
// `default` is what an unconfigured battle does today (the behaviour the engine
// already has). Every default is `implemented: true`, so an old battle keeps
// working exactly as before.
const SLOTS = Object.freeze({
    market: {
        label: 'Market',
        fields: ['symbol', 'timeframe', 'startingTimeframe', 'baseTimeframe', 'displayTimeframes', 'dataset', 'period', 'session', 'startIndex', 'startAt'],
        policies: {
            'archive-month': { implemented: true, note: 'One real archived month on its FULL canonical timeline — the same source practice backtesting replays.' },
            'live-window': { implemented: true, note: 'Bounded window of the most recent candles (no archive month).' },
            'archive-range': { implemented: false, note: 'An explicit start/end date range inside the archive.' },
            'session-slice': { implemented: false, note: 'Restrict the battle to a single trading session (London / New York / Asia).' }
        },
        default: 'archive-month'
    },
    replay: {
        label: 'Replay',
        fields: ['policy', 'speedMs', 'barStep', 'duration', 'startAt'],
        policies: {
            'host-driven': { implemented: true, note: 'The host plays / pauses / steps the ONE canonical cursor; every seat follows the same bars.' },
            'auto-timed': { implemented: true, note: 'The server ticks the canonical cursor at a configured speed once the battle starts.' },
            'wall-clock': { implemented: false, note: 'Replay speed tied to real elapsed time.' },
            'turn-based': { implemented: false, note: 'Alternating decision windows per seat.' }
        },
        default: 'host-driven'
    },
    execution: {
        label: 'Trading rules',
        fields: ['policy', 'orderTypes', 'slippage', 'spread', 'maxOpenPositions', 'allowHedging', 'allowPartialClose'],
        policies: {
            'market-on-bar': { implemented: true, note: 'Market entries inside the current visible bar; SL/TP fill on the shared bar advance for every seat on the same bar.' },
            'pending-orders': { implemented: false, note: 'Limit / stop orders working across bars.' },
            'spread-and-slippage': { implemented: false, note: 'Costs applied to fills.' },
            'position-limits': { implemented: false, note: 'Caps on concurrent positions / hedging.' }
        },
        default: 'market-on-bar'
    },
    risk: {
        label: 'Risk rules',
        fields: ['policy', 'basis', 'perTrade', 'maxRiskPerTradePct', 'dailyLossLimit', 'maxDrawdown', 'maxTrades'],
        policies: {
            'per-trade-fixed': { implemented: true, note: 'Fixed money risk per trade (the current battle default).' },
            'account-fraction': { implemented: true, note: 'Risk as a percentage of the seat balance.' },
            'prop-firm-model': { implemented: false, note: 'Prop-style limits: daily loss, max drawdown, trade caps.' }
        },
        default: 'per-trade-fixed'
    },
    settlement: {
        label: 'Ending condition',
        fields: ['policy', 'bars', 'endAt', 'equityTarget'],
        policies: {
            'timeline-exhausted': { implemented: true, note: 'The battle ends when the shared cursor reaches the last bar of the canonical timeline.' },
            'fixed-bars': { implemented: false, note: 'End after N revealed bars.' },
            'timestamp': { implemented: false, note: 'End when a historical timestamp is reached.' },
            'fixed-duration': { implemented: false, note: 'End after a wall-clock duration.' },
            'equity-target': { implemented: false, note: 'End when a seat hits an equity objective.' }
        },
        default: 'timeline-exhausted'
    },
    scoring: {
        label: 'Scoring',
        fields: ['policy'],
        policies: {
            'legacy-compat': {
                implemented: true, provisional: true,
                note: 'The existing blended 0–1000 seat score, kept ONLY so current battles still produce output. Explicitly provisional — the real scoring model is not specified yet.'
            },
            'specified-later': { implemented: false, note: 'Reserved for the scoring specification.' }
        },
        default: 'legacy-compat'
    },
    visibility: {
        label: 'Opponent information',
        fields: ['mode', 'fields'],
        policies: {
            presence: { implemented: true, note: 'Default: the opponent is reported as present and working — nothing about their position, risk or P&L.' },
            custom: { implemented: true, note: 'Expose exactly the fields listed in `fields` (server-side filtered per viewer).' },
            full: { implemented: true, note: 'Expose every tracked opponent field. Available, but no mode uses it until specified.' }
        },
        default: 'presence'
    }
});

// ---------------------------------------------------------------------------
// Participant fields — what the sync engine is CAPABLE of reporting about a
// seat. Whether any of it is visible is the `visibility` policy's job; the
// server always filters, and a viewer's own seat fields are never filtered.
// ---------------------------------------------------------------------------
const PARTICIPANT_FIELDS = Object.freeze({
    presence: 'Is the opponent here and working (last seen / last action bar).',
    status: 'Flat or in a trade — never what or where.',
    direction: 'Direction of the open position.',
    risk: 'Risk committed on the open position.',
    pnl: 'Realized and unrealized P&L.',
    trades: 'The seat’s closed trades in this battle.'
});

// identity (seat id, name, team, claimed) is always attached: it is what makes a
// seat a seat, not competitor intelligence.
const IDENTITY_FIELDS = Object.freeze(['id', 'name', 'team', 'claimed', 'mine']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

function defaults() {
    const out = { version: CONFIG_VERSION };
    Object.keys(SLOTS).forEach(k => { out[k] = { policy: SLOTS[k].default }; });
    return out;
}

// A policy is named by `policy`, or by `mode` where the slot declares `mode` as
// its field instead (visibility). Nothing else is inferred — an unreadable policy
// falls back to the slot default, and `normalize` reports when that happened.
function policyOf(slotValue, slotName) {
    const slot = SLOTS[slotName];
    if (slotValue == null) return slot.default;
    if (typeof slotValue === 'string') return slotValue;
    if (isPlainObject(slotValue)) {
        if (slotValue.policy != null) return String(slotValue.policy);
        if (slot.fields.indexOf('mode') !== -1 && slotValue.mode != null) return String(slotValue.mode);
        return slot.default;
    }
    return slot.default;
}

// ---------------------------------------------------------------------------
// normalize — turn any (possibly partial, possibly legacy) input into the
// canonical configuration plus explicit errors/warnings. No silent guessing:
// every deviation is reported.
// ---------------------------------------------------------------------------
function normalize(input) {
    const src = isPlainObject(input) ? input : {};
    const errors = [];
    const warnings = [];
    const extra = {};
    const config = defaults();

    // legacy shape: { asset|symbol, timeframe, session, startAt, rules, ... } at
    // the top level, or the namespaces posted by the older create endpoint.
    const legacyAliases = { asset: 'symbol', market: 'symbol', timeframe: 'timeframe', session: 'session' };

    Object.keys(src).forEach(key => {
        // `version` is the contract's own tag and `extra` is where unknown keys
        // were parked — re-normalizing an already-normalized config must add no
        // warnings and lose nothing.
        if (key === 'version') return;
        if (key === 'extra' && isPlainObject(src.extra)) {
            Object.keys(src.extra).forEach(k => { extra[k] = src.extra[k]; });
            return;
        }
        const slot = SLOTS[key];
        if (slot) {
            const value = src[key];
            const policy = policyOf(value, key);
            if (!slot.policies[policy]) {
                errors.push('unknown ' + key + ' policy "' + policy + '"');
            } else if (!slot.policies[policy].implemented) {
                errors.push(key + ' policy "' + policy + '" is registered but not implemented yet — the engine will not run it');
            }
            config[key] = isPlainObject(value) ? Object.assign({}, value, { policy }) : { policy };
            // a slot that names its policy through `mode` keeps both in step
            if (SLOTS[key].fields.indexOf('mode') !== -1) config[key].mode = policy;
            // copy the declared fields through, warning on undeclared ones
            if (isPlainObject(value)) {
                Object.keys(value).forEach(f => {
                    if (f === 'policy') return;
                    if (slot.fields.indexOf(f) === -1) warnings.push(key + '.' + f + ' is not a declared field of the ' + key + ' slot (kept verbatim)');
                });
            }
            return;
        }
        if (Object.prototype.hasOwnProperty.call(legacyAliases, key)) return;   // folded into market below
        extra[key] = src[key];
        warnings.push('config.' + key + ' is not part of ' + CONFIG_VERSION + ' (kept verbatim under config.extra)');
    });

    // ---- market: fold the legacy top-level market fields into the slot ----
    const m = config.market;
    ['symbol', 'timeframe', 'startingTimeframe', 'baseTimeframe', 'period', 'dataset', 'session', 'startIndex', 'startAt'].forEach(f => {
        const flat = src[f] != null ? src[f] : (src.market && isPlainObject(src.market) ? src.market[f] : undefined);
        if (flat !== undefined && flat !== null && flat !== '') m[f] = flat;
    });
    if (src.asset != null && m.symbol == null) m.symbol = src.asset;
    if (m.symbol != null) m.symbol = String(m.symbol).toUpperCase();
    if (m.timeframe != null) m.timeframe = String(m.timeframe);

    // ---- market timeframes: `timeframe` is kept as a compatibility alias of
    // `startingTimeframe` (the timeframe the chart opens on). The CANONICAL
    // timeline resolution is `baseTimeframe`; when a config does not name one the
    // engine keeps behaving exactly as it did (base = the chosen timeframe) and
    // the create path upgrades it to the finest archive resolution it has.
    if (m.startingTimeframe == null && m.timeframe != null) m.startingTimeframe = m.timeframe;
    if (m.timeframe == null && m.startingTimeframe != null) m.timeframe = m.startingTimeframe;
    ['timeframe', 'startingTimeframe', 'baseTimeframe'].forEach(f => {
        if (m[f] == null) return;
        m[f] = String(m[f]);
        if (!isTimeframe(m[f])) { errors.push('unknown market.' + f + ' "' + m[f] + '"'); delete m[f]; }
    });
    if (m.baseTimeframe == null && m.startingTimeframe != null) m.baseTimeframe = m.startingTimeframe;
    if (m.baseTimeframe != null && m.startingTimeframe != null && timeframeMs(m.startingTimeframe) < timeframeMs(m.baseTimeframe)) {
        warnings.push('market.startingTimeframe (' + m.startingTimeframe + ') is finer than the canonical timeline (' + m.baseTimeframe + ') — the chart will open on ' + m.baseTimeframe);
        m.startingTimeframe = m.baseTimeframe;
        m.timeframe = m.baseTimeframe;
    }
    if (Array.isArray(m.displayTimeframes)) {
        const bad = m.displayTimeframes.filter(tf => !isTimeframe(tf));
        if (bad.length) errors.push('unknown market.displayTimeframes: ' + bad.join(', '));
        m.displayTimeframes = m.displayTimeframes.filter(isTimeframe);
        if (!m.displayTimeframes.length) delete m.displayTimeframes;
    } else {
        delete m.displayTimeframes;
    }
    if (m.session != null && String(m.session).trim() === '') delete m.session;
    if (m.startIndex != null) {
        const n = Number(m.startIndex);
        if (!isFinite(n) || n < 0) { errors.push('market.startIndex must be a non-negative number'); delete m.startIndex; }
        else m.startIndex = Math.round(n);
    }

    // ---- replay speed sanity (a speed is a config value, not a rule) --------
    if (config.replay.speedMs != null) {
        const s = Number(config.replay.speedMs);
        if (!isFinite(s)) { errors.push('replay.speedMs must be a number'); delete config.replay.speedMs; }
        else config.replay.speedMs = clamp(Math.round(s), 40, 600000);
    }

    // ---- visibility fields must be known participant fields ----------------
    if (config.visibility.mode === 'custom') {
        const list = Array.isArray(config.visibility.fields) ? config.visibility.fields : [];
        const unknown = list.filter(f => !PARTICIPANT_FIELDS[f]);
        if (unknown.length) errors.push('unknown visibility field(s): ' + unknown.join(', '));
        config.visibility.fields = list.filter(f => PARTICIPANT_FIELDS[f]);
        if (!list.length) warnings.push('visibility.mode = custom with no fields — nothing about opponents will be exposed');
    } else if (config.visibility.mode === 'full') {
        config.visibility.fields = Object.keys(PARTICIPANT_FIELDS);
    } else {
        config.visibility.fields = ['presence'];
    }

    if (Object.keys(extra).length) config.extra = extra;

    // A contradiction between the market policy and the archive month warns.
    // "archive-month without a period" is NOT a contradiction — that is the
    // normal request shape, and the create endpoint resolves and records the
    // month it picked (so re-reading a stored config stays silent).
    if (m.period && m.policy === 'live-window') warnings.push('market.period is set while market.policy is live-window — the archive month will be ignored');

    return { config, errors, warnings, version: CONFIG_VERSION };
}

// ---------------------------------------------------------------------------
// blockers — what stops this configuration from running today. Empty means the
// engine can honour every configured policy with existing behaviour.
// ---------------------------------------------------------------------------
function blockers(config) {
    const out = [];
    const c = config || {};
    Object.keys(SLOTS).forEach(slotName => {
        const slot = SLOTS[slotName];
        const policy = policyOf(c[slotName], slotName);
        const known = slot.policies[policy];
        if (!known) out.push(slotName + ': unknown policy "' + policy + '"');
        else if (!known.implemented) out.push(slotName + ': "' + policy + '" is not implemented yet');
    });
    return out;
}

function canRun(config) {
    const b = blockers(config);
    return { ok: !b.length, blockers: b };
}

// Which participant fields the server may report for this battle. `presence` is
// always included: it is what makes the opponent panel alive at all.
function participantFields(config) {
    const c = config || {};
    const mode = policyOf(c.visibility, 'visibility');
    if (mode === 'full') return Object.keys(PARTICIPANT_FIELDS);
    if (mode === 'custom') {
        const list = (c.visibility && Array.isArray(c.visibility.fields)) ? c.visibility.fields.filter(f => PARTICIPANT_FIELDS[f]) : [];
        return list.indexOf('presence') === -1 ? ['presence'].concat(list) : list;
    }
    return ['presence'];
}

function visibilityMode(config) {
    return policyOf((config || {}).visibility, 'visibility');
}

// The scoring adapter in force for a configuration. `provisional: true` is
// honest bookkeeping — no final scoring model has been specified yet, and every
// surface that shows a score is expected to say so.
function scoringOf(config) {
    const policy = policyOf((config || {}).scoring, 'scoring');
    const known = SLOTS.scoring.policies[policy] || {};
    return { id: policy, provisional: !!known.provisional, implemented: !!known.implemented };
}

// ---------------------------------------------------------------------------
// capabilities — the catalogue the API/UI reads so the lobby can offer only
// what exists, and can label the rest as "not specified yet" instead of faking
// it. This is the single source of truth for "what can a Battle be told to do".
// ---------------------------------------------------------------------------
function capabilities() {
    const slots = Object.keys(SLOTS).map(name => {
        const s = SLOTS[name];
        return {
            slot: name,
            label: s.label,
            fields: s.fields.slice(),
            default: s.default,
            policies: Object.keys(s.policies).map(p => ({
                policy: p,
                implemented: !!s.policies[p].implemented,
                provisional: !!s.policies[p].provisional,
                note: s.policies[p].note || null
            }))
        };
    });
    return {
        version: CONFIG_VERSION,
        lifecycle: LIFECYCLE.slice(),
        availability: AVAILABILITY.slice(),
        identityFields: IDENTITY_FIELDS.slice(),
        participantFields: Object.keys(PARTICIPANT_FIELDS).map(f => ({ field: f, note: PARTICIPANT_FIELDS[f] })),
        defaults: defaults(),
        timeframes: {
            order: TIMEFRAME_ORDER.slice(),
            ms: Object.assign({}, TIMEFRAME_MS),
            note: 'A battle timeline runs at ONE canonical resolution (market.baseTimeframe). The chart may display that resolution or any coarser one, built by aggregating the revealed base bars; the canonical base is never a limit on what a player may look at, and a display choice can never change execution.'
        },
        slots,
        specified: false,   // battle mechanics/scoring/modes are not specified yet
        note: 'Battle modes, rules, scoring and matchmaking are not specified yet. This catalogue is what the engine can already honour; everything else must be added as an implemented policy.'
    };
}

module.exports = {
    CONFIG_VERSION, LIFECYCLE, AVAILABILITY, SLOTS, PARTICIPANT_FIELDS, IDENTITY_FIELDS,
    TIMEFRAME_MS, TIMEFRAME_ORDER, timeframeMs, isTimeframe, displayTimeframes, resolveBaseTimeframe,
    defaults, normalize, blockers, canRun, participantFields, visibilityMode, scoringOf, capabilities, policyOf
};
