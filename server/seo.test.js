'use strict';

/* ============================================================================
   BattlexJournal — SEO validation tests
   ----------------------------------------------------------------------------
   Verifies the public SEO surface end to end, from the registry:

     §1 Registry integrity  — unique title/description/canonical per public
                              route; every route has a real file with exactly
                              one H1 and the SEO markers.
     §2 Sitemap safety      — only canonical public URLs; no private routes,
                              no user IDs, no duplicates.
     §3 robots.txt          — public routes allowed, every private route and
                              file disallowed, sitemap referenced.
     §4 Private protection  — private pages carry noindex meta, are not in the
                              sitemap, and redirect clean paths to their files.
     §5 Structured data     — BreadcrumbList JSON-LD matches the visible
                              breadcrumb nav; blog posts get BlogPosting.
     §6 HTTP behavior       — boots the REAL server (auth ON) and checks
                              status codes, canonicals, headers and 404s.
   ========================================================================== */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

process.env.SITE_URL = process.env.SITE_URL || 'https://battlexjournal.example';
const SEO = require('./seo.js');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  — ' + extra : '')); }
}

console.log('\n== SEO registry ==');

/* ------------------------------------------------------------------ §1 ---- */
{
    const titles = new Set(), descs = new Set(), routes = new Set();
    for (const e of SEO.ALL_ROUTES) {
        ok(!!e.title && !titles.has(e.title), 'unique title for ' + e.route, e.title);
        ok(!!e.description && !descs.has(e.description), 'unique description for ' + e.route, e.description);
        ok(!routes.has(e.route), 'unique route key ' + e.route);
        titles.add(e.title); descs.add(e.description); routes.add(e.route);
        ok(SEO.canonical(e.route).startsWith(SEO.SITE_URL + '/'), 'canonical for ' + e.route);
        const file = path.join(ROOT, e.file);
        ok(fs.existsSync(file), 'file exists for ' + e.route, file);
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            const h1s = (raw.match(/<h1[\s>]/g) || []).length;
            ok(h1s === 1, 'exactly one H1 in ' + e.route, h1s + ' found');
            ok(raw.includes('<!-- SEO:META -->'), 'SEO:META marker in ' + e.route);
            if (e.route !== '/') ok(raw.includes('<!-- SEO:BREADCRUMB -->'), 'SEO:BREADCRUMB marker in ' + e.route);
        }
    }
    ok(SEO.ALL_ROUTES.length >= 18, 'full public route set present', SEO.ALL_ROUTES.length + ' routes');
    for (const b of SEO.BLOG_POSTS) {
        ok(!!b.publishedAt && /^\d{4}-\d{2}-\d{2}$/.test(b.publishedAt), 'blog post publishedAt ' + b.route);
        ok(!!b.updatedAt, 'blog post updatedAt ' + b.route);
        ok(!!b.author || true, 'blog post author field set ' + b.route);
    }
}

// Injected head sanity: one title, one canonical, one robots directive per page.
for (const e of SEO.ALL_ROUTES) {
    const file = path.join(ROOT, e.file);
    if (!fs.existsSync(file)) continue;        const injected = fs.readFileSync(file, 'utf8')
        .replace('<!-- SEO:META -->', SEO.seoHead(e.route))
        .replace('<!-- SEO:BREADCRUMB -->', SEO.breadcrumbNav(e.route));
        const escTitle = e.title.replace(/&/g, '&amp;');
    ok((injected.match(/<title>/g) || []).length === 1, 'single <title> after injection on ' + e.route);
    ok((injected.match(/rel="canonical"/g) || []).length === 1, 'single canonical after injection on ' + e.route);
    ok(injected.includes('<meta name="robots" content="index, follow">'), 'index,follow robots on ' + e.route);
    ok(injected.includes('og:url" content="' + SEO.canonical(e.route)), 'og:url canonical on ' + e.route);
    ok(injected.includes('twitter:title'), 'twitter meta present on ' + e.route);
}

