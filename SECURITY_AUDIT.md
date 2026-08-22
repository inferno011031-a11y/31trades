# BattlexJournal — Comprehensive Security Audit

**Date:** August 19, 2026
**Scope:** Full-stack security assessment of the BattlexJournal web application
**Architecture:** Node.js (vanilla http module) + Supabase (GoTrue auth, PostgreSQL), client-rendered vanilla JS SPA with localStorage-first persistence

---

## Part 1: Frontend / Browser Security Audit

### Executive Summary

BattlexJournal has **zero security headers** and **no Content Security Policy**. Authentication tokens are stored in `localStorage` (vulnerable to XSS exfiltration). The application makes 130+ `innerHTML` assignments across client pages, with inconsistent HTML escaping. A third-party CDN script is loaded without Subresource Integrity. There is no CSRF protection, no CORS configuration, no rate limiting on authentication endpoints, and the static server exposes source files. The application has a documented auth bypass mechanism (`__TRADEMIND_AUTH_BYPASS__`) designed for tests but potentially exploitable.

**Risk Profile: HIGH** — A single DOM XSS in any app page would grant an attacker access to the user's access token, refresh token, and all trading data.

---

### Findings Table

| # | Vulnerability Class | Severity | Affected Area | Likelihood | Impact |
|---|---|---|---|---|---|
| 1 | No Content Security Policy | **Critical** | Entire application | High | XSS payloads execute freely; inline scripts, CDN, and event handlers uncontrolled |
| 2 | Auth tokens in localStorage | **Critical** | `core.js` (session persistence) | Medium | Any XSS immediately exfiltrates access + refresh tokens |
| 3 | No security headers | **Critical** | `server.js` (all responses) | High | Clickjacking, MIME sniffing, protocol downgrade all possible |
| 4 | innerHTML with inconsistent escaping | **High** | All 22 app HTML pages | Medium | DOM-based XSS through user-controlled data reaching innerHTML |
| 5 | No CORS policy | **High** | API routes | Medium | Cross-origin API requests from any origin |
| 6 | No CSRF protection | **High** | All POST endpoints | Medium | State-changing requests possible from attacker-controlled pages |
| 7 | No auth rate limiting | **High** | `/api/auth/login`, `/api/auth/signup`, `/api/auth/forgot` | High | Brute-force and credential stuffing attacks |
| 8 | Third-party CDN without SRI | **High** | All app pages (`unpkg.com/lucide@1.31.0`) | Medium | Supply-chain compromise of Lucide delivers malicious JS to all users |
| 9 | Source maps served from production | **Medium** | Server file serving | Low | Attackers reconstruct application internals |
| 10 | Auth bypass mechanism | **Medium** | `core.js` lines 55-59 | Low | `sessionStorage` key `31trades.auth.bypass=1` disables client auth entirely |
| 11 | OAuth redirect from request Origin | **Medium** | `/api/auth/oauth/start` | Low | Open redirect if Origin header is spoofed |
| 12 | `rejectUnauthorized: false` on DB SSL | **Medium** | `server/db.js` line 23 | Low | MITM on database connection in non-encrypted networks |
| 13 | Sensitive data in localStorage | **Medium** | `core.js` (trades, P&L, state) | Medium | Persistent sensitive data accessible to any XSS or browser extension |
| 14 | Search history in localStorage | **Low** | `core.js` (`_GS_RECENT_KEY`) | Low | Privacy leak if XSS occurs |
| 15 | `uncaughtException` keeps server alive | **Low** | `server.js` lines 1794-1798 | Medium | Corrupted state may persist after unhandled error |

---

### Finding 1: No Content Security Policy (Critical)

**Evidence:** Zero occurrences of `Content-Security-Policy`, `helmet`, or CSP-related headers anywhere in the codebase. Confirmed via search across all `.js` and `.html` files.

**Impact:** Any injected `<script>` tag or inline handler executes without restriction. An attacker can load external scripts, exfiltrate data via image beacons to arbitrary domains, or embed iframes for credential phishing.

**Remediation:**
```js
// Add to server.js — header middleware applied to every response
function securityHeaders(res, req) {
    const origin = process.env.SITE_URL || 'https://31trades-production.up.railway.app';
    
    // CSP: restrict sources to self + approved CDNs
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' https://unpkg.com https://fonts.googleapis.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
    ].join('; '));
    
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0'); // Modern CSP replaces this
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    
    // HSTS (enable after confirming HTTPS on Railway)
    if (origin.startsWith('https://')) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
}
```

**Note:** The `'unsafe-inline'` in `style-src` is needed because app pages use inline `<style>` blocks and `style` attributes. Migrating to nonces or hashes would be ideal but requires significant refactoring of all 22 app pages.

---

### Finding 2: Auth Tokens in localStorage (Critical)

**Evidence (`core.js`):**
```js
// Line 49: tokens stored in localStorage keyed by userId
window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));

// Line 169: full application state (including trades, P&L) persisted to localStorage
window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
```

**Impact:** Any DOM XSS, browser extension, or XSS-via-`innerHTML` vulnerability immediately grants the attacker the user's Bearer token and refresh token. The attacker can then make authenticated API calls to read/modify all trading data.

**Remediation (recommended — phased):**

**Phase 1 (immediate):** Keep the current architecture but add a CSP that blocks inline scripts and restricts script sources (mitigates the XSS that would steal the token).

