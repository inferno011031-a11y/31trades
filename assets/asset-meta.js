/* ============================================================================
   31TRADES — Asset metadata & category picker
   Shared by the Log Trade modal: category pill bar, country flags for FX and
   indices, brand-colored logos for stocks, glyphs for crypto and commodity
   icons. Pure DOM — no framework, no external images.
   ============================================================================ */

(function () {
    'use strict';

    // ---- category order + pills (All + these) ----
    const CATEGORIES = ['Forex', 'Metals', 'Energy', 'Agriculture', 'Futures', 'Indices', 'Crypto', 'Stocks'];

    // Futures = the exchange-traded contracts (metals + energy + agriculture)
    const FUTURES_GROUP = ['Metals', 'Energy', 'Agriculture'];

    // ---- flag map: base-currency → country flag ----
    const CCY_FLAG = {
        EUR: '🇪🇺', GBP: '🇬🇧', USD: '🇺🇸', JPY: '🇯🇵', CHF: '🇨🇭',
        AUD: '🇦🇺', NZD: '🇳🇿', CAD: '🇨🇦'
    };

    // ---- country flags for indices ----
    const INDEX_FLAG = {
        NAS100: '🇺🇸', US100: '🇺🇸', US30: '🇺🇸', SPX500: '🇺🇸', SP500: '🇺🇸',
        DAX40: '🇩🇪', GER40: '🇩🇪', DE40: '🇩🇪', UK100: '🇬🇧', JPN225: '🇯🇵',
        NIKKEI: '🇯🇵', AUS200: '🇦🇺', EU50: '🇪🇺', FRA40: '🇫🇷', HK50: '🇭🇰'
    };

    // ---- commodity / crypto glyphs (emoji or ticker monogram) ----
    const COMMODITY_ICON = {
        XAUUSD: '🥇', XAGUSD: '🥈', XPTUSD: '⚪', XPDUSD: '⚪',
        USOIL: '🛢️', UKOIL: '🛢️', XTIUSD: '🛢️', XBRUSD: '🛢️', BRENT: '🛢️', CL: '🛢️', WTI: '🛢️', OIL: '🛢️',
        NATGAS: '🔥', XNGUSD: '🔥', NG: '🔥',
        COFFEE: '☕', SUGAR: '🍬', COCOA: '🍫', COTTON: '🌾', WHEAT: '🌾',
        CORN: '🌽', SOYBEAN: '🌱', OATS: '🌾', RICE: '🍚', KC: '☕', SB: '🍬', CC: '🍫'
    };

    // ---- brand colors for stocks + crypto logos ----
    const LOGO = {
        // stocks — letter badge with brand color
        AAPL:  { glyph: 'A', color: '#A2AAAD', bg: '#2c2f33' },
        TSLA:  { glyph: 'T', color: '#E82127', bg: '#2a1517' },
        MSFT:  { glyph: 'M', color: '#00A4EF', bg: '#0f2430' },
        NVDA:  { glyph: 'N', color: '#76B900', bg: '#1c2a10' },
        AMZN:  { glyph: 'A', color: '#FF9900', bg: '#2a1f0f' },
        META:  { glyph: 'M', color: '#1877F2', bg: '#0f1f33' },
        GOOGL: { glyph: 'G', color: '#4285F4', bg: '#122036' },
        NFLX:  { glyph: 'N', color: '#E50914', bg: '#2a1215' },
        // crypto — coin glyph on brand tint
        BTC:  { glyph: '₿', color: '#F7931A', bg: '#2a200f' },
        ETH:  { glyph: 'Ξ', color: '#627EEA', bg: '#141b33' },
        SOL:  { glyph: '◎', color: '#14F195', bg: '#0f2a20' },
        XRP:  { glyph: '✕', color: '#00AAE4', bg: '#0f2430' },
        DOGE: { glyph: 'Ð', color: '#C2A633', bg: '#2a2512' },
        ADA:  { glyph: '₳', color: '#0033AD', bg: '#101a33' },
        DOT:  { glyph: '●', color: '#E6007A', bg: '#2a1020' },
        LTC:  { glyph: 'Ł', color: '#345D9D', bg: '#101a2a' },
        BNB:  { glyph: '◆', color: '#F3BA2F', bg: '#2a240f' },
        AVAX: { glyph: '▲', color: '#E84142', bg: '#2a1215' },
        MATIC:{ glyph: '◆', color: '#8247E5', bg: '#1e1233' },
        LINK: { glyph: '⬡', color: '#2A5ADA', bg: '#101a33' },
        UNI:  { glyph: '🦄', color: '#FF007A', bg: '#2a1020' },
        SHIB: { glyph: '🐕', color: '#F5A623', bg: '#2a2210' },
        PEPE: { glyph: '🐸', color: '#4CAF50', bg: '#102a14' },
        XLM:  { glyph: '✳', color: '#3AA6B9', bg: '#10252a' },
        NEAR: { glyph: '▲', color: '#00EC97', bg: '#0f2a20' },
        APT:  { glyph: '◈', color: '#05E4C3', bg: '#0f2a26' },
        ARB:  { glyph: '◆', color: '#12AAFF', bg: '#0f2430' },
        OP:   { glyph: '✦', color: '#FF0420', bg: '#2a1012' },
        SUI:  { glyph: '◉', color: '#6D28D9', bg: '#1a1233' },
        INJ:  { glyph: '❄', color: '#00A3FF', bg: '#0f2430' },
        SEI:  { glyph: '◍', color: '#8A2BE2', bg: '#1a1230' },
        TIA:  { glyph: '✳', color: '#FF7A00', bg: '#2a1c0f' }
    };

    // ---- the canonical symbol list (same set as the core asset engine) ----
    const SYMBOLS = [
        // FOREX
        { sym: 'EURUSD', cat: 'Forex', name: 'Euro / US Dollar' },
        { sym: 'GBPUSD', cat: 'Forex', name: 'Pound / US Dollar' },
        { sym: 'USDJPY', cat: 'Forex', name: 'US Dollar / Yen' },
        { sym: 'EURJPY', cat: 'Forex', name: 'Euro / Yen' },
        { sym: 'AUDUSD', cat: 'Forex', name: 'Aussie / US Dollar' },
        { sym: 'USDCAD', cat: 'Forex', name: 'US Dollar / Loonie' },
        { sym: 'USDCHF', cat: 'Forex', name: 'US Dollar / Swissie' },
        { sym: 'NZDUSD', cat: 'Forex', name: 'Kiwi / US Dollar' },
        { sym: 'EURGBP', cat: 'Forex', name: 'Euro / Pound' },
        { sym: 'EURCHF', cat: 'Forex', name: 'Euro / Swissie' },
        { sym: 'AUDNZD', cat: 'Forex', name: 'Aussie / Kiwi' },
        { sym: 'EURNZD', cat: 'Forex', name: 'Euro / Kiwi' },
        { sym: 'GBPAUD', cat: 'Forex', name: 'Pound / Aussie' },
        { sym: 'GBPNZD', cat: 'Forex', name: 'Pound / Kiwi' },
        { sym: 'EURCAD', cat: 'Forex', name: 'Euro / Loonie' },
        { sym: 'GBPCAD', cat: 'Forex', name: 'Pound / Loonie' },
        { sym: 'AUDCHF', cat: 'Forex', name: 'Aussie / Swissie' },
        { sym: 'CADCHF', cat: 'Forex', name: 'Loonie / Swissie' },
        // METALS
        { sym: 'XAUUSD', cat: 'Metals', name: 'Gold / US Dollar' },
        { sym: 'XAGUSD', cat: 'Metals', name: 'Silver / US Dollar' },
        { sym: 'XPTUSD', cat: 'Metals', name: 'Platinum / US Dollar' },
        { sym: 'XPDUSD', cat: 'Metals', name: 'Palladium / US Dollar' },
        // ENERGY
        { sym: 'USOIL', cat: 'Energy', name: 'US Crude Oil (WTI)' },
        { sym: 'UKOIL', cat: 'Energy', name: 'Brent Crude Oil' },
        { sym: 'XTIUSD', cat: 'Energy', name: 'WTI / US Dollar' },
        { sym: 'XBRUSD', cat: 'Energy', name: 'Brent / US Dollar' },
        { sym: 'BRENT', cat: 'Energy', name: 'Brent Crude' },
        { sym: 'CL', cat: 'Energy', name: 'NYMEX Crude' },
        { sym: 'WTI', cat: 'Energy', name: 'WTI Crude' },
        { sym: 'OIL', cat: 'Energy', name: 'Crude Oil' },
        { sym: 'NATGAS', cat: 'Energy', name: 'Natural Gas' },
        { sym: 'XNGUSD', cat: 'Energy', name: 'Nat Gas / US Dollar' },
        { sym: 'NG', cat: 'Energy', name: 'NYMEX Nat Gas' },
        // AGRICULTURE
        { sym: 'COFFEE', cat: 'Agriculture', name: 'Coffee (Arabica)' },
        { sym: 'SUGAR', cat: 'Agriculture', name: 'Sugar No. 11' },
        { sym: 'COCOA', cat: 'Agriculture', name: 'Cocoa' },
        { sym: 'COTTON', cat: 'Agriculture', name: 'Cotton' },
        { sym: 'WHEAT', cat: 'Agriculture', name: 'Wheat (CBOT)' },
        { sym: 'CORN', cat: 'Agriculture', name: 'Corn' },
        { sym: 'SOYBEAN', cat: 'Agriculture', name: 'Soybeans' },
        { sym: 'OATS', cat: 'Agriculture', name: 'Oats' },
        { sym: 'RICE', cat: 'Agriculture', name: 'Rough Rice' },
        { sym: 'KC', cat: 'Agriculture', name: 'Coffee C' },
        { sym: 'SB', cat: 'Agriculture', name: 'Sugar' },
        { sym: 'CC', cat: 'Agriculture', name: 'Cocoa C' },
        // INDICES
        { sym: 'NAS100', cat: 'Indices', name: 'Nasdaq 100' },
        { sym: 'US100', cat: 'Indices', name: 'US Tech 100' },
        { sym: 'US30', cat: 'Indices', name: 'Dow Jones 30' },
        { sym: 'SPX500', cat: 'Indices', name: 'S&P 500' },
        { sym: 'SP500', cat: 'Indices', name: 'S&P 500' },
        { sym: 'DAX40', cat: 'Indices', name: 'DAX 40' },
        { sym: 'GER40', cat: 'Indices', name: 'German 40' },
        { sym: 'DE40', cat: 'Indices', name: 'German DAX' },
        { sym: 'UK100', cat: 'Indices', name: 'FTSE 100' },
        { sym: 'JPN225', cat: 'Indices', name: 'Nikkei 225' },
        { sym: 'NIKKEI', cat: 'Indices', name: 'Nikkei 225' },
        { sym: 'AUS200', cat: 'Indices', name: 'ASX 200' },
        { sym: 'EU50', cat: 'Indices', name: 'Euro Stoxx 50' },
        { sym: 'FRA40', cat: 'Indices', name: 'CAC 40' },
        { sym: 'HK50', cat: 'Indices', name: 'Hang Seng 50' },
        // CRYPTO
        { sym: 'BTCUSD', cat: 'Crypto', name: 'Bitcoin' },
        { sym: 'ETHUSD', cat: 'Crypto', name: 'Ethereum' },
        { sym: 'SOLUSD', cat: 'Crypto', name: 'Solana' },
        { sym: 'XRPUSD', cat: 'Crypto', name: 'XRP' },
        { sym: 'DOGEUSD', cat: 'Crypto', name: 'Dogecoin' },
        { sym: 'ADAUSD', cat: 'Crypto', name: 'Cardano' },
        { sym: 'DOTUSD', cat: 'Crypto', name: 'Polkadot' },
        { sym: 'LTCUSD', cat: 'Crypto', name: 'Litecoin' },
        { sym: 'BNBUSD', cat: 'Crypto', name: 'BNB' },
        { sym: 'AVAXUSD', cat: 'Crypto', name: 'Avalanche' },
        { sym: 'MATICUSD', cat: 'Crypto', name: 'Polygon' },
        { sym: 'LINKUSD', cat: 'Crypto', name: 'Chainlink' },
        { sym: 'UNIUSD', cat: 'Crypto', name: 'Uniswap' },
        { sym: 'SHIBUSD', cat: 'Crypto', name: 'Shiba Inu' },
        { sym: 'PEPEUSD', cat: 'Crypto', name: 'Pepe' },
        { sym: 'XLMUSD', cat: 'Crypto', name: 'Stellar' },
        { sym: 'NEARUSD', cat: 'Crypto', name: 'NEAR Protocol' },
        { sym: 'APTUSD', cat: 'Crypto', name: 'Aptos' },
        { sym: 'ARBUSD', cat: 'Crypto', name: 'Arbitrum' },
        { sym: 'OPUSD', cat: 'Crypto', name: 'Optimism' },
        { sym: 'SUIUSD', cat: 'Crypto', name: 'Sui' },
        { sym: 'INJUSD', cat: 'Crypto', name: 'Injective' },
        { sym: 'SEIUSD', cat: 'Crypto', name: 'Sei' },
        { sym: 'TIAUSD', cat: 'Crypto', name: 'Celestia' },
        // STOCKS
        { sym: 'AAPL', cat: 'Stocks', name: 'Apple Inc.' },
        { sym: 'TSLA', cat: 'Stocks', name: 'Tesla Inc.' },
        { sym: 'MSFT', cat: 'Stocks', name: 'Microsoft Corp.' },
        { sym: 'NVDA', cat: 'Stocks', name: 'NVIDIA Corp.' },
        { sym: 'AMZN', cat: 'Stocks', name: 'Amazon.com' },
        { sym: 'META', cat: 'Stocks', name: 'Meta Platforms' },
        { sym: 'GOOGL', cat: 'Stocks', name: 'Alphabet (Class A)' },
        { sym: 'NFLX', cat: 'Stocks', name: 'Netflix Inc.' }
    ];

    // ---- resolve the visual identity for a symbol ----
    function identityFor(sym) {
        const s = String(sym || '').toUpperCase();
        const meta = SYMBOLS.find(x => x.sym === s) || { sym: s, cat: 'Other', name: s };
        let flag = null, flag2 = null, icon = null, logo = null;

        if (meta.cat === 'Forex') {
            const m = s.match(/^([A-Z]{3})([A-Z]{3})$/);
            if (m) { flag = CCY_FLAG[m[1]] || null; flag2 = CCY_FLAG[m[2]] || null; }
        } else if (meta.cat === 'Indices') {
            flag = INDEX_FLAG[s] || null;
        }
        if (COMMODITY_ICON[s]) icon = COMMODITY_ICON[s];
        // stock logo: strip the USD suffix (BTCUSD → BTC)
        const root = s.replace(/USD$/, '');
        if (LOGO[root]) logo = LOGO[root];
        else if (meta.cat === 'Stocks' || meta.cat === 'Crypto') {
            logo = { glyph: root.slice(0, 1), color: '#94a3b8', bg: '#1a2030' };
        }

        return { sym: s, cat: meta.cat, name: meta.name, flag, flag2, icon, logo };
    }

    function catPillOf(cat) {
        if (cat === 'Futures') return FUTURES_GROUP;
        return [cat];
    }

    function inCategory(sym, cat) {
        if (!cat || cat === 'All') return true;
        return catPillOf(cat).indexOf(sym.cat) > -1;
    }

    // ---- render helpers (escaped where user content is involved) ----
    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function visualHtml(id) {
        const { flag, flag2, icon, logo } = id;
        if (flag) {
            return '<span class="tm-asset-flags">' + (flag2 ? '<span>' + flag + '</span><span>' + flag2 + '</span>'
                : '<span>' + flag + '</span>') + '</span>';
        }
        if (icon) return '<span class="tm-asset-icon">' + icon + '</span>';
        if (logo) {
            return '<span class="tm-asset-logo" style="background:' + logo.bg + ';color:' + logo.color + '">' +
                esc(logo.glyph) + '</span>';
        }
        return '<span class="tm-asset-logo" style="background:#1a2030;color:#94a3b8">' + esc(id.sym.slice(0, 1)) + '</span>';
    }

    // ---- the picker itself --------------------------------------------------
    // opts: { root, select (hidden native <select> kept for JS compat), onPick }
    function createPicker(opts) {
        const root = typeof opts.root === 'string' ? document.getElementById(opts.root) : opts.root;
        const select = typeof opts.select === 'string' ? document.getElementById(opts.select) : opts.select;
        const onPick = opts.onPick || function () {};

        // Seed the hidden native select with the full catalog so legacy reads
        // ($('e-symbol').value) and value writes (prefill) keep working.
        if (select) {
            select.innerHTML = SYMBOLS.map(s => '<option value="' + esc(s.sym) + '">' + esc(s.sym) + '</option>').join('');
        }

        let activeCat = 'All';
        let query = '';

        const pillHtml = ['All'].concat(CATEGORIES).map(c =>
            '<button type="button" class="tm-cat-pill' + (c === 'All' ? ' active' : '') + '" data-cat="' + c + '">' + c + '</button>'
        ).join('');

        root.innerHTML =
            '<div class="tm-picker">' +
                '<div class="tm-cat-bar">' + pillHtml + '</div>' +
                '<div class="tm-picker-trigger" role="button" tabindex="0">' +
                    '<span class="tm-picker-value"></span>' +
                    '<svg class="tm-picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
                '</div>' +
                '<div class="tm-picker-dropdown">' +
                    '<div class="tm-picker-search"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
                    '<input type="text" placeholder="Search symbol or name…" class="tm-picker-q"></div>' +
                    '<div class="tm-picker-list"></div>' +
                '</div>' +
            '</div>';

        const bar = root.querySelector('.tm-cat-bar');
        const trigger = root.querySelector('.tm-picker-trigger');
        const dropdown = root.querySelector('.tm-picker-dropdown');
        const list = root.querySelector('.tm-picker-list');
        const q = root.querySelector('.tm-picker-q');
        const valueEl = root.querySelector('.tm-picker-value');

        function renderList() {
            const needle = query.trim().toUpperCase();
            const rows = SYMBOLS.filter(s => inCategory(s, activeCat))
                .filter(s => !needle || s.sym.indexOf(needle) > -1 || s.name.toUpperCase().indexOf(needle) > -1)
                .map(s => {
                    const id = identityFor(s.sym);
                    return '<button type="button" class="tm-asset-row" data-sym="' + esc(id.sym) + '">' +
                        visualHtml(id) +
                        '<span class="tm-asset-info"><span class="tm-asset-sym">' + esc(id.sym) + '</span>' +
                        '<span class="tm-asset-name">' + esc(id.name) + '</span></span>' +
                        '<span class="tm-asset-cat">' + esc(id.cat) + '</span>' +
                    '</button>';
                }).join('');
            list.innerHTML = rows ||
                '<div class="tm-picker-empty">No assets match “' + esc(query) + '”</div>';
        }

        function setValue(sym) {
            if (select) {
                select.value = sym;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                select.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const id = identityFor(sym);
            valueEl.innerHTML = visualHtml(id) +
                '<span class="tm-picker-sym">' + esc(id.sym) + '</span>' +
                '<span class="tm-picker-cat">' + esc(id.cat) + '</span>';
            onPick(sym, id);
            closeDropdown();
        }

        // reflect a value set elsewhere (prefill / reset)
        function syncFromSelect() {
            if (select && select.value) setValue(select.value);
        }

        function openDropdown() {
            dropdown.classList.add('open');
            root.classList.add('dropdown-open');
            renderList();
            setTimeout(() => q.focus(), 0);
        }
        function closeDropdown() {
            dropdown.classList.remove('open');
            root.classList.remove('dropdown-open');
            q.value = ''; query = '';
        }
        function toggleDropdown() {
            dropdown.classList.contains('open') ? closeDropdown() : openDropdown();
        }

        bar.addEventListener('click', e => {
            const pill = e.target.closest('.tm-cat-pill');
            if (!pill) return;
            activeCat = pill.dataset.cat;
            bar.querySelectorAll('.tm-cat-pill').forEach(p => p.classList.toggle('active', p === pill));
            renderList();
        });

        trigger.addEventListener('click', toggleDropdown);
        trigger.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDropdown(); }
        });

        q.addEventListener('input', () => { query = q.value; renderList(); });

        list.addEventListener('click', e => {
            const row = e.target.closest('.tm-asset-row');
            if (row) setValue(row.dataset.sym);
        });

        document.addEventListener('click', e => {
            if (!root.contains(e.target)) closeDropdown();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeDropdown();
        });

        // initial value from the hidden select (kept in sync for legacy reads)
        syncFromSelect();
        if (!select || !select.value) {
            // default to the first symbol so the form always has a value
            setValue(SYMBOLS[0].sym);
        }

        return { syncFromSelect, setValue, identityFor };
    }

    // ---- public badge HTML for lists/tables (flags, icons, logos) ----
    function badgeHtml(symbol) {
        return visualHtml(identityFor(symbol));
    }

    window.TMAssets = {
        CATEGORIES: CATEGORIES,
        SYMBOLS: SYMBOLS,
        identityFor: identityFor,
        badgeHtml: badgeHtml,
        createPicker: createPicker
    };
})();
