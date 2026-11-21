// Telling surfaces apart by their motion (step 3). The demo poster hangs on
// a wall above a tiled floor; a virtual phone camera looks at the poster's
// lower part from above, so the floor fills the bottom of the view, and
// moves through the room (not just turning): the near floor and the far
// wall then shift differently in the image. Each frame is ray cast, so the
// true surface of every pixel and the true motion of each surface are known.
//
// Three ways of following, on the same frames and detections:
//   none    no camera motion (outlines move only with new detections)
//   single  one motion for the whole frame (the dominant surface)
//   multi   each track with the motion of the surface it is on
// Measured: how far outlines slip off their surface (px/frame, separately
// for tracks on the wall and on the floor), how well the corners are sorted
// into surfaces, and how often the two surfaces are told apart.
//
// Open bench/surfaces.html, or `node bench/page.mjs <url of surfaces.html>`.

import { createDetector } from '../src/detector.js';
import { createTracker, toViewUnits } from '../src/tracker.js';
import { greyOf } from '../src/motion.js';
import { createFollower } from '../src/follow.js';
import { applyH, invH, mulH } from '../src/homography.js';
import {
  AW, AH, FOCAL, FPS, ANALYSIS_EVERY, LATENCY, rng, mipmaps, posterSource, norm, cross, rotAxis, mean, pct,
} from './follow.js';

const FLOOR_GAP = 40; // the floor is this far below the poster's bottom edge (poster px)

// Floor tiles (repeating): 64-unit tiles with grout, each tile a slightly
// different shade so that their corners can be followed.
function floorSource() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  const r = rng(77);
  g.fillStyle = '#6d665c';
  g.fillRect(0, 0, S, S);
  const T = 64;
  for (let y = 0; y < S; y += T) {
    for (let x = 0; x < S; x += T) {
      const v = 150 + Math.floor(r() * 60);
      g.fillStyle = `rgb(${v},${v - 8},${v - 20})`;
      g.fillRect(x + 3, y + 3, T - 6, T - 6);
      // a fleck or two
      g.fillStyle = `rgba(60,55,50,${0.3 + 0.4 * r()})`;
      g.fillRect(x + 8 + r() * 40, y + 8 + r() * 40, 3 + r() * 5, 3 + r() * 5);
    }
  }
  return { mip: mipmaps(g.getImageData(0, 0, S, S)), w: S, h: S, repeat: true };
}

// The camera looks at a point near the poster's bottom from above and in
// front, and wanders sideways and up and down (a translation: parallax).
function cornerPath(src, seed, frames) {
  const r = rng(seed);
  const u = (a, b) => a + (b - a) * r();
  const W = src.w;
  const Hh = src.h;
  const foot0 = u(0.3, 0.45) * W;
  const D0 = (foot0 * FOCAL) / AW;
  const cx0 = u(0.3, 0.7) * W;
  const cy0 = Hh - u(150, 400);
  const tilt0 = u(28, 45) / 57.3; // looking down at the wall
  const az0 = (-90 + u(-25, 25)) / 57.3;
  const roll0 = u(-6, 6) / 57.3;
  const speed = u(0.25, 0.6);
  const waves = Array.from({ length: 3 }, () => ({ w: u(0.3, 0.9), px: u(0, 6.3), py: u(0, 6.3) }));
  let jx = 0;
  let jy = 0;
  const shake = u(0.1, 0.35) / 57.3;
  const K = [FOCAL, 0, AW / 2, 0, FOCAL, AH / 2, 0, 0, 1];
  const Yf = Hh + FLOOR_GAP;
  const out = [];
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    let ox = 0;
    let oy = 0;
    for (const wv of waves) {
      ox += Math.sin(wv.w * t * 2 * Math.PI * 0.35 + wv.px) / waves.length;
      oy += Math.sin(wv.w * t * 2 * Math.PI * 0.3 + wv.py) / waves.length;
    }
    const amp = (speed * foot0) / (2 * Math.PI * 0.3);
    const T = [cx0 + ox * amp * 2, Math.min(Hh, cy0 + oy * amp), 0];
    const tilt = tilt0 + (5 / 57.3) * Math.sin(0.6 * t);
    const D = D0 * (1 + 0.15 * Math.sin(0.5 * t + 1));
    const v = [Math.sin(tilt) * Math.cos(az0), Math.sin(tilt) * Math.sin(az0), -Math.cos(tilt)];
    const C = [T[0] + D * v[0], T[1] + D * v[1], T[2] + D * v[2]];
    let z = norm([T[0] - C[0], T[1] - C[1], T[2] - C[2]]);
    let x = norm(cross([0, 1, 0], z));
    jx = 0.85 * jx + 0.15 * (r() * 2 - 1) * shake * 3;
    jy = 0.85 * jy + 0.15 * (r() * 2 - 1) * shake * 3;
    let y = cross(z, x);
    z = norm(rotAxis(rotAxis(z, y, jx), x, jy));
    x = norm(cross(y, z));
    x = rotAxis(x, z, roll0 + (2 / 57.3) * Math.sin(0.9 * t));
    y = cross(z, x);
    const R = [x, y, z];
    const tt = R.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]));
    const col = (j) => [R[0][j], R[1][j], R[2][j]];
    const [c0, c1, c2] = [col(0), col(1), col(2)];
    // wall (X, Y, 0) and floor (X, Yf, Z) — plane coords (X, Z) — to the image
    const Hwall = mulH(K, [c0[0], c1[0], tt[0], c0[1], c1[1], tt[1], c0[2], c1[2], tt[2]]);
    const Hfloor = mulH(K, [c0[0], c2[0], c1[0] * Yf + tt[0], c0[1], c2[1], c1[1] * Yf + tt[1], c0[2], c2[2], c1[2] * Yf + tt[2]]);
    out.push({ R, C, Hwall, Hfloor, Yf });
  }
  return out;
}

