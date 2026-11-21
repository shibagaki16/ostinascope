// Ostinascope — camera motion from frame to frame, so the overlay stays on
// the surface a pattern was found on, between analyses and while the
// analysis of a frame is still on its way back from the worker.
//
//   1. corners (Shi–Tomasi), at most one per grid cell so they spread out
//   2. each corner followed into the next frame by pyramidal Lucas–Kanade,
//      checked by following it back (forward–backward error)
//   3. a homography fitted to the moved corners with RANSAC: the motion of
//      the dominant plane. Exact for any scene while the phone only turns,
//      and for a flat poster also while it moves.
//   4. again on the corners it leaves out, for up to maxPlanes surfaces:
//      when the phone moves (not just turns) a near floor and a far wall
//      shift differently, so each flat surface has its own homography.
//      Surfaces keep an id from frame to frame through their corners.
//
// Frames get consecutive indices; the motion between any two recent frames
// can be chained (chain(k0, k1), or chain(k0, k1, surfaceId) for one
// surface). Where it cannot be estimated (blank wall, heavy blur, a jump)
// the step is null and callers fall back to no motion.
//
// Pure module (no DOM): runs in the page, a worker or Node.

import { applyH, fitH, IDENTITY, mulH } from './homography.js';
import { rng } from './util.js';

export const MOTION_DEFAULTS = Object.freeze({
  levels: 3, // pyramid levels (192 → 96 → 48 px)
  win: 3, // Lucas–Kanade half window (7×7)
  iters: 8,
  maxPoints: 150,
  cell: 16, // px (level 0): one corner per cell
  minCorner: 2e-4, // Shi–Tomasi score floor (grey 0..1, 5×5 window, level 1)
  relCorner: 0.02, // … and this share of the frame's best corner
  maxFB: 0.6, // px: forward–backward disagreement allowed
  maxResidual: 0.06, // mean |ΔI| over the window after tracking (grey 0..1)
  inlierPx: 1.0, // RANSAC transfer error, px
  minInliers: 12,
  minInlierShare: 0.4,
  ransacIters: 150,
  searchEvery: 4, // frames between corner searches (while enough are left)
  history: 45, // frames of motion kept for chaining (≈1.5 s at 30 Hz)
  maxPlanes: 3, // surfaces told apart by their motion (1 = the dominant one only)
  // Surfaces are told apart over a few frames: from one frame to the next a
  // near floor and a far wall differ by a pixel or so, over 7 frames
  // (0.23 s) by several.
  segFrames: 7,
  segPx: 1.5, // px: a corner fits a surface's motion over those frames
  minPlanePoints: 10, // a further surface needs this many corners
  minPlaneShare: 0.06, // … and this share of the followed ones
  planeApart: 2, // px: its corners must miss the dominant motion by this much (median, over segFrames)
  planeApartKnown: 1.2, // … a surface already being followed, this much (hysteresis)
  planeKeep: 15, // frames a surface id survives without being found
  maxStrikes: 3, // frames in a row a corner may fit no surface before it is dropped
  maxScaleStep: 1.25, // per frame: zoom more than this is not believed
});

/** RGBA bytes → grey 0..1 (Rec. 601 luma), into `out` when it fits. */
export function greyOf(rgba, w, h, out) {
  const g = out && out.length === w * h ? out : new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    g[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * (1 / 255);
  }
  return g;
}

// A frame's pyramid: smoothed grey and its gradients per level. Built into
// preallocated buffers (two pyramids are used in turn) so the camera loop
// does not churn the garbage collector.
function allocPyramid(w, h, levels) {
  const lv = [];
  let sw = w;
  let sh = h;
  for (let L = 0; L < levels; L++) {
    lv.push({ img: new Float32Array(sw * sh), gx: new Float32Array(sw * sh), gy: new Float32Array(sw * sh),
      tmp: new Float32Array(sw * sh), w: sw, h: sh });
    sw >>= 1;
    sh >>= 1;
  }
  return lv;
}

