'use strict';

// ---------------------------------------------------------------------------
// Billing contract tests — deterministic, offline, no provider SDK.
// Contract: a plan can ONLY be granted by a webhook whose raw body carries a
// valid HMAC signature; events are idempotent; cancellation keeps access until
// the paid period ends; expiry falls back to the standard plan.
// ---------------------------------------------------------------------------

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-test-'));
process.env.TRADEMIND_DATA_DIR = TMP;

const B = require('./billing.js');
const SECRET = 'test_secret_value';

let pass = 0, fail = 0;
function ok(v, s) { if (v) pass++; else { fail++; console.error('FAIL', s); } }

const baseEvent = {
    event_id: 'evt_1001',
    type: 'subscription.activated',
    user_id: 'user_test_1',
    plan: 'pro',
    current_period_end: new Date(Date.now() + 86400000 * 30).toISOString(),
    external_customer_id: 'cus_1'
};

// 1 · signature verification
const rawBody = JSON.stringify(baseEvent);
ok(B.verifySignature(rawBody, B.signBody(rawBody, SECRET), SECRET).ok, 'valid t,v1 signature accepted');
const plainHex = crypto.createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
ok(B.verifySignature(rawBody, plainHex, SECRET).ok, 'plain hex signature accepted');
ok(!B.verifySignature(rawBody + 'x', plainHex, SECRET).ok, 'plain signature does not cover a modified body');
ok(!B.verifySignature(rawBody, B.signBody(rawBody, 'other_secret'), SECRET).ok, 'wrong secret rejected');
ok(!B.verifySignature('tampered' + rawBody, B.signBody(rawBody, SECRET), SECRET).ok, 'tampered body rejected');
ok(!B.verifySignature(rawBody, '', SECRET).ok, 'missing signature rejected');
ok(!B.verifySignature(rawBody, B.signBody(rawBody, SECRET, Date.now() - 3600 * 1000), SECRET).ok, 'stale timestamp rejected (replay protection)');
ok(B.verifySignature(rawBody, B.signBody(rawBody, SECRET), SECRET, { toleranceMs: 999999999 }).ok, 'fresh timestamp accepted');

// 2 · event normalization
const norm = B.normalizeEvent(baseEvent, 'stripe');
ok(norm.ok && norm.event.provider === 'stripe' && norm.event.plan === 'pro', 'normalizes a canonical event');
ok(!B.normalizeEvent(Object.assign({}, baseEvent, { type: 'invoice.paid' }), 'stripe').ok, 'unsupported event type rejected');
ok(!B.normalizeEvent(Object.assign({}, baseEvent, { plan: 'enterprise' }), 'stripe').ok, 'unknown plan rejected');
ok(!B.normalizeEvent(Object.assign({}, baseEvent, { user_id: '' }), 'stripe').ok, 'missing user rejected');
ok(!B.normalizeEvent(Object.assign({}, baseEvent, { current_period_end: 'not-a-date' }), 'stripe').ok, 'bad period end rejected');
ok(!B.normalizeEvent(baseEvent, 'NOT A PROVIDER').ok, 'invalid provider slug rejected');
ok(!B.normalizeEvent(baseEvent, '').ok, 'provider is required');

// 3 · webhook refuses to do anything without a configured secret
delete process.env.BILLING_WEBHOOK_SECRET;
ok(B.configured() === false, 'not configured without env secret');

