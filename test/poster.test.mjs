import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPES, paint, boundsOf, createElement, moveElement, context } from '../src/poster.js';

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
