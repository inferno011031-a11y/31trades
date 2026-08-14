'use strict';

// ============================================================================
// 31TRADES — Economic Calendar service
// ----------------------------------------------------------------------------
// Fetches REAL economic calendar events and serves them to the dashboard and
// the AI layer. Provider order:
//   1. FMP economic_calendar — when ECON_CALENDAR_KEY (or FMP_API_KEY) is set
//      and the key validates (401s are caught and we fall through).
//   2. The ForexFactory mirror feed (nfs.faireconomy.media) — keyless, real
//      events with impact/forecast/previous and exact timestamps.
// The browser NEVER calls these providers: the server fetches once and caches
// per UTC day (the mirror rate-limits hard — 429s are expected), so the whole
// app reads from a single cached snapshot. If every provider fails, the API
// returns ok:false with an honest message — NEVER fabricated events.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_TTL_MS = 15 * 60 * 1000;              // re-fetch at most every 15 min
const FMP_BASE = 'https://financialmodelingprep.com/api/v3/economic_calendar';
const MIRROR = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

function cacheFile(day) {
    return path.join(DATA_DIR, 'ecocal-' + day + '.json');
}

// ---- session classification (UTC-based, documented approximation) ----------
// Sessions overlap (London 07–13, New York 13–21, Asia 23–09, Sydney 21–07);
// precedence is fixed so every hour maps to exactly one label:
//   New York > London > Asia > Sydney > Overnight.
const SESSIONS = ['London', 'New York', 'Sydney', 'Asia', 'Overnight'];
function sessionOf(ts) {
    const h = new Date(ts).getUTCHours();
    if (h >= 13 && h < 21) return 'New York';   // 13:00–20:59 UTC
    if (h >= 7 && h < 13) return 'London';      // 07:00–12:59 UTC
    if (h >= 23 || h < 9) return 'Asia';        // 23:00–08:59 UTC (Tokyo/Singapore/HK)
    if (h >= 21 || h < 7) return 'Sydney';      // 21:00–06:59 UTC
    return 'Overnight';
}

// ---- normalization to the app's canonical event shape -----------------------
// Both providers are mapped to: { id, title, country, currency, ts, impact,
// forecast, previous, actual, session, source }
function normFMP(e) {
    const ts = e.date ? new Date(e.date + 'T12:00:00Z').toISOString() : null;   // FMP date is a plain date
    const impact = String(e.impact || 'Low').toLowerCase().indexOf('high') !== -1 ? 'High'
        : String(e.impact || '').toLowerCase().indexOf('medium') !== -1 ? 'Medium' : 'Low';
    return {
        id: 'fmp-' + (e.date || '') + '-' + (e.event || '').replace(/\s+/g, '-').toLowerCase().slice(0, 40),
        title: e.event || 'Economic event',
        country: e.country || '', currency: e.currency || e.country || '',
        ts, impact,
        forecast: e.forecast != null ? String(e.forecast) : null,
        previous: e.previous != null ? String(e.previous) : null,
        actual: e.actual != null ? String(e.actual) : null,
        source: 'fmp'
    };
}
function normMirror(e) {
    const ts = e.date ? new Date(e.date).toISOString() : null;                  // already ISO with offset
    const impact = String(e.impact || 'Low').toLowerCase();
    return {
        id: 'fx-' + (e.date || '') + '-' + (e.title || '').replace(/\s+/g, '-').toLowerCase().slice(0, 40),
        title: e.title || 'Economic event',
        country: e.country || '', currency: e.country || '',
        ts, impact: impact === 'high' ? 'High' : impact === 'medium' ? 'Medium' : 'Low',
        forecast: e.forecast != null ? String(e.forecast) : null,
        previous: e.previous != null ? String(e.previous) : null,
        actual: e.actual != null ? String(e.actual) : null,
        source: 'faireconomy'
    };
}

async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({ headers: { 'User-Agent': '31trades-backend/1.0' } }, opts));
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
    return res.json();
}

// Try providers in order; return { source, events } or null on total failure.
async function fetchFromProviders() {
    const key = process.env.ECON_CALENDAR_KEY || process.env.FMP_API_KEY || '';
    if (key) {
        try {
            const today = new Date();
            const from = today.toISOString().slice(0, 10);
            const to = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
            const data = await fetchJson(FMP_BASE + '?from=' + from + '&to=' + to + '&apikey=' + encodeURIComponent(key));
            if (Array.isArray(data) && data.length) {
                return { source: 'fmp', events: data.map(normFMP).filter(e => e.ts) };
            }
        } catch (e) { /* invalid key / network — fall through */ }
    }
    try {
        const data = await fetchJson(MIRROR);
        if (Array.isArray(data) && data.length) {
            return { source: 'faireconomy', events: data.map(normMirror).filter(e => e.ts) };
        }
    } catch (e) { /* fall through */ }
    return null;
}

// The public entry point: cached per day, served to /api/ecocal.
async function getCalendar(day) {
    const dayStr = day || new Date().toISOString().slice(0, 10);
    const f = cacheFile(dayStr);
    if (fs.existsSync(f)) {
        try {
            const cached = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
        } catch (e) { /* stale/corrupt → refetch */ }
    }
    const got = await fetchFromProviders();
    const out = got ? {
        ok: true, source: got.source, day: dayStr, fetchedAt: Date.now(),
        // every event is session-tagged once, here, so cache + API + AI all
        // read the same classification
        events: got.events.map(e => Object.assign({}, e, { session: sessionOf(e.ts) }))
    } : {
        ok: false, source: 'unavailable', day: dayStr, fetchedAt: Date.now(), events: [],
        error: 'No economic calendar provider reachable — check ECON_CALENDAR_KEY or network. Showing nothing rather than fake events.'
    };
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(f, JSON.stringify(out));
    } catch (e) { /* non-fatal */ }
    return out;
}

// Convenience: today's events by session + impact, with upcoming flag.
// The dashboard shows Moderate → High impact (the user's requirement); pass
// includeAll=true to keep Low/Holiday events too.
function todayBySession(cal, now, includeAll) {
    const t = now || new Date();
    const dayStr = t.toISOString().slice(0, 10);
    let events = (cal.events || []).filter(e => e.ts && e.ts.slice(0, 10) === dayStr);
    if (!includeAll) events = events.filter(e => e.impact === 'High' || e.impact === 'Medium');
    const by = {};
    SESSIONS.forEach(s => { by[s] = events.filter(e => e.session === s); });
    return {
        source: cal.source, day: dayStr, fetchedAt: cal.fetchedAt, ok: cal.ok,
        events, by,
        upcoming: events.filter(e => new Date(e.ts) >= t && new Date(e.ts) <= new Date(t.getTime() + 12 * 3600000))
            .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    };
}

// High/Medium only, in the next N hours — what the AI layer cares about.
function upcomingHighImpact(cal, hours, now) {
    const t = now || new Date();
    const windowEnd = new Date(t.getTime() + (hours || 6) * 3600000);
    return (cal.events || [])
        .filter(e => e.ts && e.impact !== 'Low' && new Date(e.ts) >= t && new Date(e.ts) <= windowEnd)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

module.exports = { getCalendar, todayBySession, upcomingHighImpact, sessionOf, SESSIONS, CACHE_TTL_MS, cacheFile };