(async () => {
    const off = await B.handleWebhook({ provider: 'stripe', rawBody, signature: 'sha=1' });
    ok(off.status === 503 && off.body.error === 'billing_not_configured', 'webhook 503 while unconfigured');

    process.env.BILLING_WEBHOOK_SECRET = SECRET;
    ok(B.configured() === true, 'configured with env secret');

    const bad = await B.handleWebhook({ provider: 'stripe', rawBody, signature: 'v1=deadbeef' });
    ok(bad.status === 401 && bad.body.error === 'bad_signature', 'bad signature → 401, no plan written');
    ok(!fs.existsSync(B.STORE_FILE), 'no plan store created by a rejected webhook');

    const noProvider = await B.handleWebhook({ provider: 'nowhere/x', rawBody, signature: B.signBody(rawBody, SECRET) });
    ok(noProvider.status === 404, 'unknown provider path → 404');

    const good = await B.handleWebhook({ provider: 'stripe', rawBody, signature: B.signBody(rawBody, SECRET) });
    ok(good.status === 200 && good.body.plan === 'pro' && good.body.duplicate === false, 'verified webhook activates the plan');

    // 4 · idempotency — the same provider event can never apply twice
    const replay = await B.handleWebhook({ provider: 'stripe', rawBody, signature: B.signBody(rawBody, SECRET) });
    ok(replay.status === 200 && replay.body.duplicate === true, 'retried webhook is idempotent');

    // an active event without a plan is refused
    const noPlan = await B.handleWebhook({
        provider: 'stripe',
        rawBody: JSON.stringify({ event_id: 'evt_1002', type: 'subscription.activated', user_id: 'user_test_1' }),
        signature: B.signBody(JSON.stringify({ event_id: 'evt_1002', type: 'subscription.activated', user_id: 'user_test_1' }), SECRET)
    });
    ok(noPlan.status === 422 && noPlan.body.error === 'plan_required_for_active_event', 'active event without plan refused');

    // 5 · cancellation keeps access until the period ends; expiry drops to standard
    const cancelBody = JSON.stringify({ event_id: 'evt_1003', type: 'subscription.canceled', user_id: 'user_test_1' });
    const cancelled = await B.handleWebhook({ provider: 'stripe', rawBody: cancelBody, signature: B.signBody(cancelBody, SECRET) });
    ok(cancelled.status === 200 && cancelled.body.status === 'canceled', 'cancel event recorded');
    let sub = await B.getSubscription('user_test_1');
    ok(sub.plan === 'pro', 'cancelled plan keeps access until period end');
    ok(sub.status === 'canceled', 'subscription reports canceled status');

    const expiredBody = JSON.stringify({ event_id: 'evt_1004', type: 'subscription.expired', user_id: 'user_test_1' });
    await B.handleWebhook({ provider: 'stripe', rawBody: expiredBody, signature: B.signBody(expiredBody, SECRET) });
    sub = await B.getSubscription('user_test_1');
    ok(sub.plan === 'standard', 'expired subscription falls back to standard');
    ok(sub.features.priority_support === false, 'standard plan has no priority support');

    // 6 · an ended period is not trusted even if the row still says active
    const futureBody = JSON.stringify({ event_id: 'evt_1005', type: 'subscription.activated', user_id: 'user_test_2', plan: 'pro', current_period_end: new Date(Date.now() - 86400000).toISOString() });
    await B.handleWebhook({ provider: 'paddle', rawBody: futureBody, signature: B.signBody(futureBody, SECRET) });
    const ended = await B.getSubscription('user_test_2');
    ok(ended.plan === 'standard', 'already-ended paid period does not grant pro');

    // 7 · plans + feature gating
    const plans = B.listPlans();
    ok(plans.length === 3 && plans.some(p => p.id === 'pro'), 'plan catalogue exposed');
    // a live paid period: enforced counters stay honest, declared allowance is separate
    const liveBody = JSON.stringify({ event_id: 'evt_1006', type: 'subscription.activated', user_id: 'user_test_3', plan: 'pro', current_period_end: new Date(Date.now() + 86400000 * 30).toISOString() });
    await B.handleWebhook({ provider: 'stripe', rawBody: liveBody, signature: B.signBody(liveBody, SECRET) });
    const proSub = await B.getSubscription('user_test_3');
    ok(proSub.plan === 'pro', 'live paid period grants the plan');
    ok(B.featureEnabled(proSub, 'analytics').ok === true, 'known feature resolves');
    ok(proSub.ai.mode === 'lifetime' && proSub.ai.limit === 50, 'AI counters report what is actually enforced');
    ok(proSub.declaredAi.mode === 'monthly' && proSub.declaredAi.limit === 1000, 'plan declares its own AI allowance separately');
    ok(B.featureEnabled(proSub, 'teleport').error === 'unknown_feature', 'unknown feature refused');
    ok(B.featureEnabled(null, 'analytics').error === 'subscription_required', 'missing subscription refused');

    // 8 · no secret ever lands in the store
    const storeJson = fs.readFileSync(B.STORE_FILE, 'utf8');
    ok(storeJson.indexOf(SECRET) === -1, 'webhook secret never persisted');

    console.log(`billing: ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
})();
