// Ostinascope — repetition detector.
//
// The frame is cut into 32×32 cells that overlap by half, at four scales
// (1×, 2×, 2.8×, 4× downsampled: each coarser level sees larger structures
// and also fits more periods of a mid-sized pattern into one cell). Each
// cell is windowed and Fourier transformed. A cell repeats when its
// strongest spectral peak
//   · stands far above the other frequencies at the same radius (prominence),
//   · is a sharp spot rather than a lump (isolation),
//   · and the image profile across it matches itself two periods on
//     (at least three repeats — two parallel lines are not a pattern).
// A second, non-parallel peak makes it a lattice (GRID / DOTS). Agreeing
// neighbours are merged into regions; clusters of stripe cells whose
// orientation fans out around a common point become CONCENTRIC or RADIAL.
//
// Pure module: no DOM access, so it runs in a worker and in Node for tests.

import { makePowerSpectrum } from './fft.js';
import { createRowFinder } from './rows.js';
import { regionColor } from './color.js';
import { angleDiff, clamp, ratio, TO_DEG as DEG } from './util.js';

export { angleDiff }; // part of the detector's API (tests, tracker)

export const CELL = 32;
const N = CELL;
const NN = N * N;
const HALF = N / 2;

export const TYPE = Object.freeze({
  STRIPE: 'STRIPE',
  GRID: 'GRID',
  DOTS: 'DOTS',
  CONCENTRIC: 'CONCENTRIC',
  RADIAL: 'RADIAL',
  ROW: 'ROW', // similar things in a line (rows.js)
});

export function familyOf(type) {
  if (type === TYPE.STRIPE) return 'line';
  if (type === TYPE.GRID || type === TYPE.DOTS) return 'lattice';
  if (type === TYPE.ROW) return 'row';
  return 'radial';
}

export const DETECTOR_DEFAULTS = Object.freeze({
  sensitivity: 1.8, // >1 = more permissive (also loosens the ROW thresholds)
  minContrast: 0.02, // grey std below this = blank cell
  minProminence: 20, // peak power / median power at the same radius
  minIsolation: 0.85, // share of the 5×5 bins around the peak that sits in its 3×3
  // A peak far above its background may be less sharp (wavy wire, a sheet
  // in perspective): from strongProminence on, minIsolationStrong applies.
  strongProminence: 100,
  minIsolationStrong: 0.7,
  minRepeat: 0.35, // profile self-correlation two periods on (≥ 3 repeats)
  repTolerance: 0.15, // the lag may stretch this much (perspective)
  stripeScore: 0.2, // share of energy at/above the pattern's frequency in one direction
  latticeScore: 0.3, // same, for the two lattice directions
  latticeSecond: 0.2, // 2nd direction must hold this fraction of the 1st
  dotsCross: 0.15, // cross terms (k1±k2) vs fundamentals: dots vs grid lines
  stride: 16, // cells overlap by half
  // Per level: downsampling, accepted peak radius (cycles per cell), and
  // how many cells a region needs. Together they cover periods from ~2.7
  // to ~55 px of a 192 px short side (1.4%–29% of the screen width).
  levels: [
    { scale: 1, rmin: 2.8, rmax: 12, minCells: 3 },
    { scale: 2, rmin: 2.5, rmax: 6.4, minCells: 2 },
    { scale: 2 * Math.SQRT2, rmin: 2.5, rmax: 4.8, minCells: 2 },
    { scale: 4, rmin: 2.3, rmax: 4.8, minCells: 1 },
  ],
  // a region smaller than its level's minCells must be this clear
  smallProminence: 1000,
  smallIsolation: 0.85,
  smallRepeat: 0.7,
  softCells: 3, // extra cells a region needs when most pass only by the sensitivity
  grow: true, // regions take in agreeing near-miss neighbours (extent only)
  rings: true,
  ringCells: 7,
  // rings/rays: how far (≈ sin of the angle) a cell's line may miss the
  // centre before it is dropped from the fit, and the mean miss allowed
  ringOutlier: 0.35,
  ringAim: 0.07,
  ringEllipse: 0.5, // rings may look this flat (semi-axis ratio) in perspective
  ringKeep: 0.6, // share of the group that must remain after dropping misses
  ringSpacing: 0.7, // share of ring cells whose spacing matches the median
  rows: true, // look for rows of similar things too
  // the row search follows the sensitivity only up to here: beyond it,
  // noise textures start to form rows (rowSensitivity overrides)
  rowSensitivityMax: 1.3,
  // run the row search's passes in turns over this many frames (the others
  // reuse their previous result): 1 = all every frame (tests, benchmarks)
  rowSplit: 1,
});

const now = () => (globalThis.performance ? performance.now() : Date.now());

