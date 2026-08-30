'use strict';

/* ============================================================================
   BattlexJournal — SEO registry (single source of truth)
   ----------------------------------------------------------------------------
   One registry drives everything the public site publishes:

     · PUBLIC_PAGES   — every indexable public route (title, description,
                        canonical, OG, sitemap priority, breadcrumbs)
     · BLOG_POSTS     — articles under /blog/ (full BlogPosting metadata)
     · PRIVATE_ROUTES — authenticated app paths (never indexed, never in
                        the sitemap)
     · REDIRECTS      — 301 map for legacy / alternate URL forms

   The server builds the <head> meta for each public page from this registry
   (pages carry a `<!-- SEO:META -->` marker), generates /sitemap.xml and
   /robots.txt from it, and rewrites the private-page robots directive.
   There is no second source of truth anywhere else in the repo.

   Run-time knobs:
     SITE_URL — the canonical origin used in canonicals + sitemap. Defaults to
     the current deployment; set it to the real BattlexJournal domain in
     production (Railway → Variables → SITE_URL=https://battlexjournal.com).
   ========================================================================== */

const SITE_URL = (process.env.SITE_URL || 'https://31trades-production.up.railway.app').replace(/\/+$/, '');
const BRAND = 'BattlexJournal';
const BRAND_DESC = 'BattlexJournal — a trading journal, risk engine, discipline tracker and performance analytics platform in one private workspace.';

/* ---------------------------------------------------------------------------
   PUBLIC PAGES — ordered like the internal link graph (home first).
   `file` is relative to the project root. Every route here is indexable and
   lands in the sitemap. All titles/descriptions are unique and factual.
   ------------------------------------------------------------------------- */
const PUBLIC_PAGES = [
    {
        route: '/',
        file: 'dashboard.html',
        title: 'Dashboard | BattlexJournal',
        description: 'BattlexJournal is a private trading journal with risk management, discipline tracking and performance analytics.',
        priority: '1.0', changefreq: 'daily',
        h1: 'Dashboard'
    },
    {
        route: '/trading-journal',
        file: 'public/trading-journal.html',
        title: 'Trading Journal | BattlexJournal',
        description: 'Keep a structured trading journal in BattlexJournal: log every trade with entry, exit, risk, R and setup, then review it against your rules and performance history.',
        priority: '0.9', changefreq: 'weekly',
        breadcrumbs: [{ name: 'Home', route: '/' }]
    },
    {
        route: '/trading-journal-template',
        file: 'public/trading-journal-template.html',
        title: 'Trading Journal Template | BattlexJournal',
        description: 'See what a complete trading journal template contains — the fields every trader should record — and how BattlexJournal turns a template into an analytical system.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Trading Journal', route: '/trading-journal' }]
    },
    {
        route: '/trade-journal-import',
        file: 'public/trade-journal-import.html',
        title: 'Trade Journal Import — CSV, Excel & Google Sheets | BattlexJournal',
        description: 'Import your existing trading journal into BattlexJournal from CSV, Excel (.xlsx), Google Sheets or Notion exports. Validate every row before it enters your ledger.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Trading Journal', route: '/trading-journal' }]
    },
    {
        route: '/trading-journal-for-forex',
        file: 'public/trading-journal-for-forex.html',
        title: 'Forex Trading Journal | BattlexJournal',
        description: 'A trading journal built for forex traders: log symbol, direction, entry and exit, risk, R multiple, session and setup — then analyze your forex performance over time.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Trading Journal', route: '/trading-journal' }]
    },
    {
        route: '/trading-journal-for-futures',
        file: 'public/trading-journal-for-futures.html',
        title: 'Futures Trading Journal | BattlexJournal',
        description: 'Journal futures trades with contract-aware P&L and risk tracking: entry, exit, ticks and points, risk per trade, sessions and setups — reviewed against your own rules.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Trading Journal', route: '/trading-journal' }]
    },
    {
        route: '/trading-journal-for-prop-firm-traders',
        file: 'public/trading-journal-for-prop-firm-traders.html',
        title: 'Trading Journal for Prop Firm Traders | BattlexJournal',
        description: 'Journal your prop firm evaluation with daily risk, drawdown and discipline tracking. Monitor your rules, trade frequency and review process — without any performance guarantees.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Trading Journal', route: '/trading-journal' }]
    },
    {
        route: '/trading-journal-for-day-traders',
        file: 'public/trading-journal-for-day-traders.html',
        title: 'Day Trading Journal | BattlexJournal',
        description: 'A day trading journal for logging trades, sessions, setups and behavior — with daily reviews and performance analysis that show you what actually works.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Trading Journal', route: '/trading-journal' }]
    },
    {
        route: '/trading-discipline',
        file: 'public/trading-discipline.html',
        title: 'Trading Discipline | BattlexJournal',
        description: 'Trading discipline is a process, not a personality trait. BattlexJournal measures rule adherence, tracks clean days and flags the behaviors that break your process.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }]
    },
    {
        route: '/trading-risk-management',
        file: 'public/trading-risk-management.html',
        title: 'Trading Risk Management | BattlexJournal',
        description: 'Risk management for traders: risk per trade, daily risk limits, drawdown and trade frequency — tracked automatically by BattlexJournal and checked before you enter.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }]
    },
    {
        route: '/trading-performance-analytics',
        file: 'public/trading-performance-analytics.html',
        title: 'Trading Performance Analytics | BattlexJournal',
        description: 'Analyze your trading performance with win rate, profit factor, expectancy, average R, drawdown and equity curve — broken down by strategy, setup, session and symbol.',
        priority: '0.8', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }]
    },
    {
        route: '/trading-replay',
        file: 'public/trading-replay.html',
        title: 'Trading Replay & Market Replay | BattlexJournal',
        description: 'Practice on historical price data with BattlexJournal Market Replay: step bar by bar through real market history, time your decisions, and review them without risking capital.',
        priority: '0.7', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }]
    },
    {
        route: '/trading-journal-guide',
        file: 'public/trading-journal-guide.html',
        title: 'How to Keep a Trading Journal — The Complete Guide | BattlexJournal',
        description: 'The complete guide to keeping a trading journal: what to record before, during and after every trade, how to review it, and how to turn the data into a better process.',
        priority: '0.7', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Trading Journal', route: '/trading-journal' }]
    }
];

