// Ostinascope — a generated "pattern specimen" poster for the demo mode
// (and a first sketch of the layout rules: looks scattered, every figure
// hides a different kind of repetition, spacings in 3 : 4 : 5).
//
// Design space is 1800 × 2546 (A-series ratio); `scale` renders larger
// (e.g. 2 for printing a test sheet).

export const POSTER_W = 1800;
export const POSTER_H = 2546;
const U = 12; // base unit (px in design space)

const PAPER = '#EFEAE0';
const INK = '#141414';
const RED = '#D7262B';
const YELLOW = '#F2C200';
const BLUE = '#1F4FD1';
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function drawPoster(scale = 1, doc = document) {
  const cv = doc.createElement('canvas');
  cv.width = Math.round(POSTER_W * scale);
  cv.height = Math.round(POSTER_H * scale);
  const g = cv.getContext('2d');
  g.scale(scale, scale);
  const rnd = rng(1926); // "Punkt und Linie zu Fläche"

  g.fillStyle = PAPER;
  g.fillRect(0, 0, POSTER_W, POSTER_H);

  frame(g);
  clutterUnder(g, rnd);

  // fig.1 STRIPE — fine diagonal stripes in a big circle (p = 2u)
  clipCircle(g, 520, 720, 300, () => stripes(g, 520, 720, 640, 2 * U, 30, 0.45, INK));
  ring(g, 520, 720, 300, 5, INK);
  caption(g, 'fig.1  STRIPE   p = 2u   θ = 30°', 250, 1060, 240, 1020);

  // fig.2 GRID 3:4 — red lattice in a tilted square (3u × 4u)
  g.save();
  g.translate(1290, 760);
  g.rotate((-8 * Math.PI) / 180);
  g.beginPath();
  g.rect(-250, -250, 500, 500);
  g.save();
  g.clip();
  gridLines(g, -260, -260, 520, 520, 3 * U, 4 * U, 6, RED);
  g.restore();
  g.lineWidth = 5;
  g.strokeStyle = RED;
  g.stroke();
  g.restore();
  caption(g, 'fig.2  GRID   3u × 4u  →  3 : 4', 1040, 1100, 1060, 1030);

  // fig.3 DOTS — hex lattice inside a yellow triangle (a = 2.5u)
  const tri = [[480, 1200], [820, 1790], [140, 1790]];
  g.beginPath();
  tri.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fillStyle = YELLOW;
  g.fill();
  g.save();
  g.clip();
  hexDots(g, 120, 1180, 720, 640, 2.5 * U, 7.5, INK);
  g.restore();
  caption(g, 'fig.3  DOTS   a = 2.5u   hex', 130, 1850, 300, 1795);

  // fig.4 CONCENTRIC — blue rings, Δr = 5u/3 ≈ 20
  clipCircle(g, 1280, 1500, 330, () => {
    g.strokeStyle = BLUE;
    g.lineWidth = 9;
    for (let r = 14; r < 340; r += 20) {
      g.beginPath();
      g.arc(1280, 1500, r, 0, Math.PI * 2);
      g.stroke();
    }
  });
  caption(g, 'fig.4  CONCENTRIC   Δr = 20', 1080, 1880, 1180, 1820);

  // fig.5 STRIPE (coarse) — thick bands, p = 5u (kick)
  g.save();
  g.beginPath();
  g.rect(120, 1960, 620, 380);
  g.clip();
  g.fillStyle = INK;
  for (let y = 1960; y < 2340; y += 5 * U) g.fillRect(120, y, 620, 2.5 * U);
  g.restore();
  caption(g, 'fig.5  STRIPE   p = 5u', 120, 2390, 260, 2340);

  // fig.6 two levels — a coarse lattice of discs, each filled with fine
  // vertical stripes: far away it is DOTS, close up it is STRIPE.
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const cx = 870 + i * 124;
      const cy = 2030 + j * 124;
      clipCircle(g, cx, cy, 46, () => stripes(g, cx, cy, 110, U, 90, 0.5, INK));
    }
  }
  caption(g, 'fig.6  DOTS ⊃ STRIPE   124 / u', 820, 2470, 960, 2310);

  // fig.7 RADIAL — rays on an annulus (n = 96). The hub is left empty:
  // where rays converge their spacing changes too fast to read.
  g.save();
  g.beginPath();
  g.arc(1500, 2160, 260, 0, Math.PI * 2);
  g.arc(1500, 2160, 70, 0, Math.PI * 2, true);
  g.clip('evenodd');
  g.fillStyle = INK;
  for (let k = 0; k < 96; k += 2) {
    const a0 = (k / 96) * Math.PI * 2;
    const a1 = ((k + 1) / 96) * Math.PI * 2;
    g.beginPath();
    g.moveTo(1500, 2160);
    g.arc(1500, 2160, 270, a0, a1);
    g.closePath();
    g.fill();
  }
  g.restore();
  ring(g, 1500, 2160, 260, 3, INK);
  ring(g, 1500, 2160, 70, 2, INK);
  g.fillStyle = RED;
  g.beginPath();
  g.arc(1500, 2160, 22, 0, Math.PI * 2);
  g.fill();
  caption(g, 'fig.7  RADIAL   n = 96', 1330, 2470, 1420, 2410);

  // fig.9 ROW — five look-alike bottles, unevenly spaced (15 : 15 : 20 : 25u):
  // not a period, but a row; the gaps become the rhythm.
  // on a shelf: a plain backing so the debris underneath does not show
  g.fillStyle = PAPER;
  g.fillRect(200, 1100, 1040, 160);
  g.fillStyle = INK;
  g.fillRect(200, 1252, 1040, 4);
  let bx = 270;
  for (const gap of [15, 15, 20, 25, 0]) {
    bottle(g, bx, 1250, 1);
    bx += gap * U;
  }
  caption(g, 'fig.9  ROW   ×5   15 : 15 : 20 : 25u', 1260, 1215, 1220, 1205);

  // fig.8 TEXT — lines of type are stripes too (leading = 2.5u)
  g.fillStyle = INK;
  g.font = `500 19px ${MONO}`;
  const text = [
    '見えないリズムを、見えている形の中から掘り出す。',
    'repetition hides in scattered things. a rule reads',
    'the world and the loops begin: stripes tick, grids',
    'argue three against four, dots fall like rain and',
    'circles hum. move the phone and the mix follows.',
    'p1 : p2 : p3 = 3 : 4 : 5      u = 12      ♩ = 108',
  ];
  text.forEach((line, i) => g.fillText(line, 1010, 172 + i * 2.5 * U));
  caption(g, 'fig.8  TEXT   leading = 2.5u', 1010, 360, 1010, 330, true);

  title(g);
  clutterOver(g, rnd);
  return cv;
}

