import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPES, paint, boundsOf, createElement, moveElement, context, textLayout, remapKern, rotateElement, rotationCentre } from '../src/poster/poster.js';

const spec = JSON.parse(readFileSync(new URL('../poster/poster.json', import.meta.url), 'utf8'));

// a 2D context that accepts every call and counts them
function mockContext() {
  const calls = { n: 0 };
  const g = new Proxy({}, {
    get(_, k) {
      if (k === 'calls') return calls;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 10 });
      return () => {
        calls.n++;
      };
    },
    set: () => true,
  });
  return g;
}

const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

test('poster.json: every element has a known type and its fields', () => {
  const ids = new Set();
  for (const el of spec.elements) {
    assert.ok(TYPES[el.type], `unknown type ${el.type}`);
    if (el.id) {
      assert.ok(!ids.has(el.id), `duplicate id ${el.id}`);
      ids.add(el.id);
    }
    for (const f of TYPES[el.type].fields) {
      if (f.when && !f.when(el)) continue;
      if (f.optional) continue;
      assert.notEqual(get(el, f.key), undefined, `${el.id || el.type}: missing ${f.key}`);
    }
  }
});

test('the poster paints and every element has a box', () => {
  const g = mockContext();
  paint(g, spec);
  assert.ok(g.calls.n > 500);
  const ctx = context(spec);
  for (const el of spec.elements) {
    const b = boundsOf(el, g, ctx);
    assert.ok(b && b.x1 >= b.x0 && b.y1 >= b.y0, el.id);
  }
});

test('new elements of every type paint, and move', () => {
  const g = mockContext();
  const ctx = context(spec);
  for (const type of Object.keys(TYPES)) {
    const el = createElement(type, 900, 1200);
    paint(g, { ...spec, elements: [el] });
    const b0 = boundsOf(el, g, ctx);
    moveElement(el, 10, 20);
    const b1 = boundsOf(el, g, ctx);
    if (type !== 'frame') assert.deepEqual([b1.x0 - b0.x0, b1.y0 - b0.y0], [10, 20], type);
  }
});

// text: tracking and pair kerning (1/1000 em); the mock font is 10 px a character
const textEl = (more) => ({ type: 'text', x: 100, y: 50, size: 20, weight: 500, leading: 30, color: 'ink', lines: ['abc', 'de'], ...more });
const xs = (lines) => lines.map((l) => l.chars.map((c) => c.x));

test('text: tracking opens every gap, kerning one gap, both in 1/1000 em', () => {
  const g = mockContext();
  assert.deepEqual(xs(textLayout(g, textEl())), [[100, 110, 120], [100, 110]]);
  // 100/1000 em of 20 px = 2 px a gap; the pair after "a" closes by 50/1000 em = 1 px
  const lines = textLayout(g, textEl({ tracking: 100, kern: { '0:0': -50 } }));
  assert.deepEqual(xs(lines), [[100, 111, 123], [100, 112]]);
  assert.deepEqual(lines.map((l) => l.y), [50, 80]);
  // the box ends at the last character, not after a trailing gap
  const b = boundsOf(textEl({ tracking: 100, kern: { '0:0': -50 } }), g, context(spec));
  assert.equal(b.x1, 133);
  assert.equal(boundsOf(textEl(), g, context(spec)).x1, 130);
});

test('text: with spacing it is drawn a character at a time, without it a line at a time', () => {
  const drawn = (el) => {
    const out = [];
    const g = new Proxy({}, {
      get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 10 }) : k === 'fillText' ? (...a) => out.push(a) : () => {}),
      set: () => true,
    });
    paint(g, { ...spec, elements: [el] });
    return out;
  };
  assert.deepEqual(drawn(textEl()), [['abc', 100, 50], ['de', 100, 80]]);
  assert.deepEqual(drawn(textEl({ kern: { '1:0': 30 } })), [['a', 100, 50], ['b', 110, 50], ['c', 120, 50], ['d', 100, 80], ['e', 110.6, 80]]);
});

test('text: pair kerning stays on its two characters when the text is edited', () => {
  const kern = { '0:0': -40, '1:1': 20 }; // "O|s" and "e|m"
  const old = ['Ostinato', 'tempo'];
  assert.deepEqual(remapKern(kern, old, ['Ostinato!', 'tempo']), kern); // after both pairs
  assert.deepEqual(remapKern(kern, old, ['"Ostinato', 'tempo']), { '0:1': -40, '1:1': 20 }); // before "O|s"
  assert.deepEqual(remapKern(kern, old, ['title', 'Ostinato', 'tempo']), { '1:0': -40, '2:1': 20 }); // a line above
  assert.deepEqual(remapKern(kern, old, ['Oxstinato', 'tempo']), { '1:1': 20 }); // the edit split "O|s"
  assert.deepEqual(remapKern(kern, old, ['Ostinato tempo']), { '0:0': -40, '0:10': 20 }); // lines joined
  assert.equal(remapKern({ '0:0': -40 }, ['Os'], ['O']), undefined); // nothing left
  assert.equal(remapKern({ '0:7': -40, '5:0': 10 }, old, old), undefined); // no such gap
});

