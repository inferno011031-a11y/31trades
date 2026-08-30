'use strict';

const fs = require('fs');
const path = require('path');
const createTradeMindCore = require('./src/core/index.js');
const demoTrades = require('./demo-trades.js');

const DB_FILE = path.join(__dirname, 'data', 'db-00000000-0000-0000-0000-000000000000.json');

function seedCanonical() {
    let raw = {};
    if (fs.existsSync(DB_FILE)) {
        try { raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
    }

    const core = createTradeMindCore({
        demoTrades: demoTrades
    });

    const activeAccId = (raw.Accounts && raw.Accounts[0] && raw.Accounts[0].id) || 'acc-bule-graudian-5k-mteakzzq-00iqvx';
    const accName = (raw.Accounts && raw.Accounts[0] && raw.Accounts[0].name) || 'bule graudian 5k ';

    // Seed demo account and trades
    core.seedDemoAccount(activeAccId, 60);

    // Update account identity
    const targetAcc = core.Accounts.find(a => a.id === activeAccId);
    if (targetAcc) {
        targetAcc.name = accName;
        targetAcc.current_equity = 13019.73;
    }

    const serialized = core.serializeState();
    
    // Save to user DB
    fs.writeFileSync(DB_FILE, JSON.stringify(serialized, null, 2), 'utf8');

    console.log(`✅ Seeded ${serialized.Trades.length} canonical trades for account ${activeAccId}!`);
    console.log(`First Trade: ${serialized.Trades[0].ts} | Last Trade: ${serialized.Trades[serialized.Trades.length - 1].ts}`);
}

seedCanonical();
