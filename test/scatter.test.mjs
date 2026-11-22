import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceField, scatterPieces } from '../tools/poster-editor/scatter.js';
import { pieceCircle, debrisPieces } from '../src/poster/poster.js';

test('distance field: the distance to the nearest taken cell', () => {
  const w = 23;
  const h = 17;
  let s = 7;
  const taken = new Uint8Array(w * h).map(() => ((s = (s * 1103515245 + 12345) >>> 0) % 13 === 0 ? 1 : 0));
  const d = distanceField(taken, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (taken[j * w + i]) best = Math.min(best, Math.hypot(i - x, j - y));
      assert.ok(Math.abs(d[y * w + x] - best) < 1e-6, `${x},${y}`);
    }
  }
});

// a 1000 × 800 design with a taken block in the middle, at half resolution
function field() {
  const scale = 0.5;
  const w = 500;
  const h = 400;
  const taken = new Uint8Array(w * h);
  for (let y = 150; y < 250; y++) for (let x = 200; x < 300; x++) taken[y * w + x] = 1; // design 400–600 × 300–500
  return { dist: distanceField(taken, w, h), w, h, scale };
}
const AREA = { x0: 50, y0: 50, x1: 950, y1: 750 };
const OPT = { count: 20, rMin: 15, rMax: 40, gap: 24, colors: ['red', 'blue'], seed: 3 };

test('scattered pieces keep the gap from what is taken, from each other, and stay in the area', () => {
  const { pieces, placed } = scatterPieces(field(), AREA, OPT);
  assert.equal(placed, 20);
  const cs = pieces.map(pieceCircle);
  cs.forEach((c, i) => {
    assert.ok(c.x - c.R >= AREA.x0 - 1 && c.x + c.R <= AREA.x1 + 1 && c.y - c.R >= AREA.y0 - 1 && c.y + c.R <= AREA.y1 + 1, `piece ${i} in the area`);
    // distance from the circle to the block 400–600 × 300–500
    const dx = Math.max(400 - c.x, 0, c.x - 600);
    const dy = Math.max(300 - c.y, 0, c.y - 500);
    assert.ok(Math.hypot(dx, dy) - c.R >= OPT.gap - 3, `piece ${i} clear of the block`);
    for (let j = 0; j < i; j++) assert.ok(Math.hypot(c.x - cs[j].x, c.y - cs[j].y) - c.R - cs[j].R >= OPT.gap - 2, `pieces ${j} and ${i} apart`);
  });
  assert.deepEqual([...new Set(pieces.map((p) => p.shape))].sort(), ['bar', 'disc', 'tri']);
  // triangles and bars at all sorts of angles, discs need none
  const tri = pieces.filter((p) => p.shape === 'tri').map((p) => p.rotation);
  assert.ok(new Set(tri).size === tri.length && tri.every((a) => a >= 0 && a <= 360) && Math.max(...tri) > 180);
  assert.ok(pieces.filter((p) => p.shape === 'bar').every((p) => p.rotation >= 0 && p.rotation <= 180));
  assert.ok(pieces.filter((p) => p.shape === 'disc').every((p) => p.rotation === 0));
});

test('the same seed scatters the same way, another seed differently', () => {
  const f = field();
  const a = scatterPieces(f, AREA, OPT).pieces;
  assert.deepEqual(scatterPieces(f, AREA, OPT).pieces, a);
  assert.notDeepEqual(scatterPieces(f, AREA, { ...OPT, seed: 4 }).pieces, a);
});

test('kept pieces count towards the number and are avoided', () => {
  const keep = [{ shape: 'disc', x: 200, y: 200, r: 60, rotation: 0, color: 'red', pin: true }];
  const { pieces, wanted } = scatterPieces(field(), AREA, OPT, keep);
  assert.equal(wanted, 19);
  for (const p of pieces) {
    const c = pieceCircle(p);
    assert.ok(Math.hypot(c.x - 200, c.y - 200) - c.R - 60 >= OPT.gap - 2);
  }
});

test('no room: fewer pieces, not overlapping ones', () => {
  const { placed, wanted } = scatterPieces(field(), { x0: 420, y0: 320, x1: 580, y1: 480 }, OPT);
  assert.equal(wanted, 20);
  assert.equal(placed, 0);
});

test('a seeded debris element and its pieces: triangle, disc, bar in turn', () => {
  const el = { x: 0, y: 0, w: 500, h: 500, seed: 5, count: 7, rMin: 10, rMax: 20, colors: ['red', 'ink'] };
  const ps = debrisPieces(el);
  assert.deepEqual(ps.map((p) => p.shape), ['tri', 'disc', 'bar', 'tri', 'disc', 'bar', 'tri']);
  assert.deepEqual(ps.map((p) => p.color), ['red', 'ink', 'red', 'ink', 'red', 'ink', 'red']);
  assert.ok(ps.every((p) => p.r >= 10 && p.r <= 20 && p.x >= 0 && p.x <= 500));
  assert.ok(ps.filter((p) => p.shape !== 'bar').every((p) => p.rotation === 0));
});

test("a triangle's circle holds its three corners", () => {
  for (const rotation of [0, 30, 90, 200]) {
    const p = { shape: 'tri', x: 100, y: 100, r: 20, rotation };
    const c = pieceCircle(p);
    const a = (rotation * Math.PI) / 180;
    for (const [u, v] of [[0, -20], [20, 20], [-20, 20]]) {
      const x = 100 + u * Math.cos(a) - v * Math.sin(a);
      const y = 100 + u * Math.sin(a) + v * Math.cos(a);
      assert.ok(Math.hypot(x - c.x, y - c.y) <= c.R + 1e-9);
    }
  }
});
