/* ============================================================================
   31TRADES — Connection indicator
   ----------------------------------------------------------------------------
   Reflects the real backend state in the topbar's "Connected" chip:
     · green dot + "Connected"  — API reachable, mutations replaying to it
     · amber dot + "Local only" — offline, local-first (data kept in the
                                   browser; reconciled on reconnect)
   Listens to the shared core's 'backend.online' / 'backend.offline' events
   and reads the current status on load (in case the event fired first).
   ========================================================================== */
(function () {
    'use strict';

    function updateSessionClock() {
        const chip = document.getElementById('session-chip-text');
        if (chip) {
            const d = new Date();
            const h = d.getHours();
            const session = (h >= 7 && h < 12) ? 'London' : (h >= 12 && h < 18) ? 'New York' : 'Asia';
            chip.textContent = session + ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        }
    }

    function init() {
        updateSessionClock();
        setInterval(updateSessionClock, 1000);

        const dots = Array.from(document.querySelectorAll('.conn-dot'));
        if (!dots.length) return false;
        const core = window.TradeMindCore;

        function render(online) {
            dots.forEach(dot => {
                dot.style.background = online ? '#10B981' : '#F59E0B';
                dot.style.boxShadow = online ? '0 0 0 2px rgba(16,185,129,0.2)' : '0 0 0 2px rgba(245,158,11,0.2)';
                const chip = dot.closest('.session-chip') || dot.parentElement;
                if (chip) {
                    let label = chip.querySelector('.conn-label');
                    if (!label) {
                        // Clean out loose text nodes in the connection chip
                        Array.from(chip.childNodes).forEach(n => {
                            if (n.nodeType === 3) n.remove();
                        });
                        label = document.createElement('span');
                        label.className = 'conn-label';
                        chip.appendChild(label);
                    }
                    label.textContent = online ? 'Connected' : 'Local only';
                }
            });
        }

        if (core && core.TradeMindBus) {
            core.TradeMindBus.subscribe('backend.online', () => render(true));
            core.TradeMindBus.subscribe('backend.offline', () => render(false));
            render(typeof core.isBackendOnline === 'function' ? core.isBackendOnline() : false);
        } else {
            render(false);
        }

        // Real-time server push listener: connects to /ws to receive instant ledger updates
        // from other tabs, devices, or server-side automated trades / backfills.
        let wsConn = null;
        let wsPingTimer = null;
        function connectLiveWs() {
            try {
                if (wsConn) { wsConn.close(); wsConn = null; }
                if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
            } catch (e) {}

            try {
                const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const host = window.location.host;
                if (!host) return;
                const c = window.TradeMindCore;
                const user = (c && c.session && c.session.user && c.session.user.id) ? c.session.user.id : 'anon';
                wsConn = new WebSocket(proto + '//' + host + '/ws?user=' + encodeURIComponent(user));
            } catch (e) { wsConn = null; return; }

            wsConn.onmessage = function (ev) {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg && msg.type === 'ledger.changed') {
                        const c = window.TradeMindCore;
                        if (c && typeof c.syncWithServer === 'function') {
                            c.syncWithServer(true);
                        }
                    }
                } catch (e) {}
            };
            wsConn.onclose = function () {
                wsConn = null;
                setTimeout(connectLiveWs, 5000);
            };
            wsConn.onerror = function () {
                try { wsConn.close(); } catch (e) {}
            };
            wsPingTimer = setInterval(function () {
                if (wsConn && wsConn.readyState === 1) wsConn.send('ping');
            }, 30000);
        }

        connectLiveWs();
        return true;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { if (!init()) setTimeout(init, 300); });
    } else if (!init()) {
        setTimeout(init, 300);
    }
})();
