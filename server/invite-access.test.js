'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Set isolated data dir for tests
const TEST_DATA_DIR = path.join(__dirname, '..', 'data', 'test-access-' + Date.now());
process.env.TRADEMIND_AI_DATA_DIR = TEST_DATA_DIR;

const Access = require('./access.js');

test.beforeEach(() => {
    try {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {}
});

test.after(() => {
    try {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {}
});

test('1. Valid code redemption works for Group A and Group B with normalization', async () => {
    // Lowercase with whitespace: "  bxj-2026-a  "
    const userA = 'user-test-01';
    const resA = await Access.redeemInviteCode({ userId: userA, code: '  bxj-2026-a  ' });
    assert.equal(resA.ok, true);
    assert.equal(resA.plan, 'yearly_invite');
    assert.match(resA.message, /1-year BattleXJournal access is now active/);

    const statusA = await Access.getAccessStatus(userA);
    assert.equal(statusA.hasAccess, true);
    assert.equal(statusA.plan, 'yearly_invite');
    assert.equal(statusA.isExpired, false);
    assert.equal(statusA.aiUsage.used, 0);
    assert.equal(statusA.aiUsage.limit, 100);

    // Group B: "BXJ-2026-B"
    const userB = 'user-test-02';
    const resB = await Access.redeemInviteCode({ userId: userB, code: 'BxJ-2026-b' });
    assert.equal(resB.ok, true);
    assert.equal(resB.plan, 'yearly_invite');

    const statusB = await Access.getAccessStatus(userB);
    assert.equal(statusB.hasAccess, true);
});

test('2. Invalid or empty invite code fails cleanly', async () => {
    await assert.rejects(
        () => Access.redeemInviteCode({ userId: 'user-03', code: '' }),
        /Please enter an invite code/
    );

    await assert.rejects(
        () => Access.redeemInviteCode({ userId: 'user-03', code: 'INVALID-CODE-999' }),
        /Invalid invite code/
    );
});

test('3. Same user cannot redeem twice or stack codes (anti-duplicate)', async () => {
    const user = 'user-anti-dup';
    await Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-A' });

    // Attempting to redeem code A again
    await assert.rejects(
        () => Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-A' }),
        /You already have an active BattleXJournal access period/
    );

    // Attempting to redeem code B
    await assert.rejects(
        () => Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-B' }),
        /You already have an active BattleXJournal access period/
    );
});

test('4. 1-Year Expiration is fixed and does not change on subsequent calls', async () => {
    const user = 'user-exp-fixed';
    const res = await Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-A' });
    const originalExpiresAt = res.expires_at;

    const st1 = await Access.getAccessStatus(user);
    assert.equal(st1.expiresAt, originalExpiresAt);

    // Check again
    const st2 = await Access.getAccessStatus(user);
    assert.equal(st2.expiresAt, originalExpiresAt);

    // Verify exactly ~365 days
    const diffDays = Math.round((new Date(originalExpiresAt) - new Date(res.activated_at)) / 86400000);
    assert.equal(diffDays, 365);
});

test('5. Capacity limit: code strictly stops after 30 redemptions', async () => {
    // Fill Group A with 30 users
    for (let i = 1; i <= 30; i++) {
        const res = await Access.redeemInviteCode({ userId: 'cap-user-' + i, code: 'BXJ-2026-A' });
        assert.equal(res.ok, true);
    }

    // 31st user must be rejected
    await assert.rejects(
        () => Access.redeemInviteCode({ userId: 'cap-user-31', code: 'BXJ-2026-A' }),
        /This invite code has reached its 30-user limit/
    );

    // Group B must still have capacity
    const resB = await Access.redeemInviteCode({ userId: 'cap-user-31', code: 'BXJ-2026-B' });
    assert.equal(resB.ok, true);

    const stats = await Access.getInviteStats();
    const groupA = stats.groups.find(g => g.code === 'BXJ-2026-A');
    const groupB = stats.groups.find(g => g.code === 'BXJ-2026-B');
    assert.equal(groupA.usedCount, 30);
    assert.equal(groupA.remaining, 0);
    assert.equal(groupB.usedCount, 1);
    assert.equal(groupB.remaining, 29);
});

test('6. Concurrency / Race Condition Prevention: parallel requests never exceed 30', async () => {
    // Fill 25 slots
    for (let i = 1; i <= 25; i++) {
        await Access.redeemInviteCode({ userId: 'race-pre-' + i, code: 'BXJ-2026-A' });
    }

    // 10 users simultaneously attempt to claim the remaining 5 slots
    const concurrentUsers = Array.from({ length: 10 }, (_, i) => 'race-concurrent-' + (i + 1));
    const results = await Promise.allSettled(
        concurrentUsers.map(u => Access.redeemInviteCode({ userId: u, code: 'BXJ-2026-A' }))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    assert.equal(succeeded, 5); // exactly 5 claimed
    assert.equal(failed, 5);    // exactly 5 rejected with code full

    const stats = await Access.getInviteStats();
    const groupA = stats.groups.find(g => g.code === 'BXJ-2026-A');
    assert.equal(groupA.usedCount, 30); // NEVER exceeds 30
    assert.equal(groupA.remaining, 0);
});

test('7. Server-side AI Quota Enforcement (100 requests/month)', async () => {
    const user = 'user-ai-quota';
    await Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-A' });

    // Simulate 5 AI calls
    for (let i = 0; i < 5; i++) {
        const q = await Access.enforceAiQuota(user);
        assert.equal(q.ok, true);
        assert.equal(q.used, i + 1);
        assert.equal(q.remaining, 100 - (i + 1));
    }

    const st = await Access.getAccessStatus(user);
    assert.equal(st.aiUsage.used, 5);
    assert.equal(st.aiUsage.remaining, 95);
});