/* ---------------------------------------------------------------------------
   BLOG POSTS — real, useful articles. Each entry carries the full set of
   article metadata so the blog architecture can grow without touching the
   server. `file` is relative to the project root.
   ------------------------------------------------------------------------- */
const BLOG_POSTS = [
    {
        route: '/blog/how-to-start-a-trading-journal',
        file: 'public/blog/how-to-start-a-trading-journal.html',
        title: 'How to Start a Trading Journal (Step by Step) | BattlexJournal Blog',
        description: 'A practical, step-by-step guide to starting a trading journal: what to record, how to keep it consistent, and how to review it weekly without the overwhelm.',
        publishedAt: '2026-08-18',
        updatedAt: '2026-08-18',
        priority: '0.6', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Blog', route: '/blog/' }]
    },
    {
        route: '/blog/trading-journal-mistakes',
        file: 'public/blog/trading-journal-mistakes.html',
        title: '7 Trading Journal Mistakes That Quietly Sabotage Progress | BattlexJournal Blog',
        description: 'The most common trading journal mistakes — inconsistent logging, vague notes, skipped reviews — and how to fix each one so your journal actually improves your trading.',
        publishedAt: '2026-08-18',
        updatedAt: '2026-08-18',
        priority: '0.6', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Blog', route: '/blog/' }]
    },
    {
        route: '/blog/how-to-review-trades',
        file: 'public/blog/how-to-review-trades.html',
        title: 'How to Review Your Trades Like a Trader Who Actually Improves | BattlexJournal Blog',
        description: 'A repeatable framework for reviewing your trades: score the decision, separate process from outcome, find the one thing to fix, and turn each review into a rule.',
        publishedAt: '2026-08-18',
        updatedAt: '2026-08-18',
        priority: '0.6', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Blog', route: '/blog/' }]
    },
    {
        route: '/blog/trading-risk-management-basics',
        file: 'public/blog/trading-risk-management-basics.html',
        title: 'Trading Risk Management Basics: Position Sizing, Daily Limits, Drawdown | BattlexJournal Blog',
        description: 'The basics of trading risk management: risk per trade, daily risk budgets, drawdown limits and trade frequency — and how to track them without a spreadsheet.',
        publishedAt: '2026-08-18',
        updatedAt: '2026-08-18',
        priority: '0.6', changefreq: 'monthly',
        breadcrumbs: [{ name: 'Home', route: '/' }, { name: 'Blog', route: '/blog/' }]
    }
];