// rotating together: what follows an element turns about its centre with it
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const turnAll = (els, parent, deg, g, ctx) => {
  const [cx, cy] = rotationCentre(parent, g, ctx);
  for (const o of els) rotateElement(o, deg, cx, cy, g, ctx);
};

test('rotating: fig.5 with its road, edges and caption turns as one, and back', () => {
  const g = mockContext();
  const ctx = context(spec);
  const fig5 = spec.elements.find((e) => e.id === 'fig5');
  const followers = structuredClone(spec.elements.filter((e) => e.for === 'fig5'));
  const before = structuredClone(followers);
  turnAll(followers, fig5, 5, g, ctx); // fig5 from −5° to 0°
  for (const r of followers.filter((e) => e.type === 'rect')) assert.equal(r.rotation, 0, r.id);
  // each rectangle's centre went round fig5's centre by 5°
  const road0 = before.find((e) => e.id === 'fig5-road');
  const road1 = followers.find((e) => e.id === 'fig5-road');
  const a = (5 * Math.PI) / 180;
  const [mx, my] = [road0.x + road0.w / 2 - fig5.x, road0.y + road0.h / 2 - fig5.y];
  assert.ok(near(road1.x + road1.w / 2, fig5.x + mx * Math.cos(a) - my * Math.sin(a)));
  assert.ok(near(road1.y + road1.h / 2, fig5.y + mx * Math.sin(a) + my * Math.cos(a)));
  turnAll(followers, fig5, -5, g, ctx);
  followers.forEach((o, i) => {
    for (const k of ['x', 'y', 'lx', 'ly', 'rotation']) if (o[k] != null) assert.ok(near(o[k], before[i][k]), `${o.id}.${k}`);
  });
});

test('rotating: lines, arcs, sectors and caption leaders turn; text stays level', () => {
  const g = mockContext();
  const ctx = context(spec);
  const line = { type: 'line', x0: 10, y0: 0, x1: 20, y1: 0, width: 1, color: 'ink' };
  rotateElement(line, 90, 0, 0, g, ctx);
  assert.deepEqual([line.x0, line.y0, line.x1, line.y1], [0, 10, 0, 20]);
  const arc = { type: 'arc', x: 10, y: 0, r: 5, start: 0, end: 90, width: 1, color: 'ink' };
  rotateElement(arc, 90, 0, 0, g, ctx);
  assert.deepEqual([arc.x, arc.y, arc.start, arc.end], [0, 10, 90, 180]);
  const disc = { type: 'disc', x: 0, y: 0, r: 5, start: 0, end: 360, color: 'ink' };
  rotateElement(disc, 30, 0, 0, g, ctx);
  assert.deepEqual([disc.start, disc.end], [0, 360]); // a whole disc has no angle to turn
  const cap = { type: 'caption', x: 100, y: 0, lx: 0, ly: 50, leader: true, text: 'ab' };
  rotateElement(cap, 180, 0, 0, g, ctx);
  assert.deepEqual([cap.lx, cap.ly], [0, -50]);
  const b = boundsOf(cap, g, ctx); // its middle went to the other side; the text is still level
  assert.ok(near((b.x0 + b.x1) / 2, -110) && near((b.y0 + b.y1) / 2, 6));
});

test('rotated rectangles and patterns: the box fits the turned shape', () => {
  const g = mockContext();
  const ctx = context(spec);
  const rect = { type: 'rect', x: 0, y: 0, w: 200, h: 100, rotation: 90, color: 'ink' };
  const b = boundsOf(rect, g, ctx);
  assert.ok(near(b.x0, 50) && near(b.x1, 150) && near(b.y0, -50) && near(b.y1, 150));
  const pat = { ...TYPES.pattern.make(), x: 0, y: 0, rotation: 90, shape: { kind: 'rect', w: 200, h: 100 } };
  const p = boundsOf(pat, g, ctx);
  assert.ok(near(p.x0, -50) && near(p.x1, 50) && near(p.y0, -100) && near(p.y1, 100));
});

test('repeat: the whole grid turns about its middle', () => {
  const g = mockContext();
  const ctx = context(spec);
  const el = { ...TYPES.repeat.make(), x: 0, y: 0, nx: 2, ny: 1, dx: 100, dy: 0, rotation: 90 };
  el.child = { ...el.child, shape: { kind: 'circle', r: 10 } };
  const b = boundsOf(el, g, ctx); // was x −10…110, y −10…10, about (50, 0)
  assert.ok(near(b.x0, 40) && near(b.x1, 60) && near(b.y0, -60) && near(b.y1, 60));
  paint(g, { ...spec, elements: [el] });
  // as a follower it goes round, keeping its middle's distance
  rotateElement(el, 90, 50, 100, g, ctx);
  assert.deepEqual([el.x, el.y, el.rotation], [100, 100, 180]); // its middle (50, 0) → (150, 100)
});
