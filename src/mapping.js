// Ostinascope — what each pattern sounds like.
// Pure functions: a track (pattern state) in, a loop description out.
//
//   STRIPE      → drums. Finer spacing = finer subdivision (hats … kick)
//   GRID        → polyrhythm from the ratio of its two spacings (e.g. 3:4)
//   DOTS        → short pitched percussion on a Euclidean rhythm
//   CONCENTRIC / RADIAL → drone with a tempo-synced swell
//   ROW         → one woody hit per thing in the row, placed in the bar
//                 where the thing sits along the row (uneven spacing =
//                 uneven rhythm); things set higher or lower move the pitch
//
//   colour → pitch (pentatonic), sharpness → attack, contrast & area →
//   level, orientation → pan.
// Periods are in view units: 1 = the short side of the screen.

import { clamp, mod } from './util.js';

export const SCALE = [0, 3, 5, 7, 10]; // D minor pentatonic
export const ROOT = 50; // D3

// Kandinsky-ish: yellow is high and sharp, blue is deep.
const HUE_TABLE = [
  // hue, scale degree, octave
  [0, 0, 0], // red
  [30, 1, 0], // orange
  [55, 4, 1], // yellow
  [120, 2, 0], // green
  [185, 3, 0], // cyan
  [228, 0, -1], // blue
  [285, 3, -1], // violet
];


export function colorToPitch(hue, sat) {
  if (!(sat >= 0.16)) return { degree: 0, octave: 0, chromatic: false };
  let best = HUE_TABLE[0];
  let bd = Infinity;
  for (const row of HUE_TABLE) {
    const d = Math.min(Math.abs(hue - row[0]), 360 - Math.abs(hue - row[0]));
    if (d < bd) {
      bd = d;
      best = row;
    }
  }
  return { degree: best[1], octave: best[2], chromatic: true };
}