export function createDetector(options = {}) {
  const opt = { ...DETECTOR_DEFAULTS, ...options };
  const power = makePowerSpectrum(N);
  const rowFinder = createRowFinder(options.rowOptions || {});
  const work = new Float64Array(NN);
  const P = new Float64Array(NN);
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

  // N is a power of two, so wrapping a (possibly negative) index is a mask
  const MASK = N - 1;
  const bin = (kx, ky) => (ky & MASK) * N + (kx & MASK);

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
  // so this demands at least three repeats. The profile is weighted like
  // the FFT window (the centre of the cell counts most) and sampled at
  // half-pixel resolution so fine stripes (p ≈ 3) are not smeared; the lag
  // may stretch a little, since perspective makes the period drift.
  const PB = 2;
  const profS = new Float32Array(PB * (2 * N + 2));
  const profC = new Float32Array(PB * (2 * N + 2));
  function repeats(img, iw, x0, y0, k) {
    const r = Math.hypot(k.x, k.y);
    const nx = (PB * k.x) / r;
    const ny = (PB * k.y) / r;
    const p = (PB * N) / r; // period, in profile bins
    profS.fill(0);
    profC.fill(0);
    const c = (N - 1) / 2;
    const base = PB * N;
    for (let y = 0; y < N; y++) {
      const row = (y0 + y) * iw + x0;
      const ty = (y - c) * ny + base;
      for (let x = 0; x < N; x++) {
        const b = ((x - c) * nx + ty) | 0;
        const w = 0.15 + win[y * N + x];
        profS[b] += w * img[row + x];
        profC[b] += w;
      }
    }
    const minC = 0.5;
    let first = -1;
    let last = -1;
    for (let b = 0; b < profS.length; b++) {
      if (profC[b] >= minC) {
        profS[b] /= profC[b];
        if (first < 0) first = b;
        last = b;
      } else profS[b] = NaN;
    }
    // at half-pixel resolution an axis-aligned profile has empty bins
    // between rows: fill them from their neighbours
    for (let b = first + 1; b < last; b++) {
      if (profS[b] === profS[b]) continue;
      let e = b + 1;
      while (e < last && !(profS[e] === profS[e])) e++;
      const a = profS[b - 1];
      const z = profS[e];
      for (let k = b; k < e; k++) profS[k] = a + ((z - a) * (k - b + 1)) / (e - b + 1);
      b = e;
    }
    const span = first < 0 ? 0 : last - first + 1;
    // two periods on if that still leaves a useful overlap, else one
    const lag = span - 2 * p >= 8 * PB ? 2 * p : p;
    const tol = opt.repTolerance;
    if (!(tol > 0)) return corrAt(lag);
    let best = -1;
    for (let f = 1 - tol; f <= 1 + tol + 1e-9; f += tol / 2) best = Math.max(best, corrAt(lag * f));
    return best;
  }
  function corrAt(lag) {
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
    if (!(va > 1e-9 && vb > 1e-9)) return 0;
    // one side (nearly) blank paper: its "correlation" is just noise
    if (Math.min(va, vb) < 0.03 * Math.max(va, vb)) return 0;
    return cov / Math.sqrt(va * vb);
  }

  // 3×3 vs 5×5 energy around a peak: a repetition is a sharp spot, a
  // texture's lumps are wider.
  function isolation(i) {
    let e3 = 0;
    let e5 = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const p = P[bin(KX[i] + dx, KY[i] + dy)];
        e5 += p;
        if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) e3 += p;
      }
    }
    return e5 > 0 ? e3 / e5 : 0;
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

  function analyzeCell(img, iw, x0, y0, band) {
    let s = 0;
    let s2 = 0;
    for (let y = 0; y < N; y++) {
      const row = (y0 + y) * iw + x0;
      for (let x = 0; x < N; x++) {
        const v = img[row + x];
        work[y * N + x] = v;
        s += v;
        s2 += v * v;
      }
    }
    const mean = s / NN;
    const std = Math.sqrt(Math.max(0, s2 / NN - mean * mean));
    const out = { type: null, score: 0, contrast: clamp(std * 2.5, 0, 1), std, fail: null };
    // first gate the cell fails, kept for the debug view
    const fail = (why) => {
      out.fail = why;
      return true;
    };
    if (std < opt.minContrast && fail('blank')) return out;

    for (let i = 0; i < NN; i++) work[i] = (work[i] - mean) * win[i];
    power(work, P);

    rE = Math.max(1.5, band.rmin - 1);

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
    if (!peaks.length && fail('band')) return out;
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
    // coarser or finer is left to the other levels.
    const r1 = Math.hypot(k1.x, k1.y);
    out.r1 = r1;
    if ((r1 < band.rmin || r1 > band.rmax) && fail('band')) return out;
    const a1 = lineAngle(k1);

    // Energy the shares are measured against. Natural images carry most of
    // their energy at low frequencies (shading, large edges), so everything
    // well below the pattern's own frequency is left out.
    const rHi = Math.max(rE, 0.6 * r1);
    let total = 0;
    for (let i = 0; i < NN; i++) if (R[i] >= rHi) total += P[i];
    const half = total / 2;
    if (!(half > 0) && fail('band')) return out;

    excludePeaks(Math.min(6, peaks.length));
    const prom1 = prominence(peaks[main], k1);
    out.prom = prom1;
    const sens = opt.sensitivity;
    if (prom1 * sens < opt.minProminence && fail('prom')) return out;

    // Second, non-parallel direction (for grids and dot lattices).
    let k2 = null;
    let peak2 = -1;
    let prom2 = 0;
    for (let j = 0; j < Math.min(peaks.length, 8); j++) {
      if (j === main) continue;
      const k = refine(peaks[j]);
      if (angleDiff(lineAngle(k), a1) < 20) continue;
      if (Math.hypot(k.x - k1.x, k.y - k1.y) < 2) continue;
      k2 = k;
      peak2 = peaks[j];
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

    // Fails the three-repeats or the isolation test: kept as a "weak"
    // stripe, which may take part in concentric/radial fits (rays fan out,
    // rings curve, so their peaks smear) and widen a region, but never
    // start a region on its own.
    const rep1 = repeats(img, iw, x0, y0, k1);
    out.rep1 = rep1;
    const iso1 = isolation(peaks[main]);
    out.iso1 = iso1;
    // Above 1 the sensitivity also accepts smeared peaks and looser repeats:
    // natural repetitions (tree rings, florets, scales, ripples) are only
    // roughly regular. Measured on photos: isolation is what holds them back.
    const loose = (sv) => Math.max(0, sv - 1);
    const isoNeed = (pr, sv = sens) => (pr * sv >= opt.strongProminence
      ? opt.minIsolationStrong - 0.2 * loose(sv) : opt.minIsolation - 0.25 * loose(sv));
    const repNeed = opt.minRepeat - 0.1 * loose(sens);
    out.weak = rep1 < repNeed || iso1 < isoNeed(prom1);
    // passes only thanks to the loosening: such cells need company (below)
    out.soft = !out.weak && (rep1 < opt.minRepeat || iso1 < isoNeed(prom1, 1));
    const rep2 = k2 ? repeats(img, iw, x0, y0, k2) : 0;
    out.rep2 = rep2;
    const iso2 = k2 ? isolation(peak2) : 0;
    out.iso2 = iso2;
    const score1 = (e1 + h1) / half;
    out.score1 = score1;

    // a second direction is where seams and noise fake a grid: above 1 the
    // sensitivity only partly applies to it
    const sens2 = Math.min(sens, 1.1);
    const firm = prom1 * sens2 >= opt.minProminence && rep1 >= opt.minRepeat &&
      iso1 >= (prom1 * sens2 >= opt.strongProminence ? opt.minIsolationStrong : opt.minIsolation);
    if (k2 && !out.weak && firm && e2 >= opt.latticeSecond * e1 && prom2 * sens2 >= opt.minProminence &&
        rep2 >= opt.minRepeat) {
      const h2 = energyAt(2 * k2.x, 2 * k2.y);
      const cp = energyAt(k1.x + k2.x, k1.y + k2.y);
      const cm = energyAt(k1.x - k2.x, k1.y - k2.y);
      const score2 = (e1 + e2 + h1 + h2 + cp + cm) / half;
      if (score2 * sens2 >= opt.latticeScore) {
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

    if (score1 * sens < opt.stripeScore && fail('score')) return out;
    // a weak stripe keeps its type for ring/ray fits and region growth
    if (out.weak) out.fail = rep1 < repNeed ? 'repeat' : 'iso';
    out.type = TYPE.STRIPE;
    out.score = Math.min(1, score1);
    out.p1 = N / r1;
    out.a1 = a1;
    return out;
  }

  // ---------------------------------------------------------------------

  // Grey pyramid. Each level is made from the closest finer one: a 2×2 box
  // for an exact halving, an area-weighted resample otherwise.
  const pyramid = [];
  const dims = [];
  let rowBuf = new Float32Array(0);
  function boxHalf(src, sw, dst, w, h) {
    for (let y = 0; y < h; y++) {
      const a = 2 * y * sw;
      const b = a + sw;
      for (let x = 0; x < w; x++) {
        const xx = 2 * x;
        dst[y * w + x] = 0.25 * (src[a + xx] + src[a + xx + 1] + src[b + xx] + src[b + xx + 1]);
      }
    }
  }
  // 1-D area resample of n samples (stride st) by factor f > 1 into m outputs.
  function area1d(src, s0, st, n, dst, d0, dst_st, m, f) {
    for (let i = 0; i < m; i++) {
      const a = i * f;
      const b = Math.min(n, a + f);
      let acc = 0;
      let j = Math.floor(a);
      for (; j < b; j++) {
        const lo = Math.max(a, j);
        const hi = Math.min(b, j + 1);
        acc += (hi - lo) * src[s0 + j * st];
      }
      dst[d0 + i * dst_st] = acc / (b - a);
    }
  }
  function resample(src, sw, sh, dst, w, h, f) {
    if (rowBuf.length < w * sh) rowBuf = new Float32Array(w * sh);
    for (let y = 0; y < sh; y++) area1d(src, y * sw, 1, sw, rowBuf, y * w, 1, w, f);
    for (let x = 0; x < w; x++) area1d(rowBuf, x, w, sh, dst, x, w, h, f);
  }
  function grayLevels(rgba, W, H) {
    if (!pyramid[0] || pyramid[0].length !== W * H) pyramid[0] = new Float32Array(W * H);
    const g0 = pyramid[0];
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      g0[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    }
    dims[0] = [W, H];
    const scales = opt.levels.map((l, i) => l.scale || 2 ** i);
    for (let L = 1; L < scales.length; L++) {
      // halve an earlier level when one is exactly 2× finer, else resample
      // from the full-resolution image
      let from = 0;
      for (let k = 0; k < L; k++) if (Math.abs(scales[L] / scales[k] - 2) < 1e-6) from = k;
      const f = scales[L] / scales[from];
      const [sw, sh] = dims[from];
      const w = Math.floor(W / scales[L]);
      const h = Math.floor(H / scales[L]);
      if (!pyramid[L] || pyramid[L].length !== w * h) pyramid[L] = new Float32Array(w * h);
      if (Math.abs(f - 2) < 1e-6 && w <= sw >> 1 && h <= sh >> 1) boxHalf(pyramid[from], sw, pyramid[L], w, h);
      else resample(pyramid[from], sw, sh, pyramid[L], w, h, f);
      dims[L] = [w, h];
    }
    return dims;
  }

  function analyze(rgba, W, H) {
    const t0 = now();
    const dims = grayLevels(rgba, W, H);
    const S = Math.min(N, Math.max(4, opt.stride | 0));
    const levels = [];
    const regions = [];
    for (let L = 0; L < opt.levels.length; L++) {
      const img = pyramid[L];
      const [iw, ih] = dims[L];
      const cols = Math.floor((iw - N) / S) + 1;
      const rows = Math.floor((ih - N) / S) + 1;
      if (cols < 1 || rows < 1) break;
      const ox = (iw - ((cols - 1) * S + N)) >> 1;
      const oy = (ih - ((rows - 1) * S + N)) >> 1;
      const sc = opt.levels[L].scale || 2 ** L;
      const cells = new Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = analyzeCell(img, iw, ox + c * S, oy + r * S, opt.levels[L]);
          cell.level = L;
          cell.col = c;
          cell.row = r;
          cell.size = N * sc;
          cell.core = (S < N ? 0.75 * N : N) * sc;
          cell.x = (ox + c * S) * sc;
          cell.y = (oy + r * S) * sc;
          cell.cx = cell.x + cell.size / 2;
          cell.cy = cell.y + cell.size / 2;
          if (cell.p1) cell.p1 *= sc;
          if (cell.p2) cell.p2 *= sc;
          cells[r * cols + c] = cell;
        }
      }
      const lv = { level: L, scale: sc, cols, rows, size: N * sc, step: S * sc, cells };
      levels.push(lv);
      regions.push(...buildRegions(lv));
    }

    let kept = dedupe(absorbRings(absorbRims(regions)));
    if (opt.rows) kept = kept.concat(findRows(kept, dims));
    for (const reg of kept) Object.assign(reg, regionColor(rgba, W, H, reg));
    return { W, H, levels, regions: kept, ms: now() - t0 };
  }

  // Rows of similar things, unless the same repetition is already a
  // stripe/lattice region (then the spectral one is the better reading).
  let rowFrame = 0;
  let rowCache = [];
  let rowDims = '';
  function findRows(periodic, dims) {
    const passes = rowFinder.options.passes;
    const split = Math.max(1, opt.rowSplit | 0);
    const key = dims.map((d) => d.join('x')).join(',');
    if (key !== rowDims) {
      rowCache = [];
      rowDims = key;
    }
    const inside = periodic.filter((q) => q.family !== 'radial');
    const skip = (x, y) => inside.some((q) => x > q.x && x < q.x + q.w && y > q.y && y < q.y + q.h);
    let rows = [];
    passes.forEach((pass, i) => {
      const L = pass.level;
      if (!pyramid[L] || !dims[L]) return;
      if (split === 1 || i % split === rowFrame % split || !rowCache[i]) {
        const sc = opt.levels[L].scale || 2 ** L;
        rowCache[i] = rowFinder.findInLevel(pyramid[L], dims[L][0], dims[L][1], sc, L, skip, opt.rowSensitivity ?? Math.min(opt.sensitivity, opt.rowSensitivityMax)).map((r) => ({
          ...r, img: Float32Array.from(pyramid[L]), iw: dims[L][0],
        }));
      }
      rows.push(...rowCache[i]);
    });
    rowFrame++;
    rows = rowFinder.consolidate(rows);
    const out = [];
    for (const r of rows) {
      const reg = rowFinder.toRegion(r, r.img, r.iw, r.scale);
      const dup = periodic.some((q) => {
        const ix = Math.max(0, Math.min(q.x + q.w, reg.x + reg.w) - Math.max(q.x, reg.x));
        const iy = Math.max(0, Math.min(q.y + q.h, reg.y + reg.h) - Math.max(q.y, reg.y));
        if ((ix * iy) / (reg.w * reg.h) < 0.4) return false;
        const ps = [q.period, q.period2].filter(Boolean);
        return ps.some((p) => [1, 2, 3].some((m) => ratio(reg.period, p * m) < 1.3));
      });
      if (!dup) out.push(reg);
    }
    return out;
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

  // Concentric ellipses: rings seen at an angle. The rings are level sets
  // of (p − c)ᵀ A (p − c), so a cell's stripe normal n is parallel to
  // A (p − c). With e = A c that is linear in (a, b, d, e) for
  // A = [[a, b], [b, d]]; the scale is fixed by a + d = 1. Weighted least
  // squares, in coordinates around the cells' mean for conditioning.
  function fitEllipse(cs) {
    let mx = 0, my = 0, sw = 0;
    for (const c of cs) {
      mx += c.score * c.cx;
      my += c.score * c.cy;
      sw += c.score;
    }
    mx /= sw;
    my /= sw;
    const M = new Float64Array(16);
    const v = new Float64Array(4);
    for (const c of cs) {
      const t = c.a1 / DEG;
      const nx = Math.sin(t);
      const ny = Math.cos(t);
      const x = c.cx - mx;
      const y = c.cy - my;
      const g = [-ny * x - nx * y, nx * x - ny * y, ny, -nx];
      const rhs = -nx * y;
      for (let i = 0; i < 4; i++) {
        v[i] += c.score * g[i] * rhs;
        for (let j = 0; j < 4; j++) M[i * 4 + j] += c.score * g[i] * g[j];
      }
    }
    const sol = solve4(M, v);
    if (!sol) return null;
    const [a, b, ex, ey] = sol;
    const d = 1 - a;
    const det = a * d - b * b;
    if (!(a > 0 && d > 0 && det > 1e-6)) return null;
    // semi-axis ratio of the rings: √(λmin / λmax) of A
    const disc = Math.sqrt(((a - d) * (a - d)) / 4 + b * b);
    if (Math.sqrt((0.5 - disc) / (0.5 + disc)) < opt.ringEllipse) return null;
    return { x: mx + (d * ex - b * ey) / det, y: my + (a * ey - b * ex) / det, A: [a, b, d] };
  }

  // 4×4 linear system by Gaussian elimination with partial pivoting.
  function solve4(M, v) {
    const m = Array.from({ length: 4 }, (_, i) => [M[i * 4], M[i * 4 + 1], M[i * 4 + 2], M[i * 4 + 3], v[i]]);
    for (let col = 0; col < 4; col++) {
      let piv = col;
      for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
      if (Math.abs(m[piv][col]) < 1e-9) return null;
      [m[col], m[piv]] = [m[piv], m[col]];
      for (let r = 0; r < 4; r++) {
        if (r === col) continue;
        const f = m[r][col] / m[col][col];
        for (let k = col; k < 5; k++) m[r][k] -= f * m[col][k];
      }
    }
    return m.map((row, i) => row[4] / row[i]);
  }

  // How far a cell's line misses the centre, as an angle (≈ its sine):
  // rings — the stripe normal against A (p − c), the direction a ring's
  // normal has there (for circles simply towards the centre); rays — the
  // stripe itself against the direction to the centre. Close to the centre,
  // where that angle means little, it is measured against the cell size.
  // Scale-free, so large rings are judged like small ones.
  function aimError(c, f, normal, size) {
    const t = c.a1 / DEG;
    const vx = normal ? Math.sin(t) : Math.cos(t);
    const vy = normal ? Math.cos(t) : -Math.sin(t);
    const ux = c.cx - f.x;
    const uy = c.cy - f.y;
    const [a, b, d] = f.A || [0.5, 0, 0.5];
    const gx = a * ux + b * uy;
    const gy = b * ux + d * uy;
    return Math.abs(vx * gy - vy * gx) / Math.max(Math.hypot(gx, gy), 0.5 * size);
  }

  // Fit a centre (and for rings, the ellipse they make in perspective),
  // drop the cells that clearly do not aim at it (stripes next to the
  // rings that the grouping took in), fit again.
  function ringFit(cs, normal, size) {
    const fit = (u) => (normal ? fitEllipse(u) || fitCenter(u, true) : fitCenter(u, false));
    let use = cs;
    for (let it = 0; it < 4; it++) {
      const f = fit(use);
      if (!f) return null;
      const errs = use.map((c) => aimError(c, f, normal, size));
      const keep = use.filter((_, i) => errs[i] <= opt.ringOutlier);
      if (keep.length === use.length || keep.length < opt.ringCells) {
        let e = 0;
        let w = 0;
        use.forEach((c, i) => {
          e += c.score * errs[i];
          w += c.score;
        });
        return { ...f, err: e / w, cells: use };
      }
      use = keep;
    }
    return null;
  }

  function summarize(cs, type, lv) {
    let sw = 0, gw = 0, lp = 0, lp2 = 0, ca = 0, sa = 0, ang2 = 0, contrast = 0, score = 0;
    let sharp = 0, sharpW = 0, dotsW = 0, gridW = 0, lprom = 0, iso = 0, rep = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    // A lattice region's spacings and angles come from its lattice cells
    // only: stripe cells it took in (rims, grown) see just one direction.
    const lattice = type === 'lattice';
    for (const c of cs) {
      const w = Math.max(c.score, 1e-3);
      sw += w;
      if (!lattice || c.p2) {
        gw += w;
        lp += w * Math.log(c.p1);
        ca += w * Math.cos((2 * c.a1) / DEG);
        sa += w * Math.sin((2 * c.a1) / DEG);
      }
      if (c.p2) {
        lp2 += w * Math.log(c.p2);
        ang2 += w * angleDiff(c.a1, c.a2);
        if (c.type === TYPE.DOTS) dotsW += w;
        else gridW += w;
      }
      contrast += w * c.contrast;
      score += c.score;
      lprom += Math.log(Math.max(1, c.prom || 1));
      iso += c.iso1 || 0;
      rep += c.rep1 || 0;
      if (Number.isFinite(c.sharp)) {
        sharp += w * c.sharp;
        sharpW += w;
      }
      x0 = Math.min(x0, c.cx - c.core / 2);
      y0 = Math.min(y0, c.cy - c.core / 2);
      x1 = Math.max(x1, c.cx + c.core / 2);
      y1 = Math.max(y1, c.cy + c.core / 2);
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
      period: Math.exp(lp / gw),
      angle: ((((Math.atan2(sa, ca) * DEG) / 2) % 180) + 180) % 180,
      coherence: Math.hypot(ca, sa) / gw,
      score: score / cs.length,
      contrast: contrast / sw,
      sharp: sharpW ? sharp / sharpW : 0.5,
      cellRefs: cs.map((c) => [c.col, c.row]),
      // evidence: geometric-mean prominence, mean isolation and repeat
      prom: Math.exp(lprom / cs.length),
      iso: iso / cs.length,
      rep: rep / cs.length,
    };
    if (reg.family === 'lattice') {
      reg.dirs = cs.flatMap((c) => (c.p2 ? [[c.p1, c.a1], [c.p2, c.a2]] : [[c.p1, c.a1]]));
      reg.period2 = Math.exp(lp2 / gw);
      reg.ratio = reg.period / reg.period2;
      reg.latticeAngle = ang2 / gw;
    }
    return reg;
  }

  // Rings or rays among a group of stripe cells: { reg, kept } or null.
  function ringRegion(cs, lv) {
    const bins = new Set(cs.map((c) => Math.floor(c.a1 / 20) % 9));
    if (bins.size < 3) return null;
    let ca = 0, sa = 0, sw = 0, mx = 0, my = 0;
    for (const c of cs) {
      ca += c.score * Math.cos((2 * c.a1) / DEG);
      sa += c.score * Math.sin((2 * c.a1) / DEG);
      sw += c.score;
      mx += c.cx / cs.length;
      my += c.cy / cs.length;
    }
    if (Math.hypot(ca, sa) / sw > 0.85) return null; // orientations too uniform
    if (cs.filter((c) => !c.weak).length < 2 && cs.length < 7) return null;
    const fc = ringFit(cs, true, lv.size);
    const fr = ringFit(cs, false, lv.size);
    let best = null;
    let type = null;
    if (fc && (!fr || fc.err <= fr.err)) {
      best = fc;
      type = TYPE.CONCENTRIC;
    } else if (fr) {
      best = fr;
      type = TYPE.RADIAL;
    }
    if (!best || best.err > opt.ringAim) return null;
    const kept = best.cells;
    if (kept.length < opt.ringKeep * cs.length) return null;
    // what is left must still fan out (not one straight stripe patch)
    if (new Set(kept.map((c) => Math.floor(c.a1 / 20) % 9)).size < 3) return null;
    if (kept.filter((c) => !c.weak).length < 2 && kept.length < 7) return null;
    let spread = 0;
    for (const c of kept) spread = Math.max(spread, Math.hypot(c.cx - mx, c.cy - my));
    if (Math.hypot(best.x - mx, best.y - my) > 2.5 * spread + lv.size) return null;
    if (type === TYPE.CONCENTRIC) {
      // rings keep their spacing. Some cells read the curved centre, the
      // rim or a harmonic instead, so most — not all — must agree.
      const ps = kept.map((c) => c.p1).sort((a, b) => a - b);
      const med = ps[ps.length >> 1];
      if (ps.filter((p) => ratio(p, med) < 1.3).length < opt.ringSpacing * ps.length) return null;
    }
    const reg = summarize(kept, type, lv);
    reg.center = { x: best.x, y: best.y };
    reg.fit = best.err;
    return { reg, kept };
  }

  // The group minus its straight stripe patches: firm cells that agree
  // closely (strictCompat), at least 4 of them, all one way.
  function withoutStraight(cs, lv) {
    const at = new Map(cs.map((c) => [c.row * lv.cols + c.col, c]));
    const seen = new Set();
    const drop = new Set();
    for (const c of cs) {
      if (c.weak || seen.has(c)) continue;
      const patch = [c];
      seen.add(c);
      for (let q = 0; q < patch.length; q++) {
        const cur = patch[q];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = at.get((cur.row + dy) * lv.cols + cur.col + dx);
          if (!n || n.weak || seen.has(n) || cur.col + dx < 0 || cur.col + dx >= lv.cols) continue;
          if (ratio(n.p1, c.p1) >= 1.2 || angleDiff(n.a1, c.a1) >= 10) continue;
          seen.add(n);
          patch.push(n);
        }
      }
      if (patch.length >= 4) for (const p of patch) drop.add(p);
    }
    return cs.filter((c) => !drop.has(c));
  }

  function buildRegions(lv) {
    const { cols, cells } = lv;
    const used = new Uint8Array(cells.length);
    const out = [];

    if (opt.rings) {
      const groups = components(lv, (i) => cells[i].type === TYPE.STRIPE, looseCompat, true);
      for (const g of groups) {
        if (g.length < opt.ringCells) continue;
        const cs = g.map((i) => cells[i]);
        // A straight stripe field touching the rings joins the group and
        // pulls the fit away: if the whole group fails, try without it.
        let ring = ringRegion(cs, lv);
        if (!ring) {
          const rest = withoutStraight(cs, lv);
          if (rest.length < cs.length && rest.length >= opt.ringCells) ring = ringRegion(rest, lv);
        }
        if (!ring) continue;
        out.push(ring.reg);
        for (const c of ring.kept) used[c.row * cols + c.col] = 1;
      }
    }

    const groups = components(lv, (i) => !used[i] && !!cells[i].type && !cells[i].weak, strictCompat, false);
    let parts = groups.map((g) => ({ g, cs: g.map((i) => cells[i]), lattice: isLattice(cells[g[0]]) }));

    // Seams between two stripe fields are not lattices.
    parts = parts.filter((p) => !(p.lattice && p.cs.length <= 3 && isSeam(lv, p.g)));
    // A stray line through a pattern splits it; bridge gaps under a cell.
    bridgeGaps(parts, lv);
    // Hysteresis: a region may take in neighbouring cells that only just
    // failed (weak) when they agree with it — the ragged rim of a fence,
    // a sheet in perspective. Weak cells never start a region.
    if (opt.grow) growParts(parts, lv, used);

    const band = opt.levels[lv.level];
    for (const p of parts) {
      const cs = p.cs;
      const lattice = p.lattice;
      // A region smaller than this level's minimum stands on its own only
      // when its peaks are far above the background and clearly repeat.
      // Lone lattice cells are usually two patterns sharing a cell: skip.
      // grown (weak) cells widen a region but do not make it count
      const strict = cs.length - (p.grown || 0);
      // a region of loosely regular cells only counts when it is wide
      // (bark, ripples, florets) — a few such cells are an edge or a fold
      const firm = cs.filter((c) => !c.soft && !c.weak).length;
      if (firm < band.minCells && strict < band.minCells + opt.softCells) continue;
      if (strict < band.minCells) {
        const mean = (f) => cs.reduce((s, c) => s + (c[f] || 0), 0) / cs.length;
        const gprom = Math.exp(cs.reduce((s, c) => s + Math.log(Math.max(1, c.prom || 1)), 0) / cs.length);
        const sens = lattice ? Math.min(opt.sensitivity, 1.1) : opt.sensitivity; // see sens2
        const strong = gprom * sens >= opt.smallProminence && mean('iso1') >= opt.smallIsolation &&
          mean('rep1') >= opt.smallRepeat && (!lattice || cs.length >= 2);
        if (!strong) continue;
      }
      out.push(summarize(cs, lattice ? 'lattice' : TYPE.STRIPE, lv));
    }
    return out;
  }

  function growParts(parts, lv, used) {
    const { cols, rows, cells } = lv;
    const taken = new Uint8Array(cells.length);
    for (const p of parts) for (const i of p.g) taken[i] = 1;
    for (const p of parts) {
      const m = partMean(p);
      const dirs = p.lattice ? [[m.p1, m.a1], [m.p2, m.a2]] : [[m.p1, m.a1]];
      const fits = (c) => c.type === TYPE.STRIPE && c.weak &&
        dirs.some(([pp, aa]) => ratio(c.p1, pp) < 1.2 && angleDiff(c.a1, aa) < 15);
      for (let q = 0; q < p.g.length; q++) {
        const cur = p.g[q];
        const x = cur % cols;
        const y = (cur / cols) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
          const j = yy * cols + xx;
          if (taken[j] || used[j] || !fits(cells[j])) continue;
          taken[j] = 1;
          p.g.push(j);
          p.cs.push(cells[j]);
          p.grown = (p.grown || 0) + 1;
        }
      }
    }
  }

  function partBox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of p.cs) {
      x0 = Math.min(x0, c.cx - c.core / 2);
      y0 = Math.min(y0, c.cy - c.core / 2);
      x1 = Math.max(x1, c.cx + c.core / 2);
      y1 = Math.max(y1, c.cy + c.core / 2);
    }
    return { x0, y0, x1, y1 };
  }
  function near(a, b, gap) {
    const A = partBox(a);
    const B = partBox(b);
    return A.x0 - gap < B.x1 && B.x0 - gap < A.x1 && A.y0 - gap < B.y1 && B.y0 - gap < A.y1;
  }
  function partMean(p) {
    let w = 0, lp = 0, lp2 = 0, ca = 0, sa = 0, ca2 = 0, sa2 = 0, w2 = 0;
    for (const c of p.cs) {
      const k = Math.max(c.score, 1e-3);
      w += k;
      lp += k * Math.log(c.p1);
      ca += k * Math.cos((2 * c.a1) / DEG);
      sa += k * Math.sin((2 * c.a1) / DEG);
      if (c.p2) {
        w2 += k;
        lp2 += k * Math.log(c.p2);
        ca2 += k * Math.cos((2 * c.a2) / DEG);
        sa2 += k * Math.sin((2 * c.a2) / DEG);
      }
    }
    const ang = (c, s) => ((((Math.atan2(s, c) * DEG) / 2) % 180) + 180) % 180;
    return {
      p1: Math.exp(lp / w),
      p2: w2 ? Math.exp(lp2 / w2) : 0,
      a1: ang(ca, sa),
      a2: w2 ? ang(ca2, sa2) : 0,
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

  // A ring or ray figure also leaves stripe regions on itself (a stretch of
  // rings far from the centre is nearly straight, or a level saw only part
  // of it). A stripe region mostly inside a ring/ray region whose lines run
  // the way that figure's would at that spot is part of it.
  function absorbRings(regions) {
    const hosts = regions.filter((r) => r.family === 'radial' && r.center);
    if (!hosts.length) return regions;
    return regions.filter((S) => {
      if (S.type !== TYPE.STRIPE) return true;
      return !hosts.some((H) => {
        const ix = Math.max(0, Math.min(H.x + H.w, S.x + S.w) - Math.max(H.x, S.x));
        const iy = Math.max(0, Math.min(H.y + H.h, S.y + S.h) - Math.max(H.y, S.y));
        if ((ix * iy) / (S.w * S.h) < 0.5) return false;
        if (H.type === TYPE.CONCENTRIC && ratio(S.period, H.period) > 1.5) return false;
        const t = S.angle / DEG;
        const normal = H.type === TYPE.CONCENTRIC;
        const vx = normal ? Math.sin(t) : Math.cos(t);
        const vy = normal ? Math.cos(t) : -Math.sin(t);
        const dx = H.center.x - S.cx;
        const dy = H.center.y - S.cy;
        const d = Math.hypot(dx, dy);
        return d < 0.5 * S.cellSize || Math.abs(vx * dy - vy * dx) / d <= opt.ringOutlier;
      });
    });
  }

  // The same pattern can show up at both levels near the hand-over period.
  function dedupe(regions) {
    const weight = (r) => r.score * Math.sqrt(r.w * r.h);
    const drop = new Set();
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        if (a.family !== b.family) continue;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const overlap = (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
        if (a.level === b.level) {
          // a small patch inside a much larger region of the same kind is a
          // local hiccup of that region (a stray line crossing it…)
          const small = a.w * a.h < b.w * b.h ? i : j;
          const ra = Math.min(a.w * a.h, b.w * b.h) / Math.max(a.w * a.h, b.w * b.h);
          if (overlap > 0.6 && ra < 0.25) drop.add(small);
          continue;
        }
        const pr = ratio(a.period, b.period);
        // the same pattern seen at two levels: a coarse level's cells reach
        // past the pattern's edge, so its box may stick out a long way
        const same = pr < 1.1 && angleDiff(a.angle, b.angle) < 8;
        if (overlap <= (same ? 0.25 : 0.5)) continue;
        if (pr < 1.4) {
          drop.add(weight(a) >= weight(b) ? j : i);
          continue;
        }
        // a finer level locked onto a harmonic of a coarse pattern
        const harmonic = [2, 3].some((m) => Math.abs(pr / m - 1) < 0.12) &&
          (a.family !== 'line' || angleDiff(a.angle, b.angle) < 10);
        if (harmonic) drop.add(a.period < b.period ? i : j);
      }
    }
    return regions.filter((_, i) => !drop.has(i));
  }

  function setOptions(o) {
    Object.assign(opt, o);
  }

  return { analyze, setOptions, options: opt };
}
