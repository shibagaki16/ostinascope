import test from 'node:test';
import assert from 'node:assert/strict';
import { qrCode, rsDivisor, rsRemainder } from '../src/poster/qr.js';

// Checked once against a real decoder (Chrome's BarcodeDetector): these
// texts at these levels decode to themselves at these versions.
const URL = 'https://shibagaki16.github.io/ostinascope/';

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

test('Reed–Solomon: data + remainder has the generator roots α⁰…αⁿ⁻¹', () => {
  const data = Array.from({ length: 19 }, (_, i) => (i * 37 + 11) & 0xff);
  for (const n of [7, 10, 18, 26]) {
    const cw = data.concat(rsRemainder(data, rsDivisor(n)));
    let a = 1;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const c of cw) v = gfMul(v, a) ^ c; // Horner at αⁱ
      assert.equal(v, 0, `degree ${n}, root ${i}`);
      a = gfMul(a, 2);
    }
  }
});

test('versions grow with the text and the level', () => {
  const ver = (t, e) => (qrCode(t, e).length - 17) / 4;
  assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => ver('HELLO', e)), [1, 1, 1, 1]);
  assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => ver(URL, e)), [3, 3, 4, 5]);
  assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => ver('x'.repeat(100), e)), [5, 6, 8, 10]);
  assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => ver('a1b2c3d4e5'.repeat(30), e)), [11, 13, 16, 18]);
});

test('function patterns: finders, timing, the dark module', () => {
  const m = qrCode(URL, 'M');
  const n = m.length;
  assert.equal(n, 29);
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        assert.equal(m[cy + dy][cx + dx], d !== 2, `finder at ${cx},${cy}`);
      }
    }
  }
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
  assert.equal(m[n - 8][8], true);
});

test('format bits: both copies agree, a valid BCH word, level M', () => {
  for (const t of ['HELLO', URL, 'x'.repeat(100)]) {
    const m = qrCode(t, 'M');
    const n = m.length;
    const a = [];
    const b = [];
    for (let i = 0; i <= 5; i++) a.push(m[i][8]);
    a.push(m[7][8], m[8][8], m[8][7]);
    for (let i = 9; i < 15; i++) a.push(m[8][14 - i]);
    for (let i = 0; i < 8; i++) b.push(m[8][n - 1 - i]);
    for (let i = 8; i < 15; i++) b.push(m[n - 15 + i][8]);
    assert.deepEqual(a, b, t);
    const word = a.reduce((v, bit, i) => v | ((bit ? 1 : 0) << i), 0) ^ 0x5412;
    let r = word;
    for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10);
    assert.equal(r, 0, 'BCH remainder');
    assert.equal(word >>> 13, 0, 'level M');
  }
});

test('version bits (version 7 and up): both copies agree', () => {
  const m = qrCode('The quick brown fox jumps over the lazy dog. '.repeat(3), 'M');
  const n = m.length;
  assert.ok(n >= 45);
  for (let i = 0; i < 18; i++) {
    const a = n - 11 + (i % 3);
    const c = Math.floor(i / 3);
    assert.equal(m[c][a], m[a][c]);
  }
});
