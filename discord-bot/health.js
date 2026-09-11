'use strict';

// ============================================================================
// BATTLEXJOURNAL — Health endpoint for Render / platform probes
// ----------------------------------------------------------------------------
// Render needs an HTTP port. The bot process serves a minimal status page on
// process.env.PORT so the platform health check passes. No secrets exposed.
// ============================================================================

const http = require('node:http');

function startHealthServer(port, statusFn) {
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            const s = statusFn();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, service: 'battlexjournal-discord-bot', ...s }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
    });
    server.listen(port, '0.0.0.0', () => {
        console.log('[health] listening on 0.0.0.0:' + port);
    });
    return server;
}

module.exports = { startHealthServer };