const BLOG_HUB = {
    route: '/blog/',
    file: 'public/blog/index.html',
    title: 'Trading Journal Blog | BattlexJournal',
    description: 'Guides and articles on trading journals, trade review, risk management and discipline — written for traders who want to improve their process, not chase shortcuts.',
    priority: '0.5', changefreq: 'weekly',
    breadcrumbs: [{ name: 'Home', route: '/' }]
};

/* ---------------------------------------------------------------------------
   PRIVATE ROUTES — the authenticated application. Never indexed, never in the
   sitemap. Robots.txt disallows the clean paths (and the .html files); the
   server also sends X-Robots-Tag noindex on them. Real protection remains
   authentication (client redirect to auth.html + auth-gated APIs).
   ------------------------------------------------------------------------- */
const PRIVATE_ROUTES = [
    '/dashboard', '/journal', '/review', '/improve', '/insights', '/analytics',
    '/ai-mentor', '/backtesting', '/strategy-lab', '/market-replay', '/risk',
    '/discipline', '/calendar', '/community', '/reports', '/notifications',
    '/settings', '/imports', '/battles'
];

const PRIVATE_FILES = [
    'admin.html', 'activate.html', 'app.html', 'auth.html', 'ai.html', 'analytics.html', 'backtesting.html',
    'battles.html', 'calendar.html', 'community.html', 'dashboard.html',
    'discipline.html', 'help.html', 'imports.html', 'improve.html',
    'insights.html', 'journal.html', 'notifications.html', 'replay.html',
    'reports.html', 'review.html', 'risk.html', 'settings.html', 'strategy-lab.html'
];

/* ---------------------------------------------------------------------------
   REDIRECTS — exact-match 301s. No chains: every target is a final URL.
   ------------------------------------------------------------------------- */
const REDIRECTS = {
    '/index.html': '/',
    '/home': '/',
    '/trading': '/trading-journal',
    '/blog': '/blog/',
    '/admin': '/admin.html',
    '/activate': '/activate.html',
    '/dashboard': '/dashboard.html',
    '/journal': '/journal.html',
    '/review': '/review.html',
    '/improve': '/improve.html',
    '/insights': '/insights.html',
    '/analytics': '/analytics.html',
    '/ai-mentor': '/ai.html',
    '/backtesting': '/backtesting.html',
    '/strategy-lab': '/strategy-lab.html',
    '/market-replay': '/replay.html',
    '/risk': '/risk.html',
    '/discipline': '/discipline.html',
    '/calendar': '/calendar.html',
    '/community': '/community.html',
    '/reports': '/reports.html',
    '/notifications': '/notifications.html',
    '/settings': '/settings.html',
    '/imports': '/imports.html',
    '/battles': '/battles.html',
    '/auth': '/auth.html'
};

/* ---------------------------------------------------------------------------
   Registry access
   ------------------------------------------------------------------------- */
const routeIndex = new Map();   // route → { page meta }
for (const p of PUBLIC_PAGES) routeIndex.set(p.route, p);
routeIndex.set(BLOG_HUB.route, BLOG_HUB);
for (const b of BLOG_POSTS) routeIndex.set(b.route, b);

const ALL_ROUTES = [...PUBLIC_PAGES, BLOG_HUB, ...BLOG_POSTS];   // sitemap order

function entryForRoute(route) { return routeIndex.get(route) || null; }
function canonical(route) { return SITE_URL + route; }

