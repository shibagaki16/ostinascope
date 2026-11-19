// Ostinascope — repetition detector.
//
// The frame is split into 32×32 cells at two scales (level 0 = full
// analysis resolution, level 1 = half resolution, which sees structures
// twice as large). Each cell is windowed and Fourier transformed; peaks in
// the power spectrum tell us whether the cell repeats in one direction
// (STRIPE) or two (GRID / DOTS). Neighbouring cells that agree are merged
// into regions. Clusters of stripe cells whose orientation fans out around
// a common point become CONCENTRIC or RADIAL.
//
// Pure module: no DOM access, so it runs in Node for the tests.

import { makeFFT, fft2d } from './fft.js';

export const CELL = 32;
const N = CELL;
const NN = N * N;
const HALF = N / 2;
const DEG = 180 / Math.PI;

export const TYPE = Object.freeze({
  STRIPE: 'STRIPE',
  GRID: 'GRID',
  DOTS: 'DOTS',
  CONCENTRIC: 'CONCENTRIC',
  RADIAL: 'RADIAL',
});

export function familyOf(type) {
  if (type === TYPE.STRIPE) return 'line';
  if (type === TYPE.GRID || type === TYPE.DOTS) return 'lattice';
  return 'radial';
}

export const DETECTOR_DEFAULTS = Object.freeze({
  sensitivity: 1, // >1 = more permissive
  minContrast: 0.025, // grey std below this = blank cell
  stripeScore: 0.4, // share of spectral energy in one direction (+harmonics)
  latticeScore: 0.45, // share of energy in the two lattice directions
  latticeSecond: 0.2, // 2nd direction must hold this fraction of the 1st
  dotsCross: 0.15, // cross terms (k1±k2) vs fundamentals: dots vs grid lines
  minProminence: 40, // peak power / median power at the same radius
  minRepeat: 0.4, // profile self-correlation two periods on (≥ 3 repeats)
  // Accepted peak radius (cycles per cell) per level. Level 1 continues
  // where level 0 stops, so periods from ~2.7 to ~25 px are covered.
  levels: [
    { rmin: 2.8, rmax: 12 },
    { rmin: 2.5, rmax: 6.4 },
  ],
  minCells: 2,
  singleCellScore: 0.62, // a lone level-1 cell needs to be this clean
  rings: true,
});

const now = () => (globalThis.performance ? performance.now() : Date.now());
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Undirected angle difference between two line orientations (deg). */
export function angleDiff(a, b) {
  let d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}
const ratio = (a, b) => (a > b ? a / b : b / a);

