// Ostinascope — the "pattern specimen" poster, drawn from a description
// (poster/poster.json): a palette and a list of elements, painted in order.
//
// Each element type below knows how to draw itself, which fields it has
// (the poster editor in tools/ builds its panels from them), its bounding
// box and how to move. The app only needs drawPoster(); nothing here
// depends on the editor.
//
// Coordinates are design px (1800 × 2546, A-series ratio); `scale` renders
// larger, e.g. 2 for a print test sheet. Colours are palette names or CSS.

import { mod, TO_RAD } from './util.js';
import { qrCode } from './qr.js';

export const POSTER_URL = new URL('../poster/poster.json', import.meta.url).href;
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const RAD = TO_RAD;

export async function loadPoster(url = POSTER_URL) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`poster: ${res.status} ${url}`);
  return res.json();
}

export function drawPoster(spec, scale = 1, doc = document) {
  const [W, H] = spec.size;
  const cv = doc.createElement('canvas');
  cv.width = Math.round(W * scale);
  cv.height = Math.round(H * scale);
  const g = cv.getContext('2d');
  g.scale(scale, scale);
  paint(g, spec);
  return cv;
}

// Paint onto an existing context (already scaled to design px).
export function paint(g, spec, { skip } = {}) {
  const ctx = context(spec);
  g.fillStyle = ctx.color('paper');
  g.fillRect(0, 0, spec.size[0], spec.size[1]);
  for (const el of spec.elements) {
    if (el.hidden || (skip && skip(el))) continue;
    drawElement(g, el, ctx);
  }
}

export function context(spec) {
  const pal = spec.palette || {};
  return { spec, unit: spec.unit || 12, color: (c) => (c && pal[c]) || c || 'transparent' };
}

export function drawElement(g, el, ctx) {
  const T = TYPES[el.type];
  if (!T) return;
  g.save();
  T.draw(g, el, ctx);
  g.restore();
}

// Bounding box {x0, y0, x1, y1} in design px (rotation ignored).
export function boundsOf(el, g, ctx) {
  const T = TYPES[el.type];
  return T ? T.bounds(el, g, ctx) : null;
}

// Move an element by (dx, dy) in place.
export function moveElement(el, dx, dy) {
  const T = TYPES[el.type];
  (T && T.move ? T.move : moveXY)(el, dx, dy);
}

// A new element of a type, centred on (x, y).
export function createElement(type, x, y) {
  const el = structuredClone(TYPES[type].make());
  moveElement(el, x - (el.x ?? 0), y - (el.y ?? 0));
  return el;
}

// --------------------------------------------------------------------------
// helpers

function moveXY(el, dx, dy) {
  el.x += dx;
  el.y += dy;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });

// --------------------------------------------------------------------------
// debris pieces: { shape, x, y, r, rotation (°), color }

export const PIECE_SHAPES = ['tri', 'disc', 'bar'];

// The pieces a seeded debris element draws (triangle, disc, bar in turn).
export function debrisPieces(el) {
  const rnd = rng(el.seed);
  const out = [];
  for (let i = 0; i < el.count; i++) {
    const x = el.x + rnd() * el.w;
    const y = el.y + rnd() * el.h;
    const r = el.rMin + rnd() * (el.rMax - el.rMin);
    const shape = PIECE_SHAPES[i % 3];
    out.push({ shape, x, y, r, rotation: shape === 'bar' ? rnd() * 180 : 0, color: el.colors[i % el.colors.length] });
  }
  return out;
}

// The smallest circle around a piece: { x, y, R }. A triangle's apex is r
// above (x, y) and its base r below, so its circle is centred r/4 lower.
export function pieceCircle(p) {
  if (p.shape === 'disc') return { x: p.x, y: p.y, R: p.r };
  if (p.shape === 'bar') return { x: p.x, y: p.y, R: Math.hypot(p.r, p.r / 3) };
  const a = (p.rotation || 0) * RAD;
  return { x: p.x - Math.sin(a) * (p.r / 4), y: p.y + Math.cos(a) * (p.r / 4), R: 1.25 * p.r };
}

