'use strict';

// ============================================================================
// 31TRADES — Global leaderboard (social layer)
// ----------------------------------------------------------------------------
// Cross-user standings, computed from each trader's OWN canonical ledger and
// published as a compact snapshot. Nothing here re-derives P&L with a second
// implementation: the snapshot is a per-day aggregate of the same trades the
// journal, risk and discipline engines already own.
//
//   core.Trades (live only, BACKTEST/practice excluded)
//        │  daysFromTrades()          → { 'YYYY-MM-DD': {n,w,l,gW,gL,rS,rk} }
//        ▼
//   leaderboard_entries.days ──filterDays(range)──▶ metricsFromDays() ──▶ board
//
// Storing day-level aggregates (instead of one number per range) means ANY
// window — 7d / 30d / 90d / YTD / a calendar quarter season / an arbitrary month
// / all time — is computed on read, so new ranges and future analytics
// dimensions need no schema change and no re-publish.
//
// Ranking philosophy mirrors the battle scoring engine: the headline metric is
// a blended, process-weighted BattleX Score (win rate + avg R + recovery +
// profit factor, gated by a minimum sample), so a single oversized win never
// outranks consistent execution. Raw net P&L is still available as a metric.
//
// Privacy: publication happens on demand from the caller's own request (see the
// routes) and an entry is only ever readable when the trader's profile is
// public AND exposes that metric (server/profiles.js). No email, user id or
// trade-level detail is exposed anywhere in this module's output.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');
const Profiles = require('./profiles.js');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Metrics a board can be ranked by.
const METRICS = ['bxScore', 'net', 'winRate', 'avgR', 'pf', 'trades', 'discipline'];

// Named ranges. Anything else matching the patterns below is also accepted.
const RANGES = ['7d', '30d', '90d', 'ytd', 'season', 'all'];

const MIN_TRADES_DEFAULT = 10;   // publish floor — stops 1-trade flukes topping a board

// Re-publishing is self-healing (any board read refreshes the caller's own row)
// but throttled so a scrolling UI can't hammer the store.
const PUBLISH_THROTTLE_MS = 45000;

// ---------------------------------------------------------------------------
// PURE HELPERS (unit-tested without any storage)
// ---------------------------------------------------------------------------

const dayKeyOf = ts => {
    const d = new Date(ts);
    if (!isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
};

const r2 = x => Math.round(x * 100) / 100;

// Live ledger only — practice/backtest records never leak into the boards.
function liveTrades(core) {
    const list = (core && Array.isArray(core.Trades)) ? core.Trades : [];
    return list.filter(t => t && t.source !== 'BACKTEST' && t.account_id !== 'practice' && dayKeyOf(t.ts));
}

// trades[] → { 'YYYY-MM-DD': { n, w, l, gW, gL, rS, rk } }
//   n = trades · w/l = wins/losses · gW/gL = gross win / gross loss (abs)
//   rS = ΣR · rk = Σ risk $
function daysFromTrades(trades) {
    const days = {};
    (trades || []).forEach(t => {
        const key = dayKeyOf(t.ts);
        if (!key) return;
        const d = days[key] || (days[key] = { n: 0, w: 0, l: 0, gW: 0, gL: 0, rS: 0, rk: 0, net: 0 });
        const pnl = Number(t.pnl) || 0;
        d.n++;
        if (pnl > 0) { d.w++; d.gW += pnl; }
        else if (pnl < 0) { d.l++; d.gL += Math.abs(pnl); }
        d.rS += Number(t.r) || 0;
        d.rk += Number(t.risk) || 0;
        d.net += pnl;
    });
    Object.keys(days).forEach(k => {
        const d = days[k];
        d.gW = r2(d.gW); d.gL = r2(d.gL); d.rS = Math.round(d.rS * 1000) / 1000;
        d.rk = r2(d.rk); d.net = r2(d.net);
    });
    return days;
}

const validRange = range =>
    RANGES.indexOf(String(range || '').toLowerCase()) !== -1 ||
    /^\d{4}(-q[1-4]|-\d{1,2})?$/.test(String(range || '').toLowerCase());

// 'season' → the live calendar quarter id, e.g. '2026-Q3'
function seasonId(now) {
    const d = now || new Date();
    return d.getUTCFullYear() + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1);
}

