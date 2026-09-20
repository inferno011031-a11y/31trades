'use strict';

// ============================================================================
// 31TRADES — State reconciliation (browser + Node, same code path)
// ----------------------------------------------------------------------------
// WHY THIS EXISTS
// The browser shell used to reconcile its localStorage snapshot with the server
// by comparing TRADE COUNTS:
//
//     if (serverTradeCount >= localTradeCount) adopt server
//     else  POST the entire local state over the server
//
// A count is not a recency signal. A stale browser snapshot that merely happened
// to hold MORE trades would overwrite the server wholesale — notes, records and
// every other field included. That is data loss, and it happened for real: a
// note + recomputed R on one trade were reverted by a client push that never
// went through TradeService.update (no audit entry was written for it).
//
// THE RULE HERE
// Reconciliation is RECORD by RECORD and compares CONTENT with the server,
// instead of counting trades. Every record present on both sides is classified
// against the CLIENT'S BASELINE — the hashes of the server's copies as this
// client last saw them (hashState) — with the modified stamp as a tie-breaker:
//
//   identical to the server         → keep the server's copy (the common case)
//   this client changed it, the
//   server did not                  → keep local AND push (real offline work)
//   the server changed it, this
//   client did not                  → keep the SERVER's (stale browser protected)
//   BOTH changed (true conflict)    → the later modified stamp wins; an unusable
//                                     stamp pair keeps the SERVER's copy
//   no baseline for that record     → same stamp rule; unusable → the SERVER's
//   present only on the server      → keep it, never push it
//   present only locally            → keep it and push it (real offline work)
//
// The merged result is always a SUPERSET of the server state, so the caller can
// safely send it back in one POST — merging first is what makes the whole-state
// write safe.
//
// WHY CONTENT AND NOT TIMESTAMPS
// The store cannot be trusted to carry comparable timestamps: Postgres writes
// updated_at but never maps it back on read, the JSON mirror keeps only what a
// client sent, and the shared core never writes one at all. So "did the server
// change this?" is answered by comparing content against the baseline — no
// clock, no schema change and no coordination between machines required.
// Client-side stamps are still maintained (stampChanged) so a genuine conflict
// can be resolved by whoever edited later, and so reloading a page can never be
// mistaken for staleness.
//
// STAMPS FOR THIS CLIENT'S OWN EDITS (stampChanged)
// The rules above can only protect the server when a client can PROVE its copy
// is newer. The shared core never writes updated_at, so every local record would
// otherwise look unstamped — and unstamped loses to the server, which silently
// discards real offline edits. That is the same bug facing the other way.
//
// stampChanged() derives the stamps by DIFFING the current snapshot against the
// last snapshot this client held, record by record:
//
//   · content unchanged  → carry the previous stamp across (this is the same
//                          edit as before, so it must not look newer)
//   · content changed    → this client edited it → stamp with `now`
//   · new record         → stamp with `now`
//   · removed record     → dropped (deletions never flow through a merge)
//
// A stale snapshot that nobody edited therefore gets NO fresh stamps and can
// never out-rank the server. `updated_at` is ignored while comparing content (it
// is the value being computed), which also makes the function idempotent.
//
// Deliberate limitations (documented, not accidental):
//   · Deletions are not merged — a record the server still has is kept. Removing
//     data flows through the explicit DELETE endpoints, never through a sync.
//   · Clock skew between machines can mis-order two edits made in the same
//     second; ties therefore resolve to the server, never to the client.
//   · Two clients editing the SAME record while both are ahead of the server is
//     a genuine conflict: the later stamp wins and the loser's field edit is
//     overwritten. That is last-write-wins, and it is inherent to stamping.
//   · EVENT_LOG is append-only and has no id — it is unioned by content, so
//     audit history from either side survives.
// ============================================================================

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;   // Node / tests
    if (root) root.TradeMindMerge = api;                                      // Browser
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {

    // Keyed collections, in the order the stores are reconciled. `stamp` lists
    // the fields that can prove "this record was modified later", most reliable
    // first. A record with none of them is treated as unstamped (server wins).
    const STORES = [
        { key: 'Accounts',            id: 'id', stamp: ['updated_at', 'created_at'] },
        { key: 'ConfigVersions',      id: 'id', stamp: ['updated_at', 'created_at'] },
        { key: 'StrategyAssignments', id: 'id', stamp: ['updated_at', 'active_from'] },
        { key: 'StrategyMaster',      id: 'id', stamp: ['updated_at', 'created_at'] },
        { key: 'RuleSetMaster',       id: 'id', stamp: ['updated_at', 'created_at'] },
        { key: 'Trades',              id: 'id', stamp: ['updated_at', 'created_at'] },
        { key: 'TradeEvaluations',    id: 'id', stamp: ['updated_at', 'evaluatedAt', 'evaluated_at'] },
        { key: 'Violations',          id: 'id', stamp: ['updated_at', 'createdAt', 'created_at'] },
        { key: 'EVENT_LOG',           appendOnly: true, dedupe: ['entity', 'what', 'detail', 'at'] }
    ];

    const STATE_KEYS = STORES.map(s => s.key);

    // A stamp is only usable when it parses to a real time. Anything else
    // (missing, null, '', 'nonsense') counts as "no stamp" → not newer.
    function stampOf(record, fields) {
        if (!record || !fields) return NaN;
        for (const f of fields) {
            const v = record[f];
            if (v === undefined || v === null || v === '') continue;
            const t = new Date(v).getTime();
            if (!isNaN(t)) return t;
        }
        return NaN;
    }

    function isLocalNewer(local, server, fields) {
        const l = stampOf(local, fields);
        const s = stampOf(server, fields);
        // Strictly newer, and only when both sides can prove when they changed.
        // No stamp on either side → the server keeps its record.
        return !isNaN(l) && !isNaN(s) && l > s;
    }

    function rowsOf(state, key) {
        return (state && Array.isArray(state[key])) ? state[key] : [];
    }

    // Does this state hold anything at all? An empty server means "first run",
    // which is the ONE case where pushing local state wholesale is correct.
    function hasData(state) {
        if (!state) return false;
        return STATE_KEYS.some(k => rowsOf(state, k).length > 0);
    }

    function dedupeKey(row, fields) {
        return fields.map(f => String(row && row[f] !== undefined ? row[f] : '')).join('\u0001');
    }

    // Canonical, key-order-independent serialisation of a record's CONTENT.
    // `updated_at` is excluded at every level: it is the value being computed,
    // so counting it as content would make every comparison "changed".
    function recordContent(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(recordContent).join(',') + ']';
        const keys = Object.keys(value).filter(k => k !== 'updated_at').sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + recordContent(value[k])).join(',') + '}';
    }

    // Stamp the records this client edited, carrying every other stamp forward.
    // Returns { state, stamped } — `stamped` names the records whose content
    // changed since `previous` (useful for logging and assertions).
    function stampChanged(input) {
        const previous = (input && input.previous) || null;
        const next = (input && input.next) || {};
        const now = (input && input.now) || new Date().toISOString();
        const stamped = [];
        const out = Object.assign({}, next);

        STORES.forEach(store => {
            if (store.appendOnly) return;               // unioned by content, never stamped
            const before = new Map();
            rowsOf(previous, store.key).forEach(r => { if (r && r.id !== undefined) before.set(r.id, r); });

            out[store.key] = rowsOf(next, store.key).map(rec => {
                if (!rec || typeof rec !== 'object') return rec;
                const prev = before.get(rec.id);
                const unchanged = !!prev && recordContent(prev) === recordContent(rec);
                const stamp = unchanged ? prev.updated_at : now;
                if (!unchanged) stamped.push({ store: store.key, id: rec.id === undefined ? null : rec.id });
                if (stamp === undefined || stamp === rec.updated_at) return rec;
                return Object.assign({}, rec, { updated_at: stamp });
            });
        });

        return { state: out, stamped };
    }

    // ---- Content hashes: how this client remembers the server's copies --------
    // The reconciliation compares CONTENT, not clocks: for every record on both
    // sides it asks "did I change this since I last synced, and did the server?".
    // The second half needs a baseline — the server's copies as this client last
    // knew them. Hashes keep that small (a few KB for hundreds of records) and
    // survive the store's unreliable timestamps.
    function contentHash(record) {
        const s = recordContent(record);
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }

    // { store: { id: contentHash } } — persisted by the caller after every
    // successful sync, so an edit made in an earlier session is still provable.
    function hashState(state) {
        const out = {};
        STORES.forEach(store => {
            if (store.appendOnly) return;               // unioned by content
            const map = {};
            rowsOf(state, store.key).forEach(r => {
                if (r && r.id !== undefined) map[r.id] = contentHash(r);
            });
            out[store.key] = map;
        });
        return out;
    }

    function mergeStates(input) {
        const server = (input && input.server) || {};
        const local = (input && input.local) || {};
        // Hashes of the server's copies as this client last saw them (hashState).
        // Absent on a first run or a cleared store — the stamp rule still applies.
        const baseline = (input && input.baseline) || null;
        const merged = {};
        const push = [];
        const stats = {
            serverOnly: 0, localOnly: 0, identical: 0, serverKept: 0,
            localEdited: 0, serverEdited: 0, localNewer: 0,
            conflictServerWon: 0, unproven: 0, logAdded: 0
        };

        // First run: nothing on the server yet → the local state IS the truth.
        if (!hasData(server)) {
            STATE_KEYS.forEach(k => { merged[k] = rowsOf(local, k).slice(); });
            STORES.forEach(store => {
                rowsOf(local, store.key).forEach(row => {
                    push.push({ store: store.key, id: row.id || null, reason: 'server-empty' });
                });
            });
            merged.selectedAccountId = local.selectedAccountId !== undefined ? local.selectedAccountId : null;
            return { merged, push, stats, decision: 'initial-push' };
        }

        STORES.forEach(store => {
            const serverRows = rowsOf(server, store.key);
            const localRows = rowsOf(local, store.key);

            // ---- append-only stores (EVENT_LOG): union by content ----
            if (store.appendOnly) {
                const seen = new Set();
                const out = [];
                serverRows.forEach(r => { seen.add(dedupeKey(r, store.dedupe)); out.push(r); });
                localRows.forEach(r => {
                    const k = dedupeKey(r, store.dedupe);
                    if (seen.has(k)) return;
                    seen.add(k);
                    out.push(r);
                    stats.logAdded++;
                    push.push({ store: store.key, id: null, reason: 'log-entry-local-only' });
                });
                merged[store.key] = out;
                return;
            }

            // ---- keyed stores: record-level, content-compared ----
            const baseMap = (baseline && baseline[store.key]) || {};
            const out = [];
            const seen = new Set();

            // server order first, so the server's ordering is preserved
            serverRows.forEach(srv => {
                seen.add(srv.id);
                const loc = localRows.find(r => r && r.id === srv.id);
                if (!loc) { stats.serverOnly++; out.push(srv); return; }

                const srvHash = contentHash(srv);
                const locHash = contentHash(loc);
                if (srvHash === locHash) {           // same record, nothing to decide
                    stats.identical++; stats.serverKept++; out.push(srv); return;
                }

                const base = baseMap[srv.id];
                const known = base !== undefined;      // the client has synced this record before
                const localEdited = known && base !== locHash;
                const serverEdited = known && base !== srvHash;

                // Only this client changed it → its edit stands and is pushed.
                if (localEdited && !serverEdited) {
                    stats.localEdited++;
                    out.push(loc);
                    push.push({ store: store.key, id: loc.id, reason: 'local-edited' });
                    return;
                }
                // Only the server changed it → the stale copy loses, silently.
                if (serverEdited && !localEdited) {
                    stats.serverEdited++; stats.serverKept++;
                    out.push(srv);
                    return;
                }
                // A true conflict (both changed) or no baseline for this record:
                // fall back to the modified stamp. An unusable stamp pair keeps the
                // SERVER — an unprovable client never out-ranks it.
                if (isLocalNewer(loc, srv, store.stamp)) {
                    stats.localNewer++;
                    out.push(loc);
                    push.push({ store: store.key, id: loc.id, reason: known ? 'conflict-local-newer' : 'local-newer' });
                } else {
                    stats.serverKept++;
                    if (localEdited && serverEdited) stats.conflictServerWon++;
                    else stats.unproven++;
                    out.push(srv);
                }
            });

            // local-only records — genuine offline work, protected from the server
            localRows.forEach(loc => {
                if (!loc || loc.id === undefined || seen.has(loc.id)) return;
                stats.localOnly++;
                out.push(loc);
                push.push({ store: store.key, id: loc.id, reason: 'local-only' });
            });

            merged[store.key] = out;
        });

        // Selection is cosmetic: keep the server's when it still exists, so two
        // tabs converge on the same account.
        const accounts = merged.Accounts || [];
        const serverSel = server.selectedAccountId;
        const localSel = local.selectedAccountId;
        merged.selectedAccountId = accounts.some(a => a.id === serverSel) ? serverSel
            : (accounts.some(a => a.id === localSel) ? localSel : null);

        const decision = push.length ? 'merged-and-pushed' : 'adopted-server';
        return { merged, push, stats, decision };
    }

    // Every server record must survive (except server-only ordering nuances) —
    // the property that makes the whole-state write safe. Exposed so callers and
    // tests can assert it rather than trust it.
    function mergedCoversServer(plan, server) {
        if (!plan || !plan.merged) return false;
        return STORES.every(store => {
            const serverRows = rowsOf(server, store.key);
            const mergedRows = rowsOf(plan.merged, store.key);
            if (store.appendOnly) {
                const have = new Set(mergedRows.map(r => dedupeKey(r, store.dedupe)));
                return serverRows.every(r => have.has(dedupeKey(r, store.dedupe)));
            }
            const have = new Set(mergedRows.map(r => r && r.id));
            return serverRows.every(r => have.has(r && r.id));
        });
    }

    return {
        STORES, STATE_KEYS, hasData, stampOf, isLocalNewer,
        recordContent, stampChanged, contentHash, hashState, mergeStates, mergedCoversServer
    };
});
