// Run the detector over prepared views and score them.
// usage: node bench/eval.mjs <detector.js> <viewsDir> [optionsJSON] [--out res.json]
//   views with ground truth (bench/scenes.py): recall per kind, regions off the patterns
//   photo views (bench/views.py): share of views with a region, per photo label
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const [detPath, dir, optJSON] = args;
const { createDetector } = await import(pathToFileURL(resolve(detPath)).href);
const det = createDetector(optJSON ? JSON.parse(optJSON) : {});
const index = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'));

const famOf = (t) => (t === 'STRIPE' ? 'line' : t === 'GRID' || t === 'DOTS' ? 'lattice' : t === 'ROW' ? 'row' : 'radial');
const out = [];
let ms = 0;
for (const v of index) {
  const buf = readFileSync(`${dir}/${v.view}.rgba`);
  const res = det.analyze(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), v.w, v.h);
  ms += res.ms;
  out.push({ ...v, regions: res.regions.map((r) => ({ type: r.type, level: r.level, x: r.x, y: r.y, w: r.w, h: r.h,
    cells: r.cells, count: r.count, period: +r.period.toFixed(1),
    members: r.members ? r.members.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h })) : undefined })) });
}
if (outPath) writeFileSync(outPath, JSON.stringify(out));
console.log(`views ${out.length}, mean ${(ms / out.length).toFixed(1)} ms`);

const hitOf = (g, r) => {
  const [gx0, gy0, gx1, gy1] = g.box;
  const ix = Math.max(0, Math.min(gx1, r.x + r.w) - Math.max(gx0, r.x));
  const iy = Math.max(0, Math.min(gy1, r.y + r.h) - Math.max(gy0, r.y));
  return (ix * iy) / (r.w * r.h) >= 0.35;
};
const scenes = out.filter((v) => v.gt);
if (scenes.length) {
  const rec = {};
  let regs = 0, extra = 0, extraRows = 0, countOk = 0, rowsFound = 0;
  for (const v of scenes) {
    for (const r of v.regions) {
      regs++;
      if (!v.gt.some((g) => hitOf(g, r))) { extra++; if (r.type === 'ROW') extraRows++; }
    }
    for (const g of v.gt) {
      const [x0, y0, x1, y1] = g.box;
      const vis = (Math.min(x1, v.w) - Math.max(x0, 0)) * (Math.min(y1, v.h) - Math.max(y0, 0)) / ((x1 - x0) * (y1 - y0));
      if (!(vis > 0.85)) continue;
      const rs = v.regions.filter((r) => hitOf(g, r));
      const ok = rs.filter((r) => famOf(r.type) === g.family);
      rec[g.kind] ??= [0, 0, 0, 0]; // right family, any, total, rows wrongly on it
      rec[g.kind][2]++;
      if (ok.length) rec[g.kind][0]++;
      if (rs.length) rec[g.kind][1]++;
      if (g.family !== 'row' && rs.some((r) => r.type === 'ROW')) rec[g.kind][3]++;
      if (g.family === 'row' && ok.length) {
        rowsFound++;
        if (ok.some((r) => Math.abs(r.count - g.count) <= 1)) countOk++;
      }
    }
  }
  const tot = Object.entries(rec).filter(([k]) => k !== 'row').reduce((a, [, r]) => [a[0] + r[0], a[2] + r[2]], [0, 0]);
  console.log(`patterns (not rows): right family ${tot[0]}/${tot[1]} (${(100 * tot[0] / Math.max(1, tot[1])).toFixed(0)}%)`);
  if (rec.row) console.log(`rows: found ${rec.row[0]}/${rec.row[2]} (${(100 * rec.row[0] / rec.row[2]).toFixed(0)}%), count ±1 ${countOk}/${rowsFound}`);
  console.log(`regions off every pattern: ${extra}/${regs} (${(extra / scenes.length).toFixed(2)} per view, ROW ${(extraRows / scenes.length).toFixed(2)})`);
  console.log('  by kind (right/any/total, ROW on a pattern): ' + Object.entries(rec).sort().map(([k, r]) => `${k} ${r[0]}/${r[1]}/${r[2]}` + (r[3] ? ` R${r[3]}` : '')).join('  '));
}
const photos = out.filter((v) => !v.gt);
if (photos.length) {
  const lab = {};
  for (const v of photos) {
    lab[v.label] ??= [0, 0, 0];
    lab[v.label][1]++;
    if (v.regions.length) lab[v.label][0]++;
    if (v.regions.some((r) => r.type === 'ROW')) lab[v.label][2]++;
  }
  console.log('photos (views with any region / total, ROW views):');
  console.log('  ' + Object.entries(lab).map(([k, [h, n, r]]) => `${k} ${h}/${n} R${r}`).join(' · '));
}