function sample(src, X, Y, s, rgba, j, n) {
  const { mip } = src;
  const L = Math.max(0, Math.min(mip.length - 1, Math.round(Math.log2(Math.max(1, s)) + 0.6)));
  const m = mip[L];
  const k = 1 / (1 << L);
  let u = X * k;
  let v = Y * k;
  if (src.repeat) {
    u = ((u % m.w) + m.w) % m.w;
    v = ((v % m.h) + m.h) % m.h;
  }
  u = Math.min(m.w - 1.001, Math.max(0, u));
  v = Math.min(m.h - 1.001, Math.max(0, v));
  const x0 = u | 0;
  const y0 = v | 0;
  const fx = u - x0;
  const fy = v - y0;
  const i = (y0 * m.w + x0) * 4;
  for (let c = 0; c < 3; c++) {
    const a = m.d[i + c] + (m.d[i + 4 + c] - m.d[i + c]) * fx;
    const b = m.d[i + m.w * 4 + c] + (m.d[i + m.w * 4 + 4 + c] - m.d[i + m.w * 4 + c]) * fx;
    rgba[j + c] = a + (b - a) * fy + n;
  }
}

// Ray cast: each pixel shows the nearer of wall and floor. label: 1 wall, 2 floor.
function renderCorner(wall, floor, cam, noise) {
  const rgba = new Uint8ClampedArray(AW * AH * 4);
  const label = new Uint8Array(AW * AH);
  const { R, C, Yf } = cam;
  const ray = (px, py) => {
    const a = (px - AW / 2) / FOCAL;
    const b = (py - AH / 2) / FOCAL;
    // Rᵀ (a, b, 1)
    return [R[0][0] * a + R[1][0] * b + R[2][0], R[0][1] * a + R[1][1] * b + R[2][1], R[0][2] * a + R[1][2] * b + R[2][2]];
  };
  const hit = (d) => {
    const tw = d[2] > 1e-9 ? -C[2] / d[2] : Infinity;
    const tf = d[1] > 1e-9 ? (Yf - C[1]) / d[1] : Infinity;
    if (tf > 0 && tf < tw) return { s: 2, X: C[0] + tf * d[0], Y: -(C[2] + tf * d[2]) };
    if (tw > 0 && tw < Infinity) return { s: 1, X: C[0] + tw * d[0], Y: C[1] + tw * d[1] };
    return null;
  };
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const j = (y * AW + x) * 4;
      rgba[j + 3] = 255;
      const h0 = hit(ray(x + 0.5, y + 0.5));
      if (!h0) {
        rgba[j] = rgba[j + 1] = rgba[j + 2] = 40;
        continue;
      }
      const h1 = hit(ray(x + 1.5, y + 0.5));
      const s = h1 && h1.s === h0.s ? Math.hypot(h1.X - h0.X, h1.Y - h0.Y) : 1;
      label[y * AW + x] = h0.s;
      const n = noise();
      if (h0.s === 2) sample(floor, h0.X, h0.Y, s, rgba, j, n);
      else if (h0.X >= 0 && h0.Y >= 0 && h0.X < wall.w - 1 && h0.Y < wall.h - 1) sample(wall, h0.X, h0.Y, s, rgba, j, n);
      else {
        // the wall around the poster: plain, faintly mottled
        const v = 200 + 6 * Math.sin(h0.X * 0.01) * Math.cos(h0.Y * 0.013) + n;
        rgba[j] = v;
        rgba[j + 1] = v - 4;
        rgba[j + 2] = v - 12;
      }
    }
  }
  return { rgba, label };
}

