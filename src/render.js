// Ostinascope — overlay drawing, in the grammar of a scientific plate:
// hairlines, corner brackets, dimension lines, rulers, monospaced notes.

export const COLORS = {
  STRIPE: '#FFD21F',
  GRID: '#FF4B36',
  DOTS: '#F4F1EA',
  CONCENTRIC: '#7C9DFF',
  RADIAL: '#7C9DFF',
};
const FONT = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const DEG = Math.PI / 180;

const pad2 = (n) => String(n % 100).padStart(2, '0');

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let dpr = 1;

  function resize(w, h, d) {
    W = w;
    H = h;
    dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
  }

  // -- primitives --------------------------------------------------------

  function stroke(path, color, width, alpha = 1, dash = null) {
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.globalAlpha = alpha * 0.5;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = width + 2;
    path();
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    path();
    ctx.stroke();
    ctx.restore();
  }

  function seg(x0, y0, x1, y1) {
    return () => {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    };
  }

  function tag(text, x, y, color, { align = 'left', size = 10.5, alpha = 1, bg = 0.72 } = {}) {
    ctx.save();
    ctx.font = `500 ${size}px ${FONT}`;
    const w = ctx.measureText(text).width;
    const bx = align === 'right' ? x - w - 8 : align === 'center' ? x - w / 2 - 4 : x;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgba(8,8,10,${bg})`;
    ctx.fillRect(bx, y - size - 3, w + 8, size + 6);
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, bx + 4, y);
    ctx.restore();
    return w + 8;
  }

  function corners(x, y, w, h, L) {
    return () => {
      ctx.beginPath();
      ctx.moveTo(x, y + L); ctx.lineTo(x, y); ctx.lineTo(x + L, y);
      ctx.moveTo(x + w - L, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + L);
      ctx.moveTo(x + w, y + h - L); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - L, y + h);
      ctx.moveTo(x + L, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - L);
    };
  }

  // Dimension line across `n` intervals of length p, along direction (nx, ny).
  function dimension(cx, cy, nx, ny, p, n, color, alpha) {
    const tx = ny;
    const ty = -nx;
    const half = (n * p) / 2;
    stroke(seg(cx - nx * half, cy - ny * half, cx + nx * half, cy + ny * half), color, 1, alpha);
    for (let i = 0; i <= n; i++) {
      const d = -half + i * p;
      const px = cx + nx * d;
      const py = cy + ny * d;
      const len = i === 0 || i === n ? 6 : 3.5;
      stroke(seg(px - tx * len, py - ty * len, px + tx * len, py + ty * len), color, 1, alpha);
    }
  }

  function crosshair(x, y, r, color, alpha) {
    stroke(() => {
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    }, color, 1, alpha);
    stroke(() => {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    }, color, 1, alpha);
  }

  // -- pieces ------------------------------------------------------------

  function labelFor(tr, S) {
    const sp = tr.spec;
    const px = Math.max(1, Math.round(tr.period * S));
    const n = pad2(tr.id);
    switch (tr.type) {
      case 'STRIPE':
        return `${n} STRIPE ／ 間隔${px}px ／ ${Math.round(tr.angle)}° → ${sp ? sp.rhythm : ''}`;
      case 'GRID': {
        const px2 = Math.max(1, Math.round((tr.period2 || tr.period) * S));
        return `${n} GRID ${sp ? sp.rhythm : ''} ／ ${px}×${px2}px → POLY ${sp ? sp.poly : ''}`;
      }
      case 'DOTS':
        return `${n} DOTS ／ 間隔${px}px → ${sp ? sp.rhythm : ''}`;
      case 'CONCENTRIC':
        return `${n} CONCENTRIC ／ Δr ${px}px → ${sp ? sp.voice : ''}`;
      default:
        return `${n} RADIAL → ${sp ? sp.voice : ''}`;
    }
  }

  const shortLabel = (tr) =>
    `${pad2(tr.id)} ${tr.type}${tr.spec ? ' ' + (tr.type === 'GRID' ? tr.spec.rhythm : tr.spec.rhythm) : ''}`;

  function glyph(tr, S, color, alpha) {
    const cx = tr.cx * S;
    const cy = tr.cy * S;
    const p = tr.period * S;
    const t = tr.angle * DEG;
    const nx = Math.sin(t);
    const ny = Math.cos(t);
    const maxLen = Math.min(tr.w, tr.h) * S * 0.8;
    const fit = (pp) => Math.max(1, Math.min(4, Math.floor(maxLen / Math.max(pp, 1e-3))));
    if (tr.type === 'STRIPE') {
      if (p >= 3) dimension(cx, cy, nx, ny, p, fit(p), color, alpha);
    } else if (tr.type === 'GRID') {
      const p2 = (tr.period2 || tr.period) * S;
      const t2 = (tr.angle + (tr.latticeAngle || 90)) * DEG;
      if (p >= 3) dimension(cx, cy, nx, ny, p, Math.min(3, fit(p)), color, alpha);
      if (p2 >= 3) dimension(cx, cy, Math.sin(t2), Math.cos(t2), p2, Math.min(3, fit(p2)), color, alpha);
    } else if (tr.type === 'DOTS') {
      const p2 = (tr.period2 || tr.period) * S;
      const t2 = (tr.angle + (tr.latticeAngle || 90)) * DEG;
      const ax = nx * p;
      const ay = ny * p;
      const bx = Math.sin(t2) * p2;
      const by = Math.cos(t2) * p2;
      const r = Math.max(2, Math.min(p, p2) * 0.22);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const x = cx + i * ax + j * bx;
          const y = cy + i * ay + j * by;
          stroke(() => {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }, color, 1, alpha);
        }
      }
    } else if (tr.center) {
      const ox = tr.center.x * S;
      const oy = tr.center.y * S;
      crosshair(ox, oy, 9, color, alpha);
      const rr = Math.hypot(cx - ox, cy - oy);
      if (tr.type === 'CONCENTRIC') {
        stroke(() => {
          ctx.beginPath();
          ctx.arc(ox, oy, rr, 0, Math.PI * 2);
        }, color, 1, alpha * 0.6, [3, 4]);
        if (rr > 1 && p >= 3) {
          const ux = (cx - ox) / rr;
          const uy = (cy - oy) / rr;
          dimension(ox + ux * rr, oy + uy * rr, ux, uy, p, 3, color, alpha);
        }
      } else {
        const reach = Math.max(tr.w, tr.h) * S * 0.6;
        for (const a of [-0.35, 0, 0.35]) {
          const base = Math.atan2(cy - oy, cx - ox) + a;
          stroke(seg(ox, oy, ox + Math.cos(base) * (rr + reach), oy + Math.sin(base) * (rr + reach)),
            color, 1, alpha * 0.7, [2, 4]);
        }
      }
    }
  }

  function drawTrack(tr, S, now, bounds) {
    const color = COLORS[tr.type] || '#fff';
    const x = (tr.cx - tr.w / 2) * S;
    const y = (tr.cy - tr.h / 2) * S;
    const w = tr.w * S;
    const h = tr.h * S;
    const f = tr.flash || 0;

    if (tr.state === 'cand') {
      stroke(corners(x, y, w, h, Math.min(10, w / 4, h / 4)), color, 1, 0.35, [2, 3]);
      return;
    }
    if (tr.state === 'fading') {
      const k = Math.max(0, 1 - (now - tr.fadeStart) / Math.max(1, tr.fadeMs));
      if (tr.exit && tr.exit.kind === 'edge') drawExit(tr, S, k, color, bounds);
      else {
        stroke(() => {
          ctx.beginPath();
          ctx.rect(x, y, w, h);
        }, color, 1, 0.6 * k, [4, 4]);
        tag(shortLabel(tr) + ' …', x, y - 4, color, { alpha: k });
      }
      return;
    }

    if (f > 0.02) {
      ctx.fillStyle = rgba(color, 0.12 * f);
      ctx.fillRect(x, y, w, h);
    }
    if (tr.muted) {
      stroke(() => {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
      }, color, 1, 0.5, [4, 4]);
      tag(`${shortLabel(tr)} ／ MUTED`, x, Math.max(y - 4, bounds.top + 14), color, { alpha: 0.7 });
      return;
    }
    stroke(() => {
      ctx.beginPath();
      ctx.rect(x + 0.5, y + 0.5, w - 1, h - 1);
    }, color, 1, 0.45 + 0.4 * f);
    stroke(corners(x, y, w, h, Math.min(16, w / 4, h / 4)), color, 2 + 1.5 * f, 1);
    glyph(tr, S, color, 0.85);
    const text = labelFor(tr, S) + (tr.unison ? ` ＝${pad2(tr.unison)}` : '');
    ctx.font = `500 10.5px ${FONT}`;
    const tw = ctx.measureText(text).width + 8;
    const lx = Math.max(4, Math.min(x, W - 4 - tw));
    const ly = place(lx, Math.max(bounds.top + 18, y - 5 < bounds.top + 14 ? y + 17 : y - 5), tw);
    tag(text, lx, ly, color);
  }

  // Labels of neighbouring patterns would sit on top of each other; nudge
  // each one down until it is free.
  let placed = [];
  function place(x, y, w) {
    const h = 17;
    for (let i = 0; i < 6; i++) {
      const yy = y + i * (h + 2);
      const clash = placed.some((r) => x < r.x + r.w && r.x < x + w && yy - 14 < r.y + h && r.y < yy - 14 + h);
      if (!clash || i === 5) {
        placed.push({ x, y: yy - 14, w });
        return yy;
      }
    }
    return y;
  }

  // A lost pattern leaves a mark on the border it left through.
  function drawExit(tr, S, k, color, bounds) {
    const e = tr.exit;
    const top = bounds.top + 6;
    const bottom = bounds.bottom - 6;
    let ex = Math.min(W - 3, Math.max(3, e.x * S));
    let ey = Math.min(bottom, Math.max(top, e.y * S));
    const horiz = e.edge === 'top' || e.edge === 'bottom';
    const len = Math.max(28, Math.min(150, (horiz ? tr.w : tr.h) * S));
    if (e.edge === 'left') ex = 3;
    if (e.edge === 'right') ex = W - 3;
    if (e.edge === 'top') ey = top;
    if (e.edge === 'bottom') ey = bottom;
    const ox = horiz ? len / 2 : 0;
    const oy = horiz ? 0 : len / 2;
    stroke(seg(ex - ox, ey - oy, ex + ox, ey + oy), color, 3, k);
    // outward chevrons
    const out = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }[e.edge];
    for (const s of [-0.3, 0.3]) {
      const bx = ex + ox * s * 2 - out[0] * 10;
      const by = ey + oy * s * 2 - out[1] * 10;
      const px = -out[1];
      const py = out[0];
      stroke(() => {
        ctx.beginPath();
        ctx.moveTo(bx - px * 4 - out[0] * 4, by - py * 4 - out[1] * 4);
        ctx.lineTo(bx, by);
        ctx.lineTo(bx + px * 4 - out[0] * 4, by + py * 4 - out[1] * 4);
      }, color, 1.2, k);
    }
    const text = `${shortLabel(tr)} ${{ left: '←', right: '→', top: '↑', bottom: '↓' }[e.edge]}`;
    if (e.edge === 'right') tag(text, W - 14, ey + oy + 16, color, { align: 'right', alpha: k, size: 9.5 });
    else if (e.edge === 'left') tag(text, 14, ey + oy + 16, color, { alpha: k, size: 9.5 });
    else if (e.edge === 'top') tag(text, Math.min(W - 160, Math.max(8, ex - ox)), ey + 22, color, { alpha: k, size: 9.5 });
    else tag(text, Math.min(W - 160, Math.max(8, ex - ox)), ey - 8, color, { alpha: k, size: 9.5 });
  }

  function drawGrid(res, k, S, bounds) {
    if (!res || !res.levels[0]) return;
    const lv = res.levels[0];
    const o = lv.origin || lv.cells[0];
    if (!o) return;
    // marks one cell apart over the analysed area (cells overlap by half,
    // so the area is (cols-1)·step + size wide)
    const step = lv.size * k;
    const ox = o.x * k;
    const oy = o.y * k;
    const nc = Math.round(((lv.cols - 1) * (lv.step || lv.size) + lv.size) / lv.size);
    const nr = Math.round(((lv.rows - 1) * (lv.step || lv.size) + lv.size) / lv.size);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let j = 0; j <= nr; j++) {
      for (let i = 0; i <= nc; i++) {
        const x = Math.round(ox + i * step) + 0.5;
        const y = Math.round(oy + j * step) + 0.5;
        if (y < bounds.top || y > bounds.bottom) continue;
        ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
        ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
      }
    }
    ctx.stroke();
    // rulers: top (under the HUD) and left edge
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `400 8.5px ${FONT}`;
    ctx.beginPath();
    for (let i = 0; i <= nc * 2; i++) {
      const x = Math.round(ox + (i * step) / 2) + 0.5;
      const len = i % 2 ? 3 : 6;
      ctx.moveTo(x, bounds.top);
      ctx.lineTo(x, bounds.top + len);
      if (i % 4 === 0 && i < nc * 2) ctx.fillText((x / S).toFixed(2).replace(/^0/, ''), x + 2, bounds.top + 14);
    }
    for (let j = 0; j <= nr * 2; j++) {
      const y = Math.round(oy + (j * step) / 2) + 0.5;
      if (y < bounds.top || y > bounds.bottom) continue;
      const len = j % 2 ? 3 : 6;
      ctx.moveTo(0, y);
      ctx.lineTo(len, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Debug: every cell that found a repetition, drawn by its core (cells
  // overlap by half). Weak cells (failed the repeat/isolation test) dotted.
  function drawCells(res, k) {
    if (!res) return;
    ctx.save();
    ctx.font = `400 8px ${FONT}`;
    for (const lv of res.levels) {
      for (const c of lv.cells) {
        if (!c.type) continue;
        const color = COLORS[c.type];
        const s = c.core * k;
        const x = c.cx * k - s / 2;
        const y = c.cy * k - s / 2;
        if (c.weak) {
          ctx.strokeStyle = rgba(color, 0.4);
          ctx.setLineDash([1, 3]);
          ctx.strokeRect(x + 2, y + 2, s - 4, s - 4);
          ctx.setLineDash([]);
        } else if (lv.level === 0) {
          ctx.fillStyle = rgba(color, 0.13);
          ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
          ctx.fillStyle = rgba(color, 0.85);
          ctx.fillText(`${c.type[0]}${c.p1.toFixed(1)}`, x + 3, y + 10);
        } else {
          ctx.strokeStyle = rgba(color, 0.65);
          ctx.setLineDash([2, 3]);
          ctx.strokeRect(x + 3, y + 3, s - 6, s - 6);
          ctx.setLineDash([]);
          ctx.fillStyle = rgba(color, 0.85);
          ctx.fillText(`L${lv.level} ${c.type[0]}${c.p1.toFixed(1)}`, x + 6, y + s - 6);
        }
      }
    }
    ctx.restore();
  }

  function drawHUD(st, bounds) {
    const top = st.insets.top;
    const g = ctx.createLinearGradient(0, 0, 0, bounds.top + 10);
    g.addColorStop(0, 'rgba(6,6,8,0.75)');
    g.addColorStop(1, 'rgba(6,6,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, bounds.top + 10);

    ctx.fillStyle = '#F4F1EA';
    ctx.font = `700 13px ${FONT}`;
    ctx.fillText('OSTINASCOPE', 12, top + 20);
    const pos = st.audio.position();
    ctx.font = `400 10px ${FONT}`;
    ctx.fillStyle = 'rgba(244,241,234,0.8)';
    const bar = String(pos.bar + 1).padStart(3, '0');
    ctx.fillText(`♩=${st.audio.bpm}  BAR ${bar}.${pos.beat + 1}  ${st.mode === 'demo' ? 'DEMO' : 'CAM'}`, 12, top + 35);

    // beat squares
    const bx = W - 58 - 4 * 12;
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = 'rgba(244,241,234,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + i * 12 + 0.5, top + 11.5, 8, 8);
      if (i === pos.beat) {
        ctx.fillStyle = i === 0 ? '#FFD21F' : '#F4F1EA';
        ctx.fillRect(bx + i * 12 + 2, top + 13, 5, 5);
      }
    }
    ctx.fillStyle = 'rgba(244,241,234,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText(`LOOPS ${st.audio.playingCount}/${st.maxVoices}  ${st.stats.hz.toFixed(0)}Hz`, W - 58, top + 35);
    ctx.textAlign = 'left';
    if (st.debug) {
      ctx.fillStyle = 'rgba(244,241,234,0.65)';
      ctx.font = `400 9px ${FONT}`;
      ctx.fillText(
        `analysis ${st.stats.ms.toFixed(1)}ms · ${st.procW}×${st.procH} · regions ${st.stats.regions} · tracks ${st.tracks.length}`,
        12, top + 48,
      );
    }
  }

  function drawScore(st, bounds) {
    const voices = [...st.audio.voices.values()].sort((a, b) => a.id - b.id);
    const rowH = 17;
    const y0 = bounds.bottom;
    const h = H - y0;
    ctx.fillStyle = 'rgba(6,6,8,0.66)';
    ctx.fillRect(0, y0, W, h);
    ctx.fillStyle = 'rgba(244,241,234,0.22)';
    ctx.fillRect(0, y0, W, 1);
    ctx.font = `500 9.5px ${FONT}`;
    if (!voices.length) {
      ctx.fillStyle = 'rgba(244,241,234,0.7)';
      const dots = '.'.repeat(1 + (Math.floor(st.now / 400) % 3));
      ctx.fillText(`SCANNING — 繰り返しを探しています${dots}`, 12, y0 + 18);
      return;
    }
    const tx0 = Math.min(150, W * 0.38);
    const tx1 = W - 12;
    voices.forEach((v, i) => {
      const tr = st.trackById.get(v.id);
      const type = tr ? tr.type : '';
      const color = COLORS[type] || '#fff';
      const cy = y0 + 13 + i * rowH;
      const alpha = v.state === 'fading' ? 0.45 : 1;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(12, cy - 4, 6, 6);
      ctx.fillStyle = 'rgba(244,241,234,0.9)';
      const extra = v.spec.kind === 'grid' ? v.spec.poly : v.spec.rhythm;
      ctx.fillText(`${pad2(v.id)} ${type.slice(0, 6)} ${extra}`, 24, cy + 2);
      // timeline
      ctx.fillStyle = 'rgba(244,241,234,0.18)';
      ctx.fillRect(tx0, cy - 1, tx1 - tx0, 1);
      const bars = v.spec.loopBars;
      const ticks = Math.max(4, Math.round(16 * bars));
      if (ticks <= 64) {
        for (let k = 0; k <= ticks; k++) {
          const x = tx0 + ((tx1 - tx0) * k) / ticks;
          const major = k % 4 === 0;
          ctx.fillRect(x, cy - (major ? 3 : 1.5), 1, major ? 5 : 2.5);
        }
      }
      if (v.spec.kind === 'drone') {
        ctx.strokeStyle = rgba(color, 0.9);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = tx0; x <= tx1; x += 3) {
          const ph = (x - tx0) / (tx1 - tx0);
          const yy = cy - 1 - 4 * Math.cos(ph * Math.PI * 2);
          if (x === tx0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      } else {
        v.spec.steps.forEach((s, si) => {
          const x = tx0 + (tx1 - tx0) * s.pos;
          const yy = cy - 1 + (v.spec.kind === 'grid' ? (s.layer ? 3.5 : -3.5) : 0);
          const hit = v.lastHit && st.now - (v.lastHit.get(si) || -1e9) < 140;
          const r = 1.4 + 1.6 * s.vel + (hit ? 1.5 : 0);
          ctx.beginPath();
          ctx.arc(x, yy, r, 0, Math.PI * 2);
          ctx.fillStyle = hit ? color : rgba(color, 0.55);
          ctx.fill();
        });
      }
      const ph = st.audio.loopPhase(v);
      ctx.fillStyle = 'rgba(244,241,234,0.85)';
      ctx.fillRect(tx0 + (tx1 - tx0) * ph, cy - 6, 1, 11);
      ctx.globalAlpha = 1;
    });
  }

  // -- frame -------------------------------------------------------------

  function draw(st) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    st.source.draw(ctx, W, H);
    ctx.fillStyle = 'rgba(6,6,10,0.2)';
    ctx.fillRect(0, 0, W, H);

    const S = Math.min(W, H); // view units → CSS px
    const k = W / st.procW; // analysis px → CSS px
    const voiceRows = Math.max(1, st.audio.voices.size);
    const bounds = {
      top: st.insets.top + (st.debug ? 56 : 46),
      bottom: H - st.insets.bottom - 14 - voiceRows * 17,
    };

    drawGrid(st.result, k, S, bounds);
    if (st.debug) drawCells(st.result, k);

    placed = [];
    const order = { cand: 0, fading: 1, active: 2 };
    const tracks = [...st.tracks].sort((a, b) => order[b.state] - order[a.state] || a.cy - b.cy);
    for (const tr of tracks) drawTrack(tr, S, st.now, bounds);

    // reticle
    ctx.strokeStyle = 'rgba(244,241,234,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 7, H / 2); ctx.lineTo(W / 2 + 7, H / 2);
    ctx.moveTo(W / 2, H / 2 - 7); ctx.lineTo(W / 2, H / 2 + 7);
    ctx.stroke();

    drawHUD(st, bounds);
    drawScore(st, bounds);
  }

  return { resize, draw, ctx };
}
