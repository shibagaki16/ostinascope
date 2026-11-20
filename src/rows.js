// Ostinascope — rows of similar things (bottles on a shelf, chairs,
// windows, a line of cups…). The spectral detector only sees strict,
// evenly spaced periodicity; this looks for *self-similarity* instead:
// a small window whose look (a histogram of edge directions, plus a coarse
// light/dark layout) reappears at least twice more, roughly on one line.
// The spacing may be uneven — that unevenness becomes the rhythm.
//
//   1. edge direction histograms per 4×4 block of a downsampled grey image
//   2. for windows of 3–6 blocks: a 63-number descriptor (3×3 sub-cells ×
//      6 directions, + a 3×3 light/dark layout), compared by cosine
//   3. a few distinctive anchor windows each search the whole frame; peaks
//      that stand far above the typical similarity are its look-alikes
//   4. the largest set of look-alikes on one line, sensibly spaced → ROW
//
// Pure module (no DOM).

import { clamp, TO_DEG as DEG } from './util.js';

const NB = 6; // edge direction bins (0–180°)
const ND = 9 * NB + 9; // descriptor length

export const ROW_DEFAULTS = Object.freeze({
  block: 4, // px of the level image per block
  // which pyramid levels to search, and window sizes in blocks
  passes: [
    { level: 0, sizes: [3, 4] },
    { level: 1, sizes: [3, 4, 6] },
    { level: 3, sizes: [3, 4, 5] },
  ],
  anchors: 12, // anchor windows per window size
  scanStep: 2, // anchors compare against every other window, then climb to the peak
  maxClimbs: 40, // … from at most this many starting points
  minEnergy: 0.035, // mean gradient per pixel for a window to be a "thing"
  minSim: 0.8, // cosine similarity of a look-alike
  minSim3: 0.86, // … for a row of only three
  minLift: 0.18, // … and this far above the median similarity in the frame
  maxSelfShift: 0.86, // anchor must not look like itself half a window away (texture)
  minCount: 3,
  maxCount: 12,
  lineTol: 0.33, // distance from the row's line, × window size
  minGap: 0.8, // neighbours at least this far apart, × window size
  maxGapRatio: 2.6, // largest gap ≤ this × median gap
  minDip: 0.15, // similarity must drop this much halfway between neighbours
  onLine: 0.5, // share of all look-alikes in the frame that must be in the row
  maxUneven: 0.55, // gap standard deviation / mean gap
});

// The detector's sensitivity slider, applied to the row thresholds. Only
// the ones that measured as helping: how sharply the similarity has to dip
// between neighbours, the share of look-alikes on the line, rows of three.
// The similarity floor itself stays — lower, everything looks alike.
function loosen(o, sens) {
  if (!(sens > 0) || sens === 1) return o;
  const r = Math.sqrt(sens);
  return {
    ...o,
    minDip: o.minDip / sens, // 0.15 → 0.115 at 1.3 (rows of three keep 0.15)
    onLine: o.onLine / r, // 0.5 → 0.44
    minSim3: 1 - (1 - o.minSim3) * r, // 0.86 → 0.84
    maxUneven: o.maxUneven * r,
  };
}