**Phase 2 (medium-term):** Migrate to `httpOnly` cookies for session tokens:
```js
// server.js — on successful login
res.setHeader('Set-Cookie', 
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`
);
// Remove localStorage token storage on the client
```

**Phase 3 (long-term):** Implement token rotation and short-lived access tokens with server-side session management.

**Tradeoff:** localStorage gives offline-first persistence (the app's core design). Moving tokens to cookies means the client cannot read them, which breaks the current pattern where `core.js` reads the token to add `Authorization` headers. The `core.js` API layer would need to switch to `credentials: 'include'` and the server would extract tokens from cookies.

---

### Finding 3: No Security Headers (Critical)

**Evidence:** The server (`server.js`) sends zero security headers on any response. No `X-Content-Type-Options`, no `X-Frame-Options`, no `Strict-Transport-Security`, no `Referrer-Policy`. The only headers are `Content-Type`, `Cache-Control`, `ETag`, `Vary`, and optionally `Content-Encoding`.

**Impact:** Clickjacking via iframe embedding, MIME-type sniffing leading to XSS, protocol downgrade attacks, and excessive referrer leakage.

**Remediation:** See the `securityHeaders()` function in Finding 1. Apply it as the first middleware in both `handleApi` and `serveStatic`.

---

### Finding 4: innerHTML with Inconsistent Escaping (High)

**Evidence:** 130+ `innerHTML` assignments across the application. Two different `esc()` functions exist:

| File | `esc()` Coverage |
|---|---|
| `core.js` (`_gsEsc`) | Escapes `& < > " '` — good |
| `assets/account-switcher.js` | Escapes only `& < >` — **missing `" and '`** |
| `assets/onboarding.js` | Escapes `& < > " '` — good |
| `assets/trader-card.js` | Escapes `& < > " '` — good |
| `assets/asset-meta.js` | Full escaping — good |
| `server/seo.js` | Escapes `& < > " '` — good |

**Specific unsafe pattern in `core.js` line 325:**
```js
'<svg data-lucide="' + item.icon + '" ...>'
```
The `item.icon` value is injected into an HTML attribute **without escaping**. If an attacker can influence `item.icon` (e.g., through a crafted search result or battle name), this is a direct XSS vector.

**Remediation:**
```js
// Replace the incomplete esc in account-switcher.js
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// In core.js, escape the icon attribute
'<svg data-lucide="' + _gsEsc(item.icon) + '" ...>'
```

---

### Finding 5: No CORS Policy (High)

**Evidence:** Zero occurrences of `Access-Control-Allow-Origin`, `cors`, or `CORS` in the entire codebase. The server accepts requests from any origin.