const labelAt = (label, x, y) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < AW && yi < AH ? label[yi * AW + xi] : 0;
};

function variant(kind, motionOpt = {}) {
  return {
    kind,
    tracker: createTracker(),
    follower: kind === 'none' ? null : createFollower({ motion: { ...motionOpt, maxPlanes: kind === 'multi' ? 3 : 1 } }),
    pending: [],
    last: new Map(),
    slip: { 1: [], 2: [] },
    seg: { right: 0, all: 0, rightSplit: 0, allSplit: 0 },
    split: { both: 0, told: 0 },
  };
}

async function runSequence(wall, floor, seed, frames, det, V3) {
  const cams = cornerPath(wall, seed, frames);
  const nz = rng(seed + 5);
  const noise = () => (nz() + nz() - 1) * 4;
  const unit = Math.min(AW, AH);
  const view = { w: AW / unit, h: AH / unit };
  const toV = (r) => toViewUnits(r, unit);
  let analysis = null;
  for (let f = 0; f < frames; f++) {
    const t = (f * 1000) / FPS;
    const { rgba, label } = renderCorner(wall, floor, cams[f], noise);
    const grey = greyOf(rgba, AW, AH);
    if (f % ANALYSIS_EVERY === 0) analysis = { at: f + LATENCY, res: det.analyze(rgba, AW, AH), frame: f };
    // true motion of each surface since the last frame
    const step = f ? {
      1: mulH(cams[f].Hwall, invH(cams[f - 1].Hwall)),
      2: mulH(cams[f].Hfloor, invH(cams[f - 1].Hfloor)),
    } : null;
    let floorShare = 0;
    for (let i = 0; i < label.length; i++) if (label[i] === 2) floorShare++;
    floorShare /= label.length;
    for (const V of V3) {
      let k = -1;
      if (V.follower) k = V.follower.step(grey, AW, AH, V.tracker, t).k;
      if (analysis && analysis.frame === f) V.pending.push({ ...analysis, k });
      while (V.pending.length && V.pending[0].at <= f) {
        const p = V.pending.shift();
        let dets = p.res.regions.map(toV);
        if (V.follower) {
          dets = V.follower.place(dets, p.k, unit) || dets;
          V.tracker.update(dets, t, view, () => 1500);
        } else V.tracker.update(dets, (p.frame * 1000) / FPS, view, () => 1500);
      }
      // slip, by the true surface under each playing track's centre
      const now = new Map();
      for (const tr of V.tracker.tracks) {
        if (tr.state !== 'active') continue;
        const q = tr.quad.map(([x, y]) => [x * unit, y * unit]);
        now.set(tr.id, q);
        const before = V.last.get(tr.id);
        if (!before || !step) continue;
        const cx = q.reduce((s, p) => s + p[0], 0) / 4;
        const cy = q.reduce((s, p) => s + p[1], 0) / 4;
        const sfc = labelAt(label, cx, cy);
        if (!sfc) continue;
        const moved = before.map(([x, y]) => applyH(step[sfc], x, y));
        V.slip[sfc].push(moved.reduce((acc, p, i) => acc + Math.hypot(p[0] - q[i][0], p[1] - q[i][1]), 0) / 4);
      }
      V.last = now;
      // corners sorted into surfaces (multi only)
      if (V.kind === 'multi') {
        const pts = V.follower.motion.points;
        const votes = new Map();
        for (let i = 0; i < pts.n; i++) {
          const id = pts.surface[i];
          if (id < 0) continue;
          const tl = labelAt(label, pts.x[i], pts.y[i]);
          if (!tl) continue;
          if (!votes.has(id)) votes.set(id, [0, 0, 0]);
          votes.get(id)[tl]++;
        }
        for (const v of votes.values()) {
          V.seg.right += Math.max(v[1], v[2]);
          V.seg.all += v[1] + v[2];
          if (votes.size > 1) {
            V.seg.rightSplit += Math.max(v[1], v[2]);
            V.seg.allSplit += v[1] + v[2];
          }
        }
        if (floorShare > 0.2 && floorShare < 0.8) {
          V.split.both++;
          if (V.follower.motion.stats.planes > 1) V.split.told++;
        }
      }
    }
  }
}

