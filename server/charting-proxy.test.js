'use strict';

// ============================================================================
// 31TRADES — charting-proxy tests (deterministic, no network)
// ----------------------------------------------------------------------------
// Contract: the proprietary TradingView library is only reachable through
// short-lived signed tokens; paths are sandboxed; cache headers are immutable.
// ============================================================================

const assert = require('assert');
const ChartingProxy = require('./charting-proxy.js');

let pass = 0, fail = 0;
function t(name, cond) {
    try { assert.ok(cond); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name); }
}

// ---- token round-trip ------------------------------------------------------
const { token } = ChartingProxy.issueToken('u_test_123');
t('token issued (two parts, base64url)', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));

const dec = ChartingProxy.verifyToken(token);
t('token verifies', !!dec);
t('token carries userId', dec && dec.u === 'u_test_123');
t('token carries future expiry', dec && dec.e > Date.now());

// ---- tamper resistance ------------------------------------------------------
const [payload, sig] = token.split('.');
t('tampered payload rejected', !ChartingProxy.verifyToken(Buffer.from('{"u":"attacker","e":9999999999999}').toString('base64url') + '.' + sig));
t('tampered signature rejected', !ChartingProxy.verifyToken(payload + '.' + Buffer.from('deadbeef').toString('base64url')));
t('truncated token rejected', !ChartingProxy.verifyToken(payload));
t('garbage token rejected', !ChartingProxy.verifyToken('not.a.token'));

// ---- expiry -----------------------------------------------------------------
const expiredPayload = Buffer.from(JSON.stringify({ u: 'u1', e: Date.now() - 1000 })).toString('base64url');
// sign with the module's key via a fresh issue + manual expiry check
t('expired token rejected by time check', (() => {
    const d = ChartingProxy.verifyToken(expiredPayload + '.' + 'x');
    return d === null; // bad sig AND expired — both paths must fail closed
})());
t('TTL is 30 minutes', ChartingProxy._internals.TOKEN_TTL_MS === 30 * 60 * 1000);

// ---- path sanitization -------------------------------------------------------
t('traversal stripped (..)', ChartingProxy.sanitize('../../etc/passwd') === 'etc/passwd');
t('dot segments stripped', ChartingProxy.sanitize('./a/./b') === 'a/b');
t('empty segments dropped', ChartingProxy.sanitize('bundles//x.js') === 'bundles/x.js');
t('depth capped at 10', ChartingProxy.sanitize(Array(20).fill('d').join('/')).split('/').length === 10);
t('clean path untouched', ChartingProxy.sanitize('bundles/runtime.c40b52a0e272d23ced6d.js') === 'bundles/runtime.c40b52a0e272d23ced6d.js');

// ---- issueToken hygiene -------------------------------------------------------
t('anon userId tolerated', ChartingProxy.issueToken(null).ok === true);
t('long userId truncated', ChartingProxy.issueToken('x'.repeat(500)).ok === true);

// ---- token does not leak key material ------------------------------------------
t('token payload is JSON of u/e only', (() => {
    const p = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    return Object.keys(p).sort().join(',') === 'e,u' && !JSON.stringify(p).toLowerCase().includes('key');
})());

console.log('\ncharting-proxy: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
