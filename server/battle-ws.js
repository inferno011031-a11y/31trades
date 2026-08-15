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
        let battleId = null, user = null;
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            battleId = url.searchParams.get('battle');
            user = url.searchParams.get('user');
        } catch (e) { /* keep nulls */ }

        ws.battleId = battleId;
        ws.user = user || 'anon';

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
                payload = { type: 'battle.cursor', battle: b.id, cursor: b.cursor, status: b.status };
            } else if (type === 'status' || type === 'created' || type === 'seat') {
                const pub = b.publicState();
                payload = { type: 'battle.status', battle: b.id, state: pub };
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

module.exports = { attach, broadcastFeed };