export function createDetector(options = {}) {
  const opt = { ...DETECTOR_DEFAULTS, ...options };
  const fft = makeFFT(N);
  const re = new Float32Array(NN);
  const im = new Float32Array(NN);
  const P = new Float32Array(NN);
  const mask = new Uint8Array(NN);
  const win = new Float32Array(NN);
  const R = new Float32Array(NN);
  const KX = new Int8Array(NN);
  const KY = new Int8Array(NN);
  const cand = []; // half-plane bins eligible as peaks
  const peaks = [];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / N);
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / N);
      win[i] = wx * wy;
      const kx = x < HALF ? x : x - N;
      const ky = y < HALF ? y : y - N;
      KX[i] = kx;
      KY[i] = ky;
      R[i] = Math.hypot(kx, ky);
      const halfPlane = ky > 0 || (ky === 0 && kx > 0);
      if (halfPlane && R[i] >= 1.5 && R[i] <= HALF - 1.5 && Math.abs(kx) < HALF) cand.push(i);
    }
  }

  const bin = (kx, ky) => (((ky % N) + N) % N) * N + (((kx % N) + N) % N);

  // 8 neighbours of every candidate bin, precomputed for the peak search.
  const nbr = new Int32Array(cand.length * 8);
  cand.forEach((i, n) => {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) nbr[n * 8 + k++] = bin(KX[i] + dx, KY[i] + dy);
      }
    }
  });

  // Half-plane bins in an annulus |R - r| <= 1.5, indexed by round(2r).
  const annulus = [];
  for (let r2 = 0; r2 <= N; r2++) {
    const r = r2 / 2;
    const list = [];
    for (let i = 0; i < NN; i++) {
      const halfPlane = KY[i] > 0 || (KY[i] === 0 && KX[i] > 0);
      if (halfPlane && R[i] >= 1.5 && Math.abs(R[i] - r) <= 1.5) list.push(i);
    }
    annulus.push(Int16Array.from(list));
  }
  const tmp = new Float32Array(NN);
  const peakE = new Float32Array(NN);
  const excl = new Uint8Array(NN);

  // Mark the neighbourhoods of the strongest peaks so the background
  // estimate below is not inflated by the pattern's own other peaks.
  function excludePeaks(count) {
    excl.fill(0);
    for (let j = 0; j < count; j++) {
      const i = peaks[j];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          excl[bin(KX[i] + dx, KY[i] + dy)] = 1;
          excl[bin(-KX[i] - dx, -KY[i] - dy)] = 1;
        }
      }
    }
  }

  // How far a peak stands above the typical power at the same radius.
  // Random texture has lumpy spectra too, but its lumps are only a few
  // times the median; a real repetition is orders of magnitude above it.
  function prominence(i, k) {
    const list = annulus[Math.min(N, Math.round(2 * Math.hypot(k.x, k.y)))];
    let n = 0;
    for (let m = 0; m < list.length; m++) {
      const b = list[m];
      if (!excl[b]) tmp[n++] = P[b];
    }
    if (n < 4) return 0;
    const arr = tmp.subarray(0, n).sort();
    const med = arr[n >> 1];
    return P[i] / (med + 1e-12);
  }

  // Does the cell repeat itself two periods further along k? The profile
  // across the stripes must correlate with itself at a lag of 2p. Two
  // parallel lines (a frame and an edge…) correlate at p but never at 2p,
  // so this demands at least three repeats.
  const profS = new Float32Array(2 * N + 2);
  const profC = new Float32Array(2 * N + 2);
  function repeats(img, iw, x0, y0, k) {
    const r = Math.hypot(k.x, k.y);
    const nx = k.x / r;
    const ny = k.y / r;
    const p = N / r;
    profS.fill(0);
    profC.fill(0);
    const c = (N - 1) / 2;
    for (let y = 0; y < N; y++) {
      const row = (y0 + y) * iw + x0;
      const ty = (y - c) * ny + N;
      for (let x = 0; x < N; x++) {
        const b = ((x - c) * nx + ty) | 0;
        profS[b] += img[row + x];
        profC[b]++;
      }
    }
    let span = 0;
    for (let b = 0; b < profS.length; b++) {
      profS[b] = profC[b] >= 3 ? profS[b] / profC[b] : NaN;
      if (profC[b] >= 3) span++;
    }
    // two periods on if that still leaves a useful overlap, else one
    const lag = span - 2 * p >= 8 ? 2 * p : p;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let b = 0; b < profS.length; b++) {
      const a = profS[b];
      const t = b + lag;
      const i0 = t | 0;
      if (i0 + 1 >= profS.length) break;
      const fr = t - i0;
      const v = profS[i0] * (1 - fr) + profS[i0 + 1] * fr;
      if (!(a === a) || !(v === v)) continue; // NaN check
      n++;
      sa += a; sb += v; saa += a * a; sbb += v * v; sab += a * v;
    }
    if (n < 4) return 0;
    const cov = sab - (sa * sb) / n;
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    return va > 1e-9 && vb > 1e-9 ? cov / Math.sqrt(va * vb) : 0;
  }

  // Sub-bin peak position: parabola through log power on each axis.
  function refine(i) {
    const kx = KX[i];
    const ky = KY[i];
    const c = Math.log(P[i] + 1e-20);
    const l = Math.log(P[bin(kx - 1, ky)] + 1e-20);
    const r = Math.log(P[bin(kx + 1, ky)] + 1e-20);
    const u = Math.log(P[bin(kx, ky - 1)] + 1e-20);
    const d = Math.log(P[bin(kx, ky + 1)] + 1e-20);
    const denx = l - 2 * c + r;
    const deny = u - 2 * c + d;
    const dx = denx < 0 ? clamp((0.5 * (l - r)) / denx, -0.5, 0.5) : 0;
    const dy = deny < 0 ? clamp((0.5 * (u - d)) / deny, -0.5, 0.5) : 0;
    return { x: kx + dx, y: ky + dy };
  }

  // Energy in the 3×3 bins around a (fractional) frequency vector. Bins are
  // claimed in `mask` (with their mirror) so nothing is counted twice.
  let rE = 1.5;
  function energyAt(vx, vy) {
    const ix = Math.round(vx);
    const iy = Math.round(vy);
    if (Math.abs(ix) > HALF - 1 || Math.abs(iy) > HALF - 1) return 0;
    let e = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = bin(ix + dx, iy + dy);
        if (mask[b]) continue;
        mask[b] = 1;
        mask[bin(-(ix + dx), -(iy + dy))] = 1;
        if (R[b] >= rE) e += P[b];
      }
    }
    return e;
  }

  // Line orientation in degrees, 0..180, counter-clockwise from screen +x.
  const lineAngle = (k) => (((Math.atan2(-k.x, -k.y) * DEG) % 180) + 180) % 180;

  function analyzeCell(img, iw, x0, y0, band, th) {
    let s = 0;
    let s2 = 0;
    for (let y = 0; y < N; y++) {
      const row = (y0 + y) * iw + x0;
      for (let x = 0; x < N; x++) {
        const v = img[row + x];
        re[y * N + x] = v;
        s += v;
        s2 += v * v;
      }
    }
    const mean = s / NN;
    const std = Math.sqrt(Math.max(0, s2 / NN - mean * mean));
    const out = { type: null, score: 0, contrast: clamp(std * 2.5, 0, 1), std };
    if (std < opt.minContrast) return out;

    for (let i = 0; i < NN; i++) {
      re[i] = (re[i] - mean) * win[i];
      im[i] = 0;
    }
    fft2d(fft, re, im);

    rE = Math.max(1.5, band.rmin - 1);
    let total = 0;
    for (let i = 0; i < NN; i++) {
      const p = re[i] * re[i] + im[i] * im[i];
      P[i] = p;
      if (R[i] >= rE) total += p;
    }
    const half = total / 2;
    if (!(half > 0)) return out;

    // Local maxima of the power spectrum (8-neighbourhood).
    peaks.length = 0;
    for (let n = 0; n < cand.length; n++) {
      const i = cand[n];
      const p = P[i];
      if (p <= 0) continue;
      const o = n * 8;
      if (
        P[nbr[o]] > p || P[nbr[o + 1]] > p || P[nbr[o + 2]] > p || P[nbr[o + 3]] > p ||
        P[nbr[o + 4]] > p || P[nbr[o + 5]] > p || P[nbr[o + 6]] > p || P[nbr[o + 7]] > p
      ) continue;
      peakE[i] = p + P[nbr[o]] + P[nbr[o + 1]] + P[nbr[o + 2]] + P[nbr[o + 3]] +
        P[nbr[o + 4]] + P[nbr[o + 5]] + P[nbr[o + 6]] + P[nbr[o + 7]];
      peaks.push(i);
    }
    if (!peaks.length) return out;
    // Rank by 3×3 energy: a peak between bins spreads out, and its single
    // centre bin would otherwise lose to a harmonic that sits on a bin.
    peaks.sort((a, b) => peakE[b] - peakE[a]);
    if (peaks.length > 10) peaks.length = 10;

    // Thin lines put a lot of energy in harmonics; if the top peak has a
    // clear sub-harmonic (k/3, k/2), that is the real repetition.
    let main = 0;
    let k1 = refine(peaks[0]);
    for (const div of [3, 2]) {
      const tx = k1.x / div;
      const ty = k1.y / div;
      const j = peaks.findIndex((i, n) => n > 0 && Math.hypot(KX[i] - tx, KY[i] - ty) < 1.1 &&
        peakE[i] >= 0.2 * peakE[peaks[0]]);
      if (j > 0) {
        main = j;
        k1 = refine(peaks[j]);
        break;
      }
    }

    // The strongest repetition must fall in this level's band; anything
    // coarser or finer is left to the other level.
    const r1 = Math.hypot(k1.x, k1.y);
    if (r1 < band.rmin || r1 > band.rmax) return out;
    const a1 = lineAngle(k1);
    excludePeaks(Math.min(6, peaks.length));
    const prom1 = prominence(peaks[main], k1);
    out.prom = prom1;
    if (prom1 * opt.sensitivity < opt.minProminence) return out;

    // Second, non-parallel direction (for grids and dot lattices).
    let k2 = null;
    let prom2 = 0;
    for (let j = 0; j < Math.min(peaks.length, 8); j++) {
      if (j === main) continue;
      const k = refine(peaks[j]);
      if (angleDiff(lineAngle(k), a1) < 20) continue;
      if (Math.hypot(k.x - k1.x, k.y - k1.y) < 2) continue;
      k2 = k;
      prom2 = prominence(peaks[j], k);
      out.prom2 = prom2;
      break;
    }

    mask.fill(0);
    const e1 = energyAt(k1.x, k1.y);
    const e2 = k2 ? energyAt(k2.x, k2.y) : 0;
    const sharpKnown = Math.max(Math.abs(2 * k1.x), Math.abs(2 * k1.y)) <= HALF - 2;
    const h1 = energyAt(2 * k1.x, 2 * k1.y) + energyAt(3 * k1.x, 3 * k1.y);
    out.sharp = sharpKnown && e1 > 0 ? clamp(Math.sqrt(h1 / e1) / 0.6, 0, 1) : NaN;

    const sens = opt.sensitivity;
    // Fails the three-repeats test: kept as a "weak" stripe, which may only
    // take part in concentric/radial fits (rays fan out, so their spacing
    // drifts within a cell), never form a STRIPE region on its own.
    const rep1 = repeats(img, iw, x0, y0, k1);
    out.rep1 = rep1;
    out.weak = rep1 < opt.minRepeat;
    const rep2 = k2 && !out.weak ? repeats(img, iw, x0, y0, k2) : 0;
    out.rep2 = rep2;

    if (k2 && !out.weak && e2 >= opt.latticeSecond * e1 && prom2 * opt.sensitivity >= opt.minProminence &&
        rep2 >= opt.minRepeat) {
      const h2 = energyAt(2 * k2.x, 2 * k2.y);
      const cp = energyAt(k1.x + k2.x, k1.y + k2.y);
      const cm = energyAt(k1.x - k2.x, k1.y - k2.y);
      const score2 = (e1 + e2 + h1 + h2 + cp + cm) / half;
      if (score2 * sens >= opt.latticeScore) {
        const r2 = Math.hypot(k2.x, k2.y);
        const a2 = lineAngle(k2);
        let p1 = N / r1;
        let p2 = N / r2;
        let aa = a1;
        let ab = a2;
        if (p2 > p1) {
          [p1, p2] = [p2, p1];
          [aa, ab] = [ab, aa];
        }
        out.cross = Math.max(cp, cm) / Math.max(1e-12, Math.min(e1, e2));
        out.type = out.cross >= opt.dotsCross ? TYPE.DOTS : TYPE.GRID;
        out.score = Math.min(1, score2);
        out.p1 = p1;
        out.a1 = aa;
        out.p2 = p2;
        out.a2 = ab;
        return out;
      }
    }

    const score1 = (e1 + h1) / half;
    if (score1 * sens >= opt.stripeScore) {
      out.type = TYPE.STRIPE;
      out.score = Math.min(1, score1);
      out.p1 = N / r1;
      out.a1 = a1;
    }
    return out;
  }

  // ---------------------------------------------------------------------

  let gray0 = new Float32Array(0);
  let gray1 = new Float32Array(0);

  function analyze(rgba, W, H) {
    const t0 = now();
    if (gray0.length !== W * H) gray0 = new Float32Array(W * H);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      gray0[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    }
    const W1 = W >> 1;
    const H1 = H >> 1;
    if (gray1.length !== W1 * H1) gray1 = new Float32Array(W1 * H1);
    for (let y = 0; y < H1; y++) {
      const a = 2 * y * W;
      const b = a + W;
      for (let x = 0; x < W1; x++) {
        const xx = 2 * x;
        gray1[y * W1 + x] = 0.25 * (gray0[a + xx] + gray0[a + xx + 1] + gray0[b + xx] + gray0[b + xx + 1]);
      }
    }

    const levels = [];
    const regions = [];
    for (let L = 0; L < opt.levels.length && L < 2; L++) {
      const img = L ? gray1 : gray0;
      const iw = L ? W1 : W;
      const ih = L ? H1 : H;
      const cols = Math.floor(iw / N);
      const rows = Math.floor(ih / N);
      const ox = (iw - cols * N) >> 1;
      const oy = (ih - rows * N) >> 1;
      const sc = 1 << L;
      const cells = new Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = analyzeCell(img, iw, ox + c * N, oy + r * N, opt.levels[L], opt);
          cell.level = L;
          cell.col = c;
          cell.row = r;
          cell.size = N * sc;
          cell.x = (ox + c * N) * sc;
          cell.y = (oy + r * N) * sc;
          cell.cx = cell.x + cell.size / 2;
          cell.cy = cell.y + cell.size / 2;
          if (cell.p1) cell.p1 *= sc;
          if (cell.p2) cell.p2 *= sc;
          cells[r * cols + c] = cell;
        }
      }
      const lv = { level: L, cols, rows, size: N * sc, cells };
      levels.push(lv);
      regions.push(...buildRegions(lv));
    }

    const kept = dedupe(absorbRims(regions));
    for (const reg of kept) Object.assign(reg, regionColor(rgba, W, H, reg));
    return { W, H, levels, regions: kept, ms: now() - t0 };
  }

  // ---------------------------------------------------------------------
  // Region building

  function components(lv, include, compat, eight) {
    const { cols, rows, cells } = lv;
    const seen = new Uint8Array(cols * rows);
    const groups = [];
    const nb4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const nb8 = [...nb4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const nbs = eight ? nb8 : nb4;
    for (let i = 0; i < cells.length; i++) {
      if (seen[i] || !include(i)) continue;
      const group = [i];
      seen[i] = 1;
      for (let q = 0; q < group.length; q++) {
        const cur = group[q];
        const cx = cur % cols;
        const cy = (cur / cols) | 0;
        for (const [dx, dy] of nbs) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const j = y * cols + x;
          if (seen[j] || !include(j) || !compat(cells[cur], cells[j])) continue;
          seen[j] = 1;
          group.push(j);
        }
      }
      groups.push(group);
    }
    return groups;
  }

  const isLattice = (c) => c.type === TYPE.GRID || c.type === TYPE.DOTS;

  function strictCompat(a, b) {
    if (a.type === TYPE.STRIPE && b.type === TYPE.STRIPE) {
      return ratio(a.p1, b.p1) < 1.3 && angleDiff(a.a1, b.a1) < 22;
    }
    if (isLattice(a) && isLattice(b)) {
      const same = (p, q, s, t) =>
        ratio(p, q) < 1.3 && angleDiff(s, t) < 20;
      return (
        (same(a.p1, b.p1, a.a1, b.a1) && same(a.p2, b.p2, a.a2, b.a2)) ||
        (same(a.p1, b.p2, a.a1, b.a2) && same(a.p2, b.p1, a.a2, b.a1))
      );
    }
    return false;
  }

  const looseCompat = (a, b) => ratio(a.p1, b.p1) < 1.6 && angleDiff(a.a1, b.a1) < 50;

  // Least-squares point closest to the lines through each cell centre.
  // normal=true: lines along the stripe normal (concentric rings);
  // normal=false: lines along the stripes themselves (radial rays).
  function fitCenter(cs, normal) {
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, sw = 0;
    const proj = cs.map((c) => {
      const t = c.a1 / DEG;
      const vx = normal ? Math.sin(t) : Math.cos(t);
      const vy = normal ? Math.cos(t) : -Math.sin(t);
      const p11 = 1 - vx * vx;
      const p12 = -vx * vy;
      const p22 = 1 - vy * vy;
      const w = c.score;
      a11 += w * p11;
      a12 += w * p12;
      a22 += w * p22;
      b1 += w * (p11 * c.cx + p12 * c.cy);
      b2 += w * (p12 * c.cx + p22 * c.cy);
      sw += w;
      return [p11, p12, p22, w];
    });
    const tr = a11 + a22;
    const disc = Math.sqrt(((a11 - a22) * (a11 - a22)) / 4 + a12 * a12);
    const lmax = tr / 2 + disc;
    const lmin = tr / 2 - disc;
    const det = a11 * a22 - a12 * a12;
    if (!(lmax > 0) || lmin / lmax < 0.12 || Math.abs(det) < 1e-9) return null;
    const x = (a22 * b1 - a12 * b2) / det;
    const y = (a11 * b2 - a12 * b1) / det;
    let res = 0;
    cs.forEach((c, i) => {
      const [p11, p12, p22, w] = proj[i];
      const dx = x - c.cx;
      const dy = y - c.cy;
      const q1 = p11 * dx + p12 * dy;
      const q2 = p12 * dx + p22 * dy;
      res += w * (q1 * q1 + q2 * q2);
    });
    return { x, y, rms: Math.sqrt(res / sw) };
  }

  function summarize(cs, type, lv) {
    let sw = 0, lp = 0, lp2 = 0, ca = 0, sa = 0, ang2 = 0, contrast = 0, score = 0;
    let sharp = 0, sharpW = 0, dotsW = 0, gridW = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cs) {
      const w = Math.max(c.score, 1e-3);
      sw += w;
      lp += w * Math.log(c.p1);
      ca += w * Math.cos((2 * c.a1) / DEG);
      sa += w * Math.sin((2 * c.a1) / DEG);
      if (c.p2) {
        lp2 += w * Math.log(c.p2);
        ang2 += w * angleDiff(c.a1, c.a2);
        if (c.type === TYPE.DOTS) dotsW += w;
        else gridW += w;
      }
      contrast += w * c.contrast;
      score += c.score;
      if (Number.isFinite(c.sharp)) {
        sharp += w * c.sharp;
        sharpW += w;
      }
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.size);
      y1 = Math.max(y1, c.y + c.size);
    }
    if (type === 'lattice') type = dotsW > gridW ? TYPE.DOTS : TYPE.GRID;
    const reg = {
      type,
      family: familyOf(type),
      level: lv.level,
      cells: cs.length,
      cellSize: lv.size,
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      period: Math.exp(lp / sw),
      angle: ((((Math.atan2(sa, ca) * DEG) / 2) % 180) + 180) % 180,
      coherence: Math.hypot(ca, sa) / sw,
      score: score / cs.length,
      contrast: contrast / sw,
      sharp: sharpW ? sharp / sharpW : 0.5,
      cellRefs: cs.map((c) => [c.col, c.row]),
    };
    if (reg.family === 'lattice') {
      reg.dirs = cs.flatMap((c) => [[c.p1, c.a1], [c.p2, c.a2]]);
      reg.period2 = Math.exp(lp2 / sw);
      reg.ratio = reg.period / reg.period2;
      reg.latticeAngle = ang2 / sw;
    }
    return reg;
  }

  function buildRegions(lv) {
    const { cols, cells } = lv;
    const used = new Uint8Array(cells.length);
    const out = [];

    if (opt.rings) {
      const groups = components(lv, (i) => cells[i].type === TYPE.STRIPE, looseCompat, true);
      for (const g of groups) {
        if (g.length < 5) continue;
        const cs = g.map((i) => cells[i]);
        const bins = new Set(cs.map((c) => Math.floor(c.a1 / 20) % 9));
        if (bins.size < 3) continue;
        let ca = 0, sa = 0, sw = 0, mx = 0, my = 0;
        for (const c of cs) {
          ca += c.score * Math.cos((2 * c.a1) / DEG);
          sa += c.score * Math.sin((2 * c.a1) / DEG);
          sw += c.score;
          mx += c.cx / cs.length;
          my += c.cy / cs.length;
        }
        if (Math.hypot(ca, sa) / sw > 0.85) continue; // orientations too uniform
        if (cs.filter((c) => !c.weak).length < 2 && cs.length < 7) continue;
        const fc = fitCenter(cs, true);
        const fr = fitCenter(cs, false);
        let best = null;
        let type = null;
        if (fc && (!fr || fc.rms <= fr.rms)) {
          best = fc;
          type = TYPE.CONCENTRIC;
        } else if (fr) {
          best = fr;
          type = TYPE.RADIAL;
        }
        if (!best || best.rms > 0.28 * lv.size) continue;
        let spread = 0;
        for (const c of cs) spread = Math.max(spread, Math.hypot(c.cx - mx, c.cy - my));
        if (Math.hypot(best.x - mx, best.y - my) > 2.5 * spread + lv.size) continue;
        if (type === TYPE.CONCENTRIC) {
          const ps = cs.map((c) => c.p1);
          if (Math.max(...ps) / Math.min(...ps) > 1.7) continue;
        }
        const reg = summarize(cs, type, lv);
        reg.center = { x: best.x, y: best.y };
        reg.fit = best.rms / lv.size;
        out.push(reg);
        for (const i of g) used[i] = 1;
      }
    }

    const groups = components(lv, (i) => !used[i] && !!cells[i].type && !cells[i].weak, strictCompat, false);
    let parts = groups.map((g) => ({ g, cs: g.map((i) => cells[i]), lattice: isLattice(cells[g[0]]) }));

    // Seams between two stripe fields are not lattices.
    parts = parts.filter((p) => !(p.lattice && p.cs.length <= 3 && isSeam(lv, p.g)));
    // A stray line through a pattern splits it; bridge gaps under a cell.
    bridgeGaps(parts, lv);

    for (const p of parts) {
      const cs = p.cs;
      const lattice = p.lattice;
      const meanScore = cs.reduce((s, c) => s + c.score, 0) / cs.length;
      // A lone (large, level-1) cell may stand on its own only when it is
      // very clean: high score and peaks far above the background.
      const strong = (c) => c.prom * opt.sensitivity >= 3 * opt.minProminence &&
        (!lattice || c.prom2 * opt.sensitivity >= 3 * opt.minProminence);
      // Lone lattice cells are usually two patterns sharing a cell: skip.
      const enough =
        cs.length >= opt.minCells ||
        (lv.level >= 1 && !lattice && meanScore * opt.sensitivity >= opt.singleCellScore && strong(cs[0]));
      if (!enough) continue;
      out.push(summarize(cs, lattice ? 'lattice' : TYPE.STRIPE, lv));
    }
    return out;
  }

  function partBox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of p.cs) {
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.size);
      y1 = Math.max(y1, c.y + c.size);
    }
    return { x0, y0, x1, y1 };
  }
  function near(a, b, gap) {
    const A = partBox(a);
    const B = partBox(b);
    return A.x0 - gap < B.x1 && B.x0 - gap < A.x1 && A.y0 - gap < B.y1 && B.y0 - gap < A.y1;
  }
  function partMean(p) {
    let w = 0, lp = 0, lp2 = 0, ca = 0, sa = 0;
    for (const c of p.cs) {
      const k = Math.max(c.score, 1e-3);
      w += k;
      lp += k * Math.log(c.p1);
      if (c.p2) lp2 += k * Math.log(c.p2);
      ca += k * Math.cos((2 * c.a1) / DEG);
      sa += k * Math.sin((2 * c.a1) / DEG);
    }
    return {
      p1: Math.exp(lp / w),
      p2: p.lattice ? Math.exp(lp2 / w) : 0,
      a1: ((((Math.atan2(sa, ca) * DEG) / 2) % 180) + 180) % 180,
    };
  }

  function bridgeGaps(parts, lv) {
    const gap = 1.0 * lv.size;
    for (let merged = true; merged; ) {
      merged = false;
      outer: for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const A = parts[i];
          const B = parts[j];
          if (A.lattice !== B.lattice || !near(A, B, gap)) continue;
          const a = partMean(A);
          const b = partMean(B);
          const ok = A.lattice
            ? ratio(a.p1, b.p1) < 1.25 && ratio(a.p2, b.p2) < 1.25
            : ratio(a.p1, b.p1) < 1.25 && angleDiff(a.a1, b.a1) < 15;
          if (!ok) continue;
          A.cs.push(...B.cs);
          A.g.push(...B.g);
          parts.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  // A small "lattice" sandwiched between two stripe fields whose directions
  // match its own two directions is just the seam between them.
  function isSeam(lv, group) {
    const { cols, rows, cells } = lv;
    let matchA = false;
    let matchB = false;
    for (const i of group) {
      const x = i % cols;
      const y = (i / cols) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const c = cells[yy * cols + xx];
        if (c.type !== TYPE.STRIPE || c.weak) continue;
        for (const ref of group) {
          const g = cells[ref];
          if (ratio(c.p1, g.p1) < 1.2 && angleDiff(c.a1, g.a1) < 12) matchA = true;
          if (ratio(c.p1, g.p2) < 1.2 && angleDiff(c.a1, g.a2) < 12) matchB = true;
        }
      }
    }
    return matchA && matchB;
  }

  // Cells on the rim of a lattice — or where one of its two spacings falls
  // outside a level's band — show only one direction and look like stripes.
  // A stripe region that touches a lattice region (at either level) and
  // matches one of its directions is part of that lattice.
  function absorbRims(regions) {
    const lattices = regions.filter((r) => r.family === 'lattice');
    if (!lattices.length) return regions;
    const drop = new Set();
    regions.forEach((S, i) => {
      if (S.type !== TYPE.STRIPE) return;
      const host = lattices.find((L) => {
        const gap = 0.75 * Math.max(S.cellSize, L.cellSize);
        const touching = S.x - gap < L.x + L.w && L.x - gap < S.x + S.w &&
          S.y - gap < L.y + L.h && L.y - gap < S.y + S.h;
        return touching && S.w * S.h <= 1.5 * L.w * L.h &&
          L.dirs.some(([p, a]) => ratio(S.period, p) < 1.2 && angleDiff(S.angle, a) < 12);
      });
      if (!host) return;
      const x1 = Math.max(host.x + host.w, S.x + S.w);
      const y1 = Math.max(host.y + host.h, S.y + S.h);
      host.x = Math.min(host.x, S.x);
      host.y = Math.min(host.y, S.y);
      host.w = x1 - host.x;
      host.h = y1 - host.y;
      host.cx = host.x + host.w / 2;
      host.cy = host.y + host.h / 2;
      drop.add(i);
    });
    return regions.filter((_, i) => !drop.has(i));
  }

  // The same pattern can show up at both levels near the hand-over period.
  function dedupe(regions) {
    const weight = (r) => r.score * Math.sqrt(r.w * r.h);
    const drop = new Set();
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        if (a.level === b.level || a.family !== b.family) continue;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const overlap = (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
        if (overlap > 0.5 && ratio(a.period, b.period) < 1.4) {
          drop.add(weight(a) >= weight(b) ? j : i);
        }
      }
    }
    return regions.filter((_, i) => !drop.has(i));
  }

  function setOptions(o) {
    Object.assign(opt, o);
  }

  return { analyze, setOptions, options: opt };
}

