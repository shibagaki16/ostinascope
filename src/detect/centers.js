// Concentric rings and radial rays from the orientation of every pixel.
//
// The cell detector (detector.js) needs a stripe in each cell: tree rings
// that are uneven, petals that taper, rings whose centre is off the frame
// rarely make one. Here every pixel's edge orientation counts instead:
//   1. The structure tensor (at half resolution) gives each pixel the
//      direction of its gradient and how clearly it has one.
//   2. Clear pixels vote for centres near them: along the gradient for
//      rings (a ring's centre lies across it), along the edge for rays. Only
//      near (reach): one tree stump among clutter is a local peak. The vote
//      map has a margin, for rings whose centre is off the frame.
//   3. Each peak is checked: do the orientations around it agree with rings
//      (gradient towards the centre) or rays (gradient across), and over a
//      wide arc (sectors that agree)? Rings must also turn light/dark
//      several times outwards: the rim of one round blob agrees too, but
//      only once.
//
// Pure module (no DOM).

import { clamp, overlapShare } from '../util.js';

export const CENTER_DEFAULTS = Object.freeze({
  smooth: 3, // structure tensor window radius (px of the image given)
  minCoherence: 0.25, // a pixel counts when its orientation is this clear
  reach: 40, // px a pixel votes along its line
  margin: 0.5, // vote map margin around the frame, × the short side
  peaks: 5, // candidates per kind
  radius: 90, // px around a candidate that are checked
  sectors: 16,
  sectorAgree: 0.8, // a sector agrees when this share of its weight does
  fullArc: 6, // agreeing sectors for a full score
  // the agreeing sectors must make one arc (one sector in it may fail) of
  // at least this many: straight stripes agree only in two narrow opposite
  // fans, a grid in four (the crossing and the square grid on the poster)
  ringArc: 4,
  rayArc: 8,
  turnSwing: 0.15, // a light/dark turn is at least this × the ray's range
  // Measured on labelled photo views (bench/labels.json) and the hand-held
  // sequences: lower, hair across a face, a wrinkled cheek or an
  // embroidered collar keep a loop going in scenes without a pattern (rays
  // 0.64–0.73, a cheek's 5 turns); higher, tree rings are lost.
  ringScore: 0.55,
  ringTurns: 6, // light/dark turns outwards (3 rings)
  rayScore: 0.75,
});

