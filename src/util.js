// Ostinascope — small numeric helpers shared by the modules.

export const TO_DEG = 180 / Math.PI;
export const TO_RAD = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mod = (a, n) => ((a % n) + n) % n;
/** ≥ 1: how many times larger the larger of two positive numbers is. */
export const ratio = (a, b) => (a > b ? a / b : b / a);

/** Undirected angle difference between two line orientations (deg). */
export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/** Seeded pseudo-random numbers in [0, 1) (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Area where two boxes { x, y, w, h } overlap. */
export function overlapArea(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}

/** How much of the smaller of two boxes the other covers (0…1). */
export const overlapShare = (a, b) => overlapArea(a, b) / Math.min(a.w * a.h, b.w * b.h);
