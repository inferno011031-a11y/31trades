'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DATA_DIR = path.join(__dirname, '..', 'data', 'test-admin-' + Date.now());
process.env.TRADEMIND_AI_DATA_DIR = TEST_DATA_DIR;

const Admin = require('./admin.js');

test.beforeEach(() => {
    try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
});

test.after(() => {
    try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
});

test('1. Admin login rejects invalid username / password', () => {
    assert.throws(
        () => Admin.adminLogin({ username: 'fake', password: 'wrong' }),
        /Invalid admin credentials/
    );
});

test('2. Admin login succeeds with valid credentials and issues pre-auth token for 2FA', () => {
    const res = Admin.adminLogin({
        username: 'battlex_admin',
        password: 'BattleXAdmin@2026'
    });
    assert.equal(res.ok, true);
    assert.equal(res.requires2FA, true);
    assert.ok(res.preAuthToken);
});

test('3. 2FA verification rejects incorrect PIN', () => {
    const loginRes = Admin.adminLogin({
        username: 'battlex_admin',
        password: 'BattleXAdmin@2026'
    });
    assert.throws(
        () => Admin.adminVerify2FA({ preAuthToken: loginRes.preAuthToken, pin: '000000' }),
        /Invalid 2FA Master PIN/
    );
});

test('4. 2FA verification succeeds with correct PIN and returns 24-hour admin session', () => {
    const loginRes = Admin.adminLogin({
        username: 'battlex_admin',
        password: 'BattleXAdmin@2026'
    });
    const verifyRes = Admin.adminVerify2FA({
        preAuthToken: loginRes.preAuthToken,
        pin: '882026'
    });
    assert.equal(verifyRes.ok, true);
    assert.ok(verifyRes.adminToken);
    assert.equal(verifyRes.username, 'battlex_admin');

    // Verify session
    const sess = Admin.verifyAdminSession(verifyRes.adminToken);
    assert.ok(sess);
    assert.equal(sess.username, 'battlex_admin');
});

test('5. Metrics aggregation returns real telemetry data', async () => {
    const metrics = await Admin.getDashboardMetrics('30d');
    assert.ok(typeof metrics.totalUsers === 'number');
    assert.ok(typeof metrics.newUsers === 'number');
    assert.ok(metrics.activeUsers);
    assert.ok(metrics.aiRequests);
    assert.ok(metrics.testers);
    assert.equal(metrics.testers.max, 60);
});

test('6. User list query supports pagination and search', async () => {
    const list = await Admin.getUsersList({ page: 1, limit: 10 });
    assert.ok(Array.isArray(list.users));
    assert.ok(typeof list.total === 'number');
    assert.equal(list.page, 1);
    assert.equal(list.limit, 10);
});

test('7. Admin logout revokes session', () => {
    const loginRes = Admin.adminLogin({
        username: 'battlex_admin',
        password: 'BattleXAdmin@2026'
    });
    const verifyRes = Admin.adminVerify2FA({
        preAuthToken: loginRes.preAuthToken,
        pin: '882026'
    });
    const token = verifyRes.adminToken;
    assert.ok(Admin.verifyAdminSession(token));

    Admin.adminLogout(token);
    assert.equal(Admin.verifyAdminSession(token), null);
});
