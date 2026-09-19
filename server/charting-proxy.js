'use strict';

// ============================================================================
// 31TRADES — Charting library signed proxy
// ----------------------------------------------------------------------------
// Keeps the proprietary TradingView library OFF public-by-URL exposure:
//
//   Browser ──▶ /api/charting/lib/<signed-token>/<library file…>
//                     │  token = base64url(payload).base64url(HMAC-SHA256)
//                     │  payload = { userId, exp } — 30-minute TTL
//                     ▼
//              Upstream (in priority order):
//                1. Supabase SIGNED URL  (bucket can be fully PRIVATE)
//                   — used when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set
//                2. Supabase PUBLIC object URL (graceful mode before the
//                   bucket is flipped private)
//                3. Local gitignored charting_library/ dir (dev / offline)
//
//   Secrets (service key, HMAC key) never leave the server. The browser only
//   ever holds short-lived tokens scoped to library paths.
//
//   Caching: every proxied asset answers with `Cache-Control: public,
//   max-age=31536000, immutable` — library asset names are content-hashed,
//   so a 1-year browser/CDN cache is always safe and repeat loads are fast.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const BUCKET = process.env.CHARTING_BUCKET || 'charting-library';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// HMAC key for our short-lived tokens — falls back down the secret chain.
const TOKEN_KEY = process.env.CHARTING_TOKEN_KEY || SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'dev-insecure-key';
const TOKEN_TTL_MS = 30 * 60 * 1000;          // 30 min — chart boot fits easily
const LOCAL_LIB_DIR = path.join(__dirname, '..', 'charting_library');
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const MIME = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.d.ts': 'text/plain; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8'
};

// ---- token issue / verify --------------------------------------------------
function issueToken(userId) {
    const exp = Date.now() + TOKEN_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ u: String(userId || 'anon').slice(0, 64), e: exp }));
    const sig = crypto.createHmac('sha256', TOKEN_KEY).update(payload).digest('base64url');
    return {
        ok: true,
        token: payload.toString('base64url') + '.' + sig,
        expiresInMs: TOKEN_TTL_MS,
        proxyPath: '/api/charting/lib/'
    };
}

function verifyToken(tok) {
    try {
        const i = String(tok).lastIndexOf('.');
        if (i <= 0) return null;
        const payload = Buffer.from(tok.slice(0, i), 'base64url');
        const sig = Buffer.from(tok.slice(i + 1));
        const expect = Buffer.from(crypto.createHmac('sha256', TOKEN_KEY).update(payload).digest('base64url'));
        if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return null;
        const data = JSON.parse(payload.toString('utf8'));
        if (!data || typeof data.e !== 'number' || data.e < Date.now()) return null;
        return data;
    } catch (e) { return null; }
}

// ---- upstream resolution ---------------------------------------------------
async function signedUpstream(relPath) {
    const r = await fetch(SUPABASE_URL + '/storage/v1/object/sign/' + BUCKET + '/' + relPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 120 })
    });
    if (!r.ok) throw new Error('sign failed ' + r.status);
    const j = await r.json();
    if (!j || !j.signedURL) throw new Error('no signedURL');
    return SUPABASE_URL + '/storage/v1' + j.signedURL;
}

/** Serve a library path from the local gitignored copy (dev / offline). */
function serveLocal(relPath, res) {
    const file = path.join(LOCAL_LIB_DIR, relPath);
    if (!file.startsWith(LOCAL_LIB_DIR + path.sep) && file !== LOCAL_LIB_DIR) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('forbidden path');
    }
    let data;
    try { data = fs.readFileSync(file); } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('charting asset missing locally');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': IMMUTABLE_CACHE
    });
    res.end(data);
}

function sanitize(relPath) {
    return String(relPath).split('/').filter(s => s && s !== '.' && s !== '..').slice(0, 10).join('/');
}

// ---- main entry ------------------------------------------------------------
async function handle(req, res, p) {
    const rest = p.slice('/api/charting/lib/'.length);          // "<token>/<path>"
    const slash = rest.indexOf('/');
    if (slash <= 0) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad path'); }
    if (!verifyToken(rest.slice(0, slash))) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('charting token invalid or expired — reload the page');
    }
    const relPath = sanitize(rest.slice(slash + 1));
    if (!relPath) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad path'); }

    // Dev / offline: no Supabase configured → serve the local gitignored copy
    if (!SUPABASE_URL) return serveLocal(relPath, res);

    let target;
    try {
        target = (SERVICE_KEY && SUPABASE_URL)
            ? await signedUpstream(relPath)                                              // private bucket
            : SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + relPath;      // graceful mode
    } catch (e) {
        // signing can fail (key rotated, object absent) → try public, then 404
        target = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + relPath;
    }

    let up;
    try { up = await fetch(target); }
    catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('charting upstream unreachable');
    }
    if (!up.ok) {
        res.writeHead(up.status === 404 ? 404 : 502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('charting asset missing (' + up.status + ')');
    }
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(200, {
        'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': IMMUTABLE_CACHE
    });
    res.end(buf);
}

module.exports = { issueToken, verifyToken, handle, sanitize, _internals: { TOKEN_KEY, TOKEN_TTL_MS } };