export function createRowFinder(options = {}) {
  const opt = { ...ROW_DEFAULTS, ...options };
  const base = opt;
  let hist = new Float32Array(0); // per block × NB
  let lum = new Float32Array(0); // per block mean grey
  let ii = new Float32Array(0); // integral images, (NB + 1) channels
  let desc = new Float32Array(0);
  let energy = new Float32Array(0);
  let sims = new Float32Array(0);
  let stamp = new Int32Array(0);
  let scanId = 0;

  function blocks(img, iw, ih) {
    const B = opt.block;
    const bw = Math.floor((iw - 2) / B);
    const bh = Math.floor((ih - 2) / B);
    if (hist.length < bw * bh * NB) hist = new Float32Array(bw * bh * NB);
    if (lum.length < bw * bh) lum = new Float32Array(bw * bh);
    hist.fill(0, 0, bw * bh * NB);
    lum.fill(0, 0, bw * bh);
    for (let y = 1; y < bh * B + 1; y++) {
      const by = ((y - 1) / B) | 0;
      const row = y * iw;
      for (let x = 1; x < bw * B + 1; x++) {
        const bx = ((x - 1) / B) | 0;
        const i = row + x;
        const gx = img[i + 1] - img[i - 1];
        const gy = img[i + iw] - img[i - iw];
        const m = Math.sqrt(gx * gx + gy * gy);
        const b = by * bw + bx;
        lum[b] += img[i];
        if (m < 1e-4) continue;
        let a = Math.atan2(gy, gx);
        if (a < 0) a += Math.PI;
        const f = (a / Math.PI) * NB - 0.5; // soft binning between centres
        const b0 = Math.floor(f);
        const w1 = f - b0;
        hist[b * NB + ((b0 + NB) % NB)] += m * (1 - w1);
        hist[b * NB + ((b0 + 1) % NB)] += m * w1;
      }
    }
    const inv = 1 / (B * B);
    for (let b = 0; b < bw * bh; b++) lum[b] *= inv;
    // integral images over blocks, channel-interleaved, (bw+1)×(bh+1)
    const C = NB + 1;
    const W1 = bw + 1;
    if (ii.length < W1 * (bh + 1) * C) ii = new Float32Array(W1 * (bh + 1) * C);
    ii.fill(0, 0, W1 * (bh + 1) * C);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const o = ((y + 1) * W1 + (x + 1)) * C;
        const up = (y * W1 + (x + 1)) * C;
        const left = ((y + 1) * W1 + x) * C;
        const diag = (y * W1 + x) * C;
        const b = y * bw + x;
        for (let c = 0; c < C; c++) {
          const v = c < NB ? hist[b * NB + c] : lum[b];
          ii[o + c] = v + ii[up + c] + ii[left + c] - ii[diag + c];
        }
      }
    }
    return { bw, bh };
  }

  // sum of channel c over blocks [x0,x1)×[y0,y1)
  function rect(W1, x0, y0, x1, y1, c) {
    const C = NB + 1;
    return ii[(y1 * W1 + x1) * C + c] - ii[(y0 * W1 + x1) * C + c] - ii[(y1 * W1 + x0) * C + c] + ii[(y0 * W1 + x0) * C + c];
  }

  // Window grid for size s: energies now, descriptors on demand (most
  // windows are only ever looked at by a few anchors' scans).
  let have = new Uint8Array(0);
  let cur = null;
  const lbuf = new Float32Array(9);
  function describe(bw, bh, s) {
    const nx = bw - s + 1;
    const ny = bh - s + 1;
    if (nx < 1 || ny < 1) return null;
    const n = nx * ny;
    if (desc.length < n * ND) desc = new Float32Array(n * ND);
    if (energy.length < n) energy = new Float32Array(n);
    if (have.length < n) have = new Uint8Array(n);
    have.fill(0, 0, n);
    const W1 = bw + 1;
    const B = opt.block;
    for (let wy = 0; wy < ny; wy++) {
      for (let wx = 0; wx < nx; wx++) {
        let e = 0;
        for (let c = 0; c < NB; c++) e += rect(W1, wx, wy, wx + s, wy + s, c);
        energy[wy * nx + wx] = e / (s * s * B * B);
      }
    }
    cur = { nx, ny, n, s, W1, cut: [0, Math.round(s / 3), Math.round((2 * s) / 3), s] };
    return cur;
  }

  function ensure(w) {
    if (have[w]) return;
    have[w] = 1;
    const { nx, W1, cut } = cur;
    const wx = w % nx;
    const wy = (w / nx) | 0;
    const o = w * ND;
    let h2 = 0;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const x0 = wx + cut[gx];
        const x1 = wx + cut[gx + 1];
        const y0 = wy + cut[gy];
        const y1 = wy + cut[gy + 1];
        const k = gy * 3 + gx;
        for (let c = 0; c < NB; c++) {
          const r = Math.sqrt(Math.max(0, rect(W1, x0, y0, x1, y1, c))); // Hellinger: tames strong edges
          desc[o + k * NB + c] = r;
          h2 += r * r;
        }
        lbuf[k] = rect(W1, x0, y0, x1, y1, NB) / Math.max(1, (x1 - x0) * (y1 - y0));
      }
    }
    const hn = 1 / Math.sqrt(h2 + 1e-9);
    for (let j = 0; j < 9 * NB; j++) desc[o + j] *= hn;
    let lm = 0;
    for (let k = 0; k < 9; k++) lm += lbuf[k] / 9;
    let lv = 0;
    for (let k = 0; k < 9; k++) lv += (lbuf[k] - lm) ** 2;
    const ln = 0.5 / Math.sqrt(lv + 0.002); // light/dark layout counts half
    let t = 0;
    for (let k = 0; k < 9; k++) {
      const v = (lbuf[k] - lm) * ln;
      desc[o + 9 * NB + k] = v;
    }
    for (let j = 0; j < ND; j++) t += desc[o + j] * desc[o + j];
    const tn = 1 / Math.sqrt(t + 1e-12);
    for (let j = 0; j < ND; j++) desc[o + j] *= tn;
  }

  function cos(a, b) {
    ensure(a);
    ensure(b);
    const oa = a * ND;
    const ob = b * ND;
    let d = 0;
    for (let j = 0; j < ND; j++) d += desc[oa + j] * desc[ob + j];
    return d;
  }

  // Largest subset of points within tol of one line (pairs define lines).
  function bestLine(pts, tol) {
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[j].x - pts[i].x;
        const dy = pts[j].y - pts[i].y;
        const L = Math.hypot(dx, dy);
        if (L < 1e-6) continue;
        const ux = dx / L;
        const uy = dy / L;
        const inl = pts.filter((p) => Math.abs((p.x - pts[i].x) * uy - (p.y - pts[i].y) * ux) <= tol);
        if (inl.length < 3) continue;
        const score = inl.length + inl.reduce((s, p) => s + p.sim, 0) * 0.01;
        // read left to right (top to bottom for an upright row)
        const flip = Math.abs(ux) >= Math.abs(uy) ? ux < 0 : uy < 0;
        if (!best || score > best.score) best = { score, inl, ux: flip ? -ux : ux, uy: flip ? -uy : uy };
      }
    }
    return best;
  }

  /**
   * @param img    grey level image (0..1), iw×ih
   * @param scale  level downsampling (to convert back to analysis px)
   * @param skip   (x, y) → true where no anchor should sit (analysis px)
   * @param sens   detector sensitivity (>1 = more permissive)
   * @returns candidate rows in analysis-px coordinates
   */
  function findInLevel(img, iw, ih, scale, level, skip = null, sens = 1) {
    const opt = loosen(base, sens);
    const pass = opt.passes.find((p) => p.level === level);
    if (!pass) return [];
    const { bw, bh } = blocks(img, iw, ih);
    const B = opt.block;
    const k = B * scale; // block → analysis px
    const out = [];
    for (const s of pass.sizes) {
      const g = describe(bw, bh, s);
      if (!g || g.n < 6) continue;
      const { nx, ny, n } = g;
      if (sims.length < n) sims = new Float32Array(n);
      // anchors: energetic windows, spread out, that are not textures
      const order = [];
      for (let w = 0; w < n; w++) if (energy[w] >= opt.minEnergy) order.push(w);
      order.sort((a, b) => energy[b] - energy[a]);
      const anchors = [];
      const half = Math.max(1, Math.round(s / 2));
      for (const w of order) {
        if (anchors.length >= opt.anchors) break;
        const wx = w % nx;
        const wy = (w / nx) | 0;
        // inside a known stripe/lattice: that repetition is already heard
        if (skip && skip((wx + s / 2) * k, (wy + s / 2) * k)) continue;
        if (anchors.some((a) => Math.abs((a % nx) - wx) < half && Math.abs(((a / nx) | 0) - wy) < half)) continue;
        let self = 0;
        for (const [dx, dy] of [[half, 0], [-half, 0], [0, half], [0, -half]]) {
          const x = wx + dx;
          const y = wy + dy;
          if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
          self = Math.max(self, cos(w, y * nx + x));
        }
        if (self > opt.maxSelfShift) continue;
        anchors.push(w);
      }
      if (stamp.length < n) stamp = new Int32Array(n);
      for (const a of anchors) {
        const ax = a % nx;
        const ay = (a / nx) | 0;
        const id = ++scanId;
        const simAt = (x, y) => {
          const w = y * nx + x;
          if (stamp[w] !== id) {
            stamp[w] = id;
            sims[w] = cos(a, w);
          }
          return sims[w];
        };
        // scan a coarse grid of windows; typical similarity = median of the scan
        const sample = [];
        const st = opt.scanStep;
        for (let wy = 0; wy < ny; wy += st) for (let wx = 0; wx < nx; wx += st) sample.push(simAt(wx, wy));
        const sorted = sample.slice().sort((p, q) => p - q);
        const med = sorted[sorted.length >> 1];
        const need = Math.max(opt.minSim, med + opt.minLift);
        // looks like a quarter of the frame: a texture or a grid, not a thing
        let alike = 0;
        for (const v of sample) if (v >= need) alike++;
        if (alike > 0.25 * sample.length) continue;
        const near = Math.max(need - 0.2, med + 0.1); // coarse samples may miss the exact peak
        const cands = [];
        const seen = new Set();
        // climb only from the most promising coarse samples
        const starts = [];
        for (let wy = 0; wy < ny; wy += st) {
          for (let wx = 0; wx < nx; wx += st) {
            const v = simAt(wx, wy);
            if (v >= near) starts.push([v, wx, wy]);
          }
        }
        if (starts.length > opt.maxClimbs) {
          starts.sort((p, q) => q[0] - p[0]);
          starts.length = opt.maxClimbs;
        }
        for (const [, wx, wy] of starts) {
          {
            // climb to the best window nearby
            let bx = wx;
            let by = wy;
            let bv = simAt(wx, wy);
            for (let it = 0; it < 4; it++) {
              let moved = false;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const x = bx + dx;
                  const y = by + dy;
                  if ((dx || dy) && x >= 0 && y >= 0 && x < nx && y < ny && simAt(x, y) > bv) {
                    bv = simAt(x, y); bx = x; by = y; moved = true;
                  }
                }
              }
              if (!moved) break;
            }
            const key = by * nx + bx;
            if (seen.has(key)) continue;
            seen.add(key);
            const v = bv;
            if (v < need || energy[key] < 0.6 * opt.minEnergy) continue;
            if (Math.hypot(bx - ax, by - ay) < opt.minGap * s) continue;
            // sub-block position: parabola through the similarity peak
            const at = (x, y) => (x >= 0 && y >= 0 && x < nx && y < ny ? simAt(x, y) : v);
            const sub = (l, r) => {
              const den = l - 2 * v + r;
              return den < 0 ? clamp((0.5 * (l - r)) / den, -0.5, 0.5) : 0;
            };
            cands.push({ x: bx + sub(at(bx - 1, by), at(bx + 1, by)), y: by + sub(at(bx, by - 1), at(bx, by + 1)), sim: v });
          }
        }
        if (cands.length < opt.minCount - 1) continue;
        // keep look-alikes apart from each other too
        cands.sort((p, q) => q.sim - p.sim);
        const pts = [{ x: ax, y: ay, sim: 1, anchor: true }];
        for (const c of cands) {
          if (pts.length >= opt.maxCount + 8) break;
          if (pts.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= opt.minGap * s)) pts.push(c);
        }
        if (pts.length < opt.minCount) continue;
        const total = pts.length; // look-alikes anywhere in the frame (+ anchor)
        const line = bestLine(pts, opt.lineTol * s);
        if (!line || !line.inl.some((p) => p.anchor)) continue;
        // order along the line; split where a gap is far larger than usual,
        // or where nothing different lies between two neighbours (one long
        // edge or line looks alike all along: that is one thing, not a row)
        const u = (p) => p.x * line.ux + p.y * line.uy;
        let row = line.inl.slice().sort((p, q) => u(p) - u(q));
        const gapsOf = (r) => r.slice(1).map((p, i) => u(p) - u(r[i]));
        let gaps = gapsOf(row);
        const medGap = gaps.slice().sort((p, q) => p - q)[gaps.length >> 1];
        const dip = (a, b, depth = opt.minDip) => {
          // best match anywhere near the midpoint (thin lines are touchy
          // about a block's offset)
          const mx = Math.round((a.x + b.x) / 2);
          const my = Math.round((a.y + b.y) / 2);
          let m = -1;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = mx + dx;
              const y = my + dy;
              if (x >= 0 && y >= 0 && x < nx && y < ny) m = Math.max(m, simAt(x, y));
            }
          }
          return m < Math.min(a.sim, b.sim) - depth && m < need - 0.05;
        };
        const runs = [[row[0]]];
        gaps.forEach((gp, i) => {
          if (gp > opt.maxGapRatio * medGap || !dip(row[i], row[i + 1])) runs.push([]);
          runs[runs.length - 1].push(row[i + 1]);
        });
        row = runs.find((r) => r.some((p) => p.anchor));
        if (!row || row.length < opt.minCount) continue;
        if (row.length > opt.maxCount) continue; // a long even run is a texture or stripes
        // a thing that resembles half the frame is a texture, not a row
        if (row.length < opt.onLine * total) continue;
        gaps = gapsOf(row);
        const mean = gaps.reduce((p, q) => p + q, 0) / gaps.length;
        const sd = Math.sqrt(gaps.reduce((p, q) => p + (q - mean) ** 2, 0) / gaps.length);
        if (sd > opt.maxUneven * mean) continue;
        // three is the fewest that make a row: then every one must be clear
        // (and roughly evenly placed: three lumps by chance are seldom even)
        if (row.length === opt.minCount &&
          (Math.min(...row.map((p) => p.sim)) < opt.minSim3 || sd > 0.3 * mean ||
            !row.slice(1).every((p, i) => dip(row[i], p, base.minDip)))) continue;
        const lookalikes = row.filter((p) => !p.anchor);
        const sim = lookalikes.reduce((p, q) => p + q.sim, 0) / lookalikes.length;
        out.push({
          level,
          scale,
          s,
          size: s * k,
          members: row.map((p) => ({ x: p.x * k, y: p.y * k, w: s * k, h: s * k, sim: p.sim })),
          ux: line.ux,
          uy: line.uy,
          gap: mean * k,
          evenness: mean > 0 ? sd / mean : 0,
          sim,
          score: row.length + sim,
        });
      }
    }
    return out;
  }

  // Many anchors (and window sizes, and levels) find the same row; keep
  // the best of each: same place, same spacing, same direction.
  function consolidate(rows) {
    rows.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const r of rows) {
      const same = kept.some((q) => {
        const gr = r.gap > q.gap ? r.gap / q.gap : q.gap / r.gap;
        const da = Math.abs(Math.atan2(r.uy, r.ux) - Math.atan2(q.uy, q.ux)) % Math.PI;
        const c = (m) => [m.x + m.w / 2, m.y + m.h / 2];
        // every other thing of a row (twice the spacing) is part of it
        const m = Math.round(gr);
        const multiple = (m === 2 || m === 3) && Math.abs(gr - m) < 0.15 * m && r.members.length < q.members.length;
        const parallel = Math.min(da, Math.PI - da) < 0.3;
        // parallel and within about one thing's size of each other …
        const [qx, qy] = c(q.members[0]);
        const perp = (m) => { const [x, y] = c(m); return Math.abs((x - qx) * -q.uy + (y - qy) * q.ux); };
        const dist = r.members.reduce((s, m) => s + perp(m), 0) / r.members.length;
        // a smaller row made of some of q's things is part of q
        const tol = 0.5 * Math.max(r.size, q.size);
        const shared = r.members.filter((m) => q.members.some((n) => {
          const [a, b] = c(m);
          const [x, y] = c(n);
          return Math.hypot(a - x, b - y) < tol;
        })).length;
        if (shared >= 2 && r.members.length <= q.members.length) return true;
        if ((gr > 1.35 && !multiple) || !parallel) return false;
        if (dist > 1.0 * Math.max(r.size, q.size)) return false;
        // … and overlapping along the row
        const along = (m) => { const [x, y] = c(m); return (x - qx) * q.ux + (y - qy) * q.uy; };
        const ra = r.members.map(along);
        const qa = q.members.map(along);
        const lo = Math.max(Math.min(...ra), Math.min(...qa));
        const hi = Math.min(Math.max(...ra), Math.max(...qa));
        const len = Math.min(Math.max(...ra) - Math.min(...ra), Math.max(...qa) - Math.min(...qa));
        return hi - lo >= 0.5 * len;
      });
      if (!same) kept.push(r);
    }
    return kept;
  }

  function toRegion(r, img, iw, scale) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of r.members) {
      x0 = Math.min(x0, m.x);
      y0 = Math.min(y0, m.y);
      x1 = Math.max(x1, m.x + m.w);
      y1 = Math.max(y1, m.y + m.h);
    }
    // contrast from the grey values under the members (level image; a
    // member at the frame's edge may stick out of it)
    const ih = Math.floor(img.length / iw);
    let s = 0, s2 = 0, n = 0;
    for (const m of r.members) {
      const mx0 = Math.floor(m.x / scale);
      const my0 = Math.floor(m.y / scale);
      const mw = Math.floor(m.w / scale);
      for (let y = Math.max(0, my0); y < Math.min(ih, my0 + mw); y += 2) {
        for (let x = Math.max(0, mx0); x < Math.min(iw, mx0 + mw); x += 2) {
          const v = img[y * iw + x];
          s += v;
          s2 += v * v;
          n++;
        }
      }
    }
    const std = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
    // offset of each member from the row's line, in window sizes (→ melody)
    const c0 = r.members[0];
    const nxp = -r.uy;
    const nyp = r.ux;
    const offs = r.members.map((m) => ((m.x - c0.x) * nxp + (m.y - c0.y) * nyp) / r.size);
    const mo = offs.reduce((p, q) => p + q, 0) / offs.length;
    return {
      type: 'ROW',
      family: 'row',
      level: r.level,
      cells: r.members.length,
      cellSize: r.size,
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      period: r.gap,
      angle: ((((Math.atan2(-r.uy, r.ux) * DEG) % 180) + 180) % 180),
      coherence: 1,
      score: clamp(r.sim, 0, 1),
      contrast: clamp(std * 2.5, 0, 1),
      sharp: 0.5,
      size: r.size,
      count: r.members.length,
      evenness: r.evenness,
      // along-row position (0 = first) and sideways offset of every member
      members: r.members.map((m, i) => ({
        x: m.x, y: m.y, w: m.w, h: m.h, sim: m.sim,
        t: i ? ((m.x - c0.x) * r.ux + (m.y - c0.y) * r.uy) : 0,
        off: offs[i] - mo,
      })),
    };
  }

  return { findInLevel, consolidate, toRegion, options: opt };
}
