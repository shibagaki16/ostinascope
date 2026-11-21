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
//   5. a row going away from the camera: its things shrink with distance.
//      Each one's apparent size is measured (the window size it matches the
//      anchor best at). Things of one real size on a straight line shrink
//      linearly along it, to nothing at its vanishing point t_v:
//      w = a (t − t_v); and their real position is X = −1/(t − t_v) (up to
//      scale and offset). One line through the sizes gives t_v, the rhythm
//      then follows the real spacing, not the squeezed one — and the row is
//      extended with smaller (or larger) windows where the next thing
//      should be.
//      Real things vary too much in size for that line to be sure. Most real
//      rows (chairs, posts, windows) are evenly spaced, though: then their
//      image positions follow t = (α i + β)/(γ i + 1) for the i-th thing,
//      which the gaps alone pin down. Gaps shrink with the square of the
//      distance, sizes with the distance: so this reading is taken only when
//      the sizes shrink the same way by about the square root of what the
//      gaps do (a shelf spaced unevenly on purpose has growing gaps but equal
//      sizes, and stays as it is).
//   6. look-alikes in two directions → a lattice of things (bricks, tiles,
//      keys, windows of a facade, the cells of a honeycomb). Seen in a
//      photo, such lattices rarely give the spectral detector clean peaks
//      (shading, uneven colour, wear), but each brick still looks like the
//      next. The anchor's look-alikes give two lattice vectors (from their
//      neighbours); from the anchor the lattice is then walked, each next
//      thing looked for one step from one already found (a lattice bending
//      in perspective is followed). Only things at the corners of whole
//      cells count — a look-alike hanging off by one step can be chance —
//      and the similarity must drop halfway between neighbours in both
//      directions: along a stripe the same look goes on and on, so without
//      that a striped board would read as a lattice too.
//
// Pure module (no DOM).

import { clamp, overlapShare, TO_DEG as DEG } from './util.js';

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
  // perspective (5.): a row counts as receding when its things' sizes change
  // by this factor end to end, steadily along it, and fit the model
  perspective: true,
  minSizeChange: 1.3,
  minSizeOrder: 0.8, // rank correlation of size with position along the row
  maxPerspResidual: 0.15, // sizes off their line, relative to the mean size (rms)
  // evenly spaced rows in perspective (sizes only as a check)
  maxEvenResidual: 0.12, // positions off the fit, relative to the mean gap (rms)
  minEvenDepth: 1.12, // depth ratio end to end the gaps must show
  // measured / expected size change (in log), allowed range … In perspective
  // it is about 1. A window measuring a thing takes in some of the space
  // around it, so where gaps are wider things look larger: with sizes that
  // only follow the gaps (a shelf spaced unevenly on purpose) it comes out
  // near 2 — hence the upper end.
  evenSizeAgree: [0.4, 1.6],
  evenSizeTight: 0.3, // … but sizes that lie close to their line must agree this closely (share of the expected)
  evenMinSize: 3, // blocks: things smaller than this across the row are too small to check the sizes on
  onWhy: null, // (reason, row) → why a row was not read as receding (for tuning; off)
  // 6. lattices of things (null: off). Measured on photo views (bench/
  // families.mjs): lattices 28 → 60 / 360 views, a lattice on stripes 14 →
  // 23 / 270 (half of those are real: window grids, steps laid like
  // bricks), photos without a pattern unchanged. Fitting all look-alikes to
  // one lattice (instead of walking it) found about as many, but also
  // lattices over rows of things and on blurred lettering; walking without
  // whole cells, many more of those. Lowering the similarity for walked
  // things, or asking for 3 cells, loses more than it saves.
  lattice: {
    minLen: 0.7, // lattice vectors at least this × the window (overlapping look-alikes are texture)
    tol: 0.25, // neighbour vectors agree within this × their length
    minAngle: 25, // the two vectors' directions differ by at least this (degrees)
    snap: 0.25, // the next thing is looked for within this × the shorter vector of where a step lands
    maxNodes: 60, // things walked at most
    minCells: 2, // whole cells (four things a step apart each way) at least
    minPoints: 6, // things at their corners at least
    localShare: 0.8, // of the anchor's look-alikes inside the lattice must be its things (0.6: smooth noise reads as a lattice)
    minSpan: 2, // rows and columns (of the reduced basis) at least
    span2Points: 8, // only two wide: at least this many things (2 × 3 chunks of a face are not a lattice)
    maxAspect: 3, // longer / shorter vector: further apart one way, they are rows (two shelves of cups)
    dip: 0.11, // similarity drop halfway between neighbours
    dipShare: 0.6, // of the neighbour pairs, in each direction
    maxPairs: 12, // midpoint checks per direction
  },
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

// The best match in the 3×3 blocks around block (x, y).
function bestAround(simAt, nx, ny, x, y) {
  let m = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < nx && yy < ny) m = Math.max(m, simAt(xx, yy));
    }
  }
  return m;
}