// range → { from, to } (null = all time). Unknown/blank → all time.
function rangeWindow(range, now) {
    const n = now || new Date();
    const r = String(range || 'all').toLowerCase();
    if (!r || r === 'all') return null;
    let m;
    if ((m = r.match(/^(\d+)d$/))) return { from: new Date(n.getTime() - Number(m[1]) * 864e5), to: n };
    if (r === 'ytd') return { from: new Date(Date.UTC(n.getUTCFullYear(), 0, 1)), to: n };
    if (r === 'season') {
        const q = Math.floor(n.getUTCMonth() / 3);
        return { from: new Date(Date.UTC(n.getUTCFullYear(), q * 3, 1)), to: n };
    }
    if ((m = r.match(/^(\d{4})-q([1-4])$/))) {
        const y = Number(m[1]), q = Number(m[2]) - 1;
        return { from: new Date(Date.UTC(y, q * 3, 1)), to: new Date(Date.UTC(y, q * 3 + 3, 1)) };
    }
    if ((m = r.match(/^(\d{4})-(\d{1,2})$/))) {
        const y = Number(m[1]), mo = Number(m[2]) - 1;
        if (mo < 0 || mo > 11) return null;
        return { from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 1)) };
    }
    if ((m = r.match(/^(\d{4})$/))) {
        const y = Number(m[1]);
        return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) };
    }
    return null;
}

function filterDays(days, win) {
    const all = days || {};
    if (!win) return all;
    const from = win.from ? dayKeyOf(win.from) : null;
    const to = win.to ? dayKeyOf(win.to) : null;
    const out = {};
    Object.keys(all).sort().forEach(k => {
        if (from && k < from) return;
        if (to && k >= to) return;
        out[k] = all[k];
    });
    return out;
}

// Day aggregates → headline metrics. Percentages are 0–100 (one decimal).
function metricsFromDays(days) {
    const keys = Object.keys(days || {}).sort();
    let n = 0, w = 0, l = 0, gW = 0, gL = 0, rS = 0, rk = 0, net = 0;
    let bestDay = null, worstDay = null;
    const curve = [];
    let cum = 0, peak = 0, maxDD = 0;

    keys.forEach(k => {
        const d = days[k] || {};
        n += d.n || 0; w += d.w || 0; l += d.l || 0;
        gW += d.gW || 0; gL += d.gL || 0; rS += d.rS || 0; rk += d.rk || 0;
        const dn = d.net || 0;
        net += dn;
        cum += dn;
        peak = Math.max(peak, cum);
        maxDD = Math.max(maxDD, peak - cum);
        curve.push({ day: k, net: r2(dn), equity: r2(cum) });
        if (!bestDay || dn > bestDay.net) bestDay = { day: k, net: r2(dn) };
        if (!worstDay || dn < worstDay.net) worstDay = { day: k, net: r2(dn) };
    });

    // consecutive winning/losing DAYS (best + current)
    let best = 0, run = 0, runWin = null;
    keys.forEach(k => {
        const dn = (days[k] && days[k].net) || 0;
        if (dn === 0) { run = 0; runWin = null; return; }
        const isWin = dn > 0;
        if (isWin === runWin) run++; else { runWin = isWin; run = 1; }
        best = Math.max(best, run);
    });
    let cur = 0, curWin = null;
    for (let i = keys.length - 1; i >= 0; i--) {
        const dn = (days[keys[i]] && days[keys[i]].net) || 0;
        if (dn === 0) break;
        const isWin = dn > 0;
        if (curWin === null) { curWin = isWin; cur = 1; }
        else if (curWin === isWin) cur++;
        else break;
    }

    const decided = w + l;
    return {
        n, trades: n, wins: w, losses: l,
        net: r2(net),
        grossWin: r2(gW), grossLoss: r2(gL),
        winRate: decided ? Math.round((w / decided) * 1000) / 10 : 0,
        avgR: n ? Math.round((rS / n) * 1000) / 1000 : 0,
        pf: gL ? Math.round((gW / gL) * 100) / 100 : (gW ? 3 : 0),
        maxDD: r2(maxDD),
        recovery: maxDD ? Math.round((net / maxDD) * 100) / 100 : 0,
        avgRisk: n ? r2(rk / n) : 0,
        activeDays: keys.length,
        bestDay, worstDay,
        bestDayStreak: best,
        streak: { type: curWin === null ? null : (curWin ? 'win' : 'loss'), len: cur },
        curve
    };
}