/* ---------------------------------------------------------------------------
   Public route resolution + canonicalization.
   Returns one of:
     { route, entry }                    — serve directly
     { redirect: url }                   — 301 to the canonical form
     null                                — not a public route
   Handles: exact match, trailing-slash variants (/blog → /blog/),
   lowercase case-variants.
   ------------------------------------------------------------------------- */
function publicRouteFor(pathname) {
    if (routeIndex.has(pathname)) return { route: pathname, entry: routeIndex.get(pathname) };

    // trailing slash: /trading-journal/ → /trading-journal (canonical has no slash)
    if (pathname.length > 1 && pathname.endsWith('/')) {
        const bare = pathname.slice(0, -1);
        const e = routeIndex.get(bare);
        if (e && e.route !== '/blog/') return { redirect: canonical(bare) };
    }
    // missing slash where canonical requires it: /blog → /blog/
    if (!pathname.endsWith('/') && routeIndex.has(pathname + '/')) {
        return { redirect: canonical(pathname + '/') };
    }
    // case variant: /Trading-Journal → /trading-journal
    const lower = pathname.toLowerCase();
    if (lower !== pathname && routeIndex.has(lower)) return { redirect: canonical(lower) };

    return null;
}

/* ---------------------------------------------------------------------------
   Private-path detection (for X-Robots-Tag + robots meta rewrite).
   ------------------------------------------------------------------------- */
