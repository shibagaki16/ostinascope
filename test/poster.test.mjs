import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPES, paint, boundsOf, createElement, moveElement, context, textLayout, remapKern } from '../src/poster/poster.js';

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
