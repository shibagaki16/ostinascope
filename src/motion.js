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
//
// Frames get consecutive indices; the motion between any two recent frames
// can be chained (chain(k0, k1)). Where it cannot be estimated (blank wall,
// heavy blur, a jump) the step is null and callers fall back to no motion.
//
// Pure module (no DOM): runs in the page, a worker or Node.

import { applyH, fitH, IDENTITY, mulH } from './homography.js';

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
  maxScaleStep: 1.25, // per frame: zoom more than this is not believed
});

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  let n = 0;
  let stats = { tracked: 0, inliers: 0, ok: false };

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
    best.sort((a, b) => b[0] - a[0]);
    const add = best.filter((b) => b[0] >= floor).slice(0, room);
    if (!add.length) return;
    const nx = new Float32Array(n + add.length);
    const ny = new Float32Array(n + add.length);
    nx.set(px.subarray(0, n));
    ny.set(py.subarray(0, n));
    add.forEach(([, x, y], i) => {
      nx[n + i] = x;
      ny[n + i] = y;
    });
    px = nx;
    py = ny;
    n += add.length;
  }

  // RANSAC homography on correspondences (ax, ay) → (bx, by), m of them.
  // The predicted motion (last step) and no motion are tried first: while
  // the phone moves steadily they already explain the corners.
  function ransac(ax, ay, bx, by, m, prior) {
    const thr = opt.inlierPx * opt.inlierPx;
    const inside = (H, i) => {
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
      for (let i = 0; i < m; i++) if (inside(H, i)) out.push(i);
      return out;
    };
    let best = null;
    let bestN = 0;
    // enough iterations to have drawn one all-inlier sample (99.5 %)
    const needed = (c) => Math.ceil(Math.log(0.005) / Math.log(Math.max(1e-9, 1 - (c / m) ** 4)));
    let iters = opt.ransacIters;
    for (const H of [prior, IDENTITY]) {
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
          i = Math.floor(random() * m);
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
    if (prev && n) {
      const ax = new Float32Array(n);
      const ay = new Float32Array(n);
      const bx = new Float32Array(n);
      const by = new Float32Array(n);
      let m = 0;
      for (let i = 0; i < n; i++) {
        const [gx, gy] = last ? applyH(last, px[i], py[i]) : [px[i], py[i]];
        const f = track(prev, P, px[i], py[i], gx - px[i], gy - py[i]);
        if (!f) continue;
        const back = track(P, prev, f[0], f[1], px[i] - f[0], py[i] - f[1]);
        if (!back || Math.hypot(back[0] - px[i], back[1] - py[i]) > opt.maxFB) continue;
        ax[m] = px[i];
        ay[m] = py[i];
        bx[m] = f[0];
        by[m] = f[1];
        m++;
      }
      stats = { tracked: m, inliers: 0, ok: false };
      let keep = null;
      if (m >= opt.minInliers) {
        const fit = ransac(ax, ay, bx, by, m, last);
        if (fit && fit.inliers.length >= opt.minInliers && fit.inliers.length >= opt.minInlierShare * m &&
            plausible(fit.H, w, h)) {
          H = fit.H;
          stats = { tracked: m, inliers: fit.inliers.length, ok: true };
          keep = fit.inliers;
        }
      }
      // carry on with the corners that moved with the plane (or, when the
      // motion is unknown, all that could be followed)
      const idx = keep || Array.from({ length: m }, (_, i) => i);
      px = Float32Array.from(idx, (i) => bx[i]);
      py = Float32Array.from(idx, (i) => by[i]);
      n = idx.length;
    } else {
      stats = { tracked: 0, inliers: 0, ok: false };
    }
    steps[k % opt.history] = H;
    last = H;
    prev = P;
    replenish(P);
    return { k, H, ok: !!H };
  }

  /** Motion from frame k0 to frame k1 (k0 ≤ k1), or null if unknown. */
  function chain(k0, k1 = k) {
    if (k0 > k1 || k1 > k || k1 - k0 >= opt.history) return null;
    let H = IDENTITY;
    for (let j = k0 + 1; j <= k1; j++) {
      const s = steps[j % opt.history];
      if (!s) return null;
      H = mulH(s, H);
    }
    return H;
  }

  function reset() {
    prev = null;
    dims = '';
    last = null;
    n = 0;
    px = new Float32Array(0);
    py = new Float32Array(0);
    steps.fill(null);
  }

  return {
    push,
    chain,
    reset,
    get frame() {
      return k;
    },
    /** corners being followed (level-0 px), for the debug view */
    get points() {
      return { x: px, y: py, n };
    },
    get stats() {
      return stats;
    },
    options: opt,
  };
}
