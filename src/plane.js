// Ostinascope — which way the surface under a pattern faces, from how the
// pattern is distorted (shape from texture).
//
// A pattern printed on a plane and seen in perspective has the phase
//     φ(x) = p·x / (c·x + 1)        (x: image px around the region's centre)
// for each family of lines: its spacing shrinks towards the far side and its
// lines converge. c·x + 1 = 0 is the plane's vanishing line — the same for
// every family of lines on that plane. The detector measures, per cell, the
// local frequency ∇φ (one vector for stripes, two for a lattice); fitting
// this model to them gives the vanishing line, and with the camera's focal
// length the plane's normal. A statistical test keeps a frontal surface
// frontal: the tilt is only believed when it explains the cells clearly
// better than a constant frequency does.
//
// Pure module (no DOM).

import { applyH, invH, mulH } from './homography.js';

export const PLANE_DEFAULTS = Object.freeze({
  minCells: 4, // cells a region needs before its tilt is estimated
  freqNoise: 0.04, // relative error of one cell's frequency (for the test)
  prior: 0.5, // spread of the vanishing-line term over the region (prior)
  minF: 8, // F statistic the tilted model must reach over the flat one
  minSlant: 9, // degrees: below this a plane is taken as frontal (a few degrees of noise)
  maxSlant: 72,
  minRatioCells: 6, // a lattice's ratio is measured head-on only with this many cells
  minCorner: 40, // degrees: an outline with a sharper corner is not believed
  maxAreaChange: 1.8, // … nor one this much larger or smaller than the box
});

/** Interior angles (deg) of a quad, and whether it is convex. */
export function quadShape(q) {
  const angles = [];
  let sign = 0;
  let convex = true;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const a = q[(i + 3) % 4];
    const b = q[(i + 1) % 4];
    const ux = a[0] - p[0];
    const uy = a[1] - p[1];
    const vx = b[0] - p[0];
    const vy = b[1] - p[1];
    const cr = ux * vy - uy * vx;
    if (sign && Math.sign(cr) !== sign) convex = false;
    sign = sign || Math.sign(cr);
    angles.push((Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))))) * 180) / Math.PI);
  }
  let area = 0;
  for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  return { angles, convex, area: Math.abs(area) / 2 };
}

/** Frequency vector (cycles/px) of lines with spacing p and line angle a°. */
export function frequencyOf(p, a) {
  const t = (a * Math.PI) / 180;
  return [Math.sin(t) / p, Math.cos(t) / p];
}

// ∇φ at (x, y) for one family: (p w − (p·x) c) / w², w = c·x + 1
function model(px, py, cx, cy, x, y) {
  const w = cx * x + cy * y + 1;
  const d = px * x + py * y;
  return [(px * w - d * cx) / (w * w), (py * w - d * cy) / (w * w)];
}

/**
 * obs: [{ x, y, fx, fy, w, fam }] — positions (px, around the region's
 * centre), frequencies (cycles/px, any sign), weights, family index.
 * Returns { c: [cx, cy], p: [[px, py], …], F, n } or null. c = 0 when the
 * tilt is not significant.
 */
