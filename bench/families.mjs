// Detection per family of photo views: does the right kind of region come
// out, and how often do the wrong ones (a lattice on stripes, anything at all
// on photos without a pattern)?
// usage: node bench/families.mjs <detector.js> [optionsJSON] [--json out.json]
//   photo views: bench/data/views and bench/data/nviews (bench/views.py)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const jsonPath = jsonIdx >= 0 ? args.splice(jsonIdx, 2)[1] : null;
const [detPath, optJSON] = args;
if (!detPath) {
  console.error('usage: node bench/families.mjs <detector.js> [optionsJSON] [--json out.json]');
  process.exit(1);
}
const { createDetector } = await import(pathToFileURL(resolve(detPath)).href);
const det = createDetector(optJSON ? JSON.parse(optJSON) : {});

const DIRS = ['bench/data/views', 'bench/data/nviews'];
// family: labels, which region types are right, which are wrong
const FAMILIES = [
  { name: 'lattice', labels: ['brick', 'chainlink', 'keyboard', 'polka', 'facade', 'fence', 'honeycomb', 'sunflower', 'fishscale', 'pinecone'],
    right: ['GRID', 'DOTS'] },
  { name: 'radial', labels: ['bikes', 'treering', 'flower', 'sunflower'], right: ['CONCENTRIC', 'RADIAL'] },
  { name: 'stripe', labels: ['blinds', 'zebra', 'stairs', 'bamboo', 'woodgrain', 'sandripple', 'corn'],
    right: ['STRIPE'], wrong: ['GRID', 'DOTS'] },
  // "anything" is wrong here. room/street are listed for when such photos
  // are added; labels that do not exist are reported and skipped.
  { name: 'none', labels: ['nature', 'leaves', 'pebbles', 'gravel', 'portrait', 'desk', 'room', 'street'], right: [], wrong: '*' },
];

// every view of the labels we need, analysed once
const views = new Map(); // label -> [{ view, types }]
const wanted = new Set(FAMILIES.flatMap((f) => f.labels));
let n = 0;
let ms = 0;
for (const dir of DIRS) {
  if (!existsSync(`${dir}/index.json`)) continue;
  for (const v of JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'))) {
    if (!wanted.has(v.label)) continue;
    const buf = readFileSync(`${dir}/${v.view}.rgba`);
    const res = det.analyze(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), v.w, v.h);
    ms += res.ms;
    n++;
    if (!views.has(v.label)) views.set(v.label, []);
    views.get(v.label).push({ view: `${dir.split('/').pop()}/${v.view}`, types: [...new Set(res.regions.map((r) => r.type))] });
  }
}

const out = { detector: detPath, options: optJSON ? JSON.parse(optJSON) : {}, families: {} };
console.log(`views ${n}, mean ${(ms / Math.max(1, n)).toFixed(1)} ms`);
for (const f of FAMILIES) {
  const missing = f.labels.filter((l) => !views.has(l));
  const per = {};
  let right = 0, wrong = 0, total = 0;
  for (const l of f.labels) {
    const vs = views.get(l);
    if (!vs) continue;
    const r = vs.filter((v) => v.types.some((t) => f.right.includes(t))).length;
    const w = f.wrong === '*' ? vs.filter((v) => v.types.length).length
      : f.wrong ? vs.filter((v) => v.types.some((t) => f.wrong.includes(t))).length : 0;
    per[l] = { right: r, wrong: w, total: vs.length, views: vs };
    right += r;
    wrong += w;
    total += vs.length;
  }
  out.families[f.name] = { right, wrong, total, labels: per, missing };
  const pct = (k) => `${k}/${total} (${((100 * k) / Math.max(1, total)).toFixed(0)}%)`;
  const head = f.wrong === '*' ? `anything ${pct(wrong)}`
    : f.wrong ? `right ${pct(right)}  wrong(${f.wrong.join('/')}) ${pct(wrong)}` : `right ${pct(right)}`;
  const labels = Object.entries(per).map(([l, p]) => `${l} ${f.wrong === '*' ? p.wrong : p.right}${f.wrong && f.wrong !== '*' ? '/' + p.wrong : ''}/${p.total}`).join(' · ');
  console.log(`${f.name.padEnd(8)} ${head}`);
  console.log(`         ${labels}${missing.length ? `  (no views: ${missing.join(', ')})` : ''}`);
}
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(out));
