'use strict';

// ============================================================================
// BATTLEXJOURNAL — Gold dataset month-splitter
// ----------------------------------------------------------------------------
// One-time tool. Reads the full-history CSVs in data/gold/ and writes
// per-month JSON archives the backtester market-data layer serves:
//
//     data/gold/2024-06/xau_15m_2024-06.json
//
// JSON shape (matches the existing jan2024/feb2024 archives):
//     { symbol, timeframe, period: 'YYYY-MM', label: 'June 2024', candles: [...] }
//     candle: { time (unix seconds), open, high, low, close, volume }
//
// Also derives timeframes that have no source CSV:
//     2m, 3m  ← aggregated from 1m
//     6h      ← aggregated from 1h
//     w, m    ← aggregated from 1d
//
// Run:  node tools/split-gold-months.js [--only=2024-03,2024-06]
// ============================================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const GOLD = path.join(ROOT, 'data', 'gold');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

// tf → source CSV (derived TFs handled after the split pass)
// NOTE: XAU_30m_data.csv / XAU_2h_data.csv are empty placeholders —
// 30m is derived from 1m and 2h from 1h below.
const BASE_TFS = [
    { tf: '1m', csv: 'XAU_1m_data.csv' },
    { tf: '5m', csv: 'XAU_5m_data.csv' },
    { tf: '15m', csv: 'XAU_15m_data.csv' },
    { tf: '1h', csv: 'XAU_1h_data.csv' },
    { tf: '4h', csv: 'XAU_4h_data.csv' },
    { tf: '1d', csv: 'XAU_1d_data.csv' }
];

const only = (process.argv.find(a => a.startsWith('--only=')) || '')
    .replace('--only=', '').split(',').map(s => s.trim()).filter(Boolean);

function monthKey(dateStr) { return dateStr.slice(0, 7).replace('.', '-'); } // '2024.06' → '2024-06'
function monthLabel(key) { const [y, m] = key.split('-'); return MONTH_NAMES[Number(m) - 1] + ' ' + y; }
function wanted(key) { return only.length === 0 || only.includes(key); }

function outPath(monthKeyStr, tf) {
    return path.join(GOLD, monthKeyStr, `xau_${tf}_${monthKeyStr}.json`);
}

function writeMonth(key, tf, candles) {
    const dir = path.join(GOLD, key);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
        symbol: 'XAUUSD',
        timeframe: tf,
        period: key,
        label: monthLabel(key),
        candles
    };
    fs.writeFileSync(outPath(key, tf), JSON.stringify(payload));
    return payload.candles.length;
}

// ---- pass 1: stream each CSV → per-month candle arrays ---------------------
async function splitCsv(tf, csvName) {
    const src = path.join(GOLD, csvName);
    if (!fs.existsSync(src)) { console.log('  ! missing CSV, skipped: ' + csvName); return; }

    const buckets = new Map(); // 'YYYY-MM' → candles[]
    const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });

    let first = true;
    for await (const line of rl) {
        if (first) { first = false; continue; }             // header
        if (!line) continue;
        const p = line.split(';');
        if (p.length < 5) continue;
        const key = monthKey(p[0]);
        if (!wanted(key)) continue;
        // Date '2024.06.11 07:18' → unix seconds (UTC)
        const [d, t] = p[0].split(' ');
        const [Y, Mo, D] = d.split('.').map(Number);
        const parts = (t || '00:00').split(':').map(Number);
        const time = Math.floor(Date.UTC(Y, Mo - 1, D, parts[0] || 0, parts[1] || 0) / 1000);
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push({ time, open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] || 0 });
    }

    let files = 0, bars = 0;
    for (const [key, candles] of buckets) {
        if (!candles.length) continue;
        bars += writeMonth(key, tf, candles);
        files++;
    }
    console.log('  ' + tf.padEnd(4) + ' → ' + files + ' month files, ' + bars.toLocaleString() + ' bars');
}

// ---- pass 2: derive TFs that have no CSV -----------------------------------
function aggregate(monthCandles, bucketSec) {
    const out = [];
    let cur = null, curKey = null;
    for (const c of monthCandles) {
        const key = Math.floor(c.time / bucketSec);
        if (key !== curKey) {
            if (cur) out.push(cur);
            curKey = key;
            cur = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
        } else {
            cur.high = Math.max(cur.high, c.high);
            cur.low = Math.min(cur.low, c.low);
            cur.close = c.close;
            cur.volume += c.volume;
        }
    }
    if (cur) out.push(cur);
    return out;
}

function aggregateWeeks(monthCandles) {
    // TV-style weeks start Monday; bar dated at the week's first bar
    const out = [];
    let cur = null, curWeek = null;
    for (const c of monthCandles) {
        const day = Math.floor(c.time / 86400);
        const dow = (day + 4) % 7;                       // 0 = Thursday (epoch)
        const monday = day - ((dow + 6) % 7);            // shift so 0 = Monday
        if (monday !== curWeek) {
            if (cur) out.push(cur);
            curWeek = monday;
            cur = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
        } else {
            cur.high = Math.max(cur.high, c.high);
            cur.low = Math.min(cur.low, c.low);
            cur.close = c.close;
            cur.volume += c.volume;
        }
    }
    if (cur) out.push(cur);
    return out;
}

function collapseMonth(monthCandles) {
    // A month file IS one monthly candle: first open, last close, extremes
    const c = monthCandles;
    if (!c.length) return [];
    return [{
        time: c[0].time, open: c[0].open,
        high: Math.max(...c.map(x => x.high)),
        low: Math.min(...c.map(x => x.low)),
        close: c[c.length - 1].close,
        volume: c.reduce((s, x) => s + x.volume, 0)
    }];
}

async function derive(tf, fromTf, mode) {
    let files = 0, bars = 0;
    const dirs = fs.readdirSync(GOLD).filter(d => /^\d{4}-\d{2}$/.test(d) && wanted(d));
    for (const dir of dirs) {
        const src = path.join(GOLD, dir, `xau_${fromTf}_${dir}.json`);
        if (!fs.existsSync(src)) continue;
        const out = outPath(dir, tf);
        if (fs.existsSync(out)) continue;                // idempotent re-runs
        const base = JSON.parse(fs.readFileSync(src, 'utf8')).candles;
        const candles = mode === 'week' ? aggregateWeeks(base)
            : mode === 'month' ? collapseMonth(base)
            : aggregate(base, mode);
        bars += writeMonth(dir, tf, candles);
        files++;
    }
    console.log('  ' + tf.padEnd(4) + ' ← ' + fromTf + ' → ' + files + ' month files, ' + bars.toLocaleString() + ' bars');
}

(async function main() {
    console.log('BattleX gold month-splitter' + (only.length ? ' (only: ' + only.join(', ') + ')' : ''));
    console.log('Pass 1 — split source CSVs by month:');
    for (const { tf, csv } of BASE_TFS) await splitCsv(tf, csv);
    console.log('Pass 2 — derive missing timeframes:');
    await derive('2m', '1m', 120);
    await derive('3m', '1m', 180);
    await derive('30m', '1m', 1800);
    await derive('2h', '1h', 7200);
    await derive('6h', '1h', 21600);
    await derive('w', '1d', 'week');
    await derive('m', '1d', 'month');                    // one monthly candle per month file
    console.log('Done.');
})();