export async function run({ seqs = 6, frames = 150, motion = {}, log = () => {} } = {}) {
  const wall = await posterSource();
  const floor = floorSource();
  const det = createDetector({ rowSplit: 2 });
  const agg = ['none', 'single', 'multi'].map((kind) => ({ kind, slip: { 1: [], 2: [] }, seg: { right: 0, all: 0, rightSplit: 0, allSplit: 0 }, split: { both: 0, told: 0 } }));
  for (let s = 0; s < seqs; s++) {
    const V3 = ['none', 'single', 'multi'].map((kind) => variant(kind, motion));
    await runSequence(wall, floor, 2000 + s * 31, frames, det, V3);
    V3.forEach((V, i) => {
      agg[i].slip[1].push(...V.slip[1]);
      agg[i].slip[2].push(...V.slip[2]);
      agg[i].seg.right += V.seg.right;
      agg[i].seg.all += V.seg.all;
      agg[i].seg.rightSplit += V.seg.rightSplit;
      agg[i].seg.allSplit += V.seg.allSplit;
      agg[i].split.both += V.split.both;
      agg[i].split.told += V.split.told;
    });
    log(`corner ${s + 1}/${seqs}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    slip: agg.map((a) => ({
      follow: a.kind,
      wall: +mean(a.slip[1]).toFixed(2),
      wallP90: +pct(a.slip[1], 0.9).toFixed(2),
      floor: +mean(a.slip[2]).toFixed(2),
      floorP90: +pct(a.slip[2], 0.9).toFixed(2),
      wallTrackFrames: a.slip[1].length,
      floorTrackFrames: a.slip[2].length,
    })),
    surfaces: {
      cornersOnTheirSurface: agg[2].seg.all ? +(agg[2].seg.right / agg[2].seg.all).toFixed(3) : null,
      cornersRightWhenSplit: agg[2].seg.allSplit ? +(agg[2].seg.rightSplit / agg[2].seg.allSplit).toFixed(3) : null,
      toldApartWhenBothInView: agg[2].split.both ? +(agg[2].split.told / agg[2].split.both).toFixed(3) : null,
    },
  };
}

/** Frames with the surfaces the multi follower found (corners coloured, hulls). */
export async function strip({ seed = 2000, frames = 120, every = 20 } = {}) {
  const wall = await posterSource();
  const floor = floorSource();
  const cams = cornerPath(wall, seed, frames);
  const nz = rng(seed + 5);
  const noise = () => (nz() + nz() - 1) * 4;
  const follower = createFollower();
  const tracker = createTracker();
  const K = 2;
  const picks = [];
  for (let f = every; f < frames; f += every) picks.push(f);
  const cv = document.createElement('canvas');
  cv.width = picks.length * (AW * K + 8);
  cv.height = AH * K;
  const g = cv.getContext('2d');
  const tints = ['#ffffff', '#4c7dff', '#29d17a', '#ff4b36', '#ffd21f'];
  let col = 0;
  for (let f = 0; f < frames; f++) {
    const { rgba } = renderCorner(wall, floor, cams[f], noise);
    follower.step(greyOf(rgba, AW, AH), AW, AH, tracker, (f * 1000) / FPS);
    if (!picks.includes(f)) continue;
    const tmp = document.createElement('canvas');
    tmp.width = AW;
    tmp.height = AH;
    tmp.getContext('2d').putImageData(new ImageData(rgba, AW, AH), 0, 0);
    const ox = col * (AW * K + 8);
    col++;
    g.drawImage(tmp, ox, 0, AW * K, AH * K);
    for (const sf of follower.motion.surfaces()) {
      if (sf.hull.length < 3) continue;
      g.strokeStyle = tints[sf.id % tints.length];
      g.lineWidth = 2;
      g.setLineDash([3, 4]);
      g.beginPath();
      sf.hull.forEach(([x, y], i) => (i ? g.lineTo(ox + x * K, y * K) : g.moveTo(ox + x * K, y * K)));
      g.closePath();
      g.stroke();
      g.setLineDash([]);
    }
    const pts = follower.motion.points;
    for (let i = 0; i < pts.n; i++) {
      const id = pts.surface[i];
      g.fillStyle = id < 0 ? '#888' : tints[id % tints.length];
      g.fillRect(ox + pts.x[i] * K - 2, pts.y[i] * K - 2, 4, 4);
    }
    g.fillStyle = '#000';
    g.fillRect(ox, AH * K - 20, AW * K, 20);
    g.fillStyle = '#fff';
    g.font = '600 12px monospace';
    g.fillText(`frame ${f}  surfaces ${follower.motion.stats.planes}`, ox + 6, AH * K - 6);
  }
  return cv;
}
