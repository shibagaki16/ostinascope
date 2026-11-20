// Detection per family of photo views: does the right kind of region come
// out, and how often do the wrong ones (a lattice on stripes, anything at all
// on photos without a pattern)?
// usage: node bench/families.mjs <detector.js> [optionsJSON] [--json out.json] [--labels bench/labels.json]
//   photo views: bench/data/views and bench/data/nviews (bench/views.py)
//   --labels: also count against the views' ground truth (labelled by eye):
//   for each kind, the labelled views where it shows and whether a region
//   of its type lies (mostly) on it, and the views where it does not show
//   and whether one comes out anyway
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const jsonPath = jsonIdx >= 0 ? args.splice(jsonIdx, 2)[1] : null;
const labIdx = args.indexOf('--labels');
const labPath = labIdx >= 0 ? args.splice(labIdx, 2)[1] : null;
const labels = labPath ? JSON.parse(readFileSync(labPath, 'utf8')) : null;
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
const labelled = []; // { key, label, w, h, regions }
const wanted = new Set(FAMILIES.flatMap((f) => f.labels));
let n = 0;
let ms = 0;
for (const dir of DIRS) {
  if (!existsSync(`${dir}/index.json`)) continue;
  for (const v of JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'))) {
    const key = `${dir.split('/').pop()}/${v.view}`;
    const lab = labels && labels.views[key];
    if (!wanted.has(v.label) && !lab) continue;
    const buf = readFileSync(`${dir}/${v.view}.rgba`);
    const res = det.analyze(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), v.w, v.h);
    ms += res.ms;
    n++;
    if (lab) labelled.push({ key, label: v.label, w: v.w, h: v.h, regions: res.regions.map(({ type, x, y, w, h }) => ({ type, x, y, w, h })) });
    if (!wanted.has(v.label)) continue;
    if (!views.has(v.label)) views.set(v.label, []);
    views.get(v.label).push({ view: key, types: [...new Set(res.regions.map((r) => r.type))] });
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

// Against the labels. A cell range "A2:C5" of the labelling grid → a box
// in view px; a region is on the pattern when most of it lies in its boxes.
if (labels) {
  const KINDS = { lattice: ['GRID', 'DOTS'], stripe: ['STRIPE'], concentric: ['CONCENTRIC'], radial: ['RADIAL'] };
  const boxes = (v, ranges) => {
    const [cols, rows] = labels.grid[v.h > v.w ? 'portrait' : 'landscape'];
    const cw = v.w / cols;
    const ch = v.h / rows;
    return ranges.map((r) => {
      const [a, b] = r.split(':').map((c) => [c.charCodeAt(0) - 65, +c.slice(1) - 1]);
      return [Math.min(a[0], b[0]) * cw, Math.min(a[1], b[1]) * ch, (Math.max(a[0], b[0]) + 1) * cw, (Math.max(a[1], b[1]) + 1) * ch];
    });
  };
  const inside = (r, bs) => {
    let n = 0;
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        const x = r.x + ((i + 0.5) / 10) * r.w;
        const y = r.y + ((j + 0.5) / 10) * r.h;
        if (bs.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) n++;
      }
    }
    return n / 100;
  };
  out.labelled = {};
  for (const [kind, types] of Object.entries(KINDS)) {
    const t = { shows: 0, found: 0, offOnIt: 0, absent: 0, falseOn: 0, perLabel: {}, views: [] };
    for (const v of labelled) {
      const lab = labels.views[v.key];
      if (!lab.checked.includes(kind)) continue;
      const bs = boxes(v, lab[kind] || []);
      const rs = v.regions.filter((r) => types.includes(r.type));
      const on = rs.filter((r) => bs.length && inside(r, bs) >= 0.5).length;
      const off = rs.length - on;
      const pl = (t.perLabel[v.label] ??= { shows: 0, found: 0, absent: 0, falseOn: 0 });
      if (bs.length) {
        t.shows++; pl.shows++;
        if (on) { t.found++; pl.found++; }
        if (off) t.offOnIt++;
      } else {
        t.absent++; pl.absent++;
        if (rs.length) { t.falseOn++; pl.falseOn++; }
      }
      t.views.push({ view: v.key, shows: bs.length > 0, on, off });
    }
    if (!t.shows && !t.absent) continue;
    out.labelled[kind] = t;
    const pct = (k, n) => `${k}/${n} (${((100 * k) / Math.max(1, n)).toFixed(0)}%)`;
    console.log(`labelled ${kind.padEnd(10)} shows: found ${pct(t.found, t.shows)}, also off it ${t.offOnIt}  |  absent: found anyway ${pct(t.falseOn, t.absent)}`);
    console.log(`         ${Object.entries(t.perLabel).map(([l, p]) => `${l} ${p.found}/${p.shows}+${p.falseOn}/${p.absent}`).join(' · ')}`);
  }
}
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(out));