function drawPiece(g, p, color) {
  const { x, y, r } = p;
  g.fillStyle = color(p.color);
  if (p.shape === 'disc') {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    return;
  }
  g.save();
  if (p.rotation) {
    g.translate(x, y);
    g.rotate(p.rotation * RAD);
    g.translate(-x, -y);
  }
  if (p.shape === 'bar') {
    g.fillRect(x - r, y - r / 3, 2 * r, (2 * r) / 3);
  } else {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y + r);
    g.lineTo(x - r, y + r);
    g.closePath();
    g.fill();
  }
  g.restore();
}

// first value ≥ lo on the lattice phase + k·step
const firstOnLattice = (phase, step, lo) => phase + Math.ceil((lo - phase) / step) * step;

// --------------------------------------------------------------------------
// pattern figures: a clip shape (circle, rect, polygon, annulus), an optional
// fill, a repeating pattern inside and an optional outline

const SHAPES = {
  circle: {
    path(g, s) {
      g.beginPath();
      g.arc(0, 0, s.r, 0, Math.PI * 2);
    },
    radius: (s) => s.r,
    outline(g, s, o) {
      g.lineWidth = o.width;
      g.beginPath();
      g.arc(0, 0, s.r, 0, Math.PI * 2);
      g.stroke();
    },
  },
  rect: {
    path(g, s) {
      g.beginPath();
      g.rect(-s.w / 2, -s.h / 2, s.w, s.h);
    },
    radius: (s) => Math.hypot(s.w, s.h) / 2,
    outline(g, s, o) {
      g.lineWidth = o.width;
      g.beginPath();
      g.rect(-s.w / 2, -s.h / 2, s.w, s.h);
      g.stroke();
    },
  },
  polygon: {
    path(g, s) {
      g.beginPath();
      s.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    },
    radius: (s) => Math.max(...s.points.map(([x, y]) => Math.hypot(x, y))),
    outline(g, s, o) {
      g.lineWidth = o.width;
      SHAPES.polygon.path(g, s);
      g.stroke();
    },
  },
  annulus: {
    path(g, s) {
      g.beginPath();
      g.arc(0, 0, s.r, 0, Math.PI * 2);
      g.arc(0, 0, s.r0, 0, Math.PI * 2, true);
    },
    rule: 'evenodd',
    radius: (s) => s.r,
    outline(g, s, o) {
      for (const [r, w] of [[s.r, o.width], [s.r0, o.innerWidth ?? o.width]]) {
        if (!(w > 0)) continue;
        g.lineWidth = w;
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.stroke();
      }
    },
  },
};

// Patterns are drawn around the figure's centre, over a square of half-side
// E that covers the shape; the clip trims them.
const PATTERNS = {
  none: { draw() {} },
  // parallel bands; `angle` is the line orientation (deg, CCW from +x),
  // `phase` the offset of one band's edge from the centre
  stripes: {
    draw(g, p, E, color) {
      g.rotate((-p.angle * Math.PI) / 180);
      g.fillStyle = color(p.color);
      for (let y = firstOnLattice(p.phase || 0, p.period, -E - p.period); y < E; y += p.period) {
        g.fillRect(-E, y, 2 * E, p.period * p.duty);
      }
    },
  },
  grid: {
    draw(g, p, E, color) {
      const [ox, oy] = p.phase || [0, 0];
      g.fillStyle = color(p.color);
      for (let x = firstOnLattice(ox, p.px, -E - p.px); x < E; x += p.px) g.fillRect(x, -E, p.lineWidth, 2 * E);
      for (let y = firstOnLattice(oy, p.py, -E - p.py); y < E; y += p.py) g.fillRect(-E, y, 2 * E, p.lineWidth);
    },
  },
  hexdots: {
    draw(g, p, E, color) {
      const [ox, oy] = p.phase || [0, 0];
      const rowH = (p.a * Math.sqrt(3)) / 2;
      g.fillStyle = color(p.color);
      const j0 = Math.ceil((-E - p.a - oy) / rowH);
      for (let j = j0; oy + j * rowH < E + p.a; j++) {
        const yy = oy + j * rowH;
        const sx = ox + (mod(j, 2) ? p.a / 2 : 0);
        for (let xx = firstOnLattice(sx, p.a, -E - p.a); xx < E + p.a; xx += p.a) {
          g.beginPath();
          g.arc(xx, yy, p.r, 0, Math.PI * 2);
          g.fill();
        }
      }
    },
  },
  rings: {
    draw(g, p, E, color, R) {
      g.strokeStyle = color(p.color);
      g.lineWidth = p.lineWidth;
      for (let r = p.r0; r < R + p.lineWidth; r += p.dr) {
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.stroke();
      }
    },
  },
  // n alternating wedges (n/2 dark ones); `duty` is the dark share of each
  // pair (0.5 = equal wedges, small = thin spokes)
  rays: {
    draw(g, p, E, color, R) {
      g.fillStyle = color(p.color);
      const w = 2 * (p.duty ?? 0.5);
      for (let k = 0; k < p.n; k += 2) {
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, R + 10, (k / p.n) * Math.PI * 2, ((k + w) / p.n) * Math.PI * 2);
        g.closePath();
        g.fill();
      }
    },
  },
};

