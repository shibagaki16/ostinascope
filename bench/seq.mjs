// Detector + tracker over hand-held sequences (10 Hz): does a pattern start
// playing, how fast, and how often does something off-pattern play?
// usage: node bench/seq.mjs <detector.js> <tracker.js> <seqDir> [detOptionsJSON]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [,, detPath, trPath, dir, dOpt] = process.argv;
const { createDetector } = await import(pathToFileURL(resolve(detPath)).href);
const { createTracker } = await import(pathToFileURL(resolve(trPath)).href);
const index = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'));
const seqs = new Map();
for (const v of index) {
  if (!seqs.has(v.seq)) seqs.set(v.seq, []);
  seqs.get(v.seq)[v.frame] = v;
}
const det = createDetector(dOpt ? JSON.parse(dOpt) : {});
const fam = (t) => (t === 'STRIPE' ? 'line' : t === 'GRID' || t === 'DOTS' ? 'lattice' : t === 'ROW' ? 'row' : 'radial');
const stat = {};
let noise = 0, frames = 0, ms = 0;
const noiseKinds = {};
for (const [, fr] of seqs) {
  const tracker = createTracker();
  const unit = Math.min(fr[0].w, fr[0].h);
  const view = { w: fr[0].w / unit, h: fr[0].h / unit };
  const first = new Map();
  const activeN = new Map();
  const off = new Set();
  fr.forEach((v, f) => {
    const buf = readFileSync(`${dir}/${v.view}.rgba`);
    const res = det.analyze(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), v.w, v.h);
    ms += res.ms;
    frames++;
    const n = (x) => x / unit;
    const dets = res.regions.map((r) => ({ ...r, cx: n(r.cx), cy: n(r.cy), w: n(r.w), h: n(r.h), period: n(r.period),
      period2: r.period2 ? n(r.period2) : undefined, center: r.center ? { x: n(r.center.x), y: n(r.center.y) } : null }));
    tracker.update(dets, f * 100, view, () => 1200);
    for (const tr of tracker.tracks) {
      if (tr.state !== 'active') continue;
      const b = [(tr.cx - tr.w / 2) * unit, (tr.cy - tr.h / 2) * unit, (tr.cx + tr.w / 2) * unit, (tr.cy + tr.h / 2) * unit];
      let on = -1;
      v.gt.forEach((g, gi) => {
        const ix = Math.max(0, Math.min(g.box[2], b[2]) - Math.max(g.box[0], b[0]));
        const iy = Math.max(0, Math.min(g.box[3], b[3]) - Math.max(g.box[1], b[1]));
        if ((ix * iy) / ((b[2] - b[0]) * (b[3] - b[1])) >= 0.3 && fam(tr.type) === g.family) on = gi;
      });
      if (on >= 0) {
        if (!first.has(on)) first.set(on, f);
        activeN.set(on, (activeN.get(on) || 0) + 1);
      } else if (!off.has(tr.id)) {
        off.add(tr.id);
        noiseKinds[tr.type] = (noiseKinds[tr.type] || 0) + 1;
      }
    }
  });
  const vm = fr[Math.min(10, fr.length - 1)];
  vm.gt.forEach((g, gi) => {
    const [x0, y0, x1, y1] = g.box;
    const vis = (Math.min(x1, vm.w) - Math.max(x0, 0)) * (Math.min(y1, vm.h) - Math.max(y0, 0)) / ((x1 - x0) * (y1 - y0));
    if (!(vis > 0.7)) return;
    const k = g.family === 'row' ? 'row' : 'pattern';
    stat[k] ??= { n: 0, played: 0, frames: 0, active: 0, lat: [] };
    const s = stat[k];
    s.n++;
    s.frames += fr.length;
    if (first.has(gi)) {
      s.played++;
      s.lat.push(first.get(gi));
      s.active += activeN.get(gi);
    }
  });
  noise += off.size;
}
const secs = frames / 10;
console.log(`sequences ${seqs.size}, mean ${(ms / frames).toFixed(1)} ms/frame`);
for (const [k, s] of Object.entries(stat)) {
  s.lat.sort((a, b) => a - b);
  console.log(`${k}: played ${s.played}/${s.n} (${(100 * s.played / s.n).toFixed(0)}%), first sound median ${s.lat[s.lat.length >> 1] ?? '-'} p90 ${s.lat[Math.floor(s.lat.length * 0.9)] ?? '-'} frames, playing while visible ${(100 * s.active / s.frames).toFixed(0)}%`);
}
console.log(`off-pattern loops: ${noise} in ${secs.toFixed(0)} s (${(noise / secs * 60).toFixed(1)}/min) ${JSON.stringify(noiseKinds)}`);
