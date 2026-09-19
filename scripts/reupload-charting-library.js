#!/usr/bin/env node
'use strict';

// ============================================================================
// 31TRADES — Re-upload charting library to Supabase Storage with immutable
// cache headers (Cache-Control: public, max-age=31536000, immutable).
// ----------------------------------------------------------------------------
// Why: the original upload used the default no-cache policy, so every browser
// revalidated 600+ assets on each chart load. Library asset names are
// content-hashed → immutable → safe to cache for a year.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reupload-charting-library.js
//   (falls back to .env values when present)
//
// Notes:
//   · Requires the service-role key (anon key cannot overwrite bucket policy
//     reliably and cannot set cacheControl on existing objects).
//   · Uploads are idempotent — safe to re-run. --dry-run lists without sending.
// ============================================================================

const fs = require('fs');
const path = require('path');

// ---- load .env (NAME=VALUE lines, ignore comments) -------------------------
function loadDotEnv(file) {
    try {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
        }
    } catch (e) { /* optional */ }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.CHARTING_BUCKET || 'charting-library';
const LOCAL_DIR = path.join(__dirname, '..', 'charting_library');
const CACHE = 'public, max-age=31536000, immutable';
const CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || 8);
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env or .env). Aborting.');
    process.exit(1);
}

// ---- collect files ---------------------------------------------------------
function walk(dir, base, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = base ? base + '/' + entry.name : entry.name;
        if (entry.isDirectory()) walk(full, rel, out);
        else out.push({ rel, full });
    }
    return out;
}
const files = walk(LOCAL_DIR, '', []);
const totalBytes = files.reduce((a, f) => a + fs.statSync(f.full).size, 0);
console.log('Files: ' + files.length + '  (' + (totalBytes / 1048576).toFixed(1) + ' MB)' + (DRY_RUN ? '  [DRY RUN]' : ''));
if (DRY_RUN) { files.forEach(f => console.log('  ' + f.rel)); process.exit(0); }

const MIME = {
    '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

let done = 0, failed = [];
async function uploadOne(f) {
    const data = fs.readFileSync(f.full);
    const ext = path.extname(f.full).toLowerCase();
    const url = SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + f.rel.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(url, {
        method: 'POST',   // POST creates-or-overwrites in Supabase Storage
        headers: {
            Authorization: 'Bearer ' + SERVICE_KEY,
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'x-upsert': 'true',
            'Cache-Control': CACHE
        },
        body: data
    });
    if (!r.ok) {
        // retry once with PUT (some bucket policies allow update but not create)
        const r2 = await fetch(url, {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': CACHE },
            body: data
        });
        if (!r2.ok) throw new Error(f.rel + ' → ' + r.status + '/' + r2.status);
    }
    done++;
    if (done % 50 === 0) console.log('  …' + done + '/' + files.length);
}

async function pool(items, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
        while (i < items.length) { const f = items[i++]; try { await worker(f); } catch (e) { failed.push(e.message); } }
    });
    await Promise.all(runners);
}

(async () => {
    const t0 = Date.now();
    await pool(files, uploadOne);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\nUploaded ' + (files.length - failed.length) + '/' + files.length + ' in ' + secs + 's');
    if (failed.length) { console.log('FAILED:\n  ' + failed.join('\n  ')); process.exit(1); }

    // ---- verify: headers on a bundle must show the new cache policy ----
    const sample = files.find(f => f.rel.startsWith('bundles/') && f.rel.endsWith('.js'));
    const head = await fetch(SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + sample.rel, { method: 'HEAD' });
    console.log('\nVerify ' + sample.rel + ':');
    console.log('  status: ' + head.status);
    console.log('  cache-control: ' + (head.headers.get('cache-control') || '(none)'));
    console.log(head.status === 200 && /max-age=31536000/.test(head.headers.get('cache-control') || '')
        ? '\n✅ Immutable caching live — repeat chart loads will be fast.'
        : '\n⚠️  Cache header not confirmed — check bucket upload settings.');
})();