// Blended 0–1000, process-weighted (same philosophy as the battle scorer).
// null below the sample floor — a board must not be topped by a 2-trade fluke.
function bxScore(m, minTrades) {
    const floor = Number(minTrades) > 0 ? Number(minTrades) : MIN_TRADES_DEFAULT;
    if (!m || m.n < floor) return null;
    const winComp = clamp(m.winRate / 100, 0, 1);
    const avgRComp = clamp((m.avgR + 1) / 3, 0, 1);          // −1R → 0 · +2R → 1
    const recovery = m.maxDD > 0 ? m.net / m.maxDD : (m.net > 0 ? 3 : 0);
    const recComp = clamp(recovery / 3, 0, 1);                // 3× recovery = full credit
    const consComp = clamp(m.pf / 2, 0, 1);                   // PF 2.0 = full credit
    const activity = clamp(m.n / (floor * 2), 0, 1);
    const raw = 0.30 * winComp + 0.30 * avgRComp + 0.20 * recComp + 0.20 * consComp;
    return {
        score: Math.round(1000 * raw * activity),
        comps: {
            winRate: Math.round(winComp * 1000) / 1000,
            avgR: Math.round(avgRComp * 1000) / 1000,
            recovery: Math.round(recComp * 1000) / 1000,
            consistency: Math.round(consComp * 1000) / 1000,
            activity: Math.round(activity * 1000) / 1000
        }
    };
}

// ---------------------------------------------------------------------------
// Storage — Supabase first, JSON file fallback
// ---------------------------------------------------------------------------

const ROW_COLUMNS = [
    'user_id', 'handle', 'display_name', 'avatar', 'country', 'squad_id',
    'days', 'discipline', 'first_trade_at', 'last_trade_at'
];

function storeFile() {
    return path.join(process.env.TRADEMIND_SOCIAL_DATA_DIR || path.join(__dirname, '..', 'data'), 'leaderboard.json');
}

const isoOrNull = v => {
    if (!v) return null;
    const d = new Date(v);
    return isFinite(d.getTime()) ? d.toISOString() : null;
};

function fromRow(r) {
    return {
        userId: r.user_id,
        handle: r.handle || null,
        displayName: r.display_name || null,
        avatar: r.avatar || null,
        country: r.country || null,
        squadId: r.squad_id || null,
        days: r.days && typeof r.days === 'object' ? r.days : {},
        discipline: r.discipline == null ? null : Number(r.discipline),
        firstTradeAt: r.first_trade_at || null,
        lastTradeAt: r.last_trade_at || null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null
    };
}

function toRow(e) {
    return [
        e.userId, e.handle, e.displayName, e.avatar, e.country, e.squadId,
        JSON.stringify(e.days || {}), e.discipline,
        e.firstTradeAt ? new Date(e.firstTradeAt) : null,
        e.lastTradeAt ? new Date(e.lastTradeAt) : null
    ];
}

function readFile() {
    try {
        const f = storeFile();
        if (fs.existsSync(f)) {
            const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (raw && typeof raw === 'object') return raw;
        }
    } catch (e) { /* ignore */ }
    return {};
}

