import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector, angleDiff, TYPE } from '../src/detect/detector.js';
import * as S from './synth.mjs';

const W = 192;
const H = 416; // portrait phone frame at analysis resolution

function run(f, opts) {
  const det = createDetector();
  const rgba = S.render(W, H, f, opts);
  return det.analyze(rgba, W, H);
}

const area = (r) => r.w * r.h;
const biggest = (res, type) =>
  res.regions.filter((r) => !type || r.type === type).sort((a, b) => area(b) - area(a))[0];
const coverage = (res, type) =>
  res.regions.filter((r) => r.type === type).reduce((s, r) => s + area(r), 0) / (W * H);

function describe(res) {
  return res.regions
    .map((r) => `${r.type}@L${r.level} n=${r.cells} p=${r.period.toFixed(1)} a=${r.angle.toFixed(0)}` +
      (r.count ? ` ×${r.count} ev=${r.evenness.toFixed(2)}` : '') +
      (r.ratio ? ` ratio=${r.ratio.toFixed(2)}` : '') + ` s=${r.score.toFixed(2)}`)
    .join('\n  ');
}

for (const [period, angle] of [[8, 30], [5, 90], [6, 0], [10, 135], [4, 60]]) {
  test(`stripes p=${period} θ=${angle}° → STRIPE`, () => {
    const res = run(S.stripes(period, angle));
    const r = biggest(res, TYPE.STRIPE);
    assert.ok(r, `no stripe region\n  ${describe(res)}`);
    assert.ok(coverage(res, TYPE.STRIPE) > 0.6, `low coverage\n  ${describe(res)}`);
    assert.ok(Math.abs(r.period - period) / period < 0.08, `period ${r.period}`);
    assert.ok(angleDiff(r.angle, angle) < 4, `angle ${r.angle}`);
    assert.equal(res.regions.filter((x) => x.type !== TYPE.STRIPE).length, 0, describe(res));
  });
}

test('coarse stripes p=20 → STRIPE at a coarse level', () => {
  const res = run(S.stripes(20, 10));
  const r = biggest(res, TYPE.STRIPE);
  assert.ok(r, describe(res));
  assert.ok(r.level >= 1, `level ${r.level}`);
  assert.ok(Math.abs(r.period - 20) < 2, `period ${r.period}`);
});

test('very coarse stripes p=40 (5 across the screen) → STRIPE', () => {
  const res = run(S.stripes(40, 75));
  const r = biggest(res, TYPE.STRIPE);
  assert.ok(r, describe(res));
  assert.ok(Math.abs(r.period - 40) / 40 < 0.1, `period ${r.period}`);
  assert.ok(angleDiff(r.angle, 75) < 6, `angle ${r.angle}`);
});

test('large dots p=34 → DOTS', () => {
  const res = run(S.dots(34, 9));
  const r = biggest(res, TYPE.DOTS);
  assert.ok(r, describe(res));
  assert.ok(Math.abs(r.period - 34) / 34 < 0.1, `period ${r.period}`);
});

test('grid 9×12 (3:4) → GRID ratio ≈ 4/3', () => {
  const res = run(S.grid(9, 12, 1.6, 0));
  const r = biggest(res, TYPE.GRID);
  assert.ok(r, describe(res));
  assert.ok(coverage(res, TYPE.GRID) > 0.5, describe(res));
  assert.ok(Math.abs(r.ratio - 4 / 3) < 0.1, `ratio ${r.ratio}`);
});

test('rotated grid 8×8 → GRID', () => {
  const res = run(S.grid(8, 8, 1.4, 20));
  const r = biggest(res, TYPE.GRID);
  assert.ok(r, describe(res));
  assert.ok(Math.abs(r.ratio - 1) < 0.1, `ratio ${r.ratio}`);
});

test('square dot lattice → DOTS', () => {
  const res = run(S.dots(8, 2.2));
  assert.ok(coverage(res, TYPE.DOTS) > 0.5, describe(res));
});

test('hex dot lattice → DOTS', () => {
  const res = run(S.dots(9, 2.5, true, 10));
  assert.ok(coverage(res, TYPE.DOTS) > 0.5, describe(res));
});

test('concentric rings → CONCENTRIC near the true centre', () => {
  const res = run(S.rings(96, 210, 7));
  const r = biggest(res, TYPE.CONCENTRIC);
  assert.ok(r, describe(res));
  assert.ok(Math.hypot(r.center.x - 96, r.center.y - 210) < 20, `centre ${JSON.stringify(r.center)}`);
});

