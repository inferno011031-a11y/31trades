'use strict';

const fs = require('fs');
const path = require('path');
const { createTradeMindCore } = require('./src/core/index.js');

const DB_FILE = path.join(__dirname, 'data', 'db-00000000-0000-0000-0000-000000000000.json');

// Deterministic PRNG
function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const rnd = mulberry32(42);

const STRATEGIES = [
    { id: 'strat-fvg', name: 'MSS + FVG Trend' },
    { id: 'strat-breakout', name: 'London Breakout' },
    { id: 'strat-ob', name: 'Order Block Reversal' },
    { id: 'strat-scalp', name: 'NY Open Momentum' }
];

const SYMBOLS = [
    { symbol: 'EURUSD', asset: 'Forex', basePrice: 1.0850, spread: 0.0001, pipVal: 10 },
    { symbol: 'GBPUSD', asset: 'Forex', basePrice: 1.2950, spread: 0.0002, pipVal: 10 },
    { symbol: 'XAUUSD', asset: 'Metals', basePrice: 2450.0, spread: 0.20, pipVal: 10 },
    { symbol: 'US30', asset: 'Indices', basePrice: 40500, spread: 2.0, pipVal: 1 },
    { symbol: 'NAS100', asset: 'Indices', basePrice: 19800, spread: 1.0, pipVal: 1 },
    { symbol: 'BTCUSD', asset: 'Crypto', basePrice: 64000, spread: 10.0, pipVal: 1 }
];

const EMOTIONS = ['Calm', 'Disciplined', 'Confident', 'Cautious', 'Anxious'];
const SESSIONS = ['London', 'New York', 'Asia'];

function generateSampleTrades() {
    let raw = {};
    if (fs.existsSync(DB_FILE)) {
        try { raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
    }

    const accountId = (raw.Accounts && raw.Accounts[0] && raw.Accounts[0].id) || 'acc-bule-graudian-5k-mteakzzq-00iqvx';
    let balance = 10000;
    const trades = [];
    const evaluations = [];
    const violations = [];
    const eventLog = raw.EVENT_LOG || [];

    // July 1, 2026 to August 29, 2026 (approx 60 calendar days)
    const startDate = new Date(2026, 6, 1, 9, 0, 0); // July 1, 2026
    const endDate = new Date(2026, 7, 29, 15, 0, 0);  // August 29, 2026

    let currentDate = new Date(startDate);
    let tradeCounter = 1;

    while (currentDate <= endDate) {
        const dow = currentDate.getDay();
        // Trade Monday through Friday
        if (dow !== 0 && dow !== 6) {
            // 1 to 3 trades per trading day
            const dayTradesCount = 1 + Math.floor(rnd() * 3);
            for (let i = 0; i < dayTradesCount; i++) {
                const symObj = SYMBOLS[Math.floor(rnd() * SYMBOLS.length)];
                const strat = STRATEGIES[Math.floor(rnd() * STRATEGIES.length)];
                const session = rnd() < 0.5 ? 'London' : (rnd() < 0.85 ? 'New York' : 'Asia');
                const side = rnd() > 0.5 ? 'BUY' : 'SELL';
                const emotion = EMOTIONS[Math.floor(rnd() * EMOTIONS.length)];

                // Set trade hour based on session
                const tradeTime = new Date(currentDate);
                const hourBase = session === 'London' ? 8 : (session === 'New York' ? 14 : 2);
                tradeTime.setHours(hourBase + Math.floor(rnd() * 3), Math.floor(rnd() * 59), 0, 0);

                const closeTime = new Date(tradeTime.getTime() + (15 + Math.floor(rnd() * 120)) * 60000);

                // Win rate ~ 62%
                const isWin = rnd() < 0.62;
                const riskAmount = 25 + Math.floor(rnd() * 20); // $25 - $45 risk per trade
                const rMultiple = isWin 
                    ? +(1.2 + rnd() * 2.3).toFixed(2)
                    : -(0.8 + rnd() * 0.4).toFixed(2);
                
                const pnl = +(rMultiple * riskAmount).toFixed(2);
                balance = +(balance + pnl).toFixed(2);

                const tradeId = 'trd-seed-' + String(tradeCounter).padStart(4, '0');
                const trade = {
                    id: tradeId,
                    account_id: accountId,
                    strategy_id: strat.id,
                    strategy_name: strat.name,
                    symbol: symObj.symbol,
                    asset_class: symObj.asset,
                    direction: side,
                    session: session,
                    status: 'CLOSED',
                    opened_at: tradeTime.toISOString(),
                    closed_at: closeTime.toISOString(),
                    entry_price: symObj.basePrice,
                    exit_price: +(side === 'BUY' ? symObj.basePrice * (1 + (pnl / 10000)) : symObj.basePrice * (1 - (pnl / 10000))).toFixed(4),
                    stop_loss: +(side === 'BUY' ? symObj.basePrice * 0.995 : symObj.basePrice * 1.005).toFixed(4),
                    take_profit: +(side === 'BUY' ? symObj.basePrice * 1.015 : symObj.basePrice * 0.985).toFixed(4),
                    risk_amount: riskAmount,
                    risk_percent: +(riskAmount / balance * 100).toFixed(2),
                    pnl_net: pnl,
                    pnl_gross: pnl,
                    r_multiple: rMultiple,
                    commission: 0,
                    swap: 0,
                    emotion: emotion,
                    rules_followed: rMultiple > -1.1,
                    tags: [strat.name, session, symObj.symbol],
                    notes: isWin ? 'Target reached cleanly with structure confirmation.' : 'Stop triggered on liquidity sweep.',
                    created_at: tradeTime.toISOString()
                };

                trades.push(trade);

                // Evaluation
                const evalObj = {
                    trade_id: tradeId,
                    evaluated_at: closeTime.toISOString(),
                    status: trade.rules_followed ? 'PASS' : 'VIOLATION',
                    rule_results: [
                        { rule_key: 'riskPerTrade', pass: true, label: 'Risk within limit' },
                        { rule_key: 'stopRequired', pass: true, label: 'Stop Loss set' },
                        { rule_key: 'minRR', pass: isWin || rMultiple > -1.0, label: 'Min 1.5R target' }
                    ]
                };
                evaluations.push(evalObj);

                if (!trade.rules_followed) {
                    violations.push({
                        id: 'viol-' + tradeId,
                        trade_id: tradeId,
                        rule_key: 'minRR',
                        severity: 'Soft',
                        message: 'Risk to reward fell below planned threshold.',
                        created_at: closeTime.toISOString()
                    });
                }

                tradeCounter++;
            }
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }

    raw.StrategyMaster = STRATEGIES;
    raw.Trades = trades;
    raw.TradeEvaluations = evaluations;
    raw.Violations = violations;
    if (raw.Accounts && raw.Accounts[0]) {
        raw.Accounts[0].current_equity = balance;
    }

    eventLog.push({
        entity: 'Trade Seeder',
        what: 'Populated 2-Month Data',
        detail: `${trades.length} trades generated across July and August 2026`,
        impact: `Ending Balance: $${balance.toLocaleString()}`,
        at: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    });
    raw.EVENT_LOG = eventLog;

    fs.writeFileSync(DB_FILE, JSON.stringify(raw, null, 2), 'utf8');
    console.log(`✅ Successfully seeded ${trades.length} trades across July & August 2026! Ending Balance: $${balance}`);
}

generateSampleTrades();
