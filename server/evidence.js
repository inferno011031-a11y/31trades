'use strict';

const MAX_LABEL = 160;
const MAX_URL = 2048;
const KINDS = new Set(['screenshot', 'chart', 'document', 'link']);

function normalizeEvidence(input) {
    const x = input && typeof input === 'object' ? input : {};
    const kind = String(x.kind || 'screenshot').toLowerCase();
    if (!KINDS.has(kind)) return { ok: false, error: 'unsupported evidence kind' };
    const url = String(x.url || '').trim();
    if (!url || url.length > MAX_URL) return { ok: false, error: 'evidence url required' };
    let parsed;
    try { parsed = new URL(url); } catch (e) { return { ok: false, error: 'evidence url is invalid' }; }
    if (!['https:', 'http:'].includes(parsed.protocol)) return { ok: false, error: 'evidence must use http or https' };
    // Never allow javascript/data/blob URLs or user-controlled storage paths.
    const label = String(x.label || '').trim().slice(0, MAX_LABEL);
    return { ok: true, evidence: { kind, url, label, created_at: new Date().toISOString() } };
}

function attachToTrade(trade, input) {
    const normalized = normalizeEvidence(input);
    if (!normalized.ok) return normalized;
    const prior = Array.isArray(trade.evidence) ? trade.evidence : [];
    if (prior.some(e => e && e.url === normalized.evidence.url)) return { ok: true, duplicate: true, evidence: prior, added: null };
    if (prior.length >= 12) return { ok: false, error: 'maximum of 12 evidence items per trade reached' };
    const evidence = prior.concat(normalized.evidence);
    return { ok: true, duplicate: false, evidence, added: normalized.evidence };
}

module.exports = { normalizeEvidence, attachToTrade };