// rings seen at an angle are ellipses; a stripe field next to them joins
// the stripe cells' group and must not pull the centre away
for (const [p, k] of [[7, 0.65], [6, 0.8], [9, 0.6], [8, 1]]) {
  test(`rings in perspective (axis ratio ${k}, p=${p}) beside a stripe field → CONCENTRIC`, () => {
    const ell = (x, y) => {
      const r = Math.hypot(x - 96, (y - 180) / k);
      return r < 88 && Math.floor(r / p) % 2 === 0;
    };
    const field = (x, y) => y > 300 && y < 400 && Math.floor((x + y * 0.3) / 6) % 2 === 0;
    const res = run((x, y) => ell(x, y) || field(x, y));
    const r = biggest(res, TYPE.CONCENTRIC);
    assert.ok(r, describe(res));
    assert.ok(Math.hypot(r.center.x - 96, r.center.y - 180) < 12, `centre ${JSON.stringify(r.center)}`);
    assert.ok(res.regions.some((q) => q.type === TYPE.STRIPE && q.cy > 300), 'the stripe field stays a STRIPE');
  });
}

test('radial rays → RADIAL', () => {
  const res = run(S.rays(96, 210, 64));
  const r = biggest(res, TYPE.RADIAL);
  assert.ok(r, describe(res));
  assert.ok(Math.hypot(r.center.x - 96, r.center.y - 210) < 24, `centre ${JSON.stringify(r.center)}`);
});

// Rings from every pixel's orientation (centers.js): lobed, faint tree
// rings with uneven widths make no clean stripe in a cell, so the cells
// alone miss them — also with the centre off the frame. A single soft blob
// and straight stripes in a box must not read as rings or rays.
for (const [cx, cy, p, seed] of [[96, 200, 9, 5], [96, 220, 12, 9], [-60, 190, 10, 3]]) {
  test(`lobed, faint tree rings (centre ${cx},${cy}, p≈${p}) → CONCENTRIC`, () => {
    const res = run(S.treeRings(cx, cy, p, seed, 0.15, 0.75, 0.15), { ss: 2 });
    assert.ok(res.regions.some((r) => r.type === TYPE.CONCENTRIC), describe(res));
  });
}
test('a soft blob, stripes in a box → no rings or rays', () => {
  for (const f of [S.softBlob(96, 200, 60, 6), S.softBlob(96, 200, 90, 12), S.stripesInRect(30, 20, 80, 172, 330), S.stripesInRect(44, 20, 80, 172, 330)]) {
    const res = run(f, { ss: 2 });
    assert.ok(!res.regions.some((r) => r.family === 'radial'), describe(res));
  }
});

// Lattices of things (rows.js 6.): bricks and tiles that each have their
// own colour give the spectral detector stripes at best; each brick still
// looks like the next. A plank board is stripes only: along a plank the
// look goes on, so it must not become a lattice.
const latticeCover = (res) => res.regions.filter((r) => r.family === 'lattice').reduce((s, r) => s + area(r), 0) / (W * H);
for (const [bw, bh] of [[30, 12], [40, 16]]) {
  test(`running bond bricks ${bw}×${bh}, each its own colour → a lattice`, () => {
    const res = run(S.brickBond(bw, bh, W, H), { ss: 2 });
    assert.ok(latticeCover(res) > 0.4, describe(res));
  });
}
for (const p of [26, 34]) {
  test(`tiles p=${p}, each a different grey → a lattice`, () => {
    const res = run(S.unevenTiles(p, W, H), { ss: 2 });
    assert.ok(latticeCover(res) > 0.5, describe(res));
  });
}
test('chain-link, thin wires over an uneven background → a lattice', () => {
  const res = run(S.chainLink(16), { ss: 2 });
  assert.ok(latticeCover(res) > 0.5, describe(res));
});
for (const p of [14, 20]) {
  test(`plank board p=${p} → STRIPE, not a lattice`, () => {
    const res = run(S.plankBoard(p), { ss: 2 });
    assert.ok(coverage(res, TYPE.STRIPE) > 0.3, describe(res));
    assert.equal(latticeCover(res), 0, describe(res));
  });
}

test('non-repeating texture → nothing', () => {
  const res = run(S.valueNoise(5), { noise: 0.03 });
  assert.equal(res.regions.length, 0, describe(res));
});

test('non-repeating textures at many scales → nothing', () => {
  const det = createDetector();
  let hits = 0;
  for (const scale of [2, 4, 7, 12]) {
    for (const seed of [3, 11, 29]) {
      const rgba = S.render(W, H, S.valueNoise(scale, seed), { noise: 0.03, ss: 2 });
      if (det.analyze(rgba, W, H).regions.length) hits++;
    }
  }
  assert.equal(hits, 0);
});

test('thin lines (15% duty) → STRIPE at the true period, not a harmonic', () => {
  const res = run(S.stripes(9, 45, 0.15));
  const r = biggest(res, TYPE.STRIPE);
  assert.ok(r, describe(res));
  assert.ok(Math.abs(r.period - 9) < 0.6, `period ${r.period}`);
});