function buildPyramid(lv, grey) {
  let src = grey;
  for (let L = 0; L < lv.length; L++) {
    const { img, gx, gy, tmp, w, h } = lv[L];
    blur(src, w, h, tmp, img);
    // central differences of the smoothed image
    for (let y = 1; y < h - 1; y++) {
      const r = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = r + x;
        gx[i] = 0.5 * (img[i + 1] - img[i - 1]);
        gy[i] = 0.5 * (img[i + w] - img[i - w]);
      }
    }
    if (L === lv.length - 1) break;
    // 2×2 box down into the next level's scratch buffer, blurred from there
    const nx = lv[L + 1];
    const dst = nx.gx; // free until that level's gradients are computed
    for (let y = 0; y < nx.h; y++) {
      const a = 2 * y * w;
      const b = a + w;
      for (let x = 0; x < nx.w; x++) {
        const xx = 2 * x;
        dst[y * nx.w + x] = 0.25 * (img[a + xx] + img[a + xx + 1] + img[b + xx] + img[b + xx + 1]);
      }
    }
    src = dst;
  }
  return lv;
}

// [1 2 1]/4 separable blur (edges clamped), src → out via tmp.
function blur(src, w, h, tmp, out) {
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[r + (x > 0 ? x - 1 : 0)];
      const c = src[r + x];
      const rr = src[r + (x < w - 1 ? x + 1 : x)];
      tmp[r + x] = 0.25 * (l + 2 * c + rr);
    }
  }
  for (let y = 0; y < h; y++) {
    const u = (y > 0 ? y - 1 : 0) * w;
    const r = y * w;
    const d = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) out[r + x] = 0.25 * (tmp[u + x] + 2 * tmp[r + x] + tmp[d + x]);
  }
}

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Convex hull (monotone chain).
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function createMotion(options = {}) {
  const opt = { ...MOTION_DEFAULTS, ...options };
  const R = opt.win;
  const WN = (2 * R + 1) * (2 * R + 1);
  const T = new Float32Array(WN);
  const TX = new Float32Array(WN);
  const TY = new Float32Array(WN);
  const J = new Float32Array(WN);
  const random = rng(1);

  let prev = null; // pyramid of the previous frame
  let pyrs = []; // the two pyramids, used in turn
  let dims = '';
  let k = -1; // index of the latest frame
  const steps = new Array(opt.history).fill(null); // steps[k % history]: H from k-1 to k
  let last = null; // the previous step, as a prediction for this one
  // corners being followed (level-0 px)
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let pl = new Int16Array(0); // surface id of each corner (-1: none yet)
  let age = new Uint16Array(0); // frames followed
  let strikes = new Uint8Array(0); // frames in a row that fitted no surface
  const HN = 8; // positions kept per corner (0 = now)
  let hx = new Float32Array(0);
  let hy = new Float32Array(0);
  let n = 0;
  let stats = { tracked: 0, inliers: 0, ok: false, planes: 0 };
  const planes = new Map(); // id → { id, last: H, missed }
  let nextPlane = 0;
  let mainPlane = -1;

  // Sample a (2R+1)² window centred on (x, y) by bilinear interpolation.
  // Every pixel of the window shares the same sub-pixel offset, so the
  // four weights are computed once.
  function sampleWin(img, w, x, y, out) {
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    let m = 0;
    for (let v = -R; v <= R; v++) {
      let i = (y0 + v) * w + x0 - R;
      for (let u = -R; u <= R; u++, i++) {
        out[m++] = w00 * img[i] + w10 * img[i + 1] + w01 * img[i + w] + w11 * img[i + w + 1];
      }
    }
  }

  // Follow one point from pyramid A to pyramid B, starting from a guess
  // (level-0 px). Returns [x, y] in B, or null.
  function track(A, B, x, y, gx0, gy0) {
    let dx = gx0 / (1 << (A.length - 1));
    let dy = gy0 / (1 << (A.length - 1));
    for (let L = A.length - 1; L >= 0; L--) {
      const a = A[L];
      const b = B[L];
      const s = 1 / (1 << L);
      const ax = x * s;
      const ay = y * s;
      if (ax < R + 1 || ay < R + 1 || ax > a.w - R - 2 || ay > a.h - R - 2) return null;
      // template and its gradients around the point in A
      sampleWin(a.img, a.w, ax, ay, T);
      sampleWin(a.gx, a.w, ax, ay, TX);
      sampleWin(a.gy, a.w, ax, ay, TY);
      let gxx = 0, gxy = 0, gyy = 0;
      for (let m = 0; m < WN; m++) {
        gxx += TX[m] * TX[m];
        gxy += TX[m] * TY[m];
        gyy += TY[m] * TY[m];
      }
      const det = gxx * gyy - gxy * gxy;
      if (!(det > 1e-12)) {
        if (L === 0) return null;
      } else {
        for (let it = 0; it < opt.iters; it++) {
          const bx = ax + dx;
          const by = ay + dy;
          if (bx < R + 1 || by < R + 1 || bx > b.w - R - 2 || by > b.h - R - 2) return null;
          sampleWin(b.img, b.w, bx, by, J);
          let ex = 0;
          let ey = 0;
          for (let m = 0; m < WN; m++) {
            const d = T[m] - J[m];
            ex += d * TX[m];
            ey += d * TY[m];
          }
          const sx = (gyy * ex - gxy * ey) / det;
          const sy = (gxx * ey - gxy * ex) / det;
          dx += sx;
          dy += sy;
          if (sx * sx + sy * sy < 1e-4) break;
        }
      }
      if (L > 0) {
        dx *= 2;
        dy *= 2;
      }
    }
    const bx = x + dx;
    const by = y + dy;
    const b0 = B[0];
    if (bx < R + 1 || by < R + 1 || bx > b0.w - R - 2 || by > b0.h - R - 2) return null;
    // the window must look the same where it landed (T: the level-0 template)
    sampleWin(b0.img, b0.w, bx, by, J);
    let res = 0;
    for (let m = 0; m < WN; m++) res += Math.abs(T[m] - J[m]);
    if (res / WN > opt.maxResidual) return null;
    return [bx, by];
  }

  // New corners where there are none yet (Shi–Tomasi on level 1).
  function replenish(P) {
    const room = opt.maxPoints - n;
    if (room < opt.maxPoints * 0.25) return;
    // a full search only every few frames, unless corners are running out
    if (n > opt.maxPoints * 0.5 && k % opt.searchEvery) return;
    const lv = P[Math.min(1, P.length - 1)];
    const sc = P.length > 1 ? 2 : 1;
    const { w, h, gx, gy } = lv;
    const cs = Math.max(4, Math.round(opt.cell / sc));
    const cols = Math.floor(w / cs);
    const rows = Math.floor(h / cs);
    const taken = new Uint8Array(cols * rows);
    for (let i = 0; i < n; i++) {
      const c = Math.floor(px[i] / sc / cs);
      const r = Math.floor(py[i] / sc / cs);
      if (c >= 0 && r >= 0 && c < cols && r < rows) taken[r * cols + c] = 1;
    }
    const best = [];
    let top = 0;
    const B = 2; // 5×5 structure tensor
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (taken[r * cols + c]) continue;
        let bs = 0;
        let bxx = 0;
        let byy = 0;
        for (let y = r * cs; y < (r + 1) * cs; y++) {
          if (y < B + R + 2 || y >= h - B - R - 2) continue;
          for (let x = c * cs; x < (c + 1) * cs; x++) {
            if (x < B + R + 2 || x >= w - B - R - 2) continue;
            let a = 0, bb = 0, d = 0;
            for (let v = -B; v <= B; v++) {
              const o = (y + v) * w + x;
              for (let u = -B; u <= B; u++) {
                const tx = gx[o + u];
                const ty = gy[o + u];
                a += tx * tx;
                bb += tx * ty;
                d += ty * ty;
              }
            }
            const score = (a + d) / 2 - Math.sqrt(((a - d) * (a - d)) / 4 + bb * bb); // min eigenvalue
            if (score > bs) {
              bs = score;
              bxx = x;
              byy = y;
            }
          }
        }
        if (bs > 0) {
          best.push([bs, bxx * sc, byy * sc]);
          if (bs > top) top = bs;
        }
      }
    }
    const floor = Math.max(opt.minCorner, opt.relCorner * top);
    // fill the emptiest parts of the frame first (a soft floor beside a
    // contrasty poster would otherwise never get corners): rank by how many
    // of the surrounding cells already have one, then by strength
    const crowd = (x, y) => {
      const c = Math.floor(x / sc / cs);
      const r = Math.floor(y / sc / cs);
      let k2 = 0;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && taken[rr * cols + cc]) k2++;
        }
      }
      return k2;
    };
    const ranked = best.filter((b) => b[0] >= floor).map((b) => [crowd(b[1], b[2]), ...b]);
    ranked.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const add = ranked.slice(0, room).map((b) => b.slice(1));
    if (!add.length) return;
    const N = n + add.length;
    const grow = (A, Ctor, per = 1) => {
      const B = new Ctor(N * per);
      B.set(A.subarray(0, n * per));
      return B;
    };
    px = grow(px, Float32Array);
    py = grow(py, Float32Array);
    pl = grow(pl, Int16Array);
    age = grow(age, Uint16Array);
    strikes = grow(strikes, Uint8Array);
    hx = grow(hx, Float32Array, HN);
    hy = grow(hy, Float32Array, HN);
    add.forEach(([, x, y], i) => {
      const j = n + i;
      px[j] = x;
      py[j] = y;
      pl[j] = -1;
      age[j] = 0;
      strikes[j] = 0;
      for (let q = 0; q < HN; q++) {
        hx[j * HN + q] = x;
        hy[j * HN + q] = y;
      }
    });
    n = N;
  }

  // RANSAC homography on correspondences (ax, ay) → (bx, by) for the
  // indices in `idx`. The predicted motions (`priors`: last steps) are
  // tried first: while the phone moves steadily they already explain the
  // corners.
  function ransac(ax, ay, bx, by, idx, priors) {
    const m = idx.length;
    const thr = opt.inlierPx * opt.inlierPx;
    const inside = (H, j) => {
      const i = idx[j];
      const x = ax[i];
      const y = ay[i];
      const w = H[6] * x + H[7] * y + H[8];
      const dx = (H[0] * x + H[1] * y + H[2]) / w - bx[i];
      const dy = (H[3] * x + H[4] * y + H[5]) / w - by[i];
      return dx * dx + dy * dy < thr;
    };
    const count = (H) => {
      let c = 0;
      for (let i = 0; i < m; i++) if (inside(H, i)) c++;
      return c;
    };
    const inliersOf = (H) => {
      const out = [];
      for (let j = 0; j < m; j++) if (inside(H, j)) out.push(idx[j]);
      return out;
    };
    let best = null;
    let bestN = 0;
    // enough iterations to have drawn one all-inlier sample (99.5 %)
    const needed = (c) => Math.ceil(Math.log(0.005) / Math.log(Math.max(1e-9, 1 - (c / m) ** 4)));
    let iters = opt.ransacIters;
    for (const H of priors) {
      if (!H) continue;
      const c = count(H);
      if (c > bestN) {
        best = H;
        bestN = c;
        iters = Math.min(iters, needed(c));
      }
    }
    const s = [0, 0, 0, 0];
    for (let it = 0; it < iters; it++) {
      for (let j = 0; j < 4; j++) {
        let i;
        let dup;
        do {
          i = idx[Math.floor(random() * m)];
          dup = false;
          for (let q = 0; q < j; q++) if (s[q] === i) dup = true;
        } while (dup);
        s[j] = i;
      }
      const H = fitH(ax, ay, bx, by, s);
      if (!H) continue;
      const c = count(H);
      if (c > bestN) {
        best = H;
        bestN = c;
        iters = Math.min(iters, needed(c));
      }
    }
    if (!best) return null;
    // refine on the inliers, twice
    let H = best;
    for (let r = 0; r < 2; r++) {
      const inl = inliersOf(H);
      if (inl.length < 4) break;
      const F = fitH(ax, ay, bx, by, inl);
      if (!F) break;
      H = F;
    }
    return { H, inliers: inliersOf(H) };
  }

  /** A believable frame-to-frame motion: no flips, no wild zoom or tilt. */
  function plausible(H, w, h) {
    const det = H[0] * H[4] - H[1] * H[3];
    if (!(det > 0)) return false;
    const s = Math.sqrt(det);
    if (s > opt.maxScaleStep || s < 1 / opt.maxScaleStep) return false;
    // perspective change across the frame within a factor 1.25
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => H[6] * x + H[7] * y + H[8]);
    return Math.max(...corners) / Math.min(...corners) < 1.25 && Math.min(...corners) > 0;
  }

  /**
   * Add a frame (grey 0..1, w×h). Returns { k, H, ok }: H takes points of
   * the previous frame to this one (null when the motion is unknown).
   */
  function push(grey, w, h) {
    const key = `${w}x${h}`;
    if (key !== dims) {
      reset();
      dims = key;
      pyrs = [allocPyramid(w, h, opt.levels), allocPyramid(w, h, opt.levels)];
    }
    const P = buildPyramid(pyrs[0] === prev ? pyrs[1] : pyrs[0], grey);
    k++;
    let H = null;
    let bySurface = new Map();
    if (prev && n) {
      const ax = new Float32Array(n);
      const ay = new Float32Array(n);
      const bx = new Float32Array(n);
      const by = new Float32Array(n);
      const src = new Int32Array(n); // index of the corner before this frame
      let m = 0;
      for (let i = 0; i < n; i++) {
        const guess = (planes.get(pl[i]) || {}).last || last;
        const [gx, gy] = guess ? applyH(guess, px[i], py[i]) : [px[i], py[i]];
        const f = track(prev, P, px[i], py[i], gx - px[i], gy - py[i]);
        if (!f) continue;
        const back = track(P, prev, f[0], f[1], px[i] - f[0], py[i] - f[1]);
        if (!back || Math.hypot(back[0] - px[i], back[1] - py[i]) > opt.maxFB) continue;
        ax[m] = px[i];
        ay[m] = py[i];
        bx[m] = f[0];
        by[m] = f[1];
        src[m] = i;
        m++;
      }
      stats = { tracked: m, inliers: 0, ok: false, planes: 0 };
      // the dominant motion from this frame's corners
      const all = Array.from({ length: m }, (_, i) => i);
      const priors = [last, ...[...planes.values()].map((q) => q.last), IDENTITY];
      const fit = m >= opt.minInliers ? ransac(ax, ay, bx, by, all, priors) : null;
      if (fit && fit.inliers.length >= opt.minInliers && fit.inliers.length >= opt.minInlierShare * m && plausible(fit.H, w, h)) {
        H = fit.H;
        stats = { tracked: m, inliers: fit.inliers.length, ok: true, planes: 1 };
      }
      // the followed corners, with their histories moved on by one frame
      const nhx = new Float32Array(m * HN);
      const nhy = new Float32Array(m * HN);
      const nage = new Uint16Array(m);
      const nlab = new Int16Array(m);
      const nstr = new Uint8Array(m);
      for (let j = 0; j < m; j++) {
        const i = src[j];
        nhx[j * HN] = bx[j];
        nhy[j * HN] = by[j];
        for (let q = 1; q < HN; q++) {
          nhx[j * HN + q] = hx[i * HN + q - 1];
          nhy[j * HN + q] = hy[i * HN + q - 1];
        }
        nage[j] = Math.min(65535, age[i] + 1);
        nlab[j] = pl[i];
        nstr[j] = strikes[i];
      }
      let keep = all;
      if (H) {
        const seg = segment(ax, ay, bx, by, m, nhx, nhy, nage, nlab, H, w, h);
        bySurface = seg.by;
        mainPlane = seg.main;
        stats.planes = bySurface.size;
        // a corner that fits no surface for a few frames in a row goes
        keep = [];
        for (let j = 0; j < m; j++) {
          nlab[j] = seg.label[j];
          nstr[j] = seg.fits[j] ? 0 : Math.min(255, nstr[j] + 1);
          if (nstr[j] <= opt.maxStrikes) keep.push(j);
        }
      }
      const pick = (A, Ctor) => Ctor.from(keep, (j) => A[j]);
      px = pick(bx, Float32Array);
      py = pick(by, Float32Array);
      pl = pick(nlab, Int16Array);
      age = pick(nage, Uint16Array);
      strikes = pick(nstr, Uint8Array);
      hx = new Float32Array(keep.length * HN);
      hy = new Float32Array(keep.length * HN);
      keep.forEach((j, q) => {
        hx.set(nhx.subarray(j * HN, (j + 1) * HN), q * HN);
        hy.set(nhy.subarray(j * HN, (j + 1) * HN), q * HN);
      });
      n = keep.length;
    } else {
      stats = { tracked: 0, inliers: 0, ok: false, planes: 0 };
    }
    if (!H) mainPlane = -1;
    steps[k % opt.history] = H ? { H, by: bySurface } : null;
    last = H;
    for (const [id, Hs] of bySurface) planes.set(id, { id, last: Hs, missed: 0 });
    for (const [id, q] of planes) {
      if (bySurface.has(id)) continue;
      q.missed++;
      q.last = null;
      if (q.missed > opt.planeKeep) planes.delete(id);
    }
    prev = P;
    replenish(P);
    return { k, H, ok: !!H, surfaces: bySurface, main: mainPlane };
  }

  // Sort the corners into surfaces and give each surface its motion for
  // this frame.
  //   1. over the last segFrames frames (corners followed that long), the
  //      dominant homography, then — on the corners it leaves out — others,
  //      each with enough corners that clearly do not move with the first
  //   2. each such corner goes to the surface that explains its path best;
  //      a surface inherits the id most of its corners had
  //   3. each surface's motion from the previous frame to this one, fitted
  //      on its own corners; younger corners join the surface whose motion
  //      they clearly fit best, or keep the one they had
  // Returns { by: Map(id → H), main: id, label, fits } (label/fits per corner).
  function segment(ax, ay, bx, by, m, nhx, nhy, nage, nlab, H, w, h) {
    const L = Math.min(opt.segFrames, HN - 1);
    const thr = opt.inlierPx * opt.inlierPx;
    const label = Int16Array.from(nlab);
    const fits = new Uint8Array(m);
    const err = (Hm, x0, y0, x1, y1) => {
      const ww = Hm[6] * x0 + Hm[7] * y0 + Hm[8];
      const dx = (Hm[0] * x0 + Hm[1] * y0 + Hm[2]) / ww - x1;
      const dy = (Hm[3] * x0 + Hm[4] * y0 + Hm[5]) / ww - y1;
      return dx * dx + dy * dy;
    };
    // 1. long-baseline correspondences of the corners followed long enough
    const old = [];
    for (let j = 0; j < m; j++) if (nage[j] >= L) old.push(j);
    const sx = new Float32Array(m);
    const sy = new Float32Array(m);
    const ex = new Float32Array(m);
    const ey = new Float32Array(m);
    for (const j of old) {
      sx[j] = nhx[j * HN + L];
      sy[j] = nhy[j * HN + L];
      ex[j] = nhx[j * HN];
      ey[j] = nhy[j * HN];
    }
    const fitsLong = [];
    if (opt.maxPlanes > 1 && old.length >= opt.minPlanePoints * 2) {
      const segThr = opt.segPx * opt.segPx;
      let rest = old;
      for (let s = 0; s < opt.maxPlanes && rest.length >= opt.minPlanePoints; s++) {
        // a surface already being followed: start from its own corners
        const seeds = [];
        for (const id of planes.keys()) {
          const mine = rest.filter((j) => nlab[j] === id);
          if (mine.length >= 6) seeds.push(mine);
        }
        const f = ransacLong(sx, sy, ex, ey, rest, segThr, seeds);
        if (!f) break;
        const nIn = f.inliers.length;
        if (s === 0) {
          if (nIn < opt.minInlierShare * old.length) break;
        } else {
          if (nIn < Math.max(opt.minPlanePoints, opt.minPlaneShare * old.length)) break;
          const known = f.inliers.filter((j) => nlab[j] >= 0 && planes.has(nlab[j]) && nlab[j] !== nlab[fitsLong[0].inliers[0]]).length > 0.5 * nIn;
          const apart = known ? opt.planeApartKnown : opt.planeApart;
          const miss = f.inliers.map((j) => err(fitsLong[0].H, sx[j], sy[j], ex[j], ey[j])).sort((a, b) => a - b);
          if (miss[miss.length >> 1] < apart * apart) break;
        }
        fitsLong.push(f);
        const inl = new Set(f.inliers);
        rest = rest.filter((j) => !inl.has(j));
      }
    }
    // only one surface (or too few corners to tell): everything is it
    if (fitsLong.length < 2) {
      const id = inherit([...Array(m).keys()].filter((j) => err(H, ax[j], ay[j], bx[j], by[j]) < thr), nlab, new Set());
      for (let j = 0; j < m; j++) {
        label[j] = id;
        fits[j] = err(H, ax[j], ay[j], bx[j], by[j]) < 4 * thr ? 1 : 0;
      }
      return { by: new Map([[id, H]]), main: id, label, fits };
    }
    // 2. each long-followed corner to its best surface; ids
    const members = fitsLong.map(() => []);
    const segThr = opt.segPx * opt.segPx;
    for (const j of old) {
      let best = -1;
      let be = segThr * 2;
      fitsLong.forEach((f, q) => {
        const e = err(f.H, sx[j], sy[j], ex[j], ey[j]);
        if (e < be) {
          be = e;
          best = q;
        }
      });
      if (best >= 0) members[best].push(j);
    }
    const taken = new Set();
    const ids = members.map((mem) => {
      const id = inherit(mem, nlab, taken);
      taken.add(id);
      return id;
    });
    // 3. this frame's motion per surface, on its own corners
    const step = new Map();
    members.forEach((mem, q) => {
      const id = ids[q];
      const prior = (planes.get(id) || {}).last;
      let Hq = null;
      if (mem.length >= opt.minPlanePoints) {
        const f = ransac(ax, ay, bx, by, mem, [prior, H]);
        if (f && f.inliers.length >= Math.max(6, 0.5 * mem.length) && plausible(f.H, w, h)) Hq = f.H;
      }
      step.set(id, Hq || (q === 0 ? H : null));
      for (const j of mem) label[j] = id;
    });
    for (const [id, Hq] of step) if (!Hq) step.delete(id);
    const main = ids[0];
    if (!step.has(main)) step.set(main, H);
    // younger corners: the surface whose motion they clearly fit best
    for (let j = 0; j < m; j++) {
      const own = step.get(label[j]);
      const errs = [...step].map(([id, Hq]) => [id, err(Hq, ax[j], ay[j], bx[j], by[j])]).sort((a, b) => a[1] - b[1]);
      if (nage[j] < L && errs.length) {
        if (errs.length === 1 || errs[1][1] - errs[0][1] > thr) label[j] = errs[0][0];
        else if (!own) label[j] = -1;
      }
      const mine = step.get(label[j]) || H;
      fits[j] = err(mine, ax[j], ay[j], bx[j], by[j]) < 4 * thr ? 1 : 0;
    }
    return { by: step, main, label, fits };
  }

  // the id most of these corners had before (and not taken), or a new one
  function inherit(mem, lab, taken) {
    const votes = new Map();
    for (const j of mem) if (lab[j] >= 0) votes.set(lab[j], (votes.get(lab[j]) || 0) + 1);
    let id = -1;
    let top = 0;
    for (const [v, c] of votes) {
      if (!taken.has(v) && c > top && c >= 0.3 * mem.length) {
        id = v;
        top = c;
      }
    }
    return id >= 0 ? id : nextPlane++;
  }

  // RANSAC homography over long-baseline correspondences; `seeds` are
  // corner sets (surfaces already followed) whose own fit is tried first.
  function ransacLong(sx, sy, ex, ey, idx, thr, seeds = []) {
    const m = idx.length;
    const count = (Hm) => {
      const out = [];
      for (const j of idx) {
        const ww = Hm[6] * sx[j] + Hm[7] * sy[j] + Hm[8];
        const dx = (Hm[0] * sx[j] + Hm[1] * sy[j] + Hm[2]) / ww - ex[j];
        const dy = (Hm[3] * sx[j] + Hm[4] * sy[j] + Hm[5]) / ww - ey[j];
        if (dx * dx + dy * dy < thr) out.push(j);
      }
      return out;
    };
    let best = null;
    let bestIn = [];
    const needed = (c) => Math.ceil(Math.log(0.005) / Math.log(Math.max(1e-9, 1 - (c / m) ** 4)));
    let iters = opt.ransacIters;
    for (const sd of seeds) {
      const Hm = fitH(sx, sy, ex, ey, sd);
      if (!Hm) continue;
      const inl = count(Hm);
      if (inl.length > bestIn.length) {
        best = Hm;
        bestIn = inl;
        iters = Math.min(opt.ransacIters, needed(inl.length));
      }
    }
    const s = [0, 0, 0, 0];
    for (let it = 0; it < iters; it++) {
      for (let q = 0; q < 4; q++) {
        let i;
        let dup;
        do {
          i = idx[Math.floor(random() * m)];
          dup = false;
          for (let r = 0; r < q; r++) if (s[r] === i) dup = true;
        } while (dup);
        s[q] = i;
      }
      const Hm = fitH(sx, sy, ex, ey, s);
      if (!Hm) continue;
      const inl = count(Hm);
      if (inl.length > bestIn.length) {
        best = Hm;
        bestIn = inl;
        iters = Math.min(opt.ransacIters, needed(inl.length));
      }
    }
    if (!best || bestIn.length < 4) return null;
    const F = fitH(sx, sy, ex, ey, bestIn);
    if (F) {
      best = F;
      bestIn = count(F);
    }
    return { H: best, inliers: bestIn };
  }

  /**
   * Motion from frame k0 to frame k1 (k0 ≤ k1), or null if unknown. With a
   * surface id, that surface's motion wherever it was found (the dominant
   * one in the other steps).
   */
  function chain(k0, k1 = k, surface = null) {
    if (k0 > k1 || k1 > k || k1 - k0 >= opt.history) return null;
    let H = IDENTITY;
    for (let j = k0 + 1; j <= k1; j++) {
      const s = steps[j % opt.history];
      if (!s) return null;
      H = mulH((surface !== null && s.by.get(surface)) || s.H, H);
    }
    return H;
  }

  /**
   * Which surface the corners inside a polygon (level-0 px) belong to:
   * { id, share, n } for the most common one, or null without corners.
   */
  function surfaceIn(poly) {
    const count = new Map();
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (pl[i] < 0 || !inPoly(poly, px[i], py[i])) continue;
      count.set(pl[i], (count.get(pl[i]) || 0) + 1);
      total++;
    }
    if (!total) return null;
    let id = -1;
    let c = 0;
    for (const [v, q] of count) {
      if (q > c) {
        id = v;
        c = q;
      }
    }
    return { id, share: c / total, n: total };
  }

  /** The current surfaces: id, corner count and convex hull (level-0 px). */
  function surfaces() {
    const pts = new Map();
    for (let i = 0; i < n; i++) {
      if (pl[i] < 0) continue;
      if (!pts.has(pl[i])) pts.set(pl[i], []);
      pts.get(pl[i]).push([px[i], py[i]]);
    }
    return [...pts].map(([id, p]) => ({ id, n: p.length, main: id === mainPlane, hull: hull(p) }));
  }

  function reset() {
    prev = null;
    dims = '';
    last = null;
    n = 0;
    px = new Float32Array(0);
    py = new Float32Array(0);
    pl = new Int16Array(0);
    age = new Uint16Array(0);
    strikes = new Uint8Array(0);
    hx = new Float32Array(0);
    hy = new Float32Array(0);
    steps.fill(null);
    planes.clear();
    mainPlane = -1;
  }

  return {
    push,
    chain,
    surfaceIn,
    surfaces,
    reset,
    get frame() {
      return k;
    },
    /** corners being followed (level-0 px), for the debug view */
    get points() {
      return { x: px, y: py, surface: pl, n };
    },
    get stats() {
      return stats;
    },
    options: opt,
  };
}
