'use strict';

// ============================================================================
// 31TRADES — provider-neutral subscription & entitlement contract
// ----------------------------------------------------------------------------
// One contract, ANY payment provider. A provider only has to be able to send an
// HMAC-signed webhook whose JSON body matches the canonical schema below — then
// it can grant/deny plan access. No provider SDK, no fake billing: until
// BILLING_WEBHOOK_SECRET is set the webhook endpoint answers 503
// `billing_not_configured` and no plan is ever written.
//
//   POST /api/billing/webhook            (unauthenticated, signature IS the auth)
//   GET  /api/billing/subscription       (authed — current plan + features)
//
// Canonical event (what the provider must send):
//   {
//     "event_id":            "evt_123",                    // idempotency key
//     "type":                "subscription.activated",     // see EVENT_TYPES
//     "user_id":             "user_2cb732d7",              // BattleX user id
//     "plan":                "pro",                        // see PLANS
//     "current_period_end":  "2027-01-01T00:00:00Z",       // optional
//     "external_customer_id":"cus_987",                    // optional
//     "occurred_at":         "2026-09-21T10:00:00Z"        // optional
//   }
//
// Signature header (either form):
//   X-Battlex-Signature: t=<unix_seconds>,v1=<hex hmac of "<t>.<rawBody>">
//   X-Battlex-Signature: <hex hmac of rawBody>
//
// Verification is timing-safe and rejects timestamps older than TOLERANCE_MS
// (replay protection). Secrets live only in env — never logged, never stored.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db.js');

const DATA_DIR = process.env.TRADEMIND_DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'subscriptions.json');
const TOLERANCE_MS = Number(process.env.BILLING_WEBHOOK_TOLERANCE_MS) || 5 * 60 * 1000;
const MAX_PERIOD_MS = 1000 * 60 * 60 * 24 * 366 * 5;   // sanity bound: period ≤ 5 years

// ---------------------------------------------------------------------------
// Plans — the ONLY source of truth for feature access. `standard` (free) and
// `tester` (invite program) are derived from server/access.js; `pro` can only
// be granted by a verified provider webhook.
// ---------------------------------------------------------------------------
const PRO_AI_LIMIT = parseInt(process.env.PRO_AI_LIMIT || '1000', 10);

const BASE_FEATURES = {
    journal: true,
    analytics: true,
    backtesting: true,
    battles: true,
    voice: true,
    imports: true,
    evidence: true,
    community: true,
    squads: true
};

const PLANS = {
    standard: {
        id: 'standard',
        label: 'Standard',
        tier: 'normal',
        ai: { mode: 'lifetime', limit: 50 },
        features: Object.assign({}, BASE_FEATURES, { priority_support: false })
    },
    tester: {
        id: 'tester',
        label: 'Tester Program',
        tier: 'tester',
        ai: { mode: 'monthly', limit: parseInt(process.env.TESTER_AI_LIMIT || '100', 10) },
        features: Object.assign({}, BASE_FEATURES, { priority_support: true })
    },
    pro: {
        id: 'pro',
        label: 'Pro',
        tier: 'pro',
        ai: { mode: 'monthly', limit: PRO_AI_LIMIT },
        features: Object.assign({}, BASE_FEATURES, { priority_support: true })
    }
};

const EVENT_TYPES = {
    'subscription.activated': 'active',
    'subscription.renewed': 'active',
    'subscription.canceled': 'canceled',
    'subscription.expired': 'expired'
};

const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// ---------------------------------------------------------------------------
// Local mirror (offline / no-DB fallback). Same shape as other 31Trades stores:
// data/subscriptions.json → { plans: {userId: {...}}, events: {key: {...}} }
// ---------------------------------------------------------------------------
function loadStore() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
            return { plans: j.plans || {}, events: j.events || {} };
        }
    } catch (e) { /* corrupt → fresh */ }
    return { plans: {}, events: {} };
}

function saveStore(store) {
    try {
        fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
        fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    } catch (e) { /* read-only fs → DB only */ }
}

function configured() {
    return Boolean(process.env.BILLING_WEBHOOK_SECRET);
}

