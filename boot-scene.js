/* ============================================================================ 
   BATTLEX TERMINAL BOOT — blueprint scene builder
   Draws + animates the terminal assembling itself (panels → tools → candles)
   on a blueprint canvas. Pure canvas 2D, no dependencies.

   window.buildBootScene(canvas, onProgress)          → terminal layout
   window.buildBootScene(canvas, onProgress, 'dashboard') → backtesting dashboard layout

   'dashboard' preset: header bar → stat cards row → trades table skeleton
   → analytics donut → month cards grid, then the neon glow pass.
   ==========================================================================*/
(function () {
  'use strict';
  function buildBootScene(canvas, onProgress, presetName) {
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      W = canvas.clientWidth || window.innerWidth;
      H = canvas.clientHeight || window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const onRz = () => resize();
    window.addEventListener('resize', onRz);

    /* ---------- geometry presets (normalized 0..1 coords) ---------- */
    const IS_DASH = presetName === 'dashboard';
    const parts = IS_DASH ? [
      { k: 'dhead', r: [0.015, 0.030, 0.970, 0.075] },  // page header / title bar
      { k: 'stat',  r: [0.015, 0.130, 0.230, 0.150] },  // stat cards row
      { k: 'stat',  r: [0.258, 0.130, 0.230, 0.150] },
      { k: 'stat',  r: [0.501, 0.130, 0.230, 0.150] },
      { k: 'stat',  r: [0.744, 0.130, 0.230, 0.150] },
      { k: 'table', r: [0.015, 0.305, 0.585, 0.560] },  // trades table
      { k: 'donut', r: [0.615, 0.305, 0.370, 0.270] },  // analytics donut
      { k: 'months',r: [0.615, 0.590, 0.370, 0.275] }   // month cards mini-grid
    ] : [
      { k: 'top',    r: [0.015, 0.030, 0.970, 0.055] },   // top toolbar
      { k: 'left',   r: [0.015, 0.105, 0.042, 0.760] },   // drawing toolbar
      { k: 'chart',  r: [0.072, 0.105, 0.780, 0.760] },   // main chart pane
      { k: 'right',  r: [0.866, 0.105, 0.119, 0.760] },   // watchlist panel
      { k: 'bottom', r: [0.015, 0.880, 0.970, 0.090] },   // bottom bar / HUD dock
      { k: 'hud',    r: [0.610, 0.150, 0.230, 0.300] }    // execution HUD card
    ];
    const CHART_PART = IS_DASH ? 5 : 2;   // index of the pane that gets candles
    const ACC = '#22e5b4', ACC2 = '#2f7bff', INK = 'rgba(139,149,161,';

    /* ---------- animated candle mini-series inside the chart pane ---------- */
    const CANDLES = [];
    (function () {
      let p = 100;
      for (let i = 0; i < 26; i++) {
        const drift = Math.sin(i * 0.55) * 6 + (Math.random() * 4 - 2);
        const o = p, c = p + drift + 1.2;
        CANDLES.push({ o, c, h: Math.max(o, c) + 1.5 + Math.random() * 2.5, l: Math.min(o, c) - 1.5 - Math.random() * 2.5 });
        p = c;
      }
    })();

    /* ---------- timeline (seconds) ---------- */
    const T = {
      grid: [0.15, 1.1],       // blueprint grid fades in
      panel: [0.35, 2.0],      // wireframe panels draw on (stroke sweep)
      tools: [1.5, 2.6],       // tool icons + watchlist rows pop
      candles: [2.2, 4.1],     // candles stamp in
      glow: [3.6, 4.6]         // neon glow pass over everything
    };
    const DUR = 4.6;
    const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
    const seg = (t, a, b) => clamp01((t - a) / (b - a));
    const ease = q => 1 - Math.pow(1 - q, 3); // easeOutCubic

    let t0 = null, raf = 0, alive = true;
    function frame(ts) {
      if (!alive) return;
      if (t0 === null) t0 = ts;
      const t = (ts - t0) / 1000;
      draw(t);
      if (onProgress) onProgress(Math.min(1, t / DUR));
      if (t < DUR + 0.4) raf = requestAnimationFrame(frame);
    }

    function draw(t) {
      ctx.clearRect(0, 0, W, H);

      /* --- blueprint grid --- */
      const gA = seg(t, T.grid[0], T.grid[1]);
      if (gA > 0) {
        ctx.save();
        ctx.globalAlpha = gA * 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.045)';
        ctx.lineWidth = 1;
        const s = 46;
        ctx.beginPath();
        for (let x = (W / 2) % s; x < W; x += s) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        for (let y = (H / 2) % s; y < H; y += s) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
        ctx.restore();
      }

      /* --- panels: wireframe stroke sweep --- */
      const pA = seg(t, T.panel[0], T.panel[1]);
      parts.forEach((p, pi) => {
        const local = clamp01((pA - pi * 0.09) / 0.55);
        if (local <= 0) return;
        const e = ease(local);
        const x = p.r[0] * W, y = p.r[1] * H, w = p.r[2] * W, h = p.r[3] * H;
        const half = 2 * (w + h), drawn = half * e;
        ctx.save();
        ctx.strokeStyle = ACC; ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.55 + 0.35 * e;
        ctx.setLineDash([half]); ctx.lineDashOffset = half - drawn;
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        // faint fill once drawn
        ctx.globalAlpha = 0.05 * e;
        ctx.fillStyle = ACC;
        ctx.fillRect(x, y, w, h);
        ctx.restore();

        /* --- tools / contents --- */
        const tA = seg(t, T.tools[0], T.tools[1]);
        if (p.k === 'left' && tA > 0) {           // drawing toolbar icons
          const n = 9;
          for (let i = 0; i < n; i++) {
            const li = clamp01((tA - i * 0.055) / 0.3);
            if (li <= 0) continue;
            ctx.save(); ctx.globalAlpha = li * 0.8;
            ctx.strokeStyle = INK + (0.9) + ')'; ctx.lineWidth = 1.3;
            const iy = y + 16 + i * ((h - 24) / n), ix = x + w / 2;
            ctx.beginPath();
            if (i % 3 === 0) { ctx.moveTo(ix - 5, iy + 4); ctx.lineTo(ix + 5, iy - 4); }        // trend line
            else if (i % 3 === 1) { ctx.rect(ix - 4.5, iy - 4.5, 9, 9); }                        // rectangle
            else { ctx.moveTo(ix - 5, iy + 3); ctx.arc(ix, iy - 2, 4.2, 0.35 * Math.PI, 2.6 * Math.PI); } // fib/arc
            ctx.stroke(); ctx.restore();
          }
        }
        if (p.k === 'stat' && tA > 0) {           // dashboard stat cards: label + big number
          const li = ease(tA);
          ctx.save(); ctx.globalAlpha = li * 0.5;
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x + 14, y + 16, (w - 28) * 0.5, 4);
          ctx.globalAlpha = li * 0.85;
          ctx.fillRect(x + 14, y + h - 34, (w - 28) * 0.42, 12);
          ctx.fillStyle = pi % 2 ? 'rgba(8,153,129,.75)' : 'rgba(242,54,69,.7)';
          ctx.fillRect(x + 14 + (w - 28) * 0.55, y + h - 30, (w - 28) * 0.22, 5);
          ctx.restore();
        }
        if (p.k === 'table' && tA > 0) {          // trades table skeleton rows
          for (let i = 0; i < 7; i++) {
            const li = clamp01((tA - i * 0.05) / 0.3);
            if (li <= 0) continue;
            ctx.save(); ctx.globalAlpha = li * 0.5;
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            const ry = y + 16 + i * ((h - 26) / 7);
            ctx.fillRect(x + 12, ry, (w - 24) * 0.3, 4);
            ctx.fillStyle = i % 2 ? 'rgba(8,153,129,.8)' : 'rgba(242,54,69,.75)';
            ctx.fillRect(x + 12 + (w - 24) * 0.78, ry, (w - 24) * 0.12, 4);
            ctx.restore();
          }
        }
        if (p.k === 'donut' && tA > 0) {          // analytics donut sweep
          const li = ease(clamp01((tA - 0.1) / 0.7));
          if (li > 0) {
            ctx.save(); ctx.globalAlpha = li;
            const cx = x + w / 2, cy = y + h / 2 + 6, R = Math.min(w, h) * 0.3;
            ctx.lineWidth = R * 0.42;
            ctx.strokeStyle = 'rgba(255,255,255,0.07)';
            ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
            ctx.strokeStyle = ACC;
            ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * 0.68 * li); ctx.stroke();
            ctx.strokeStyle = ACC2;
            ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2 + 2 * Math.PI * 0.68 * li, -Math.PI / 2 + 2 * Math.PI * li); ctx.stroke();
            ctx.restore();
          }
        }
        if (p.k === 'months' && tA > 0) {         // month cards mini-grid
          for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
            const li = clamp01((tA - (r * 3 + c) * 0.045) / 0.28);
            if (li <= 0) continue;
            ctx.save(); ctx.globalAlpha = li * 0.55;
            ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
            const cw = (w - 26) / 3, chh = (h - 24) / 2;
            ctx.strokeRect(x + 10 + c * (cw + 3), y + 10 + r * (chh + 4), cw, chh);
            ctx.fillStyle = r === 0 ? 'rgba(8,153,129,.8)' : 'rgba(242,54,69,.7)';
            ctx.fillRect(x + 16 + c * (cw + 3), y + 10 + r * (chh + 4) + chh - 9, cw * 0.4, 3);
            ctx.restore();
          }
        }
        if (p.k === 'dhead' && tA > 0) {          // dashboard header: tabs + title
          const li = ease(tA);
          ctx.save(); ctx.globalAlpha = li * 0.6;
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x + 14, y + h / 2 - 3, (w - 28) * 0.22, 6);
          for (let i = 0; i < 3; i++) {
            ctx.globalAlpha = li * (i === 0 ? 0.9 : 0.4);
            ctx.strokeStyle = i === 0 ? ACC : 'rgba(255,255,255,0.3)';
            ctx.strokeRect(x + w - 250 + i * 80, y + h / 2 - 9, 70, 18);
          }
          ctx.restore();
        }
        if (p.k === 'right' && tA > 0) {          // watchlist rows
          for (let i = 0; i < 7; i++) {
            const li = clamp01((tA - i * 0.05) / 0.3);
            if (li <= 0) continue;
            ctx.save(); ctx.globalAlpha = li * 0.55;
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fillRect(x + 10, y + 14 + i * ((h - 22) / 7), (w - 20) * 0.55, 3);
            ctx.fillStyle = i % 3 ? 'rgba(242,54,69,.8)' : 'rgba(8,153,129,.9)';
            ctx.fillRect(x + 10 + (w - 20) * 0.62, y + 14 + i * ((h - 22) / 7), (w - 20) * 0.2, 3);
            ctx.restore();
          }
        }
        if (p.k === 'hud' && tA > 0) {            // HUD: buy/sell blocks
          const li = ease(tA);
          ctx.save(); ctx.globalAlpha = li;
          ctx.fillStyle = 'rgba(8,153,129,.75)';
          ctx.fillRect(x + 10, y + h - 34, (w - 30) / 2, 16);
          ctx.fillStyle = 'rgba(242,54,69,.75)';
          ctx.fillRect(x + 20 + (w - 30) / 2, y + h - 34, (w - 30) / 2, 16);
          ctx.restore();
        }
      });

      /* --- candles stamping into the chart pane --- */
      const cA = seg(t, T.candles[0], T.candles[1]);
      if (cA > 0) {
        const cp = parts[CHART_PART].r;
        const cx = cp[0] * W, cy = cp[1] * H, cw = cp[2] * W, ch = cp[3] * H;
        const n = CANDLES.length, shown = Math.floor(ease(cA) * n);
        const slot = (cw * 0.9) / n, bw = Math.max(3, slot * 0.55);
        const base = cy + ch * 0.82, amp = ch * 0.42;
        for (let i = 0; i < shown; i++) {
          const cd = CANDLES[i];
          const x = cx + cw * 0.05 + slot * i + slot / 2;
          const yo = base - (cd.o - 80) / 40 * amp, yc = base - (cd.c - 80) / 40 * amp;
          const yh = base - (cd.h - 80) / 40 * amp, yl = base - (cd.l - 80) / 40 * amp;
          const up = cd.c >= cd.o, col = up ? '#089981' : '#f23645';
          const li = clamp01((cA * n - i) / 0.8);
          ctx.save(); ctx.globalAlpha = li;
          ctx.strokeStyle = col; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x, yl); ctx.stroke();
          ctx.fillStyle = col;
          ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(2, Math.abs(yc - yo)));
          ctx.restore();
        }
        // glowing price line trailing the candles
        if (shown > 1) {
          ctx.save();
          ctx.globalAlpha = IS_DASH ? 0.55 : 0.9;   // subtler inside the dashboard's table pane
          ctx.strokeStyle = ACC; ctx.lineWidth = 1.8;
          ctx.shadowColor = ACC; ctx.shadowBlur = 12;
          ctx.beginPath();
          for (let i = 0; i < shown; i++) {
            const x = cx + cw * 0.05 + slot * i + slot / 2;
            const yy = base - (CANDLES[i].c - 80) / 40 * amp;
            i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
          }
          ctx.stroke(); ctx.restore();
        }
      }

      /* --- final neon glow pass --- */
      const gA2 = seg(t, T.glow[0], T.glow[1]);
      if (gA2 > 0) {
        ctx.save();
        ctx.globalAlpha = (1 - Math.abs(gA2 * 2 - 1)) * 0.16;
        const gr = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.6);
        gr.addColorStop(0, ACC); gr.addColorStop(1, 'transparent');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }

    raf = requestAnimationFrame(frame);
    return function stop() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onRz);
    };
  }
  window.buildBootScene = buildBootScene;
})();
