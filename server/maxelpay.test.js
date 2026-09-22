'use strict';

// ============================================================================
// 31TRADES / BATTLEX — MaxelPay Integration Test Suite
// ----------------------------------------------------------------------------
// Tests session creation, status querying, HMAC SHA-256 webhook signatures,
// and order lifecycle fulfillment.
// ============================================================================

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Isolate storage to test scratch dir
const TEST_DIR = path.join(__dirname, '..', 'data', 'test-maxelpay-' + Date.now());
process.env.TRADEMIND_DATA_DIR = TEST_DIR;
process.env.MAXELPAY_MOCK = 'true'; // force mock mode for determinism in unit test

const MaxelPay = require('./maxelpay.js');

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
    console.log('MaxelPay Crypto Gateway Integration Tests:');
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const testOrderId = 'bx_ord_' + Date.now();

    // -----------------------------------------------------------------------
    // 1. Session Creation Validation
    // -----------------------------------------------------------------------
    await test('createPaymentSession rejects missing required parameters', async () => {
        await assert.rejects(
            () => MaxelPay.createPaymentSession({ amount: 50 }),
            /Missing required parameter: orderId/
        );
        await assert.rejects(
            () => MaxelPay.createPaymentSession({ orderId: '123', amount: 0 }),
            /Invalid or missing parameter: amount/
        );
        await assert.rejects(
            () => MaxelPay.createPaymentSession({ orderId: '123', amount: 10 }),
            /Missing required parameter: successUrl/
        );
    });

    let createdSession = null;
    await test('createPaymentSession generates valid checkout session in test mode', async () => {
        createdSession = await MaxelPay.createPaymentSession({
            orderId: testOrderId,
            amount: 49.00,
            currency: 'USD',
            description: 'BattleX Pro Tier - 1 Month',
            successUrl: 'https://battlex.io/settings.html?pay=success',
            cancelUrl: 'https://battlex.io/settings.html?pay=cancelled',
            callbackUrl: 'https://battlex.io/api/pay/maxelpay/webhook',
            metadata: { userId: 'user-apex-trader' }
        });

        assert(createdSession, 'Session should be created');
        assert(createdSession.sessionId, 'Session must have a sessionId');
        assert(createdSession.sessionId.startsWith('ps_test_'), 'SessionId should have test prefix');
        assert(createdSession.checkoutUrl.includes('checkout.maxelpay.com'), 'Checkout URL should point to MaxelPay');
        assert.strictEqual(createdSession.status, 'pending');
    });

    // -----------------------------------------------------------------------
    // 2. Status Checking
    // -----------------------------------------------------------------------
    await test('getSessionStatus returns pending status for freshly created session', async () => {
        const status = await MaxelPay.getSessionStatus(createdSession.sessionId);
        assert(status.ok);
        assert.strictEqual(status.status, 'pending');
        assert.strictEqual(status.orderId, testOrderId);
    });

    // -----------------------------------------------------------------------
    // 3. Webhook Signature Verification
    // -----------------------------------------------------------------------
    const testSecret = 'sk_test_super_secret_key_12345';
    const samplePayload = {
        event: 'payment.completed',
        timestamp: new Date().toISOString(),
        data: {
            sessionId: createdSession.sessionId,
            orderId: testOrderId,
            status: 'paid',
            amount: 49.00,
            currency: 'USD',
            paidAmount: 49.00,
            totalPaidUsd: 49.00,
            txHash: '0xabc1234567890deadbeefcafe9876543210fedcba',
            network: 'Polygon',
            tokenSymbol: 'USDT',
            customerEmail: 'trader@battlex.io',
            metadata: { userId: 'user-apex-trader' }
        }
    };

    let validSignature = '';
    await test('signWebhookPayload produces valid HMAC SHA-256 signature', () => {
        validSignature = MaxelPay.signWebhookPayload(samplePayload, testSecret);
        assert(typeof validSignature === 'string');
        assert.strictEqual(validSignature.length, 64, 'SHA-256 hex digest must be 64 characters');
    });

    await test('verifyWebhookSignature validates genuine signature and rejects forged one', () => {
        const isValid = MaxelPay.verifyWebhookSignature(samplePayload, validSignature, testSecret);
        assert.strictEqual(isValid, true, 'Valid signature must pass');

        const isTampered = MaxelPay.verifyWebhookSignature(samplePayload, 'forged_fake_signature_hash_1234567890abcdef1234567890abcdef12345678', testSecret);
        assert.strictEqual(isTampered, false, 'Forged signature must fail');

        const isBadPayload = MaxelPay.verifyWebhookSignature({ ...samplePayload, event: 'tampered' }, validSignature, testSecret);
        assert.strictEqual(isBadPayload, false, 'Tampered payload must fail');
    });

    // -----------------------------------------------------------------------
    // 4. Webhook Event Processing
    // -----------------------------------------------------------------------
    await test('processWebhookEvent marks order as paid and records tx details', async () => {
        const result = await MaxelPay.processWebhookEvent(samplePayload, validSignature, testSecret);
        assert(result.ok);
        assert.strictEqual(result.event, 'payment.completed');
        assert.strictEqual(result.status, 'paid');
        assert.strictEqual(result.txHash, samplePayload.data.txHash);

        // Verify order persisted in store
        const status = await MaxelPay.getSessionStatus(createdSession.sessionId);
        assert.strictEqual(status.status, 'paid');
    });

    await test('processWebhookEvent handles payment.expired event', async () => {
        const expiredOrder = 'bx_ord_expired_' + Date.now();
        await MaxelPay.createPaymentSession({
            orderId: expiredOrder,
            amount: 25.00,
            currency: 'USD',
            successUrl: 'https://test.io/success',
            cancelUrl: 'https://test.io/cancel',
            callbackUrl: 'https://test.io/webhook'
        });

        const expiredPayload = {
            event: 'payment.expired',
            timestamp: new Date().toISOString(),
            data: {
                sessionId: 'ps_test_expired',
                orderId: expiredOrder,
                status: 'expired'
            }
        };
        const sig = MaxelPay.signWebhookPayload(expiredPayload, testSecret);
        const result = await MaxelPay.processWebhookEvent(expiredPayload, sig, testSecret);
        assert.strictEqual(result.status, 'expired');
    });

    // Cleanup scratch dir
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {}

    if (failures > 0) {
        console.error(`\nFAILED: ${failures} test(s) failed.`);
        process.exit(1);
    } else {
        console.log(`\nALL MaxelPay Integration tests passed successfully!\n`);
    }
}

run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