test('period hand-over between levels is continuous', () => {
  for (const p of [9, 10, 11, 12, 13, 14]) {
    const r = biggest(run(S.stripes(p, 20), { ss: 2 }), TYPE.STRIPE);
    assert.ok(r && Math.abs(r.period - p) / p < 0.06, `p=${p} → ${r && r.period}`);
  }
});

test('single hard edge → nothing', () => {
  const res = run(S.edge(25, 150));
  assert.equal(res.regions.length, 0, describe(res));
});

test('two parallel lines are not a repetition', () => {
  // one pair (a frame line next to a rule…) somewhere in the frame
  for (const [d, ang, off] of [[10, 0, 200], [14, 30, 150], [20, 0, 180], [8, 90, 90]]) {
    const t = (ang * Math.PI) / 180;
    const f = (x, y) => {
      const u = x * Math.sin(t) + y * Math.cos(t);
      return Math.abs(u - off) < 1.5 || Math.abs(u - off - d) < 1.5;
    };
    const res = run(f);
    assert.equal(res.regions.length, 0, `d=${d}\n  ${describe(res)}`);
  }
});

test('a paper edge next to a frame line is not a repetition', () => {
  const res = run((x, y) => {
    const u = y % 96;
    return u < 40 || Math.abs(u - 52) < 1.2;
  });
  assert.equal(res.regions.length, 0, describe(res));
});

test('blank paper → nothing', () => {
  const res = run(() => false);
  assert.equal(res.regions.length, 0, describe(res));
});

test('two stripe fields side by side → two STRIPEs, no fake GRID', () => {
  const res = run(S.split(S.stripes(7, 0), S.stripes(7, 60), 96));
  const stripes = res.regions.filter((r) => r.type === TYPE.STRIPE);
  assert.ok(stripes.length >= 2, describe(res));
  assert.equal(res.regions.filter((r) => r.family === 'lattice').length, 0, describe(res));
});

test('a grid patch cut by a stray line stays one GRID, and its rim is not STRIPE', () => {
  const g = S.grid(9, 12, 1.6, 0);
  const f = (x, y) => {
    if (Math.abs(0.35 * x - y + 210) < 4) return true; // thick diagonal line
    return x > 20 && x < 172 && y > 60 && y < 360 ? g(x, y) : false;
  };
  const res = run(f);
  const lattices = res.regions.filter((r) => r.family === 'lattice');
  assert.equal(lattices.length, 1, describe(res));
  assert.equal(res.regions.filter((r) => r.type === TYPE.STRIPE).length, 0, describe(res));
});

test('a small patch of stripes on a busy background is found', () => {
  const bg = S.valueNoise(3, 5);
  const st = S.stripes(6, 35);
  const inPatch = (x, y) => x > 40 && x < 140 && y > 150 && y < 260;
  const res = run((x, y) => (inPatch(x, y) ? st(x, y) : bg(x, y)), { noise: 0.03 });
  const hit = res.regions.find((r) => r.type === TYPE.STRIPE &&
    r.cx > 40 && r.cx < 140 && r.cy > 150 && r.cy < 260);
  assert.ok(hit, describe(res));
  assert.ok(Math.abs(hit.period - 6) < 0.6, `period ${hit.period}`);
  assert.equal(res.regions.filter((r) => !(r.cx > 30 && r.cx < 150 && r.cy > 140 && r.cy < 270)).length, 0,
    `regions off the patch\n  ${describe(res)}`);
});

test('faint stripes mixed into a strong texture are found across the frame', () => {
  // a camera view: shading and clutter in the same pixels as the pattern
  const bg = S.valueNoise(3, 4);
  const st = S.stripes(7, 25);
  const f = (x, y) => {
    const v = 0.15 + 0.7 * bg(x, y)[0] - (st(x, y) ? 0.2 : 0);
    return [v, v, v];
  };
  const res = run(f, { noise: 0.03 });
  assert.ok(coverage(res, TYPE.STRIPE) > 0.4, `coverage ${coverage(res, TYPE.STRIPE).toFixed(2)}\n  ${describe(res)}`);
  assert.equal(res.regions.filter((r) => r.type !== TYPE.STRIPE).length, 0, describe(res));
});

test('stripes in perspective (period drifting 6 → 9 px) → one STRIPE', () => {
  const a = Math.log(1.5) / H;
  const p0 = 6;
  const f = (x, y) => {
    const phase = (1 - Math.exp(-a * y)) / (a * p0) + x * 0.15 / p0;
    return phase - Math.floor(phase) < 0.5;
  };
  const res = run(f);
  assert.ok(coverage(res, TYPE.STRIPE) > 0.5, describe(res));
});

