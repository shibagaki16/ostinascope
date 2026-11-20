import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion, greyOf } from '../src/motion.js';
import { applyH, fitH, invH, mulH, scaleH } from '../src/homography.js';
import { createTracker, warpRegion } from '../src/tracker.js';
import * as S from './synth.mjs';

const W = 192;
const H = 416;

// a scene with corners everywhere: thresholded value noise plus a few
// stripes (the stripes alone would give no corners)
const noise = S.valueNoise(9, 3);
const scene = (x, y) => noise(x, y)[0] > 0.55 || (x > 60 && x < 130 && y > 150 && y < 260 && Math.floor(x / 6) % 2 === 0);

function frame(Hm) {
  const inv = invH(Hm);
  const f = (x, y) => {
    const [u, v] = applyH(inv, x, y);
    return scene(u, v);
  };
  return greyOf(S.render(W, H, f, { ss: 2, noise: 0.015 }), W, H);
}

// how far H moves points compared with the truth, worst over the frame (px)
function worst(Hest, Htrue) {
  let e = 0;
  for (let y = 20; y < H - 20; y += 40) {
    for (let x = 20; x < W - 20; x += 40) {
      const [a, b] = applyH(Hest, x, y);
      const [c, d] = applyH(Htrue, x, y);
      e = Math.max(e, Math.hypot(a - c, b - d));
    }
  }
  return e;
}

// small camera motions: shift, turn about the centre, zoom, tilt
const about = (A) => mulH([1, 0, W / 2, 0, 1, H / 2, 0, 0, 1], mulH(A, [1, 0, -W / 2, 0, 1, -H / 2, 0, 0, 1]));
const rot = (deg, s = 1) => {
  const t = (deg * Math.PI) / 180;
  return about([s * Math.cos(t), -s * Math.sin(t), 0, s * Math.sin(t), s * Math.cos(t), 0, 0, 0, 1]);
};
const MOVES = {
  'shift 3,−2 px': [1, 0, 3, 0, 1, -2, 0, 0, 1],
  'shift 9 px (fast)': [1, 0, 9, 0, 1, 4, 0, 0, 1],
  'turn 2°': rot(2),
  'zoom 4 %': rot(0, 1.04),
  'tilt (perspective)': about([1, 0.01, 0, 0.005, 1, 0, 0.0004, 0.0002, 1]),
};

for (const [name, M] of Object.entries(MOVES)) {
  test(`motion: ${name} is recovered to within 0.5 px`, () => {
    const mo = createMotion();
    mo.push(frame([1, 0, 0, 0, 1, 0, 0, 0, 1]), W, H);
    const r = mo.push(frame(M), W, H);
    assert.ok(r.ok, JSON.stringify(mo.stats));
    assert.ok(worst(r.H, M) < 0.5, `error ${worst(r.H, M).toFixed(2)} px, ${JSON.stringify(mo.stats)}`);
  });
}

test('motion: chained over several frames', () => {
  const mo = createMotion();
  let acc = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const step = rot(1.2, 1.01);
  const k0 = mo.push(frame(acc), W, H).k;
  for (let i = 0; i < 5; i++) {
    acc = mulH(step, acc);
    assert.ok(mo.push(frame(acc), W, H).ok);
  }
  const C = mo.chain(k0);
  assert.ok(C);
  assert.ok(worst(C, acc) < 1, `error ${worst(C, acc).toFixed(2)} px`);
});

test('motion: a blank frame gives no motion (not a wrong one)', () => {
  const mo = createMotion();
  const blank = greyOf(S.render(W, H, () => false, { noise: 0.01 }), W, H);
  mo.push(blank, W, H);
  const r = mo.push(blank, W, H);
  assert.equal(r.ok, false);
  assert.equal(mo.chain(r.k - 1), null);
});

test('homography fit: exact from 4 points, least squares from more', () => {
  const Ht = [1.1, 0.05, 3, -0.02, 0.95, -4, 0.0003, -0.0002, 1];
  const ax = [0, 100, 100, 0, 50, 20];
  const ay = [0, 0, 100, 100, 50, 80];
  const bx = [];
  const by = [];
  ax.forEach((x, i) => {
    const [u, v] = applyH(Ht, x, ay[i]);
    bx.push(u);
    by.push(v);
  });
  for (const idx of [[0, 1, 2, 3], [0, 1, 2, 3, 4, 5]]) {
    const F = fitH(ax, ay, bx, by, idx);
    assert.ok(worst(F, Ht) < 1e-6);
  }
  const inv = invH(Ht);
  const [x, y] = applyH(inv, ...applyH(Ht, 30, 40));
  assert.ok(Math.hypot(x - 30, y - 40) < 1e-9);
});

test('tracker: tracks move with the camera, and keep their identity', () => {
  const tr = createTracker();
  const det = { type: 'STRIPE', family: 'line', cx: 0.5, cy: 1, w: 0.3, h: 0.3, period: 0.05, angle: 30,
    score: 1, contrast: 0.5, cells: 9, level: 0, hue: 0, sat: 0 };
  tr.update([{ ...det }], 0, { w: 1, h: 2.17 });
  const shift = scaleH([1, 0, 19.2, 0, 1, 0, 0, 0, 1], 1 / 192); // 0.1 view units to the right
  tr.warp(shift, 33);
  const t = tr.tracks[0];
  assert.ok(Math.abs(t.cx - 0.6) < 1e-9 && Math.abs(t.cy - 1) < 1e-9, `${t.cx}, ${t.cy}`);
  assert.ok(t.vx > 0);
  // the next sighting, already mapped to this frame, matches the same track
  tr.update([warpRegion({ ...det }, shift)], 100, { w: 1, h: 2.17 });
  assert.equal(tr.tracks.length, 1);
  assert.ok(Math.abs(tr.tracks[0].cx - 0.6) < 1e-9);
});

test('tracker: a turn turns the quad and the stripe angle', () => {
  const r = warpRegion({ cx: 1, cy: 1, w: 0.4, h: 0.2, angle: 0, period: 0.1 }, scaleH(rot(10), 1 / 192));
  assert.ok(Math.abs(r.angle - 10) < 0.5 || Math.abs(r.angle - 170) < 0.5, `angle ${r.angle}`);
  assert.ok(Math.abs(r.period - 0.1) < 1e-3);
  assert.ok(Math.abs(r.quad[0][1] - r.quad[1][1]) > 0.05, 'top edge no longer level');
});
