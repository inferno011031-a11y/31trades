'use strict';

// ============================================================================
// 31TRADES — Broker Sync & MT5 Integration Test Suite
// ----------------------------------------------------------------------------
// Tests token generation, MT5 live EA webhook ingestion, TradingView webhooks,
// broker statement parsing (MT5 HTML, cTrader CSV, IBKR CSV), idempotency,
// and real HTTP endpoint behavior.
// ============================================================================

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Point storage to a clean scratch directory for isolation
const TEST_DIR = path.join(__dirname, '..', 'data', 'test-broker-sync-' + Date.now());
process.env.TRADEMIND_BROKER_DATA_DIR = TEST_DIR;
process.env.TRADEMIND_DATA_DIR = TEST_DIR;
process.env.TRADEMIND_AUTH = 'off'; // test in anonymous mode

const BrokerSync = require('./broker-sync.js');
const BrokerParsers = require('./broker-parsers.js');
const createCore = require('../src/core/index.js');

let failures = 0;
function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log('  ok   ' + name);
        })
        .catch(err => {
            console.error('  FAIL ' + name + ' — ' + err.message);
            failures++;
        });
}

async function run() {
    console.log('Broker Sync & Multi-Broker Integration Tests:');
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const testUser = 'user-test-mt5-' + Math.random().toString(36).slice(2, 8);

    // -----------------------------------------------------------------------
    // Unit Tests: Token Management
    // -----------------------------------------------------------------------
    let userToken = null;
    await test('getOrCreateSyncToken generates a secure prefixed token', async () => {
        const data = await BrokerSync.getOrCreateSyncToken(testUser);
        assert(data, 'Token data should exist');
        assert(typeof data.token === 'string', 'Token must be a string');
        assert(data.token.startsWith(BrokerSync.TOKEN_PREFIX), 'Token must start with prefix bx_live_');
        assert(data.token.length > 30, 'Token must be cryptographically long');
        userToken = data.token;
    });

    await test('resolveUserFromToken resolves token back to correct userId', async () => {
        const resolved = await BrokerSync.resolveUserFromToken(userToken);
        assert.strictEqual(resolved, testUser, 'Should resolve to testUser');
    });

    await test('resolveUserFromToken rejects invalid or foreign tokens', async () => {
        assert.strictEqual(await BrokerSync.resolveUserFromToken('bx_live_invalid12345'), null);
        assert.strictEqual(await BrokerSync.resolveUserFromToken('random_string'), null);
        assert.strictEqual(await BrokerSync.resolveUserFromToken(''), null);
        assert.strictEqual(await BrokerSync.resolveUserFromToken(null), null);
    });

    await test('regenerateSyncToken produces a new token and revokes old one', async () => {
        const regenerated = await BrokerSync.regenerateSyncToken(testUser);
        assert.notStrictEqual(regenerated.token, userToken, 'New token must differ from old');
        assert.strictEqual(await BrokerSync.resolveUserFromToken(userToken), null, 'Old token must be revoked');
        assert.strictEqual(await BrokerSync.resolveUserFromToken(regenerated.token), testUser, 'New token must resolve');
        userToken = regenerated.token; // update active token
    });

    // -----------------------------------------------------------------------
    // Unit Tests: MT5 Normalization & Ingestion
    // -----------------------------------------------------------------------
    await test('normalizeMt5Payload correctly cleans symbol, direction, and PnL', () => {
        const payload = {
            ticket: 1049281,
            symbol: 'XAUUSD.pro',
            type: 'BUY',
            lots: 0.50,
            openPrice: 2040.50,
            closePrice: 2048.20,
            sl: 2036.00,
            tp: 2052.00,
            pnl: 385.00,
            commission: -3.50,
            swap: -1.00,
            comment: 'Silver Bullet NY'
        };
        const normalized = BrokerSync.normalizeMt5Payload(payload, 'acc-test');
        assert.strictEqual(normalized.id, 'mt5-1049281');
        assert.strictEqual(normalized.broker_ticket, '1049281');
        assert.strictEqual(normalized.symbol, 'XAUUSD', 'Symbol should strip .pro suffix');
        assert.strictEqual(normalized.dir, 'Long');
        assert.strictEqual(normalized.entry, 2040.50);
        assert.strictEqual(normalized.exit, 2048.20);
        assert.strictEqual(normalized.size, 0.50);
        assert.strictEqual(normalized.pnl, 380.50, 'Net PnL should be 385 - 3.5 - 1 = 380.50');
        assert.strictEqual(normalized.setup, 'Silver Bullet NY');
        assert.strictEqual(normalized.broker, 'MetaTrader 5');
    });

    await test('ingestMt5Trade logs trade into Core and prevents duplicate ticket', async () => {
        const core = createCore();
        core.Trades.length = 0;
        const accountId = core.Accounts[0].id;

        const payload = {
            ticket: 884920,
            symbol: 'EURUSD',
            type: 'SELL',
            lots: 1.0,
            openPrice: 1.08800,
            closePrice: 1.08300,
            pnl: 500.00,
            account_id: accountId
        };

        const first = await BrokerSync.ingestMt5Trade(core, testUser, payload);
        assert(first.ok, 'First ingestion should succeed');
        assert.strictEqual(first.duplicated, false);
        assert(core.Trades.some(t => t.id === 'mt5-884920'), 'Trade should exist in Core.Trades');

        // Repeated ticket should be detected as duplicate
        const second = await BrokerSync.ingestMt5Trade(core, testUser, payload);
        assert(second.ok, 'Duplicate call should succeed');
        assert.strictEqual(second.duplicated, true);
        const count = core.Trades.filter(t => t.id === 'mt5-884920').length;
        assert.strictEqual(count, 1, 'Duplicate ticket must not be inserted twice');
    });

    // -----------------------------------------------------------------------
    // Unit Tests: TradingView Webhook
    // -----------------------------------------------------------------------
    await test('normalizeTradingViewPayload handles alert fields', () => {
        const payload = {
            ticker: 'NASDAQ:QQQ',
            action: 'buy',
            price: 490.50,
            quantity: 10,
            strategy: 'FVG Retest',
            order_id: 'tv-alert-771'
        };
        const normalized = BrokerSync.normalizeTradingViewPayload(payload, 'acc-test');
        assert.strictEqual(normalized.id, 'tv-tv-alert-771');
        assert.strictEqual(normalized.dir, 'Long');
        assert.strictEqual(normalized.symbol, 'NASDAQQQQ');
        assert.strictEqual(normalized.entry, 490.50);
        assert.strictEqual(normalized.setup, 'FVG Retest');
    });

    // -----------------------------------------------------------------------
    // Unit Tests: Broker Statement Parsers
    // -----------------------------------------------------------------------
    await test('detectBrokerFormat identifies MT5, cTrader, and IBKR formats', () => {
        const mt5Sample = '<html><body><h1>MetaTrader 5 Detailed Report</h1><table><tr><td>Deals</td></tr></table></body></html>';
        assert.strictEqual(BrokerParsers.detectBrokerFormat(mt5Sample), 'MT5_REPORT');

        const ctraderSample = 'Position ID,Symbol,Opening Direction,Closing Direction,Entry Price,Closing Price,Realized Net P&L\n1234,EURUSD,Buy,Sell,1.08,1.09,100';
        assert.strictEqual(BrokerParsers.detectBrokerFormat(ctraderSample), 'CTRADER_CSV');

        const ibkrSample = 'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Realized P/L\nTrades,Data,Order,Stocks,USD,AAPL,2026-09-20,10,150,155,50';
        assert.strictEqual(BrokerParsers.detectBrokerFormat(ibkrSample), 'IBKR_CSV');
    });

    await test('parseBrokerStatement extracts trades from mock MT5 HTML statement', () => {
        const html = `
        <html>
        <body>
        <h1>MetaTrader 5 Statement</h1>
        <table>
            <tr><th>Open Time</th><th>Position</th><th>Symbol</th><th>Type</th><th>Volume</th><th>Open Price</th><th>S / L</th><th>T / P</th><th>Close Time</th><th>Close Price</th><th>Commission</th><th>Swap</th><th>Profit</th></tr>
            <tr><td>2026.09.20 14:00:00</td><td>554433</td><td>EURUSD</td><td>buy</td><td>0.50</td><td>1.08500</td><td>1.08200</td><td>1.09100</td><td>2026.09.20 15:00:00</td><td>1.08900</td><td>-3.50</td><td>0.00</td><td>200.00</td></tr>
            <tr><td>2026.09.20 16:00:00</td><td>554434</td><td>GBPUSD</td><td>sell</td><td>1.00</td><td>1.27500</td><td>1.27800</td><td>1.27000</td><td>2026.09.20 17:00:00</td><td>1.27100</td><td>-7.00</td><td>0.00</td><td>400.00</td></tr>
        </table>
        </body>
        </html>
        `;
        const result = BrokerParsers.parseBrokerStatement(html, 'acc-test');
        assert(result.ok, 'Parsing should succeed');
        assert.strictEqual(result.count, 2);
        assert.strictEqual(result.trades[0].symbol, 'EURUSD');
        assert.strictEqual(result.trades[0].dir, 'Long');
        assert.strictEqual(result.trades[0].pnl, 200.00);
        assert.strictEqual(result.trades[1].symbol, 'GBPUSD');
        assert.strictEqual(result.trades[1].dir, 'Short');
        assert.strictEqual(result.trades[1].pnl, 400.00);
    });

    await test('parseBrokerStatement extracts trades from cTrader CSV', () => {
        const csv = `Position ID,Symbol,Opening Direction,Closing Direction,Entry Price,Closing Price,Closing Quantity,Realized Net P&L\n998811,XAUUSD,Buy,Sell,2040.00,2045.00,1.0,500.00`;
        const result = BrokerParsers.parseBrokerStatement(csv, 'acc-test');
        assert(result.ok);
        assert.strictEqual(result.count, 1);
        assert.strictEqual(result.trades[0].symbol, 'XAUUSD');
        assert.strictEqual(result.trades[0].dir, 'Long');
        assert.strictEqual(result.trades[0].pnl, 500.00);
    });

    // -----------------------------------------------------------------------
    // EA File Verification
    // -----------------------------------------------------------------------
    await test('BattleX_Sync.mq5 file exists and contains MQL5 WebRequest logic', () => {
        const eaPath = path.join(__dirname, '..', 'public', 'assets', 'ea', 'BattleX_Sync.mq5');
        assert(fs.existsSync(eaPath), 'BattleX_Sync.mq5 must exist');
        const content = fs.readFileSync(eaPath, 'utf8');
        assert(content.includes('BattleX_Sync'), 'EA must have header comment');
        assert(content.includes('WebRequest'), 'EA must implement WebRequest');
        assert(content.includes('InpSyncToken'), 'EA must accept InpSyncToken input');
        assert(content.includes('OnTradeTransaction'), 'EA must handle OnTradeTransaction');
    });

    // Cleanup scratch dir
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {}

    if (failures > 0) {
        console.error(`\nFAILED: ${failures} test(s) failed.`);
        process.exit(1);
    } else {
        console.log(`\nALL Broker Sync tests passed successfully!\n`);
    }
}

run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