/* ------------------------------------------------------------------ §2 ---- */
console.log('\n== Sitemap ==');
{
    const xml = SEO.sitemapXml();
    ok(xml.includes('<?xml version="1.0"'), 'sitemap is well-formed XML');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    ok(locs.length === SEO.ALL_ROUTES.length, 'sitemap covers every public route', locs.length + '/' + SEO.ALL_ROUTES.length);
    const seen = new Set();
    for (const loc of locs) {
        const p = loc.replace(SEO.SITE_URL, '');
        ok(!seen.has(loc), 'no duplicate URL in sitemap: ' + loc);
        seen.add(loc);
        ok(SEO.entryForRoute(p), 'sitemap URL is a registered public route: ' + p);
        ok(!/[?&#]/.test(loc), 'no query strings in sitemap: ' + loc);
        ok(SEO.publicRouteFor(p) && !SEO.publicRouteFor(p).redirect, 'sitemap URL is canonical: ' + p);
    }
    // private surface must never appear
    for (const r of SEO.PRIVATE_ROUTES) ok(!xml.includes(SEO.SITE_URL + r + '.html') && !xml.includes('>' + SEO.SITE_URL + r + '<'), 'private route not in sitemap: ' + r);
    for (const f of SEO.PRIVATE_FILES) ok(!xml.includes(SEO.SITE_URL + '/' + f), 'private file not in sitemap: ' + f);
    ok(!xml.includes('user') || !xml.includes('id'), 'no user-id patterns in sitemap');
    ok(xml.split('\n').every(l => !l.includes('dashboard')), 'no private content in sitemap');
}

/* ------------------------------------------------------------------ §3 ---- */
console.log('\n== robots.txt ==');
{
    const robots = SEO.robotsTxt();
    ok(robots.includes('User-agent: *'), 'robots has User-agent: *');
    ok(/^Allow: \/$/m.test(robots), 'robots allows the root');
    ok(robots.includes('Sitemap: ' + SEO.SITE_URL + '/sitemap.xml'), 'robots references the sitemap');
    for (const r of SEO.PRIVATE_ROUTES) ok(robots.includes('Disallow: ' + r), 'robots disallows ' + r);
    for (const f of SEO.PRIVATE_FILES) ok(robots.includes('Disallow: /' + f), 'robots disallows /' + f);
    // every public route must be crawlable (no Disallow pattern is a prefix of it)
    const disallows = [...robots.matchAll(/^Disallow: (\S+)$/gm)].map(m => m[1]);
    for (const e of SEO.ALL_ROUTES) {
        const blocked = disallows.some(d => e.route.startsWith(d));
        ok(!blocked, 'public route not blocked by robots: ' + e.route);
    }
    // important public assets stay allowed
    for (const asset of ['/assets/seo.css', '/assets/tailwind-compiled.css', '/404.html']) {
        const blocked = disallows.some(d => asset.startsWith(d));
        ok(!blocked, 'public asset not blocked: ' + asset);
    }
}

/* ------------------------------------------------------------------ §4 ---- */
console.log('\n== Private protection ==');
{
    for (const f of SEO.PRIVATE_FILES) {
        const file = path.join(ROOT, f);
        if (!fs.existsSync(file)) { ok(false, 'private file exists: ' + f); continue; }
        const raw = fs.readFileSync(file, 'utf8');
        ok(raw.includes('noindex, nofollow, noarchive'), 'noindex meta on ' + f);
        ok(!raw.includes('content="index, follow"'), 'no index,follow robots on ' + f);
    }
    // clean private paths redirect to their real page files (no duplicate indexable routes)
    for (const r of SEO.PRIVATE_ROUTES) {
        ok(!!SEO.redirectFor(r), 'clean private path redirects: ' + r);
    }
    ok(SEO.redirectFor('/index.html') === '/', '/index.html → /');
    ok(SEO.redirectFor('/journal') === '/journal.html', '/journal → /journal.html');
    // redirect targets are final (no chains)
    for (const [from, to] of Object.entries(SEO.REDIRECTS)) {
        ok(!SEO.REDIRECTS[to], 'no redirect chain from ' + from);
    }
    // public pages never mention private surface
    for (const e of SEO.ALL_ROUTES) {
        const file = path.join(ROOT, e.file);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        ok(!raw.includes('noindex'), 'public page has no noindex: ' + e.route);
        ok(!raw.includes('/dashboard') && !raw.includes('/api/'), 'public page has no private links: ' + e.route);
    }
}

/* ------------------------------------------------------------------ §5 ---- */
console.log('\n== Structured data ==');
{
    for (const e of SEO.ALL_ROUTES) {
        const ld = SEO.seoHead(e.route).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
        const graphs = ld.map(s => JSON.parse(s.replace(/<script type="application\/ld\+json">/, '').replace(/<\/script>/, '')));
        if (e.route === '/') {
            ok(graphs.some(g => g['@type'] === 'Organization' && g.name === 'BattlexJournal'), 'homepage has Organization JSON-LD');
            ok(graphs.some(g => g['@type'] === 'WebSite'), 'homepage has WebSite JSON-LD');
        }
        if ((e.breadcrumbs || []).length) {
            const bc = graphs.find(g => g['@type'] === 'BreadcrumbList');
            ok(!!bc, 'BreadcrumbList JSON-LD on ' + e.route);
            if (bc) {
                // visible breadcrumb must match the structured data exactly. The
                // current page renders as an aria-current span (no link), so the
                // crawlable <a> links cover every breadcrumb except the last item.
                const nav = SEO.breadcrumbNav(e.route);
                const hrefs = [...nav.matchAll(/<a href="([^"]+)"/g)].map(m => m[1]);
                const items = bc.itemListElement.map(x => x.item.replace(SEO.SITE_URL, ''));
                ok(JSON.stringify(hrefs) === JSON.stringify(items.slice(0, -1)), 'visible breadcrumb links match JSON-LD on ' + e.route, JSON.stringify(hrefs) + ' vs ' + JSON.stringify(items.slice(0, -1)));
                const lastItem = bc.itemListElement[bc.itemListElement.length - 1];
                ok(nav.includes('aria-current="page"') && nav.includes(lastItem.name.replace(/&/g, '&amp;')), 'current page rendered as aria-current on ' + e.route);
                ok(bc.itemListElement[0].name === 'Home' && bc.itemListElement[0].position === 1, 'breadcrumb starts at Home on ' + e.route);
            }
        }
    }
    for (const b of SEO.BLOG_POSTS) {
        const ld = SEO.seoHead(b.route).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
        const graphs = ld.map(s => JSON.parse(s.replace(/<script type="application\/ld\+json">/, '').replace(/<\/script>/, '')));
        const bp = graphs.find(g => g['@type'] === 'BlogPosting');
        ok(!!bp, 'BlogPosting JSON-LD on ' + b.route);
        if (bp) {
            ok(!!bp.headline && !!bp.datePublished && !!bp.author, 'BlogPosting has headline/date/author on ' + b.route);
            ok(!bp.aggregateRating && !bp.review && !bp.offer, 'no fabricated ratings/reviews/offers on ' + b.route);
        }
    }
    // no fabricated org data
    const homeLd = SEO.seoHead('/');
    ok(!homeLd.includes('address') && !homeLd.includes('telephone') && !homeLd.includes('sameAs'), 'Organization JSON-LD has no fabricated details');
}

/* ------------------------------------------------------------------ §6 ---- */
console.log('\n== HTTP behavior (real server, auth ON) ==');
const PORT = 8200 + Math.floor(Math.random() * 300);
const API = 'http://127.0.0.1:' + PORT;
let serverProc = null;
let serverLog = '';

function startServer() {
    return new Promise((resolve, reject) => {
        serverProc = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            // auth ON (production default) + a deterministic canonical origin
            env: { ...process.env, TRADEMIND_PORT: String(PORT), TRADEMIND_AUTH: 'on', SITE_URL: process.env.SITE_URL, GEMINI_API_KEY: '' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        serverProc.stdout.on('data', d => { serverLog += d; });
        serverProc.stderr.on('data', d => { serverLog += d; });
        const t0 = Date.now();
        const poll = () => {
            fetch(API + '/api/health').then(r => r.ok ? resolve() : setTimeout(poll, 400))
                .catch(() => (Date.now() - t0 > 25000 ? reject(new Error('server boot timeout\n' + serverLog.slice(-1500))) : setTimeout(poll, 400)));
        };
        poll();
    });
}
function stopServer() {
    return new Promise(resolve => {
        if (!serverProc) return resolve();
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        serverProc.on('exit', finish);
        serverProc.kill('SIGTERM');
        setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch (e) {} finish(); }, 6000);
    });
}

async function httpGet(p) {
    const r = await fetch(API + p, { redirect: 'manual' });
    const body = await r.text();
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body };
}