export function fitPerspective(obs, nFam, options = {}) {
  const opt = { ...PLANE_DEFAULTS, ...options };
  if (obs.length < opt.minCells) return null;
  // sign of each frequency: along its family's main axis
  const fams = [];
  for (let j = 0; j < nFam; j++) {
    let a = 0, b = 0, d = 0;
    for (const o of obs) {
      if (o.fam !== j) continue;
      a += o.w * o.fx * o.fx;
      b += o.w * o.fx * o.fy;
      d += o.w * o.fy * o.fy;
    }
    const ang = 0.5 * Math.atan2(2 * b, a - d);
    fams.push([Math.cos(ang), Math.sin(ang)]);
  }
  const data = obs.map((o) => {
    const [ux, uy] = fams[o.fam];
    const s = o.fx * ux + o.fy * uy >= 0 ? 1 : -1;
    return { ...o, fx: s * o.fx, fy: s * o.fy, mag: Math.hypot(o.fx, o.fy) };
  });
  let R = 0;
  let wsum = 0;
  for (const o of data) {
    R = Math.max(R, Math.hypot(o.x, o.y));
    wsum += o.w;
  }
  R = Math.max(R, 1);
  const wn = data.map((o) => Math.sqrt((o.w * data.length) / wsum));

  // parameters: p (2 per family), then c (2)
  const k = 2 * nFam + 2;
  const residuals = (th, withC) => {
    const cx = withC ? th[k - 2] : 0;
    const cy = withC ? th[k - 1] : 0;
    const out = [];
    data.forEach((o, i) => {
      const [mx, my] = model(th[2 * o.fam], th[2 * o.fam + 1], cx, cy, o.x, o.y);
      const s = wn[i] / (o.mag * opt.freqNoise);
      out.push((mx - o.fx) * s, (my - o.fy) * s);
    });
    if (withC) out.push((cx * R) / opt.prior, (cy * R) / opt.prior);
    return out;
  };
  const sse = (r) => r.reduce((s, v) => s + v * v, 0);

  // Levenberg–Marquardt with a numeric Jacobian (k ≤ 6 parameters)
  function lm(th0, withC) {
    let th = th0.slice();
    const free = withC ? k : k - 2;
    let r = residuals(th, withC);
    let cost = sse(r);
    let lambda = 1e-3;
    for (let it = 0; it < 30; it++) {
      const J = [];
      for (let q = 0; q < free; q++) {
        const h = Math.max(1e-7, Math.abs(th[q]) * 1e-4) * (q >= k - 2 ? 1 / R : 1);
        const t2 = th.slice();
        t2[q] += h;
        const r2 = residuals(t2, withC);
        J.push(r2.map((v, i) => (v - r[i]) / h));
      }
      const A = new Float64Array(free * free);
      const g = new Float64Array(free);
      for (let a = 0; a < free; a++) {
        for (let b = 0; b < free; b++) {
          let s = 0;
          for (let i = 0; i < r.length; i++) s += J[a][i] * J[b][i];
          A[a * free + b] = s;
        }
        let s = 0;
        for (let i = 0; i < r.length; i++) s += J[a][i] * r[i];
        g[a] = -s;
      }
      let improved = false;
      for (let tries = 0; tries < 6 && !improved; tries++) {
        const M = Float64Array.from(A);
        for (let a = 0; a < free; a++) M[a * free + a] *= 1 + lambda;
        const step = solveSym(M, g, free);
        if (!step) {
          lambda *= 10;
          continue;
        }
        const t2 = th.slice();
        for (let a = 0; a < free; a++) t2[a] += step[a];
        const r2 = residuals(t2, withC);
        const c2 = sse(r2);
        if (c2 < cost) {
          const gain = cost - c2;
          th = t2;
          r = r2;
          cost = c2;
          lambda = Math.max(1e-7, lambda / 3);
          improved = true;
          if (gain < 1e-9 * (1 + cost)) return { th, cost };
        } else lambda *= 10;
      }
      if (!improved) break;
    }
    return { th, cost };
  }

  const th0 = new Array(k).fill(0);
  for (let j = 0; j < nFam; j++) {
    let sx = 0, sy = 0, sw = 0;
    data.forEach((o) => {
      if (o.fam !== j) return;
      sx += o.w * o.fx;
      sy += o.w * o.fy;
      sw += o.w;
    });
    if (!(sw > 0)) return null;
    th0[2 * j] = sx / sw;
    th0[2 * j + 1] = sy / sw;
  }
  const flat = lm(th0, false);
  const tilted = lm(flat.th, true);
  const N = 2 * data.length;
  const dof = Math.max(1, N - k);
  // the prior's own terms are not evidence
  const c = [tilted.th[k - 2], tilted.th[k - 1]];
  const sse1 = tilted.cost - ((c[0] * R) / opt.prior) ** 2 - ((c[1] * R) / opt.prior) ** 2;
  const F = (flat.cost - sse1) / 2 / Math.max(1e-9, sse1 / dof);
  const p = [];
  for (let j = 0; j < nFam; j++) p.push([tilted.th[2 * j], tilted.th[2 * j + 1]]);
  if (!(F >= opt.minF)) {
    const pf = [];
    for (let j = 0; j < nFam; j++) pf.push([flat.th[2 * j], flat.th[2 * j + 1]]);
    return { c: [0, 0], p: pf, F, n: data.length, flat: true };
  }
  return { c, p, F, n: data.length, flat: false };
}

