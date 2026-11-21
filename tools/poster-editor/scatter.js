// Scatter debris pieces into the free space of the poster.
//
// The editor paints every other element onto a transparent canvas; whatever
// it covers (alpha > ½) is taken, so pale discs can still have debris on
// them while figures, text and paper-coloured masks cannot. The distance to
// the nearest taken cell tells where a piece fits: its circle plus the gap
// must stay clear of everything taken, of the other pieces, and inside the
// debris area. No canvas here, so it runs (and is tested) in Node too.

import { rng, pieceCircle, PIECE_SHAPES } from '../../src/poster.js';

// Euclidean distance (in cells) from each cell to the nearest taken cell:
// Felzenszwalb & Huttenlocher's two passes of 1-D lower envelopes.
export function distanceField(taken, w, h) {
  const INF = 1e20;
  const f = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = taken[i] ? 0 : INF;
  const n = Math.max(w, h);
  const line = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (len) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      for (;;) {
        const p = v[k];
        s = ((line[q] + q * q) - (line[p] + p * p)) / (2 * q - 2 * p);
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const d = q - v[k];
      out[q] = d * d + line[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = f[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) f[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = f[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) f[y * w + x] = out[x];
  }
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = Math.sqrt(f[i]);
  return d;
}

// field: { dist, w, h, scale } (scale: cells per design px)
// area:  { x0, y0, x1, y1 } in design px
// opt:   { count, rMin, rMax, gap, colors, seed, tries, choose }
// keep:  pieces that stay (they count towards `count` and are avoided)
// → { pieces, wanted, placed }; shapes and colours go round in turn
export function scatterPieces(field, area, opt, keep = []) {
  const { dist, w, h, scale } = field;
  const gap = opt.gap ?? 24;
  const tries = opt.tries ?? 600;
  const choose = opt.choose ?? 3; // best of a few fits: spread out, not even
  const rnd = rng(opt.seed);
  const placed = keep.map(pieceCircle);
  const clearance = (x, y) => {
    const cx = Math.round(x * scale);
    const cy = Math.round(y * scale);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return 0;
    return dist[cy * w + cx] / scale - 1 / scale; // a cell of slack
  };
  const pieces = [];
  const n = Math.max(0, opt.count - keep.length);
  for (let i = 0; i < n; i++) {
    const k = keep.length + i;
    const shape = PIECE_SHAPES[k % PIECE_SHAPES.length];
    const color = opt.colors[k % opt.colors.length];
    let r = opt.rMin + rnd() * (opt.rMax - opt.rMin);
    // any angle for a triangle (no symmetry), half a turn for a bar
    const turn = { tri: 360, bar: 180 }[shape] || 0;
    const rotation = turn ? Math.round(rnd() * turn * 10) / 10 : 0;
    let best = null;
    // shrink a piece that does not fit anywhere, down to rMin
    for (let shrink = 0; shrink < 4 && !best; shrink++) {
      let fits = 0;
      let bestRoom = -Infinity;
      for (let t = 0; t < tries && fits < choose; t++) {
        const p = { shape, x: 0, y: 0, r, rotation, color };
        p.x = area.x0 + rnd() * (area.x1 - area.x0);
        p.y = area.y0 + rnd() * (area.y1 - area.y0);
        const c = pieceCircle(p);
        if (c.x - c.R < area.x0 || c.x + c.R > area.x1 || c.y - c.R < area.y0 || c.y + c.R > area.y1) continue;
        if (clearance(c.x, c.y) < c.R + gap) continue;
        let room = Infinity;
        for (const q of placed) room = Math.min(room, Math.hypot(c.x - q.x, c.y - q.y) - c.R - q.R);
        if (room < gap) continue;
        fits++;
        if (room > bestRoom) {
          bestRoom = room;
          best = p;
        }
      }
      if (!best) r = Math.max(opt.rMin, r * 0.8);
      if (!best && r === opt.rMin && shrink > 0) break;
    }
    if (!best) continue;
    best.x = Math.round(best.x);
    best.y = Math.round(best.y);
    best.r = Math.round(best.r * 10) / 10;
    placed.push(pieceCircle(best));
    pieces.push(best);
  }
  return { pieces, wanted: n, placed: pieces.length };
}
