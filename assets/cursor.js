/* BattlexJournal — directional smooth cursor follow (landing page)
   ---------------------------------------------------------------------------
   The page hides the system cursor on fine-pointer devices and renders a
   custom SVG pointer (#smooth-cursor-container). This script makes it follow
   the mouse with easing, matching auth.html's implementation. External file
   so it stays allowed under an enforced CSP (script-src 'self').
   --------------------------------------------------------------------------- */
(function () {
    'use strict';
    const cursor = document.getElementById('smooth-cursor-container');
    if (!cursor || !window.matchMedia('(pointer: fine)').matches) return;
    let tx = innerWidth / 2;
    let ty = innerHeight / 2;
    let x = tx;
    let y = ty;
    window.addEventListener('mousemove', e => {
        tx = e.clientX;
        ty = e.clientY;
    });
    (function loop() {
        x += (tx - x) * 0.18;
        y += (ty - y) * 0.18;
        cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px) translate(-50%, -50%)';
        requestAnimationFrame(loop);
    })();
})();