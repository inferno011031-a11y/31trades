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

    function init() {
        const chips = Array.from(document.querySelectorAll('.session-chip'));
        if (!chips.length) return false;
        const core = window.TradeMindCore;

        function render(online) {
            chips.forEach(chip => {
                const dot = chip.querySelector('.conn-dot');
                if (dot) {
                    dot.style.background = online ? '#10B981' : '#F59E0B';
                    dot.style.boxShadow = online ? '0 0 0 3px rgba(16,185,129,0.15)' : '0 0 0 3px rgba(245,158,11,0.15)';
                }
                // Replace the trailing text node ("Connected") without touching icons.
                let textNode = Array.from(chip.childNodes).find(n => n.nodeType === 3);
                const label = ' ' + (online ? 'Connected' : 'Local only');
                if (textNode) textNode.textContent = label;
                else chip.insertAdjacentText('beforeend', label);
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
