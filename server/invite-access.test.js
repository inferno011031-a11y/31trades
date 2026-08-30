'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('1. Normal user without code starts with 50 lifetime AI requests and is not blocked from app', async () => {
    const user = 'normal-user-01';
    const status = await Access.getAccessStatus(user);
    assert.equal(status.isTester, false);
    assert.equal(status.accessType, 'normal');
    assert.equal(status.aiUsage.tier, 'normal');
    assert.equal(status.aiUsage.used, 0);
    assert.equal(status.aiUsage.limit, 50);
    assert.equal(status.aiUsage.remaining, 50);
    assert.equal(status.aiUsage.isLifetime, true);
});

test('2. Normal user consumes 50 lifetime requests: #50 succeeds, #51 is blocked', async () => {
    const user = 'normal-user-50';

    // Consume 50 requests
    for (let i = 1; i <= 50; i++) {
        const q = await Access.enforceAiQuota(user);
        assert.equal(q.ok, true);
        assert.equal(q.used, i);
        assert.equal(q.remaining, 50 - i);
        assert.equal(q.tier, 'normal');
    }

    // Status shows 0 remaining
    const st = await Access.getAccessStatus(user);
    assert.equal(st.aiUsage.used, 50);
    assert.equal(st.aiUsage.remaining, 0);

    // 51st request must be denied
    await assert.rejects(
        () => Access.enforceAiQuota(user),
        /You have used all 50 lifetime AI requests available on the standard plan/
    );
});

test('3. Normal user count persists across simulated sessions / devices', async () => {
    const user = 'normal-user-persist';
    await Access.enforceAiQuota(user);
    await Access.enforceAiQuota(user);

    const st1 = await Access.getAccessStatus(user);
    assert.equal(st1.aiUsage.used, 2);
    assert.equal(st1.aiUsage.remaining, 48);

    // Subsequent check reads same state
    const st2 = await Access.getAccessStatus(user);
    assert.equal(st2.aiUsage.used, 2);
    assert.equal(st2.aiUsage.remaining, 48);
});

test('4. Tester code redemption for Group A and B with normalization', async () => {
    const userA = 'tester-user-A';
    const resA = await Access.redeemInviteCode({ userId: userA, code: '  bxj-2026-a  ' });
    assert.equal(resA.ok, true);
    assert.equal(resA.access_type, 'tester');
    assert.match(resA.message, /1-year BattleXJournal tester access is now active/);

    const stA = await Access.getAccessStatus(userA);
    assert.equal(stA.isTester, true);
    assert.equal(stA.accessType, 'tester');
    assert.equal(stA.aiUsage.tier, 'tester');
    assert.equal(stA.aiUsage.limit, 100);
    assert.equal(stA.aiUsage.remaining, 100);
    assert.equal(stA.aiUsage.isLifetime, false);

    // Group B
    const userB = 'tester-user-B';
    const resB = await Access.redeemInviteCode({ userId: userB, code: 'BxJ-2026-b' });
    assert.equal(resB.ok, true);
    assert.equal(resB.access_type, 'tester');
});

test('5. Tester user double-redemption is rejected (cannot stack A and B)', async () => {
    const user = 'tester-anti-dup';
    await Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-A' });

    // Try redeeming A again
    await assert.rejects(
        () => Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-A' }),
        /Your tester access is already active/
    );

    // Try redeeming B
    await assert.rejects(
        () => Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-B' }),
        /Your tester access is already active/
    );
});

test('6. Tester 1-year expiration is fixed and does not change on subsequent calls', async () => {
    const user = 'tester-exp-check';
    const res = await Access.redeemInviteCode({ userId: user, code: 'BXJ-2026-A' });
    const originalExpiresAt = res.expires_at;

    const st1 = await Access.getAccessStatus(user);
    assert.equal(st1.expiresAt, originalExpiresAt);

    const diffDays = Math.round((new Date(originalExpiresAt) - new Date(res.activated_at)) / 86400000);
    assert.equal(diffDays, 365);
});

test('7. Capacity enforcement: Group A stops at 30, Group B stops at 30 (60 total)', async () => {
    for (let i = 1; i <= 30; i++) {
        const res = await Access.redeemInviteCode({ userId: 'tester-a-' + i, code: 'BXJ-2026-A' });
        assert.equal(res.ok, true);
    }

    // 31st user on code A fails
    await assert.rejects(
        () => Access.redeemInviteCode({ userId: 'tester-a-31', code: 'BXJ-2026-A' }),
        /This tester code has reached its 30-user limit/
    );

    // But code B still works
    const resB = await Access.redeemInviteCode({ userId: 'tester-b-1', code: 'BXJ-2026-B' });
    assert.equal(resB.ok, true);

    const stats = await Access.getInviteStats();
    assert.equal(stats.groups.find(g => g.code === 'BXJ-2026-A').usedCount, 30);
    assert.equal(stats.groups.find(g => g.code === 'BXJ-2026-B').usedCount, 1);
});

test('8. Concurrency / Race Condition Prevention: simultaneous claims never exceed 30', async () => {
    for (let i = 1; i <= 28; i++) {
        await Access.redeemInviteCode({ userId: 'race-tester-' + i, code: 'BXJ-2026-A' });
    }

    // 6 users simultaneously try to claim the remaining 2 slots
    const concurrentUsers = Array.from({ length: 6 }, (_, i) => 'race-concurrent-' + (i + 1));
    const results = await Promise.allSettled(
        concurrentUsers.map(u => Access.redeemInviteCode({ userId: u, code: 'BXJ-2026-A' }))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    assert.equal(succeeded, 2);
    assert.equal(failed, 4);

    const stats = await Access.getInviteStats();
    assert.equal(stats.groups.find(g => g.code === 'BXJ-2026-A').usedCount, 30);
});