function drawPattern(g, el, ctx) {
  const S = SHAPES[el.shape.kind];
  g.translate(el.x, el.y);
  if (el.rotation) g.rotate((el.rotation * Math.PI) / 180);
  const R = S.radius(el.shape);
  g.save();
  S.path(g, el.shape);
  if (el.fill) {
    g.fillStyle = ctx.color(el.fill);
    g.fill(S.rule || 'nonzero');
  }
  g.clip(S.rule || 'nonzero');
  const P = PATTERNS[el.pattern.kind] || PATTERNS.none;
  const E = Math.ceil(R) + 2;
  P.draw(g, el.pattern, E, ctx.color, R);
  g.restore();
  if (el.outline && el.outline.width > 0) {
    g.strokeStyle = ctx.color(el.outline.color);
    S.outline(g, el.shape, el.outline);
  }
}

// motifs for rows of look-alikes, standing on (x, y)
const MOTIFS = {
  // neck, shoulders, a label band
  bottle(g, x, y, el, color) {
    const k = el.size;
    g.fillStyle = color(el.color);
    g.fillRect(x - 9 * k, y - 132 * k, 18 * k, 36 * k);
    g.beginPath();
    g.moveTo(x - 9 * k, y - 96 * k);
    g.lineTo(x - 30 * k, y - 72 * k);
    g.lineTo(x - 30 * k, y);
    g.lineTo(x + 30 * k, y);
    g.lineTo(x + 30 * k, y - 72 * k);
    g.lineTo(x + 9 * k, y - 96 * k);
    g.closePath();
    g.fill();
    g.fillStyle = color(el.accent);
    g.fillRect(x - 30 * k, y - 52 * k, 60 * k, 24 * k);
    g.fillStyle = color(el.detail);
    g.fillRect(x - 18 * k, y - 46 * k, 36 * k, 4 * k);
  },
  // a book spine: two bands and a title block
  book(g, x, y, el, color) {
    const w = el.w * el.size;
    const h = el.h * el.size;
    g.fillStyle = color(el.color);
    g.fillRect(x - w / 2, y - h, w, h);
    g.fillStyle = color(el.accent);
    g.fillRect(x - w / 2, y - h + h * 0.08, w, h * 0.05);
    g.fillRect(x - w / 2, y - h * 0.13, w, h * 0.05);
    g.fillStyle = color(el.detail);
    g.fillRect(x - w * 0.22, y - h * 0.7, w * 0.44, h * 0.3);
  },
  // a plain block (crosswalk bar, fence board, key…)
  block(g, x, y, el, color) {
    const w = el.w * el.size;
    const h = el.h * el.size;
    g.fillStyle = color(el.color);
    g.fillRect(x - w / 2, y - h, w, h);
  },
  // a cup: body, handle, a band
  cup(g, x, y, el, color) {
    const w = el.w * el.size;
    const h = el.h * el.size;
    g.fillStyle = color(el.color);
    g.beginPath();
    g.moveTo(x - w / 2, y - h);
    g.lineTo(x + w / 2, y - h);
    g.lineTo(x + w * 0.4, y);
    g.lineTo(x - w * 0.4, y);
    g.closePath();
    g.fill();
    g.strokeStyle = color(el.color);
    g.lineWidth = w * 0.12;
    g.beginPath();
    g.arc(x + w * 0.5, y - h * 0.55, h * 0.22, -Math.PI / 2, Math.PI / 2);
    g.stroke();
    g.fillStyle = color(el.accent);
    g.fillRect(x - w * 0.46, y - h * 0.75, w * 0.92, h * 0.16);
  },
};

const motifHeight = (el) => (el.motif === 'bottle' ? 132 : el.h) * el.size;
const motifWidth = (el) => (el.motif === 'bottle' ? 60 : el.w) * el.size;

