'use strict';

// ============================================================================
// 31TRADES — Battle WebSocket Hub
// ----------------------------------------------------------------------------
// Real-time push for Online Battles: participants subscribe to a battle by id
// and receive cursor/status events the moment they happen server-side, instead
// of polling. The Dashboard feed subscribes with no battle id and receives a
// lightweight 'feed.changed' ping whenever any battle mutates, so the feed can
// re-fetch. Only public state is ever pushed — private seat decisions are
// still fetched over authed REST, so nothing leaks across seats.
// ============================================================================

const { WebSocketServer } = require('ws');
const Battle = require('./battle.js');

const rooms = new Map();          // battleId -> Set<ws>
const feedClients = new Set();    // ws without a battle (dashboard feed)
let wss = null;

function attach(httpServer) {
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws, req) => {
        let battleId = null;
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            battleId = url.searchParams.get('battle');
        } catch (e) { /* keep nulls */ }

        ws.battleId = battleId;
        // The query string is untrusted and must never identify a user. Battle
        // rooms only carry public snapshots; private seat state stays on the
        // authenticated REST endpoints.
        ws.user = null;

        if (battleId) {
            if (!rooms.has(battleId)) rooms.set(battleId, new Set());
            rooms.get(battleId).add(ws);
        } else {
            feedClients.add(ws);
        }

        ws.on('close', () => {
            if (ws.battleId && rooms.has(ws.battleId)) {
                rooms.get(ws.battleId).delete(ws);
                if (!rooms.get(ws.battleId).size) rooms.delete(ws.battleId);
            }
            feedClients.delete(ws);
        });
        ws.on('error', () => { try { ws.close(); } catch (e) {} });
    });

    // One subscription to the battle engine: any mutation → push to the room.
    Battle.subscribe((type, b) => {
        let payload = null;
        try {
            if (type === 'cursor') {
                // every room update carries the policy-filtered participant
                // projection, so opponent presence/status stays in step with the
                // shared cursor without any private seat data on the wire.
                payload = {
                    type: 'battle.cursor', battle: b.id, cursor: b.cursor, status: b.status,
                    lifecycle: b.lifecycle, stateRevision: b.stateRevision,
                    participants: b.participants(null)
                };
            } else if (type === 'seat') {
                // a seat acted: the room learns THAT it moved (plus whatever the
                // visibility policy allows) — never the private decision itself.
                const last = (b.actions && b.actions[b.actions.length - 1]) || {};
                payload = {
                    type: 'battle.seat', battle: b.id, seat: last.seat || null, kind: last.type || null,
                    cursor: b.cursor, status: b.status, lifecycle: b.lifecycle,
                    stateRevision: b.stateRevision, participants: b.participants(null)
                };
            } else if (type === 'status' || type === 'created') {
                const pub = b.publicState();
                payload = { type: 'battle.status', battle: b.id, state: pub };
            } else if (type === 'challenges') {
                // no battle room — the dashboard/feed clients re-read instead
                payload = { type: 'challenges.changed' };
            }
        } catch (e) { payload = null; }
        if (payload) {
            const room = rooms.get(b.id);
            if (room) room.forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); });
        }
        // every mutation also pings the dashboard feed
        const ping = JSON.stringify({ type: 'feed.changed' });
        feedClients.forEach(ws => { if (ws.readyState === 1) ws.send(ping); });
    });

    return wss;
}

function broadcastFeed() {
    if (!wss) return;
    const ping = JSON.stringify({ type: 'feed.changed' });
    wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(ping); });
}

function broadcastUser(userId, message) {
    // User-targeted delivery requires authenticated upgrade handling. Until the
    // WebSocket handshake shares the HTTP auth verifier, fail closed rather than
    // trusting a spoofable ?user= query parameter.
    return false;
}

module.exports = { attach, broadcastFeed, broadcastUser };