**Impact:** A malicious page at `evil.com` can make authenticated API requests (with the user's token) to `31trades-production.up.railway.app/api/*` if the user is logged in.

**Remediation:**
```js
// Add to the beginning of handleApi()
function corsMiddleware(req, res) {
    const origin = req.headers.origin;
    const allowed = (process.env.SITE_URL || 'https://31trades-production.up.railway.app');
    
    if (origin && origin === allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }
}
```

---

### Finding 6: No CSRF Protection (High)

**Evidence:** The server relies exclusively on Bearer tokens in the `Authorization` header for authentication. There are no CSRF tokens, no `SameSite` cookie attributes, and no `Origin`/`Referer` header validation.

**Current state:** Because tokens are in localStorage (not cookies), browsers won't automatically attach them to cross-origin requests, which provides *incidental* CSRF protection. However, this protection disappears if tokens are migrated to cookies (Finding 2).

**Remediation (before migrating to cookies):**
```js
// Add Origin/Referer validation for state-changing API requests
function csrfCheck(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const allowed = process.env.SITE_URL || 'https://31trades-production.up.railway.app';
    return origin === allowed || referer.startsWith(allowed);
}
```

---

### Finding 7: No Auth Rate Limiting (High)

**Evidence:** The import endpoints have rate limiting (`Imports.rateLimit`), but the authentication endpoints (`/api/auth/login`, `/api/auth/signup`, `/api/auth/forgot`, `/api/auth/change-password`) have **zero rate limiting**.

**Impact:** Attackers can brute-force passwords, perform credential stuffing attacks, and spam password reset emails without throttling.

**Remediation:**
```js
// In server.js, add to each auth endpoint handler
const loginAttempts = new Map(); // key: email+IP, value: { count, lastAttempt }

function checkRateLimit(key, limit = 5, windowMs = 300000) { // 5 attempts per 5 min
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (entry && now - entry.lastAttempt < windowMs && entry.count >= limit) {
        return false;
    }
    if (!entry || now - entry.lastAttempt >= windowMs) {
        loginAttempts.set(key, { count: 1, lastAttempt: now });
    } else {
        entry.count++;
        entry.lastAttempt = now;
    }
    return true;
}

// In /api/auth/login handler:
const rlKey = `login:${b.email}:${req.socket.remoteAddress}`;
if (!checkRateLimit(rlKey)) {
    return json(res, 429, { error: 'Too many login attempts. Try again in 5 minutes.' });
}
```

---

### Finding 8: Third-Party CDN Without SRI (High)

**Evidence (all app pages):**
```html
<script src="https://unpkg.com/lucide@1.31.0"></script>
```

No `integrity` or `crossorigin` attributes. If unpkg.com is compromised or the CDN serves a tampered version of Lucide, the malicious JavaScript executes with full page context (access to localStorage tokens, DOM, etc.).

**Remediation:**
```html
<script 
    src="https://unpkg.com/lucide@0.263.1/dist/umd/lucide.min.js"
    integrity="sha384-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    crossorigin="anonymous"
></script>
```

Generate the `integrity` hash by downloading the file and running:
```bash
cat lucide.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```

**Better alternative:** Self-host the Lucide bundle:
```bash
cp node_modules/lucide/dist/umd/lucide.min.js assets/lucide.min.js
```
Then reference `/assets/lucide.min.js` — no external dependency, no SRI needed.

---

### Finding 9: Source Maps Served (Low)

**Evidence:** No `.map` files exist in the repository, and the server doesn't have explicit source-map-related code. However, the `cacheFor()` function includes `.map` in its cacheable extensions, meaning if source maps were ever added, they'd be served. Currently not actively exploitable.

**Status:** No action needed now; add a block if source maps are ever generated.

---

### Finding 10: Auth Bypass Mechanism (Medium)

**Evidence (`core.js` lines 55-59):**
```js
const BYPASS = (typeof window.__TRADEMIND_AUTH_BYPASS__ === 'boolean' && window.__TRADEMIND_AUTH_BYPASS__) ||
    (typeof window.sessionStorage !== 'undefined' && window.sessionStorage.getItem('31trades.auth.bypass') === '1');
```

**Impact:** If an attacker can execute JavaScript in the user's browser (via XSS), they can set `sessionStorage.setItem('31trades.auth.bypass', '1')` and refresh the page to bypass all client-side auth checks. This works regardless of whether a real session exists.

**Mitigating factor:** The server still requires valid Bearer tokens for API calls, so the bypass only affects client-side routing, not data access. However, it could be used to access app pages that should require authentication.

**Remediation:** Remove from production builds. Use environment variables or build-time flags:
```js
// Replace with:
const BYPASS = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
```

---

### Finding 11: OAuth Redirect from Request Origin (Medium)

**Evidence (`server.js` line 665):**
```js
const origin = (req.headers.origin || ('http://' + (req.headers.host || 'localhost:3000'))).replace(/\\/+$/, '');
return json(res, 200, auth.oauthStart({ provider: q.get('provider') || 'google', redirectTo: origin + '/auth.html' }));
```

**Impact:** If an attacker can send a request with a spoofed `Origin` header, the OAuth callback would redirect to the attacker's domain with the access token in the URL hash. However, browsers control the `Origin` header on real OAuth flows, making exploitation difficult in practice.

**Remediation:**
```js
// Validate against a whitelist instead of trusting the request
const allowedOrigins = (process.env.SITE_URL || 'https://31trades-production.up.railway.app').split(',').map(s => s.trim());
const redirect = allowedOrigins.includes(origin) ? origin + '/auth.html' : allowedOrigins[0] + '/auth.html';
```

---

### Finding 12: SSL Certificate Verification Disabled (Medium)

**Evidence (`server/db.js` line 23):**
```js
ssl: ssl ? { rejectUnauthorized: false } : false
```

**Impact:** Database connections don't verify SSL certificates, enabling MITM attacks on the PostgreSQL connection in environments where network interception is possible.

**Remediation:**
```js
ssl: ssl ? { rejectUnauthorized: true } : false
```
**Tradeoff:** Supabase's pooler uses self-signed or intermediate CA certificates. Set `rejectUnauthorized: true` only after confirming the correct CA bundle is available, or use Supabase's recommended connection string with the proper SSL mode.

---

### Finding 13: Sensitive Data in localStorage (Medium)

**Evidence:** The core state (`31trades.state.v1.{userId}`) includes trade history, P&L data, risk limits, discipline records, AI conversations, account balances, and strategy definitions — all in plaintext localStorage.

**Impact:** Any browser extension, XSS vulnerability, or shared computer scenario exposes all trading data.

**Remediation:**
1. **Encrypt sensitive fields** before localStorage persistence
2. **Add a session timeout** that clears state after N minutes of inactivity
3. **Warn users** about browser extensions that have access to page data

---

### Finding 15: uncaughtException Keeps Server Alive (Low)

**Evidence (`server.js` lines 1794-1798):**
```js
process.on('uncaughtException', err => {
    console.error('[31trades] UNCAUGHT EXCEPTION (kept alive): ' + (err && err.stack ? err.stack : err));
});
```

**Impact:** After an uncaught exception, the server continues running but may be in a corrupted state (e.g., half-written database, leaked resources). This is the documented cause of 502 errors in the Railway logs.

**Remediation:** Flush pending writes and restart after uncaught exceptions:
```js
process.on('uncaughtException', err => {
    console.error('[31trades] UNCAUGHT EXCEPTION: ' + err.stack);
    shutdown('UNCAUGHT_EXCEPTION');
});
```

---

### Prioritized Action Plan

#### Quick Wins (1-2 days)
1. **Add security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` (Finding 3)
2. **Add auth rate limiting** — simple in-memory counter for login/signup/forgot (Finding 7)
3. **Normalize all `esc()` functions** — use the complete `& < > " '` version everywhere (Finding 4)
4. **Remove auth bypass from production** — gate behind `NODE_ENV=test` (Finding 10)
5. **Self-host Lucide** — eliminate the CDN dependency (Finding 8)

#### Phase 1 (1 week)
6. **Implement CSP** — start with report-only, then enforce (Finding 1)
7. **Add CORS policy** — restrict to `SITE_URL` origin (Finding 5)
8. **Add Origin validation** for OAuth redirect (Finding 11)
9. **Add CSRF Origin/Referer check** for state-changing endpoints (Finding 6)

#### Phase 2 (2-4 weeks)
10. **Migrate tokens to httpOnly cookies** — requires server-side session management (Finding 2)
11. **Encrypt localStorage sensitive fields** (Finding 13)
12. **Enable `rejectUnauthorized: true`** on database SSL (Finding 12)
13. **Add server restart on uncaughtException** (Finding 15)

---

### Do's and Don'ts Checklist for Secure Frontend Development

| ✅ Do | ❌ Don't |
|---|---|
| Use `textContent` or the `esc()` function for all dynamic content | Use `innerHTML` with unescaped user input |
| Validate and escape data at every trust boundary | Trust that "only authenticated users" can provide safe data |
| Use CSP `script-src` with explicit allowlists | Use `'unsafe-inline'` or `'unsafe-eval'` in production |
| Self-host critical third-party scripts | Load scripts from CDNs without SRI |
| Store auth tokens in httpOnly, Secure, SameSite cookies | Store access tokens or refresh tokens in localStorage |
| Rate-limit authentication endpoints | Assume Supabase GoTrue handles all rate limiting |
| Set `X-Frame-Options: DENY` on all pages | Allow your pages to be embedded in iframes |
| Use `encodeURIComponent()` for URL parameters | Construct URLs by string concatenation with raw values |
| Validate Origin/Referer headers on state-changing endpoints | Rely solely on Bearer tokens for CSRF protection |
| Log security events (failed logins, rate limit hits) | Silently drop rate-limited requests |

---

## Part 2: Authentication Design Specification

### 2.1 Access & Refresh Token Strategy

**Current State:** Supabase GoTrue issues JWT access tokens (1 hour default) and refresh tokens. The app stores both in `localStorage` and sends the access token as a Bearer header.

**Recommended Architecture:**

```
┌─────────┐     ┌─────────┐     ┌──────────┐
│ Browser  │────▶│ Server  │────▶│ Supabase │
│ (client) │◀────│ (proxy) │◀────│ (GoTrue) │
└─────────┘     └─────────┘     └──────────┘
     │                │
     │  access_token  │  access_token (verified)
     │  (in cookie)   │  (verified via /auth/v1/user)
     │                │
     │  refresh_token │  refresh_token (proxied)
     │  (httpOnly     │  (proxied to GoTrue)
     │   cookie)      │
```

**Token Configuration:**
- **Access token:** 15 minutes (shortened from GoTrue default of 1 hour)
- **Refresh token:** 7 days, rotating on each use
- **Refresh token reuse detection:** If a previously-used refresh token is presented, invalidate all sessions for that user

**Storage:**
- **Access token:** `httpOnly`, `Secure`, `SameSite=Strict` cookie, `Path=/api`, `Max-Age=900`
- **Refresh token:** `httpOnly`, `Secure`, `SameSite=Strict` cookie, `Path=/api/auth/refresh`, `Max-Age=604800`
- **Never** store tokens in localStorage or sessionStorage

**Token Rotation Flow:**
```
1. Client sends request with expired access token
2. Server detects 401 from Supabase
3. Server reads refresh_token from httpOnly cookie
4. Server calls Supabase /auth/v1/token?grant_type=refresh_token
5. Supabase returns NEW access_token + NEW refresh_token
6. Server sets new cookies, retries the original request
7. If the refresh token was already used → invalidate ALL sessions for this user
```

**Token Revocation:**
- On logout: call GoTrue `/auth/v1/logout` (already implemented in `server/auth.js`)
- On password change: GoTrue invalidates all existing refresh tokens automatically
- On suspected compromise: clear cookies client-side, GoTrue revocation invalidates all sessions

**Must Not:**
- Store tokens in localStorage, sessionStorage, or IndexedDB
- Put tokens in URLs or query parameters
- Include tokens in `Referer` headers (use `Referrer-Policy: same-origin`)
- Send tokens to third-party domains

---

### 2.2 Session Management

**Current State:** Sessions are stateless JWTs verified against Supabase. No idle timeout, no absolute timeout, no device/session management.

**Recommended Implementation:**

**Session Creation:**
- Sessions are created on successful login/signup/OAuth callback
- Each session gets a unique `session_id` claim in the JWT
- Server maintains a session registry (in-memory Map or Redis) mapping `session_id → { userId, createdAt, lastActive, ip, userAgent }`

**Timeouts:**
- **Idle timeout:** 30 minutes — if no API request is made, the session expires
- **Absolute timeout:** 24 hours — regardless of activity, force re-authentication
- **Sliding window:** Each request resets the idle timer

**Session Revocation:**
- On password change: revoke all sessions except the current one
- On explicit logout: revoke the current session
- On suspicious activity: revoke all sessions for the user

**Device/Session Management (future feature):**
```
GET /api/auth/sessions → list active sessions with device, IP, last active
DELETE /api/auth/sessions/:id → revoke a specific session
DELETE /api/auth/sessions → revoke all sessions except current
```

**Implementation pseudocode:**
```js
// server.js middleware
const activeSessions = new Map(); // sessionId → { userId, createdAt, lastActive, ip }

function sessionMiddleware(req, res) {
    const sessionId = extractSessionId(req); // from JWT claims
    const session = activeSessions.get(sessionId);
    
    if (!session) return json(res, 401, { error: 'Session expired' });
    
    const now = Date.now();
    if (now - session.lastActive > 30 * 60 * 1000) { // 30 min idle
        activeSessions.delete(sessionId);
        return json(res, 401, { error: 'Session expired due to inactivity' });
    }
    if (now - session.createdAt > 24 * 60 * 60 * 1000) { // 24h absolute
        activeSessions.delete(sessionId);
        return json(res, 401, { error: 'Session expired — please sign in again' });
    }
    
    session.lastActive = now;
    // proceed with request
}
```

---

### 2.3 Authentication Mechanisms

**Current State:** Email/password via Supabase GoTrue + Google OAuth. No MFA/passkeys.

**Recommended Additions:**

**MFA/TOTP (Time-based One-Time Password):**
- Use Supabase's built-in MFA: `supabase.auth.mfa.enroll()`, `supabase.auth.mfa.challenge()`, `supabase.auth.mfa.verify()`
- Require MFA for:
  - Users with more than 100 trades logged (high data value)
  - Password change operations
  - OAuth account linking
  - Any admin-level operation (if admin roles are added)

**WebAuthn/Passkeys (future):**
- Leverage Supabase's WebAuthn support or implement via a library like `@simplewebauthn/server`
- Benefits: phishing-resistant, no shared secrets, works across devices

**Reauthentication for Critical Actions:**
```
Trigger reauthentication when:
  - User changes email address
  - User changes password
  - User deletes account
  - User exports all data
  - User links/unlinks OAuth provider
```

**Implementation:**
```js
// Middleware for sensitive operations
function requireRecentAuth(req, res, next) {
    const lastAuth = req.session.lastAuthAt;
    if (Date.now() - lastAuth > 5 * 60 * 1000) { // 5 minutes
        return json(res, 403, { 
            error: 'REAUTH_REQUIRED',
            message: 'This action requires recent authentication. Please sign in again.' 
        });
    }
    next();
}
```

**Must Not:**
- Skip MFA for "convenience" on high-risk operations
- Store MFA secrets in localStorage
- Allow MFA bypass through client-side flags

---

### 2.4 Attack Protections

**Current State:** No login rate limiting. No bot detection. No suspicious login detection.

**Login Rate Limiting:**
```js
// Per-email rate limiting (prevents targeted brute-force)
const loginAttempts = new Map();
// Key: email → { attempts: [{timestamp, success}], lockedUntil }

function checkLoginRateLimit(email, ip) {
    const key = email.toLowerCase();
    const entry = loginAttempts.get(key) || { attempts: [], lockedUntil: 0 };
    
    // Check lockout
    if (entry.lockedUntil > Date.now()) {
        const waitMinutes = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
        return { allowed: false, error: `Account locked. Try again in ${waitMinutes} minutes.` };
    }
    
    // Clean old attempts (last 15 minutes)
    entry.attempts = entry.attempts.filter(a => Date.now() - a.timestamp < 15 * 60 * 1000);
    
    // Progressive lockout
    const recentFailures = entry.attempts.filter(a => !a.success).length;
    if (recentFailures >= 5) {
        entry.lockedUntil = Date.now() + (15 * 60 * 1000); // 15 min lockout
        loginAttempts.set(key, entry);
        return { allowed: false, error: 'Account temporarily locked due to multiple failed attempts.' };
    }
    
    // Global IP-based rate limit (100 attempts per 15 min per IP)
    const ipKey = `ip:${ip}`;
    const ipEntry = loginAttempts.get(ipKey) || { attempts: [] };
    ipEntry.attempts = ipEntry.attempts.filter(a => Date.now() - a.timestamp < 15 * 60 * 1000);
    if (ipEntry.attempts.length >= 100) {
        return { allowed: false, error: 'Too many requests. Please try again later.' };
    }
    ipEntry.attempts.push({ timestamp: Date.now() });
    loginAttempts.set(ipKey, ipEntry);
    
    loginAttempts.set(key, entry);
    return { allowed: true };
}
```

**Credential Stuffing Protection:**
- Implement a simple CAPTCHA (e.g., hCaptcha) after 3 failed login attempts
- Use Turnstile (Cloudflare) for invisible bot detection

**Suspicious Login Detection:**
```js
function assessLoginRisk(user, req) {
    const riskScore = 0;
    const ip = req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';
    
    // New IP (not seen in last 30 days)
    if (!recentIPs(user.id).includes(ip)) riskScore += 2;
    
    // New User-Agent
    if (!recentUAs(user.id).includes(ua)) riskScore += 1;
    
    // Login at unusual hour (user's typical pattern)
    const hour = new Date().getHours();
    if (isUnusualHour(user.id, hour)) riskScore += 1;
    
    // Impossible travel (two logins from distant IPs within minutes)
    if (hasImpossibleTravel(user.id, ip)) riskScore += 5;
    
    return {
        score: riskScore,
        requireMFA: riskScore >= 3,
        blockLogin: riskScore >= 7,
        notifyUser: riskScore >= 2
    };
}
```

**Must Not:**
- Return "email not found" vs "wrong password" (use a generic "Invalid credentials")
- Store failed login attempt details in client-accessible responses
- Allow unlimited password reset email sends

---

### 2.5 Password Security

**Current State:** Passwords are hashed by Supabase GoTrue (uses bcrypt with 10 rounds). Minimum password length: 6 characters.

**Recommended Policies:**

**Password Requirements:**
- Minimum 12 characters (OWASP 2024 recommendation)
- Require at least 3 of: uppercase, lowercase, numbers, special characters
- Check against breached password databases (HaveIBeenPwned API)
- Block common passwords (use a list like `passwords_top_100k`)

**Password Hashing (server-side if handling passwords directly):**
```js
// Use Argon2id (OWASP recommended)
const argon2 = require('argon2');

const hashOptions = {
    type: argon2.argon2id,
    memoryCost: 65536,    // 64 MB
    timeCost: 3,          // 3 iterations
    parallelism: 4,       // 4 threads
    saltLength: 16,       // 16 bytes salt
    hashLength: 32        // 32 bytes output
};

async function hashPassword(password) {
    return argon2.hash(password, hashOptions);
}

async function verifyPassword(password, hash) {
    return argon2.verify(hash, password);
}
```

**Secure Password Reset Flow:**
```
1. User requests reset → POST /api/auth/forgot
2. Server generates cryptographically random token (32 bytes, hex-encoded)
3. Server stores: { tokenHash: sha256(token), userId, expiresAt: now + 1 hour, used: false }
4. Server emails link: https://app.com/auth.html#reset&token={raw_token}&type=recovery
5. User clicks link → client extracts token from URL hash
6. Client calls POST /api/auth/reset-password with { token, newPassword }
7. Server:
   a. Hashes the submitted token
   b. Finds matching record where used=false and expiresAt > now
   c. Marks record as used
   d. Updates password
   e. Invalidates all existing sessions for this user
   f. Sends "Your password was changed" notification email
```

**Must Not:**
- Use sequential or predictable token values
- Allow password reset tokens to be used more than once
- Skip the "password changed" notification email
- Accept passwords shorter than 12 characters
- Log plaintext passwords in any log file

---

### 2.6 Secrets Management

**Current State:** All secrets are in `.env` (gitignored). The Supabase anon key is only on the server (proxied). The `SUPABASE_SERVICE_ROLE_KEY` is defined in `.env.example` but never used in code (good). The `GEMINI_API_KEY` is used server-side only.

**Policy:**

| Secret | Where | How |
|---|---|---|
| `SUPABASE_URL` | Server only | `.env` / Railway env vars |
| `SUPABASE_ANON_KEY` | Server only (proxied) | `.env` / Railway env vars |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only (not used in code) | `.env` / Railway env vars |
| `SUPABASE_DB_URL` | Server only | `.env` / Railway env vars |
| `GEMINI_API_KEY` | Server only | `.env` / Railway env vars |
| JWT signing secret | GoTrue managed | Supabase dashboard |

**Frontend Must Never Contain:**
- Database connection strings
- API keys (Gemini, FMP, etc.)
- Supabase service role key
- JWT signing secrets
- User passwords
- Session tokens (other than the signed JWT in the httpOnly cookie)

**Current Risk:** The Supabase anon key is designed to be public (it's the "anonymous" key), but it's proxied through the server which is good practice. The `.env.example` correctly documents `SUPABASE_SERVICE_ROLE_KEY` as "NEVER ship this to the browser."

**Recommendation:** Consider using Railway's built-in secrets management or a vault service (e.g., HashiCorp Vault) for production, rather than relying solely on environment variables.

---

### 2.7 Threat Model Summary

| # | Threat | Controls | Status |
|---|---|---|---|
| 1 | **Phishing** | OAuth with Supabase (verified provider), no password in URL | ⚠️ Partial — no MFA |
| 2 | **Credential Stuffing** | Rate limiting on login, progressive lockout, CAPTCHA | ❌ Not implemented |
| 3 | **Token Theft (XSS)** | CSP headers, httpOnly cookies, token rotation | ❌ No CSP, tokens in localStorage |
| 4 | **Session Fixation** | Supabase GoTrue issues fresh tokens on login | ✅ Handled by GoTrue |
| 5 | **Brute Force** | Per-account and per-IP rate limiting, account lockout | ❌ Not implemented |
| 6 | **Leaked Secrets** | `.env` gitignored, server-side proxy, no client-side keys | ✅ Good |
| 7 | **Man-in-the-Middle** | HTTPS (Railway), HSTS header | ⚠️ HSTS not set |
| 8 | **DOM XSS** | HTML escaping (`esc()`), CSP | ⚠️ Inconsistent escaping, no CSP |
| 9 | **Clickjacking** | `X-Frame-Options: DENY` | ❌ Not set |
| 10 | **Supply Chain** | Self-hosted dependencies, SRI on CDN | ⚠️ CDN without SRI |

---

## Part 3: Backend Authorization Guide

### Core Principle: Never Trust the Frontend

The frontend can be modified, bypassed, or impersonated. Every authorization check **must** happen on the server. Hiding a UI element is not security — it's UX.

### Authorization Flow

Every API request must pass through these checks:

```
1. Is the user authenticated? (valid Bearer token → Supabase GoTrue verification)
2. Is the user authorized for this endpoint? (RBAC: does the role permit this action?)
3. Does the user own this resource? (Object-level: is resource.userId === requestingUser.id?)
4. Is the action allowed based on current attributes? (ABAC: account status, subscription, rate limits)
```

### Implementation Pattern

```js
// server.js — Authorization middleware

// 1. Authentication (already implemented)
async function requireAuth(req) {
    const token = bearerToken(req);
    if (!token) throw { code: 401, message: 'Authentication required' };
    return auth.verify(token); // returns user object from Supabase
}

// 2. Role-based access control
const ROLES = {
    free:     ['read:own_trades', 'write:own_trades', 'read:own_analytics'],
    pro:      ['read:own_trades', 'write:own_trades', 'read:own_analytics', 'read:ai_mentor', 'write:ai_mentor'],
    admin:    ['read:all_users', 'write:all_users', 'read:system_metrics', 'write:system_config']
};

function requireRole(...allowedRoles) {
    return async (req) => {
        const user = await requireAuth(req);
        const userRole = user.user_metadata?.role || 'free';
        if (!allowedRoles.includes(userRole)) {
            throw { code: 403, message: 'Insufficient permissions' };
        }
        return user;
    };
}

// 3. Object-level authorization (ownership check)
async function requireOwnership(req, resourceType) {
    const user = await requireAuth(req);
    const resourceId = extractResourceId(req); // from URL params
    
    // Server-side ownership verification — NEVER trust client-provided userId
    const resource = await db.getResource(resourceType, resourceId);
    if (!resource) throw { code: 404, message: 'Resource not found' };
    if (resource.userId !== user.id) {
        throw { code: 403, message: 'Access denied' };
    }
    return { user, resource };
}

// 4. Function-level authorization
function requirePermission(permission) {
    return async (req) => {
        const user = await requireAuth(req);
        const role = user.user_metadata?.role || 'free';
        const perms = ROLES[role] || [];
        if (!perms.includes(permission)) {
            throw { code: 403, message: `Permission denied: ${permission}` };
        }
        return user;
    };
}
```

### Concrete Example: `GET /api/users/123/private-data`

```js
// INSECURE (current pattern — client sends userId, server trusts it)
if (p.match(/^\/api\/users\/([^/]+)\/private-data$/)) {
    const userId = m[1]; // ← this is the userId from the URL
    const data = await db.getUserData(userId); // ← WRONG: no ownership check
    return json(res, 200, data);
}

// SECURE
if (p.match(/^\/api\/users\/([^/]+)\/private-data$/)) {
    try {
        const user = await requireAuth(req);           // Check 1: authenticated?
        const requestedId = m[1];
        
        // Check 2: authorized for this endpoint? (all authenticated users can access their own data)
        
        // Check 3: owns this resource?
        if (requestedId !== user.id) {
            return json(res, 403, { error: 'Access denied' });
        }
        
        // Check 4: action allowed based on attributes?
        // (e.g., is the account in good standing?)
        
        const data = await db.getUserData(user.id); // Use SERVER-resolved user.id, not URL param
        return json(res, 200, data);
    } catch (err) {
        return json(res, err.code || 500, { error: err.message });
    }
}
```

### Tenant Isolation

BattlexJournal is single-tenant per user (each user has their own data partition). The isolation boundary is `userId`:

```js
// Every data access must be scoped to the authenticated user
function userPartition(userId) {
    return path.join(DATA_DIR, `db-${userId}.json`);
}

// API handlers must ALWAYS use the server-resolved userId
app.get('/api/trades', async (req, res) => {
    const user = await requireAuth(req);
    const trades = loadTrades(user.id); // ← user.id from Supabase, not from query params
    return json(res, 200, trades);
});
```

### Privilege Escalation Protection

```js
// Never allow users to modify their own role
// Bad:
app.put('/api/user/profile', async (req, res) => {
    const user = await requireAuth(req);
    // ❌ User can set role: 'admin' in the request body
    await updateUser(user.id, req.body); 
});

// Good:
app.put('/api/user/profile', async (req, res) => {
    const user = await requireAuth(req);
    // Only allow safe fields to be updated
    const allowed = pick(req.body, ['name', 'theme', 'currency']);
    await updateUser(user.id, allowed);
});
```

### Admin Separation

If admin functionality is added:
- Admin routes under `/api/admin/*` require `admin` role
- Admin role is assigned server-side only (via Supabase dashboard or database)
- Admin endpoints have additional logging and audit trails
- Admin sessions have shorter timeouts (15 min idle, 4h absolute)

### Common Anti-Patterns

| ❌ Insecure | ✅ Secure |
|---|---|
| Client sends `userId` in request body, server trusts it | Server resolves `userId` from the Bearer token |
| `if (user.role === 'admin') showAdminUI()` | `if (!user.admin) return 403` on the server |
| Hide admin routes in the frontend | Server returns 403 for unauthorized access regardless of UI |
| Check authorization once at login | Check authorization on every request |
| Store role in localStorage and check client-side | Store role in JWT claims, verify server-side |
| Use `userId` from URL params for data access | Use `userId` from authenticated session for data access |
| Single shared API key for all server calls | Per-service keys with least-privilege scopes |

---

## Part 4: API Security Checklist

### Treat Every Endpoint as Hostile Territory

Every API endpoint is an attack surface. An attacker can send any request, with any payload, from any origin. Server-side validation is the only defense.

### Checklist

#### Schema Validation & Input Validation

- [ ] **Validate all request bodies** against a defined schema (use a library like `joi`, `zod`, or hand-written validation)
- [ ] **Reject unexpected fields** — don't forward unknown properties to database operations
- [ ] **Validate content types** — reject requests with unexpected `Content-Type` headers
- [ ] **Validate URL parameters** — check format, length, and allowed values
- [ ] **Validate query strings** — apply the same rigor as body fields

```js
// Example: validate trade creation payload
function validateTrade(body) {
    const errors = [];
    if (!body.symbol || typeof body.symbol !== 'string') errors.push('symbol is required');
    if (body.symbol && body.symbol.length > 20) errors.push('symbol too long');
    if (!['long', 'short'].includes(body.direction)) errors.push('direction must be long or short');
    if (typeof body.entryPrice !== 'number' || body.entryPrice <= 0) errors.push('invalid entryPrice');
    if (typeof body.exitPrice !== 'number') errors.push('invalid exitPrice');
    if (body.riskAmount != null && (typeof body.riskAmount !== 'number' || body.riskAmount < 0)) {
        errors.push('invalid riskAmount');
    }
    if (errors.length) throw { code: 400, message: errors.join('; ') };
    return body; // sanitized
}
```

#### Output Encoding

- [ ] **Always set `Content-Type` explicitly** on responses
- [ ] **JSON responses:** Set `Content-Type: application/json` and validate that the response is valid JSON
- [ ] **Never reflect user input in HTML responses** without escaping
- [ ] **Sanitize error messages** — don't leak stack traces, SQL errors, or internal paths to clients

#### Request Size Limits

```js
// In server.js, before reading body:
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                reject(Object.assign(new Error('Request body too large'), { code: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(Object.assign(new Error('Invalid JSON'), { code: 400 }));
            }
        });
        req.on('error', reject);
    });
}
```

#### Rate Limiting & Throttling

- [ ] **Global rate limit:** 1000 requests per minute per IP
- [ ] **Per-endpoint rate limits:**
  - `/api/auth/login`: 5 attempts per 5 minutes per email
  - `/api/auth/signup`: 3 per hour per IP
  - `/api/auth/forgot`: 3 per hour per email
  - `/api/imports/upload`: 10 per minute per user (already implemented)
  - `/api/imports/commit`: 10 per minute per user (already implemented)
  - `/api/ai/*`: 30 per minute per user
- [ ] **Return `429 Too Many Requests`** with `Retry-After` header

#### Authentication

- [ ] **Every API endpoint** (except `/api/auth/*`, `/api/health`, and static assets) requires a valid Bearer token
- [ ] **Token verification** happens server-side on every request (currently implemented via `auth.verify()` with 60s cache)
- [ ] **Invalid tokens** return `401 Unauthorized` — not `403 Forbidden`
- [ ] **Expired tokens** trigger refresh flow (client-side), not silent failure

#### Authorization

- [ ] **Check permissions on every request** — not just at login
- [ ] **Object-level authorization** — verify resource ownership before returning/modifying data
- [ ] **Function-level authorization** — verify the user's role permits the specific operation
- [ ] **Never rely on client-side checks** — hiding UI elements is not authorization

#### Replay Protection

- [ ] **Idempotency keys** for state-changing operations that might be retried:
  ```js
  // Client sends: Idempotency-Key: <uuid>
  // Server stores key → response mapping for 24 hours
  // Duplicate requests return the original response
  ```
- [ ] **CSRF tokens** for browser-based form submissions (if cookies are used for auth)

#### Pagination & Query Limits

- [ ] **Maximum page size:** 100 items (enforce server-side)
- [ ] **Default page size:** 25 items
- [ ] **Maximum query range:** 1 year of trades per request
- [ ] **Never return entire database** — always paginate

```js
function paginate(query, { page = 1, limit = 25, maxLimit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(1, limit), maxLimit);
    const offset = (Math.max(1, page) - 1) * safeLimit;
    return { limit: safeLimit, offset };
}
```

#### Timeout Constraints

- [ ] **Request timeout:** 30 seconds for API requests
- [ ] **Database query timeout:** 10 seconds
- [ ] **External API timeout:** 15 seconds (Gemini, Supabase GoTrue)
- [ ] **WebSocket ping/pong:** 30 seconds

#### API Versioning

- [ ] **URL-based versioning:** `/api/v1/...` (currently not versioned)
- [ ] **Never break existing clients** — deprecate endpoints with a 6-month sunset period
- [ ] **Version the response schema** — include `"version": "1.0"` in response metadata

#### Abuse Detection

- [ ] **Log all failed authentication attempts** with IP, User-Agent, and timestamp
- [ ] **Detect credential stuffing** — alert on >50 failed logins per IP per hour
- [ ] **Detect data scraping** — alert on >500 GET requests per user per minute
- [ ] **Monitor for anomalous patterns** — sudden spike in API usage from a single account

#### CORS Restrictions

- [ ] **Only allow the production domain** as `Access-Control-Allow-Origin`
- [ ] **Never use `*`** for `Access-Control-Allow-Origin` in production
- [ ] **Restrict `Access-Control-Allow-Methods`** to only the methods each endpoint supports
- [ ] **Restrict `Access-Control-Allow-Headers`** to `Content-Type` and `Authorization`
- [ ] **Set `Access-Control-Max-Age`** to reduce preflight requests

#### HTTP Method Restrictions

- [ ] **Only allow the correct HTTP method** for each endpoint
- [ ] **Return `405 Method Not Allowed`** for incorrect methods
- [ ] **Support OPTIONS** for CORS preflight requests

```js
function requireMethod(req, res, allowed, handler) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Allow': allowed.join(', ') });
        return res.end();
    }
    if (!allowed.includes(req.method)) {
        return json(res, 405, { error: `Method ${req.method} not allowed. Use ${allowed.join(' or ')}.` });
    }
    return handler();
}
```

#### Response Size Limits

- [ ] **Never return the full user object** in list endpoints — select only needed fields
- [ ] **Truncate large text fields** (AI responses, notes) in list views
- [ ] **Compress large responses** with gzip/brotli (already implemented for static assets)

```js
// Select only safe fields from user object
function safeUser(u) {
    return { id: u.id, email: u.email, name: u.name, created_at: u.created_at };
    // Never include: password_hash, internal_notes, raw_metadata
}
```

#### Ongoing Monitoring & Threat Detection

- [ ] **Track API response times** — detect slowloris attacks
- [ ] **Monitor error rates** — spike in 5xx errors may indicate an attack
- [ ] **Log all admin operations** with timestamp, user, and action
- [ ] **Set up alerts** for:
  - >10 failed logins per minute from a single IP
  - >100 requests per second from a single IP
  - Any request to a non-existent endpoint (reconnaissance)
  - Any attempt to access `/data/`, `/server/`, `/.env` (already blocked)

---

## Summary of All Files Created / Modified

| File | Purpose |
|---|---|
| `SECURITY_AUDIT.md` | This report |
| `server.js` | **Needs security headers middleware** (see Finding 1) |
| `server/auth.js` | Needs rate limiting integration (see Finding 7) |
| `server/db.js` | `rejectUnauthorized: false` flagged (see Finding 12) |
| `core.js` | localStorage token storage flagged (see Finding 2), auth bypass flagged (see Finding 10) |
| All 22 app `.html` pages | Need SRI on Lucide script tag (see Finding 8) |
| `assets/account-switcher.js` | Incomplete `esc()` function (see Finding 4) |

---

*This audit was performed through static code analysis of the BattlexJournal codebase. Dynamic testing (penetration testing) is recommended to validate these findings and discover runtime-specific vulnerabilities.*
