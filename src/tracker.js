// Ostinascope — temporal tracking of detected regions.
//
// Detections flicker from frame to frame; tracks give each pattern an
// identity and a little stubbornness:
//   cand    seen, but not yet trusted (needs a few consecutive frames)
//   active  trusted — its loop is playing
//   fading  lost — its loop fades out over 1–2 bars; can still be re-acquired
// Between analyses the camera motion (motion.js) moves every track with the
// surface it is on (warp); each track keeps a quad, which a tilted surface
// turns into a trapezoid.
// Pure module (no DOM).

import { angleDiff, lerp, TO_DEG as DEG } from './util.js';
import { applyH, localScale } from './homography.js';

/** The four corners of a region's box (clockwise from top-left). */
export function boxQuad(r) {
  const x0 = r.cx - r.w / 2;
  const y0 = r.cy - r.h / 2;
  const x1 = r.cx + r.w / 2;
  const y1 = r.cy + r.h / 2;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// The same corners in the same order as `ref` (the cyclic shift that puts
// each corner nearest its counterpart), so blending moves corners, not
// rotates them.
function alignQuad(ref, q) {
  let best = 0;
  let bestD = Infinity;
  for (let s = 0; s < 4; s++) {
    let d = 0;
    for (let i = 0; i < 4; i++) d += Math.hypot(ref[i][0] - q[(i + s) % 4][0], ref[i][1] - q[(i + s) % 4][1]);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return q.map((_, i) => q[(i + best) % 4]);
}

// cx, cy, w, h: the quad's bounding box (what matching and the sound use)
function boundQuad(r) {
  const xs = r.quad.map((p) => p[0]);
  const ys = r.quad.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  r.cx = (x0 + x1) / 2;
  r.cy = (y0 + y1) / 2;
  r.w = x1 - x0;
  r.h = y1 - y0;
}

/**
 * Move a region (a detection or a track, in view units) by a homography:
 * its quad, centre, members, and — locally — its angle and period.
 * Returns the region (changed in place).
 */
export function warpRegion(r, H) {
  const ox = r.cx;
  const oy = r.cy;
  r.quad = (r.quad || boxQuad(r)).map(([x, y]) => applyH(H, x, y));
  const k = localScale(H, ox, oy, 0.01);
  if (Number.isFinite(r.angle)) {
    const t = r.angle / DEG;
    const [x0, y0] = applyH(H, ox, oy);
    const [x1, y1] = applyH(H, ox + 0.01 * Math.cos(t), oy - 0.01 * Math.sin(t));
    r.angle = (((Math.atan2(-(y1 - y0), x1 - x0) * DEG) % 180) + 180) % 180;
  }
  if (r.period) r.period *= k;
  if (r.period2) r.period2 *= k;
  if (r.size) r.size *= k;
  if (r.center) {
    const [x, y] = applyH(H, r.center.x, r.center.y);
    r.center = { x, y };
  }
  if (r.members) {
    r.members = r.members.map((m) => {
      const q = [[m.x, m.y], [m.x + m.w, m.y], [m.x + m.w, m.y + m.h], [m.x, m.y + m.h]].map(([x, y]) => applyH(H, x, y));
      const xs = q.map((p) => p[0]);
      const ys = q.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      return { ...m, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, t: m.t !== undefined ? m.t * k : m.t };
    });
  }
  boundQuad(r);
  return r;
}

export const TRACKER_DEFAULTS = Object.freeze({
  confirmHits: 3, // consecutive-ish frames before a pattern may sound
  confirmMs: 250,
  candMaxMisses: 2, // a candidate missing this many frames is dropped
  lostGraceMs: 350, // an active track may vanish this long before fading
  maxDist: 0.35, // match radius, in view short-side units (+ region size)
  maxLogPeriod: 0.4, // |ln(period ratio)| allowed between frames
  maxAngle: 30, // degrees, for stripes
  smoothPos: 0.5,
  // a track the camera motion keeps on its surface lags nothing by being
  // smoothed, so its outline follows each new sighting less: detection
  // boxes are made of analysis cells and jitter by up to one
  smoothPosMoved: 0.25,
  smoothParam: 0.3,
  edgeMargin: 0.06,
});


export function createTracker(options = {}) {
  const opt = { ...TRACKER_DEFAULTS, ...options };
  let nextId = 1;
  let tracks = [];

  // Where a track should be now. A track the camera motion keeps in place
  // is already there; otherwise extrapolate from its last sighting.
  function predict(tr, t) {
    const dt = Math.min((t - Math.max(tr.lastSeen, tr.movedAt)) / 1000, 0.6);
    return { x: tr.cx + tr.vx * dt * 0.7, y: tr.cy + tr.vy * dt * 0.7 };
  }

  function cost(tr, d, t) {
    if (tr.family !== d.family) return Infinity;
    const p = predict(tr, t);
    const reach = opt.maxDist * (tr.state === 'fading' ? 1.4 : 1) + 0.35 * Math.sqrt(tr.w * tr.h);
    const cd = Math.hypot(d.cx - p.x, d.cy - p.y) / reach;
    const cp = Math.abs(Math.log(d.period / tr.period)) / opt.maxLogPeriod;
    let ca = 0;
    if (tr.family === 'line' || tr.family === 'row') ca = angleDiff(d.angle, tr.angle) / opt.maxAngle;
    else if (tr.family === 'lattice') ca = Math.abs(Math.log(d.ratio / tr.ratio)) / 0.25;
    if (cd > 1 || cp > 1 || ca > 1) return Infinity;
    return cd + cp + ca;
  }

  function create(d, t) {
    const tr = {
      id: nextId++,
      family: d.family,
      type: d.type,
      votes: { [d.type]: 1 },
      state: 'cand',
      hits: 1,
      misses: 0,
      born: t,
      lastSeen: t,
      activatedAt: 0,
      fadeStart: 0,
      fadeMs: 0,
      exit: null,
      resumed: false,
      vx: 0,
      vy: 0,
      movedAt: -Infinity, // last time the camera motion moved it
      ...pick(d),
    };
    tr.ac = Math.cos((2 * d.angle) / DEG);
    tr.as = Math.sin((2 * d.angle) / DEG);
    tr.hx = Math.cos(d.hue / DEG) * d.sat;
    tr.hy = Math.sin(d.hue / DEG) * d.sat;
    return tr;
  }

  function pick(d) {
    return {
      cx: d.cx, cy: d.cy, w: d.w, h: d.h, quad: (d.quad || boxQuad(d)).map((p) => [...p]),
      period: d.period, angle: d.angle,
      period2: d.period2, ratio: d.ratio, latticeAngle: d.latticeAngle,
      center: d.center ? { ...d.center } : null,
      contrast: d.contrast, sharp: d.sharp, hue: d.hue, sat: d.sat,
      score: d.score, cells: d.cells, level: d.level,
      members: d.members, count: d.count, evenness: d.evenness, size: d.size, receding: d.receding || 0,
      plane: d.plane || null,
      surface: d.surface ?? null, // which surface the camera motion puts it on
    };
  }

  function absorb(tr, d, t) {
    const dt = Math.max(1e-3, (t - tr.lastSeen) / 1000);
    const moved = tr.movedAt > tr.lastSeen;
    const sp = moved ? opt.smoothPosMoved : opt.smoothPos;
    const s = opt.smoothParam;
    const dq = alignQuad(tr.quad, d.quad || boxQuad(d));
    const ocx = tr.cx;
    const ocy = tr.cy;
    tr.quad = tr.quad.map(([x, y], i) => [lerp(x, dq[i][0], sp), lerp(y, dq[i][1], sp)]);
    boundQuad(tr);
    // without camera motion, the velocity comes from the sightings (with
    // it, from the motion itself: see warp)
    if (tr.misses === 0 && !moved) {
      tr.vx = lerp(tr.vx, (tr.cx - ocx) / dt, 0.5);
      tr.vy = lerp(tr.vy, (tr.cy - ocy) / dt, 0.5);
    }
    tr.period = Math.exp(lerp(Math.log(tr.period), Math.log(d.period), s));
    tr.ac = lerp(tr.ac, Math.cos((2 * d.angle) / DEG), s);
    tr.as = lerp(tr.as, Math.sin((2 * d.angle) / DEG), s);
    tr.angle = ((((Math.atan2(tr.as, tr.ac) * DEG) / 2) % 180) + 180) % 180;
    if (d.ratio) {
      tr.ratio = tr.ratio ? Math.exp(lerp(Math.log(tr.ratio), Math.log(d.ratio), s)) : d.ratio;
      tr.period2 = tr.period2 ? lerp(tr.period2, d.period2, s) : d.period2;
      tr.latticeAngle = tr.latticeAngle ? lerp(tr.latticeAngle, d.latticeAngle, s) : d.latticeAngle;
    }
    if (d.center) {
      tr.center = tr.center
        ? { x: lerp(tr.center.x, d.center.x, sp), y: lerp(tr.center.y, d.center.y, sp) }
        : { ...d.center };
    }
    // the surface's tilt, as last seen (a lost estimate keeps the old one
    // for a moment)
    if (d.surface != null) tr.surface = d.surface;
    if (d.plane) tr.plane = d.plane;
    else if (tr.plane && tr.hits % 4 === 0) tr.plane = null;
    tr.contrast = lerp(tr.contrast, d.contrast, s);
    tr.sharp = lerp(tr.sharp, d.sharp, s);
    tr.score = lerp(tr.score, d.score, s);
    tr.cells = d.cells;
    tr.level = d.level;
    if (d.members) {
      // a row's members are taken as seen (their number is the rhythm)
      tr.members = d.members;
      tr.count = d.count;
      tr.evenness = d.evenness;
      tr.size = d.size;
      tr.receding = d.receding || 0;
    }
    tr.hx = lerp(tr.hx, Math.cos(d.hue / DEG) * d.sat, s);
    tr.hy = lerp(tr.hy, Math.sin(d.hue / DEG) * d.sat, s);
    tr.sat = Math.hypot(tr.hx, tr.hy);
    tr.hue = ((Math.atan2(tr.hy, tr.hx) * DEG) + 360) % 360;

    for (const k in tr.votes) tr.votes[k] *= 0.8;
    tr.votes[d.type] = (tr.votes[d.type] || 0) + 1;
    tr.type = Object.keys(tr.votes).reduce((a, b) => (tr.votes[a] >= tr.votes[b] ? a : b));

    tr.hits++;
    tr.misses = 0;
    tr.lastSeen = t;
  }

  // Where did a lost pattern go? If it was near the border (or moving out),
  // remember the point on the border it left through.
  function exitOf(tr, view) {
    const m = opt.edgeMargin;
    const lead = 0.25;
    const px = tr.cx + tr.vx * lead;
    const py = tr.cy + tr.vy * lead;
    const touching =
      tr.cx - tr.w / 2 < m || tr.cy - tr.h / 2 < m ||
      tr.cx + tr.w / 2 > view.w - m || tr.cy + tr.h / 2 > view.h - m;
    const outside = px < m || py < m || px > view.w - m || py > view.h - m;
    const speed = Math.hypot(tr.vx, tr.vy);
    if (!outside && !(touching && speed > 0.05)) return { kind: 'vanish' };

    let dx = tr.vx;
    let dy = tr.vy;
    if (speed < 0.08) {
      dx = tr.cx - view.w / 2;
      dy = tr.cy - view.h / 2;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const ts = [];
    if (dx > 1e-6) ts.push([(view.w - tr.cx) / dx, 'right']);
    if (dx < -1e-6) ts.push([-tr.cx / dx, 'left']);
    if (dy > 1e-6) ts.push([(view.h - tr.cy) / dy, 'bottom']);
    if (dy < -1e-6) ts.push([-tr.cy / dy, 'top']);
    ts.sort((a, b) => a[0] - b[0]);
    const [tt, edge] = ts[0] || [0, 'right'];
    const x = Math.min(view.w, Math.max(0, tr.cx + dx * Math.max(0, tt)));
    const y = Math.min(view.h, Math.max(0, tr.cy + dy * Math.max(0, tt)));
    return { kind: 'edge', edge, x, y, dx, dy };
  }

  /**
   * @param dets   regions in normalised view units (short side = 1)
   * @param t      timestamp, ms
   * @param view   { w, h } view extent in the same units
   * @param fadeMsFor  (track) => fade duration in ms
   */
  function update(dets, t, view, fadeMsFor = () => 2000) {
    for (const tr of tracks) tr.resumed = false;

    const pairs = [];
    dets.forEach((d, j) => {
      tracks.forEach((tr, i) => {
        const c = cost(tr, d, t);
        if (c < Infinity) pairs.push([c, i, j]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set();
    const usedD = new Set();
    for (const [, i, j] of pairs) {
      if (usedT.has(i) || usedD.has(j)) continue;
      usedT.add(i);
      usedD.add(j);
      const tr = tracks[i];
      absorb(tr, dets[j], t);
      if (tr.state === 'fading') {
        tr.state = 'active';
        tr.resumed = true;
        tr.exit = null;
      }
    }

    // New candidates — unless they merely duplicate a pattern we already
    // follow (a region that split in two for a frame).
    dets.forEach((d, j) => {
      if (usedD.has(j)) return;
      const dup = tracks.some((tr) =>
        tr.family === d.family && tr.state !== 'fading' &&
        overlap(tr, d) > 0.3 && Math.abs(Math.log(d.period / tr.period)) < 0.3);
      if (!dup) tracks.push(create(d, t));
    });

    const alive = [];
    tracks.forEach((tr, i) => {
      if (!usedT.has(i) && tr.born !== t) tr.misses++;
      if (tr.state === 'cand') {
        if (tr.misses > opt.candMaxMisses) return;
        if (tr.misses === 0 && tr.hits >= opt.confirmHits && t - tr.born >= opt.confirmMs) {
          tr.state = 'active';
          tr.activatedAt = t;
        }
      } else if (tr.state === 'active') {
        if (t - tr.lastSeen > opt.lostGraceMs) {
          tr.state = 'fading';
          tr.fadeStart = t;
          tr.fadeMs = fadeMsFor(tr);
          tr.exit = exitOf(tr, view);
        }
      } else if (tr.state === 'fading') {
        if (t - tr.fadeStart > tr.fadeMs) return;
      }
      alive.push(tr);
    });
    tracks = alive;
    return tracks;
  }

  /**
   * Camera motion since the last call: H takes view-unit points of the
   * previous frame to this one — one homography for all tracks, or a
   * function giving each track its own (the surface it is on).
   */
  function warp(H, t) {
    const Hof = typeof H === 'function' ? H : () => H;
    for (const tr of tracks) {
      const ox = tr.cx;
      const oy = tr.cy;
      warpRegion(tr, Hof(tr));
      const dt = Math.max(1e-3, (t - (Number.isFinite(tr.movedAt) ? tr.movedAt : t - 33)) / 1000);
      tr.vx = lerp(tr.vx, (tr.cx - ox) / dt, 0.3);
      tr.vy = lerp(tr.vy, (tr.cy - oy) / dt, 0.3);
      tr.movedAt = t;
    }
  }

  function overlap(a, b) {
    const ix = Math.max(0, Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2));
    const iy = Math.max(0, Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2));
    return (ix * iy) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
  }

  return {
    update,
    warp,
    get tracks() {
      return tracks;
    },
    reset() {
      tracks = [];
    },
    options: opt,
  };
}
