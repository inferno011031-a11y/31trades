'use strict';

// ============================================================================
// 31TRADES — Broker Live Sync & Webhook Engine
// ----------------------------------------------------------------------------
// Enables live automatic trade ingestion from MetaTrader 5 (MT5), MetaTrader 4,
// TradingView webhooks, and third-party broker bridges.
//
// FEATURES:
//   1. Cryptographically secure per-user Sync Tokens (bx_live_...)
//   2. MT5 Expert Advisor (EA) Webhook Ingestion (`POST /api/brokers/mt5/sync`)
//   3. TradingView Alert Webhook Ingestion (`POST /api/brokers/tradingview/webhook`)
//   4. Idempotency & Deduplication based on broker ticket / order IDs
//   5. Automatic R-Multiple, PnL, Asset-Class & Session normalization
//   6. Direct routing through BattleX canonical 7-step trade logging pipeline
// ============================================================================

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.js');

const TOKEN_PREFIX = 'bx_live_';
const TOKEN_BYTES = 24;

function tokenFileFor(userId) {
    const dir = process.env.TRADEMIND_BROKER_DATA_DIR || path.join(__dirname, '..', 'data');
    return path.join(dir, 'broker-token-' + userId + '.json');
}

function syncStateFileFor(userId) {
    const dir = process.env.TRADEMIND_BROKER_DATA_DIR || path.join(__dirname, '..', 'data');
    return path.join(dir, 'broker-sync-' + userId + '.json');
}