export function midiOf(pitch, octaveShift = 0, degreeShift = 0) {
  const deg = pitch.degree + degreeShift;
  const oct = pitch.octave + octaveShift + Math.floor(deg / SCALE.length);
  return ROOT + 12 * oct + SCALE[mod(deg, SCALE.length)];
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => NAMES[mod(m, 12)] + (Math.floor(m / 12) - 1);
export const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

/** Euclidean rhythm: k onsets spread as evenly as possible over n steps. */
export function euclid(k, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((i * k) % n < k);
  return out;
}

const RATIOS = [
  [1, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [3, 5], [2, 5], [1, 3], [4, 7], [5, 7], [3, 7],
];

/** Closest small-integer ratio a:b (a ≤ b) to r ≥ 1. */
export function simpleRatio(r) {
  let best = RATIOS[0];
  let bc = Infinity;
  for (const [a, b] of RATIOS) {
    const c = Math.abs(Math.log(b / a) - Math.log(r)) + 0.012 * (a + b);
    if (c < bc) {
      bc = c;
      best = [a, b];
    }
  }
  return best;
}

export function stripeSpec(t) {
  const p = t.period;
  const sub = p < 0.022 ? 16 : p < 0.04 ? 8 : p < 0.075 ? 4 : 2;
  const sharp = clamp(t.sharp ?? 0.5, 0, 1);
  const pitch = colorToPitch(t.hue, t.sat);
  const steps = [];
  let inst;
  let tone;
  if (sub >= 8) {
    inst = 'hat';
    const acc = sub === 16 ? [0.85, 0.35, 0.6, 0.35] : [0.4, 0.9];
    for (let i = 0; i < sub; i++) steps.push({ pos: i / sub, vel: acc[i % acc.length] });
    tone = {
      decay: (sub === 16 ? 0.05 : 0.11) * (1.3 - 0.6 * sharp),
      cutoff: 6500 + 900 * pitch.degree + 1500 * pitch.octave,
    };
  } else {
    inst = 'kick';
    const acc = sub === 4 ? [1, 0.75, 0.9, 0.75] : [1, 0.8];
    for (let i = 0; i < sub; i++) steps.push({ pos: i / sub, vel: acc[i] });
    tone = {
      f0: 160,
      f1: sub === 4 ? 50 : 41,
      decay: sub === 4 ? 0.38 : 0.65,
      click: 0.15 + 0.6 * sharp,
    };
  }
  return {
    kind: 'stripe',
    inst,
    loopBars: 1,
    steps,
    tone,
    rhythm: `1/${sub}`,
    voice: inst === 'hat' ? 'HAT' : 'KICK',
    sig: `stripe:${sub}`,
  };
}

export function gridSpec(t) {
  const [a, b] = simpleRatio(Math.max(1, t.ratio || 1));
  let m = b <= 1 ? 4 : b <= 3 ? 2 : 1;
  const fine = Math.sqrt(t.period * (t.period2 || t.period)) < 0.03;
  if (fine && b * m * 2 <= 12) m *= 2;
  const na = a * m;
  const nb = b * m;
  const pitch = colorToPitch(t.hue, t.sat);
  const lo = midiOf(pitch, 0);
  const hi = midiOf(pitch, 0, 3);
  const offset = a === b ? 0.5 / nb : 0; // 1:1 → interlock instead of unison
  const steps = [];
  for (let i = 0; i < na; i++) steps.push({ pos: i / na, vel: i ? 0.65 : 1, layer: 0, midi: lo });
  for (let i = 0; i < nb; i++) steps.push({ pos: i / nb + offset, vel: i ? 0.55 : 0.85, layer: 1, midi: hi });
  const sharp = clamp(t.sharp ?? 0.5, 0, 1);
  return {
    kind: 'grid',
    inst: 'mallet',
    loopBars: 1,
    steps,
    tone: { decay: 0.55 - 0.3 * sharp, hard: sharp },
    rhythm: `${a}:${b}`,
    poly: `${na}:${nb}`,
    voice: `${noteName(lo)}/${noteName(hi)}`,
    sig: `grid:${na}:${nb}:${lo}:${hi}`,
  };
}

const CONTOURS = [
  [0, 2, 1, 3],
  [0, 1, 2, 4],
  [4, 2, 1, 0],
  [0, 3, 1, 2],
];

export function dotsSpec(t) {
  const p = t.period;
  const k = p < 0.02 ? 11 : p < 0.03 ? 9 : p < 0.042 ? 7 : p < 0.06 ? 5 : 3;
  const n = 16;
  const pitch = colorToPitch(t.hue, t.sat);
  const contour = CONTOURS[Math.floor(mod(t.angle, 180) / 45) % 4];
  const up = p < 0.03 ? 1 : 0;
  const steps = [];
  let h = 0;
  euclid(k, n).forEach((hit, i) => {
    if (!hit) return;
    steps.push({ pos: i / n, vel: h ? 0.7 : 1, midi: midiOf(pitch, up, contour[h % contour.length]) });
    h++;
  });
  const sharp = clamp(t.sharp ?? 0.5, 0, 1);
  return {
    kind: 'dots',
    inst: 'blip',
    loopBars: 1,
    steps,
    tone: { decay: 0.22 - 0.1 * sharp, fm: 0.6 + 2.4 * sharp, attack: 0.012 - 0.01 * sharp },
    rhythm: `E(${k},${n})`,
    voice: noteName(steps[0].midi),
    sig: `dots:${k}:${steps.map((s) => s.midi).join(',')}`,
  };
}

export function droneSpec(t) {
  const pitch = colorToPitch(t.hue, t.sat);
  let base = midiOf(pitch, -1);
  while (base < 38) base += 12;
  while (base >= 50) base -= 12;
  const radial = t.type === 'RADIAL';
  const notes = radial ? [base, base + 5, base + 12] : [base, base + 7, base + 12];
  const p = t.period;
  const lfoBeats = p < 0.025 ? 1 : p < 0.05 ? 2 : p < 0.09 ? 4 : 8;
  return {
    kind: 'drone',
    inst: 'drone',
    // the drone sounds continuously; steps only mark its swell for the visuals
    loopBars: lfoBeats / 4,
    steps: [{ pos: 0, vel: 1 }],
    notes,
    lfoBeats,
    tone: { cutoff: radial ? 900 : 520, depth: 0.5 + 0.5 * clamp(t.contrast, 0, 1) },
    rhythm: lfoBeats >= 4 ? `${lfoBeats / 4} bar` : `${lfoBeats} beat`,
    voice: `DRONE ${noteName(base)}`,
    sig: `drone:${notes.join(',')}:${lfoBeats}`,
  };
}

export function rowSpec(t) {
  const ms = (t.members || []).slice().sort((a, b) => a.t - b.t);
  const n = ms.length;
  const pitch = colorToPitch(t.hue, t.sat);
  const size = t.size || 0.15;
  const oct = size > 0.2 ? -1 : size < 0.11 ? 1 : 0;
  const span = n > 1 ? ms[n - 1].t - ms[0].t : 1;
  const steps = [];
  let last = -1;
  ms.forEach((m, i) => {
    // where along the row → where in the bar (the last thing leaves room
    // for the loop to come round, as an evenly spaced row would)
    const pos = n > 1 ? ((m.t - ms[0].t) / span) * ((n - 1) / n) : 0;
    let q = Math.round(pos * 16);
    if (q <= last) q = last + 1;
    if (q > 15) return;
    last = q;
    const deg = clamp(Math.round(-(m.off || 0) * 2.5), -4, 4);
    steps.push({ pos: q / 16, vel: i ? 0.62 + 0.2 * clamp((m.sim || 0.85) - 0.8, 0, 0.2) * 5 : 1, midi: midiOf(pitch, oct, deg) });
  });
  const grid = Array.from({ length: 16 }, (_, i) => (steps.some((st) => Math.round(st.pos * 16) === i) ? 'x' : '·')).join('');
  const even = (t.evenness ?? 0) < 0.12;
  return {
    kind: 'row',
    inst: 'wood',
    loopBars: 1,
    steps,
    pattern: grid,
    tone: { decay: 0.09 + 0.5 * clamp(size, 0.05, 0.35), body: clamp(1 - size * 2, 0.3, 1) },
    rhythm: `×${steps.length}${even ? '' : '~'}`,
    voice: noteName(steps[0] ? steps[0].midi : ROOT),
    sig: `row:${grid}:${steps.map((st) => st.midi).join(',')}`,
  };
}

export function specFor(t) {
  switch (t.type) {
    case 'STRIPE':
      return stripeSpec(t);
    case 'GRID':
      return gridSpec(t);
    case 'DOTS':
      return dotsSpec(t);
    case 'ROW':
      return rowSpec(t);
    default:
      return droneSpec(t);
  }
}

const KIND_GAIN = { hat: 0.42, kick: 0.95, mallet: 0.5, blip: 0.45, drone: 0.3, wood: 0.6 };

/** Loop level from contrast and on-screen area. */
export function levelFor(t, spec, view, area0 = t.w * t.h) {
  const area = Math.min(1, area0 / (view.w * view.h));
  const g = (0.35 + 0.65 * clamp(t.contrast, 0, 1)) * clamp(0.5 + 0.9 * Math.sqrt(area), 0.5, 1.1);
  return g * (KIND_GAIN[spec.inst] ?? 0.5);
}

/** Stereo position: orientation of the stripes (and a little of where they are). */
export function panFor(t, view) {
  const x = clamp((t.cx / view.w) * 2 - 1, -1, 1);
  if (t.family === 'line') return clamp(0.6 * Math.sin((2 * t.angle * Math.PI) / 180) + 0.3 * x, -0.9, 0.9);
  return clamp(0.7 * x, -0.9, 0.9);
}

// How long a lost pattern's loop fades (bars). Lost in place, it may only
// have flickered: 1–2 bars, so a dropout is not heard. Gone out through
// the frame's edge, it is not coming back soon: a quarter of a bar, so
// the loops of patterns panned past do not pile up.
export const fadeBarsFor = (t) => (t.exit && t.exit.kind === 'edge' ? 0.25 : t.family === 'line' ? 1 : 2);
