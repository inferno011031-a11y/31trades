'use strict';

// ============================================================================
// 31TRADES — Auth service (Supabase GoTrue proxy)
// ----------------------------------------------------------------------------
// The browser never talks to Supabase directly: it calls OUR /api/auth/*
// endpoints, which proxy to the project's GoTrue instance using the anon key
// from .env. The client only ever holds the session token; the anon key stays
// server-side.
//
//   signup(email, password, name)  → GoTrue signup (may return a session, or
//                                    just a user when email confirmation is on)
//   login(email, password)         → password grant → session
//   verify(token)                  → validates a token via /auth/v1/user,
//                                    cached 60s; throws {code:401} when invalid
//   logout(token)                  → revokes the session server-side
//
// Error convention: auth failures throw Error with .code = 401 so the server
// can answer 401 (the browser treats it as "session expired → auth.html").
// ============================================================================

function supabaseBase() {
    const raw = process.env.SUPABASE_URL || '';
    let u = raw.trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!u.includes('.')) u += '.supabase.co';
    return u.replace(/\/+$/, '');
}

function anonKey() {
    return process.env.SUPABASE_ANON_KEY || '';
}

async function gotrue(path, { method = 'GET', token, body } = {}) {
    const base = supabaseBase();
    if (!base || !anonKey()) {
        throw Object.assign(new Error('Supabase auth is not configured (SUPABASE_URL / SUPABASE_ANON_KEY missing in .env)'), { code: 500 });
    }
    const headers = { apikey: anonKey(), 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // GoTrue answers 403 for malformed/expired tokens on some endpoints —
        // treat token-bearing auth failures uniformly as 401 so the client's
        // "session expired → auth.html" handling fires.
        const isTokenPath = path === '/auth/v1/user' || path === '/auth/v1/logout';
        const code = isTokenPath && (res.status === 401 || res.status === 403) ? 401 : res.status;
        const msg = data.msg || data.error_description || data.message || data.error || ('GoTrue error ' + res.status);
        throw Object.assign(new Error(String(msg)), { code });
    }
    return data;
}

function pickUser(u) {
    if (!u) return null;
    const meta = u.user_metadata || {};
    return {
        id: u.id,
        email: u.email,
        name: meta.full_name || meta.name || u.raw_user_meta_data?.full_name || '',
        created_at: u.created_at
    };
}

function pickSession(data) {
    // GoTrue returns either a top-level session ({access_token, …}) or a
    // {session: null} envelope when email confirmation is required.
    const token = data.access_token || data.session?.access_token || null;
    const user = pickUser(data.user || data.session?.user);
    if (!token || !user) return null;
    return {
        token,
        refresh_token: data.refresh_token || data.session?.refresh_token || null,
        expires_in: data.expires_in || data.session?.expires_in || null,
        user
    };
}

async function signup({ email, password, name }) {
    if (!email || !password) throw Object.assign(new Error('Email and password are required'), { code: 400 });
    const data = await gotrue('/auth/v1/signup', {
        method: 'POST',
        body: { email, password, data: name ? { full_name: name } : {} }
    });
    return {
        session: pickSession(data),
        needsConfirmation: !data.session && !data.access_token,
        user: pickUser(data.user)
    };
}

async function login({ email, password }) {
    if (!email || !password) throw Object.assign(new Error('Email and password are required'), { code: 400 });
    const data = await gotrue('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password }
    });
    const session = pickSession(data);
    if (!session) {
        throw Object.assign(new Error('Login did not return a session'), { code: 401 });
    }
    return { session };
}

// ---- token verification (cached 60s — avoids hammering GoTrue per request) ----
const verifyCache = new Map();   // token → { user, at }

async function verify(token) {
    if (!token) throw Object.assign(new Error('Authentication required — sign in at /auth.html'), { code: 401 });
    const cached = verifyCache.get(token);
    if (cached && Date.now() - cached.at < 60 * 1000) return cached.user;
    const user = pickUser(await gotrue('/auth/v1/user', { token }));
    if (!user) throw Object.assign(new Error('Invalid session'), { code: 401 });
    verifyCache.set(token, { user, at: Date.now() });
    if (verifyCache.size > 500) {   // bound the cache
        const first = verifyCache.keys().next().value;
        if (first) verifyCache.delete(first);
    }
    return user;
}

function invalidate(token) {
    if (token) verifyCache.delete(token);
}

async function logout(token) {
    if (!token) return;
    invalidate(token);
    try {
        await gotrue('/auth/v1/logout', { method: 'POST', token });
    } catch (e) {
        // session may already be dead — that's a successful logout
    }
}

module.exports = { signup, login, verify, logout, invalidate };
