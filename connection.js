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
        return true;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { if (!init()) setTimeout(init, 300); });
    } else if (!init()) {
        setTimeout(init, 300);
    }
})();
