/* ============================================================================
   31TRADES — Asset metadata & category picker
   Shared by the Log Trade modal: category pill bar, country flags for FX and
   indices, brand-colored logos for stocks, glyphs for crypto and commodity
   icons. Pure DOM — no framework, no external images.
   ============================================================================ */

(function () {
    'use strict';

    // ---- category order + pills (All + these) ----
    const CATEGORIES = ['Forex', 'Metals', 'Energy', 'Futures', 'Indices', 'Crypto', 'Stocks'];

    // TradingView style category SVG icons
    const CAT_ICONS = {
        All: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
        Forex: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>',
        Metals: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 4-5h10l4 5-9 11L3 9z"/><path d="M3 9h18"/><path d="m10 4 2 5 2-5"/></svg>',
        Energy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
        Futures: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M7 15V9"/><path d="M7 6V3"/><path d="M7 18v-1"/><path d="M17 12V7"/><path d="M17 3v2"/><path d="M17 18v-4"/><rect x="5" y="6" width="4" height="6" rx="1"/><rect x="15" y="7" width="4" height="5" rx="1"/></svg>',
        Indices: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 0 18 18 0"/><path d="m19 9-5 5-4-4-3 3"/><path d="M19 5v4h-4"/></svg>',
        Crypto: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 8h4a2.5 2.5 0 0 1 0 5H9.5"/><path d="M9.5 13h4.5a2.5 2.5 0 0 1 0 5H9.5"/><path d="M12 6v2"/><path d="M12 18v2"/><path d="M9.5 6v14"/></svg>',
        Stocks: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 13v.01"/><path d="M9 17v.01"/></svg>'
    };

    // Futures = the exchange-traded contracts (metals + energy)
    const FUTURES_GROUP = ['Metals', 'Energy'];

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

    // ---- commodity / energy SVGs (TradingView vector style, no emojis) ----
    const COMMODITY_ICON = {
        XAUUSD: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 4-5h10l4 5-9 11L3 9z"/><path d="M3 9h18"/><path d="m10 4 2 5 2-5"/></svg>',
        XAGUSD: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 4-5h10l4 5-9 11L3 9z"/><path d="M3 9h18"/><path d="m10 4 2 5 2-5"/></svg>',
        XPTUSD: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 4-5h10l4 5-9 11L3 9z"/><path d="M3 9h18"/><path d="m10 4 2 5 2-5"/></svg>',
        XPDUSD: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 4-5h10l4 5-9 11L3 9z"/><path d="M3 9h18"/><path d="m10 4 2 5 2-5"/></svg>',
        USOIL: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        UKOIL: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        XTIUSD: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        XBRUSD: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        BRENT: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        CL: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        WTI: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        OIL: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="m4.93 10.93 4.24 4.24"/><path d="M2 18h20"/><path d="M20 10a8 8 0 1 1-16 0c0-3.3 4-8 8-8s8 4.7 8 8Z"/></svg>',
        NATGAS: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>',
        XNGUSD: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>',
        NG: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>'
    };

    // ---- real internet logos (favicon CDN for stocks, CoinGecko for crypto),
    // with a letter-glyph badge fallback when offline / image fails. ----
    const LOGO = {
        // stocks — Google favicon service (real brand mark), glyph fallback
        AAPL:  { img: 'https://www.google.com/s2/favicons?domain=apple.com&sz=128', glyph: 'A', color: '#A2AAAD', bg: '#2c2f33' },
        TSLA:  { img: 'https://www.google.com/s2/favicons?domain=tesla.com&sz=128', glyph: 'T', color: '#E82127', bg: '#2a1517' },
        MSFT:  { img: 'https://www.google.com/s2/favicons?domain=microsoft.com&sz=128', glyph: 'M', color: '#00A4EF', bg: '#0f2430' },
        NVDA:  { img: 'https://www.google.com/s2/favicons?domain=nvidia.com&sz=128', glyph: 'N', color: '#76B900', bg: '#1c2a10' },
        AMZN:  { img: 'https://www.google.com/s2/favicons?domain=amazon.com&sz=128', glyph: 'A', color: '#FF9900', bg: '#2a1f0f' },
        META:  { img: 'https://www.google.com/s2/favicons?domain=meta.com&sz=128', glyph: 'M', color: '#1877F2', bg: '#0f1f33' },
        GOOGL: { img: 'https://www.google.com/s2/favicons?domain=google.com&sz=128', glyph: 'G', color: '#4285F4', bg: '#122036' },
        NFLX:  { img: 'https://www.google.com/s2/favicons?domain=netflix.com&sz=128', glyph: 'N', color: '#E50914', bg: '#2a1215' },
        // crypto — CoinGecko asset images (real coin logos), glyph fallback
        BTC:  { img: 'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400', glyph: '₿', color: '#F7931A', bg: '#2a200f' },
        ETH:  { img: 'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628', glyph: 'Ξ', color: '#627EEA', bg: '#141b33' },
        SOL:  { img: 'https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756', glyph: '◎', color: '#14F195', bg: '#0f2a20' },
        XRP:  { img: 'https://coin-images.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png?1696501442', glyph: '✕', color: '#00AAE4', bg: '#0f2430' },
        DOGE: { img: 'https://coin-images.coingecko.com/coins/images/5/large/dogecoin.png?1696501409', glyph: 'Ð', color: '#C2A633', bg: '#2a2512' },
        ADA:  { img: 'https://coin-images.coingecko.com/coins/images/975/large/cardano.png?1696502090', glyph: '₳', color: '#0033AD', bg: '#101a33' },
        DOT:  { img: 'https://coin-images.coingecko.com/coins/images/12171/large/polkadot.jpg?1766533446', glyph: '●', color: '#E6007A', bg: '#2a1020' },
        LTC:  { img: 'https://coin-images.coingecko.com/coins/images/2/large/litecoin.png?1696501400', glyph: 'Ł', color: '#345D9D', bg: '#101a2a' },
        BNB:  { img: 'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png?1696501970', glyph: '◆', color: '#F3BA2F', bg: '#2a240f' },
        AVAX: { img: 'https://coin-images.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png?1696512369', glyph: '▲', color: '#E84142', bg: '#2a1215' },
        MATIC:{ img: 'https://coin-images.coingecko.com/coins/images/4713/large/polygon.png?1698233745', glyph: '◆', color: '#8247E5', bg: '#1e1233' },
        LINK: { img: 'https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405', glyph: '⬡', color: '#2A5ADA', bg: '#101a33' },
        UNI:  { img: 'https://coin-images.coingecko.com/coins/images/12504/large/uniswap-logo.png?1720676669', glyph: '🦄', color: '#FF007A', bg: '#2a1020' },
        SHIB: { img: 'https://coin-images.coingecko.com/coins/images/11939/large/shiba.png?1696511800', glyph: '🐕', color: '#F5A623', bg: '#2a2210' },
        PEPE: { img: 'https://coin-images.coingecko.com/coins/images/29850/large/pepe-token.jpeg?1696528776', glyph: '🐸', color: '#4CAF50', bg: '#102a14' },
        XLM:  { img: 'https://coin-images.coingecko.com/coins/images/100/large/fmpFRHHQ_400x400.jpg?1735231350', glyph: '✳', color: '#3AA6B9', bg: '#10252a' },
        NEAR: { img: 'https://coin-images.coingecko.com/coins/images/10365/large/near.jpg?1696510367', glyph: '▲', color: '#00EC97', bg: '#0f2a20' },
        APT:  { img: 'https://coin-images.coingecko.com/coins/images/26455/large/Aptos-Network-Symbol-Black-RGB-1x.png?1761789140', glyph: '◈', color: '#05E4C3', bg: '#0f2a26' },
        ARB:  { img: 'https://coin-images.coingecko.com/coins/images/16547/large/arb.jpg?1721358242', glyph: '◆', color: '#12AAFF', bg: '#0f2430' },
        OP:   { img: 'https://coin-images.coingecko.com/coins/images/25244/large/Token.png?1774456081', glyph: '✦', color: '#FF0420', bg: '#2a1012' },
        SUI:  { img: 'https://coin-images.coingecko.com/coins/images/26375/large/sui-ocean-square.png?1727791290', glyph: '◉', color: '#6D28D9', bg: '#1a1233' },
        INJ:  { img: 'https://coin-images.coingecko.com/coins/images/12882/large/injective_logo.jpg?1696513503', glyph: '❄', color: '#00A3FF', bg: '#0f2430' },
        SEI:  { img: 'https://coin-images.coingecko.com/coins/images/28205/large/Sei_Logo_-_Transparent.png?1696527207', glyph: '◍', color: '#8A2BE2', bg: '#1a1230' },
        TIA:  { img: 'https://coin-images.coingecko.com/coins/images/31967/large/tia.jpg?1696530772', glyph: '✳', color: '#FF7A00', bg: '#2a1c0f' }
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
            // Real internet logo (favicon / CoinGecko) with a graceful glyph
            // fallback when the image can't load (offline, blocked, removed).
            const fallback = '<span class="tm-asset-logo" style="background:' + logo.bg + ';color:' + logo.color + '">' +
                esc(logo.glyph) + '</span>';
            if (logo.img) {
                // The fallback markup must be HTML-escaped inside the onerror
                // attribute (its own double quotes would otherwise break it).
                // The handler swaps the wrapper class and content so the glyph
                // badge replaces the image cleanly (no leftover white box).
                return '<span class="tm-asset-logo tm-asset-logo-img" title="' + esc(id.sym) + '">' +
                    '<img src="' + esc(logo.img) + '" alt="" loading="lazy" ' +
                    'onerror="var w=this.closest(\'.tm-asset-logo-img\');w.className=\'tm-asset-logo\';w.innerHTML=' + esc(JSON.stringify(fallback)) + '">' +
                '</span>';
            }
            return fallback;
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
            '<button type="button" class="tm-cat-pill' + (c === 'All' ? ' active' : '') + '" data-cat="' + c + '">' +
                (CAT_ICONS[c] || '') +
                '<span>' + c + '</span>' +
            '</button>'
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
