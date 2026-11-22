import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/track/tracker.js';

const view = { w: 1, h: 2 };
const det = (cx, cy, extra = {}) => ({
  type: 'STRIPE', family: 'line', cx, cy, w: 0.4, h: 0.4,
  period: 0.04, angle: 30, contrast: 0.8, sharp: 0.5, hue: 0, sat: 0, score: 0.8,
  cells: 4, level: 0, ...extra,
});

test('needs a few frames before a pattern becomes active', () => {
  const tk = createTracker();
  let t = 0;
  const states = [];
  for (let i = 0; i < 5; i++, t += 100) states.push(tk.update([det(0.5, 1)], t, view)[0].state);
  assert.deepEqual(states, ['cand', 'cand', 'cand', 'active', 'active']);
});

test('a one-frame dropout does not fade the loop', () => {
  const tk = createTracker();
  let t = 0;
  for (let i = 0; i < 5; i++, t += 100) tk.update([det(0.5, 1)], t, view);
  tk.update([], t, view);
  t += 100;
  tk.update([], t, view);
  t += 100;
  const [tr] = tk.update([det(0.5, 1)], t, view);
  assert.equal(tr.state, 'active');
  assert.equal(tk.tracks.length, 1);
});

test('a pattern sliding out to the right leaves an edge trace on the right', () => {
  const tk = createTracker();
  let t = 0;
  let x = 0.4;
  for (let i = 0; i < 8; i++, t += 100, x += 0.06) tk.update([det(x, 1)], t, view);
  let tr;
  for (let i = 0; i < 6; i++, t += 100) [tr] = tk.update([], t, view, () => 1000);
  assert.equal(tr.state, 'fading');
  assert.equal(tr.exit.kind, 'edge');
  assert.equal(tr.exit.edge, 'right');
  for (let i = 0; i < 12; i++, t += 100) tk.update([], t, view, () => 1000);
  assert.equal(tk.tracks.length, 0, 'removed after the fade');
});

test('a fading pattern that comes back is resumed, not duplicated', () => {
  const tk = createTracker();
  let t = 0;
  for (let i = 0; i < 5; i++, t += 100) tk.update([det(0.5, 1)], t, view);
  for (let i = 0; i < 6; i++, t += 100) tk.update([], t, view, () => 3000);
  assert.equal(tk.tracks[0].state, 'fading');
  const [tr] = tk.update([det(0.52, 1)], t, view);
  assert.equal(tr.state, 'active');
  assert.equal(tr.resumed, true);
  assert.equal(tk.tracks.length, 1);
});

test('different families never match each other', () => {
  const tk = createTracker();
  let t = 0;
  for (let i = 0; i < 5; i++, t += 100) tk.update([det(0.5, 1)], t, view);
  tk.update([det(0.5, 1, { type: 'GRID', family: 'lattice', ratio: 1.33, period2: 0.03 })], t, view);
  assert.equal(tk.tracks.length, 2);
});

test('a region that splits for a frame does not spawn a second track', () => {
  const tk = createTracker();
  let t = 0;
  for (let i = 0; i < 5; i++, t += 100) tk.update([det(0.5, 1)], t, view);
  tk.update([det(0.45, 0.95, { w: 0.3 }), det(0.6, 1.05, { w: 0.2, h: 0.3 })], t, view);
  assert.equal(tk.tracks.length, 1);
});

test('zooming in (period growing smoothly) keeps the same track', () => {
  const tk = createTracker();
  let t = 0;
  let p = 0.03;
  let id = null;
  for (let i = 0; i < 20; i++, t += 100, p *= 1.08) {
    const [tr] = tk.update([det(0.5, 1, { period: p })], t, view);
    id ??= tr.id;
    assert.equal(tr.id, id);
  }
});

test('the fade length is chosen knowing how the pattern left (edge or in place)', () => {
  const tk = createTracker();
  let t = 0;
  let x = 0.4;
  for (let i = 0; i < 8; i++, t += 100, x += 0.06) tk.update([det(x, 1)], t, view);
  const fade = (tr) => (tr.exit && tr.exit.kind === 'edge' ? 300 : 3000);
  for (let i = 0; i < 4; i++, t += 100) tk.update([], t, view, fade);
  assert.equal(tk.tracks[0].state, 'fading');
  assert.equal(tk.tracks[0].fadeMs, 300, 'gone out through the edge: the short fade');
  for (let i = 0; i < 5; i++, t += 100) tk.update([], t, view, fade);
  assert.equal(tk.tracks.length, 0);
});