// ---------------------------------------------------------------------------
// 1. Signature verification (timing-safe, replay-protected)
// ---------------------------------------------------------------------------
function timingSafeEqual(a, b) {
    const A = Buffer.from(String(a || ''), 'utf8');
    const B = Buffer.from(String(b || ''), 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
}

function hmacHex(secret, payload) {
    return crypto.createHmac('sha256', String(secret)).update(String(payload), 'utf8').digest('hex');
}

function parseSignatureHeader(header) {
    const raw = String(header || '').trim();
    if (!raw) return null;
    if (raw.indexOf('=') === -1) return { t: null, v1: raw };
    const out = { t: null, v1: null };
    raw.split(',').forEach(part => {
        const i = part.indexOf('=');
        if (i === -1) return;
        const k = part.slice(0, i).trim().toLowerCase();
        const v = part.slice(i + 1).trim();
        if (k === 't') out.t = Number(v) || null;
        if (k === 'v1' || k === 'sig' || k === 's') out.v1 = v;
    });
    return out.v1 ? out : null;
}

/**
 * Verify a provider webhook signature against the RAW body.
 * @returns {{ok:boolean, error?:string}}
 */
function verifySignature(rawBody, header, secret, opts) {
    const o = opts || {};
    const tolerance = o.toleranceMs != null ? o.toleranceMs : TOLERANCE_MS;
    if (!secret) return { ok: false, error: 'billing_not_configured' };
    const sig = parseSignatureHeader(header);
    if (!sig || !sig.v1) return { ok: false, error: 'missing_signature' };
    if (sig.t != null) {
        const age = Math.abs(Date.now() - sig.t * 1000);
        if (age > tolerance) return { ok: false, error: 'signature_expired' };
        if (!timingSafeEqual(hmacHex(secret, sig.t + '.' + rawBody), sig.v1)) return { ok: false, error: 'bad_signature' };
        return { ok: true };
    }
    if (!timingSafeEqual(hmacHex(secret, rawBody), sig.v1)) return { ok: false, error: 'bad_signature' };
    return { ok: true };
}

function signBody(rawBody, secret, atMs) {
    const t = Math.floor((atMs != null ? atMs : Date.now()) / 1000);
    return 't=' + t + ',v1=' + hmacHex(secret, t + '.' + rawBody);
}

// ---------------------------------------------------------------------------
// 2. Event normalization + validation (never trusts provider field names)
// ---------------------------------------------------------------------------
function normalizeEvent(payload, providerHint) {
    const body = payload || {};
    const provider = String(providerHint || body.provider || '').toLowerCase();
    if (!PROVIDER_RE.test(provider)) return { ok: false, error: 'invalid_provider' };

    const eventId = String(body.event_id || body.id || '').trim();
    if (!eventId || eventId.length > 128) return { ok: false, error: 'invalid_event_id' };

    const type = String(body.type || '').trim();
    const status = EVENT_TYPES[type];
    if (!status) return { ok: false, error: 'unsupported_event_type' };

    const userId = String(body.user_id || '').trim();
    if (!userId || userId.length > 128) return { ok: false, error: 'invalid_user_id' };

    const plan = body.plan == null ? null : String(body.plan).trim().toLowerCase();
    if (plan !== null && !PLANS[plan]) return { ok: false, error: 'unknown_plan' };

    let periodEnd = null;
    if (body.current_period_end) {
        const t = new Date(body.current_period_end).getTime();
        if (!isFinite(t)) return { ok: false, error: 'invalid_period_end' };
        if (t - Date.now() > MAX_PERIOD_MS) return { ok: false, error: 'period_end_out_of_range' };
        periodEnd = new Date(t).toISOString();
    }

    let occurredAt = null;
    if (body.occurred_at) {
        const t = new Date(body.occurred_at).getTime();
        if (!isFinite(t)) return { ok: false, error: 'invalid_occurred_at' };
        occurredAt = new Date(t).toISOString();
    }

    return {
        ok: true,
        event: {
            provider,
            eventId,
            type,
            status,
            userId,
            plan,
            currentPeriodEnd: periodEnd,
            externalCustomerId: body.external_customer_id ? String(body.external_customer_id).slice(0, 128) : null,
            occurredAt,
            receivedAt: new Date().toISOString()
        }
    };
}

function eventKey(e) {
    return e.provider + ':' + e.eventId;
}

// ---------------------------------------------------------------------------
// 3. Apply an event — idempotent, and it NEVER elevates without a verified
//    signature (applyEvent is only reachable from handleWebhook).
// ---------------------------------------------------------------------------
async function applyEvent(event) {
    const store = loadStore();
    const key = eventKey(event);
    if (store.events[key]) {
        return { ok: true, duplicate: true, plan: store.plans[event.userId] || null, event };
    }

    store.events[key] = {
        provider: event.provider, eventId: event.eventId, type: event.type,
        userId: event.userId, plan: event.plan, status: event.status,
        currentPeriodEnd: event.currentPeriodEnd, occurredAt: event.occurredAt,
        receivedAt: event.receivedAt
    };

    let record = store.plans[event.userId] || null;
    if (event.status === 'active') {
        if (!event.plan) return { ok: false, error: 'plan_required_for_active_event' };
        record = {
            userId: event.userId,
            plan: event.plan,
            status: 'active',
            provider: event.provider,
            currentPeriodEnd: event.currentPeriodEnd,
            externalCustomerId: event.externalCustomerId,
            updatedAt: event.receivedAt
        };
    } else if (event.status === 'canceled') {
        // Cancellation keeps access until the paid period actually ends.
        if (record) {
            record = Object.assign({}, record, {
                status: 'canceled',
                currentPeriodEnd: event.currentPeriodEnd || record.currentPeriodEnd,
                updatedAt: event.receivedAt
            });
        }
    } else if (event.status === 'expired') {
        record = {
            userId: event.userId,
            plan: 'standard',
            status: 'expired',
            provider: event.provider,
            currentPeriodEnd: event.currentPeriodEnd || null,
            externalCustomerId: event.externalCustomerId || null,
            updatedAt: event.receivedAt
        };
    }

    if (record) store.plans[event.userId] = record;
    saveStore(store);

    await persistPlan(record, event).catch(err => {
        console.warn('[billing] plan mirror to Postgres failed (' + err.message + ') — local mirror kept');
    });

    return { ok: true, duplicate: false, plan: record, event };
}

async function persistPlan(record, event) {
    const pool = db.getPool();
    if (!pool || !record) return { persisted: false };
    // UPDATE first so a pre-existing entitlement row (tester code redemption etc.)
    // is never clobbered by a plan switch; INSERT only fills a genuinely missing row.
    const upd = await pool.query(
        `UPDATE user_entitlements
            SET plan = $2, plan_status = $3, plan_expires_at = $4, billing_provider = $5, updated_at = now()
          WHERE user_id = $1`,
        [record.userId, record.plan, record.status, record.currentPeriodEnd, record.provider]
    );
    if (upd.rowCount) return { persisted: true, updated: true };
    try {
        await pool.query(
            `INSERT INTO user_entitlements (user_id, plan, plan_status, plan_expires_at, billing_provider, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (user_id) DO UPDATE SET
               plan = EXCLUDED.plan, plan_status = EXCLUDED.plan_status,
               plan_expires_at = EXCLUDED.plan_expires_at,
               billing_provider = EXCLUDED.billing_provider, updated_at = now()`,
            [record.userId, record.plan, record.status, record.currentPeriodEnd, record.provider]
        );
        return { persisted: true, inserted: true };
    } catch (err) {
        console.warn('[billing] user_entitlements insert skipped (' + err.message + ') — apply migration 019 to persist plan columns');
        return { persisted: false, event };
    }
}

// ---------------------------------------------------------------------------
// 4. Webhook orchestration
// ---------------------------------------------------------------------------
async function handleWebhook(input) {
    const i = input || {};
    const secret = process.env.BILLING_WEBHOOK_SECRET;
    if (!secret) return { status: 503, body: { ok: false, error: 'billing_not_configured' } };

    const provider = String(i.provider || '').toLowerCase();
    if (!PROVIDER_RE.test(provider)) return { status: 404, body: { ok: false, error: 'unsupported_provider' } };

    const sig = verifySignature(i.rawBody, i.signature, secret);
    if (!sig.ok) return { status: 401, body: { ok: false, error: sig.error } };

    let payload;
    try { payload = JSON.parse(String(i.rawBody || '')); }
    catch (e) { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }

    const norm = normalizeEvent(payload, provider);
    if (!norm.ok) return { status: 422, body: { ok: false, error: norm.error } };

    const applied = await applyEvent(norm.event);
    if (!applied.ok) return { status: 422, body: { ok: false, error: applied.error } };

    if (!applied.duplicate) {
        console.log('[billing] ' + provider + ' ' + norm.event.type + ' → ' + norm.event.userId + ' plan=' + (applied.plan ? applied.plan.plan : 'none'));
    }
    return {
        status: 200,
        body: {
            ok: true,
            duplicate: !!applied.duplicate,
            event_id: norm.event.eventId,
            plan: applied.plan ? applied.plan.plan : null,
            status: applied.plan ? applied.plan.status : null
        }
    };
}

// ---------------------------------------------------------------------------
// 5. Read model — what the app asks for. Honest: plan access is derived from
//    server/access.js (tester program) or a verified provider record; an
//    expired paid period silently falls back to `standard`.
// ---------------------------------------------------------------------------
async function getSubscription(userId) {
    const Access = require('./access.js');
    let access = null;
    try { access = await Access.getAccessStatus(userId); } catch (e) { access = null; }

    const store = loadStore();
    let record = store.plans[userId] || null;

    // DB record wins when the migration is applied and holds a newer update.
    const pool = db.getPool();
    if (pool) {
        try {
            const r = await pool.query(
                'SELECT plan, plan_status, plan_expires_at, billing_provider, updated_at FROM user_entitlements WHERE user_id = $1',
                [userId]
            );
            if (r.rows.length && r.rows[0].plan) {
                const row = r.rows[0];
                const rowAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
                const localAt = record && record.updatedAt ? new Date(record.updatedAt).getTime() : 0;
                if (rowAt >= localAt) {
                    record = {
                        userId,
                        plan: row.plan,
                        status: row.plan_status || 'active',
                        provider: row.billing_provider || null,
                        currentPeriodEnd: row.plan_expires_at ? new Date(row.plan_expires_at).toISOString() : null,
                        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
                        externalCustomerId: record ? record.externalCustomerId : null
                    };
                }
            }
        } catch (e) { /* column missing → local mirror only */ }
    }

    const periodEnded = record && record.currentPeriodEnd && new Date(record.currentPeriodEnd).getTime() <= Date.now();
    // A canceled subscription keeps its plan until the paid period actually ends.
    const planStillPaid = record && (record.status === 'active' || record.status === 'canceled') && PLANS[record.plan] && !periodEnded;
    let planId = 'standard';
    if (planStillPaid) planId = record.plan;
    else if (access && access.isTester) planId = 'tester';

    const plan = PLANS[planId];
    // `ai` reports what the quota engine ACTUALLY enforces (server/access.js),
    // never a number the user cannot spend. `declaredAi` is what the plan will
    // grant once plan-aware enforcement is switched on for paid plans.
    const ai = access && access.aiUsage
        ? access.aiUsage
        : { tier: plan.tier, used: 0, limit: plan.ai.limit, remaining: plan.ai.limit, isLifetime: plan.ai.mode === 'lifetime' };

    return {
        ok: true,
        configured: configured(),
        provider: record ? record.provider : null,
        plan: plan.id,
        label: plan.label,
        status: record && record.status === 'active' && !periodEnded ? 'active' : (record && record.status ? record.status : 'none'),
        currentPeriodEnd: record ? record.currentPeriodEnd : null,
        expiresAt: access ? access.expiresAt || null : null,
        accessType: access ? access.accessType : 'normal',
        isTester: !!(access && access.isTester),
        ai: {
            tier: ai.tier,
            used: ai.used || 0,
            limit: ai.limit,
            remaining: ai.remaining != null ? ai.remaining : Math.max(0, (ai.limit || 0) - (ai.used || 0)),
            mode: ai.isLifetime ? 'lifetime' : 'monthly'
        },
        declaredAi: { mode: plan.ai.mode, limit: plan.ai.limit },
        features: Object.assign({}, plan.features)
    };
}

function featureEnabled(userIdOrSub, feature) {
    const sub = userIdOrSub && userIdOrSub.features ? userIdOrSub : null;
    if (!sub) return { ok: false, error: 'subscription_required' };
    if (sub.features[feature] === undefined) return { ok: false, error: 'unknown_feature' };
    return { ok: !!sub.features[feature], plan: sub.plan };
}

function listPlans() {
    return Object.keys(PLANS).map(id => ({
        id, label: PLANS[id].label, ai: PLANS[id].ai, features: PLANS[id].features
    }));
}

module.exports = {
    PLANS,
    EVENT_TYPES,
    configured,
    verifySignature,
    signBody,
    normalizeEvent,
    applyEvent,
    handleWebhook,
    getSubscription,
    featureEnabled,
    listPlans,
    STORE_FILE,
    TOLERANCE_MS
};
