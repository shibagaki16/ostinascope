// Does the overlay stay on the surface? A virtual phone camera moves over
// the demo poster and some photos in 3-D (tilting, panning, zooming, hand
// shake), with the true plane-to-image homography known for every frame.
// The real detector, tracker and motion estimator run on the frames as the
// app runs them (camera frames at 30 Hz, analysis at 10 Hz, results back
// two frames late), once without and once with camera motion.
//
// Measured over the playing (active) tracks:
//   slip   how far an overlay moves relative to the surface under it,
//          px per frame (192 px wide frame). 0 = glued to the surface.
//   IoU    overlap with the poster figure it sits on (visible part)
//   held   share of frames in which a fully visible figure is playing
//   ids    distinct playing tracks per figure (1 = never lost its identity)
// and, per detection (step 2, the surface's tilt):
//   tiltErr  angle between the estimated and the true surface normal
//   falseTilt share of regions given a tilt while the view is frontal (<6°)
//   fit      IoU of a region's outline with its figure: the outline
//            (a trapezoid on a tilted surface) vs its plain box
//   3:4      share of fig.2 (a 3 : 4 grid) lattice regions whose ratio
//            rounds to 3 : 4 — as seen, and measured head-on
//
// Runs in a browser (the poster is drawn with canvas): open
// bench/follow.html, or `node bench/page.mjs <url of follow.html>`.

import { drawPoster, loadPoster, boundsOf, context } from '../src/poster/poster.js';
import { createDetector, familyOf } from '../src/detect/detector.js';
import { createTracker, toViewUnits } from '../src/track/tracker.js';
import { greyOf } from '../src/track/motion.js';
import { createFollower } from '../src/track/follow.js';
import { applyH, invH, mulH } from '../src/homography.js';
import { simpleRatio } from '../src/sound/mapping.js';
import { rng } from '../src/util.js';

export const AW = 192;
export const AH = 416;
export const FOCAL = 278; // px: ≈ 38° across the short side (a phone's main camera, cropped to the screen)
export const FPS = 30;
export const ANALYSIS_EVERY = 3; // 10 Hz
export const LATENCY = 2; // frames until a result is back

export { rng };

// ---------------------------------------------------------------- sources

export function mipmaps(img) {
  const levels = [{ w: img.width, h: img.height, d: Float32Array.from(img.data) }];
  while (levels.length < 8) {
    const a = levels[levels.length - 1];
    const w = a.w >> 1;
    const h = a.h >> 1;
    if (w < 8 || h < 8) break;
    const d = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          const i = (2 * y * a.w + 2 * x) * 4 + c;
          d[(y * w + x) * 4 + c] = 0.25 * (a.d[i] + a.d[i + 4] + a.d[i + a.w * 4] + a.d[i + a.w * 4 + 4]);
        }
      }
    }
    levels.push({ w, h, d });
  }
  return levels;
}

export async function posterSource() {
  const spec = await loadPoster();
  await document.fonts.ready;
  const cv = drawPoster(spec, 1);
  const g = cv.getContext('2d');
  const ctx = context(spec);
  const figs = [];
  for (const el of spec.elements) {
    if (!/^fig\d+$/.test(el.id) || el.type === 'text') continue;
    const kind = el.type === 'row' ? 'row' : el.type === 'repeat' ? el.child.pattern.kind : el.pattern.kind;
    const family = { stripes: 'line', grid: 'lattice', hexdots: 'lattice', rings: 'radial', rays: 'radial', row: 'row' }[kind];
    if (!family) continue;
    const b = boundsOf(el, g, ctx);
    const fig = { id: el.id, family, poly: [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] };
    if (el.type === 'row') {
      // where each thing of the row stands (its centre)
      const xs = [el.x];
      for (const gp of el.gaps) xs.push(xs[xs.length - 1] + gp * ctx.unit);
      const h = (el.motif === 'bottle' ? 132 : el.h) * el.size;
      fig.things = xs.map((x) => [x, el.y - h / 2]);
    }
    figs.push(fig);
  }
  return { name: 'poster', mip: mipmaps(g.getImageData(0, 0, cv.width, cv.height)), w: cv.width, h: cv.height, figs };
}

