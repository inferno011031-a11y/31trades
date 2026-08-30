/* ============================================================================
   31TRADES — Shared Core Package (src/core)
   ----------------------------------------------------------------------------
   The canonical data model + event bus + configuration API + the shared
   calculation services (Rule Engine, Risk, Discipline, Analytics, Calendar,
   Insights, Reviews, the 7-step trade pipeline).

   ZERO DOM / localStorage dependencies — the host injects everything:

       createTradeMindCore({
           demoTrades,      // optional deterministic demo generator
           storage,         // optional { load, save, clear } persistence adapter
           sync,            // optional (path, body, method) backend-mirror hook
           connectBackend   // optional () => Promise<boolean> liveness probe
       })

   Runs in the browser (UMD: window.createTradeMindCore) AND in Node
   (module.exports). The SAME calculation code runs on both sides — a single
   source of truth for data AND for the math that derives from it.
   ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();            // Node / server
    } else {
        root.createTradeMindCore = factory();  // browser
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    return function createTradeMindCore(env) {
        env = env || {};



    // ------------------------------------------------------------------
    // 1. EVENT BUS
    // ------------------------------------------------------------------
    class EventBus {
        constructor() { this.listeners = {}; }

        subscribe(eventType, callback) {
            if (!this.listeners[eventType]) this.listeners[eventType] = [];
            this.listeners[eventType].push(callback);
            return () => this.unsubscribe(eventType, callback);
        }

        unsubscribe(eventType, callback) {
            this.listeners[eventType] = (this.listeners[eventType] || []).filter(cb => cb !== callback);
        }

        publish(eventType, payload) {
            (this.listeners[eventType] || []).slice().forEach(callback => callback(payload));
        }
    }

    const TradeMindBus = new EventBus();

    // ------------------------------------------------------------------
    // 2. CANONICAL TABLES
    // ------------------------------------------------------------------
    // 1. IDENTITY & ACCOUNTS
    const Accounts = [
        {
            id: 'acc-prop',
            name: 'Prop Firm A',
            account_type: 'Prop / Funded',
            currency: 'USD',
            starting_balance: 10000,
            current_equity: 10319,   // starting + ledger P&L (+$319)
            status: 'Active',
            note: 'Trailing drawdown from peak equity · daily reset budget'
        },
        {
            id: 'acc-personal',
            name: 'Personal',
            account_type: 'Personal',
            currency: 'USD',
            starting_balance: 25000,
            current_equity: 25000,   // no ledger trades yet
            status: 'Active',
            note: 'Static drawdown from starting balance'
        }
    ];

    // 2. CONFIGURATION & POLICIES (immutable versions — never edited in place)
    const cv = (id, entity_type, entity_id, version, created_at, values, note) =>
        ({ id, entity_type, entity_id, version, created_at: new Date(created_at).toISOString(), values, note: note || '' });

    const ConfigVersions = [
        // ---- Risk policies (per account) ----
        cv('cv_rp_prop_v1', 'RiskPolicy', 'acc-prop', 'v1.0', '2026-05-15T00:00:00', {
            ddModel: 'trailing', maxDailyLoss: 100, maxTotalDrawdown: 500,
            riskPerTrade: 25, riskBasis: 'money', maxOpenRisk: 50, openBasis: 'money',
            maxTrades: 3, warn: [50, 70, 90]
        }, 'Account limits at activation'),
        cv('cv_rp_pers_v1', 'RiskPolicy', 'acc-personal', 'v1.0', '2026-05-15T00:00:00', {
            ddModel: 'static', maxDailyLoss: 250, maxTotalDrawdown: 1500,
            riskPerTrade: 50, riskBasis: 'money', maxOpenRisk: 100, openBasis: 'money',
            maxTrades: 5, warn: [50, 70, 90]
        }, 'Account limits at activation'),

        // ---- Strategy versions (bumped on every edit — PRD §6.3) ----
        cv('cv_strat_lfvg_v11', 'Strategy', 'strat-lfvg', 'v1.1', '2026-07-01T00:00:00', {
            name: 'London FVG', markets: 'FX · EURUSD, GBPUSD', sessions: ['London'],
            setup: 'MSS + FVG, FVG', risk: { riskPerTrade: '1%', minRR: 1.0, stopRequired: true, maxPositions: 1 },
            entry: 'FVG fill + MSS confirmation', exit: 'TP at opposing liquidity · 50% partial at 1R',
            behavior: ['No revenge entry', 'Cooldown 15 min after loss', 'Max 2 losses then stop'],
            evidence: ['Chart screenshot', 'Setup annotation'], tags: ['A+ Setup', 'London', 'Clean Entry']
        }, 'Original rule set'),
        cv('cv_strat_lfvg_v12', 'Strategy', 'strat-lfvg', 'v1.2', '2026-08-04T00:00:00', {
            name: 'London FVG', markets: 'FX · EURUSD, GBPUSD', sessions: ['London'],
            setup: 'MSS + FVG, FVG', risk: { riskPerTrade: '1%', minRR: 1.5, stopRequired: true, maxPositions: 1 },
            entry: 'FVG fill + MSS confirmation', exit: 'TP at opposing liquidity · 50% partial at 1R',
            behavior: ['No revenge entry', 'Cooldown 15 min after loss', 'Max 2 losses then stop'],
            evidence: ['Chart screenshot', 'Setup annotation'], tags: ['A+ Setup', 'London', 'Clean Entry']
        }, 'Min RR 1.0 → 1.5'),
        cv('cv_strat_orob_v1', 'Strategy', 'strat-orob', 'v1.0', '2026-05-15T00:00:00', {
            name: 'Opening Range Breakout', markets: 'Index · NAS100', sessions: ['New York'],
            setup: 'Breakout', risk: { riskPerTrade: '2%', minRR: 2, stopRequired: true, maxPositions: 1 },
            entry: 'Range breakout with retest', exit: 'Trailing stop · TP at ATH/ATL',
            behavior: ['No adding to loser'], evidence: ['Pre-trade note'], tags: ['NY', 'Breakout']
        }, 'Initial release'),
        cv('cv_strat_aob_v14', 'Strategy', 'strat-aob', 'v1.4', '2026-05-15T00:00:00', {
            name: 'Asia Order Block', markets: 'Metal · XAUUSD', sessions: ['Asia'],
            setup: 'Order Block', risk: { riskPerTrade: '0.5%', minRR: 1.5, stopRequired: true, maxPositions: 1 },
            entry: 'OB mitigation', exit: 'TP at session high/low',
            behavior: ['Cooldown after loss'], evidence: ['Setup annotation'], tags: ['Asia', 'A+ Setup']
        }, 'Initial release'),

        // ---- Rule sets (versioned — every toggle creates a new version) ----
        cv('cv_rs_core_v1', 'RuleSet', 'rs-core', 'v1.0', '2026-05-15T00:00:00', {
            rules: [
                { key: 'riskPerTrade', cat: 'Risk', label: 'Max risk per trade', op: '≤', threshold: 25, unit: '$', severity: 'Hard', enabled: true },
                { key: 'dailyRisk', cat: 'Risk', label: 'Max daily risk', op: '≤', threshold: 100, unit: '$', severity: 'Hard', enabled: true },
                { key: 'dailyLoss', cat: 'Risk', label: 'Max daily loss', op: '≤', threshold: 100, unit: '$', severity: 'Hard', enabled: true },
                { key: 'maxTrades', cat: 'Frequency', label: 'Max trades per day', op: '≤', threshold: 3, unit: '', severity: 'Hard', enabled: true },
                { key: 'maxOpenRisk', cat: 'Risk', label: 'Max open risk', op: '≤', threshold: 50, unit: '$', severity: 'Hard', enabled: true },
                { key: 'cooldown', cat: 'Behavior', label: 'Cooldown after loss', op: '≥', threshold: 15, unit: 'min', severity: 'Soft', enabled: true }
            ]
        }, 'Initial release'),
        cv('cv_rs_exec_v10', 'RuleSet', 'rs-exec', 'v1.0', '2026-07-20T00:00:00', {
            rules: [
                { key: 'stopRequired', cat: 'Execution', label: 'Stop loss required', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'minRR', cat: 'Execution', label: 'Minimum risk/reward', op: '≥', threshold: 1.5, unit: 'R', severity: 'Soft', enabled: true },
                { key: 'noRevenge', cat: 'Behavior', label: 'No revenge entry after loss', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'noAddLoser', cat: 'Behavior', label: 'No adding to a loser', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true }
            ]
        }, 'Initial release'),
        cv('cv_rs_exec_v11', 'RuleSet', 'rs-exec', 'v1.1', '2026-08-01T00:00:00', {
            rules: [
                { key: 'stopRequired', cat: 'Execution', label: 'Stop loss required', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'minRR', cat: 'Execution', label: 'Minimum risk/reward', op: '≥', threshold: 1.5, unit: 'R', severity: 'Soft', enabled: true },
                { key: 'noRevenge', cat: 'Behavior', label: 'No revenge entry after loss', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'noAddLoser', cat: 'Behavior', label: 'No adding to a loser', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true }
            ]
        }, 'Wording refresh'),
        cv('cv_rs_evid_v1', 'RuleSet', 'rs-evidence', 'v1.0', '2026-05-15T00:00:00', {
            rules: [
                { key: 'screenshot', cat: 'Evidence', label: 'Chart screenshot required', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true },
                { key: 'preTradeNote', cat: 'Evidence', label: 'Pre-trade note required', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true },
                { key: 'endOfDayReview', cat: 'Review', label: 'End-of-day review after breach', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true }
            ]
        }, 'Initial release')
    ];

    // Stable identity registries (identity survives version bumps)
    const StrategyMaster = [
        { id: 'strat-lfvg', name: 'London FVG', desc: 'Fair value gap sweep in the London open, MSS confirmation.', color: '#10B981', status: 'Active' },
        { id: 'strat-orob', name: 'Opening Range Breakout', desc: 'Breakout of the first 30-minute range at the NY open.', color: '#3B82F6', status: 'Active' },
        { id: 'strat-aob', name: 'Asia Order Block', desc: 'Order block entries in the quiet Asia session, tight stops.', color: '#C084FC', status: 'Active' }
    ];
    const RuleSetMaster = [
        { id: 'rs-core', name: 'Core Risk Set', scope: 'Accounts' },
        { id: 'rs-exec', name: 'Execution Discipline', scope: 'Strategies' },
        { id: 'rs-evidence', name: 'Evidence & Review', scope: 'Global' }
    ];

    // 3. ASSIGNMENTS — account ↔ strategy ↔ immutable policy version
    const asgn = (id, account_id, strategy_id, policy_id, strategy_version_id, active_from) =>
        ({ id, account_id, strategy_id, policy_id, strategy_version_id, active_from: new Date(active_from).toISOString() });

    let _asgnN = 0;
    const StrategyAssignments = [
        asgn('asgn-1', 'acc-prop', 'strat-lfvg', 'cv_rp_prop_v1', 'cv_strat_lfvg_v12', '2026-08-04T00:00:00'),
        asgn('asgn-2', 'acc-prop', 'strat-orob', 'cv_rp_prop_v1', 'cv_strat_orob_v1', '2026-05-15T00:00:00'),
        asgn('asgn-3', 'acc-personal', 'strat-lfvg', 'cv_rp_pers_v1', 'cv_strat_lfvg_v12', '2026-08-04T00:00:00'),
        asgn('asgn-4', 'acc-personal', 'strat-aob', 'cv_rp_pers_v1', 'cv_strat_aob_v14', '2026-05-15T00:00:00')
    ];
    _asgnN = StrategyAssignments.length; // next assignment id → 5, 6, … (was a duplicate-id bug)

    // 4. TRADES — immutable evidence (seeded from the shared demo history)
    const Trades = [];

    // 5. EVALUATION & VIOLATION EVENTS — written by the pipeline on
    //    create/edit (audit records of what each rule said at trade time).
    const TradeEvaluations = [];   // per-rule result per trade (versioned, immutable)
    const Violations = [];         // discipline violation events (hard-rule FAILs)

    // ------------------------------------------------------------------
    // 3. SEEDING — link every historical trade to an immutable version
    // ------------------------------------------------------------------
    const DEMO_STRATEGY_BY_SETUP = { 'MSS + FVG': 'strat-lfvg', 'FVG': 'strat-lfvg', 'Breakout': 'strat-orob', 'Order Block': 'strat-aob' };
    const nowISO = () => new Date().toISOString();

    function versionActiveAt(entityId, date) {
        return ConfigVersions
            .filter(cv2 => cv2.entity_type === 'Strategy' && cv2.entity_id === entityId && new Date(cv2.created_at) <= date)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    }

    function seedFromDemo(accountId, count) {
        if (Trades.length) return;
        if (!env.demoTrades) return; // pages without the shared generator start empty
        const acc = accountId || 'acc-prop';
        const demo = count ? env.demoTrades.genTrades().slice(-count) : env.demoTrades.genTrades();
        const policy = activePolicy(acc);
        demo.forEach((t, i) => {
            const strategyId = DEMO_STRATEGY_BY_SETUP[t.setup] || 'strat-lfvg';
            const sv = versionActiveAt(strategyId, t.ts) || ConfigVersions.find(c2 => c2.entity_id === strategyId);
            // derive entry/exit/size consistent with the ledger P&L (pip math
            // from the shared ASSET SPEC ENGINE, deterministic via the hash
            // helper — the same numbers everywhere)
            const tsNum = t.ts.getTime();
            const spec = assetSpecFor(t.symbol) || DEFAULT_SPEC;
            const pip = spec.pip, val = spec.val;
            const base = spec.base;
            const size = 1;
            const move = (t.pnl / (size * val)) * pip;                     // price move implied by P&L
            const jitter = (env.demoTrades ? env.demoTrades.mulberry32(tsNum + 3)() - 0.5 : 0) * pip * 10;
            const entry = Math.round((base + jitter) / pip) * pip;
            const exit = Math.round((entry + (t.dir === 'Long' ? 1 : -1) * move) / pip) * pip;
            Trades.push({
                id: 'txn-' + (i + 1).toString().padStart(4, '0'),
                ts: t.ts,
                account_id: acc,
                strategy_id: strategyId,
                config_version_id: policy ? policy.id : null,     // immutable policy link
                strategy_version_id: sv ? sv.id : null,           // immutable strategy link
                symbol: t.symbol, dir: t.dir, setup: t.setup, session: t.session,
                emotion: t.emotion, adherence: t.adherence, adherence_result: 'PASS',
                risk: t.risk, r: t.r, pnl: t.pnl,
                entry, exit, size,
                // derived fields (analytics / insights / discipline consume these)
                assetClass: t.assetClass, timeframe: t.timeframe, holdMin: t.holdMin,
                hour: t.hour, dow: t.dow, notes: t.notes,
                note: t.notes, created_at: t.ts.toISOString()
            });
        });
    }

    // ------------------------------------------------------------------
    // 4. AUDIT LOG (feed for the History tab — written by bus subscribers)
    // ------------------------------------------------------------------
    const EVENT_LOG = [
        { entity: 'Strategy · London FVG', what: 'Version bumped', detail: 'v1.1 → v1.2 · min RR 1.0 → 1.5', at: 'Aug 4, 09:12', impact: 'Trades before Aug 4 retain v1.1 rules' },
        { entity: 'Account · Prop Firm A', what: 'Limit edited', detail: 'Daily loss limit $80 → $100', at: 'Aug 2, 17:40', impact: 'Risk & Discipline re-evaluated from this date' },
        { entity: 'Tags', what: 'Tag archived', detail: '“Anxious” archived — 12 historical trades keep the tag', at: 'Jul 28, 11:05', impact: 'No new trades can use it; analytics preserved' }
    ];

    function logEvent(entry) {
        EVENT_LOG.unshift({ ...entry, at: nowStr() });
    }

    // ------------------------------------------------------------------
    // 5. HELPERS
    // ------------------------------------------------------------------
    const nowStr = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const bumpVer = v => {
        const m = String(v || '').match(/v(\d+)\.(\d+)/);
        return m ? 'v' + m[1] + '.' + (Number(m[2]) + 1) : 'v1.0';
    };
    const slug = s => String(s || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
    // Id generator — monotonic counter + millisecond timestamp + random suffix.
    // The counter guarantees uniqueness within a process (several ids created in
    // the same millisecond can otherwise collide, which a relational PK catches
    // where the in-memory demo never did); timestamp + entropy covers cross-process
    // runs. Ids are opaque strings — nothing parses their format.
    let _idSeq = 0;
    const idSuffix = () => Date.now().toString(36) + '-' + (_idSeq++).toString(36) + Math.random().toString(36).slice(2, 7);
    const uid = p => (p || 'id') + '-' + idSuffix();
    const deepCopy = o => o == null ? o : JSON.parse(JSON.stringify(o));
    const sameDay = (a, b) => {
        const da = a instanceof Date ? a : new Date(a);
        const db = b instanceof Date ? b : new Date(b);
        return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
    };

    // ------------------------------------------------------------------
    // 5b. HYDRATE / RESEED — swap the canonical tables in place (the arrays
    //     are live references held by every page, so they are mutated, never
    //     reassigned). hydrate() loads a backend snapshot (or data/db.json on
    //     the server); reseed() restores the pristine demo seed (Reset).
    // ------------------------------------------------------------------
    function recomputeEquities() {
        // Account equity is DERIVED state — always recomputed from the ledger
        // so a single source of truth can never drift from the trade records.
        Accounts.forEach(a => {
            const net = Trades.filter(t => t.account_id === a.id).reduce((s, t) => s + (t.pnl || 0), 0);
            a.current_equity = Math.round((a.starting_balance + net) * 100) / 100;
        });
    }

    // The account that drives the active dataset across every screen.
    // Persisted with the store so navigation keeps the same selection.
    let selectedAccountId = null;
    function selectedAccount() {
        if (selectedAccountId && Accounts.some(a => a.id === selectedAccountId)) return selectedAccountId;
        return Accounts.length ? Accounts[0].id : null;
    }
    function setSelectedAccount(id) {
        if (!Accounts.some(a => a.id === id)) return false;
        selectedAccountId = id;
        persist();
        TradeMindBus.publish('account.changed', { account_id: id });
        return true;
    }

    function hydrate(state) {
        if (!state) return;
        const set = (arr, rows) => { arr.length = 0; (rows || []).forEach(r => arr.push(r)); };
        set(Accounts, state.Accounts);
        set(ConfigVersions, state.ConfigVersions);
        set(StrategyAssignments, state.StrategyAssignments);
        set(Trades, state.Trades);
        set(StrategyMaster, state.StrategyMaster);
        set(RuleSetMaster, state.RuleSetMaster);
        set(TradeEvaluations, state.TradeEvaluations);
        set(Violations, state.Violations);
        set(EVENT_LOG, state.EVENT_LOG);
        if (state.selectedAccountId && Accounts.some(a => a.id === state.selectedAccountId)) selectedAccountId = state.selectedAccountId;
        _asgnN = StrategyAssignments.length;
        enrichAllDerived();
    }

    // ---- first-user / reset target: zero trades, zero strategies, zero accounts.
    // The real journey starts empty — the user sets up an account, a strategy,
    // then logs their first trade. seedDemoAccount() fills it for testing. ----
    function emptyState() {
        return {
            Accounts: [], ConfigVersions: [], StrategyAssignments: [], Trades: [],
            StrategyMaster: [], RuleSetMaster: [], TradeEvaluations: [], Violations: [],
            EVENT_LOG: [], selectedAccountId: null
        };
    }

    function reseed() {
        hydrate(emptyState());
        selectedAccountId = null;
        persist();
    }

    // ---- derived trade fields (single source of truth) ----
    // Pages need hour / dow / assetClass / timeframe / holdMin / notes / postLoss /
    // delayMin for analytics, insights and discipline. These are DERIVED from the
    // canonical ledger — recomputed here, never stored separately.

    // ----------------------------------------------------------------------
    // ASSET SPEC ENGINE — contract specifications for every major asset class
    // (Global Stocks, Indices, Forex, Crypto, Commodities). The SAME engine
    // powers the browser (journal live-calc, analytics units) and the server
    // (trade pipeline) — one formula, one source of truth.
    //
    //   pip      — the price step used to quote a move (0.0001 forex, 1 index
    //              point, 0.01 stock cent, 0.1 gold…)
    //   val      — dollars gained per 1.0 unit of size per ONE pip of move
    //              (forex $10/lot/pip, index $1/contract/point, stock $0.01
    //              /share/cent ⇒ $1 per $1 price move, crypto $1/coin/$1)
    //   unit     — the UI unit label (Pips / Points / Cents / Coins / Amount)
    //   sizeLabel— what the Size field means (Lots / Contracts / Shares / Coins)
    //   decimals — price display precision
    //   base     — a reference price for deriving seeded entry/exit prices
    //
    // P&L  = (exit − entry) ÷ pip × size × val × sign(dir)
    // Per-unit contract value = val ÷ pip  ($ per 1.0 price move per unit)
    // Size = risk ÷ (|entry − stop| × contract value)
    // ----------------------------------------------------------------------
    const ASSET_SPECS = [
        // ---- FOREX (JPY pairs quote in 0.01) ----
        { re: /^(USDJPY|EURJPY|GBPJPY|AUDJPY|CADJPY|CHFJPY|NZDJPY)$/, assetClass: 'Forex', pip: 0.01, val: 10, unit: 'Pips', sizeLabel: 'Lots', decimals: 3, base: 155 },
        { re: /^(EURUSD|GBPUSD|AUDUSD|NZDUSD|USDCAD|USDCHF|EURGBP|EURCHF|AUDNZD|EURNZD|GBPAUD|GBPNZD|EURCAD|GBPCAD|AUDCHF|CADCHF)$/, assetClass: 'Forex', pip: 0.0001, val: 10, unit: 'Pips', sizeLabel: 'Lots', decimals: 5, base: 1.1 },
        // ---- METALS ----
        { re: /^XAU/, assetClass: 'Commodities', pip: 0.1, val: 10, unit: 'Pips', sizeLabel: 'Lots', decimals: 2, base: 2350 },
        { re: /^XAG/, assetClass: 'Commodities', pip: 0.01, val: 5, unit: 'Pips', sizeLabel: 'Lots', decimals: 3, base: 27 },
        { re: /^X(PT|PD)/, assetClass: 'Commodities', pip: 0.1, val: 10, unit: 'Pips', sizeLabel: 'Lots', decimals: 2, base: 900 },
        // ---- ENERGY ----
        { re: /^(USOIL|UKOIL|XTIUSD|XBRUSD|BRENT|CL|WTI|OIL)$/, assetClass: 'Commodities', pip: 0.01, val: 10, unit: 'Pips', sizeLabel: 'Contracts', decimals: 2, base: 78 },
        { re: /^(NATGAS|XNGUSD|NG)$/, assetClass: 'Commodities', pip: 0.001, val: 10, unit: 'Pips', sizeLabel: 'Contracts', decimals: 3, base: 2.8 },
        // ---- AGRICULTURE / SOFTS (dollar move per unit) ----
        { re: /^(COFFEE|SUGAR|COCOA|COTTON|WHEAT|CORN|SOYBEAN|OATS|RICE|KC|SB|CC)$/, assetClass: 'Commodities', pip: 0.01, val: 1, unit: 'Pips', sizeLabel: 'Contracts', decimals: 2, base: 100 },
        // ---- INDICES (1 point = $1 per contract) ----
        { re: /(NAS100|US100|US30|SPX500|SP500|DAX40|GER40|DE40|UK100|JPN225|NIKKEI|AUS200|EU50|FRA40|HK50|NQ|ES|YM)$/, assetClass: 'Indices', pip: 1, val: 1, unit: 'Points', sizeLabel: 'Contracts', decimals: 0, base: 20000 },
        // ---- CRYPTO (dollar move per coin) ----
        { re: /^(BTC|ETH|SOL|XRP|ADA|DOGE|DOT|LTC|BNB|AVAX|MATIC|LINK|UNI|SHIB|PEPE|XLM|NEAR|APT|ARB|OP|SUI|INJ|SEI|TIA)/, assetClass: 'Crypto', pip: 1, val: 1, unit: 'Coins', sizeLabel: 'Coins', decimals: 0, base: 60000 },
        // ---- STOCKS (any 1–5 letter ticker: AAPL, TSLA, MSFT…) ----
        { re: /^[A-Z]{1,5}$/, assetClass: 'Stocks', pip: 0.01, val: 0.01, unit: 'Cents', sizeLabel: 'Shares', decimals: 2, base: 150 }
    ];
    const DEFAULT_SPEC = { assetClass: 'Other', pip: 1, val: 1, unit: 'Units', sizeLabel: 'Units', decimals: 2, base: 100 };

    // First match wins — specific contracts (JPY pairs, CL oil) are listed
    // before the broad fallbacks (stock ticker regex).
    function assetSpecFor(symbol) {
        const s = String(symbol || '').toUpperCase();
        for (let i = 0; i < ASSET_SPECS.length; i++) {
            if (ASSET_SPECS[i].re.test(s)) return ASSET_SPECS[i];
        }
        return null;
    }

    function assetClassOf(symbol) {
        const spec = assetSpecFor(symbol);
        return spec ? spec.assetClass : DEFAULT_SPEC.assetClass;
    }

    // $ per 1.0 price move per 1.0 unit of size (the contract value).
    function contractValueOf(symbol) {
        const s = assetSpecFor(symbol) || DEFAULT_SPEC;
        return s.val / s.pip;
    }

    // Dynamic P&L from contract spec — NOT a single default formula.
    // Returns null when there isn't enough to compute (callers fall back to
    // the user-provided value).
    function calcPnl(symbol, dir, entry, exit, size) {
        if (entry == null || exit == null || !size || size <= 0) return null;
        const s = assetSpecFor(symbol) || DEFAULT_SPEC;
        const sign = String(dir || 'Long').toLowerCase() === 'short' ? -1 : 1;
        return Math.round(((exit - entry) / s.pip) * size * s.val * sign * 100) / 100;
    }

    // Risk-based position sizing: units = risk $ ÷ (stop distance × contract
    // value per unit). E.g. forex: $100 ÷ (20 pips × $10/pip) = 0.5 lots;
    // stocks: $100 ÷ ($5 stop × $1/share/$, 1 move) = 20 shares.
    function calcPositionSize(symbol, riskDollars, entry, stop) {
        if (!riskDollars || riskDollars <= 0 || entry == null || stop == null || entry === stop) return null;
        const dist = Math.abs(entry - stop);
        const perUnit = contractValueOf(symbol);
        if (!dist || !perUnit) return null;
        return Math.round((riskDollars / (dist * perUnit)) * 100) / 100;
    }

    // Actual $ risk of a position: stop distance × size × contract value.
    function calcRiskDollars(symbol, entry, stop, size) {
        if (entry == null || stop == null || !size || size <= 0 || entry === stop) return null;
        return Math.round(Math.abs(entry - stop) * size * contractValueOf(symbol) * 100) / 100;
    }

    // Reward-to-risk from entry / stop / target (price distances only).
    function calcRR(entry, stop, tp) {
        if (entry == null || stop == null || tp == null || entry === stop) return null;
        const risk = Math.abs(entry - stop);
        return risk ? Math.round((Math.abs(tp - entry) / risk) * 100) / 100 : null;
    }

    // Spec-aware price formatting (5 decimals forex, 3 JPY, 2 gold/stocks…).
    function fmtPrice(symbol, v) {
        if (v == null || isNaN(v)) return '—';
        const s = assetSpecFor(symbol) || DEFAULT_SPEC;
        return Number(v).toFixed(s.decimals);
    }

    function enrichTrade(t, prev) {
        // normalize ts to a Date (localStorage round-trips it to an ISO string)
        if (!(t.ts instanceof Date)) t.ts = new Date(t.ts);
        const ts = t.ts;
        t.hour = ts.getHours();
        t.dow = ts.getDay();
        if (t.assetClass == null) t.assetClass = assetClassOf(t.symbol);
        if (t.timeframe == null) t.timeframe = 'M5';
        if (t.holdMin == null) t.holdMin = 60;
        if (t.notes == null) t.notes = t.note || '';
        if (t.note == null) t.note = t.notes || '';
        t.postLoss = !!(prev && prev.pnl < 0);
        if (prev && t.delayMin == null) t.delayMin = Math.max(0, Math.round((ts - new Date(prev.ts)) / 60000));
        return t;
    }

    function enrichAllDerived() {
        const byAccount = {};
        Trades.forEach(t => { (byAccount[t.account_id] = byAccount[t.account_id] || []).push(t); });
        Object.keys(byAccount).forEach(acc => {
            const sorted = byAccount[acc].slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
            sorted.forEach((t, i) => enrichTrade(t, i > 0 ? sorted[i - 1] : null));
        });
        recomputeEquities();
    }

    function activeAssignment(accountId, strategyId) {
        const rows = StrategyAssignments
            .filter(a => a.account_id === accountId && (!strategyId || a.strategy_id === strategyId))
            .sort((a, b) => new Date(b.active_from) - new Date(a.active_from));
        return rows[0] || null;
    }

    function activePolicy(accountId) {
        const a = activeAssignment(accountId);
        if (a) return ConfigVersions.find(cv2 => cv2.id === a.policy_id) || null;
        // fresh account with no strategy assignments yet — fall back to the
        // latest RiskPolicy version created for the account
        return ConfigVersions
            .filter(cv2 => cv2.entity_type === 'RiskPolicy' && cv2.entity_id === accountId)
            .sort((x, y) => new Date(y.created_at) - new Date(x.created_at))[0] || null;
    }

    function activeStrategyVersion(strategyId) {
        return ConfigVersions
            .filter(cv2 => cv2.entity_type === 'Strategy' && cv2.entity_id === strategyId)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    }

    function activeRuleSetVersion(ruleSetId) {
        return ConfigVersions
            .filter(cv2 => cv2.entity_type === 'RuleSet' && cv2.entity_id === ruleSetId)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    }

    function strategiesFor(accountId) {
        const ids = [...new Set(StrategyAssignments.filter(a => a.account_id === accountId).map(a => a.strategy_id))];
        return ids.map(id => StrategyMaster.find(m => m.id === id)).filter(Boolean);
    }

    function accountIdsForStrategy(strategyId) {
        return [...new Set(StrategyAssignments.filter(a => a.strategy_id === strategyId).map(a => a.account_id))];
    }

    function reAssign(accountId, strategyId, policyId, strategyVersionId) {
        // Guarantee strictly increasing active_from for the same account+strategy
        // so the newest assignment always wins the desc sort in activeAssignment.
        // Same-millisecond edits would otherwise tie and keep the OLDER
        // assignment first — and the new policy version would never activate.
        let from = Date.now();
        StrategyAssignments
            .filter(a => a.account_id === accountId && a.strategy_id === strategyId)
            .forEach(a => { const t = new Date(a.active_from).getTime(); if (t >= from) from = t + 1; });
        StrategyAssignments.push({
            id: 'asgn-' + (++_asgnN),
            account_id: accountId,
            strategy_id: strategyId,
            policy_id: policyId,
            strategy_version_id: strategyVersionId,
            active_from: new Date(from).toISOString()
        });
    }

    // ------------------------------------------------------------------
    // 6. CONFIGURATION API — the only way to change configuration.
    //    Every mutation creates an immutable version and emits events.
    // ------------------------------------------------------------------
    function newConfigVersion(entity_type, entity_id, version, values, note) {
        const v = {
            id: 'cv_' + idSuffix(),
            entity_type, entity_id, version,
            created_at: nowISO(),
            values: deepCopy(values),
            note: note || ''
        };
        ConfigVersions.push(v);
        return v;
    }

    function publishConfig(version, extra) {
        TradeMindBus.publish('config.version.created', version ? { ...version, ...extra } : extra);
        TradeMindBus.publish('config.changed', { ...(extra || {}), version });
    }

    const ConfigAPI = {
        // ---- reads ----
        getAccount: id => Accounts.find(a => a.id === id) || null,
        getStrategy: id => StrategyMaster.find(m => m.id === id) || null,
        getRuleSet: id => RuleSetMaster.find(m => m.id === id) || null,
        activeAssignment, activePolicy, activeStrategyVersion, activeRuleSetVersion,
        strategiesFor, accountIdsForStrategy,
        getEventLog: () => EVENT_LOG,
        getVersionChain: (entityId) => ConfigVersions
            .filter(cv2 => cv2.entity_id === entityId)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),

        // ---- account identity (not versioned) ----
        updateAccount(accountId, fields) {
            const a = Accounts.find(x => x.id === accountId);
            if (!a) return null;
            if (fields.name != null) a.name = fields.name;
            if (fields.account_type != null) a.account_type = fields.account_type;
            if (fields.currency != null) a.currency = fields.currency;
            if (fields.style != null) a.style = fields.style;
            if (fields.starting_balance != null) a.starting_balance = fields.starting_balance;
            if (fields.current_equity != null) a.current_equity = fields.current_equity;
            if (fields.status != null) a.status = fields.status;
            if (fields.note != null) a.note = fields.note;
            TradeMindBus.publish('config.changed', { account_id: accountId });
            syncToBackend('/api/accounts/' + accountId, fields);
            return a;
        },

        // ---- risk limits: creates a NEW immutable policy version + re-points assignments ----
        updateAccountLimits(accountId, values, note) {
            const old = activePolicy(accountId);
            const oldDaily = old ? old.values.maxDailyLoss : null;
            const v = newConfigVersion('RiskPolicy', accountId, bumpVer(old ? old.version : 'v0.0'), values, note || 'Limit edit');
            // re-point every assignment of this account at the new immutable version
            StrategyAssignments.filter(a => a.account_id === accountId).forEach(a => reAssign(accountId, a.strategy_id, v.id, a.strategy_version_id));
            const accName = (Accounts.find(x => x.id === accountId) || {}).name;
            logEvent({
                entity: 'Account · ' + accName, what: 'Limit edited',
                detail: oldDaily != null && values.maxDailyLoss != null && oldDaily !== values.maxDailyLoss
                    ? 'Daily loss limit $' + oldDaily + ' → $' + values.maxDailyLoss
                    : 'Configuration updated',
                impact: 'Risk & Discipline re-evaluate from this timestamp'
            });
            publishConfig(v, { account_id: accountId, entity: 'RiskPolicy', name: accName });
            syncToBackend('/api/accounts/' + accountId + '/limits', { values, note });
            return v;
        },

        setAccountStatus(accountId, status) {
            const a = Accounts.find(x => x.id === accountId);
            if (!a) return null;
            a.status = status;
            const active = status === 'Active';
            logEvent({
                entity: 'Account · ' + a.name, what: active ? 'Activated' : 'Archived',
                detail: 'Status → ' + status, at: nowStr(),
                impact: 'Archived accounts stay readable in history'
            });
            TradeMindBus.publish('config.changed', { account_id: accountId });
            syncToBackend('/api/accounts/' + accountId + '/status', { status });
            return a;
        },

        createAccount(fields, preId) {
            // idempotent replay — an account that already exists is a no-op
            if (preId && Accounts.some(a => a.id === preId)) return preId;
            // defensive aliasing — the UI and the API may use different key
            // spellings; a partial payload must never yield a no-limit policy
            const risk = fields.risk != null ? fields.risk : (fields.riskPerTrade != null ? fields.riskPerTrade : 25);
            const dailyLoss = fields.dailyLoss != null ? fields.dailyLoss : (fields.dailyLossLimit != null ? fields.dailyLossLimit : 100);
            const maxDD = fields.maxDD != null ? fields.maxDD : (fields.maxDrawdown != null ? fields.maxDrawdown : 500);
            const start = fields.start != null ? fields.start : (fields.starting_balance != null ? fields.starting_balance : 0);
            const equity = fields.equity != null ? fields.equity : start;
            const id = preId || 'acc-' + slug(fields.name) + '-' + idSuffix();
            Accounts.push({
                id, name: fields.name, account_type: fields.type || fields.account_type || 'Personal',
                currency: fields.currency || 'USD', style: fields.style || '',
                starting_balance: start, current_equity: equity,
                status: fields.status || 'Active', note: 'Drawdown basis: ' + (fields.ddModel || 'static')
            });
            const v = newConfigVersion('RiskPolicy', id, 'v1.0', {
                ddModel: fields.ddModel || 'static',
                maxDailyRisk: fields.dailyRisk != null ? fields.dailyRisk : (fields.maxDailyRisk != null ? fields.maxDailyRisk : dailyLoss),
                maxDailyLoss: dailyLoss, maxTotalDrawdown: maxDD,
                riskPerTrade: risk, riskBasis: fields.basis || 'money', maxOpenRisk: fields.openR || fields.maxOpenRisk || 50, openBasis: 'money',
                maxTrades: fields.maxTrades || 5, warn: fields.warn || [50, 70, 90]
            }, 'Created with account');
            logEvent({
                entity: 'Account · ' + fields.name, what: 'Created',
                detail: '$' + fields.start + ' · $' + fields.dailyLoss + ' daily loss · $' + fields.maxDD + ' max DD',
                impact: 'Published as active account rule state'
            });
            publishConfig(v, { account_id: id, entity: 'RiskPolicy', name: fields.name });
            syncToBackend('/api/accounts', { id, fields });
            // provision the standard rule sets so the rule engine evaluates
            // trades from the very first log (limits read the policy above)
            ensureDefaultRuleSets(id);
            // a new account picks up every active strategy by default (so the
            // Journal can log against it immediately); explicit assignment UI
            // can refine this later
            if (!StrategyAssignments.some(a => a.account_id === id)) {
                StrategyMaster.filter(m => m.status === 'Active').forEach(m => {
                    const sv = activeStrategyVersion(m.id);
                    reAssign(id, m.id, v.id, sv ? sv.id : null);
                });
            }
            return id;
        },

        duplicateAccount(accountId, preId) {
            const src = Accounts.find(a => a.id === accountId);
            if (!src) return null;
            if (preId && Accounts.some(a => a.id === preId)) return preId;
            const id = preId || 'acc-' + slug(src.name) + '-copy-' + idSuffix();
            Accounts.push({
                id, name: src.name + ' (copy)', account_type: src.account_type, currency: src.currency,
                starting_balance: src.starting_balance, current_equity: src.current_equity,
                status: 'Paused', note: src.note
            });
            const pol = activePolicy(accountId);
            const v = newConfigVersion('RiskPolicy', id, 'v1.0', pol ? pol.values : {}, 'Duplicated from ' + src.name);
            StrategyAssignments.filter(a => a.account_id === accountId).forEach(a => reAssign(id, a.strategy_id, v.id, a.strategy_version_id));
            logEvent({
                entity: 'Account · ' + src.name + ' (copy)', what: 'Duplicated',
                detail: 'From ' + src.name + ' · paused on creation',
                impact: 'No trades linked yet'
            });
            publishConfig(v, { account_id: id, entity: 'RiskPolicy', name: src.name + ' (copy)' });
            syncToBackend('/api/accounts/' + accountId + '/duplicate', { id });
            return id;
        },

        // ---- strategies: every edit bumps the immutable version ----
        createStrategy(fields, preId) {
            // idempotent replay — a strategy that already exists is a no-op
            if (preId && StrategyMaster.some(s => s.id === preId)) return preId;
            const id = preId || 'strat-' + slug(fields.name) + '-' + idSuffix();
            StrategyMaster.push({
                id, name: fields.name, desc: fields.desc || '', color: fields.color || '#10B981', status: 'Active'
            });
            const v = newConfigVersion('Strategy', id, 'v1.0', {
                name: fields.name, markets: fields.markets,
                sessions: (fields.sessions || []).slice(),
                setup: fields.setup, risk: { riskPerTrade: fields.riskPerTrade, minRR: Number(fields.minRR) || 1.5, stopRequired: fields.stopRequired, maxPositions: 1 },
                entry: fields.entry, exit: fields.exit, behavior: (fields.behavior || []).slice(),
                evidence: ['Chart screenshot'], tags: (fields.tags || []).slice()
            }, 'Created');
            const accId = selectedAccount() || (Accounts.length ? Accounts[0].id : null);
            if (accId) {
                const pol = activePolicy(accId);
                reAssign(accId, id, pol ? pol.id : null, v.id);
            }
            logEvent({
                entity: 'Strategy · ' + fields.name, what: 'Created',
                detail: 'v1.0 · ' + fields.markets + ' · ' + fields.riskPerTrade + ' risk',
                impact: 'Available for Journal assignment now'
            });
            publishConfig(v, { entity: 'Strategy', name: fields.name });
            syncToBackend('/api/strategies', { id, fields });
            return id;
        },

        updateStrategy(strategyId, fields, note) {
            const old = activeStrategyVersion(strategyId);
            const m = StrategyMaster.find(x => x.id === strategyId);
            if (!m) return null;
            const prev = old ? old.values : {};
            const oldVer = old ? old.version : 'v0.0';
            // Partial edits are merged with the previous version's values so the
            // new immutable version inherits every unchanged setting (v2 keeps
            // v1's untouched fields). Guarded slices — a caller sending only
            // { name, minRR } must not throw on undefined arrays.
            const v = newConfigVersion('Strategy', strategyId, bumpVer(oldVer), {
                name: fields.name || prev.name || m.name,
                markets: fields.markets !== undefined ? fields.markets : prev.markets,
                sessions: (fields.sessions || prev.sessions || []).slice(),
                setup: fields.setup !== undefined ? fields.setup : prev.setup,
                risk: {
                    riskPerTrade: fields.riskPerTrade !== undefined ? fields.riskPerTrade : (prev.risk || {}).riskPerTrade,
                    minRR: Number(fields.minRR) || (prev.risk || {}).minRR || 1.5,
                    stopRequired: fields.stopRequired !== undefined ? fields.stopRequired : (prev.risk || {}).stopRequired,
                    maxPositions: (prev.risk || {}).maxPositions || 1
                },
                entry: fields.entry !== undefined ? fields.entry : prev.entry,
                exit: fields.exit !== undefined ? fields.exit : prev.exit,
                behavior: (fields.behavior || prev.behavior || []).slice(),
                evidence: fields.evidence || prev.evidence || ['Chart screenshot'],
                tags: (fields.tags || prev.tags || []).slice()
            }, note || 'Strategy edit');
            StrategyAssignments.filter(a => a.strategy_id === strategyId).forEach(a => reAssign(a.account_id, strategyId, a.policy_id, v.id));
            logEvent({
                entity: 'Strategy · ' + m.name, what: 'Version bumped',
                detail: oldVer + ' → ' + v.version + ' · rules updated',
                impact: 'Trades before now retain ' + oldVer + ' rules'
            });
            publishConfig(v, { entity: 'Strategy', name: m.name });
            syncToBackend('/api/strategies/' + strategyId, { fields, note });
            return v;
        },

        duplicateStrategy(strategyId, preId) {
            const src = StrategyMaster.find(m => m.id === strategyId);
            if (!src) return null;
            if (preId && StrategyMaster.some(s => s.id === preId)) return preId;
            const id = preId || 'strat-' + slug(src.name) + '-copy-' + idSuffix();
            StrategyMaster.push({ id, name: src.name + ' (copy)', desc: src.desc, color: src.color, status: 'Active' });
            const old = activeStrategyVersion(strategyId);
            newConfigVersion('Strategy', id, 'v1.0', old ? deepCopy(old.values) : {}, 'Duplicated from ' + src.name);
            logEvent({
                entity: 'Strategy · ' + src.name + ' (copy)', what: 'Duplicated',
                detail: 'From ' + src.name + ' · fresh version v1.0',
                impact: 'Unassigned — pick accounts before using'
            });
            publishConfig(null, { entity: 'Strategy', name: src.name + ' (copy)' });
            syncToBackend('/api/strategies/' + strategyId + '/duplicate', { id });
            return id;
        },

        // ---- rule sets: toggling a rule creates a new immutable version ----
        toggleRule(key) {
            const master = RuleSetMaster.find(m2 => (activeRuleSetVersion(m2.id) || {}).values &&
                activeRuleSetVersion(m2.id).values.rules.some(r => r.key === key));
            if (!master) return null;
            const old = activeRuleSetVersion(master.id);
            const rules = deepCopy(old.values.rules);
            const rule = rules.find(r => r.key === key);
            if (!rule) return null;
            rule.enabled = !rule.enabled;
            const v = newConfigVersion('RuleSet', master.id, bumpVer(old.version), { rules }, 'Rule toggled: ' + key);
            logEvent({
                entity: 'Rule Set · ' + master.name, what: rule.enabled ? 'Rule enabled' : 'Rule disabled',
                detail: '“' + rule.label + '” ' + (rule.enabled ? 'enabled' : 'disabled') + ' · ' + old.version + ' → ' + v.version,
                impact: 'Discipline & Journal evaluate against the new version from now on'
            });
            publishConfig(v, { entity: 'RuleSet', name: master.name });
            syncToBackend('/api/rule-sets/toggle', { key });
            return v;
        },

        recordManualChange(detail) {
            logEvent({ entity: 'Configuration', what: 'Manual record', detail: detail, impact: 'Audited for future reference' });
            TradeMindBus.publish('config.changed', { manual: true });
            syncToBackend('/api/events', { action: 'manual', detail: detail });
        },

        logTagEvent(entity, what, detail, impact, opts) {
            logEvent({ entity, what, detail, impact });
            TradeMindBus.publish('config.changed', { tag: true });
            // opts.sync === false → record locally only (e.g. broker events,
            // which the /api/brokers routes already write to the server log, so
            // the client mirrors locally without duplicating the server entry).
            if (!opts || opts.sync !== false) {
                syncToBackend('/api/events', { action: 'tag', entity, what, detail, impact });
            }
        },

        // ---- rule sets: add / edit a rule (always a new immutable version) ----
        addRule(ruleSetId, rule) {
            const master = RuleSetMaster.find(m2 => m2.id === ruleSetId);
            if (!master) return null;
            const old = activeRuleSetVersion(ruleSetId);
            const rules = deepCopy(old ? old.values.rules : []);
            const key = rule.key || slug(rule.label || 'rule');
            rules.push({ key, cat: rule.cat || 'Custom', label: rule.label, op: rule.op || '≤', threshold: rule.threshold, unit: rule.unit || '', severity: rule.severity || 'Hard', enabled: rule.enabled !== false });
            const v = newConfigVersion('RuleSet', ruleSetId, bumpVer(old ? old.version : 'v0.0'), { rules }, 'Rule added: ' + rule.label);
            logEvent({ entity: 'Rule Set · ' + master.name, what: 'Rule added', detail: '“' + rule.label + '” · ' + (rule.severity || 'Hard'), impact: 'Future evaluations include it' });
            publishConfig(v, { entity: 'RuleSet', name: master.name });
            syncToBackend('/api/rule-sets/' + ruleSetId + '/rules', { rule });
            return v;
        },

        updateRule(ruleSetId, key, changes) {
            const master = RuleSetMaster.find(m2 => m2.id === ruleSetId);
            if (!master) return null;
            const old = activeRuleSetVersion(ruleSetId);
            if (!old) return null;
            const rules = deepCopy(old.values.rules);
            const rule = rules.find(r => r.key === key);
            if (!rule) return null;
            Object.keys(changes || {}).forEach(k => { if (changes[k] !== undefined && k !== 'key') rule[k] = changes[k]; });
            const v = newConfigVersion('RuleSet', ruleSetId, bumpVer(old.version), { rules }, 'Rule edited: ' + key);
            logEvent({ entity: 'Rule Set · ' + master.name, what: 'Rule updated', detail: '“' + rule.label + '” ' + old.version + ' → ' + v.version, impact: 'Future evaluations use the new threshold' });
            publishConfig(v, { entity: 'RuleSet', name: master.name });
            syncToBackend('/api/rule-sets/' + ruleSetId + '/rules/' + key, { changes });
            return v;
        },

        // ---- strategy-to-account assignment ----
        assignStrategy(accountId, strategyId) {
            if (!Accounts.find(a => a.id === accountId) || !StrategyMaster.find(m => m.id === strategyId)) return null;
            const pol = activePolicy(accountId);
            const sv = activeStrategyVersion(strategyId);
            reAssign(accountId, strategyId, pol ? pol.id : null, sv ? sv.id : null);
            const accName = (Accounts.find(x => x.id === accountId) || {}).name;
            logEvent({ entity: 'Account · ' + accName, what: 'Strategy assigned', detail: strategyId, impact: 'Journal & analytics include it from now on' });
            TradeMindBus.publish('config.changed', { account_id: accountId });
            syncToBackend('/api/accounts/' + accountId + '/strategies', { strategy_id: strategyId });
            return true;
        }
    };

    // ------------------------------------------------------------------
    // 7. THE 7-STEP RULE EVALUATION PIPELINE (Log Trade)
    // ------------------------------------------------------------------
    function logTradePipeline(rawTrade) {
        // Idempotency — a replayed trade (client-generated id) that already
        // exists is returned as-is instead of being evaluated + inserted twice
        // (client→server sync replays mutations; ids are client-generated).
        if (rawTrade && rawTrade.id) {
            const existing = Trades.find(t => t.id === rawTrade.id);
            if (existing) return existing;
        }
        // Step 0: ensure the rule engine has rules to evaluate against (older
        // persisted states may predate provisioning — self-heal)
        if (!RuleSetMaster.length && rawTrade.account_id) ensureDefaultRuleSets(rawTrade.account_id);
        // Step 1: Resolve Context — find the assignment for this account (and strategy if given)
        const accountId = rawTrade.account_id;
        if (!accountId) throw new Error('account_id is required');
        if (!Accounts.some(a => a.id === accountId)) {
            throw new Error('Unknown account ' + accountId + ' — create an account in Strategy Lab first');
        }
        let assignment = StrategyAssignments
            .filter(a => a.account_id === accountId && (!rawTrade.strategy_id || a.strategy_id === rawTrade.strategy_id))
            .sort((a, b) => new Date(b.active_from) - new Date(a.active_from))[0]
            || StrategyAssignments.filter(a => a.account_id === accountId).sort((a, b) => new Date(b.active_from) - new Date(a.active_from))[0];
        // Self-heal: an account with no assignment must never silently fail to
        // log a trade. Auto-assign its first active strategy — or provision a
        // default "Manual Trading" strategy — so the save always succeeds and
        // the trade is still evaluated against the account policy.
        if (!assignment) {
            let pol = activePolicy(accountId);
            if (!pol) {
                pol = newConfigVersion('RiskPolicy', accountId, 'v1.0', {
                    ddModel: 'static', maxDailyLoss: 100, maxTotalDrawdown: 500,
                    riskPerTrade: 25, riskBasis: 'money', maxOpenRisk: 50, openBasis: 'money',
                    maxTrades: 5, warn: [50, 70, 90]
                }, 'Provisioned on first trade');
            }
            let strat = StrategyMaster.find(m => m.status === 'Active');
            if (!strat) {
                const sid = 'strat-manual-' + Date.now().toString(36).slice(-4);
                StrategyMaster.push({ id: sid, name: 'Manual Trading', desc: 'Auto-provisioned — no strategy configured yet', color: '#10B981', status: 'Active' });
                newConfigVersion('Strategy', sid, 'v1.0', {
                    name: 'Manual Trading', markets: '', sessions: [],
                    setup: '', risk: { riskPerTrade: pol.values.riskPerTrade, minRR: 1.5, stopRequired: true, maxPositions: 1 },
                    entry: '', exit: '', behavior: [], evidence: ['Chart screenshot'], tags: []
                }, 'Provisioned on first trade');
                strat = StrategyMaster.find(m => m.id === sid);
            }
            const sv = activeStrategyVersion(strat.id);
            reAssign(accountId, strat.id, pol.id, sv ? sv.id : null);
            ensureDefaultRuleSets(accountId);
            TradeMindBus.publish('config.changed', { account_id: accountId, selfHealed: true });
            assignment = StrategyAssignments
                .filter(a => a.account_id === accountId && (!rawTrade.strategy_id || a.strategy_id === rawTrade.strategy_id))
                .sort((a, b) => new Date(b.active_from) - new Date(a.active_from))[0]
                || StrategyAssignments.filter(a => a.account_id === accountId).sort((a, b) => new Date(b.active_from) - new Date(a.active_from))[0];
        }

        // Step 2: Load Policy — the immutable version the assignment points at
        const policy = ConfigVersions.find(cv2 => cv2.id === assignment.policy_id);
        if (!policy) throw new Error('No active policy for assignment ' + assignment.id);

        // Step 3: Evaluate — the shared Rule Engine (deterministic, versioned).
        // The engine covers per-trade risk, daily risk, daily loss, trade count,
        // cooldown, session/setup rules, execution and behavior rules.
        // ---- ASSET-AWARE DERIVATION (shared engine, not a default formula):
        // if the ledger P&L wasn't given but entry/exit/size were, compute it
        // from the instrument's contract spec (pips/lots, points/contracts,
        // shares/cents, coins/$). If size is missing but P&L + prices exist,
        // derive the size that produced it. Rules evaluate against the final
        // values so daily-loss / max-risk checks see the real numbers.
        const spec = assetSpecFor(rawTrade.symbol);
        let _pnl = rawTrade.pnl != null ? rawTrade.pnl : null;
        let _size = rawTrade.size != null ? rawTrade.size : null;
        if (_pnl == null && _size > 0 && rawTrade.entry != null && rawTrade.exit != null) {
            _pnl = calcPnl(rawTrade.symbol, rawTrade.dir, rawTrade.entry, rawTrade.exit, _size);
        }
        if (_size == null && _pnl != null && rawTrade.entry != null && rawTrade.exit != null && rawTrade.entry !== rawTrade.exit) {
            const cv = spec ? spec.val / spec.pip : 1;
            if (cv > 0) _size = Math.round(Math.abs(_pnl) / (Math.abs(rawTrade.exit - rawTrade.entry) * cv) * 100) / 100;
        }
        const draft = {
            ...rawTrade,
            account_id: accountId,
            strategy_id: assignment.strategy_id,
            ts: rawTrade.ts ? new Date(rawTrade.ts) : new Date(),
            pnl: _pnl != null ? _pnl : 0,
            risk: rawTrade.risk != null ? rawTrade.risk : (rawTrade.plannedRisk || 0),
            size: _size != null ? _size : rawTrade.size
        };
        const evals = evaluateRules({
            accountId,
            trade: draft,
            policyOverride: policy,
            strategyVersionOverride: activeStrategyVersion(assignment.strategy_id)
        });
        const hardFails = evals.filter(e => e.state === 'FAIL' && e.severity === 'Hard');
        const blocking = hardFails.filter(e => BLOCKING_KEYS.indexOf(e.ruleKey) !== -1);
        const ruleResult = blocking.length ? 'BLOCK' : (hardFails.length ? 'VIOLATION' : 'PASS');

        // Step 4: Persist Evidence — the trade is immutable proof, linked to the
        // version. The client-generated id is preserved when present so replaying
        // the same trade is idempotent (client→server sync); otherwise generate one.
        const validatedTrade = {
            ...draft,
            id: rawTrade.id || ('txn-' + idSuffix()),
            account_id: accountId,
            strategy_id: assignment.strategy_id,
            config_version_id: policy.id,                  // immutable link (policy)
            strategy_version_id: assignment.strategy_version_id, // immutable link (strategy)
            adherence_result: ruleResult,
            block_reason: hardFails.map(e => e.explanation).join('; '),
            created_at: nowISO()
        };
        // R multiple is derived state — recompute whenever risk is present
        if (validatedTrade.risk > 0 && (validatedTrade.r == null || isNaN(validatedTrade.r))) {
            validatedTrade.r = Math.round((validatedTrade.pnl / validatedTrade.risk) * 100) / 100;
        }
        // derived fields (hour/dow/assetClass/timeframe/postLoss/delayMin/…) so
        // analytics, insights and discipline read them straight off the ledger
        enrichTrade(validatedTrade, lastTradeBefore(accountId, validatedTrade.ts));
        Trades.push(validatedTrade);
        writeEvaluations(validatedTrade, evals);   // evaluation + violation audit

        // Step 5: Update State — account equity is derived state, recomputed here
        const account = Accounts.find(a => a.id === accountId);
        if (account) account.current_equity += validatedTrade.pnl;

        // Step 6 & 7: Publish Events & Refresh Insights — downstream modules
        // (Risk, Discipline, Analytics, Journal) listen and update themselves.
        TradeMindBus.publish('trade.created', validatedTrade);
        syncToBackend('/api/trades', validatedTrade);
        return validatedTrade;
    }

    // ------------------------------------------------------------------
    // 8. DOWNSTREAM SUBSCRIBERS (architecture demonstration — see pages)
    // ------------------------------------------------------------------
    TradeMindBus.subscribe('trade.created', (trade) => {
        console.log('Risk Engine: Recomputing drawdown for account ' + trade.account_id + ' (' + trade.adherence_result + ')');
        const acct = Accounts.find(a => a.id === trade.account_id);
        if (acct) console.log('   → ' + acct.name + ' equity now ' + acct.current_equity.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
    });
    TradeMindBus.subscribe('config.version.created', (newConfig) => {
        console.log('Audit Service: New rule version created — ' + newConfig.id + ' · ' + newConfig.version + ' (' + newConfig.entity_type + ')');
    });

    // ------------------------------------------------------------------
    // 9. PERSISTENCE SEAM — the host injects storage via env.storage
    //    ({ load, save, clear }). The browser shell supplies a localStorage
    //    adapter; the server supplies none (it persists data/db.json itself).
    //    The core itself has ZERO DOM / localStorage dependencies.
    // ------------------------------------------------------------------
    const repo = env.storage || null;

    function serializeState() {
        return {
            Accounts: deepCopy(Accounts),
            ConfigVersions: deepCopy(ConfigVersions),
            StrategyAssignments: deepCopy(StrategyAssignments),
            Trades: deepCopy(Trades),
            StrategyMaster: deepCopy(StrategyMaster),
            RuleSetMaster: deepCopy(RuleSetMaster),
            TradeEvaluations: deepCopy(TradeEvaluations),
            Violations: deepCopy(Violations),
            EVENT_LOG: deepCopy(EVENT_LOG),
            selectedAccountId
        };
    }

    let persistTimer = null;
    function persist() {
        clearTimeout(persistTimer);
        if (!repo) return;
        repo.save(serializeState());
    }
    function schedulePersist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persist, 60);
    }

    // Persist on every mutation — one hook, every write path. The bus is the
    // single funnel: all mutations end by publishing one of these events.
    ['trade.created', 'trade.updated', 'trade.deleted', 'config.changed', 'review.completed'].forEach(ev => {
        TradeMindBus.subscribe(ev, schedulePersist);
    });

    // ---- optional backend mirror (OFF by default — local-first). The host
    // (browser shell) injects env.sync; the core stays DOM/localStorage-free.
    const syncToBackend = env.sync || function () {};
    // ---- DEV / TESTING SEED — a realistic ~30-trade dataset. NOT the
    // default: the first-user experience starts empty. Call from devtools:
    //     TradeMindCore.seedDemoAccount(30)
    function seedDemoAccount(count) {
        if (!env.demoTrades) return null;
        reseed();
        const n = count || 30;

        const accId = ConfigAPI.createAccount({
            name: 'Prop Firm A', type: 'Prop / Funded', currency: 'USD', style: 'Intraday',
            start: 10000, equity: 10000, ddModel: 'trailing',
            dailyLoss: 100, maxDD: 500, risk: 25, basis: 'money', openR: 50,
            maxTrades: 3, status: 'Active', warn: [50, 70, 90]
        }, 'acc-prop');

        ConfigAPI.createStrategy({
            name: 'London FVG', desc: 'Fair value gap sweep in the London open, MSS confirmation.', color: '#10B981',
            markets: 'FX · EURUSD, GBPUSD', sessions: ['London'], setup: 'MSS + FVG, FVG',
            riskPerTrade: '1%', minRR: 1.5, stopRequired: true,
            entry: 'FVG fill + MSS confirmation', exit: 'TP at opposing liquidity · 50% partial at 1R',
            behavior: ['No revenge entry', 'Cooldown 15 min after loss', 'Max 2 losses then stop'],
            evidence: ['Chart screenshot', 'Setup annotation'], tags: ['A+ Setup', 'London', 'Clean Entry']
        }, 'strat-lfvg');
        ConfigAPI.createStrategy({
            name: 'Opening Range Breakout', desc: 'Breakout of the first 30-minute range at the NY open.', color: '#3B82F6',
            markets: 'Index · NAS100', sessions: ['New York'], setup: 'Breakout',
            riskPerTrade: '2%', minRR: 2, stopRequired: true,
            entry: 'Range breakout with retest', exit: 'Trailing stop · TP at ATH/ATL',
            behavior: ['No adding to loser'], evidence: ['Pre-trade note'], tags: ['NY', 'Breakout']
        }, 'strat-orob');
        ConfigAPI.createStrategy({
            name: 'Asia Order Block', desc: 'Order block entries in the quiet Asia session, tight stops.', color: '#C084FC',
            markets: 'Metal · XAUUSD', sessions: ['Asia'], setup: 'Order Block',
            riskPerTrade: '0.5%', minRR: 1.5, stopRequired: true,
            entry: 'OB mitigation', exit: 'TP at session high/low',
            behavior: ['Cooldown after loss'], evidence: ['Setup annotation'], tags: ['Asia', 'A+ Setup']
        }, 'strat-aob');

        // rule sets — identity + first immutable version (discipline engine keys).
        // createAccount() already auto-provisioned now-dated versions — replace
        // them with the canonical backdated originals so seeded historical trades
        // evaluate against the same rules (and no duplicate ids/versions exist).
        for (let i = ConfigVersions.length - 1; i >= 0; i--) {
            if (ConfigVersions[i].entity_type === 'RuleSet') ConfigVersions.splice(i, 1);
        }
        RuleSetMaster.splice(0, RuleSetMaster.length);
        RuleSetMaster.push({ id: 'rs-core', name: 'Core Risk Set', scope: 'Accounts' });
        RuleSetMaster.push({ id: 'rs-exec', name: 'Execution Discipline', scope: 'Strategies' });
        RuleSetMaster.push({ id: 'rs-evidence', name: 'Evidence & Review', scope: 'Global' });
        ConfigVersions.push(cv('cv_rs_core_v1', 'RuleSet', 'rs-core', 'v1.0', '2026-05-15T00:00:00', {
            rules: [
                { key: 'riskPerTrade', cat: 'Risk', label: 'Max risk per trade', op: '≤', threshold: 25, unit: '$', severity: 'Hard', enabled: true },
                { key: 'dailyRisk', cat: 'Risk', label: 'Max daily risk', op: '≤', threshold: 100, unit: '$', severity: 'Hard', enabled: true },
                { key: 'dailyLoss', cat: 'Risk', label: 'Max daily loss', op: '≤', threshold: 100, unit: '$', severity: 'Hard', enabled: true },
                { key: 'maxTrades', cat: 'Frequency', label: 'Max trades per day', op: '≤', threshold: 3, unit: '', severity: 'Hard', enabled: true },
                { key: 'maxOpenRisk', cat: 'Risk', label: 'Max open risk', op: '≤', threshold: 50, unit: '$', severity: 'Hard', enabled: true },
                { key: 'cooldown', cat: 'Behavior', label: 'Cooldown after loss', op: '≥', threshold: 15, unit: 'min', severity: 'Soft', enabled: true }
            ]
        }, 'Initial release'));
        ConfigVersions.push(cv('cv_rs_exec_v10', 'RuleSet', 'rs-exec', 'v1.0', '2026-07-20T00:00:00', {
            rules: [
                { key: 'stopRequired', cat: 'Execution', label: 'Stop loss required', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'minRR', cat: 'Execution', label: 'Minimum risk/reward', op: '≥', threshold: 1.5, unit: 'R', severity: 'Soft', enabled: true },
                { key: 'noRevenge', cat: 'Behavior', label: 'No revenge entry after loss', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'noAddLoser', cat: 'Behavior', label: 'No adding to a loser', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true }
            ]
        }, 'Initial release'));
        ConfigVersions.push(cv('cv_rs_evid_v1', 'RuleSet', 'rs-evidence', 'v1.0', '2026-05-15T00:00:00', {
            rules: [
                { key: 'screenshot', cat: 'Evidence', label: 'Chart screenshot required', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true },
                { key: 'preTradeNote', cat: 'Evidence', label: 'Pre-trade note required', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true },
                { key: 'endOfDayReview', cat: 'Review', label: 'End-of-day review after breach', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true }
            ]
        }, 'Initial release'));

        // the most recent N trades from the deterministic demo generator —
        // internally consistent: wins/losses, sessions, instruments, R ranges,
        // emotions, risk levels and some discipline deviations
        seedFromDemo(accId, n);
        backfillEvaluations();
        enrichAllDerived();
        setSelectedAccount(accId);
        persist();
        console.log('[31trades] demo account seeded — ' + Trades.length + ' trades, ' + Accounts.length + ' accounts, ' + StrategyMaster.length + ' strategies');
        return { trades: Trades.length, accounts: Accounts.length, strategies: StrategyMaster.length };
    }

    // ------------------------------------------------------------------
    // 10. SHARED SERVICES — the single calculation core. Every page AND every
    //     API endpoint reads these. No screen maintains its own totals.
    //     (Risk, Discipline, Analytics, Calendar, Insights all derive from
    //     the canonical ledger + configuration via these functions.)
    // ------------------------------------------------------------------

    // ---- generic immutable-version resolution (any entity, as-of a date) ----
    function configVersionActiveAt(entityType, entityId, date) {
        return ConfigVersions
            .filter(c2 => c2.entity_type === entityType && c2.entity_id === entityId && new Date(c2.created_at) <= date)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    }

    const dayKey = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

    function dayTrades(accountId, date, extra) {
        const list = Trades.filter(t => t.account_id === accountId && sameDay(t.ts, date));
        if (extra) list.push(extra);
        return list;
    }
    function lastTradeBefore(accountId, date) {
        let best = null;
        Trades.forEach(t => {
            if (t.account_id === accountId && new Date(t.ts) < new Date(date) && (!best || t.ts > best.ts)) best = t;
        });
        return best;
    }

    // ---- rule-set provisioning: every account gets the standard rule sets so
    // the Rule Engine evaluates from the very first trade. The numeric limit
    // evaluators read the account policy directly, so these only supply
    // enabled/severity/priority — the policy stays the single source of truth.
    function ensureDefaultRuleSets(accountId) {
        if (RuleSetMaster.length) return;
        const pol = activePolicy(accountId);
        const v = pol ? pol.values : {};
        RuleSetMaster.push({ id: 'rs-core', name: 'Core Risk Set', scope: 'Accounts' });
        RuleSetMaster.push({ id: 'rs-exec', name: 'Execution Discipline', scope: 'Strategies' });
        RuleSetMaster.push({ id: 'rs-evidence', name: 'Evidence & Review', scope: 'Global' });
        ConfigVersions.push(cv('cv_rs_core_v1', 'RuleSet', 'rs-core', 'v1.0', nowISO(), {
            rules: [
                { key: 'riskPerTrade', cat: 'Risk', label: 'Max risk per trade', op: '≤', threshold: v.riskPerTrade || 25, unit: '$', severity: 'Hard', enabled: true },
                { key: 'dailyRisk', cat: 'Risk', label: 'Max daily risk', op: '≤', threshold: v.maxDailyRisk || v.maxDailyLoss || 100, unit: '$', severity: 'Hard', enabled: true },
                { key: 'dailyLoss', cat: 'Risk', label: 'Max daily loss', op: '≤', threshold: v.maxDailyLoss || 100, unit: '$', severity: 'Hard', enabled: true },
                { key: 'maxTrades', cat: 'Frequency', label: 'Max trades per day', op: '≤', threshold: v.maxTrades || 3, unit: '', severity: 'Hard', enabled: true },
                { key: 'maxOpenRisk', cat: 'Risk', label: 'Max open risk', op: '≤', threshold: v.maxOpenRisk || 50, unit: '$', severity: 'Hard', enabled: true },
                { key: 'cooldown', cat: 'Behavior', label: 'Cooldown after loss', op: '≥', threshold: 15, unit: 'min', severity: 'Soft', enabled: true }
            ]
        }, 'Provisioned with account'));
        ConfigVersions.push(cv('cv_rs_exec_v10', 'RuleSet', 'rs-exec', 'v1.0', nowISO(), {
            rules: [
                { key: 'stopRequired', cat: 'Execution', label: 'Stop loss required', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'minRR', cat: 'Execution', label: 'Minimum risk/reward', op: '≥', threshold: 1.5, unit: 'R', severity: 'Soft', enabled: true },
                { key: 'noRevenge', cat: 'Behavior', label: 'No revenge entry after loss', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true },
                { key: 'noAddLoser', cat: 'Behavior', label: 'No adding to a loser', op: '=', threshold: 'Yes', unit: '', severity: 'Hard', enabled: true }
            ]
        }, 'Provisioned with account'));
        ConfigVersions.push(cv('cv_rs_evid_v1', 'RuleSet', 'rs-evidence', 'v1.0', nowISO(), {
            rules: [
                { key: 'screenshot', cat: 'Evidence', label: 'Chart screenshot required', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true },
                { key: 'preTradeNote', cat: 'Evidence', label: 'Pre-trade note required', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true },
                { key: 'endOfDayReview', cat: 'Review', label: 'End-of-day review after breach', op: '=', threshold: 'Yes', unit: '', severity: 'Soft', enabled: true }
            ]
        }, 'Provisioned with account'));
        TradeMindBus.publish('config.changed', { provisioned: true });
    }

    // ---- THE RULE ENGINE: one evaluator per rule key, one pass over rules ----
    const RULE_EVALUATORS = {
        riskPerTrade: (t, ctx) => {
            const lim = ctx.policy.values.riskPerTrade || 25;   // fallback matches rule-set provisioning
            return { expected: '$' + lim, actual: '$' + t.risk, pass: t.risk <= lim };
        },
        dailyRisk: (t, ctx) => {
            const used = dayTrades(t.account_id, t.ts, ctx.inLedger ? null : t).reduce((s, x) => s + (x.risk || 0), 0);
            const lim = ctx.policy.values.maxDailyRisk || ctx.policy.values.maxDailyLoss || Infinity;
            return { expected: '$' + lim, actual: '$' + used, pass: used <= lim };
        },
        dailyLoss: (t, ctx) => {
            const used = Math.abs(dayTrades(t.account_id, t.ts, ctx.inLedger ? null : t).filter(x => x.pnl < 0).reduce((s, x) => s + x.pnl, 0));
            const lim = ctx.policy.values.maxDailyLoss || Infinity;
            return { expected: '$' + lim, actual: '$' + used, pass: used <= lim };
        },
        maxTrades: (t, ctx) => {
            const n = dayTrades(t.account_id, t.ts, ctx.inLedger ? null : t).length;
            const lim = ctx.policy.values.maxTrades || Infinity;
            return { expected: lim, actual: n, pass: n <= lim };
        },
        maxOpenRisk: (t, ctx) => ({ expected: '$' + (ctx.policy.values.maxOpenRisk || 0), actual: '—', pass: true, skip: true }),
        cooldown: (t, ctx) => {
            const prev = lastTradeBefore(t.account_id, t.ts);
            if (!prev || prev.pnl >= 0) return { expected: '0 min', actual: '—', pass: true, skip: true };
            const min = Math.round((new Date(t.ts) - new Date(prev.ts)) / 60000);
            const lim = ctx.policy.values.cooldown || 0;
            return { expected: lim + ' min', actual: min + ' min', pass: min >= lim };
        },
        stopRequired: (t) => {
            if (t.stop === undefined && !(t.evidence && t.evidence.screenshot)) return { expected: 'Yes', actual: 'Not captured', pass: true, skip: true };
            return { expected: 'Yes', actual: t.stop ? 'Yes' : 'No', pass: !!t.stop };
        },
        minRR: (t, ctx) => {
            const min = Number((ctx.strategyVersion && ctx.strategyVersion.values.risk && ctx.strategyVersion.values.risk.minRR) || 1.5);
            let rr = t.rr;
            if (rr == null && t.entry && t.stop && t.tp) {
                const denom = Math.abs(t.entry - t.stop);
                rr = denom ? Math.abs(t.tp - t.entry) / denom : 0;
            }
            if (rr == null && t.risk) rr = Math.abs(t.pnl) / t.risk;
            const val = rr == null ? 0 : Math.round(rr * 10) / 10;
            return { expected: min + 'R', actual: val + 'R', pass: rr != null && rr >= min };
        },
        noRevenge: (t) => ({ expected: 'No', actual: t.emotion === 'Revenge' ? 'Yes' : 'No', pass: t.emotion !== 'Revenge' }),
        noFomo: (t) => ({ expected: 'No', actual: t.emotion === 'FOMO' ? 'Yes' : 'No', pass: t.emotion !== 'FOMO' }),
        noAddLoser: (t) => ({ expected: 'No', actual: t.addedToLoser ? 'Yes' : 'No', pass: !t.addedToLoser }),
        allowedSessions: (t, ctx) => {
            const allowed = ctx.strategyVersion ? ctx.strategyVersion.values.sessions : null;
            if (!allowed || !allowed.length) return { expected: 'Any', actual: t.session, pass: true, skip: true };
            return { expected: allowed.join(' / '), actual: t.session, pass: allowed.indexOf(t.session) !== -1 };
        },
        approvedSetups: (t, ctx) => {
            const setups = String((ctx.strategyVersion && ctx.strategyVersion.values.setup) || '').split(',').map(s => s.trim()).filter(Boolean);
            if (!setups.length) return { expected: 'Any', actual: t.setup, pass: true, skip: true };
            return { expected: setups.join(' / '), actual: t.setup, pass: setups.indexOf(t.setup) !== -1 };
        },
        earlyExit: (t) => ({ expected: 'No early exit', actual: t.adherence === 'early exit' ? 'Yes' : 'No', pass: t.adherence !== 'early exit' }),
        movingStop: (t) => ({ expected: 'No moving stop', actual: t.adherence === 'moving stop' ? 'Yes' : 'No', pass: t.adherence !== 'moving stop' }),
        screenshot: (t) => ({ expected: 'Attached', actual: (t.evidence && t.evidence.screenshot) ? 'Attached' : 'Missing', pass: !!(t.evidence && t.evidence.screenshot) }),
        preTradeNote: (t) => ({ expected: 'Written', actual: t.note ? 'Written' : 'Missing', pass: !!t.note }),
        endOfDayReview: (t) => ({ expected: 'Done', actual: t.reviewed ? 'Done' : 'Pending', pass: !!t.reviewed })
    };

    const BLOCKING_KEYS = ['riskPerTrade', 'dailyRisk', 'dailyLoss', 'maxTrades', 'maxOpenRisk'];

    // Evaluate every enabled rule for a trade (or a draft), against the policy
    // + strategy versions active at its timestamp. Historical trades keep the
    // versions they were created under — changing a rule never rewrites them.
    function evaluateRules(opts) {
        const { accountId, trade, policyOverride, strategyVersionOverride, asOf } = opts || {};
        const account = Accounts.find(a => a.id === accountId);
        if (!account) throw new Error('unknown account ' + accountId);

        const policy = (trade && trade.config_version_id)
            ? (ConfigVersions.find(v => v.id === trade.config_version_id) || activePolicy(accountId))
            : (policyOverride || activePolicy(accountId));
        const strategyVersion = (trade && trade.strategy_version_id)
            ? ConfigVersions.find(v => v.id === trade.strategy_version_id)
            : (strategyVersionOverride || null);
        const asOfDate = asOf ? new Date(asOf) : (trade ? new Date(trade.ts) : new Date());
        const ctx = { account, policy, strategyVersion, inLedger: !!(trade && Trades.some(x => x.id === trade.id)) };

        const results = [];
        RuleSetMaster.forEach(master => {
            const rsVersion = configVersionActiveAt('RuleSet', master.id, asOfDate);
            if (!rsVersion) return;
            (rsVersion.values.rules || []).forEach(rule => {
                if (!rule.enabled) return;
                const fn = RULE_EVALUATORS[rule.key];
                if (!fn) return;
                let r;
                try { r = fn(trade, ctx); } catch (e) { return; }
                if (!r) return;
                const state = r.skip ? 'SKIP' : (r.pass ? 'PASS' : 'FAIL');
                results.push({
                    ruleId: rsVersion.id, ruleKey: rule.key, ruleLabel: rule.label,
                    ruleVersion: rsVersion.version, category: rule.cat, severity: rule.severity,
                    expected: r.expected, actual: r.actual, state,
                    explanation: state === 'FAIL'
                        ? rule.label + ': expected ' + r.expected + ', actual ' + r.actual
                        : (state === 'PASS' ? rule.label + ': ' + r.actual + ' ✓' : rule.label + ': not evaluated')
                });
            });
        });
        return results;
    }

    // ---- evaluation + violation audit records ----
    function clearEvaluations(tradeId) {
        TradeEvaluations.filter(e => e.tradeId === tradeId).forEach(e => {
            const i = TradeEvaluations.indexOf(e); if (i >= 0) TradeEvaluations.splice(i, 1);
        });
        Violations.filter(v => v.tradeId === tradeId).forEach(v => {
            const i = Violations.indexOf(v); if (i >= 0) Violations.splice(i, 1);
        });
    }
    function writeEvaluations(trade, evals) {
        clearEvaluations(trade.id);
        (evals || []).forEach(e => TradeEvaluations.push({
            id: uid('eval'), tradeId: trade.id, account_id: trade.account_id,
            ruleId: e.ruleId, ruleKey: e.ruleKey, ruleLabel: e.ruleLabel,
            ruleVersion: e.ruleVersion, category: e.category, severity: e.severity,
            expected: e.expected, actual: e.actual, state: e.state, explanation: e.explanation,
            evaluatedAt: nowISO()
        }));
        evals.filter(e => e.state === 'FAIL' && e.severity === 'Hard').forEach(e => Violations.push({
            id: uid('viol'), tradeId: trade.id, account_id: trade.account_id,
            ruleKey: e.ruleKey, ruleLabel: e.ruleLabel, ruleVersion: e.ruleVersion,
            severity: e.severity, expected: e.expected, actual: e.actual, explanation: e.explanation,
            pnl: trade.pnl, r: trade.r, reviewState: 'open', ts: trade.ts, createdAt: nowISO()
        }));
        return evals;
    }

    // ---- RISK SERVICE (RiskSnapshot: the single live risk state) ----
    function riskState(accountId) {
        const account = Accounts.find(a => a.id === accountId);
        if (!account) throw new Error('unknown account ' + accountId);
        const policy = activePolicy(accountId);
        const v = policy ? policy.values : {};
        const dailyRisk = v.maxDailyRisk || v.maxDailyLoss || 0;
        const lossLimit = v.maxDailyLoss || 0;
        const ddLimit = v.maxTotalDrawdown || 0;
        const riskPerTrade = v.riskPerTrade || 0;
        const maxTrades = v.maxTrades || Infinity;

        const accountTrades = Trades.filter(t => t.account_id === accountId);
        const today = startOfDay(new Date());
        const day = accountTrades.filter(t => sameDay(t.ts, today));
        const riskUsed = day.reduce((s, t) => s + (t.risk || 0), 0);
        const lossUsed = Math.abs(day.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));

        // drawdown from the realized equity curve (same math everywhere)
        let eq = account.starting_balance, peak = account.starting_balance, maxDD = 0;
        accountTrades.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts)).forEach(t => {
            eq += t.pnl;
            peak = Math.max(peak, eq);
            maxDD = Math.max(maxDD, peak - eq);
        });
        const currentDD = Math.max(0, peak - account.current_equity);
        const riskRemaining = Math.max(0, dailyRisk - riskUsed);
        const lossRemaining = Math.max(0, lossLimit - lossUsed);
        const drawdownRemaining = Math.max(0, ddLimit - currentDD);
        const maxAllowedRisk = Math.min(riskPerTrade || Infinity, riskRemaining, lossRemaining, drawdownRemaining, v.maxOpenRisk || Infinity);

        // status precedence: limit breached > high risk > caution > normal
        let status = 'NORMAL', label = 'SAFE';
        const warn = v.warn || [50, 70, 90];
        const riskPct = dailyRisk ? (riskUsed / dailyRisk) * 100 : 0;
        const ddPct = ddLimit ? (currentDD / ddLimit) * 100 : 0;
        if ((ddLimit && currentDD >= ddLimit) || (lossLimit && lossUsed >= lossLimit) || (dailyRisk && riskUsed >= dailyRisk)) {
            status = 'LIMIT'; label = 'LIMIT BREACHED';
        } else if (riskPct >= warn[2] || ddPct >= warn[2]) { status = 'HIGH'; label = 'HIGH RISK'; }
        else if (riskPct >= warn[0] || ddPct >= warn[0]) { status = 'CAUTION'; label = 'CAUTION'; }

        return {
            account_id: accountId, currency: account.currency,
            policyVersion: policy ? policy.id : null,
            equity: account.current_equity, starting_balance: account.starting_balance,
            day: dayKey(today),
            dailyRiskBudget: dailyRisk, riskUsed: Math.round(riskUsed), riskRemaining: Math.round(riskRemaining),
            dailyLossLimit: lossLimit, lossUsed: Math.round(lossUsed), lossRemaining: Math.round(lossRemaining),
            tradeCount: day.length, maxTrades,
            currentDrawdown: Math.round(currentDD), maxDrawdown: Math.round(maxDD), drawdownLimit: ddLimit, drawdownRemaining: Math.round(drawdownRemaining),
            riskPerTradeLimit: riskPerTrade, maxOpenRiskLimit: v.maxOpenRisk || 0,
            maxAllowedRisk: Math.round(maxAllowedRisk), recommendedMaxRisk: Math.round(maxAllowedRisk),
            status, statusLabel: label
        };
    }

    // Pre-trade check — deterministic decision from the rule engine + risk state.
    // Returns a canonical contract: status (CLEAR/CAUTION/VIOLATION/BLOCKED) plus
    // the actual constraint headroom so every surface (Risk page, Journal ticket,
    // notifications, future AI) renders the exact same decision.
    function preTradeCheck(accountId, draft) {
        const account = Accounts.find(a => a.id === accountId);
        if (!account) throw new Error('unknown account ' + accountId);
        const t = { ...(draft || {}), account_id: accountId, ts: draft && draft.ts ? new Date(draft.ts) : new Date() };
        t.risk = draft && draft.risk != null ? draft.risk : (draft && draft.plannedRisk || 0);
        const assignment = activeAssignment(accountId, t.strategy_id);
        const policy = assignment ? ConfigVersions.find(v => v.id === assignment.policy_id) : activePolicy(accountId);
        const checks = evaluateRules({ accountId, trade: t, policyOverride: policy, strategyVersionOverride: assignment ? activeStrategyVersion(assignment.strategy_id) : null, asOf: new Date() });
        const rs = riskState(accountId);
        const fails = checks.filter(c => c.state === 'FAIL');
        const hard = fails.filter(c => c.severity === 'Hard');
        const soft = fails.filter(c => c.severity === 'Soft');
        const blocks = [];
        if (t.risk > rs.riskRemaining) blocks.push('Daily risk budget — only $' + rs.riskRemaining + ' remaining');
        if (t.risk > rs.lossRemaining) blocks.push('Daily loss budget — only $' + rs.lossRemaining + ' remaining');
        if (t.risk > rs.drawdownRemaining) blocks.push('Drawdown buffer — only $' + rs.drawdownRemaining + ' remaining');
        const state = blocks.length ? 'BLOCKED' : hard.length ? 'VIOLATION' : soft.length ? 'CAUTION' : 'CLEAR';
        return {
            account_id: accountId, state, status: state,
            riskRequested: t.risk,
            riskRemaining: rs.riskRemaining, lossRemaining: rs.lossRemaining,
            drawdownRemaining: rs.drawdownRemaining, maxAllowedRisk: rs.maxAllowedRisk,
            recommended_max_risk: rs.recommendedMaxRisk,
            checks,
            blocking_rules: [...hard.map(c => c.explanation), ...blocks],
            warnings: soft.map(c => c.explanation),
            violations: hard.map(c => c.explanation),
            blocks
        };
    }

    // Risk events — derived deterministically from the canonical ledger + policy
    // (same math as riskState), listed newest-first. Nothing is persisted here,
    // so re-deriving on every page load never duplicates events. Every event
    // carries an optional trade_id for deep-linking into the Journal.
    function riskEvents(accountId, opts) {
        const account = Accounts.find(a => a.id === accountId);
        if (!account) return [];
        const policy = activePolicy(accountId);
        const v = policy ? policy.values : {};
        const limRisk = v.maxDailyRisk || v.maxDailyLoss || 0;
        const limLoss = v.maxDailyLoss || 0;
        const limDD = v.maxTotalDrawdown || 0;
        const limTrade = v.riskPerTrade || 0;
        const warn = v.warn || [50, 70, 90];

        const list = Trades
            .filter(t => t.account_id === accountId)
            .slice()
            .sort((a, b) => new Date(a.ts) - new Date(b.ts));
        const days = {};
        list.forEach(t => {
            const k = dayKey(new Date(t.ts));
            (days[k] = days[k] || []).push(t);
        });

        const events = [];
        // drawdown track across the whole ledger (peak-to-current, same as riskState)
        let eq = account.starting_balance, peak = account.starting_balance, maxDD = 0, curDD = 0;
        const dayKeys = Object.keys(days).sort();
        dayKeys.forEach(k => {
            const g = days[k];
            const risk = g.reduce((s, t) => s + (t.risk || 0), 0);
            const loss = Math.abs(g.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
            const riskPct = limRisk ? (risk / limRisk) * 100 : 0;
            if (limRisk && risk > limRisk) {
                events.push({ at: g[g.length - 1].ts, day: k, type: 'risk-breach', severity: 'critical',
                    detail: 'Risk used $' + risk + ' > $' + limRisk + ' daily budget', trade_ids: g.map(t => t.id) });
            } else if (limRisk && riskPct >= warn[0]) {
                events.push({ at: g[g.length - 1].ts, day: k, type: riskPct >= warn[2] ? 'high-risk' : 'risk-warning',
                    severity: riskPct >= warn[2] ? 'warning' : 'info',
                    detail: 'Risk used $' + risk + ' (' + Math.round(riskPct) + '% of budget)', trade_ids: g.map(t => t.id) });
            }
            if (limLoss && loss > limLoss) {
                events.push({ at: g[g.length - 1].ts, day: k, type: 'loss-breach', severity: 'critical',
                    detail: 'Realized loss $' + loss + ' > $' + limLoss + ' daily loss limit', trade_ids: g.map(t => t.id) });
            }
            // end-of-day drawdown vs the running peak
            g.forEach(t => { eq += (t.pnl || 0); if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); curDD = Math.max(0, peak - eq); });
            if (limDD && curDD >= limDD) {
                events.push({ at: g[g.length - 1].ts, day: k, type: 'drawdown-breach', severity: 'critical',
                    detail: 'Drawdown $' + Math.round(curDD) + ' ≥ $' + limDD + ' limit', trade_ids: g.map(t => t.id) });
            }
            // per-trade spikes + policy blocks (deep-link into the Journal)
            g.forEach(t => {
                if (limTrade && t.risk > limTrade * 1.5) {
                    events.push({ at: t.ts, day: k, type: 'risk-spike', severity: 'warning',
                        detail: t.symbol + ' risked $' + t.risk + ' vs $' + limTrade + ' per-trade limit', trade_id: t.id });
                }
                if (t.adherence_result === 'BLOCK') {
                    events.push({ at: t.ts, day: k, type: 'block', severity: 'high',
                        detail: (t.block_reason || 'Rule engine rejected this trade') + ' · ' + t.symbol, trade_id: t.id });
                }
            });
        });

        const limit = (opts && opts.limit) || 20;
        return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
    }

    // ---- DISCIPLINE SERVICE (process score, not profitability) ----
    const DISC_DIMS = [
        { key: 'risk', label: 'Risk', weight: 0.25, rules: ['riskPerTrade', 'dailyRisk', 'dailyLoss', 'maxOpenRisk'] },
        { key: 'strategy', label: 'Strategy', weight: 0.20, rules: ['allowedSessions', 'approvedSetups', 'minRR', 'stopRequired'] },
        { key: 'execution', label: 'Execution', weight: 0.20, rules: ['earlyExit', 'movingStop', 'stopRequired'] },
        { key: 'frequency', label: 'Frequency', weight: 0.15, rules: ['maxTrades', 'cooldown'] },
        { key: 'session', label: 'Session', weight: 0.10, rules: ['allowedSessions'] },
        { key: 'behavior', label: 'Behavior', weight: 0.10, rules: ['noRevenge', 'noFomo', 'noAddLoser', 'cooldown'] }
    ];

    function disciplineState(accountId, opts) {
        const from = opts && opts.from ? new Date(opts.from) : null;
        const to = opts && opts.to ? new Date(opts.to) : null;
        const trades = Trades
            .filter(t => t.account_id === accountId)
            .filter(t => !from || new Date(t.ts) >= from)
            .filter(t => !to || new Date(t.ts) <= to);
        const evaluations = trades.map(t => ({ trade: t, rules: evaluateRules({ accountId, trade: t }).filter(r => r.state !== 'SKIP') }));

        const dims = DISC_DIMS.map(d => {
            const evs = evaluations.flatMap(e => e.rules.filter(r => d.rules.indexOf(r.ruleKey) !== -1));
            const passed = evs.filter(r => r.state === 'PASS').length;
            return { key: d.key, label: d.label, weight: d.weight, score: evs.length ? Math.round((passed / evs.length) * 100) : null, passed, total: evs.length };
        });
        const scored = dims.filter(d => d.score != null);
        const score = scored.length
            ? Math.round(scored.reduce((s, d) => s + d.weight * d.score, 0) / scored.reduce((s, d) => s + d.weight, 0))
            : null;

        const ruleStats = {};
        evaluations.forEach(e => e.rules.forEach(r => {
            (ruleStats[r.ruleKey] = ruleStats[r.ruleKey] || { key: r.ruleKey, label: r.ruleLabel, passed: 0, total: 0 });
            ruleStats[r.ruleKey].total++;
            if (r.state === 'PASS') ruleStats[r.ruleKey].passed++;
        }));
        const rules = Object.values(ruleStats).map(r => ({ ...r, rate: r.total ? Math.round((r.passed / r.total) * 100) : 0 })).sort((a, b) => b.rate - a.rate);

        const days = {};
        trades.forEach(t => { (days[dayKey(t.ts)] = days[dayKey(t.ts)] || []).push(t); });
        let streak = 0, bestStreak = 0;
        Object.keys(days).sort().forEach(k => {
            const hasHardFail = days[k].some(t => (evaluations.find(e => e.trade === t) || { rules: [] }).rules.some(r => r.state === 'FAIL' && r.severity === 'Hard'));
            if (hasHardFail) streak = 0; else { streak++; bestStreak = Math.max(bestStreak, streak); }
        });
        return {
            account_id: accountId,
            score, dims, rules,
            violations: Violations.filter(v => v.account_id === accountId && (!from || new Date(v.ts) >= from) && (!to || new Date(v.ts) <= to)).length,
            cleanDayStreak: streak, bestCleanDayStreak: bestStreak,
            strongest: rules[0] || null, weakest: rules[rules.length - 1] || null,
            sample: trades.length
        };
    }

    // ---- ANALYTICS SERVICE (one implementation for every analytics endpoint) ----
    function computeAnalytics(list) {
        const n = list.length;
        const wins = list.filter(t => t.pnl > 0);
        const losses = list.filter(t => t.pnl < 0);
        const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const net = list.reduce((s, t) => s + t.pnl, 0);
        const sorted = list.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
        let eq = 0, peak = 0, maxDD = 0, minEq = Infinity, maxEq = -Infinity;
        const curve = sorted.map(t => {
            eq += t.pnl;
            peak = Math.max(peak, eq);
            maxDD = Math.max(maxDD, peak - eq);
            maxEq = Math.max(maxEq, eq); minEq = Math.min(minEq, eq);
            return { ts: t.ts, equity: Math.round(eq * 100) / 100 };
        });
        const by = key => {
            const m = {};
            list.forEach(t => { const k = key(t); (m[k] = m[k] || []).push(t); });
            return Object.keys(m).map(k => {
                const g = m[k];
                const gw = g.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
                const gl = Math.abs(g.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
                return { key: k, n: g.length, pnl: g.reduce((s, t) => s + t.pnl, 0), winRate: g.length ? g.filter(t => t.pnl > 0).length / g.length : 0, avgR: g.reduce((s, t) => s + t.r, 0) / g.length, pf: gl ? gw / gl : (gw ? 3 : 0) };
            }).sort((a, b) => b.pnl - a.pnl);
        };
        let cur = 0, bestWin = 0, bestLoss = 0;
        sorted.forEach(t => {
            if (t.pnl > 0) { cur = cur > 0 ? cur + 1 : 1; bestWin = Math.max(bestWin, cur); }
            else if (t.pnl < 0) { cur = cur < 0 ? cur - 1 : -1; bestLoss = Math.min(bestLoss, cur); }
            else cur = 0;
        });
        const buckets = {};
        list.forEach(t => {
            const b = t.risk <= 20 ? '$0–20' : t.risk <= 35 ? '$21–35' : t.risk <= 50 ? '$36–50' : '$50+';
            (buckets[b] = buckets[b] || []).push(t);
        });
        const byRisk = Object.keys(buckets).map(k => {
            const g = buckets[k];
            return { key: k, n: g.length, pnl: g.reduce((s, t) => s + t.pnl, 0), winRate: g.filter(t => t.pnl > 0).length / g.length, avgR: g.reduce((s, t) => s + t.r, 0) / g.length };
        }).sort((a, b) => a.key.localeCompare(b.key));
        return {
            n, net: Math.round(net), grossWin: Math.round(grossWin), grossLoss: Math.round(grossLoss),
            winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
            avgWin: wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
            avgLoss: losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
            avgTrade: n ? net / n : 0, avgR: n ? list.reduce((s, t) => s + t.r, 0) / n : 0,
            expectancy: n ? list.reduce((s, t) => s + t.r, 0) / n : 0,
            pf: grossLoss ? grossWin / grossLoss : (wins.length ? 3 : 0),
            maxDD: Math.round(maxDD), recovery: maxDD ? net / maxDD : 0, avgRisk: n ? list.reduce((s, t) => s + (t.risk || 0), 0) / n : 0,
            curve, byStrategy: by(t => t.strategy_id), bySetup: by(t => t.setup), bySymbol: by(t => t.symbol),
            bySession: by(t => t.session), byDirection: by(t => t.dir), byRisk,
            streaks: { bestWin, bestLoss: Math.abs(bestLoss) },
            maxEq: Math.round(maxEq), minEq: Math.round(minEq)
        };
    }

    function analytics(accountId, filters) {
        const f = filters || {};
        let list = Trades.filter(t => t.account_id === accountId);
        if (f.symbol) list = list.filter(t => t.symbol === f.symbol);
        if (f.setup) list = list.filter(t => t.setup === f.setup);
        if (f.session) list = list.filter(t => t.session === f.session);
        if (f.direction) list = list.filter(t => t.dir === f.direction);
        if (f.result) list = list.filter(t => f.result === 'win' ? t.pnl > 0 : f.result === 'loss' ? t.pnl < 0 : t.pnl === 0);
        if (f.emotion) list = list.filter(t => t.emotion === f.emotion);
        if (f.adherence) list = list.filter(t => t.adherence === f.adherence);
        if (f.from) list = list.filter(t => new Date(t.ts) >= new Date(f.from));
        if (f.to) list = list.filter(t => new Date(t.ts) <= new Date(f.to));
        return computeAnalytics(list);
    }

    // ---- CALENDAR SERVICE (daily read model — never manually edited) ----
    function calendarMonth(accountId, year, month) {
        const t0 = new Date(year, month, 1);
        const t1 = new Date(year, month + 1, 1);
        const trades = Trades.filter(t => t.account_id === accountId && new Date(t.ts) >= t0 && new Date(t.ts) < t1);
        const byDay = {};
        trades.forEach(t => { const k = new Date(t.ts).getDate(); (byDay[k] = byDay[k] || []).push(t); });
        const days = Object.keys(byDay).map(d => {
            const g = byDay[d];
            const pnl = g.reduce((s, t) => s + t.pnl, 0);
            const wins = g.filter(t => t.pnl > 0).length;
            const evs = g.flatMap(t => evaluateRules({ accountId, trade: t }));
            const pass = evs.filter(e => e.state === 'PASS').length;
            return {
                day: Number(d), date: dayKey(g[0].ts),
                pnl: Math.round(pnl), trades: g.length, wins, losses: g.length - wins,
                avgR: Math.round((g.reduce((s, t) => s + t.r, 0) / g.length) * 100) / 100,
                riskConsumed: g.reduce((s, t) => s + (t.risk || 0), 0),
                disciplineScore: evs.length ? Math.round((pass / evs.length) * 100) : null,
                violations: Violations.filter(v => v.account_id === accountId && sameDay(v.ts, g[0].ts)).length,
                list: g
            };
        }).sort((a, b) => a.day - b.day);
        const totalPnl = days.reduce((s, d) => s + d.pnl, 0);
        const totalTrades = days.reduce((s, d) => s + d.trades, 0);
        const winDays = days.filter(d => d.pnl > 0).length;
        const lossDays = days.filter(d => d.pnl < 0).length;
        const totalWins = days.reduce((s, d) => s + (d.wins || 0), 0);
        const totalLosses = days.reduce((s, d) => s + (d.losses || 0), 0);
        const totalViol = days.reduce((s, d) => s + (d.violations || 0), 0);
        const totalR = days.reduce((s, d) => s + ((d.avgR || 0) * (d.trades || 0)), 0);
        const avgR = totalTrades ? (totalR / totalTrades) : 0;
        const winRate = (totalWins + totalLosses) ? (totalWins / (totalWins + totalLosses)) : 0;
        const totals = {
            trades: totalTrades, wins: totalWins, losses: totalLosses, pnl: totalPnl,
            winRate, avgR, violations: totalViol, daysTraded: days.length, winDays, lossDays
        };
        return {
            year, month, days,
            totalPnl, totalTrades, winDays, lossDays, totals
        };
    }

    // ---- INSIGHT SERVICE (evidence-backed findings; never manufactured) ----
    function insights(accountId) {
        const a = analytics(accountId, {});
        const out = [];
        const push = (type, severity, title, detail, evidence, confidence) => {
            out.push({ id: uid('ins'), period: 'all', type, severity, title, detail, evidence, sample: evidence.length, confidence, status: 'open' });
        };
        if (a.n < 10) {
            out.push({ id: 'ins-developing', period: 'all', type: 'developing', severity: 'neutral', title: 'Developing — insufficient evidence', detail: 'Log at least 10 trades to unlock evidence-backed findings. Currently ' + a.n + '.', evidence: [], sample: a.n, confidence: 0, status: 'open' });
            return out;
        }
        const list = Trades.filter(t => t.account_id === accountId);
        const bySetup = a.bySetup[0];
        if (bySetup && bySetup.n >= 8) {
            const ev = list.filter(t => t.setup === bySetup.key).map(t => t.id);
            push('strength', 'positive', 'Strongest setup', bySetup.key + ' — ' + Math.round(bySetup.winRate * 100) + '% win rate, ' + bySetup.pnl + '$ net across ' + bySetup.n + ' trades', ev, 'high');
        }
        const bySession = a.bySession[0];
        if (bySession && bySession.n >= 8) {
            const ev = list.filter(t => t.session === bySession.key).map(t => t.id);
            push('strength', 'positive', 'Strongest session', bySession.key + ' — ' + bySession.pnl + '$ net across ' + bySession.n + ' trades', ev, 'high');
        }
        const bySym = a.bySymbol[0];
        if (bySym && bySym.n >= 8) {
            const ev = list.filter(t => t.symbol === bySym.key).map(t => t.id);
            push('strength', 'positive', 'Strongest instrument', bySym.key + ' — ' + bySym.pnl + '$ net across ' + bySym.n + ' trades', ev, 'high');
        }
        const emotional = list.filter(t => t.emotion === 'FOMO' || t.emotion === 'Revenge');
        if (emotional.length >= 3) {
            const cost = emotional.reduce((s, t) => s + t.pnl, 0);
            push('risk', 'negative', 'Emotional entries are costly', emotional.length + ' FOMO/revenge trades — ' + (cost >= 0 ? '+' : '') + cost + '$ net', emotional.map(t => t.id), 'high');
        }
        const afterLoss = list.filter((t, i) => i > 0 && list[i - 1].pnl < 0);
        const baselineRisk = a.avgRisk || 0;
        if (afterLoss.length >= 5) {
            const avgAfter = afterLoss.reduce((s, t) => s + (t.risk || 0), 0) / afterLoss.length;
            if (avgAfter > baselineRisk * 1.1) push('risk', 'negative', 'Risk escalates after losses', 'Average risk after a loss is $' + Math.round(avgAfter) + ' vs $' + Math.round(baselineRisk) + ' baseline', afterLoss.map(t => t.id), 'medium');
        }
        const violCost = Violations.filter(v => v.account_id === accountId).reduce((s, v) => s + (v.pnl || 0), 0);
        if (Violations.filter(v => v.account_id === accountId).length >= 5) {
            push('risk', 'negative', 'Rule breaks cost real money', Violations.filter(v => v.account_id === accountId).length + ' hard-rule violations — ' + (violCost >= 0 ? '+' : '') + violCost + '$ net', [...new Set(Violations.filter(v => v.account_id === accountId).map(v => v.tradeId))], 'high');
        }
        return out;
    }

    // ---- TRADE SERVICE (create / edit / delete with full recalculation) ----
    const TradeService = {
        create: logTradePipeline,
        update(tradeId, fields) {
            const t = Trades.find(x => x.id === tradeId);
            if (!t) throw new Error('unknown trade ' + tradeId);
            const oldPnl = t.pnl;
            const changes = [];
            ['symbol', 'dir', 'setup', 'session', 'emotion', 'adherence', 'entry', 'exit', 'size', 'risk', 'pnl', 'note', 'reviewed', 'stop', 'tp'].forEach(k => {
                if (fields[k] !== undefined && fields[k] !== null) {
                    if (String(t[k]) !== String(fields[k])) changes.push(k + ': ' + t[k] + ' → ' + fields[k]);
                    t[k] = fields[k];
                }
            });
            if (fields.ts !== undefined && fields.ts !== null) {
                const d = new Date(fields.ts);
                if (!isNaN(d.getTime())) { changes.push('time'); t.ts = d; }
            }
            if (t.risk > 0) t.r = Math.round((t.pnl / t.risk) * 100) / 100;
            const account = Accounts.find(x => x.id === t.account_id);
            if (account) account.current_equity += (t.pnl - oldPnl);
            // derived fields may have changed (ts moved, postLoss/delayMin of
            // following trades, equity from ledger) — recompute before re-evaluating
            enrichAllDerived();
            // re-evaluate against the SAME immutable versions (history preserved)
            const evals = evaluateRules({ accountId: t.account_id, trade: t });
            writeEvaluations(t, evals);
            const hard = evals.filter(e => e.state === 'FAIL' && e.severity === 'Hard');
            const block = hard.filter(e => BLOCKING_KEYS.indexOf(e.ruleKey) !== -1);
            t.adherence_result = hard.length ? (block.length ? 'BLOCK' : 'VIOLATION') : 'PASS';
            t.block_reason = hard.length ? hard.map(e => e.explanation).join('; ') : '';
            logEvent({ entity: 'Trade · ' + t.symbol, what: 'Edited', detail: changes.join('; ') || 'Trade updated', impact: 'Risk, discipline, analytics recalculated from canonical state' });
            TradeMindBus.publish('trade.updated', t);
            syncToBackend('/api/trades/' + tradeId, { fields }, 'PATCH');
            return t;
        },
        remove(tradeId) {
            const i = Trades.findIndex(x => x.id === tradeId);
            if (i < 0) throw new Error('unknown trade ' + tradeId);
            const t = Trades[i];
            const account = Accounts.find(x => x.id === t.account_id);
            if (account) account.current_equity -= t.pnl;
            Trades.splice(i, 1);
            clearEvaluations(tradeId);
            enrichAllDerived();   // recompute equity + postLoss/delayMin of the rest
            logEvent({ entity: 'Trade · ' + t.symbol, what: 'Deleted / reversed', detail: 'P&L $' + t.pnl + ' · risk $' + t.risk, impact: 'Equity, risk, discipline, analytics recalculated' });
            TradeMindBus.publish('trade.deleted', t);
            syncToBackend('/api/trades/' + tradeId, {}, 'DELETE');
            return t;
        },
        evaluationsFor(tradeId) {
            const stored = TradeEvaluations.filter(e => e.tradeId === tradeId);
            const t = Trades.find(x => x.id === tradeId);
            return stored.length ? stored : (t ? evaluateRules({ accountId: t.account_id, trade: t }) : []);
        }
    };

    // ---- REVIEWS SERVICE (daily / weekly / monthly — derived on demand from
    // the canonical discipline + analytics data; never stored independently) ----
    function dailyReview(accountId, date) {
        const d0 = startOfDay(date);
        const d1 = new Date(d0.getTime() + 864e5);
        const dayT = Trades.filter(t => t.account_id === accountId && new Date(t.ts) >= d0 && new Date(t.ts) < d1);
        const disc = disciplineState(accountId, { from: d0.toISOString(), to: d1.toISOString() });
        const fails = dayT.flatMap(t => evaluateRules({ accountId, trade: t })).filter(e => e.state === 'FAIL');
        const dayViol = Violations.filter(v => v.account_id === accountId && new Date(v.ts) >= d0 && new Date(v.ts) < d1);
        return {
            period: 'daily', date: dayKey(d0), trades: dayT.length,
            pnl: Math.round(dayT.reduce((s, t) => s + t.pnl, 0)),
            score: disc.score, dims: disc.dims,
            violations: dayViol.length,
            violation_breakdown: dayViol.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts)).map(v => ({
                rule: v.ruleLabel, expected: v.expected, actual: v.actual, pnl: v.pnl, r: v.r, tradeId: v.tradeId
            })),
            summary: dayT.length
                ? (fails.length ? fails.length + ' rule break' + (fails.length > 1 ? 's' : '') + ' across ' + dayT.length + ' trade' + (dayT.length > 1 ? 's' : '') : 'Clean day — all rules followed')
                : 'No trades this day',
            focus: disc.weakest ? 'Tighten: ' + disc.weakest.label : 'Keep the routine'
        };
    }

    function weeklyReview(accountId) {
        const to = new Date();
        const from = new Date(to.getTime() - 7 * 864e5);
        const disc = disciplineState(accountId, { from: from.toISOString(), to: to.toISOString() });
        const viol = Violations.filter(v => v.account_id === accountId && new Date(v.ts) >= from && new Date(v.ts) <= to);
        const byRule = {};
        viol.forEach(v => {
            (byRule[v.ruleKey] = byRule[v.ruleKey] || { rule: v.ruleLabel, count: 0, cost: 0 });
            byRule[v.ruleKey].count++;
            byRule[v.ruleKey].cost += (v.pnl || 0);
        });
        const ranking = Object.values(byRule).sort((a, b) => b.count - a.count);
        const costly = ranking.slice().sort((a, b) => a.cost - b.cost)[0];
        return {
            period: 'weekly', from: dayKey(from), to: dayKey(to),
            score: disc.score, dims: disc.dims,
            cleanDays: disc.cleanDayStreak, violations: disc.violations,
            most_frequent: ranking[0] ? ranking[0].rule : null,
            most_costly: costly && costly.count > 0 ? costly : null,
            focus: disc.weakest ? 'Focus: ' + disc.weakest.label : 'Consistency maintained'
        };
    }

    function monthlyReview(accountId) {
        const now = new Date();
        const t0 = new Date(now.getFullYear(), now.getMonth(), 1);
        const t1 = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const disc = disciplineState(accountId, { from: t0.toISOString(), to: t1.toISOString() });
        const a = analytics(accountId, { from: t0.toISOString(), to: t1.toISOString() });
        const scored = disc.dims.filter(d => d.score != null);
        const best = scored.slice().sort((x, y) => y.score - x.score)[0];
        const worst = scored.slice().sort((x, y) => x.score - y.score)[0];
        return {
            period: 'monthly', month: now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'),
            score: disc.score, dims: disc.dims,
            strongest_dim: best ? best.label : null, weakest_dim: worst ? worst.label : null,
            trades: a.n, netPnl: a.net, winRate: Math.round(a.winRate * 100),
            violations: disc.violations, cleanDayStreak: disc.cleanDayStreak
        };
    }

    function reviews(accountId, opts) {
        const p = (opts && opts.period) || 'all';
        const out = {};
        if (p === 'all' || p === 'daily') out.daily = dailyReview(accountId, (opts && opts.date) ? new Date(opts.date) : new Date());
        if (p === 'all' || p === 'weekly') out.weekly = weeklyReview(accountId);
        if (p === 'all' || p === 'monthly') out.monthly = monthlyReview(accountId);
        return out;
    }

    function completeReview(accountId, period, note) {
        logEvent({
            entity: 'Account · ' + ((Accounts.find(a => a.id === accountId) || {}).name || accountId),
            what: 'Review completed', detail: period + (note ? ' · ' + note : ''),
            impact: 'Weekly/monthly metrics updated'
        });
        TradeMindBus.publish('review.completed', { account_id: accountId, period, note });
        syncToBackend('/api/reviews/complete', { account_id: accountId, period, note });
        return { ok: true, period };
    }

    // ---- backfill: evaluation + violation audit for every historical trade.
    // Called by the server after it hydrates db.json (and after /api/reset);
    // the browser never needs it — it hydrates this state from the backend.
    function backfillEvaluations() {
        Trades.slice().forEach(t => {
            const evals = evaluateRules({ accountId: t.account_id, trade: t });
            writeEvaluations(t, evals);
            const hard = evals.filter(e => e.state === 'FAIL' && e.severity === 'Hard');
            const block = hard.filter(e => BLOCKING_KEYS.indexOf(e.ruleKey) !== -1);
            t.adherence_result = hard.length ? (block.length ? 'BLOCK' : 'VIOLATION') : 'PASS';
            t.block_reason = hard.length ? hard.map(e => e.explanation).join('; ') : '';
        });
    }

    return {
        EventBus, TradeMindBus,
        Accounts, ConfigVersions, StrategyAssignments, Trades,
        StrategyMaster, RuleSetMaster, TradeEvaluations, Violations,
        ConfigAPI,
        logTradePipeline, TradeService,
        evaluateRules, preTradeCheck, riskEvents,
        riskState, disciplineState, analytics, calendarMonth, insights,
        // the SAME analytics math, runnable over any trade-shaped list — the
        // practice/backtest and battle views feed it flattened simulated trades
        // so they share one canonical calculation instead of a parallel one.
        analyticsFrom: computeAnalytics,
        reviews, dailyReview, weeklyReview, monthlyReview, completeReview,
        backfillEvaluations,
        // convenience accessors (delegated to the ConfigAPI)
        activeAssignment, activePolicy, activeStrategyVersion, activeRuleSetVersion,
        strategiesFor, accountIdsForStrategy,
        getEventLog: () => EVENT_LOG,
        // ---- ASSET SPEC ENGINE (single source of truth for P&L / sizing / units) ----
        assetSpecFor, assetClassOf, contractValueOf, calcPnl, calcPositionSize,
        calcRiskDollars, calcRR, fmtPrice, ASSET_SPECS,
        bumpVer, nowStr, sameDay, dayKey,
        hydrate, reseed,
        // local-first storage & testing
        selectedAccountId: selectedAccount, setSelectedAccount,
        seedDemoAccount, serializeState, persist,
        connectBackend: env.connectBackend || function () { return Promise.resolve(true); },
        enrichAllDerived, emptyState,
    };
    };
});