// Colour of the pattern inside a region: split pixels at the mean
// luminance and take whichever half is more saturated (coloured ink on
// paper, or black ink on coloured paper).
export function regionColor(rgba, W, H, box) {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(W, Math.ceil(box.x + box.w));
  const y1 = Math.min(H, Math.ceil(box.y + box.h));
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 1200)));
  let n = 0;
  let lsum = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const j = (y * W + x) * 4;
      lsum += 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      n++;
    }
  }
  if (!n) return { hue: 0, sat: 0, light: 0.5 };
  const lm = lsum / n;
  const acc = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const j = (y * W + x) * 4;
      const l = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      const a = acc[l < lm ? 0 : 1];
      a[0] += rgba[j];
      a[1] += rgba[j + 1];
      a[2] += rgba[j + 2];
      a[3]++;
    }
  }
  let best = { hue: 0, sat: 0, light: lm / 255 };
  for (const a of acc) {
    if (!a[3]) continue;
    const hsv = rgbToHueSat(a[0] / a[3], a[1] / a[3], a[2] / a[3]);
    if (hsv.sat > best.sat) best = hsv;
  }
  return best;
}

function rgbToHueSat(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const c = mx - mn;
  let h = 0;
  if (c > 1e-6) {
    if (mx === r) h = ((g - b) / c) % 6;
    else if (mx === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { hue: h, sat: c, light: (mx + mn) / 2 };
}
