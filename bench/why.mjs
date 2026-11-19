// Why do views of a label not react? First failing gate per cell, and how
// close the best cells of each view came to each threshold.
// usage: node bench/why.mjs <detector.js> <viewsDir> [labels,comma] [optionsJSON]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [,, detPath, dir, only, optJSON] = process.argv;
const { createDetector } = await import(pathToFileURL(resolve(detPath)).href);
const det = createDetector(optJSON ? JSON.parse(optJSON) : {});
const o = det.options;
const want = only ? new Set(only.split(',')) : null;
const index = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8')).filter((v) => !want || want.has(v.label));

const byLabel = {};
for (const v of index) {
  const buf = readFileSync(`${dir}/${v.view}.rgba`);
  const res = det.analyze(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), v.w, v.h);
  const L = (byLabel[v.label] ??= { views: 0, hit: 0, fail: {}, cells: 0, best: [] });
  L.views++;
  if (res.regions.length) L.hit++;
  // per view: the cell that got furthest (largest prominence that is in band)
  let best = null;
  for (const lv of res.levels) {
    for (const c of lv.cells) {
      L.cells++;
      const f = c.type && !c.weak ? 'ok' : c.fail || 'other';
      L.fail[f] = (L.fail[f] || 0) + 1;
      if (c.prom && (!best || c.prom > best.prom)) best = c;
    }
  }
  if (best) L.best.push(best);
}
const pct = (a, n) => `${Math.round((100 * a) / n)}%`;
const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[xs.length >> 1] : NaN);
console.log(`thresholds: prom ${o.minProminence} iso ${o.minIsolation} rep ${o.minRepeat} stripeScore ${o.stripeScore} (sens ${o.sensitivity})`);
for (const [k, L] of Object.entries(byLabel)) {
  const fails = Object.entries(L.fail).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${pct(n, L.cells)}`).join(' ');
  const b = L.best;
  console.log(`${k.padEnd(11)} views ${L.hit}/${L.views} | cells: ${fails}`);
  console.log(`${''.padEnd(11)} best cell per view (median): prom ${med(b.map((c) => c.prom)).toFixed(0)} iso ${med(b.map((c) => c.iso1 ?? 0)).toFixed(2)} rep ${med(b.map((c) => c.rep1 ?? 0)).toFixed(2)} score ${med(b.map((c) => c.score1 ?? 0)).toFixed(2)}`);
}