function rowXs(el, unit) {
  const xs = [el.x];
  for (const gap of el.gaps) xs.push(xs[xs.length - 1] + gap * unit);
  return xs;
}

// --------------------------------------------------------------------------
// field descriptions (for the editor). `when` hides a field that does not
// apply; dotted keys reach into nested objects.

const F = {
  num: (key, label, step = 1, min, max) => ({ key, label, type: 'number', step, min, max }),
  color: (key, label = '色') => ({ key, label, type: 'color' }),
  text: (key, label) => ({ key, label, type: 'text' }),
};
const XY = [F.num('x', 'x'), F.num('y', 'y')];
const shapeIs = (k) => (el) => el.shape.kind === k;
const patIs = (...k) => (el) => k.includes(el.pattern.kind);

const PATTERN_FIELDS = [
  ...XY,
  F.num('rotation', '回転°', 1),
  { key: 'shape.kind', label: '形', type: 'select', options: Object.keys(SHAPES) },
  { ...F.num('shape.r', '半径'), when: (el) => ['circle', 'annulus'].includes(el.shape.kind) },
  { ...F.num('shape.r0', '内径'), when: shapeIs('annulus') },
  { ...F.num('shape.w', '幅'), when: shapeIs('rect') },
  { ...F.num('shape.h', '高さ'), when: shapeIs('rect') },
  { key: 'shape.points', label: '頂点 (x,y; …)', type: 'points', when: shapeIs('polygon') },
  { key: 'fill', label: '地の色（空=なし）', type: 'color', optional: true },
  { key: 'pattern.kind', label: '模様', type: 'select', options: Object.keys(PATTERNS) },
  { ...F.color('pattern.color', '模様の色'), when: patIs('stripes', 'grid', 'hexdots', 'rings', 'rays') },
  { ...F.num('pattern.period', '間隔'), when: patIs('stripes') },
  { ...F.num('pattern.angle', '線の向き°'), when: patIs('stripes') },
  { ...F.num('pattern.duty', '線の太さ比', 0.01, 0.02, 0.98), when: patIs('stripes', 'rays') },
  { ...F.num('pattern.phase', '位相'), when: patIs('stripes') },
  { ...F.num('pattern.px', '横の間隔'), when: patIs('grid') },
  { ...F.num('pattern.py', '縦の間隔'), when: patIs('grid') },
  { ...F.num('pattern.lineWidth', '線幅', 0.5), when: patIs('grid', 'rings') },
  { ...F.num('pattern.a', '点の間隔'), when: patIs('hexdots') },
  { ...F.num('pattern.r', '点の半径', 0.5), when: patIs('hexdots') },
  { key: 'pattern.phase', label: '位相 (x,y)', type: 'numbers', when: patIs('grid', 'hexdots') },
  { ...F.num('pattern.r0', '最初の半径'), when: patIs('rings') },
  { ...F.num('pattern.dr', '輪の間隔'), when: patIs('rings') },
  { ...F.num('pattern.n', '本数', 2, 4), when: patIs('rays') },
  F.num('outline.width', '輪郭の太さ', 0.5, 0),
  { ...F.num('outline.innerWidth', '内側の輪郭', 0.5, 0), when: shapeIs('annulus') },
  F.color('outline.color', '輪郭の色'),
];

// Defaults when switching the pattern kind in the editor.
export const PATTERN_DEFAULTS = {
  none: { kind: 'none' },
  stripes: { kind: 'stripes', period: 24, angle: 0, duty: 0.5, phase: 0, color: 'ink' },
  grid: { kind: 'grid', px: 36, py: 48, lineWidth: 6, phase: [0, 0], color: 'ink' },
  hexdots: { kind: 'hexdots', a: 30, r: 7.5, phase: [0, 0], color: 'ink' },
  rings: { kind: 'rings', r0: 14, dr: 20, lineWidth: 9, color: 'ink' },
  rays: { kind: 'rays', n: 96, duty: 0.5, color: 'ink' },
};
export const SHAPE_DEFAULTS = {
  circle: { kind: 'circle', r: 200 },
  rect: { kind: 'rect', w: 400, h: 300 },
  polygon: { kind: 'polygon', points: [[0, -200], [220, 180], [-220, 180]] },
  annulus: { kind: 'annulus', r: 220, r0: 60 },
};

