// Analysis time of two detectors on the same views. This machine's timing
// wanders a lot, so the two take turns, several rounds each, and the
// fastest round of each is compared.
// usage: node bench/abtime.mjs <a/detector.js> <b/detector.js> <viewsDir> [views=100] [rounds=5] [optionsJSON]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [aPath, bPath, dir, nArg = '100', rArg = '5', optJSON] = process.argv.slice(2);
if (!aPath || !bPath || !dir) {
  console.error('usage: node bench/abtime.mjs <a/detector.js> <b/detector.js> <viewsDir> [views] [rounds] [optionsJSON]');
  process.exit(1);
}
const opts = optJSON ? JSON.parse(optJSON) : {};
const load = async (p) => (await import(pathToFileURL(resolve(p)).href)).createDetector(opts);
const dets = { a: await load(aPath), b: await load(bPath) };

// spread the views over the whole set, so every label takes part
const index = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'));
const want = Math.min(index.length, +nArg);
const step = index.length / want;
const frames = Array.from({ length: want }, (_, i) => {
  const v = index[Math.floor(i * step)];
  const buf = readFileSync(`${dir}/${v.view}.rgba`);
  return { data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), w: v.w, h: v.h };
});

function round(det) {
  const t0 = performance.now();
  for (const f of frames) det.analyze(f.data, f.w, f.h);
  return (performance.now() - t0) / frames.length;
}

round(dets.a); // warm up both (JIT, buffers)
round(dets.b);
const times = { a: [], b: [] };
for (let r = 0; r < +rArg; r++) {
  for (const k of r % 2 ? ['b', 'a'] : ['a', 'b']) times[k].push(round(dets[k]));
}
const best = (k) => Math.min(...times[k]);
const fmt = (k) => `${best(k).toFixed(1)} ms (rounds ${times[k].map((t) => t.toFixed(1)).join(' ')})`;
console.log(`a ${aPath}: ${fmt('a')}`);
console.log(`b ${bPath}: ${fmt('b')}`);
console.log(`b / a = ${(best('b') / best('a')).toFixed(3)}  (${((best('b') / best('a') - 1) * 100).toFixed(1)}%)`);