// --------------------------------------------------------------------------

// A bottle standing on (x, y): neck, shoulders, a red label band.
function bottle(g, x, y, k) {
  g.fillStyle = INK;
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
  g.fillStyle = RED;
  g.fillRect(x - 30 * k, y - 52 * k, 60 * k, 24 * k);
  g.fillStyle = PAPER;
  g.fillRect(x - 18 * k, y - 46 * k, 36 * k, 4 * k);
}

function frame(g) {
  g.strokeStyle = INK;
  g.lineWidth = 1.5;
  g.strokeRect(70, 70, POSTER_W - 140, POSTER_H - 140);
  g.font = `400 13px ${MONO}`;
  g.fillStyle = INK;
  for (let x = 70; x <= POSTER_W - 70; x += 30) {
    const major = (x - 70) % 300 === 0;
    g.fillRect(x, 70 - (major ? 18 : 8), 1, major ? 18 : 8);
    g.fillRect(x, POSTER_H - 70, 1, major ? 18 : 8);
    if (major) g.fillText(String(x - 70), x + 4, 50);
  }
  for (let y = 70; y <= POSTER_H - 70; y += 30) {
    const major = (y - 70) % 300 === 0;
    g.fillRect(70 - (major ? 18 : 8), y, major ? 18 : 8, 1);
    g.fillRect(POSTER_W - 70, y, major ? 18 : 8, 1);
    if (major) {
      g.save();
      g.translate(44, y - 4);
      g.rotate(-Math.PI / 2);
      g.fillText(String(y - 70), 0, 0);
      g.restore();
    }
  }
}

function title(g) {
  g.fillStyle = INK;
  g.font = `700 72px ${MONO}`;
  g.fillText('OSTINASCOPE', 110, 200);
  g.font = `400 20px ${MONO}`;
  g.fillText('pattern specimen  —  point a phone, find the loop', 112, 240);
  g.fillText('u = 12      θ in degrees      p = period', 112, 270);
}