function writeFile(map) {
    try {
        const f = storeFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(map));
    } catch (e) { /* ignore */ }
}

async function dbAll() {
    const pool = db.getPool();
    if (!pool) return null;
    try {
        const r = await pool.query('SELECT * FROM leaderboard_entries');
        return r.rows.map(fromRow);
    } catch (e) { return null; }
}

async function dbUpsert(e) {
    const pool = db.getPool();
    if (!pool) return false;
    try {
        const row = toRow(e);
        const params = row.map((_, i) => '$' + (i + 1));
        await pool.query(
            'INSERT INTO leaderboard_entries (' + ROW_COLUMNS.join(', ') + ', updated_at) VALUES (' +
            params.join(', ') + ', now()) ' +
            'ON CONFLICT (user_id) DO UPDATE SET ' +
            ROW_COLUMNS.slice(1).map((c, i) => c + ' = $' + (i + 2)).join(', ') +
            ', updated_at = now()',
            row
        );
        return true;
    } catch (err) {
        return false;
    }
}

// Every published entry (DB merged over the file mirror).
async function readAll() {
    const file = readFile();
    const out = {};
    Object.keys(file).forEach(uid => { out[uid] = file[uid]; });
    const rows = await dbAll();
    if (rows) rows.forEach(e => { out[e.userId] = e; });
    return Object.values(out);
}

async function entryFor(userId) {
    const uid = String(userId || '');
    const rows = await dbAll();
    if (rows) {
        const hit = rows.find(e => e.userId === uid);
        if (hit) return hit;
    }
    return readFile()[uid] || null;
}

async function put(entry) {
    await dbUpsert(entry);
    const map = readFile();
    map[entry.userId] = entry;
    writeFile(map);
}

// ---------------------------------------------------------------------------
// Publish — snapshot the caller's own ledger into their standings entry
// ---------------------------------------------------------------------------

// userId is the partition; publish never reaches into another user's data.
async function publish(userId, opts) {
    const uid = String(userId || '');
    if (!uid) return { ok: false, error: 'missing user' };
    const o = opts || {};
    const core = o.core;
    if (!core) return { ok: false, error: 'missing core state' };

    const profile = o.profile || await Profiles.get(uid);
    const prev = (await entryFor(uid)) || {};

    // Fresh enough? Skip the rewrite unless the caller forces it.
    if (!o.force && prev.updatedAt && (Date.now() - new Date(prev.updatedAt).getTime()) < PUBLISH_THROTTLE_MS) {
        return { ok: true, entry: prev, skipped: true, summary: summarize(prev) };
    }

    const trades = liveTrades(core);
    const days = daysFromTrades(trades);

    // discipline is evaluation-derived (not a day aggregate) → snapshot it
    let discipline = prev.discipline == null ? null : prev.discipline;
    try {
        const accounts = (core.Accounts || []).filter(a => a && a.id && a.id !== 'practice');
        const accountId = o.accountId || (accounts[0] && accounts[0].id) || null;
        if (accountId && typeof core.disciplineState === 'function') {
            const d = core.disciplineState(accountId, {});
            if (d && typeof d.score === 'number') discipline = d.score;
        }
    } catch (e) { /* discipline is optional on the boards */ }

    const keys = Object.keys(days).sort();
    const entry = {
        userId: uid,
        handle: profile.handle || null,
        displayName: profile.displayName || null,
        avatar: profile.avatar || null,
        country: profile.country || null,
        squadId: prev.squadId || null,        // owned by squad membership (setSquad)
        days,
        discipline,
        firstTradeAt: keys.length ? keys[0] + 'T00:00:00.000Z' : null,
        lastTradeAt: keys.length ? keys[keys.length - 1] + 'T23:59:59.999Z' : null,
        updatedAt: new Date().toISOString()
    };
    await put(entry);
    return { ok: true, entry, summary: summarize(entry) };
}

