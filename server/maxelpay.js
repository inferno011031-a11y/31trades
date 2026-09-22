'use strict';

// ============================================================================
// 31TRADES / BATTLEX — MaxelPay Crypto Payment Gateway Integration
// ----------------------------------------------------------------------------
// Implements MaxelPay API v1:
//   - POST /api/v1/payments/sessions (Create hosted crypto checkout session)
//   - GET  /api/v1/payments/sessions/{sessionId}/status (Query session status)
//   - Webhook IPN listener with HMAC SHA-256 signature verification
//   - Sandbox / Simulated Test Mode for friction-free local verification
// ============================================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAXELPAY_BASE_URL = process.env.MAXELPAY_BASE_URL || 'https://api.maxelpay.com';
const DEFAULT_API_KEY = process.env.MAXELPAY_API_KEY || 'pk_test_sample_key';
const DEFAULT_SECRET_KEY = process.env.MAXELPAY_SECRET_KEY || 'sk_test_sample_secret';

// Data storage directory for payment records
function getStorageDir() {
    return process.env.TRADEMIND_DATA_DIR || path.join(__dirname, '..', 'data');
}

function getOrdersFile() {
    return path.join(getStorageDir(), 'maxelpay_orders.json');
}

function loadOrders() {
    try {
        const file = getOrdersFile();
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {}
    return {};
}

function saveOrders(orders) {
    try {
        const dir = getStorageDir();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(getOrdersFile(), JSON.stringify(orders, null, 2), 'utf8');
    } catch (e) {}
}

/**
 * Creates a payment session with MaxelPay API.
 * In live mode, sends HTTP POST to https://api.maxelpay.com/api/v1/payments/sessions
 * If API fails or is in mock mode, returns a deterministic test session.
 */
async function createPaymentSession(params, apiKey = DEFAULT_API_KEY) {
    const {
        orderId,
        amount,
        currency = 'USD',
        description = 'BattleX Journal Subscription',
        successUrl,
        cancelUrl,
        callbackUrl,
        metadata = {}
    } = params || {};

    if (!orderId) throw new Error('Missing required parameter: orderId');
    if (!amount || Number(amount) <= 0) throw new Error('Invalid or missing parameter: amount');
    if (!successUrl) throw new Error('Missing required parameter: successUrl');
    if (!cancelUrl) throw new Error('Missing required parameter: cancelUrl');
    if (!callbackUrl) throw new Error('Missing required parameter: callbackUrl');

    const payload = {
        orderId: String(orderId),
        amount: Number(amount),
        currency: String(currency).toUpperCase(),
        description: String(description),
        successUrl: String(successUrl),
        cancelUrl: String(cancelUrl),
        callbackUrl: String(callbackUrl)
    };

    let session = null;

    // Only make live network calls if explicitly not forced to mock and a key is provided
    if (process.env.MAXELPAY_MOCK !== 'true' && apiKey && !apiKey.includes('test_sample')) {
        try {
            const res = await fetch(`${MAXELPAY_BASE_URL}/api/v1/payments/sessions`, {
                method: 'POST',
                headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                session = await res.json();
            } else {
                const errText = await res.text();
                console.warn(`[MaxelPay] Remote API error (${res.status}): ${errText}`);
                // If API rejected test key, fall back to simulated session
                if (res.status === 401 || res.status === 403 || apiKey.startsWith('pk_test_')) {
                    session = null;
                } else {
                    throw new Error(`MaxelPay API error (${res.status}): ${errText}`);
                }
            }
        } catch (err) {
            if (apiKey.startsWith('pk_test_') || apiKey.includes('sample')) {
                // Graceful fallback for test keys
                session = null;
            } else {
                throw err;
            }
        }
    }

    // Fallback: Generate simulated test session for local/testing environments
    if (!session) {
        const mockSessionId = 'ps_test_' + crypto.randomBytes(16).toString('hex');
        session = {
            ok: true,
            isMock: true,
            sessionId: mockSessionId,
            orderId: payload.orderId,
            amount: payload.amount,
            currency: payload.currency,
            description: payload.description,
            checkoutUrl: `https://checkout.maxelpay.com/pay/${mockSessionId}?test=1`,
            status: 'pending',
            created_at: new Date().toISOString()
        };
    }

    // Persist session to local registry
    const orders = loadOrders();
    orders[payload.orderId] = {
        sessionId: session.sessionId || session.id,
        orderId: payload.orderId,
        amount: payload.amount,
        currency: payload.currency,
        description: payload.description,
        status: session.status || 'pending',
        checkoutUrl: session.checkoutUrl || session.url,
        metadata,
        created_at: new Date().toISOString()
    };
    saveOrders(orders);

    return session;
}

/**
 * Retrieve session status from MaxelPay.
 */
async function getSessionStatus(sessionId, apiKey = DEFAULT_API_KEY) {
    if (!sessionId) throw new Error('Missing sessionId');

    // Check local store first
    const orders = loadOrders();
    const localOrder = Object.values(orders).find(o => o.sessionId === sessionId);

    if (process.env.MAXELPAY_MOCK !== 'true' && apiKey && !apiKey.includes('test_sample') && !sessionId.startsWith('ps_test_')) {
        try {
            const res = await fetch(`${MAXELPAY_BASE_URL}/api/v1/payments/sessions/${sessionId}/status`, {
                headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                }
            });
            if (res.ok) {
                const data = await res.json();
                if (localOrder && data.status) {
                    localOrder.status = data.status;
                    saveOrders(orders);
                }
                return data;
            }
        } catch (err) {
            console.warn('[MaxelPay] Status check error:', err.message);
        }
    }

    // Return stored state or default
    return {
        ok: true,
        sessionId,
        status: (localOrder && localOrder.status) || 'pending',
        orderId: localOrder ? localOrder.orderId : undefined,
        amount: localOrder ? localOrder.amount : undefined,
        currency: localOrder ? localOrder.currency : 'USD'
    };
}

/**
 * Verifies the HMAC SHA-256 signature sent in the X-MaxelPay-Signature header.
 */
function verifyWebhookSignature(payload, signature, secretKey = DEFAULT_SECRET_KEY) {
    if (!payload || !signature) return false;

    try {
        const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const expectedSignature = crypto
            .createHmac('sha256', secretKey)
            .update(payloadString)
            .digest('hex');

        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expectedSignature);

        if (sigBuf.length !== expBuf.length) return false;
        return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch (e) {
        return false;
    }
}

/**
 * Generates an HMAC SHA-256 signature for test payloads.
 */
function signWebhookPayload(payload, secretKey = DEFAULT_SECRET_KEY) {
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto
        .createHmac('sha256', secretKey)
        .update(payloadString)
        .digest('hex');
}

/**
 * Processes incoming MaxelPay webhook events:
 *   - payment.completed
 *   - payment.partial
 *   - payment.overpaid
 *   - payment.expired
 */
async function processWebhookEvent(rawBody, signature, secretKey = DEFAULT_SECRET_KEY) {
    const isValid = verifyWebhookSignature(rawBody, signature, secretKey);
    if (!isValid) {
        throw new Error('Invalid MaxelPay webhook signature');
    }

    const eventObj = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const { event, data } = eventObj || {};

    if (!event || !data) {
        throw new Error('Malformed webhook payload');
    }

    const { orderId, sessionId, status, amount, txHash, network, tokenSymbol } = data;

    // Update local order registry
    const orders = loadOrders();
    const existing = orders[orderId] || {};

    let resolvedStatus = 'pending';
    switch (event) {
        case 'payment.completed':
            resolvedStatus = 'paid';
            break;
        case 'payment.partial':
            resolvedStatus = 'partial';
            break;
        case 'payment.overpaid':
            resolvedStatus = 'overpaid';
            break;
        case 'payment.expired':
            resolvedStatus = 'expired';
            break;
        default:
            resolvedStatus = status || 'unknown';
    }

    orders[orderId] = {
        ...existing,
        sessionId: sessionId || existing.sessionId,
        orderId,
        status: resolvedStatus,
        lastEvent: event,
        amount: amount || existing.amount,
        txHash: txHash || existing.txHash,
        network: network || existing.network,
        tokenSymbol: tokenSymbol || existing.tokenSymbol,
        updated_at: new Date().toISOString()
    };
    saveOrders(orders);

    return {
        ok: true,
        event,
        orderId,
        status: resolvedStatus,
        txHash
    };
}

/**
 * Simulates a successful cryptocurrency payment and triggers webhook fulfillment.
 * Perfect for developer testing and local demos.
 */
async function simulateTestPayment(params = {}, secretKey = DEFAULT_SECRET_KEY) {
    const orderId = params.orderId || ('bx_ord_' + Date.now());
    const amount = Number(params.amount || 29.00);
    const sessionId = params.sessionId || ('ps_test_' + crypto.randomBytes(16).toString('hex'));

    const testPayload = {
        event: 'payment.completed',
        timestamp: new Date().toISOString(),
        data: {
            sessionId,
            orderId,
            status: 'paid',
            amount,
            currency: params.currency || 'USD',
            paidAmount: amount,
            totalPaidUsd: amount,
            txHash: '0x' + crypto.randomBytes(32).toString('hex'),
            network: params.network || 'Polygon',
            tokenSymbol: params.tokenSymbol || 'USDT',
            customerEmail: params.customerEmail || 'trader@battlex.io',
            metadata: params.metadata || { simulated: true }
        }
    };

    const signature = signWebhookPayload(testPayload, secretKey);
    const result = await processWebhookEvent(testPayload, signature, secretKey);
    return {
        ok: true,
        simulated: true,
        payload: testPayload,
        result
    };
}

module.exports = {
    MAXELPAY_BASE_URL,
    DEFAULT_API_KEY,
    DEFAULT_SECRET_KEY,
    createPaymentSession,
    getSessionStatus,
    verifyWebhookSignature,
    signWebhookPayload,
    processWebhookEvent,
    simulateTestPayment,
    loadOrders
};