function caption(g, text, x, y, lx, ly, noLeader = false) {
  g.fillStyle = INK;
  g.font = `500 17px ${MONO}`;
  g.fillText(text, x, y);
  if (noLeader) return;
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y - 22);
  g.lineTo(lx, ly);
  g.stroke();
  g.beginPath();
  g.arc(lx, ly, 3, 0, Math.PI * 2);
  g.fill();
}

function clipCircle(g, cx, cy, r, fn) {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  fn();
  g.restore();
}

function ring(g, cx, cy, r, w, color) {
  g.strokeStyle = color;
  g.lineWidth = w;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
}

// Stripes through (cx, cy) covering a square of side `size`; `angle` is the
// line orientation (deg, CCW from +x).
function stripes(g, cx, cy, size, period, angle, duty, color) {
  g.save();
  g.translate(cx, cy);
  g.rotate((-angle * Math.PI) / 180);
  g.fillStyle = color;
  const h = size;
  for (let y = -h; y < h; y += period) g.fillRect(-h, y, 2 * h, period * duty);
  g.restore();
}

function gridLines(g, x, y, w, h, px, py, lw, color) {
  g.fillStyle = color;
  for (let xx = x; xx < x + w; xx += px) g.fillRect(xx, y, lw, h);
  for (let yy = y; yy < y + h; yy += py) g.fillRect(x, yy, w, lw);
}

function hexDots(g, x, y, w, h, a, r, color) {
  g.fillStyle = color;
  const rowH = (a * Math.sqrt(3)) / 2;
  for (let j = 0, yy = y; yy < y + h; j++, yy += rowH) {
    for (let xx = x + (j % 2 ? a / 2 : 0); xx < x + w; xx += a) {
      g.beginPath();
      g.arc(xx, yy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// Non-repeating Kandinsky debris — under and over the specimens.
function clutterUnder(g, rnd) {
  const colors = [RED, YELLOW, BLUE, INK];
  for (let i = 0; i < 16; i++) {
    const x = 120 + rnd() * 1560;
    const y = 320 + rnd() * 2100;
    const r = 8 + rnd() * 34;
    g.fillStyle = colors[i % colors.length];
    g.globalAlpha = 0.9;
    if (i % 3 === 0) {
      g.beginPath();
      g.moveTo(x, y - r);
      g.lineTo(x + r, y + r);
      g.lineTo(x - r, y + r);
      g.closePath();
      g.fill();
    } else if (i % 3 === 1) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    } else {
      g.save();
      g.translate(x, y);
      g.rotate(rnd() * Math.PI);
      g.fillRect(-r, -r / 3, 2 * r, (2 * r) / 3);
      g.restore();
    }
  }
  g.globalAlpha = 1;
  // a big black semicircle and a pale disc, for weight
  g.fillStyle = INK;
  g.beginPath();
  g.arc(900, 1180, 90, Math.PI, 0);
  g.fill();
  g.fillStyle = 'rgba(31,79,209,0.18)';
  g.beginPath();
  g.arc(780, 520, 170, 0, Math.PI * 2);
  g.fill();
}

function clutterOver(g, rnd) {
  g.strokeStyle = INK;
  g.lineCap = 'round';
  const lines = [
    [90, 1150, 1720, 960, 3],
    [300, 330, 1100, 2480, 1.5],
    [1700, 1250, 950, 1960, 7],
    [140, 1900, 760, 1880, 2],
  ];
  for (const [x0, y0, x1, y1, w] of lines) {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  }
  // arcs
  g.lineWidth = 4;
  g.strokeStyle = RED;
  g.beginPath();
  g.arc(1590, 1250, 120, Math.PI * 0.9, Math.PI * 1.6);
  g.stroke();
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(240, 1450, 190, Math.PI * 1.1, Math.PI * 1.5);
  g.stroke();
  // a tiny checkerboard (too small to count as a pattern on its own)
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      if ((i + j) % 2) continue;
      g.fillStyle = INK;
      g.fillRect(1600 + i * 14, 560 + j * 14, 14, 14);
    }
  }
  // scattered points
  for (let i = 0; i < 40; i++) {
    g.fillStyle = INK;
    g.beginPath();
    g.arc(110 + rnd() * 1580, 320 + rnd() * 2150, 1.5 + rnd() * 4, 0, Math.PI * 2);
    g.fill();
  }
  g.lineCap = 'butt';
}