export function createCenterFinder(options = {}) {
  const opt = { ...CENTER_DEFAULTS, ...options };
  let gx = new Float32Array(0), gy = new Float32Array(0), wgt = new Float32Array(0);
  let txx = new Float32Array(0), tyy = new Float32Array(0), txy = new Float32Array(0), tmp = new Float32Array(0);

  function ensure(n) {
    if (gx.length >= n) return;
    gx = new Float32Array(n); gy = new Float32Array(n); wgt = new Float32Array(n);
    txx = new Float32Array(n); tyy = new Float32Array(n); txy = new Float32Array(n); tmp = new Float32Array(n);
  }

  // separable box sum of radius R, in place
  function box(a, w, h, R) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      const row = y * w;
      for (let x = -R; x < w + R; x++) {
        if (x + R < w) s += a[row + x + R];
        if (x - R - 1 >= 0) s -= a[row + x - R - 1];
        if (x >= 0 && x < w) tmp[row + x] = s;
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -R; y < h + R; y++) {
        if (y + R < h) s += tmp[(y + R) * w + x];
        if (y - R - 1 >= 0) s -= tmp[(y - R - 1) * w + x];
        if (y >= 0 && y < h) a[y * w + x] = s;
      }
    }
  }

  // 1. gradient direction (unit gx, gy) and weight of every pixel
  function field(img, w, h) {
    const n = w * h;
    ensure(n);
    txx.fill(0, 0, n); tyy.fill(0, 0, n); txy.fill(0, 0, n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const dx = img[i + 1] - img[i - 1];
        const dy = img[i + w] - img[i - w];
        txx[i] = dx * dx;
        tyy[i] = dy * dy;
        txy[i] = dx * dy;
      }
    }
    box(txx, w, h, opt.smooth);
    box(tyy, w, h, opt.smooth);
    box(txy, w, h, opt.smooth);
    // energy normalised by its 90th percentile (contrast does not matter)
    const sample = [];
    for (let i = 0; i < n; i += 7) if (txx[i] + tyy[i] > 0) sample.push(txx[i] + tyy[i]);
    sample.sort((a, b) => a - b);
    const e90 = sample.length ? sample[Math.floor(0.9 * (sample.length - 1))] : 1;
    for (let i = 0; i < n; i++) {
      const a = txx[i], b = tyy[i], c = txy[i];
      const tr = a + b;
      wgt[i] = 0;
      if (tr <= 1e-12) continue;
      const d = Math.sqrt((a - b) * (a - b) + 4 * c * c);
      const coh = (d / tr) ** 2;
      if (coh < opt.minCoherence) continue;
      // the gradient's direction θ from 2θ (half-angle formulas)
      const c2 = (a - b) / d;
      gx[i] = Math.sqrt(Math.max(0, (1 + c2) / 2));
      gy[i] = (c >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, (1 - c2) / 2));
      wgt[i] = coh * Math.min(1, tr / e90);
    }
  }

  // 2. centre votes → candidates { x, y } per kind ('c' rings, 'r' rays)
  let accC = new Float32Array(0), accR = new Float32Array(0), accT = new Float32Array(0);
  // the pixels that agree around a candidate: x, y, sector, radius, weight
  let agX = new Float32Array(0), agY = new Float32Array(0), agS = new Uint8Array(0), agR = new Float32Array(0), agW = new Float32Array(0);
  // add v along the line through (x, y) in direction (ux, uy), both ways
  function vote(a, bw, bh, x, y, ux, uy, v, M) {
    const B = 2;
    for (let s = 4; s <= opt.reach; s += 2) {
      let bx = Math.floor((x + s * ux + M) / B);
      let by = Math.floor((y + s * uy + M) / B);
      if (bx >= 0 && by >= 0 && bx < bw && by < bh) a[by * bw + bx] += v;
      bx = Math.floor((x - s * ux + M) / B);
      by = Math.floor((y - s * uy + M) / B);
      if (bx >= 0 && by >= 0 && bx < bw && by < bh) a[by * bw + bx] += v;
    }
  }
  // 3 × 3 mean (zero at the border), into a; accT is scratch
  function blur3(a, bw, bh) {
    accT.fill(0, 0, bw * bh);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x;
        accT[i] = (a[i - bw - 1] + a[i - bw] + a[i - bw + 1] + a[i - 1] + a[i] + a[i + 1] + a[i + bw - 1] + a[i + bw] + a[i + bw + 1]) / 9;
      }
    }
    a.set(accT.subarray(0, bw * bh));
  }

  function candidates(w, h) {
    const M = Math.round(opt.margin * Math.min(w, h));
    const B = 2;
    const bw = Math.ceil((w + 2 * M) / B);
    const bh = Math.ceil((h + 2 * M) / B);
    const n = bw * bh;
    if (accC.length < n) {
      accC = new Float32Array(n);
      accR = new Float32Array(n);
      accT = new Float32Array(n);
    }
    accC.fill(0, 0, n);
    accR.fill(0, 0, n);
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = y * w + x;
        const v = wgt[i];
        if (!v) continue;
        vote(accC, bw, bh, x, y, gx[i], gy[i], v, M);
        vote(accR, bw, bh, x, y, -gy[i], gx[i], v, M);
      }
    }
    const out = {};
    for (const k of ['c', 'r']) {
      const m = k === 'c' ? accC : accR;
      blur3(m, bw, bh);
      blur3(m, bw, bh);
      let top = 0;
      for (let i = 0; i < n; i++) top = Math.max(top, m[i]);
      const list = [];
      for (let y = 2; y < bh - 2; y++) {
        for (let x = 2; x < bw - 2; x++) {
          const v = m[y * bw + x];
          if (v <= 0.05 * top) continue;
          let max = true;
          for (let dy = -2; dy <= 2 && max; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if ((dx || dy) && m[(y + dy) * bw + x + dx] > v) {
                max = false;
                break;
              }
            }
          }
          if (max) list.push({ x: (x + 0.5) * B - M, y: (y + 0.5) * B - M, v });
        }
      }
      list.sort((p, q) => q.v - p.v);
      const kept = [];
      for (const p of list) {
        if (kept.length >= opt.peaks) break;
        if (kept.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 10)) kept.push(p);
      }
      out[k] = kept;
    }
    return out;
  }

  // light/dark turns along a ray from (cx, cy) at angle a: their number and
  // radii
  function turnsAlong(img, w, h, cx, cy, a) {
    const ux = Math.cos(a), uy = Math.sin(a);
    const prof = [];
    for (let r = 3; r <= opt.radius; r += 1) {
      const x = cx + r * ux, y = cy + r * uy;
      if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) break;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
      prof.push((img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy);
    }
    if (prof.length < 12) return null;
    const L = prof.length;
    const sm = prof.map((v, i) => (prof[Math.max(0, i - 1)] + 2 * v + prof[Math.min(L - 1, i + 1)]) / 4);
    let lo = Infinity, hi = -Infinity;
    for (const v of sm) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const swing = opt.turnSwing * (hi - lo);
    const at = [];
    let last = sm[0], lastR = 0, dir = 0;
    sm.forEach((v, i) => {
      if (dir >= 0 && v < last - swing) {
        if (dir > 0) at.push(3 + lastR);
        dir = -1; last = v; lastR = i;
      } else if (dir <= 0 && v > last + swing) {
        if (dir < 0) at.push(3 + lastR);
        dir = 1; last = v; lastR = i;
      } else if ((dir > 0 && v > last) || (dir < 0 && v < last)) {
        last = v; lastR = i;
      }
    });
    return at;
  }

  // 3. how well the orientations around (cx, cy) agree with kind 'c' / 'r'
  function check(img, w, h, cx, cy, kind) {
    const R = opt.radius, NS = opt.sectors;
    const sw = new Float64Array(NS), sa = new Float64Array(NS);
    let tw = 0, ta = 0, na = 0;
    const xa = Math.max(0, Math.floor(cx - R)), xb = Math.min(w - 1, Math.ceil(cx + R));
    const ya = Math.max(0, Math.floor(cy - R)), yb = Math.min(h - 1, Math.ceil(cy + R));
    const most = Math.ceil((xb - xa + 2) / 2) * Math.ceil((yb - ya + 2) / 2);
    if (agX.length < most) {
      agX = new Float32Array(most); agY = new Float32Array(most); agS = new Uint8Array(most);
      agR = new Float32Array(most); agW = new Float32Array(most);
    }
    for (let y = ya; y <= yb; y += 2) {
      for (let x = xa; x <= xb; x += 2) {
        const i = y * w + x;
        const v = wgt[i];
        if (!v) continue;
        const dx = x - cx, dy = y - cy;
        const r2 = dx * dx + dy * dy;
        if (r2 < 9 || r2 > R * R) continue;
        const c = (gx[i] * dx + gy[i] * dy);
        const c2 = (c * c) / r2; // 1: the gradient points at the centre (rings)
        const agree = kind === 'c' ? c2 : 1 - c2;
        const s = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * NS) % NS;
        sw[s] += v;
        sa[s] += v * agree;
        tw += v;
        ta += v * agree;
        if (agree > opt.sectorAgree) {
          agX[na] = x; agY[na] = y; agS[na] = s; agR[na] = Math.sqrt(r2); agW[na] = v;
          na++;
        }
      }
    }
    if (tw <= 0 || !na) return null;
    const s = 2 * (ta / tw) - 1; // −1…1, 0 = chance
    const ok = [];
    let cov = 0;
    for (let k = 0; k < NS; k++) {
      ok[k] = sw[k] >= 0.02 * tw && sa[k] / sw[k] >= opt.sectorAgree;
      if (ok[k]) cov++;
    }
    const score = s * Math.min(1, cov / opt.fullArc);
    if (score < (kind === 'c' ? opt.ringScore : opt.rayScore)) return { score };
    let arc = 0;
    for (let k0 = 0; k0 < NS; k0++) {
      if (!ok[k0]) continue;
      let n = 0, miss = 0, last = 0;
      while (n < NS) {
        if (ok[(k0 + n) % NS]) last = n + 1;
        else if (++miss > 1) break;
        n++;
      }
      arc = Math.max(arc, last);
    }
    if (arc < (kind === 'c' ? opt.ringArc : opt.rayArc)) return { score: 0 };
    // the extent: agreeing pixels in the agreeing sectors, out to the radius
    // that holds 90% of their weight (pixels that agree by chance are
    // everywhere, so all of them would make the whole frame)
    const hist = new Float64Array(Math.ceil(R) + 2);
    let wsum = 0;
    for (let j = 0; j < na; j++) {
      if (!ok[agS[j]]) continue;
      hist[Math.floor(agR[j])] += agW[j];
      wsum += agW[j];
    }
    if (wsum <= 0) return null;
    let acc = 0, r90 = R;
    for (let r = 0; r < hist.length; r++) {
      acc += hist[r];
      if (acc >= 0.9 * wsum) {
        r90 = r + 1;
        break;
      }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j < na; j++) {
      if (!ok[agS[j]] || agR[j] > r90) continue;
      x0 = Math.min(x0, agX[j]); y0 = Math.min(y0, agY[j]); x1 = Math.max(x1, agX[j]); y1 = Math.max(y1, agY[j]);
    }
    let spacing = NaN;
    if (kind === 'c') {
      const counts = [];
      const gaps = [];
      for (let k = 0; k < NS; k++) {
        if (!ok[k]) continue;
        const at = turnsAlong(img, w, h, cx, cy, ((k + 0.5) / NS) * 2 * Math.PI - Math.PI);
        if (!at) continue;
        counts.push(at.length);
        for (let j = 2; j < at.length; j += 1) gaps.push(at[j] - at[j - 2]); // light to light
      }
      counts.sort((p, q) => p - q);
      const turns = counts.length ? counts[counts.length >> 1] : 0;
      if (turns < opt.ringTurns) return null;
      gaps.sort((p, q) => p - q);
      spacing = gaps.length ? gaps[gaps.length >> 1] : NaN;
    } else {
      // rays: their spacing along a circle halfway out
      const rm = 0.5 * Math.min(R, Math.hypot(x1 - x0, y1 - y0));
      spacing = (2 * Math.PI * rm) / Math.max(6, 2 * cov);
    }
    return { score, s, cov, box: [x0, y0, x1, y1], spacing };
  }

  // Regions (in px of the full frame: × scale) of the image img (w × h).
  // known: regions found already; a candidate in the same place as a
  // concentric/radial one there is left to it.
  function find(img, w, h, scale, known = []) {
    field(img, w, h);
    const cand = candidates(w, h);
    const found = [];
    for (const k of ['c', 'r']) {
      for (const p of cand[k]) {
        const q = check(img, w, h, p.x, p.y, k);
        if (!q || q.score < (k === 'c' ? opt.ringScore : opt.rayScore)) continue;
        found.push({ k, x: p.x, y: p.y, ...q });
      }
    }
    found.sort((a, b) => b.score - a.score);
    const out = [];
    for (const f of found) {
      const [x0, y0, x1, y1] = f.box.map((v) => v * scale);
      const reg = {
        x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      };
      if (reg.w < 8 || reg.h < 8) continue;
      const same = (a) => overlapShare(a, reg) > 0.5;
      if (out.some(same) || known.some((a) => a.family === 'radial' && same(a))) continue;
      // grey contrast under the box
      let s = 0, s2 = 0, n = 0;
      for (let y = Math.floor(f.box[1]); y <= f.box[3]; y += 2) {
        for (let x = Math.floor(f.box[0]); x <= f.box[2]; x += 2) {
          const v = img[y * w + x];
          s += v; s2 += v * v; n++;
        }
      }
      const std = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
      out.push({
        ...reg,
        type: f.k === 'c' ? 'CONCENTRIC' : 'RADIAL',
        family: 'radial',
        level: 1,
        cells: f.cov,
        cellSize: 2 * opt.radius * scale,
        cx: reg.x + reg.w / 2,
        cy: reg.y + reg.h / 2,
        center: { x: f.x * scale, y: f.y * scale },
        period: Number.isFinite(f.spacing) ? f.spacing * scale : 16 * scale,
        angle: 0,
        coherence: clamp(f.s, 0, 1),
        score: clamp(f.score, 0, 1),
        contrast: clamp(std * 2.5, 0, 1),
        sharp: 0.5,
        oriented: true, // found by centers.js (pixel orientations), not by cells
      });
    }
    return out;
  }

  return { find, options: opt };
}