async function photoSource(url) {
  const im = new Image();
  im.src = url;
  await im.decode();
  const k = Math.min(1, 1600 / Math.max(im.width, im.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(im.width * k);
  cv.height = Math.round(im.height * k);
  const g = cv.getContext('2d');
  g.drawImage(im, 0, 0, cv.width, cv.height);
  return { name: url.split('/').pop(), mip: mipmaps(g.getImageData(0, 0, cv.width, cv.height)), w: cv.width, h: cv.height, figs: [] };
}

// ---------------------------------------------------------------- camera

export const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
};
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const rotAxis = (v, axis, ang) => {
  // Rodrigues
  const [x, y, z] = axis;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = (x * v[0] + y * v[1] + z * v[2]) * (1 - c);
  const cr = cross(axis, v);
  return [v[0] * c + cr[0] * s + x * d, v[1] * c + cr[1] * s + y * d, v[2] * c + cr[2] * s + z * d];
};

// A hand-held path over the plane: the point looked at wanders, the phone
// tilts, rolls, comes closer and backs off, and shakes a little.
export function cameraPath(src, seed, frames) {
  const r = rng(seed);
  const u = (a, b) => a + (b - a) * r();
  const W = src.w;
  const Hh = src.h;
  const foot0 = u(0.2, 0.45) * Math.min(W, Hh); // plane px across the short side
  const D0 = (foot0 * FOCAL) / AW;
  const cx0 = u(0.25, 0.75) * W;
  const cy0 = u(0.25, 0.75) * Hh;
  const speed = u(0.15, 0.6); // footprints per second (rough)
  const waves = Array.from({ length: 3 }, () => ({ w: u(0.2, 0.9), px: u(0, 6.3), py: u(0, 6.3) }));
  const tilt0 = u(0, 40) / 57.3;
  const az0 = u(0, 6.3);
  const roll0 = u(-12, 12) / 57.3;
  let jx = 0;
  let jy = 0;
  const shake = u(0.1, 0.5) / 57.3; // rad
  const out = [];
  const normals = [];
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    let ox = 0;
    let oy = 0;
    for (const wv of waves) {
      ox += Math.sin(wv.w * t * 2 * Math.PI * 0.35 + wv.px) / waves.length;
      oy += Math.sin(wv.w * t * 2 * Math.PI * 0.3 + wv.py) / waves.length;
    }
    const amp = (speed * foot0) / (2 * Math.PI * 0.3);
    const T = [Math.min(W, Math.max(0, cx0 + ox * amp * 2)), Math.min(Hh, Math.max(0, cy0 + oy * amp * 2)), 0];
    const tilt = Math.max(0, tilt0 + (8 / 57.3) * Math.sin(0.7 * t + az0));
    const D = D0 * (1 + 0.2 * Math.sin(0.5 * t + roll0 * 10));
    const v = [Math.sin(tilt) * Math.cos(az0), Math.sin(tilt) * Math.sin(az0), -Math.cos(tilt)];
    const C = [T[0] + D * v[0], T[1] + D * v[1], T[2] + D * v[2]];
    let z = norm([T[0] - C[0], T[1] - C[1], T[2] - C[2]]);
    let x = norm(cross([0, 1, 0], z));
    // hand shake: a smoothed random turn of the phone
    jx = 0.85 * jx + 0.15 * (r() * 2 - 1) * shake * 3;
    jy = 0.85 * jy + 0.15 * (r() * 2 - 1) * shake * 3;
    let y = cross(z, x);
    z = norm(rotAxis(rotAxis(z, y, jx), x, jy));
    x = norm(cross(y, z));
    const roll = roll0 + (3 / 57.3) * Math.sin(0.9 * t);
    x = rotAxis(x, z, roll);
    y = cross(z, x);
    normals.push([x[2], y[2], z[2]]); // the plane's normal (0, 0, 1) in the camera frame
    // plane (X, Y, 0) → image: K [r1 r2 t]
    const Rm = [x, y, z];
    const tt = Rm.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]));
    const P = [
      [Rm[0][0], Rm[0][1], tt[0]],
      [Rm[1][0], Rm[1][1], tt[1]],
      [Rm[2][0], Rm[2][1], tt[2]],
    ];
    const K = [FOCAL, 0, AW / 2, 0, FOCAL, AH / 2, 0, 0, 1];
    out.push(mulH(K, P.flat()));
  }
  out.normals = normals;
  return out;
}

