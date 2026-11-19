// Synthetic test images, rendered with supersampling so edges look like a
// (slightly soft) camera image rather than aliased pixels.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frac = (v) => v - Math.floor(v);
const INK = [0.08, 0.08, 0.1];
const PAPER = [0.93, 0.91, 0.87];

/** f(x, y) -> true for ink, or an [r,g,b] array. */
export function render(W, H, f, { ss = 3, noise = 0.02, seed = 1, ink = INK, paper = PAPER } = {}) {
  const rnd = mulberry32(seed);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const v = f(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss);
          const c = Array.isArray(v) ? v : v ? ink : paper;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const k = 1 / (ss * ss);
      const n = noise * (rnd() * 2 - 1);
      const j = (y * W + x) * 4;
      rgba[j] = (r * k + n) * 255;
      rgba[j + 1] = (g * k + n) * 255;
      rgba[j + 2] = (b * k + n) * 255;
      rgba[j + 3] = 255;
    }
  }
  return rgba;
}

// angle = line orientation, degrees CCW from +x (screen, y up)
export const stripes = (period, angle, duty = 0.5, ox = 0) => {
  const t = (angle * Math.PI) / 180;
  const nx = Math.sin(t);
  const ny = Math.cos(t);
  return (x, y) => frac((x * nx + y * ny + ox) / period) < duty;
};

export const grid = (px, py, lw = 1.5, angle = 0) => {
  const t = (angle * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return (x, y) => {
    const u = x * c - y * s;
    const v = x * s + y * c;
    return frac(u / px) * px < lw || frac(v / py) * py < lw;
  };
};

export const dots = (spacing, radius, hex = false, angle = 0) => {
  const t = (angle * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const rowH = hex ? (spacing * Math.sqrt(3)) / 2 : spacing;
  return (x, y) => {
    const u = x * c - y * s;
    const v = x * s + y * c;
    const row = Math.floor(v / rowH);
    const off = hex && row % 2 ? spacing / 2 : 0;
    const du = frac((u + off) / spacing) * spacing - spacing / 2;
    const dv = frac(v / rowH) * rowH - rowH / 2;
    return du * du + dv * dv < radius * radius;
  };
};

export const rings = (cx, cy, period, duty = 0.5) => (x, y) =>
  frac(Math.hypot(x - cx, y - cy) / period) < duty;

export const rays = (cx, cy, n) => (x, y) =>
  frac(((Math.atan2(y - cy, x - cx) / (2 * Math.PI)) * n)) < 0.5;

export const edge = (angle, offset) => {
  const t = (angle * Math.PI) / 180;
  return (x, y) => x * Math.sin(t) + y * Math.cos(t) < offset;
};

// Smooth value noise — stands in for a natural, non-repeating texture.
export const valueNoise = (scale, seed = 7) => {
  const rnd = mulberry32(seed);
  const size = 256;
  const g = new Float32Array(size * size).map(() => rnd());
  const at = (i, j) => g[((j & (size - 1)) * size) + (i & (size - 1))];
  return (x, y) => {
    const u = x / scale;
    const v = y / scale;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const sm = (t) => t * t * (3 - 2 * t);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sm(fu);
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sm(fu);
    const val = a + (b - a) * sm(fv);
    return [val, val, val];
  };
};

export const split = (fa, fb, xSplit) => (x, y) => (x < xSplit ? fa(x, y) : fb(x, y));
