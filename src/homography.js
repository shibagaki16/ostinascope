// Ostinascope — 3×3 homographies (row-major arrays of 9): how a plane seen
// by the camera moves between two frames. Pure module.

export const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function mulH(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    }
  }
  return normH(C);
}

export function invH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return null;
  return normH([
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]);
}

/** Scale so that H[8] = 1 (when it can be). */
export function normH(H) {
  const s = Math.abs(H[8]) > 1e-12 ? H[8] : 1;
  for (let i = 0; i < 9; i++) H[i] /= s;
  return H;
}

/** Re-express a homography in other units: x' = k·x (e.g. px → view units). */
export function scaleH(H, k) {
  return normH([H[0], H[1], H[2] * k, H[3], H[4], H[5] * k, H[6] / k, H[7] / k, H[8]]);
}

/** Local isotropic scale of H around (x, y): √|det J|. */
export function localScale(H, x, y, e = 1) {
  const [x0, y0] = applyH(H, x, y);
  const [x1, y1] = applyH(H, x + e, y);
  const [x2, y2] = applyH(H, x, y + e);
  return Math.sqrt(Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0))) / e;
}

// Gaussian elimination with partial pivoting; A is n×n (row-major), b n.
// Both are overwritten. Returns the solution or null when singular.
export function solve(A, b, n) {
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[piv * n + col])) piv = r;
    const p = A[piv * n + col];
    if (!(Math.abs(p) > 1e-12)) return null;
    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = A[col * n + k];
        A[col * n + k] = A[piv * n + k];
        A[piv * n + k] = t;
      }
      const t = b[col];
      b[col] = b[piv];
      b[piv] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / p;
      if (!f) continue;
      for (let k = col; k < n; k++) A[r * n + k] -= f * A[col * n + k];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

// Hartley normalisation: centre the points, mean distance √2.
function normaliser(xs, ys, idx) {
  let mx = 0, my = 0;
  for (const i of idx) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= idx.length;
  my /= idx.length;
  let d = 0;
  for (const i of idx) d += Math.hypot(xs[i] - mx, ys[i] - my);
  const s = d > 0 ? (Math.SQRT2 * idx.length) / d : 1;
  return { mx, my, s };
}

/**
 * Least-squares homography taking (ax, ay)[i] → (bx, by)[i] for i in idx
 * (≥ 4 points; exactly 4 is the minimal solve). h33 is fixed to 1 in
 * normalised coordinates. Returns null for degenerate configurations.
 */
export function fitH(ax, ay, bx, by, idx) {
  if (idx.length < 4) return null;
  const na = normaliser(ax, ay, idx);
  const nb = normaliser(bx, by, idx);
  const M = new Float64Array(64);
  const v = new Float64Array(8);
  const row = new Float64Array(8);
  const add = (r, rhs) => {
    for (let i = 0; i < 8; i++) {
      if (!r[i]) continue;
      v[i] += r[i] * rhs;
      for (let j = 0; j < 8; j++) M[i * 8 + j] += r[i] * r[j];
    }
  };
  for (const i of idx) {
    const x = (ax[i] - na.mx) * na.s;
    const y = (ay[i] - na.my) * na.s;
    const u = (bx[i] - nb.mx) * nb.s;
    const w = (by[i] - nb.my) * nb.s;
    row.set([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    add(row, u);
    row.set([0, 0, 0, x, y, 1, -w * x, -w * y]);
    add(row, w);
  }
  const h = solve(M, v, 8);
  if (!h || h.some((q) => !Number.isFinite(q))) return null;
  const Hn = [...h, 1];
  // H = Tb⁻¹ · Hn · Ta
  const Ta = [na.s, 0, -na.s * na.mx, 0, na.s, -na.s * na.my, 0, 0, 1];
  const TbInv = [1 / nb.s, 0, nb.mx, 0, 1 / nb.s, nb.my, 0, 0, 1];
  return mulH(TbInv, mulH(Hn, Ta));
}
