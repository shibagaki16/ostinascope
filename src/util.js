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
