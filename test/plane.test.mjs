import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/detector.js';
import { applyH, invH, mulH } from '../src/homography.js';
import { simpleRatio } from '../src/mapping.js';
import * as S from './synth.mjs';

const W = 192;
const H = 416;

const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A camera (focal × short side) looking at the plane's origin, turned away
// from it by `slant` degrees towards azimuth `az`. Plane units ≈ image px
// at the centre. Returns the plane → image homography and the plane's
// normal in the camera frame.
function camera(slant, az, focal = 1.6) {
  const f = focal * W;
  const t = (slant * Math.PI) / 180;
  const a = (az * Math.PI) / 180;
  const D = 1000;
  const C = [D * Math.sin(t) * Math.cos(a), D * Math.sin(t) * Math.sin(a), -D * Math.cos(t)];
  const z = norm(C.map((v) => -v));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const R = [x, y, z];
  const tt = R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2]));
  const s = D / f;
  const K = [f, 0, W / 2, 0, f, H / 2, 0, 0, 1];
  return {
    H: mulH(K, [R[0][0] * s, R[0][1] * s, tt[0], R[1][0] * s, R[1][1] * s, tt[1], R[2][0] * s, R[2][1] * s, tt[2]]),
    n: [x[2], y[2], z[2]],
  };
}

function look(det, pattern, cam) {
  const inv = invH(cam.H);
  const f = (x, y) => pattern(...applyH(inv, x, y));
  return det.analyze(S.render(W, H, f, { ss: 2 }), W, H);
}

const biggest = (res, family) => res.regions.filter((r) => r.family === family).sort((a, b) => b.w * b.h - a.w * a.h)[0];
const angleBetween = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const is34 = (r) => {
  const [a, b] = simpleRatio(Math.max(1, r));
  return a === 3 && b === 4;
};

test('plane: a frontal pattern stays frontal (no tilt, plain box)', () => {
  const det = createDetector();
  for (const pattern of [S.stripes(8, 30), S.grid(9, 12, 2)]) {
    const res = look(det, pattern, camera(0, 0));
    for (const r of res.regions) assert.equal(r.plane, undefined, `${r.type} got a tilt of ${r.plane && r.plane.slant}°`);
  }
});

for (const [slant, az] of [[30, 0], [45, 90], [55, 200]]) {
  test(`plane: stripes turned ${slant}° (towards ${az}°) → normal within 3°, outline is a trapezoid`, () => {
    const cam = camera(slant, az);
    const r = biggest(look(createDetector(), S.stripes(8, 30), cam), 'line');
    assert.ok(r && r.plane, 'no tilt found');
    assert.ok(angleBetween(r.plane.normal, cam.n) < 3, `normal off by ${angleBetween(r.plane.normal, cam.n).toFixed(1)}°`);
    const [a, b, c, d] = r.quad;
    const top = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bottom = Math.hypot(c[0] - d[0], c[1] - d[1]);
    const left = Math.hypot(d[0] - a[0], d[1] - a[1]);
    const right = Math.hypot(c[0] - b[0], c[1] - b[1]);
    assert.ok(Math.max(top / bottom, bottom / top, left / right, right / left) > 1.05, 'outline is still a rectangle');
  });
}

test('plane: a 3 : 4 grid seen at 45° is measured 3 : 4 (head-on), though it does not look it', () => {
  const det = createDetector({ focal: 1.6 });
  const r = biggest(look(det, S.grid(9, 12, 2), camera(45, 0)), 'lattice');
  assert.ok(r && r.plane, 'no tilt found');
  assert.ok(!is34(r.ratioSeen), `as seen ${r.ratioSeen.toFixed(3)} already rounds to 3:4`);
  assert.ok(Math.abs(r.ratio / (4 / 3) - 1) < 0.03, `head-on ratio ${r.ratio.toFixed(3)}`);
  assert.ok(is34(r.ratio));
});

test('plane: the focal length is learnt from tilted grids', () => {
  const det = createDetector();
  const grid = S.grid(9, 12, 2);
  for (const [slant, az] of [[35, 0], [45, 90], [40, 200], [50, 300], [35, 120], [45, 30]]) look(det, grid, camera(slant, az, 1.1));
  const res = look(det, grid, camera(45, 60, 1.1));
  assert.ok(Math.abs(res.focal / 1.1 - 1) < 0.05, `learnt ${res.focal.toFixed(2)}, true 1.1`);
  const r = biggest(res, 'lattice');
  assert.ok(r && Math.abs(r.ratio / (4 / 3) - 1) < 0.04, `head-on ratio ${r && r.ratio.toFixed(3)}`);
});