function isPrivatePath(pathname) {
    if (PRIVATE_ROUTES.indexOf(pathname) !== -1) return true;
    const base = pathname.replace(/^\//, '');
    return PRIVATE_FILES.indexOf(base) !== -1;
}

function redirectFor(pathname) {
    return REDIRECTS[pathname] || null;
}

/* ---------------------------------------------------------------------------
   <head> meta block, injected into public pages at the SEO:META marker.
   Everything comes from the registry — titles/descriptions/canonicals are
   unique by construction (validated by server/seo.test.js).
   ------------------------------------------------------------------------- */
function ogTitleOf(entry) { return entry.ogTitle || entry.title; }
function ogDescriptionOf(entry) { return entry.ogDescription || entry.description; }

function jsonLdFor(route) {
    const entry = entryForRoute(route);
    if (!entry) return [];
    const graphs = [];
    const pageUrl = canonical(route);

    if (route === '/') {
        graphs.push({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: BRAND,
            url: SITE_URL
        });
        graphs.push({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: BRAND,
            url: SITE_URL,
            description: BRAND_DESC
        });
    }

    const crumbs = entry.breadcrumbs || [];
    if (crumbs.length) {
        graphs.push({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: crumbs.concat([{ name: entry.breadcrumbName || entry.title.split(' | ')[0], route }])
                .map((c, i) => ({
                    '@type': 'ListItem',
                    position: i + 1,
                    name: c.name,
                    item: canonical(c.route)
                }))
        });
    }

    const post = BLOG_POSTS.find(b => b.route === route);
    if (post) {
        graphs.push({
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            headline: post.title.split(' | ')[0],
            description: post.description,
            datePublished: post.publishedAt,
            dateModified: post.updatedAt,
            author: { '@type': 'Organization', name: BRAND, url: SITE_URL },
            publisher: { '@type': 'Organization', name: BRAND, url: SITE_URL },
            mainEntityOfPage: pageUrl
        });
    }
    return graphs;
}

function seoHead(route) {
    const entry = entryForRoute(route);
    if (!entry) return '';
    const url = canonical(route);
    const ld = jsonLdFor(route);
    let out = '';
    out += '<title>' + esc(entry.title) + '</title>\n';
    out += '    <meta name="description" content="' + esc(entry.description) + '">\n';
    out += '    <meta name="robots" content="index, follow">\n';
    out += '    <meta name="theme-color" content="#0a0a0b">\n';
    out += '    <meta property="og:type" content="' + (route.indexOf('/blog') === 0 ? 'article' : 'website') + '">\n';
    out += '    <meta property="og:site_name" content="' + BRAND + '">\n';
    out += '    <meta property="og:title" content="' + esc(ogTitleOf(entry)) + '">\n';
    out += '    <meta property="og:description" content="' + esc(ogDescriptionOf(entry)) + '">\n';
    out += '    <meta property="og:url" content="' + url + '">\n';
    out += '    <meta name="twitter:card" content="summary">\n';
    out += '    <meta name="twitter:title" content="' + esc(ogTitleOf(entry)) + '">\n';
    out += '    <meta name="twitter:description" content="' + esc(ogDescriptionOf(entry)) + '">\n';
    out += '    <link rel="canonical" href="' + url + '">';
    for (const g of ld) {
        out += '\n    <script type="application/ld+json">' + JSON.stringify(g) + '</script>';
    }
    return out;
}

/* Visible breadcrumb nav (crawlable <a> links), rendered from the same
   registry data that builds the BreadcrumbList JSON-LD. */
function breadcrumbNav(route) {
    const entry = entryForRoute(route);
    if (!entry || !(entry.breadcrumbs || []).length) return '';
    const crumbs = entry.breadcrumbs.concat([{ name: entry.breadcrumbName || entry.title.split(' | ')[0], route }]);
    let out = '<nav class="bx-breadcrumb" aria-label="Breadcrumb"><ol>';
    crumbs.forEach((c, i) => {
        const last = i === crumbs.length - 1;
        out += '<li>' + (last
            ? '<span aria-current="page">' + esc(c.name) + '</span>'
            : '<a href="' + esc(c.route) + '">' + esc(c.name) + '</a>') + '</li>';
    });
    out += '</ol></nav>';
    return out;
}

/* ---------------------------------------------------------------------------
   /robots.txt — allow the public site, disallow the private app + data.
   Generated from the same registries as the sitemap. This is NOT the primary
   protection for private data: authentication + noindex meta + X-Robots-Tag
   headers are.
   ------------------------------------------------------------------------- */
function robotsTxt() {
    const lines = [];
    lines.push('# ' + BRAND + ' robots.txt');
    lines.push('# Public SEO pages are crawlable; the authenticated application is not.');
    lines.push('# Private data is protected by authentication and noindex — this file is an extra guard.');
    lines.push('User-agent: *');
    lines.push('Allow: /');
    // non-public code/data trees
    for (const p of ['/api/', '/data/', '/db/', '/server/', '/src/', '/core.js', '/demo-trades.js', '/connection.js', '/reset.js']) {
        lines.push('Disallow: ' + p);
    }
    // authenticated app — clean paths + page files
    for (const r of PRIVATE_ROUTES) lines.push('Disallow: ' + r);
    for (const f of PRIVATE_FILES) lines.push('Disallow: /' + f);
    lines.push('');
    lines.push('Sitemap: ' + SITE_URL + '/sitemap.xml');
    return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------------------
   /sitemap.xml — ONLY canonical public URLs. Built from the registry so the
   sitemap can never drift from the pages (validated by server/seo.test.js).
   ------------------------------------------------------------------------- */
function sitemapXml() {
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
    out += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const e of ALL_ROUTES) {
        const lastmod = e.updatedAt || e.publishedAt || '2026-08-18';
        out += '  <url>\n';
        out += '    <loc>' + esc(canonical(e.route)) + '</loc>\n';
        out += '    <lastmod>' + lastmod + '</lastmod>\n';
        out += '    <changefreq>' + (e.changefreq || 'monthly') + '</changefreq>\n';
        out += '    <priority>' + (e.priority || '0.5') + '</priority>\n';
        out += '  </url>\n';
    }
    out += '</urlset>\n';
    return out;
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
    SITE_URL,
    BRAND,
    PUBLIC_PAGES,
    BLOG_POSTS,
    BLOG_HUB,
    ALL_ROUTES,
    PRIVATE_ROUTES,
    PRIVATE_FILES,
    REDIRECTS,
    entryForRoute,
    canonical,
    publicRouteFor,
    isPrivatePath,
    redirectFor,
    seoHead,
    breadcrumbNav,
    robotsTxt,
    sitemapXml
};