// Least squares of w against t: the means and the sums for the slope
// (slope = sxy / sxx, when sxx > 0).
function lineFit(ts, ws) {
  const n = ts.length;
  const mt = ts.reduce((p, q) => p + q, 0) / n;
  const mw = ws.reduce((p, q) => p + q, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (ts[i] - mt) * (ws[i] - mw);
    sxx += (ts[i] - mt) ** 2;
  }
  return { mt, mw, sxy, sxx };
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
    gridH = bh;
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
    finishDesc(desc, o, h2);
  }

  // Finish a descriptor at d[o…] whose histograms hold squared length h2:
  // the histograms to unit length, the 3×3 light/dark layout (lbuf)
  // centred at half weight, then the whole to unit length.
  function finishDesc(d, o, h2) {
    const hn = 1 / Math.sqrt(h2 + 1e-9);
    for (let j = 0; j < 9 * NB; j++) d[o + j] *= hn;
    let lm = 0;
    for (let k = 0; k < 9; k++) lm += lbuf[k] / 9;
    let lv = 0;
    for (let k = 0; k < 9; k++) lv += (lbuf[k] - lm) ** 2;
    const ln = 0.5 / Math.sqrt(lv + 0.002); // light/dark layout counts half
    for (let k = 0; k < 9; k++) d[o + 9 * NB + k] = (lbuf[k] - lm) * ln;
    let t = 0;
    for (let j = 0; j < ND; j++) t += d[o + j] * d[o + j];
    const tn = 1 / Math.sqrt(t + 1e-12);
    for (let j = 0; j < ND; j++) d[o + j] *= tn;
  }

  // Integral image at fractional block coordinates (bilinear: as if each
  // block's content were spread evenly over it), all channels into out.
  function iiAll(W1, x, y, out, o) {
    const C = NB + 1;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = Math.min(W1 - 1, x0 + 1);
    const y1 = Math.min(gridH, y0 + 1);
    const i00 = (y0 * W1 + x0) * C;
    const i10 = (y0 * W1 + x1) * C;
    const i01 = (y1 * W1 + x0) * C;
    const i11 = (y1 * W1 + x1) * C;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    for (let c = 0; c < C; c++) out[o + c] = w00 * ii[i00 + c] + w10 * ii[i10 + c] + w01 * ii[i01 + c] + w11 * ii[i11 + c];
  }
  const grid16 = new Float32Array(16 * (NB + 1));

  // Descriptor of the window at (wx, wy), size sz — both in blocks and
  // fractional (things shrink smoothly along a row) — into out. false if
  // it does not fit. The 3×3 cells share their 16 corners: read once.
  function descAt(wx, wy, sz, out, szy = sz) {
    const { W1 } = cur;
    const bw = W1 - 1;
    const bh = gridH;
    if (wx < 0 || wy < 0 || wx + sz > bw || wy + szy > bh || sz < 2 || szy < 2) return false;
    const C = NB + 1;
    const cut = [0, sz / 3, (2 * sz) / 3, sz];
    const cuty = [0, szy / 3, (2 * szy) / 3, szy];
    for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) iiAll(W1, wx + cut[gx], wy + cuty[gy], grid16, (gy * 4 + gx) * C);
    const area = (sz / 3) * (szy / 3);
    let h2 = 0;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const a = (gy * 4 + gx) * C;
        const b = (gy * 4 + gx + 1) * C;
        const c2 = ((gy + 1) * 4 + gx) * C;
        const d = ((gy + 1) * 4 + gx + 1) * C;
        const k = gy * 3 + gx;
        for (let c = 0; c < NB; c++) {
          const r = Math.sqrt(Math.max(0, grid16[d + c] - grid16[b + c] - grid16[c2 + c] + grid16[a + c]));
          out[k * NB + c] = r;
          h2 += r * r;
        }
        lbuf[k] = (grid16[d + NB] - grid16[b + NB] - grid16[c2 + NB] + grid16[a + NB]) / Math.max(1e-6, area);
      }
    }
    finishDesc(out, 0, h2);
    return true;
  }
  const dtmp = new Float32Array(ND);
  const danc = new Float32Array(ND);
  let gridH = 0;

  // Similarity to the anchor (danc) of a window of size sz centred near
  // (cx, cy) blocks: the best over shifts of up to ±range in steps of step.
  function simSized(cx, cy, sz, range = 0.5, step = 0.5, szy = sz) {
    let best = -1;
    let bx = cx;
    let by = cy;
    for (let dy = -range; dy <= range + 1e-9; dy += step) {
      for (let dx = -range; dx <= range + 1e-9; dx += step) {
        const wx = cx - sz / 2 + dx;
        const wy = cy - szy / 2 + dy;
        if (!descAt(wx, wy, sz, dtmp, szy)) continue;
        let d = 0;
        for (let j = 0; j < ND; j++) d += danc[j] * dtmp[j];
        if (d > best) {
          best = d;
          bx = cx + dx;
          by = cy + dy;
        }
      }
    }
    return { sim: best, cx: bx, cy: by };
  }

  // The size (blocks) at which a thing near (cx, cy) looks most like the
  // anchor: window sizes ×1.1 apart (a window matching a larger thing also
  // sits a little off: shifts up to a block), refined by a parabola in
  // log-size. Returns { size, sim, cx, cy }. `quick`: sizes ×1.25 apart,
  // whole-block shifts (to see whether sizes change at all).
  function sizeOf(cx, cy, lo, hi, quick = false) {
    const f = quick ? 1.25 : 1.1;
    const tries = [];
    for (let sz = Math.max(2, lo); sz <= hi * 1.001; sz *= f) tries.push({ sz, ...simSized(cx, cy, sz, 1, 1) });
    if (!tries.length) return null;
    let bi = 0;
    tries.forEach((t, i) => {
      if (t.sim > tries[bi].sim) bi = i;
    });
    const b = tries[bi];
    let size = b.sz;
    if (bi > 0 && bi < tries.length - 1) {
      const l = tries[bi - 1].sim;
      const r = tries[bi + 1].sim;
      const den = l - 2 * b.sim + r;
      if (den < 0) size = b.sz * f ** clamp((0.5 * (l - r)) / den, -0.5, 0.5);
    }
    return { size, sim: b.sim, cx: b.cx, cy: b.cy };
  }

  // A thing's size across the row (its height, for a row running sideways):
  // the window keeps the anchor's length along the row and stretches across
  // it. Unlike the plain size, the gaps along the row cannot sway it.
  function acrossOf(cx, cy, s, across, lo, hi) {
    let best = null;
    const tries = [];
    for (let sz = Math.max(2, lo); sz <= hi * 1.001; sz *= 1.1) {
      const t = across === 'y' ? simSized(cx, cy, s, 1, 1, sz) : simSized(cx, cy, sz, 1, 1, s);
      tries.push({ sz, ...t });
    }
    tries.forEach((t, i) => {
      if (!best || t.sim > best.sim) best = { ...t, i };
    });
    if (!best) return null;
    let size = best.sz;
    if (best.i > 0 && best.i < tries.length - 1) {
      const l = tries[best.i - 1].sim;
      const r = tries[best.i + 1].sim;
      const den = l - 2 * best.sim + r;
      if (den < 0) size = best.sz * 1.1 ** clamp((0.5 * (l - r)) / den, -0.5, 0.5);
    }
    return size;
  }

  // Real positions along a receding row from apparent sizes (see 5. above):
  // a line w = a t + b through the sizes gives the vanishing point; returns
  // positions rescaled to the row's span in the image, or null when the
  // sizes do not say it recedes.
  function perspectivePositions(ts, ws, o) {
    const n = ts.length;
    if (n < (o.provisional ? 3 : 4)) return null;
    // sizes change steadily along the row (rank correlation)
    const rank = (v) => {
      const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
      const r = new Array(n);
      idx.forEach(([, i], j) => (r[i] = j));
      return r;
    };
    const rt = rank(ts);
    const rw = rank(ws);
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += (rt[i] - rw[i]) ** 2;
    const rho = 1 - (6 * d2) / (n * (n * n - 1));
    if (!o.provisional && Math.abs(rho) < o.minSizeOrder) return null;
    // w = a t + b
    const { mt, mw, sxy, sxx } = lineFit(ts, ws);
    if (!(sxx > 0)) return null;
    const a = sxy / sxx;
    const b = mw - a * mt;
    const wp = ts.map((t) => a * t + b);
    if (wp.some((w) => !(w > 0))) return null;
    const rms = Math.sqrt(ws.reduce((acc, w, i) => acc + (w - wp[i]) ** 2, 0) / n);
    if (rms > o.maxPerspResidual * mw) return null;
    const change = Math.max(wp[0], wp[n - 1]) / Math.min(wp[0], wp[n - 1]);
    if (change < o.minSizeChange) return null;
    const tv = -b / a;
    const X = ts.map((t) => -1 / (t - tv));
    const span = ts[n - 1] - ts[0];
    const toPos = (x) => ts[0] + ((x - X[0]) / (X[n - 1] - X[0])) * span;
    return {
      pos: X.map(toPos),
      sizeChange: change,
      sizes: wp,
      // for growing the row: real ↔ image along the row
      model: { a, b, tv, X0: X[0], Xn: X[n - 1], t0: ts[0], span },
    };
  }

  // An evenly spaced row in perspective (see 5.): fit t = (α i + β)/(γ i + 1)
  // to the positions, with a missed thing (a gap about twice the expected)
  // skipping an index; check the sizes agree. Returns { pos, sizes,
  // sizeChange, model } or null. `provisional`: three things, fitted exactly
  // (only good enough to look for a fourth).
  function evenPerspective(ts, ws, o, provisional = false) {
    const n = ts.length;
    if (n < (provisional ? 3 : 4)) return o.onReason && o.onReason('too few'), null;
    const solveFor = (idx) => {
      // t (γ i + 1) = α i + β  →  [i, 1, −i t] · (α, β, γ) = t
      let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, b1 = 0, b2 = 0, b3 = 0;
      for (let k = 0; k < n; k++) {
        const i = idx[k];
        const r = [i, 1, -i * ts[k]];
        a11 += r[0] * r[0]; a12 += r[0] * r[1]; a13 += r[0] * r[2];
        a22 += r[1] * r[1]; a23 += r[1] * r[2]; a33 += r[2] * r[2];
        b1 += r[0] * ts[k]; b2 += r[1] * ts[k]; b3 += r[2] * ts[k];
      }
      const M = [[a11, a12, a13, b1], [a12, a22, a23, b2], [a13, a23, a33, b3]];
      for (let c = 0; c < 3; c++) {
        let pv = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[pv][c])) pv = r;
        if (Math.abs(M[pv][c]) < 1e-12) return null;
        [M[c], M[pv]] = [M[pv], M[c]];
        for (let r = 0; r < 3; r++) {
          if (r === c) continue;
          const f = M[r][c] / M[c][c];
          for (let q = c; q < 4; q++) M[r][q] -= f * M[c][q];
        }
      }
      return M.map((row, k) => row[3] / row[k]);
    };
    const tAt = (m, i) => (m[0] * i + m[1]) / (m[2] * i + 1);
    let idx = ts.map((_, k) => k);
    let m = solveFor(idx);
    if (!m) return o.onReason && o.onReason('no fit'), null;
    // a thing not found leaves a gap about twice the expected: skip an index
    for (let it = 0; it < 2 && !provisional; it++) {
      const next = [0];
      let changed = false;
      for (let k = 1; k < n; k++) {
        const i = next[k - 1];
        const step = tAt(m, i + 1) - tAt(m, i);
        const gap = ts[k] - ts[k - 1];
        const skip = step > 0 && gap > 1.6 * step ? Math.min(3, Math.round(gap / step)) : 1;
        if (skip !== 1) changed = true;
        next.push(i + skip);
      }
      if (!changed) break;
      const m2 = solveFor(next);
      if (!m2) break;
      idx = next;
      m = m2;
    }
    const i0 = idx[0];
    const i1 = idx[n - 1];
    for (let i = i0; i <= i1; i++) if (!(m[2] * i + 1 > 0)) return o.onReason && o.onReason('beyond vanishing point'), null;
    const pred = idx.map((i) => tAt(m, i));
    for (let k = 1; k < n; k++) if (!(pred[k] > pred[k - 1])) return o.onReason && o.onReason('order'), null;
    const meanGap = (ts[n - 1] - ts[0]) / (i1 - i0);
    const rms = Math.sqrt(pred.reduce((acc, v, k) => acc + (v - ts[k]) ** 2, 0) / n);
    if (!provisional && rms > o.maxEvenResidual * meanGap) return o.onReason && o.onReason('gaps off the even fit'), null;
    // depth end to end, and the sizes it implies (∝ 1/depth)
    const Z = (i) => m[2] * i + 1;
    const depth = Z(i1) / Z(i0); // > 1: the far end is the last
    const pc = Math.max(depth, 1 / depth);
    if (pc < o.minEvenDepth) return o.onReason && o.onReason('too little depth'), null;
    // measured size change, from a line through the sizes
    const { mt, mw, sxy, sxx } = lineFit(ts, ws);
    const sl = sxx > 0 ? sxy / sxx : 0;
    const w0 = mw + sl * (ts[0] - mt);
    const w1 = mw + sl * (ts[n - 1] - mt);
    if (!(w0 > 0 && w1 > 0)) return o.onReason && o.onReason('sizes'), null;
    // sizes: larger at the near end (depth > 1: the first is nearer)
    const measured = Math.log(w0 / w1); // > 0 when the first is larger
    const expected = Math.log(depth);
    if (Math.sign(measured) !== Math.sign(expected)) return o.onReason && o.onReason('sizes the wrong way'), null;
    const agree = measured / expected;
    if (agree < o.evenSizeAgree[0] || agree > o.evenSizeAgree[1]) return o.onReason && o.onReason('size change disagrees'), null;
    // how sure the measured change is: sizes off their line (rms) → the
    // uncertainty of its ends. Things all alike (books) give sure sizes, and
    // then the gaps must not claim more depth than the sizes show — a shelf
    // spaced unevenly on purpose, seen a little from the side, has some
    // real perspective in its sizes and much more "depth" in its gaps.
    let r2 = 0;
    for (let k = 0; k < n; k++) r2 += (ws[k] - (mw + sl * (ts[k] - mt))) ** 2;
    const rmsRel = Math.sqrt(r2 / n) / mw;
    const sigma = rmsRel * Math.sqrt(12 / n); // log-change uncertainty, roughly
    if (Math.abs(measured - expected) > Math.max(2 * sigma, o.evenSizeTight * Math.abs(expected))) {
      return o.onReason && o.onReason('sizes too sure to agree'), null;
    }
    const span = ts[n - 1] - ts[0];
    const zMean = idx.reduce((p, i) => p + 1 / Z(i), 0) / n;
    return {
      pos: idx.map((i) => ts[0] + ((i - i0) / (i1 - i0)) * span),
      sizes: idx.map((i) => (mw * (1 / Z(i))) / zMean),
      sizeChange: pc,
      model: { m, idx, mw, zMean },
      even: true,
    };
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
    const lats = [];
    const pass = opt.passes.find((p) => p.level === level);
    if (!pass) return Object.assign([], { lattices: lats });
    const { bw, bh } = blocks(img, iw, ih);
    const B = opt.block;
    const k = B * scale; // block → analysis px
    const out = [];
    const why = (reason, r) => {
      if (opt.onWhy) opt.onWhy(reason, r);
      return null;
    };
    // the same row is found from several of its things (each can be the
    // anchor): its perspective is worked out once per frame
    const recedeMemo = new Map();
    // 5. A row's things' sizes and real positions; grow the row along its
    // line with windows of the size the model expects there. Returns
    // { row, pos, sizeChange } (row with .size per thing) or null.
    function recede(row0, a, s, nx, ny, need, line, u) {
      // the anchor's own descriptor, to match any window size against
      ensure(a);
      danc.set(desc.subarray(a * ND, a * ND + ND));
      const lo = Math.max(2, s * 0.55);
      const hi = s * 1.8;
      // cheapest first: a receding row's gaps in the image shrink (or grow)
      // along it — most rows face the camera, and their gaps do not trend
      const ts0 = row0.map((p) => u({ x: p.x, y: p.y }));
      const gp = ts0.slice(1).map((t, i) => t - ts0[i]);
      let trend = 0;
      if (gp.length >= 2) {
        if (Math.max(...gp) / Math.min(...gp) < 1.15) return why('gaps flat', row0);
        // the gaps grow (or shrink) along the row: rank correlation with
        // their place (real things sit a little off their spots)
        let trendSum = 0;
        if (gp.length === 2) trendSum = Math.sign(gp[1] - gp[0]);
        else {
          const r = gp.map((g, i) => [g, i]).sort((a, b) => a[0] - b[0]);
          const rk = new Array(gp.length);
          r.forEach(([, i], j) => (rk[i] = j));
          let d2 = 0;
          for (let i = 0; i < gp.length; i++) d2 += (rk[i] - i) ** 2;
          const m = gp.length;
          const rho = 1 - (6 * d2) / (m * (m * m - 1));
          if (Math.abs(rho) < 0.6) return why('gaps not one way', row0);
          trendSum = Math.sign(rho);
        }
        trend = trendSum;
      }
      // a cheap look at the two ends: when they clearly match, skip the
      // full measurement (most rows face the camera)
      const end0 = sizeOf(row0[0].x + s / 2, row0[0].y + s / 2, lo, hi, true);
      const end1 = sizeOf(row0[row0.length - 1].x + s / 2, row0[row0.length - 1].y + s / 2, lo, hi, true);
      if (end0 && end1 && Math.max(end0.size, end1.size) / Math.min(end0.size, end1.size) < 1.05) return why('ends same size (quick)', row0);
      const measure = (p) => {
        const z = sizeOf(p.x + s / 2, p.y + s / 2, lo, hi);
        return z ? { ...p, size: z.size } : { ...p, size: s };
      };
      let row = row0.map(measure);
      // nearer things are larger and further apart: sizes (a line through
      // all of them) must change, and the way the gaps do
      {
        const ts1 = row.map((p) => u({ x: p.x, y: p.y }));
        const ws1 = row.map((p) => p.size);
        const n1 = ts1.length;
        const mt = ts1.reduce((a2, b2) => a2 + b2, 0) / n1;
        const mw = ws1.reduce((a2, b2) => a2 + b2, 0) / n1;
        let sxy = 0;
        let sxx = 0;
        for (let i = 0; i < n1; i++) {
          sxy += (ts1[i] - mt) * (ws1[i] - mw);
          sxx += (ts1[i] - mt) ** 2;
        }
        const sl = sxx > 0 ? sxy / sxx : 0;
        const w0 = mw + sl * (ts1[0] - mt);
        const w1 = mw + sl * (ts1[n1 - 1] - mt);
        if (!(w0 > 0 && w1 > 0) || Math.max(w0, w1) / Math.min(w0, w1) < 1.08) return why('ends same size', row);
        if (trend && Math.sign(w1 - w0) !== trend) return why('sizes against gaps', row);
      }
      const fit = (r) => perspectivePositions(r.map((p) => u({ x: p.x, y: p.y })), r.map((p) => p.size), opt);
      let P = fit(row);
      // the sizes alone are not sure: an evenly spaced row, read from its gaps
      if (!P) return recedeEven(row, s, need, line, u, why);
      // grow at both ends while the model finds the next thing
      for (const end of [1, -1]) {
        for (let tries = 0; tries < 6 && row.length < opt.maxCount; tries++) {
          const n = row.length;
          const ts = row.map((p) => u({ x: p.x, y: p.y }));
          // next real position: one median real gap beyond the end, back
          // into the image through the vanishing point; its size on the line
          const { a: sa, b: sb, tv } = P.model;
          const X = ts.map((t) => -1 / (t - tv));
          const gapsR = X.slice(1).map((v, i) => v - X[i]).sort((p, q) => p - q);
          const g = gapsR[gapsR.length >> 1];
          const Xn = end > 0 ? X[n - 1] + g : X[0] - g;
          if (!(Xn < 0)) break; // beyond the vanishing point
          const tn = tv - 1 / Xn;
          const wn = sa * tn + sb;
          if (!(wn >= 2) || wn > 3 * s) break;
          // the predicted centre on the row's line, in block coords
          const base = row[end > 0 ? n - 1 : 0];
          const bt = ts[end > 0 ? n - 1 : 0];
          const cx = base.x + s / 2 + (tn - bt) * line.ux;
          const cy = base.y + s / 2 + (tn - bt) * line.uy;
          const lo2 = Math.max(2, Math.floor(wn * 0.8));
          const hi2 = Math.ceil(wn * 1.25);
          const z = sizeOf(cx, cy, lo2, hi2);
          if (!z || z.sim < need) break;
          // it must stand apart from the end thing (something different between)
          const mid = simSized((cx + base.x + s / 2) / 2, (cy + base.y + s / 2) / 2, Math.round((z.size + base.size) / 2));
          if (mid.sim > Math.min(z.sim, base.sim || 1) - opt.minDip) break;
          const np = { x: z.cx - s / 2, y: z.cy - s / 2, sim: z.sim, size: z.size, grown: true };
          const next = end > 0 ? [...row, np] : [np, ...row];
          const P2 = fit(next);
          if (!P2) break;
          row = next;
          P = P2;
        }
      }
      // P is the fit of the row as grown (each step kept only when it fits)
      return { row: row.map((p, i) => ({ ...p, size: P.sizes[i] })), pos: P.pos, sizeChange: P.sizeChange, by: 'sizes' };
    }
    // 5b. An evenly spaced receding row (evenPerspective): grow it at both
    // ends where the next thing should be, and keep it only when it stands.
    function recedeEven(row0, s, need, line, u, why) {
      let reason = '';
      // the check on the sizes uses each thing's size across the row
      const across = Math.abs(line.ux) >= Math.abs(line.uy) ? 'y' : 'x';
      const lo = Math.max(2, s * 0.55);
      const hi = s * 1.8;
      const acrossSize = (p) => (p.across ??= acrossOf(p.x + s / 2, p.y + s / 2, s, across, lo, hi) || p.size);
      const at = (r) => evenPerspective(r.map((p) => u({ x: p.x, y: p.y })), r.map(acrossSize), { ...opt, onReason: (x) => (reason = x) }, r.length < 4);
      let row = row0.map((p) => ({ ...p }));
      // too small to measure (a distant shelf): the sizes cannot vouch for
      // the gaps, and the gaps alone cannot tell perspective from a rhythm
      if (Math.min(...row.map(acrossSize)) < opt.evenMinSize) return why('even: things too small to check', row);
      let E = at(row);
      if (!E) return why(`even: ${reason}`, row);
      for (const end of [1, -1]) {
        for (let tries = 0; tries < 6 && row.length < opt.maxCount; tries++) {
          const n = row.length;
          const ts = row.map((p) => u({ x: p.x, y: p.y }));
          const { m, idx, mw, zMean } = E.model;
          const i = end > 0 ? idx[n - 1] + 1 : idx[0] - 1;
          const zi = m[2] * i + 1;
          if (!(zi > 0)) break;
          const tn = (m[0] * i + m[1]) / zi;
          const wn = (mw * (1 / zi)) / zMean;
          if (!(wn >= 2) || wn > 3 * s) break;
          const base = row[end > 0 ? n - 1 : 0];
          const bt = ts[end > 0 ? n - 1 : 0];
          if ((tn - bt) * end <= 0) break;
          const cx = base.x + s / 2 + (tn - bt) * line.ux;
          const cy = base.y + s / 2 + (tn - bt) * line.uy;
          const z = sizeOf(cx, cy, Math.max(2, wn * 0.8), wn * 1.25);
          if (!z || z.sim < need) break;
          const mid = simSized((cx + base.x + s / 2) / 2, (cy + base.y + s / 2) / 2, (z.size + base.size) / 2);
          if (mid.sim > Math.min(z.sim, base.sim || 1) - opt.minDip) break;
          const np = { x: z.cx - s / 2, y: z.cy - s / 2, sim: z.sim, size: z.size, grown: true };
          const next = end > 0 ? [...row, np] : [np, ...row];
          const E2 = at(next);
          if (!E2) break;
          row = next;
          E = E2;
        }
      }
      if (row.length < 4) return why('even: three, did not grow', row);
      E = evenPerspective(row.map((p) => u({ x: p.x, y: p.y })), row.map(acrossSize), { ...opt, onReason: (x) => (reason = x) });
      if (!E) return why(`even (grown): ${reason}`, row);
      return { row: row.map((p, k) => ({ ...p, size: E.sizes[k] })), pos: E.pos, sizeChange: E.sizeChange, by: 'gaps' };
    }

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
        // 6. the same look-alikes in two directions: a lattice of things
        if (opt.lattice) {
          const lat = fitLattice(pts, s, simAt, nx, ny, need);
          if (lat) lats.push(latticeRecord(lat, img, iw, level, scale, s, k));
        }
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
          const m = bestAround(simAt, nx, ny, Math.round((a.x + b.x) / 2), Math.round((a.y + b.y) / 2));
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
        // 5. going away from the camera? sizes, real positions, and the
        // things beyond the ends that the anchor's size missed
        let persp = null;
        if (opt.perspective && row.length >= 3) {
          const key = `${s}:` + row.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).sort().join(';');
          if (recedeMemo.has(key)) persp = recedeMemo.get(key);
          else {
            persp = recede(row, a, s, nx, ny, need, line, u);
            recedeMemo.set(key, persp);
          }
        }
        if (persp) row = persp.row;
        const along = persp ? persp.pos : row.map(u);
        gaps = along.slice(1).map((v, i) => v - along[i]);
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
          members: row.map((p, i) => {
            const sz = p.size || s;
            // centre stays; box of the thing's own size
            const cx = p.x + s / 2;
            const cy = p.y + s / 2;
            return { x: (cx - sz / 2) * k, y: (cy - sz / 2) * k, w: sz * k, h: sz * k, sim: p.sim,
              along: persp ? (persp.pos[i] - persp.pos[0]) * k : undefined };
          }),
          ux: line.ux,
          uy: line.uy,
          gap: mean * k,
          evenness: mean > 0 ? sd / mean : 0,
          receding: persp ? persp.sizeChange : 0,
          recedingBy: persp ? persp.by : null,
          sim,
          // the same row read with its perspective beats a reading without
          score: row.length + sim + (persp ? 0.5 : 0),
        });
      }
    }
    out.lattices = lats;
    return out;
  }

  // 6. A lattice through the look-alikes pts (window positions, blocks):
  // { a, b, det, on, span } or null. simAt(x, y): similarity to the anchor
  // of the window at (x, y); need: the similarity of a look-alike.
  let lvx = new Float64Array(0);
  let lvy = new Float64Array(0);
  let lvr = new Float64Array(0);
  let lok = new Uint8Array(0);
  function fitLattice(pts, s, simAt, nx, ny, need) {
    const L = opt.lattice;
    const np = pts.length;
    if (np < L.minPoints) return null;
    // each thing's 3 nearest neighbours, folded into one half-plane (typed
    // arrays: this runs for most anchors)
    if (lvx.length < 3 * np) {
      lvx = new Float64Array(3 * np);
      lvy = new Float64Array(3 * np);
      lvr = new Float64Array(3 * np);
      lok = new Uint8Array(3 * np);
    }
    let nv = 0;
    for (let pi = 0; pi < np; pi++) {
      const p = pts[pi];
      let i0 = -1, i1 = -1, i2 = -1, r0 = Infinity, r1 = Infinity, r2 = Infinity;
      for (let qi = 0; qi < np; qi++) {
        if (qi === pi) continue;
        const r = Math.hypot(pts[qi].x - p.x, pts[qi].y - p.y);
        if (r < r0) { i2 = i1; r2 = r1; i1 = i0; r1 = r0; i0 = qi; r0 = r; }
        else if (r < r1) { i2 = i1; r2 = r1; i1 = qi; r1 = r; }
        else if (r < r2) { i2 = qi; r2 = r; }
      }
      for (const [qi, r] of [[i0, r0], [i1, r1], [i2, r2]]) {
        if (qi < 0) continue;
        const x = pts[qi].x - p.x;
        const y = pts[qi].y - p.y;
        const f = y < 0 || (y === 0 && x < 0) ? -1 : 1;
        lvx[nv] = f * x;
        lvy[nv] = f * y;
        lvr[nv] = r;
        nv++;
      }
    }
    const angDiff = (u, v) => {
      const d = Math.abs(Math.atan2(u.y, u.x) - Math.atan2(v.y, v.x)) % Math.PI;
      return Math.min(d, Math.PI - d) * DEG;
    };
    // the best supported vector (and its supporters' mean) among those lok
    // lets take part; supporters lie within tol × its length
    const pick = () => {
      let best = -1;
      let bs = 0;
      const lim = L.minLen * s;
      for (let v = 0; v < nv; v++) {
        if (lvr[v] < lim || !lok[v]) continue;
        const t2 = (L.tol * lvr[v]) ** 2;
        let c = 0;
        for (let w = 0; w < nv; w++) if (lok[w] && (lvx[w] - lvx[v]) ** 2 + (lvy[w] - lvy[v]) ** 2 <= t2) c++;
        if (c > bs || (c === bs && best >= 0 && lvr[v] < lvr[best])) {
          best = v;
          bs = c;
        }
      }
      if (best < 0) return null;
      const t2 = (L.tol * lvr[best]) ** 2;
      let mx = 0, my = 0, n = 0;
      for (let w = 0; w < nv; w++) {
        if (!lok[w] || (lvx[w] - lvx[best]) ** 2 + (lvy[w] - lvy[best]) ** 2 > t2) continue;
        mx += lvx[w];
        my += lvy[w];
        n++;
      }
      return { x: mx / n, y: my / n, r: Math.hypot(mx / n, my / n) };
    };
    lok.fill(1, 0, nv);
    let a = pick();
    if (!a) return null;
    for (let v = 0; v < nv; v++) lok[v] = angDiff({ x: lvx[v], y: lvy[v] }, a) >= L.minAngle ? 1 : 0;
    let b = pick();
    if (!b) return null;
    // Gauss reduction: the same lattice, by its two shortest independent
    // vectors — so that rows and columns are counted as such
    for (let it = 0; it < 8; it++) {
      if (b.r < a.r) [a, b] = [b, a];
      const m = Math.round((a.x * b.x + a.y * b.y) / (a.r * a.r));
      if (!m) break;
      const x = b.x - m * a.x;
      const y = b.y - m * a.y;
      b = { x, y, r: Math.hypot(x, y) };
    }
    if (b.r < L.minLen * s || angDiff(a, b) < L.minAngle || b.r > L.maxAspect * a.r) return null;
    const det = a.x * b.y - a.y * b.x;
    // walk the lattice from the anchor: each next thing is looked for
    // around where a step (±a, ±b) from a thing already found lands, so a
    // lattice that bends in perspective is followed
    const o = pts.find((p) => p.anchor) || pts[0];
    const rad = Math.max(1, Math.round(L.snap * Math.min(a.r, b.r)));
    const nodes = new Map([['0,0', { p: o, i: 0, j: 0 }]]);
    const used = new Set([`${Math.round(o.x)},${Math.round(o.y)}`]);
    const tried = new Set(['0,0']);
    const queue = [nodes.get('0,0')];
    while (queue.length && nodes.size < L.maxNodes) {
      const q = queue.shift();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${q.i + di},${q.j + dj}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const px = Math.round(q.p.x + di * a.x + dj * b.x);
        const py = Math.round(q.p.y + di * a.y + dj * b.y);
        let bv = -1, bx = 0, by = 0;
        for (let y = py - rad; y <= py + rad; y++) {
          for (let x = px - rad; x <= px + rad; x++) {
            if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
            const v = simAt(x, y);
            if (v > bv) {
              bv = v;
              bx = x;
              by = y;
            }
          }
        }
        if (bv < need || energy[by * nx + bx] < 0.6 * opt.minEnergy || used.has(`${bx},${by}`)) continue;
        used.add(`${bx},${by}`);
        const n = { p: { x: bx, y: by, sim: bv }, i: q.i + di, j: q.j + dj };
        nodes.set(key, n);
        queue.push(n);
      }
    }
    // only things at the corners of whole cells count
    const inCell = new Set();
    let cells = 0;
    for (const q of nodes.values()) {
      const c = [`${q.i},${q.j}`, `${q.i + 1},${q.j}`, `${q.i},${q.j + 1}`, `${q.i + 1},${q.j + 1}`];
      if (!c.every((k) => nodes.has(k))) continue;
      cells++;
      for (const k of c) inCell.add(k);
    }
    if (cells < L.minCells) return null;
    for (const k of [...nodes.keys()]) if (!inCell.has(k)) nodes.delete(k);
    const on = [...nodes.values()];
    if (on.length < L.minPoints) return null;
    // Inside the lattice, the anchor's best look-alikes from the whole frame
    // must be its things. A walked thing is the best window around where a
    // step lands, so in smooth noise or along a plank there is always one,
    // a step apart, with the midpoint less alike — but the best look-alikes
    // lie anywhere in between.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { p } of on) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    let inside = 0;
    let hit = 0;
    for (const p of pts) {
      if (p.x < x0 - rad || p.x > x1 + rad || p.y < y0 - rad || p.y > y1 + rad) continue;
      inside++;
      if (on.some((q) => Math.abs(q.p.x - p.x) <= rad + 0.5 && Math.abs(q.p.y - p.y) <= rad + 0.5)) hit++;
    }
    if (hit < L.localShare * inside) return null;
    const span = Math.min(new Set(on.map((q) => q.i)).size, new Set(on.map((q) => q.j)).size);
    if (span < L.minSpan || (span <= 2 && on.length < L.span2Points)) return null;
    // halfway between neighbours, in both directions, something else
    const midSim = (u, v) => bestAround(simAt, nx, ny, Math.round((u.x + v.x) / 2), Math.round((u.y + v.y) / 2));
    const dips = (di, dj) => {
      let pairs = 0;
      let d = 0;
      for (const q of on) {
        if (pairs >= L.maxPairs) break;
        const r = nodes.get(`${q.i + di},${q.j + dj}`);
        if (!r) continue;
        pairs++;
        if (midSim(q.p, r.p) < Math.min(q.p.sim, r.p.sim) - L.dip) d++;
      }
      return pairs >= 2 && d >= L.dipShare * pairs;
    };
    if (!dips(1, 0) || !dips(0, 1)) return null;
    return { a, b, det, on, span };
  }

  // A lattice in analysis px: its two families of lines (spacing and line
  // angle, like a spectral GRID: lines along b lie |det|/|b| apart), its
  // vectors, its things and the box around them, their mean similarity and
  // grey contrast.
  function latticeRecord(lat, img, iw, level, scale, s, k) {
    const { a, b, det, on } = lat;
    const lineAngle = (v) => ((((Math.atan2(-v.y, v.x) * DEG) % 180) + 180) % 180);
    const fams = [
      { p: (Math.abs(det) / b.r) * k, angle: lineAngle(b) },
      { p: (Math.abs(det) / a.r) * k, angle: lineAngle(a) },
    ].sort((u, v) => v.p - u.p);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { p } of on) {
      x0 = Math.min(x0, p.x * k);
      y0 = Math.min(y0, p.y * k);
      x1 = Math.max(x1, (p.x + s) * k);
      y1 = Math.max(y1, (p.y + s) * k);
    }
    const others = on.filter((q) => !q.p.anchor);
    const sim = others.reduce((t, q) => t + q.p.sim, 0) / Math.max(1, others.length);
    const nodes = on.map(({ p }) => ({ x: p.x * k, y: p.y * k, w: s * k }));
    return { level, scale, size: s * k, x: x0, y: y0, w: x1 - x0, h: y1 - y0, fams, count: on.length, sim, span: lat.span,
      basis: [[a.x * k, a.y * k], [b.x * k, b.y * k]], nodes, contrast: contrastUnder(nodes, img, iw, scale) };
  }

  // Grey contrast under some square boxes (analysis px) of a level image.
  function contrastUnder(boxes, img, iw, scale) {
    const ih = Math.floor(img.length / iw);
    let s = 0, s2 = 0, n = 0;
    for (const m of boxes) {
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
    return clamp(std * 2.5, 0, 1);
  }

  // Many lattice records (anchors, sizes, levels) of the same place: the
  // best of each, as detector regions (GRID: whether the things are blobs
  // or cells between lines is not told apart yet).
  function latticeRegions(lats) {
    const kept = [];
    for (const l of lats.slice().sort((p, q) => q.count + q.sim - (p.count + p.sim))) {
      if (!kept.some((q) => overlapShare(q, l) > 0.5)) kept.push(l);
    }
    return kept.map((l) => {
      const [f1, f2] = l.fams;
      return {
        type: 'GRID',
        family: 'lattice',
        level: l.level,
        cells: l.count,
        cellSize: l.size,
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
        cx: l.x + l.w / 2,
        cy: l.y + l.h / 2,
        period: f1.p,
        period2: f2.p,
        ratio: f1.p / f2.p,
        angle: f1.angle,
        latticeAngle: (((f2.angle - f1.angle) % 180) + 180) % 180, // the second family's lines, from the first's
        coherence: 1,
        score: clamp(l.sim, 0, 1),
        contrast: l.contrast,
        sharp: 0.5,
        things: true, // found as a lattice of look-alike things
        span: l.span, // its narrower side, in things (rows × columns of the reduced basis)
        basis: l.basis, // its two vectors (analysis px)
        nodes: l.nodes, // its things: square boxes { x, y, w } (analysis px)
        dirs: [[f1.p, f1.angle], [f2.p, f2.angle]],
      };
    });
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
    const contrast = contrastUnder(r.members, img, iw, scale);
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
      contrast,
      sharp: 0.5,
      size: r.size,
      count: r.members.length,
      evenness: r.evenness,
      receding: r.receding || 0, // size change end to end (0: not receding)
      recedingBy: r.recedingBy || null, // 'sizes' (their line) or 'gaps' (an evenly spaced row)
      // along-row position (0 = first) and sideways offset of every member
      members: r.members.map((m, i) => ({
        x: m.x, y: m.y, w: m.w, h: m.h, sim: m.sim,
        // along-row position: the real one for a receding row
        t: m.along !== undefined ? m.along : i ? ((m.x + m.w / 2 - c0.x - c0.w / 2) * r.ux + (m.y + m.h / 2 - c0.y - c0.h / 2) * r.uy) : 0,
        off: offs[i] - mo,
      })),
    };
  }

  return { findInLevel, consolidate, toRegion, latticeRegions, options: opt };
}