// Render the plane through H (plane → image) with mip-mapped bilinear
// sampling, a touch of blur and sensor noise.
export function renderFrame(src, H, noise) {
  const inv = invH(H);
  const rgba = new Uint8ClampedArray(AW * AH * 4);
  const { mip } = src;
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const [X, Y] = applyH(inv, x + 0.5, y + 0.5);
      const j = (y * AW + x) * 4;
      if (!(X >= 0 && Y >= 0 && X < src.w - 1 && Y < src.h - 1)) {
        rgba[j] = rgba[j + 1] = rgba[j + 2] = 52;
        rgba[j + 3] = 255;
        continue;
      }
      // footprint of the pixel on the plane → mip level (+0.6: lens softness)
      const [X1, Y1] = applyH(inv, x + 1.5, y + 0.5);
      const s = Math.hypot(X1 - X, Y1 - Y);
      const L = Math.max(0, Math.min(mip.length - 1, Math.round(Math.log2(Math.max(1, s)) + 0.6)));
      const m = mip[L];
      const k = 1 / (1 << L);
      const u = Math.min(m.w - 1.001, X * k);
      const v = Math.min(m.h - 1.001, Y * k);
      const x0 = u | 0;
      const y0 = v | 0;
      const fx = u - x0;
      const fy = v - y0;
      const i = (y0 * m.w + x0) * 4;
      const n = noise();
      for (let c = 0; c < 3; c++) {
        const a = m.d[i + c] + (m.d[i + 4 + c] - m.d[i + c]) * fx;
        const b = m.d[i + m.w * 4 + c] + (m.d[i + m.w * 4 + 4 + c] - m.d[i + m.w * 4 + c]) * fx;
        rgba[j + c] = a + (b - a) * fy + n;
      }
      rgba[j + 3] = 255;
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- geometry

export function area(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}
// Sutherland–Hodgman: subject clipped by a convex polygon
export function clip(subject, by) {
  let out = subject;
  const orient = Math.sign(by.reduce((s, p, i) => {
    const q = by[(i + 1) % by.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) || 1;
  for (let i = 0; i < by.length && out.length; i++) {
    const a = by[i];
    const b = by[(i + 1) % by.length];
    const side = (p) => orient * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j];
      const q = inp[(j + 1) % inp.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}
export const VIEW = [[0, 0], [AW, 0], [AW, AH], [0, AH]];
export function iou(a, b) {
  const i = area(clip(a, b));
  return i / Math.max(1e-9, area(a) + area(b) - i);
}

// ---------------------------------------------------------------- run

function makeVariant(useMotion, trackerOpt) {
  return {
    useMotion,
    tracker: createTracker(trackerOpt),
    follower: useMotion ? createFollower() : null,
    pending: [], // [applyAtFrame, result, captureFrame, motionIndex]
    last: new Map(), // track id → quad (px) in the previous frame
    slip: [],
    slipFast: [],
    slipDet: [], // frames in which a detection was taken in
    split: 0, // frames in which a flat scene was split into several surfaces
    frames: 0,
    iou: [],
    held: 0,
    visible: 0,
    figIds: new Map(),
  };
}

async function runSequence(src, seed, frames, out, trackerOpt, det, plane) {
  const Hs = cameraPath(src, seed, frames);
  const nz = rng(seed + 99);
  const noise = () => (nz() + nz() - 1) * 4;
  const variants = [makeVariant(false), makeVariant(true, trackerOpt)];
  const unit = Math.min(AW, AH);
  const view = { w: AW / unit, h: AH / unit };
  const toV = (r) => toViewUnits(r, unit);
  let analysis = null;
  for (let f = 0; f < frames; f++) {
    const t = (f * 1000) / FPS;
    const rgba = renderFrame(src, Hs[f], noise);
    const grey = greyOf(rgba, AW, AH);
    if (f % ANALYSIS_EVERY === 0) analysis = { at: f + LATENCY, res: det.analyze(rgba, AW, AH), frame: f };
    const figsNow = src.figs.map((g) => ({ ...g, H: Hs[f], img: g.poly.map(([x, y]) => applyH(Hs[f], x, y)) }));
    if (analysis && analysis.frame === f) measurePlanes(analysis.res, Hs.normals[f], figsNow, plane);
    const trueStep = f ? mulH(Hs[f], invH(Hs[f - 1])) : null;
    for (const V of variants) {
      let k = -1;
      if (V.follower) {
        const m = V.follower.step(grey, AW, AH, V.tracker, t);
        k = m.k;
        V.frames++;
        if (m.surfaces && m.surfaces.size > 1) V.split++;
      }
      if (analysis && analysis.frame === f) V.pending.push({ ...analysis, k });
      let updated = false;
      while (V.pending.length && V.pending[0].at <= f) {
        const p = V.pending.shift();
        updated = true;
        let dets = p.res.regions.map(toV);
        if (V.follower) {
          dets = V.follower.place(dets, p.k, unit) || dets;
          V.tracker.update(dets, t, view, () => 1500);
        } else {
          // as the app did: stamped with the capture time
          V.tracker.update(dets, (p.frame * 1000) / FPS, view, () => 1500);
        }
      }
      // --- measure
      const now = new Map();
      for (const tr of V.tracker.tracks) {
        if (tr.state !== 'active') continue;
        const q = tr.quad.map(([x, y]) => [x * unit, y * unit]);
        now.set(tr.id, q);
        const before = V.last.get(tr.id);
        if (before && trueStep) {
          const moved = before.map(([x, y]) => applyH(trueStep, x, y));
          const s = moved.reduce((acc, p, i) => acc + Math.hypot(p[0] - q[i][0], p[1] - q[i][1]), 0) / 4;
          V.slip.push(s);
          if (updated) V.slipDet.push(s);
          const [ax, ay] = applyH(trueStep, AW / 2, AH / 2);
          if (Math.hypot(ax - AW / 2, ay - AH / 2) > 3) V.slipFast.push(s);
        }
        if (figsNow.length) {
          let best = 0;
          let bestFig = null;
          for (const g of figsNow) {
            const vis = clip(g.img, VIEW);
            if (vis.length < 3) continue;
            const o = iou(q, vis);
            if (o > best) {
              best = o;
              bestFig = g;
            }
          }
          V.iou.push(best);
          if (bestFig && best > 0.2) {
            if (!V.figIds.has(bestFig.id)) V.figIds.set(bestFig.id, new Set());
            V.figIds.get(bestFig.id).add(tr.id);
          }
        }
      }
      V.last = now;
      // held: fully visible figures with a playing track of the right family on them
      for (const g of figsNow) {
        if (area(clip(g.img, VIEW)) < 0.95 * area(g.img)) continue;
        V.visible++;
        const on = V.tracker.tracks.some((tr) => tr.state === 'active' && familyOf(tr.type) === g.family &&
          iou(tr.quad.map(([x, y]) => [x * unit, y * unit]), g.img) > 0.15);
        if (on) V.held++;
      }
    }
  }
  for (const [i, V] of variants.entries()) {
    const o = out[i];
    o.slip.push(...V.slip);
    o.slipFast.push(...V.slipFast);
    o.slipDet.push(...V.slipDet);
    o.split = (o.split || 0) + V.split;
    o.frames = (o.frames || 0) + V.frames;
    o.iou.push(...V.iou);
    o.held += V.held;
    o.visible += V.visible;
    for (const s of V.figIds.values()) o.ids.push(s.size);
  }
}

/** A strip of frames from one sequence (for looking at), as a canvas. */
export async function strip({ seed = 1000, frames = 150, every = 15, photo = null } = {}) {
  const src = photo ? await photoSource(photo) : await posterSource();
  const Hs = cameraPath(src, seed + src.name.length, frames);
  const nz = rng(seed + 99);
  const noise = () => (nz() + nz() - 1) * 4;
  const picks = [];
  for (let f = 0; f < frames; f += every) picks.push(f);
  const cv = document.createElement('canvas');
  cv.width = picks.length * (AW + 4);
  cv.height = AH;
  const g = cv.getContext('2d');
  picks.forEach((f, i) => g.putImageData(new ImageData(renderFrame(src, Hs[f], noise), AW, AH), i * (AW + 4), 0));
  return cv;
}

// Step 2: the regions' surface tilt, outline fit and the grid's ratio.
function measurePlanes(res, nTrue, figs, P) {
  const slantTrue = (Math.acos(Math.min(1, Math.abs(nTrue[2]))) * 180) / Math.PI;
  for (const r of res.regions) {
    if (r.family !== 'line' && r.family !== 'lattice') continue;
    P.regions++;
    if (r.plane) {
      const n = r.plane.normal;
      const e = (Math.acos(Math.min(1, Math.abs(n[0] * nTrue[0] + n[1] * nTrue[1] + n[2] * nTrue[2]))) * 180) / Math.PI;
      P.tiltErr.push(e);
      if (slantTrue < 6) P.falseTilt++;
    } else if (slantTrue >= 20) P.flatOnTilted++;
    if (slantTrue < 6) P.frontal++;
    if (slantTrue >= 20) P.tilted++;
    // outline vs box against the figure it sits on
    const box = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    let best = null;
    let bo = 0;
    for (const g of figs) {
      const vis = clip(g.img, VIEW);
      if (vis.length < 3) continue;
      const o = iou(box, vis);
      if (o > bo) {
        bo = o;
        best = vis;
      }
    }
    if (best && bo > 0.2 && r.plane) {
      P.fitBox.push(bo);
      P.fitQuad.push(iou(r.quad, best));
    }
    const g2 = figs.find((g) => g.id === 'fig2');
    if (g2 && r.family === 'lattice') {
      const vis = clip(g2.img, VIEW);
      if (vis.length >= 3 && iou(box, vis) > 0.2) {
        const seen = r.ratioSeen ?? r.ratio;
        const is34 = (q) => {
          const [a, b] = simpleRatio(Math.max(1, q));
          return a === 3 && b === 4;
        };
        P.grid++;
        if (is34(seen)) P.gridSeen++;
        if (is34(r.ratio)) P.gridFlat++;
        if (slantTrue >= 20) {
          P.gridTilted++;
          if (is34(seen)) P.gridTiltedSeen++;
          if (is34(r.ratio)) P.gridTiltedFlat++;
        }
      }
    }
  }
  // the row's rhythm: positions of its things along it (0…1) vs the printed ones
  for (const r of res.regions) {
    if (r.type !== 'ROW') continue;
    for (const g of figs) {
      if (!g.things) continue;
      const vis = clip(g.img, VIEW);
      if (vis.length < 3) continue;
      const box = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      if (iou(box, vis) < 0.2) continue;
      const ms = [...r.members].sort((a, b) => a.t - b.t);
      if (ms.length < 3) continue;
      const tImg = g.things.map((p) => applyH(g.H, p[0], p[1]));
      const idx = ms.map((m) => {
        const cx = m.x + m.w / 2;
        const cy = m.y + m.h / 2;
        let bi = 0;
        tImg.forEach((p, i) => {
          if (Math.hypot(p[0] - cx, p[1] - cy) < Math.hypot(tImg[bi][0] - cx, tImg[bi][1] - cy)) bi = i;
        });
        return bi;
      });
      if (new Set(idx).size !== idx.length) continue;
      const truth = idx.map((i) => g.things[i][0]);
      const tn = (v, a, b) => (v - a) / (b - a);
      const ang = (r.angle * Math.PI) / 180;
      const ux = Math.cos(ang);
      const uy = -Math.sin(ang);
      const seen = ms.map((m) => (m.x + m.w / 2) * ux + (m.y + m.h / 2) * uy);
      const errOf = (vals) => vals.reduce((acc, v, i) => acc + Math.abs(tn(v, vals[0], vals[vals.length - 1]) - tn(truth[i], truth[0], truth[truth.length - 1])), 0) / vals.length;
      P.rowSeen.push(errOf(seen));
      P.rowUsed.push(errOf(ms.map((m) => m.t)));
      if (r.receding) P.rowReceding++;
    }
  }
  P.focal = res.focal;
}

/** Frames with the detector's outlines drawn on (box dashed, surface outline solid). */
export async function stripRegions({ seed = 1003, frames = 150, every = 25, warm = 60, photo = null } = {}) {
  const src = photo ? await photoSource(photo) : await posterSource();
  const Hs = cameraPath(src, seed + src.name.length, frames);
  const nz = rng(seed + 99);
  const noise = () => (nz() + nz() - 1) * 4;
  const det = createDetector();
  for (let f = 0; f < warm; f += 3) det.analyze(renderFrame(src, Hs[f], noise), AW, AH); // learn the focal length
  const picks = [];
  for (let f = warm; f < frames; f += every) picks.push(f);
  const K = 2;
  const cv = document.createElement('canvas');
  cv.width = picks.length * (AW * K + 8);
  cv.height = AH * K;
  const g = cv.getContext('2d');
  picks.forEach((f, i) => {
    const rgba = renderFrame(src, Hs[f], noise);
    const res = det.analyze(rgba, AW, AH);
    const tmp = document.createElement('canvas');
    tmp.width = AW;
    tmp.height = AH;
    tmp.getContext('2d').putImageData(new ImageData(rgba, AW, AH), 0, 0);
    const ox = i * (AW * K + 8);
    g.drawImage(tmp, ox, 0, AW * K, AH * K);
    const n = Hs.normals[f];
    const slantTrue = (Math.acos(Math.min(1, Math.abs(n[2]))) * 180) / Math.PI;
    g.font = '600 13px monospace';
    g.fillStyle = '#000';
    g.fillRect(ox, AH * K - 22, AW * K, 22);
    g.fillStyle = '#fff';
    g.fillText(`true slant ${slantTrue.toFixed(0)}°  focal ${res.focal.toFixed(2)}`, ox + 6, AH * K - 7);
    for (const r of res.regions) {
      if (r.family !== 'line' && r.family !== 'lattice') continue;
      const col = r.family === 'line' ? '#FFD21F' : '#FF4B36';
      g.lineWidth = 1.5;
      g.strokeStyle = col;
      g.setLineDash([4, 4]);
      g.strokeRect(ox + r.x * K, r.y * K, r.w * K, r.h * K);
      g.setLineDash([]);
      if (r.plane) {
        g.lineWidth = 3;
        g.beginPath();
        r.quad.forEach(([x, y], j) => (j ? g.lineTo(ox + x * K, y * K) : g.moveTo(ox + x * K, y * K)));
        g.closePath();
        g.stroke();
        const txt = `${r.type} ${r.plane.slant.toFixed(0)}°` + (r.ratioSeen ? ` ${r.ratioSeen.toFixed(2)}→${r.ratio.toFixed(2)}` : '');
        g.fillStyle = 'rgba(0,0,0,0.75)';
        g.fillRect(ox + r.quad[0][0] * K, r.quad[0][1] * K - 16, g.measureText(txt).width + 8, 16);
        g.fillStyle = col;
        g.fillText(txt, ox + r.quad[0][0] * K + 4, r.quad[0][1] * K - 4);
      }
    }
  });
  return cv;
}

export const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

export async function run({ seqs = 6, frames = 150, photos = [], tracker = {}, detector = {}, log = () => {} } = {}) {
  const sources = [await posterSource()];
  for (const p of photos) sources.push(await photoSource(p));
  const report = [];
  const planes = [];
  // one phone: the detector (and the focal length it learns) persists
  const det = createDetector({ rowSplit: 2, ...detector });
  for (const src of sources) {
    const out = [0, 1].map(() => ({ slip: [], slipFast: [], slipDet: [], iou: [], held: 0, visible: 0, ids: [] }));
    const P = { regions: 0, tiltErr: [], falseTilt: 0, frontal: 0, tilted: 0, flatOnTilted: 0, fitBox: [], fitQuad: [],
      grid: 0, gridSeen: 0, gridFlat: 0, gridTilted: 0, gridTiltedSeen: 0, gridTiltedFlat: 0, focal: 0,
      rowSeen: [], rowUsed: [], rowReceding: 0 };
    const n = src.name === 'poster' ? seqs : Math.max(1, seqs >> 1);
    for (let s = 0; s < n; s++) {
      await runSequence(src, 1000 + s * 17 + src.name.length, frames, out, tracker, det, P);
      log(`${src.name} ${s + 1}/${n}`);
      await new Promise((r) => setTimeout(r, 0));
    }
    for (const [i, o] of out.entries()) {
      report.push({
        source: src.name,
        motion: i === 1,
        slip: +mean(o.slip).toFixed(2),
        slipP90: +pct(o.slip, 0.9).toFixed(2),
        slipFast: +mean(o.slipFast).toFixed(2),
        slipDet: +mean(o.slipDet).toFixed(2),
        falseSplit: o.frames ? +(o.split / o.frames).toFixed(3) : null,
        iou: src.figs.length ? +mean(o.iou).toFixed(3) : null,
        held: o.visible ? +(o.held / o.visible).toFixed(3) : null,
        idsPerFigure: o.ids.length ? +mean(o.ids).toFixed(2) : null,
        trackFrames: o.slip.length,
      });
    }
    planes.push({
      source: src.name,
      regions: P.regions,
      tiltErrMedian: +pct(P.tiltErr, 0.5).toFixed(1),
      tiltErrP90: +pct(P.tiltErr, 0.9).toFixed(1),
      tiltedFound: P.tilted ? +(1 - P.flatOnTilted / P.tilted).toFixed(2) : null,
      falseTilt: P.frontal ? +(P.falseTilt / P.frontal).toFixed(2) : null,
      fitBox: P.fitBox.length ? +mean(P.fitBox).toFixed(3) : null,
      fitQuad: P.fitQuad.length ? +mean(P.fitQuad).toFixed(3) : null,
      grid34Seen: P.grid ? +(P.gridSeen / P.grid).toFixed(2) : null,
      grid34HeadOn: P.grid ? +(P.gridFlat / P.grid).toFixed(2) : null,
      tiltedGrid34Seen: P.gridTilted ? +(P.gridTiltedSeen / P.gridTilted).toFixed(2) : null,
      tiltedGrid34HeadOn: P.gridTilted ? +(P.gridTiltedFlat / P.gridTilted).toFixed(2) : null,
      gridRegions: P.grid,
      focal: +P.focal.toFixed(2),
      rowPosErrSeen: P.rowSeen.length ? +mean(P.rowSeen).toFixed(3) : null,
      rowPosErrUsed: P.rowUsed.length ? +mean(P.rowUsed).toFixed(3) : null,
      rowDetections: P.rowSeen.length,
      rowReceding: P.rowReceding,
    });
  }
  return { follow: report, planes, focalTrue: +(FOCAL / AW).toFixed(2) };
}