// --------------------------------------------------------------------------
// element types

export const TYPES = {
  pattern: {
    label: '模様の図形',
    draw: drawPattern,
    bounds(el) {
      const R = SHAPES[el.shape.kind].radius(el.shape);
      if (el.shape.kind === 'rect' && !el.rotation) {
        return box(el.x - el.shape.w / 2, el.y - el.shape.h / 2, el.x + el.shape.w / 2, el.y + el.shape.h / 2);
      }
      return box(el.x - R, el.y - R, el.x + R, el.y + R);
    },
    fields: PATTERN_FIELDS,
    make: () => ({ type: 'pattern', x: 0, y: 0, rotation: 0, shape: { ...SHAPE_DEFAULTS.circle }, fill: '',
      pattern: { ...PATTERN_DEFAULTS.stripes }, outline: { width: 0, color: 'ink' } }),
  },

  repeat: {
    label: '図形の繰り返し',
    draw(g, el, ctx) {
      for (let j = 0; j < el.ny; j++) {
        for (let i = 0; i < el.nx; i++) {
          g.save();
          g.translate(el.x + i * el.dx, el.y + j * el.dy);
          drawElement(g, el.child, ctx);
          g.restore();
        }
      }
    },
    bounds(el, g, ctx) {
      const b = TYPES[el.child.type].bounds(el.child, g, ctx);
      return box(el.x + b.x0, el.y + b.y0, el.x + b.x1 + (el.nx - 1) * el.dx, el.y + b.y1 + (el.ny - 1) * el.dy);
    },
    fields: [
      ...XY,
      F.num('nx', '横の数', 1, 1), F.num('ny', '縦の数', 1, 1), F.num('dx', '横の間隔'), F.num('dy', '縦の間隔'),
      ...PATTERN_FIELDS.filter((f) => f.key !== 'x' && f.key !== 'y').map((f) => ({
        ...f, key: 'child.' + f.key, when: f.when && ((el) => f.when(el.child)),
      })),
    ],
    make: () => ({ type: 'repeat', x: 0, y: 0, nx: 3, ny: 3, dx: 124, dy: 124, child: { ...TYPES.pattern.make(),
      shape: { kind: 'circle', r: 46 }, pattern: { ...PATTERN_DEFAULTS.stripes, period: 12, angle: 90 } } }),
  },

  row: {
    label: '似たものの並び',
    draw(g, el, ctx) {
      for (const x of rowXs(el, ctx.unit)) MOTIFS[el.motif](g, x, el.y, el, ctx.color);
    },
    bounds(el, g, ctx) {
      const xs = rowXs(el, ctx.unit);
      const w = motifWidth(el);
      return box(xs[0] - w / 2, el.y - motifHeight(el), xs[xs.length - 1] + w / 2, el.y);
    },
    fields: [
      ...XY,
      { key: 'motif', label: 'モチーフ', type: 'select', options: Object.keys(MOTIFS) },
      { key: 'gaps', label: '間隔 (u, …)', type: 'numbers' },
      F.num('size', '大きさ', 0.05, 0.1),
      { ...F.num('w', '幅'), when: (el) => el.motif !== 'bottle' },
      { ...F.num('h', '高さ'), when: (el) => el.motif !== 'bottle' },
      F.color('color', '本体の色'), F.color('accent', '帯の色'), F.color('detail', '細部の色'),
    ],
    make: () => ({ type: 'row', x: 0, y: 0, gaps: [10, 10, 10, 10], motif: 'book', size: 1, w: 40, h: 150,
      color: 'ink', accent: 'red', detail: 'paper' }),
  },

  rect: {
    label: '四角',
    draw(g, el, ctx) {
      g.fillStyle = ctx.color(el.color);
      if (el.rotation) {
        g.translate(el.x + el.w / 2, el.y + el.h / 2);
        g.rotate(el.rotation * RAD);
        g.fillRect(-el.w / 2, -el.h / 2, el.w, el.h);
      } else {
        g.fillRect(el.x, el.y, el.w, el.h);
      }
    },
    bounds: (el) => box(el.x, el.y, el.x + el.w, el.y + el.h),
    fields: [...XY, F.num('w', '幅'), F.num('h', '高さ'), F.num('rotation', '回転°'), F.color('color')],
    make: () => ({ type: 'rect', x: -150, y: -50, w: 300, h: 100, rotation: 0, color: 'ink' }),
  },

  disc: {
    label: '円・扇形',
    draw(g, el, ctx) {
      g.fillStyle = ctx.color(el.color);
      g.beginPath();
      if ((el.end - el.start) % 360 !== 0) g.moveTo(el.x, el.y);
      g.arc(el.x, el.y, el.r, el.start * RAD, el.end * RAD);
      g.fill();
    },
    bounds: (el) => box(el.x - el.r, el.y - el.r, el.x + el.r, el.y + el.r),
    fields: [...XY, F.num('r', '半径'), F.num('start', '開始角°'), F.num('end', '終了角°'), F.color('color')],
    make: () => ({ type: 'disc', x: 0, y: 0, r: 80, start: 0, end: 360, color: 'red' }),
  },

  arc: {
    label: '弧',
    draw(g, el, ctx) {
      g.strokeStyle = ctx.color(el.color);
      g.lineWidth = el.width;
      g.lineCap = 'round';
      g.beginPath();
      g.arc(el.x, el.y, el.r, el.start * RAD, el.end * RAD);
      g.stroke();
    },
    bounds: (el) => box(el.x - el.r, el.y - el.r, el.x + el.r, el.y + el.r),
    fields: [...XY, F.num('r', '半径'), F.num('start', '開始角°'), F.num('end', '終了角°'), F.num('width', '太さ', 0.5), F.color('color')],
    make: () => ({ type: 'arc', x: 0, y: 0, r: 120, start: 180, end: 300, width: 4, color: 'ink' }),
  },

  line: {
    label: '線',
    draw(g, el, ctx) {
      g.strokeStyle = ctx.color(el.color);
      g.lineWidth = el.width;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(el.x0, el.y0);
      g.lineTo(el.x1, el.y1);
      g.stroke();
    },
    bounds: (el) => box(Math.min(el.x0, el.x1) - 6, Math.min(el.y0, el.y1) - 6, Math.max(el.x0, el.x1) + 6, Math.max(el.y0, el.y1) + 6),
    move(el, dx, dy) {
      el.x0 += dx;
      el.x1 += dx;
      el.y0 += dy;
      el.y1 += dy;
    },
    fields: [F.num('x0', 'x0'), F.num('y0', 'y0'), F.num('x1', 'x1'), F.num('y1', 'y1'), F.num('width', '太さ', 0.5), F.color('color')],
    make: () => ({ type: 'line', x0: -200, y0: 0, x1: 200, y1: 0, width: 3, color: 'ink' }),
  },

  text: {
    label: '文字',
    draw(g, el, ctx) {
      g.fillStyle = ctx.color(el.color);
      g.font = `${el.weight} ${el.size}px ${MONO}`;
      el.lines.forEach((line, i) => g.fillText(line, el.x, el.y + i * el.leading));
    },
    bounds(el, g) {
      g.save();
      g.font = `${el.weight} ${el.size}px ${MONO}`;
      const w = Math.max(0, ...el.lines.map((l) => g.measureText(l).width));
      g.restore();
      return box(el.x, el.y - el.size, el.x + w, el.y + (el.lines.length - 1) * el.leading + el.size * 0.3);
    },
    fields: [
      ...XY, { key: 'lines', label: '本文', type: 'lines' },
      F.num('size', '文字の大きさ', 0.5, 4), { key: 'weight', label: '太さ', type: 'select', options: [400, 500, 700] },
      F.num('leading', '行送り', 0.5), F.color('color'),
    ],
    make: () => ({ type: 'text', x: -200, y: 0, size: 19, weight: 500, leading: 30, color: 'ink', lines: ['text'] }),
  },

  caption: {
    label: '注記',
    draw(g, el, ctx) {
      g.fillStyle = ctx.color(el.color || 'ink');
      g.font = `500 17px ${MONO}`;
      g.fillText(el.text, el.x, el.y);
      if (!el.leader) return;
      g.strokeStyle = ctx.color(el.color || 'ink');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(el.x, el.y - 22);
      g.lineTo(el.lx, el.ly);
      g.stroke();
      g.beginPath();
      g.arc(el.lx, el.ly, 3, 0, Math.PI * 2);
      g.fill();
    },
    bounds(el, g) {
      g.save();
      g.font = `500 17px ${MONO}`;
      const w = g.measureText(el.text).width;
      g.restore();
      return box(el.x, el.y - 17, el.x + w, el.y + 5);
    },
    fields: [
      ...XY, F.text('text', '文'), { key: 'leader', label: '引き出し線', type: 'bool' },
      { ...F.num('lx', '線の先 x'), when: (el) => el.leader }, { ...F.num('ly', '線の先 y'), when: (el) => el.leader },
    ],
    make: () => ({ type: 'caption', x: 0, y: 0, lx: 20, ly: -60, leader: true, text: 'fig.  ' }),
  },

  frame: {
    label: '枠と目盛り',
    draw(g, el, ctx) {
      const [W, H] = ctx.spec.size;
      // the frame is a whole number of ticks each way (its corners sit on
      // ticks), centred; margin is the least space around it
      const TICK = 30;
      const fw = Math.floor((W - 2 * el.margin) / TICK) * TICK;
      const fh = Math.floor((H - 2 * el.margin) / TICK) * TICK;
      const x0 = (W - fw) / 2;
      const y0 = (H - fh) / 2;
      g.strokeStyle = ctx.color(el.color);
      g.lineWidth = 1.5;
      g.strokeRect(x0, y0, fw, fh);
      g.font = `400 13px ${MONO}`;
      g.fillStyle = ctx.color(el.color);
      for (let d = 0; d <= fw; d += TICK) {
        const x = x0 + d;
        const major = d % (10 * TICK) === 0;
        g.fillRect(x, y0 - (major ? 18 : 8), 1, major ? 18 : 8);
        g.fillRect(x, y0 + fh, 1, major ? 18 : 8);
        if (major) g.fillText(String(d), x + 4, y0 - 20);
      }
      for (let d = 0; d <= fh; d += TICK) {
        const y = y0 + d;
        const major = d % (10 * TICK) === 0;
        g.fillRect(x0 - (major ? 18 : 8), y, major ? 18 : 8, 1);
        g.fillRect(x0 + fw, y, major ? 18 : 8, 1);
        if (major) {
          g.save();
          g.translate(x0 - 26, y - 4);
          g.rotate(-Math.PI / 2);
          g.fillText(String(d), 0, 0);
          g.restore();
        }
      }
    },
    bounds: (el, g, ctx) => box(0, 0, ctx.spec.size[0], el.margin),
    move() {},
    fields: [F.num('margin', '余白（最小）'), F.color('color')],
    make: () => ({ type: 'frame', margin: 70, color: 'ink' }),
  },

  // non-repeating Kandinsky debris: triangles, discs and bars in turn, from
  // a seed. Once split (the editor's "ばらす" / "隙間に撒く"), the pieces are
  // elements of their own (`piece`, linked to this one) and this element
  // only keeps the area and the settings for scattering them again.
  debris: {
    label: 'がらくた（ランダム）',
    draw(g, el, ctx) {
      if (el.split) return;
      g.globalAlpha = el.alpha;
      for (const p of debrisPieces(el)) drawPiece(g, p, ctx.color);
    },
    bounds: (el) => box(el.x, el.y, el.x + el.w, el.y + el.h),
    fields: [
      ...XY, F.num('w', '範囲の幅'), F.num('h', '範囲の高さ'), F.num('seed', '乱数の種'), F.num('count', '個数', 1, 0),
      F.num('rMin', '最小'), F.num('rMax', '最大'), { key: 'colors', label: '色 (…, …)', type: 'colors' },
      F.num('alpha', '不透明度', 0.05, 0, 1),
      { ...F.num('gap', 'ほかとの隙間', 1, 0), optional: true },
    ],
    make: () => ({ type: 'debris', x: -300, y: -300, w: 600, h: 600, seed: 1, count: 12, rMin: 8, rMax: 40,
      colors: ['red', 'yellow', 'blue', 'ink'], alpha: 0.9, gap: 24 }),
  },

  // one piece of debris
  piece: {
    label: 'がらくた（1 個）',
    draw(g, el, ctx) {
      g.globalAlpha = el.alpha ?? 1;
      drawPiece(g, el, ctx.color);
    },
    bounds(el) {
      if (el.shape === 'disc' || (el.shape === 'tri' && !el.rotation)) return box(el.x - el.r, el.y - el.r, el.x + el.r, el.y + el.r);
      const c = pieceCircle(el);
      return box(c.x - c.R, c.y - c.R, c.x + c.R, c.y + c.R);
    },
    fields: [
      ...XY, { key: 'shape', label: '形', type: 'select', options: PIECE_SHAPES }, F.num('r', '大きさ', 0.5, 1),
      F.num('rotation', '回転°'), F.color('color'), F.num('alpha', '不透明度', 0.05, 0, 1),
      { key: 'pin', label: '固定（撒き直しても残す）', type: 'bool', optional: true },
    ],
    make: () => ({ type: 'piece', x: 0, y: 0, shape: 'tri', r: 30, rotation: 0, color: 'red', alpha: 0.9 }),
  },

  scatter: {
    label: '点の散らばり（ランダム）',
    draw(g, el, ctx) {
      const rnd = rng(el.seed);
      g.fillStyle = ctx.color(el.color);
      for (let i = 0; i < el.count; i++) {
        g.beginPath();
        g.arc(el.x + rnd() * el.w, el.y + rnd() * el.h, el.rMin + rnd() * (el.rMax - el.rMin), 0, Math.PI * 2);
        g.fill();
      }
    },
    bounds: (el) => box(el.x, el.y, el.x + el.w, el.y + el.h),
    fields: [
      ...XY, F.num('w', '範囲の幅'), F.num('h', '範囲の高さ'), F.num('seed', '乱数の種'), F.num('count', '個数', 1, 0),
      F.num('rMin', '最小', 0.5), F.num('rMax', '最大', 0.5), F.color('color'),
    ],
    make: () => ({ type: 'scatter', x: -300, y: -300, w: 600, h: 600, seed: 1, count: 30, rMin: 1.5, rMax: 5, color: 'ink' }),
  },

  // a small checkerboard (too small to count as a pattern on its own)
  checker: {
    label: '市松',
    draw(g, el, ctx) {
      g.fillStyle = ctx.color(el.color);
      for (let j = 0; j < el.ny; j++) {
        for (let i = 0; i < el.nx; i++) if (!((i + j) % 2)) g.fillRect(el.x + i * el.size, el.y + j * el.size, el.size, el.size);
      }
    },
    bounds: (el) => box(el.x, el.y, el.x + el.nx * el.size, el.y + el.ny * el.size),
    fields: [...XY, F.num('nx', '横の数', 1, 1), F.num('ny', '縦の数', 1, 1), F.num('size', 'マスの大きさ'), F.color('color')],
    make: () => ({ type: 'checker', x: -28, y: -28, nx: 4, ny: 4, size: 14, color: 'ink' }),
  },

  // a QR code (the app's address): whole-px modules, so the print is crisp,
  // with the standard's quiet zone of 4 modules in the ground colour
  qr: {
    label: '2 次元コード',
    draw(g, el, ctx) {
      const m = qrOf(el);
      const q = 4;
      const s = el.module;
      const n = m.length + 2 * q;
      g.fillStyle = ctx.color(el.bg);
      g.fillRect(el.x, el.y, n * s, n * s);
      g.fillStyle = ctx.color(el.color);
      for (let y = 0; y < m.length; y++) {
        // a run of dark modules as one rectangle (no seams between them)
        for (let x = 0; x < m.length; x++) {
          if (!m[y][x]) continue;
          let e = x;
          while (e + 1 < m.length && m[y][e + 1]) e++;
          g.fillRect(el.x + (x + q) * s, el.y + (y + q) * s, (e - x + 1) * s, s);
          x = e;
        }
      }
    },
    bounds: (el) => {
      const n = qrOf(el).length + 8;
      return box(el.x, el.y, el.x + n * el.module, el.y + n * el.module);
    },
    fields: [...XY, F.text('text', '載せる文字（URL）'), F.num('module', '1 マスの大きさ', 1, 1), F.color('color'), F.color('bg', '地の色')],
    make: () => ({ type: 'qr', x: 0, y: 0, text: 'https://trow16.github.io/ostinascope/', module: 6, color: 'ink', bg: 'paper' }),
  },
};

// QR modules of an element, made once per text
const qrCache = new Map();
function qrOf(el) {
  const key = String(el.text || ' ');
  if (!qrCache.has(key)) {
    if (qrCache.size > 32) qrCache.clear();
    qrCache.set(key, qrCode(key, 'M'));
  }
  return qrCache.get(key);
}