test('a wavy wire lattice (like a fence) → lattice', () => {
  // two families of thin wavy lines at ±60°, spacing 22 px
  const fam = (ang) => {
    const t = (ang * Math.PI) / 180;
    return (x, y) => {
      const u = x * Math.cos(t) + y * Math.sin(t);
      const v = -x * Math.sin(t) + y * Math.cos(t);
      const w = u + 1.8 * Math.sin(v / 9);
      return Math.abs(w - 22 * Math.round(w / 22)) < 1.6;
    };
  };
  const a = fam(60);
  const b = fam(-60);
  const res = run((x, y) => a(x, y) || b(x, y));
  const r = res.regions.find((x) => x.family === 'lattice');
  assert.ok(r, describe(res));
});

// a cup-like thing (body, label band, handle), size s around (cx, cy)
const cup = (cx, cy, s) => (x, y) => {
  const u = (x - cx) / s;
  const v = (y - cy) / s;
  const body = Math.abs(u) < 0.32 && v > -0.4 && v < 0.45;
  const band = body && v > 0 && v < 0.15;
  const handle = Math.abs(Math.hypot(u - 0.42, v) - 0.16) < 0.05 && u > 0.32;
  return (body && !band) || handle;
};
const any = (fs) => (x, y) => fs.some((f) => f(x, y));
const rows = (res) => res.regions.filter((r) => r.type === TYPE.ROW);

test('five cups in a row → one ROW ×5', () => {
  const res = run(any([0, 1, 2, 3, 4].map((i) => cup(30 + i * 34, 200, 28))));
  const r = rows(res);
  assert.equal(r.length, 1, describe(res));
  assert.equal(r[0].count, 5);
  assert.ok(r[0].evenness < 0.15, `evenness ${r[0].evenness}`);
});

test('unevenly spaced cups → ROW ×4 that knows it is uneven', () => {
  const res = run(any([20, 60, 120, 165].map((x, i) => cup(x, 150 + i * 8, 30))));
  const r = rows(res);
  assert.equal(r.length, 1, describe(res));
  assert.equal(r[0].count, 4);
  assert.ok(r[0].evenness > 0.1, `evenness ${r[0].evenness}`);
  const ts = r[0].members.map((m) => m.t);
  assert.ok(ts[2] - ts[1] > 1.2 * (ts[1] - ts[0]), `positions ${ts.map((t) => t.toFixed(0))}`);
});

test('two shelves of cups → two ROWs', () => {
  const res = run(any([0, 1, 2, 3, 4].flatMap((i) => [cup(30 + i * 34, 120, 28), cup(30 + i * 34, 300, 28)])));
  const r = rows(res);
  assert.equal(r.length, 2, describe(res));
  assert.ok(r.every((x) => x.count === 5), describe(res));
});

test('one or two cups are not a row', () => {
  assert.equal(rows(run(cup(96, 200, 40))).length, 0);
  assert.equal(rows(run(any([cup(60, 200, 34), cup(140, 200, 34)]))).length, 0);
});

test('stripes are STRIPE, not also a ROW', () => {
  const res = run(S.stripes(14, 0, 0.35));
  assert.equal(rows(res).length, 0, describe(res));
});

test('colour is picked from the ink', () => {
  const red = [0.84, 0.15, 0.17];
  const res = run(S.stripes(8, 45), { ink: red });
  const r = biggest(res, TYPE.STRIPE);
  assert.ok(r, describe(res));
  assert.ok(r.sat > 0.4, `sat ${r.sat}`);
  assert.ok(r.hue < 15 || r.hue > 345, `hue ${r.hue}`);
});

// the time depends on the machine: GitHub's are slower than a desktop, so
// there (CI) it is not a test
test('analysis is fast enough for ~10 Hz', { skip: process.env.CI ? 'timing depends on the machine' : false }, () => {
  // as in the app's worker: the row search alternates over two frames
  const det = createDetector({ rowSplit: 2 });
  const rgba = S.render(W, H, S.grid(9, 12), { ss: 1 });
  for (let i = 0; i < 6; i++) det.analyze(rgba, W, H); // JIT warm-up
  // mean of 10 (both halves of the row search), best of 3 runs: other test
  // files run in parallel and steal CPU
  let ms = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) det.analyze(rgba, W, H);
    ms = Math.min(ms, (performance.now() - t0) / 10);
  }
  // a worst case (every cell full of pattern) on a desktop CPU
  assert.ok(ms < 80, `${ms.toFixed(1)} ms per frame`);
});

test('a row touching the frame edge still has a finite contrast', () => {
  // bottles whose tops are cut off by the top edge
  const bottle = (cx) => (x, y) => Math.abs(x - cx) < 9 && y < 40;
  const f = (x, y) => [30, 70, 110, 150].some((cx) => bottle(cx)(x, y));
  const res = run(f);
  for (const r of res.regions) assert.ok(Number.isFinite(r.contrast), `${r.type} contrast ${r.contrast}`);
});
