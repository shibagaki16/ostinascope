import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/sound/mapping.js';

const base = { hue: 0, sat: 0, sharp: 0.5, contrast: 0.8, angle: 30, cx: 0.5, cy: 1, w: 0.3, h: 0.3, family: 'line' };

test('euclidean rhythm E(3,8) is the tresillo', () => {
  assert.equal(M.euclid(3, 8).map((x) => (x ? 'x' : '.')).join(''), 'x..x..x.');
});

test('grid ratios snap to small integers', () => {
  assert.deepEqual(M.simpleRatio(4 / 3), [3, 4]);
  assert.deepEqual(M.simpleRatio(1.02), [1, 1]);
  assert.deepEqual(M.simpleRatio(1.5), [2, 3]);
  assert.deepEqual(M.simpleRatio(1.24), [4, 5]);
});

test('finer stripes give finer subdivisions', () => {
  const subs = [0.015, 0.03, 0.06, 0.1].map((p) => M.stripeSpec({ ...base, period: p }).rhythm);
  assert.deepEqual(subs, ['1/16', '1/8', '1/4', '1/2']);
  assert.equal(M.stripeSpec({ ...base, period: 0.015 }).inst, 'hat');
  assert.equal(M.stripeSpec({ ...base, period: 0.1 }).inst, 'kick');
});

test('a 3:4 grid plays 3 against 4', () => {
  const s = M.gridSpec({ ...base, type: 'GRID', family: 'lattice', period: 0.06, period2: 0.045, ratio: 4 / 3 });
  assert.equal(s.rhythm, '3:4');
  assert.equal(s.steps.filter((x) => x.layer === 0).length, 3);
  assert.equal(s.steps.filter((x) => x.layer === 1).length, 4);
});

test('colour moves pitch; yellow is higher than blue', () => {
  const yellow = M.midiOf(M.colorToPitch(55, 0.8));
  const blue = M.midiOf(M.colorToPitch(228, 0.8));
  const grey = M.midiOf(M.colorToPitch(0, 0.02));
  assert.ok(yellow > grey && grey > blue);
  assert.equal(M.noteName(50), 'D3');
});

test('every step position lies inside its loop', () => {
  for (const type of ['STRIPE', 'GRID', 'DOTS', 'CONCENTRIC', 'RADIAL']) {
    for (const p of [0.015, 0.03, 0.06, 0.12]) {
      const s = M.specFor({ ...base, type, period: p, period2: p * 0.8, ratio: 1.25 });
      assert.ok(s.steps.length > 0, type);
      for (const st of s.steps) assert.ok(st.pos >= 0 && st.pos < 1, `${type} ${st.pos}`);
      assert.ok(typeof s.sig === 'string');
    }
  }
});

test('orientation pans: 45° and 135° stripes sit on opposite sides', () => {
  const view = { w: 1, h: 2 };
  const l = M.panFor({ ...base, angle: 135 }, view);
  const r = M.panFor({ ...base, angle: 45 }, view);
  assert.ok(l < -0.3 && r > 0.3);
});

test('a row plays one hit per thing, where it sits along the row', () => {
  const row = (ts, offs = []) => M.rowSpec({ ...base, family: 'row', type: 'ROW', size: 0.15, evenness: 0.2,
    members: ts.map((t, i) => ({ t, off: offs[i] || 0, sim: 0.9 })) });
  const even = row([0, 1, 2, 3]);
  assert.deepEqual(even.steps.map((s) => s.pos * 16), [0, 4, 8, 12]);
  const uneven = row([0, 1, 1.5, 3]);
  assert.deepEqual(uneven.steps.map((s) => s.pos * 16), [0, 4, 6, 12]);
  assert.equal(uneven.pattern, 'x···x·x·····x···');
  // a thing set higher than the others is a higher note
  const lifted = row([0, 1, 2], [0, -0.6, 0]);
  assert.ok(lifted.steps[1].midi > lifted.steps[0].midi);
  // identical rows sound in unison; a different rhythm does not
  assert.equal(row([0, 1, 2, 3]).sig, even.sig);
  assert.notEqual(uneven.sig, even.sig);
});

test('a loop whose pattern went out through the edge fades fast; one lost in place slowly', () => {
  assert.equal(M.fadeBarsFor({ family: 'line', exit: { kind: 'edge' } }), 0.25);
  assert.equal(M.fadeBarsFor({ family: 'lattice', exit: { kind: 'edge' } }), 0.25);
  assert.equal(M.fadeBarsFor({ family: 'line', exit: { kind: 'vanish' } }), 1);
  assert.equal(M.fadeBarsFor({ family: 'lattice', exit: { kind: 'vanish' } }), 2);
  assert.equal(M.fadeBarsFor({ family: 'radial' }), 2);
});