// Generate a cryptographically random token string
function generateTokenString() {
    return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// Read token state for user
function readTokenData(userId) {
    try {
        const file = tokenFileFor(userId);
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {}
    return null;
}

// Write token state for user
function writeTokenData(userId, data) {
    try {
        const file = tokenFileFor(userId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
}

// Get or create sync token for user
async function getOrCreateSyncToken(userId) {
    if (!userId) return null;
    let data = readTokenData(userId);
    if (!data || !data.token) {
        const token = generateTokenString();
        data = {
            userId,
            token,
            created_at: new Date().toISOString(),
            last_used_at: null,
            total_synced_trades: 0,
            active_brokers: ['MetaTrader 5']
        };
        writeTokenData(userId, data);
    }
    return data;
}

// Regenerate sync token (revokes old token)
async function regenerateSyncToken(userId) {
    if (!userId) return null;
    const old = readTokenData(userId) || {};
    const newToken = generateTokenString();
    const data = {
        userId,
        token: newToken,
        created_at: new Date().toISOString(),
        last_used_at: null,
        total_synced_trades: old.total_synced_trades || 0,
        active_brokers: old.active_brokers || ['MetaTrader 5']
    };
    writeTokenData(userId, data);
    return data;
}

// Look up userId from token
async function resolveUserFromToken(token) {
    if (!token || typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
        return null;
    }
    const cleanToken = token.trim();
    const dir = process.env.TRADEMIND_BROKER_DATA_DIR || path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) return null;

    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (file.startsWith('broker-token-') && file.endsWith('.json')) {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                    if (content && content.token === cleanToken) {
                        return content.userId;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

// Record sync heartbeat & activity
function recordSyncSuccess(userId, broker, tradeId) {
    try {
        const data = readTokenData(userId);
        if (data) {
            data.last_used_at = new Date().toISOString();
            data.total_synced_trades = (data.total_synced_trades || 0) + 1;
            if (broker && !data.active_brokers.includes(broker)) {
                data.active_brokers.push(broker);
            }
            writeTokenData(userId, data);
        }

        const stateFile = syncStateFileFor(userId);
        let syncState = { history: [] };
        if (fs.existsSync(stateFile)) {
            try { syncState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
        }
        syncState.history = syncState.history || [];
        syncState.history.unshift({
            at: new Date().toISOString(),
            broker: broker || 'MetaTrader 5',
            tradeId
        });
        if (syncState.history.length > 50) syncState.history.length = 50;
        syncState.lastSync = new Date().toISOString();
        syncState.lastBroker = broker || 'MetaTrader 5';
        fs.writeFileSync(stateFile, JSON.stringify(syncState, null, 2), 'utf8');
    } catch (e) {}
}

// Detect market trading session (London, New York, Asia) from date
function detectSession(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return 'New York';
    const utcHour = dateObj.getUTCHours();
    if (utcHour >= 0 && utcHour < 8) return 'Asia';
    if (utcHour >= 8 && utcHour < 13) return 'London';
    return 'New York';
}

// Clean symbol string (e.g. "EURUSD.r", "XAUUSDm", "GOLD" -> standard format)
function cleanSymbol(sym) {
    if (!sym) return 'EURUSD';
    let s = String(sym).trim().toUpperCase();
    // Strip common broker suffixes like .pro, .r, .m, _i
    s = s.replace(/[\._\-](PRO|R|M|I|RAW|ECN|STD)$/i, '');
    s = s.replace(/[^A-Z0-9]/g, '');
    if (s === 'GOLD') return 'XAUUSD';
    if (s === 'SILVER') return 'XAGUSD';
    if (s === 'OIL' || s === 'WTI') return 'USOIL';
    return s || 'EURUSD';
}

// Parse date string or timestamp from MT5 format (e.g. "2026.09.20 14:30:00" or ISO or unix)
function parseDate(val) {
    if (!val) return new Date();
    if (typeof val === 'number') {
        return new Date(val > 1e11 ? val : val * 1000);
    }
    if (typeof val === 'string') {
        // Handle "YYYY.MM.DD HH:MM:SS" from MT5
        const mt5Match = val.match(/^(\d{4})[\.\/\-](\d{1,2})[\.\/\-](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
        if (mt5Match) {
            return new Date(Date.UTC(
                Number(mt5Match[1]),
                Number(mt5Match[2]) - 1,
                Number(mt5Match[3]),
                Number(mt5Match[4]),
                Number(mt5Match[5]),
                Number(mt5Match[6] || 0)
            ));
        }
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d;
    }
    return new Date();
}

// ============================================================================
// MT5 LIVE INGESTION NORMALIZER
// ============================================================================
function normalizeMt5Payload(payload, accountId) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid MT5 payload: expected JSON object');
    }

    const ticket = payload.ticket || payload.deal || payload.order || payload.position;
    if (!ticket) {
        throw new Error('Missing ticket/deal ID in MT5 trade payload');
    }

    const symbol = cleanSymbol(payload.symbol);
    const rawType = String(payload.type != null ? payload.type : (payload.cmd != null ? payload.cmd : 'BUY')).toUpperCase();
    const isBuy = rawType === '0' || rawType === 'BUY' || rawType.includes('BUY');
    const dir = isBuy ? 'Long' : 'Short';

    const entry = Number(payload.openPrice || payload.price_open || payload.open_price || payload.price || 0);
    const exit = Number(payload.closePrice || payload.price_close || payload.close_price || payload.exit_price || entry);
    const size = Math.abs(Number(payload.lots || payload.volume || payload.size || 0.01));
    const sl = payload.sl != null ? Number(payload.sl) : (payload.stopLoss != null ? Number(payload.stopLoss) : null);
    const tp = payload.tp != null ? Number(payload.tp) : (payload.takeProfit != null ? Number(payload.takeProfit) : null);

    const profit = Number(payload.pnl != null ? payload.pnl : (payload.profit != null ? payload.profit : 0));
    const commission = Number(payload.commission || 0);
    const swap = Number(payload.swap || 0);
    const netPnl = Math.round((profit + commission + swap) * 100) / 100;

    const openDate = parseDate(payload.openTime || payload.time_open || payload.open_time);
    const closeDate = parseDate(payload.closeTime || payload.time_close || payload.close_time || openDate);
    const session = detectSession(openDate);

    // Calculate risk amount in currency if SL is provided
    let risk = 25; // default fallback risk
    if (sl && entry && entry !== sl) {
        const dist = Math.abs(entry - sl);
        // Estimate risk based on price distance and size
        risk = Math.max(1, Math.round(dist * size * 100) / 100);
    }

    const comment = String(payload.comment || payload.magic || '').trim();
    const setup = comment ? (comment.length > 50 ? comment.slice(0, 50) : comment) : 'MT5 Live Execution';

    return {
        id: 'mt5-' + String(ticket).trim(),
        broker_ticket: String(ticket).trim(),
        broker: 'MetaTrader 5',
        source: 'BROKER_SYNC',
        account_id: accountId,
        symbol,
        dir,
        entry,
        exit,
        size,
        sl: sl || undefined,
        tp: tp || undefined,
        pnl: netPnl,
        risk,
        setup,
        session,
        opened_at: openDate.toISOString(),
        closed_at: closeDate.toISOString(),
        notes: `Auto-synced from MetaTrader 5 (Ticket #${ticket}${payload.magic ? ' · Magic ' + payload.magic : ''}${commission || swap ? ` · Comm: $${commission} · Swap: $${swap}` : ''})`,
        tags: ['MT5', 'LiveSync'],
        emotion: 'Disciplined',
        adherence: 'followed'
    };
}

// Ingest MT5 trade into Core
async function ingestMt5Trade(Core, userId, payload) {
    if (!Core) throw new Error('Core engine not provided');
    const accountId = payload.account_id || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
    if (!accountId) throw new Error('No trading account available to attach MT5 trade to');

    const normalized = normalizeMt5Payload(payload, accountId);

    // Check if trade already exists
    const existing = Core.Trades.find(t =>
        t.id === normalized.id ||
        (t.broker_ticket && t.broker_ticket === normalized.broker_ticket)
    );
    if (existing) {
        return { ok: true, duplicated: true, trade: existing };
    }

    const trade = Core.logTradePipeline(normalized);
    recordSyncSuccess(userId, 'MetaTrader 5', trade.id);
    return { ok: true, duplicated: false, trade };
}

// ============================================================================
// TRADINGVIEW WEBHOOK INGESTION NORMALIZER
// ============================================================================
function normalizeTradingViewPayload(payload, accountId) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid TradingView payload');
    }

    const ticker = cleanSymbol(payload.ticker || payload.symbol || 'SPY');
    const rawAction = String(payload.action || payload.side || payload.order_action || 'buy').toLowerCase();
    const isBuy = rawAction.includes('buy') || rawAction.includes('long');
    const dir = isBuy ? 'Long' : 'Short';

    const price = Number(payload.price || payload.close || payload.entry || 0);
    const exitPrice = Number(payload.exit || payload.close_price || price);
    const qty = Number(payload.quantity || payload.contracts || payload.size || 1);
    const sl = payload.sl ? Number(payload.sl) : undefined;
    const tp = payload.tp ? Number(payload.tp) : undefined;
    const pnl = payload.pnl != null ? Number(payload.pnl) : (payload.profit != null ? Number(payload.profit) : 0);

    const orderId = payload.order_id || payload.id || ('tv-' + Date.now().toString(36));

    return {
        id: 'tv-' + String(orderId),
        broker_ticket: String(orderId),
        broker: 'TradingView',
        source: 'WEBHOOK',
        account_id: accountId,
        symbol: ticker,
        dir,
        entry: price,
        exit: exitPrice,
        size: qty,
        sl,
        tp,
        pnl,
        setup: String(payload.strategy || payload.setup || 'TradingView Alert'),
        session: detectSession(new Date()),
        opened_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        notes: `Webhook execution from TradingView alert: ${payload.message || 'Strategy Trigger'}`,
        tags: ['TradingView', 'AlertSync'],
        emotion: 'Neutral',
        adherence: 'followed'
    };
}

// Ingest TradingView Webhook
async function ingestTradingViewAlert(Core, userId, payload) {
    if (!Core) throw new Error('Core engine not provided');
    const accountId = payload.account_id || (Core.selectedAccountId ? Core.selectedAccountId() : null) || (Core.Accounts[0] ? Core.Accounts[0].id : null);
    if (!accountId) throw new Error('No trading account available');

    const normalized = normalizeTradingViewPayload(payload, accountId);

    const existing = Core.Trades.find(t => t.id === normalized.id);
    if (existing) {
        return { ok: true, duplicated: true, trade: existing };
    }

    const trade = Core.logTradePipeline(normalized);
    recordSyncSuccess(userId, 'TradingView', trade.id);
    return { ok: true, duplicated: false, trade };
}

module.exports = {
    TOKEN_PREFIX,
    getOrCreateSyncToken,
    regenerateSyncToken,
    resolveUserFromToken,
    recordSyncSuccess,
    cleanSymbol,
    detectSession,
    parseDate,
    normalizeMt5Payload,
    ingestMt5Trade,
    normalizeTradingViewPayload,
    ingestTradingViewAlert
};