// Squad membership writes back into the standings row so the squad board can
// filter without a second lookup (squads → leaderboard, one-way dependency).
async function setSquad(userId, squadId) {
    const uid = String(userId || '');
    if (!uid) return { ok: false, error: 'missing user' };
    const prev = (await entryFor(uid)) || {
        userId: uid, handle: null, displayName: null, avatar: null, country: null,
        days: {}, discipline: null, firstTradeAt: null, lastTradeAt: null
    };
    const entry = { ...prev, squadId: squadId || null, updatedAt: new Date().toISOString() };
    await put(entry);
    return { ok: true, entry };
}

// Compact public summary of one entry (used by /me and by the squads module).
function summarize(entry, opts) {
    const o = opts || {};
    const win = rangeWindow(o.range || 'all');
    const m = metricsFromDays(filterDays(entry.days, win));
    const bx = bxScore(m, o.minTrades);
    return {
        userId: entry.userId,
        handle: entry.handle || null,
        displayName: entry.displayName || null,
        avatar: entry.avatar || null,
        country: entry.country || null,
        squadId: entry.squadId || null,
        discipline: entry.discipline == null ? null : entry.discipline,
        updatedAt: entry.updatedAt || null,
        metrics: m,
        bxScore: bx ? bx.score : null,
        bxComps: bx ? bx.comps : null
    };
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

const METRIC_VALUE = {
    bxScore: r => (r.bxScore == null ? -Infinity : r.bxScore),
    net: r => r.metrics.net,
    winRate: r => r.metrics.winRate,
    avgR: r => r.metrics.avgR,
    pf: r => r.metrics.pf,
    trades: r => r.metrics.n,
    discipline: r => (r.discipline == null ? -Infinity : r.discipline)
};

// Mask every metric the trader keeps private. The ranking metric of a board is
// guaranteed visible (rows without it are filtered out before this runs).
function maskRow(row, allowed) {
    const m = row.metrics;
    return {
        ...row,
        metrics: {
            trades: allowed.trades ? m.trades : null,
            wins: allowed.winRate ? m.wins : null,
            losses: allowed.winRate ? m.losses : null,
            net: allowed.net ? m.net : null,
            winRate: allowed.winRate ? m.winRate : null,
            avgR: allowed.avgR ? m.avgR : null,
            pf: allowed.net ? m.pf : null,
            maxDD: allowed.net ? m.maxDD : null,
            avgRisk: allowed.net ? m.avgRisk : null,
            activeDays: m.activeDays,
            bestDay: allowed.net ? m.bestDay : null,
            worstDay: allowed.net ? m.worstDay : null,
            bestDayStreak: m.bestDayStreak,
            streak: m.streak
        },
        bxScore: allowed.bxScore ? row.bxScore : null,
        bxComps: allowed.bxScore ? row.bxComps : null,
        discipline: allowed.discipline ? row.discipline : null
    };
}

// Every eligible row for a board, ranked. `board()` slices this.
async function standings(opts) {
    const o = opts || {};
    const metric = METRICS.indexOf(o.metric) !== -1 ? o.metric : 'bxScore';
    const range = validRange(o.range) ? String(o.range).toLowerCase() : '30d';
    const minTrades = Number(o.minTrades) > 0 ? Math.round(Number(o.minTrades)) : MIN_TRADES_DEFAULT;
    const win = rangeWindow(range);

    const [entries, profiles] = await Promise.all([readAll(), Profiles.all()]);
    const rows = [];
    entries.forEach(e => {
        const p = profiles[e.userId];
        if (!p || p.visibility.public !== true) return;              // strictly opt-in
        if (o.squadId && e.squadId !== o.squadId) return;
        const allowed = Profiles.allowedMetrics(p);
        if (metric === 'discipline') allowed.discipline = allowed.discipline && e.discipline != null;
        if (!allowed[metric]) return;                                // hidden metric → unranked
        const m = metricsFromDays(filterDays(e.days, win));
        if (m.n < minTrades) return;                                 // sample floor
        const bx = bxScore(m, minTrades);
        rows.push(maskRow({
            userId: e.userId,
            handle: p.handle,
            displayName: p.displayName || p.handle,
            avatar: p.avatar,
            country: p.country,
            squadId: e.squadId || null,
            discipline: e.discipline == null ? null : e.discipline,
            updatedAt: e.updatedAt || null,
            metrics: m,
            bxScore: bx ? bx.score : null,
            bxComps: bx ? bx.comps : null
        }, allowed));
    });

    rows.sort((a, b) => {
        const d = METRIC_VALUE[metric](b) - METRIC_VALUE[metric](a);
        if (d) return d;
        const t = (b.metrics.activeDays || 0) - (a.metrics.activeDays || 0);
        if (t) return t;
        return String(a.handle || '').localeCompare(String(b.handle || ''));
    });
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { metric, range, minTrades, rows };
}

async function board(opts) {
    const o = opts || {};
    const limit = clamp(Number(o.limit) > 0 ? Math.round(Number(o.limit)) : 25, 1, 100);
    const offset = Math.max(0, Math.round(Number(o.offset) || 0));
    const s = await standings(o);
    return {
        ok: true,
        metric: s.metric,
        range: s.range,
        season: seasonId(),
        minTrades: s.minTrades,
        total: s.rows.length,
        limit, offset,
        rows: s.rows.slice(offset, offset + limit)
    };
}

// The caller's own standing — works even when they are private or below the
// floor, so the UI can always explain WHY they are not on a board.
async function myRank(userId, opts) {
    const uid = String(userId || '');
    const o = opts || {};
    const s = await standings(o);
    const idx = s.rows.findIndex(r => r.userId === uid);
    const entry = await entryFor(uid);
    const profile = await Profiles.get(uid);
    const win = rangeWindow(s.range);
    const mine = entry
        ? summarize({ ...entry, handle: profile.handle || entry.handle, displayName: profile.displayName || entry.displayName, avatar: profile.avatar || entry.avatar, country: profile.country || entry.country }, { range: s.range, minTrades: s.minTrades })
        : null;

    const reasons = [];
    if (!profile.visibility.public) reasons.push('your profile is private — enable it in profile settings');
    const allowed = Profiles.allowedMetrics(profile);
    if (!allowed[s.metric]) reasons.push('you hide the «' + s.metric + '» metric — enable it to be ranked by it');
    if (mine && mine.metrics.n < s.minTrades) reasons.push('needs at least ' + s.minTrades + ' trades in this range (you have ' + mine.metrics.n + ')');

    return {
        ok: true,
        metric: s.metric,
        range: s.range,
        minTrades: s.minTrades,
        total: s.rows.length,
        ranked: idx !== -1,
        rank: idx !== -1 ? idx + 1 : null,
        percentile: idx !== -1 && s.rows.length > 1
            ? Math.round((1 - idx / s.rows.length) * 1000) / 10
            : null,
        profile: Profiles.publicProfile(profile),
        metrics: mine ? mine.metrics : null,
        bxScore: mine ? mine.bxScore : null,
        bxComps: mine ? mine.bxComps : null,
        discipline: entry && entry.discipline != null && profile.visibility.showDiscipline !== false ? entry.discipline : null,
        reasons
    };
}

// Entries for a set of users (squad standings) — no ranking, no masking here.
async function entriesFor(userIds) {
    const want = new Set((userIds || []).map(String));
    if (!want.size) return [];
    const all = await readAll();
    return all.filter(e => want.has(e.userId));
}

module.exports = {
    METRICS, RANGES, MIN_TRADES_DEFAULT, PUBLISH_THROTTLE_MS, ROW_COLUMNS,
    // pure helpers (unit-tested directly)
    dayKeyOf, daysFromTrades, rangeWindow, filterDays, metricsFromDays, bxScore,
    validRange, seasonId, liveTrades,
    // storage + read models
    publish, setSquad, entryFor, readAll, entriesFor, summarize,
    standings, board, myRank,
    fromRow, toRow, storeFile
};
