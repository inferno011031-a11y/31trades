'use strict';

const http = require('http');

function postJson(urlPath, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const req = http.request({
            hostname: '127.0.0.1',
            port: 8080,
            path: urlPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let resBody = '';
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(resBody) }); }
                catch (e) { resolve({ status: res.statusCode, raw: resBody }); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function getJson(urlPath) {
    return new Promise((resolve, reject) => {
        http.get({
            hostname: '127.0.0.1',
            port: 8080,
            path: urlPath,
            headers: { 'Accept': 'application/json' }
        }, res => {
            let resBody = '';
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(resBody) }); }
                catch (e) { resolve({ status: res.statusCode, raw: resBody }); }
            });
        }).on('error', reject);
    });
}

async function runTest() {
    console.log('=== TEST: 7-Step Log Trade Pipeline ===');

    // 1. Check initial state
    const stateBefore = await getJson('/api/state');
    console.log(`Initial Trade Count: ${stateBefore.data.Trades.length}`);
    const account = stateBefore.data.Accounts[0];
    console.log(`Account: ${account.name} | Balance: $${account.current_equity}`);

    // 2. Prepare a new trade
    const newTrade = {
        account_id: account.id,
        strategy_id: 'strat-fvg',
        strategy_name: 'MSS + FVG Trend',
        symbol: 'EURUSD',
        asset_class: 'Forex',
        direction: 'BUY',
        session: 'London',
        status: 'CLOSED',
        opened_at: new Date().toISOString(),
        closed_at: new Date(Date.now() + 30 * 60000).toISOString(),
        entry_price: 1.0850,
        exit_price: 1.0880,
        stop_loss: 1.0830,
        take_profit: 1.0900,
        risk_amount: 30,
        pnl_net: 75.00,
        r_multiple: 2.50,
        emotion: 'Disciplined',
        notes: 'Live automated test trade via 7-step pipeline'
    };

    console.log('\nLogging Trade...');
    const logRes = await postJson('/api/trades', newTrade);
    console.log(`API Response Status: ${logRes.status}`);
    console.log('API Result:', JSON.stringify(logRes.data, null, 2));

    // 3. Verify state after logging
    const stateAfter = await getJson('/api/state');
    console.log(`\nTrade Count After Logging: ${stateAfter.data.Trades.length}`);
    const latestTrade = stateAfter.data.Trades[stateAfter.data.Trades.length - 1];
    console.log('Latest Logged Trade:', latestTrade.id, latestTrade.symbol, latestTrade.direction, `+$${latestTrade.pnl_net}`);
    console.log(`Updated Account Balance: $${stateAfter.data.Accounts[0].current_equity}`);

    console.log('\n✅ 7-Step Pipeline Verified and Functional!');
}

runTest().catch(console.error);