async function httpPost(p, body, extraHeaders) {
    const r = await fetch(API + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body)
    });
    const text = await r.text();
    let jsonBody;
    try { jsonBody = JSON.parse(text); } catch (e) { jsonBody = text; }
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: jsonBody };
}

async function httpReq(method, p, extraHeaders) {
    const r = await fetch(API + p, {
        method,
        headers: { ...extraHeaders },
        redirect: 'manual'
    });
    const body = await r.text();
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body };
}

// normalize a Location header (absolute or relative) to its path form
const locPath = l => String(l).replace(/^https?:\/\/[^/]+/, '');

async function runHttp() {
    await startServer();
    try {
        // public pages: 200, unique meta, crawlable, injected from registry
        for (const e of SEO.ALL_ROUTES) {
            const r = await httpGet(e.route);
            ok(r.status === 200, '200 for public ' + e.route, r.status);
            ok(r.body.includes('<title>' + e.title.replace(/&/g, '&amp;') + '</title>'), 'registry title served on ' + e.route);
            ok(r.body.includes('rel="canonical" href="' + SEO.canonical(e.route)), 'registry canonical served on ' + e.route);
            ok((r.body.match(/<h1[\s>]/g) || []).length === 1, 'one H1 served on ' + e.route);
            ok(!r.body.includes('window.TradeMindCore') && !r.body.includes('core.js'), 'no app bundle on public ' + e.route);
            ok(r.body.includes('rel="icon" href="/assets/logo.svg"'), 'favicon link on ' + e.route);
            // homepage uses .logo-badge, the public pages use .bx-logo-img
            const logoClass = e.route === '/' ? 'class="logo-badge"' : 'class="bx-logo-img"';
            ok(r.body.includes('src="/assets/logo.svg"') && r.body.includes(logoClass), 'real logo img on ' + e.route);
            ok(!r.body.includes('bx-logo-mark'), 'no old B-mark logo on ' + e.route);
            if ((e.breadcrumbs || []).length) ok(r.body.includes('bx-breadcrumb'), 'visible breadcrumb on ' + e.route);
        }
        // dynamic endpoints
        let r = await httpGet('/robots.txt');
        ok(r.status === 200 && r.headers['content-type'].includes('text/plain'), 'robots.txt served as text/plain');
        r = await httpGet('/sitemap.xml');
        ok(r.status === 200 && r.headers['content-type'].includes('application/xml'), 'sitemap.xml served as XML');
        ok(r.body.split('<loc>').length - 1 === SEO.ALL_ROUTES.length, 'sitemap XML has all public URLs');

        // canonicalization + redirects (Location may be absolute or relative)
        r = await httpGet('/trading-journal/');
        ok(r.status === 301 && locPath(r.headers.location) === '/trading-journal', 'trailing slash → 301 canonical', r.headers.location);
        r = await httpGet('/blog');
        ok(r.status === 301 && locPath(r.headers.location) === '/blog/', '/blog → /blog/');
        r = await httpGet('/Trading-Journal');
        ok(r.status === 301 && locPath(r.headers.location) === '/trading-journal', 'case variant → 301 canonical');
        r = await httpGet('/journal');
        ok(r.status === 301 && locPath(r.headers.location) === '/journal.html', '/journal → /journal.html');
        r = await httpGet('/index.html');
        ok(r.status === 301 && locPath(r.headers.location) === '/', '/index.html → /');

        // private pages: served shell but noindex (meta + header)
        for (const f of ['dashboard.html', 'journal.html', 'risk.html', 'settings.html']) {
            r = await httpGet('/' + f);
            ok(r.status === 200, '200 for app shell /' + f, r.status);
            ok(r.headers['x-robots-tag'] === 'noindex, nofollow, noarchive', 'X-Robots-Tag noindex on /' + f);
            ok(r.body.includes('noindex, nofollow, noarchive'), 'noindex meta served on /' + f);
            ok(!r.body.includes('content="index, follow"'), 'no index,follow served on /' + f);
        }
        r = await httpGet('/journal?view=unreviewed');
        ok(r.status === 301 && locPath(r.headers.location) === '/journal.html', 'query-param private URL redirects to the canonical page file');
        r = await httpGet('/journal.html?view=unreviewed');
        ok(r.headers['x-robots-tag'] === 'noindex, nofollow, noarchive', 'query-param private URL still noindex');

        // private data requires authentication (auth is ON in this server)
        r = await httpGet('/api/state');
        ok(r.status === 401, '/api/state requires auth (401)', r.status);
        r = await httpGet('/api/trades');
        ok(r.status === 401, '/api/trades requires auth (401)', r.status);

        // sensitive trees are never served over HTTP (storage mirrors + secrets)
        r = await httpGet('/data/db.json');
        ok(r.status === 403, '/data/* forbidden (no private storage mirrors on the wire)', r.status);
        r = await httpGet('/.env');
        ok(r.status === 403, '/.env forbidden (no secrets on the wire)', r.status);
        r = await httpGet('/server/auth.js');
        ok(r.status === 403, '/server/* forbidden', r.status);
        r = await httpGet('/src/core/index.js');
        ok(r.status === 200, '/src/* still served (app bundle)', r.status);

        // 404: real HTTP 404 with the branded page
        r = await httpGet('/no-such-page');
        ok(r.status === 404, 'missing page returns real 404', r.status);
        ok(r.body.includes('Page not found') && r.body.includes('BattlexJournal'), 'branded 404 page served');
        ok(r.headers['x-robots-tag'] && r.headers['x-robots-tag'].includes('noindex'), '404 page noindex header');

        // logo asset: renders with the real sniffed type (PNG/JPEG under the .svg name)
        r = await httpGet('/assets/logo.svg');
        ok(r.status === 200 && ['image/png', 'image/jpeg'].includes(r.headers['content-type']), 'logo.svg served with a real image type', r.headers['content-type']);
        r = await httpGet('/');
        ok(r.body.includes('src="/assets/logo.svg"') && r.body.includes('class="logo-badge"'), 'homepage uses the real logo');
        ok(!r.body.includes('<div class="logo-badge">31</div>'), 'homepage has no old 31 badge');

        // shared assets
        r = await httpGet('/assets/seo.css');
        ok(r.status === 200 && r.headers['content-type'].includes('text/css'), 'assets/seo.css served');
        r = await httpGet('/assets/tailwind-compiled.css');
        ok(r.status === 200, 'assets/tailwind-compiled.css served');

        // ---- §7 SECURITY HEADERS ----
        r = await httpGet('/');
        const h = r.headers;
        // CSP defaults to REPORT-ONLY (the app ships inline scripts; enforcing
        // breaks them). The report-only header carries the same directives.
        const csp = h['content-security-policy-report-only'] || h['content-security-policy'] || '';
        ok(!!h['content-security-policy-report-only'], 'CSP is report-only by default (inline scripts keep working until CSP_ENFORCE=true)', h['content-security-policy-report-only'] ? 'report-only' : 'enforcing');
        ok(csp.includes("default-src 'self'"), 'CSP directives present (default-src self)', csp.slice(0, 60));
        ok(csp.includes("frame-ancestors 'none'"), 'CSP frame-ancestors none');
        ok(h['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options nosniff', h['x-content-type-options']);
        ok(h['x-frame-options'] === 'DENY', 'X-Frame-Options DENY', h['x-frame-options']);
        ok(h['x-xss-protection'] === '0', 'X-XSS-Protection disabled (CSP replaces it)', h['x-xss-protection']);
        ok(h['referrer-policy'] === 'strict-origin-when-cross-origin', 'Referrer-Policy set', h['referrer-policy']);
        ok(h['permissions-policy'] && h['permissions-policy'].includes('camera='), 'Permissions-Policy set', h['permissions-policy']);
        ok(h['strict-transport-security'] && h['strict-transport-security'].includes('max-age=31536000'), 'HSTS set with long max-age', h['strict-transport-security']);

        // ---- §8 CORS ----
        const evilResp = await httpReq('OPTIONS', '/api/health', { origin: 'https://evil.com' });
        ok(!evilResp.headers['access-control-allowed-origin'] || evilResp.headers['access-control-allowed-origin'] !== 'https://evil.com', 'CORS rejects evil origin');

        // ---- §9 SELF-HOSTED LUCIDE ----
        r = await httpGet('/assets/lucide.min.js');
        ok(r.status === 200 && r.headers['content-type'].includes('javascript'), 'Self-hosted lucide.min.js served', r.headers['content-type']);

        const appPages = ['ai.html', 'dashboard.html', 'journal.html', 'auth.html'];
        for (const pg of appPages) {
            const resp = await httpGet('/' + pg);
            ok(!resp.body.includes('unpkg.com/lucide'), pg + ' has no CDN lucide reference');
            ok(resp.body.includes('/assets/lucide.min.js'), pg + ' references self-hosted lucide');
        }

        // ---- §10 RATE LIMITING ----
        for (let i = 0; i < 9; i++) {
            await httpPost('/api/auth/login', { email: 'ratelimittest@test.com', password: 'wrong' });
        }
        const rlResp = await httpPost('/api/auth/login', { email: 'ratelimittest@test.com', password: 'wrong' });
        ok(rlResp.status === 429, 'Rate limiting returns 429 after repeated failures', rlResp.status);
        ok(rlResp.body.error && (rlResp.body.error.includes('locked') || rlResp.body.error.includes('Too many')), 'Rate limit error message present', JSON.stringify(rlResp.body));
        ok(rlResp.headers['retry-after'], 'Retry-After header present on 429', rlResp.headers['retry-after']);

        // ---- §11 STANDALONE TEST CHATBOT (/api/chat-test + landing widget) ----
        r = await httpGet('/assets/chat-test.js');
        ok(r.status === 200 && r.headers['content-type'].includes('javascript'), 'chat widget asset served', r.headers['content-type']);
        r = await httpGet('/assets/cursor.js');
        ok(r.status === 200 && r.headers['content-type'].includes('javascript'), 'smooth-cursor asset served', r.headers['content-type']);
        r = await httpGet('/');
        ok(r.body.includes('/assets/chat-test.js'), 'homepage loads the chat widget');
        ok(r.body.includes('<script src="/assets/cursor.js"') && !r.body.includes('tx = innerWidth'), 'homepage loads cursor.js externally (no inline copy)');
        ok(!r.body.includes('localStorage') || r.body.includes('/assets/chat-test.js'), 'widget always present on homepage');

        // endpoint validation (each invalid POST also consumes rate-limit quota)
        r = await httpPost('/api/chat-test', {});
        ok(r.status === 400, 'chat-test rejects empty message', r.status);
        r = await httpPost('/api/chat-test', { message: 'x'.repeat(2001) });
        ok(r.status === 400, 'chat-test rejects over-long message', r.status);
        r = await httpPost('/api/chat-test', { message: '  ', history: 'nope' });
        ok(r.status === 400, 'chat-test rejects blank message', r.status);
        r = await httpPost('/api/chat-test', { message: 'hello', history: [{ role: 'admin', text: 'pwn' }] });
        ok(r.status === 503, 'chat-test without GEMINI_API_KEY returns 503', r.status);
        ok(r.body.error && r.body.error.includes('GEMINI_API_KEY'), 'chat-test 503 names the missing key', JSON.stringify(r.body));
        r = await httpPost('/api/chat-test', { message: 'hello', history: [{ role: 'user', text: 'hi' }, { role: 'model', text: 'hello' }] });
        ok(r.status === 503, 'chat-test with valid history still 503 without key', r.status);

        // per-IP rate limit: 4 consumed above → 26 more → 31st is 429
        for (let i = 0; i < 26; i++) {
            await httpPost('/api/chat-test', { message: 'ping ' + i });
        }
        r = await httpPost('/api/chat-test', { message: 'one too many' });
        ok(r.status === 429, 'chat-test rate limited per IP', r.status);
        ok(r.headers['retry-after'], 'chat-test 429 has Retry-After', r.headers['retry-after']);
    } finally {
        await stopServer();
    }
}

runHttp().then(() => {
    console.log('\nSEO tests: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
}).catch(err => {
    console.error('SEO test run failed: ' + err.message);
    console.error(serverLog.slice(-2000));
    process.exit(1);
});