// Symmetric positive (semi)definite solve by Gaussian elimination.
function solveSym(M, g, n) {
  const A = Float64Array.from(M);
  const b = Float64Array.from(g);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[piv * n + col])) piv = r;
    if (!(Math.abs(A[piv * n + col]) > 1e-18)) return null;
    for (let q = 0; q < n; q++) [A[col * n + q], A[piv * n + q]] = [A[piv * n + q], A[col * n + q]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r * n + col] / A[col * n + col];
      for (let q = col; q < n; q++) A[r * n + q] -= f * A[col * n + q];
      b[r] -= f * b[col];
    }
  }
  return Array.from(b, (v, i) => v / A[i * n + i]);
}

/**
 * The plane from a vanishing line around (x0, y0): its normal in the
 * camera frame (focal f px, principal point u0, v0), slant (deg, 0 =
 * facing the camera), tilt (deg, image direction in which it recedes), and
 * the homography `rect` that shows it head-on (with `back`, its inverse).
 * The head-on view is the camera turned the least, so a frontal plane
 * stays as it is.
 */
export function planeFromLine(c, x0, y0, f, u0, v0) {
  // homogeneous vanishing line l·(X, Y, 1) = 0 in image px
  const l = [c[0], c[1], 1 - c[0] * x0 - c[1] * y0];
  // n ∝ Kᵀ l
  let n = [f * l[0], f * l[1], u0 * l[0] + v0 * l[1] + l[2]];
  const len = Math.hypot(...n);
  if (!(len > 0)) return null;
  n = n.map((v) => v / len);
  if (n[2] < 0) n = n.map((v) => -v);
  const slant = (Math.acos(Math.min(1, n[2])) * 180) / Math.PI;
  const tilt = (Math.atan2(n[1], n[0]) * 180) / Math.PI;
  // rotation taking n to the optical axis (0, 0, 1): axis n × z
  const ax = [n[1], -n[0], 0];
  const s = Math.hypot(ax[0], ax[1]);
  let Rm;
  if (s < 1e-9) Rm = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  else {
    const kx = ax[0] / s;
    const ky = ax[1] / s;
    const cs = n[2];
    const sn = s;
    const t = 1 - cs;
    Rm = [
      cs + kx * kx * t, kx * ky * t, ky * sn,
      kx * ky * t, cs + ky * ky * t, -kx * sn,
      -ky * sn, kx * sn, cs,
    ];
  }
  const K = [f, 0, u0, 0, f, v0, 0, 0, 1];
  const Ki = [1 / f, 0, -u0 / f, 0, 1 / f, -v0 / f, 0, 0, 1];
  const rect = mulH(K, mulH(Rm, Ki));
  const back = invH(rect);
  if (!back) return null;
  return { normal: n, slant, tilt, rect, back, line: l };
}

/** Jacobian of a homography at (x, y), as [[a, b], [c, d]]. */
export function jacobian(H, x, y, e = 0.5) {
  const [x0, y0] = applyH(H, x - e, y);
  const [x1, y1] = applyH(H, x + e, y);
  const [x2, y2] = applyH(H, x, y - e);
  const [x3, y3] = applyH(H, x, y + e);
  return [[(x1 - x0) / (2 * e), (x2 - x3) / -(2 * e)], [(y1 - y0) / (2 * e), (y2 - y3) / -(2 * e)]];
}

/** A frequency vector seen at (x, y) carried into the head-on view: J⁻ᵀ k. */
export function rectifyFrequency(rect, x, y, k) {
  const [[a, b], [c, d]] = jacobian(rect, x, y);
  const det = a * d - b * c;
  // J⁻ᵀ = (1/det) [[d, −c], [−b, a]]
  return [(d * k[0] - c * k[1]) / det, (-b * k[0] + a * k[1]) / det];
}
