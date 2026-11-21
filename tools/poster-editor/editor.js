// Ostinascope poster editor — edits poster/poster.json.
//
// Reads the app's poster renderer (element types, their fields and how they
// draw) and its detector (for "カメラで見る"); the app knows nothing about
// this tool. Saving needs tools/poster-editor/serve.py; without it the
// poster can still be exported as JSON / PNG.

import {
  TYPES, paint, drawPoster, loadPoster, boundsOf, moveElement, createElement, context, drawElement, debrisPieces,
  PATTERN_DEFAULTS, SHAPE_DEFAULTS, POSTER_URL,
} from '../../src/poster.js';
import { createDetector } from '../../src/detector.js';
import { distanceField, scatterPieces } from './scatter.js';
import { COLORS } from '../../src/render.js';

const $ = (s) => document.querySelector(s);
const posterCv = $('#poster');
const overlay = $('#overlay');
const g = posterCv.getContext('2d');
const og = overlay.getContext('2d');

const st = {
  spec: null,
  sel: -1,
  hover: -1,
  zoom: 0.3,
  dirty: false,
  undo: [],
  redo: [],
  drag: null,
  scope: { on: false, pinned: false, x: 900, y: 1200, s: 600, result: null, busy: false, stale: true },
};

// ---------------------------------------------------------------- helpers

const W = () => st.spec.size[0];
const H = () => st.spec.size[1];
const ctx = () => context(st.spec);
const selEl = () => st.spec.elements[st.sel] || null;
const nameOf = (el) => el.id || TYPES[el.type]?.label || el.type;

function getPath(o, path) {
  return path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
}
function setPath(o, path, value) {
  const ks = path.split('.');
  const last = ks.pop();
  const parent = ks.reduce((v, k) => (v[k] ??= {}), o);
  parent[last] = value;
}

function uniqueId(base) {
  const ids = new Set(st.spec.elements.map((e) => e.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ---------------------------------------------------------------- history

let lastKey = null;
let lastT = 0;
// Call before a change; edits to the same field in quick succession are
// one undo step.
function willChange(key = null) {
  const t = performance.now();
  if (key && key === lastKey && t - lastT < 900) {
    lastT = t;
    return;
  }
  lastKey = key;
  lastT = t;
  st.undo.push(JSON.stringify(st.spec));
  if (st.undo.length > 300) st.undo.shift();
  st.redo = [];
}

function changed({ structure = false, panel = false } = {}) {
  st.dirty = true;
  st.scope.stale = true;
  showStatus();
  requestPaint();
  if (structure) renderLayers();
  if (panel || structure) renderPanel();
  else renderLayers();
}

function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(st.spec));
  st.spec = JSON.parse(from.pop());
  if (st.sel >= st.spec.elements.length) st.sel = -1;
  lastKey = null;
  changed({ structure: true });
}

// ---------------------------------------------------------------- painting

let paintQueued = false;
function requestPaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paintPoster();
    paintOverlay();
  });
}

function setZoom(z) {
  const stage = $('#stage');
  st.zoom = z === 'fit' ? Math.min((stage.clientHeight - 32) / H(), (stage.clientWidth - 32) / W()) : +z;
  const dpr = window.devicePixelRatio || 1;
  for (const c of [posterCv, overlay]) {
    c.width = Math.round(W() * st.zoom * dpr);
    c.height = Math.round(H() * st.zoom * dpr);
    c.style.width = `${W() * st.zoom}px`;
    c.style.height = `${H() * st.zoom}px`;
  }
  requestPaint();
}

function paintPoster() {
  const k = st.zoom * (window.devicePixelRatio || 1);
  g.setTransform(k, 0, 0, k, 0, 0);
  paint(g, st.spec);
}

function paintOverlay() {
  const k = st.zoom * (window.devicePixelRatio || 1);
  og.setTransform(1, 0, 0, 1, 0, 0);
  og.clearRect(0, 0, overlay.width, overlay.height);
  og.setTransform(k, 0, 0, k, 0, 0);
  const px = 1 / st.zoom; // one screen pixel in design px

  if ($('#ugrid').checked) {
    const u = st.spec.unit || 12;
    og.lineWidth = px;
    for (let x = 0; x <= W(); x += u) {
      og.strokeStyle = x % (u * 5) === 0 ? 'rgba(31,79,209,0.35)' : 'rgba(31,79,209,0.12)';
      og.beginPath();
      og.moveTo(x, 0);
      og.lineTo(x, H());
      og.stroke();
    }
    for (let y = 0; y <= H(); y += u) {
      og.strokeStyle = y % (u * 5) === 0 ? 'rgba(31,79,209,0.35)' : 'rgba(31,79,209,0.12)';
      og.beginPath();
      og.moveTo(0, y);
      og.lineTo(W(), y);
      og.stroke();
    }
  }

  const c = ctx();
  const outline = (el, style, dash) => {
    const b = boundsOf(el, g, c);
    if (!b) return;
    og.strokeStyle = style;
    og.lineWidth = 2 * px;
    og.setLineDash(dash.map((d) => d * px));
    og.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    og.setLineDash([]);
  };
  if (st.hover >= 0 && st.hover !== st.sel && !st.scope.on) outline(st.spec.elements[st.hover], 'rgba(31,79,209,0.7)', [4, 3]);
  const el = selEl();
  if (el) {
    for (const o of linkedTo(el)) outline(o, 'rgba(215,38,43,0.5)', [2, 3]);
    outline(el, '#D7262B', [7, 4]);
  }

  if (st.scope.on) paintScope(px);
}

// ---------------------------------------------------------------- layers

function renderLayers() {
  const list = $('#layer-list');
  list.textContent = '';
  const el = selEl();
  const linked = new Set(el ? linkedTo(el) : []);
  // topmost first
  for (let i = st.spec.elements.length - 1; i >= 0; i--) {
    const e = st.spec.elements[i];
    const li = document.createElement('li');
    li.className = (i === st.sel ? 'sel ' : '') + (e.hidden ? 'hidden ' : '') + (linked.has(e) ? 'linked' : '');
    const eye = document.createElement('span');
    eye.className = 'eye';
    eye.textContent = e.hidden ? '○' : '●';
    eye.title = '表示／非表示';
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      willChange();
      e.hidden = !e.hidden || undefined;
      changed({ structure: true });
    });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = nameOf(e);
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = e.type;
    li.append(eye, name, type);
    li.addEventListener('click', () => select(i));
    list.append(li);
  }
}

function select(i) {
  st.sel = i;
  renderLayers();
  renderPanel();
  requestPaint();
}

// elements that follow this one when it is dragged (its captions, hub…)
function linkedTo(el) {
  if (!el.id) return [];
  return st.spec.elements.filter((o) => o !== el && o.for === el.id);
}

// ---------------------------------------------------------------- panel

function renderPanel() {
  const form = $('#fields');
  form.textContent = '';
  const el = selEl();
  $('#props-title').textContent = el ? `${nameOf(el)} — ${TYPES[el.type]?.label || el.type}` : '（要素を選んでください）';
  if (!el) return;
  const T = TYPES[el.type];
  const common = [
    { key: 'id', label: '名前', type: 'text' },
    { key: 'for', label: '連動する図形', type: 'link' },
  ];
  for (const f of [...common, ...T.fields]) {
    if (f.when && !f.when(el)) continue;
    form.append(fieldRow(el, f));
  }
  if (el.type === 'debris') form.append(debrisActions(el));
}

function fieldRow(el, f) {
  const label = document.createElement('label');
  const cap = document.createElement('span');
  cap.textContent = f.label;
  label.append(cap);
  const v = getPath(el, f.key);
  const key = `${st.sel}:${f.key}`;
  const commit = (value, opts) => {
    willChange(key);
    setPath(el, f.key, value);
    if (el.type === 'piece' && f.key !== 'pin') el.pin = true; // placed by hand: keep it
    changed(opts);
  };
  let input;
  switch (f.type) {
    case 'number': {
      input = document.createElement('input');
      input.type = 'number';
      input.step = f.step ?? 1;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      input.value = v ?? '';
      input.addEventListener('input', () => {
        if (input.value === '' || !Number.isFinite(+input.value)) return;
        commit(+input.value);
      });
      break;
    }
    case 'text': {
      input = document.createElement('input');
      input.type = 'text';
      input.value = v ?? '';
      input.addEventListener('input', () => {
        if (f.key === 'id') {
          // keep the elements that follow this one linked to it
          const old = el.id;
          willChange(key);
          for (const o of st.spec.elements) if (old && o.for === old) o.for = input.value || undefined;
          el.id = input.value || undefined;
          changed();
          return;
        }
        commit(input.value || undefined);
      });
      break;
    }
    case 'lines': {
      input = document.createElement('textarea');
      input.value = (v || []).join('\n');
      input.addEventListener('input', () => commit(input.value.split('\n')));
      break;
    }
    case 'bool': {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!v;
      input.addEventListener('change', () => commit(input.checked, { panel: true }));
      break;
    }
    case 'select': {
      input = document.createElement('select');
      for (const o of f.options) input.append(new Option(String(o), String(o)));
      input.value = String(v);
      input.addEventListener('change', () => {
        const raw = typeof f.options[0] === 'number' ? +input.value : input.value;
        willChange();
        if (f.key.endsWith('shape.kind')) {
          setPath(el, f.key.replace(/kind$/, '').replace(/\.$/, ''), { ...SHAPE_DEFAULTS[raw] });
        } else if (f.key.endsWith('pattern.kind')) {
          const path = f.key.replace(/\.kind$/, '');
          const color = getPath(el, path)?.color;
          setPath(el, path, { ...PATTERN_DEFAULTS[raw], ...(color && raw !== 'none' ? { color } : {}) });
        } else {
          setPath(el, f.key, raw);
        }
        changed({ panel: true });
      });
      break;
    }
    case 'numbers': {
      input = document.createElement('input');
      input.type = 'text';
      input.value = (v || []).join(', ');
      input.addEventListener('input', () => {
        const xs = input.value.split(/[,\s]+/).filter(Boolean).map(Number);
        if (xs.length && xs.every(Number.isFinite)) commit(xs);
      });
      break;
    }
    case 'points': {
      input = document.createElement('input');
      input.type = 'text';
      input.value = (v || []).map((p) => p.join(',')).join('; ');
      input.addEventListener('input', () => {
        const ps = input.value.split(';').map((s) => s.split(',').map((t) => +t.trim()));
        if (ps.length >= 3 && ps.every((p) => p.length === 2 && p.every(Number.isFinite))) commit(ps);
      });
      break;
    }
    case 'colors': {
      input = document.createElement('input');
      input.type = 'text';
      input.value = (v || []).join(', ');
      input.addEventListener('input', () => {
        const cs = input.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (cs.length) commit(cs);
      });
      break;
    }
    case 'color':
      input = colorInput(v, f.optional, (value) => commit(value));
      break;
    case 'link': {
      input = document.createElement('select');
      input.append(new Option('（なし）', ''));
      for (const o of st.spec.elements) if (o.id && o !== el && !o.for) input.append(new Option(o.id, o.id));
      input.value = v || '';
      input.addEventListener('change', () => commit(input.value || undefined, { structure: true }));
      break;
    }
    default:
      input = document.createElement('span');
      input.textContent = JSON.stringify(v);
  }
  label.append(input);
  return label;
}

// A palette name or any CSS colour, with a picker for hex values.
function colorInput(value, optional, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'colorpick';
  const pick = document.createElement('input');
  pick.type = 'color';
  const text = document.createElement('input');
  text.type = 'text';
  text.setAttribute('list', 'palette-names');
  text.value = value ?? '';
  text.placeholder = optional ? '（なし）' : '';
  const sync = () => {
    const hex = toHex(ctx().color(text.value));
    if (hex) pick.value = hex;
  };
  sync();
  text.addEventListener('input', () => {
    if (!text.value && !optional) return;
    sync();
    onChange(text.value || '');
  });
  pick.addEventListener('input', () => {
    text.value = pick.value.toUpperCase();
    onChange(text.value);
  });
  wrap.append(pick, text);
  return wrap;
}

const hexProbe = document.createElement('canvas').getContext('2d');
function toHex(css) {
  if (!css || css === 'transparent') return null;
  hexProbe.fillStyle = '#000';
  hexProbe.fillStyle = css;
  const v = hexProbe.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

function renderPalette() {
  const box = $('#palette');
  box.textContent = '';
  const pal = st.spec.palette;
  let list = document.getElementById('palette-names');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'palette-names';
    document.body.append(list);
  }
  list.textContent = '';
  for (const name of Object.keys(pal)) {
    list.append(new Option(name, name));
    const row = document.createElement('div');
    row.className = 'swatch';
    const pick = document.createElement('input');
    pick.type = 'color';
    pick.value = toHex(pal[name]) || '#000000';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.value = pal[name];
    const label = document.createElement('span');
    label.textContent = name;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'この色を消す（使っている要素は透明になる）';
    pick.addEventListener('input', () => {
      willChange(`pal:${name}`);
      pal[name] = pick.value.toUpperCase();
      hex.value = pal[name];
      changed();
    });
    hex.addEventListener('input', () => {
      if (!toHex(hex.value) && !hex.value.startsWith('rgba')) return;
      willChange(`pal:${name}`);
      pal[name] = hex.value;
      changed();
    });
    del.addEventListener('click', () => {
      if (name === 'paper') return;
      willChange();
      delete pal[name];
      renderPalette();
      changed({ panel: true });
    });
    row.append(pick, label, hex, del);
    box.append(row);
  }
}

// ---------------------------------------------------------------- canvas input

function toDesign(e) {
  return { x: e.offsetX / st.zoom, y: e.offsetY / st.zoom };
}

// smallest box under the point (big scatter fields would win otherwise)
function hitTest(p) {
  const c = ctx();
  let best = -1;
  let bestArea = Infinity;
  st.spec.elements.forEach((el, i) => {
    if (el.hidden) return;
    const b = boundsOf(el, g, c);
    if (!b || p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) return;
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (area <= bestArea) {
      best = i;
      bestArea = area;
    }
  });
  return best;
}

overlay.addEventListener('pointerdown', (e) => {
  const p = toDesign(e);
  if (st.scope.on) {
    st.scope.pinned = !st.scope.pinned;
    Object.assign(st.scope, p, { stale: true });
    requestPaint();
    return;
  }
  const i = hitTest(p);
  select(i);
  if (i < 0) return;
  overlay.setPointerCapture(e.pointerId);
  willChange(`drag:${performance.now()}`);
  st.drag = { start: p, moved: { x: 0, y: 0 }, alone: e.altKey };
});

overlay.addEventListener('pointermove', (e) => {
  const p = toDesign(e);
  $('#coords').textContent = `x ${Math.round(p.x)}  y ${Math.round(p.y)}  (u ${(p.x / (st.spec.unit || 12)).toFixed(1)}, ${(p.y / (st.spec.unit || 12)).toFixed(1)})`;
  if (st.scope.on) {
    if (!st.scope.pinned) {
      Object.assign(st.scope, p, { stale: true });
      requestPaint();
    }
    return;
  }
  if (!st.drag) {
    const h = hitTest(p);
    if (h !== st.hover) {
      st.hover = h;
      requestPaint();
    }
    return;
  }
  const u = st.spec.unit || 12;
  let dx = p.x - st.drag.start.x;
  let dy = p.y - st.drag.start.y;
  const snap = e.shiftKey ? u : 1;
  dx = Math.round(dx / snap) * snap;
  dy = Math.round(dy / snap) * snap;
  const ddx = dx - st.drag.moved.x;
  const ddy = dy - st.drag.moved.y;
  if (!ddx && !ddy) return;
  moveSelected(ddx, ddy, st.drag.alone);
  st.drag.moved = { x: dx, y: dy };
});

overlay.addEventListener('pointerup', () => {
  if (st.drag && (st.drag.moved.x || st.drag.moved.y)) renderPanel();
  st.drag = null;
});
overlay.addEventListener('pointerleave', () => {
  st.hover = -1;
  requestPaint();
});

function moveSelected(dx, dy, alone = false) {
  const el = selEl();
  if (!el) return;
  moveElement(el, dx, dy);
  if (el.type === 'piece') el.pin = true; // placed by hand: keep it when scattering again
  if (!alone) for (const o of linkedTo(el)) moveElement(o, dx, dy);
  st.dirty = true;
  st.scope.stale = true;
  showStatus();
  requestPaint();
}

// ---------------------------------------------------------------- keys

window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
    return;
  }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) restore(st.redo, st.undo);
    else restore(st.undo, st.redo);
    return;
  }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicate();
    return;
  }
  if (!selEl()) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    remove();
    return;
  }
  const step = e.shiftKey ? 10 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) {
    e.preventDefault();
    willChange(`nudge:${st.sel}`);
    moveSelected(d[0], d[1], e.altKey);
    renderPanel();
  }
});

// ---------------------------------------------------------------- structure

function duplicate() {
  const el = selEl();
  if (!el) return;
  willChange();
  const copy = structuredClone(el);
  if (copy.id) copy.id = uniqueId(copy.id);
  moveElement(copy, 24, 24);
  st.spec.elements.splice(st.sel + 1, 0, copy);
  st.sel += 1;
  changed({ structure: true });
}

function remove() {
  const el = selEl();
  if (!el) return;
  willChange();
  st.spec.elements.splice(st.sel, 1);
  st.sel = Math.min(st.sel, st.spec.elements.length - 1);
  changed({ structure: true });
}

function reorder(delta) {
  const i = st.sel;
  const j = i + delta;
  if (i < 0 || j < 0 || j >= st.spec.elements.length) return;
  willChange();
  const els = st.spec.elements;
  [els[i], els[j]] = [els[j], els[i]];
  st.sel = j;
  changed({ structure: true });
}

function add(type) {
  const stage = $('#stage');
  const cx = (stage.scrollLeft + stage.clientWidth / 2 - 16) / st.zoom;
  const cy = (stage.scrollTop + stage.clientHeight / 2 - 16) / st.zoom;
  willChange();
  const el = createElement(type, Math.round(Math.min(cx, W() / 2 + 400)), Math.round(Math.min(cy, H() - 200)));
  el.id = uniqueId(type);
  st.spec.elements.push(el);
  st.sel = st.spec.elements.length - 1;
  changed({ structure: true });
}

// ---------------------------------------------------------------- debris: split it, scatter it into the gaps

const piecesOf = (el) => (el.id ? st.spec.elements.filter((o) => o.type === 'piece' && o.for === el.id) : []);

function debrisActions(el) {
  const box = document.createElement('div');
  box.className = 'actions';
  const row = document.createElement('div');
  row.className = 'row';
  const button = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; // inside the form: not a submit
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    row.append(b);
  };
  const keep = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  keep.append(cb, ' 固定したものは残す');
  button('隙間に撒く', 'ほかの図形・文字から「ほかとの隙間」以上離れた場所に、範囲の中で撒き直す', () => scatterDebris(el, cb.checked));
  if (!el.split) button('今の配置をばらす', '見た目はそのままで、1 個ずつ動かせる要素にする', () => splitDebris(el));
  const n = piecesOf(el).length;
  const pinned = piecesOf(el).filter((o) => o.pin).length;
  const note = document.createElement('p');
  note.className = 'hint';
  note.id = 'debris-note';
  note.textContent = el.split
    ? `ばらした状態：がらくた ${n} 個（固定 ${pinned} 個）。1 個ずつ選んで動かせます。手で動かしたり項目を変えたりしたものは固定になり、撒き直しても残ります。`
    : '種から描いています。ばらすか撒くと、1 個ずつ選んで動かせるようになります。';
  box.append(row, keep, note);
  return box;
}

// what is taken, at half resolution: everything but this debris and its
// pieces, painted on a transparent canvas (pale discs stay free)
function freeSpace(skip, scale = 0.5) {
  const w = Math.ceil(W() * scale);
  const h = Math.ceil(H() * scale);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cg = cv.getContext('2d', { willReadFrequently: true });
  cg.scale(scale, scale);
  const c = ctx();
  for (const o of st.spec.elements) if (!o.hidden && !skip(o)) drawElement(cg, o, c);
  const a = cg.getImageData(0, 0, w, h).data;
  const taken = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) taken[i] = a[4 * i + 3] > 127;
  return { dist: distanceField(taken, w, h), w, h, scale };
}

function ensureId(el) {
  if (!el.id) el.id = uniqueId(el.type);
  return el.id;
}

// new piece elements for `el`, right after it in the drawing order
function insertPieces(el, pieces) {
  const ids = new Set(st.spec.elements.map((o) => o.id));
  let k = 1;
  const els = pieces.map((p) => {
    while (ids.has(`${el.id}-${k}`)) k++;
    const id = `${el.id}-${k}`;
    ids.add(id);
    return { id, type: 'piece', for: el.id, ...p, alpha: el.alpha };
  });
  st.spec.elements.splice(st.spec.elements.indexOf(el) + 1, 0, ...els);
}

function splitDebris(el) {
  willChange();
  ensureId(el);
  const round = (v) => Math.round(v * 10) / 10;
  insertPieces(el, debrisPieces(el).map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y), r: round(p.r), rotation: round(p.rotation) })));
  el.split = true;
  st.sel = st.spec.elements.indexOf(el);
  changed({ structure: true });
  showStatus(`がらくたを ${el.count} 個の要素にばらしました`);
}

function scatterDebris(el, keepPinned) {
  willChange();
  ensureId(el);
  const own = piecesOf(el);
  const keep = keepPinned ? own.filter((o) => o.pin) : [];
  st.spec.elements = st.spec.elements.filter((o) => !own.includes(o) || keep.includes(o));
  const field = freeSpace((o) => o === el || (o.type === 'piece' && o.for === el.id));
  el.seed = ((el.seed || 0) + 1) >>> 0; // a new draw each time
  el.gap ??= 24;
  const area = { x0: el.x, y0: el.y, x1: el.x + el.w, y1: el.y + el.h };
  const res = scatterPieces(field, area, { count: el.count, rMin: el.rMin, rMax: el.rMax, gap: el.gap, colors: el.colors, seed: el.seed }, keep);
  insertPieces(el, res.pieces);
  el.split = true;
  st.sel = st.spec.elements.indexOf(el);
  changed({ structure: true });
  const short = res.placed < res.wanted ? `（隙間が足りず ${res.wanted - res.placed} 個は置けませんでした）` : '';
  showStatus(`がらくたを ${res.placed} 個撒きました${keep.length ? `、固定 ${keep.length} 個はそのまま` : ''}${short}`);
}

// ---------------------------------------------------------------- scope: what would the camera see?

const AW = 192; // the app's analysis resolution (short side)
const AH = Math.round((AW * 844) / 390);
const detector = createDetector();
const analysisCv = document.createElement('canvas');
analysisCv.width = AW;
analysisCv.height = AH;
const ag = analysisCv.getContext('2d', { willReadFrequently: true });
let flat = null; // the poster at 1×, redrawn when it changed
let flatSpec = '';

function scopeBox() {
  const w = st.scope.s;
  const h = (w * 844) / 390;
  return { x0: st.scope.x - w / 2, y0: st.scope.y - h / 2, w, h };
}

function runScope() {
  const json = JSON.stringify(st.spec);
  if (json !== flatSpec) {
    flat = drawPoster(st.spec, 1);
    flatSpec = json;
  }
  const b = scopeBox();
  ag.fillStyle = '#000';
  ag.fillRect(0, 0, AW, AH);
  ag.drawImage(flat, b.x0, b.y0, b.w, b.h, 0, 0, AW, AH);
  const img = ag.getImageData(0, 0, AW, AH);
  const res = detector.analyze(img.data, AW, AH);
  const k = b.w / AW;
  st.scope.result = {
    ms: res.ms,
    regions: res.regions.map((r) => ({
      type: r.type, x: b.x0 + r.x * k, y: b.y0 + r.y * k, w: r.w * k, h: r.h * k,
      period: r.period * k, count: r.count, angle: r.angle,
    })),
  };
  showScope();
}

let scopeTimer = 0;
function paintScope(px) {
  const b = scopeBox();
  og.fillStyle = 'rgba(20,20,20,0.35)';
  og.beginPath();
  og.rect(0, 0, W(), H());
  og.rect(b.x0, b.y0, b.w, b.h);
  og.fill('evenodd');
  og.strokeStyle = st.scope.pinned ? '#D7262B' : '#fff';
  og.lineWidth = 2 * px;
  og.strokeRect(b.x0, b.y0, b.w, b.h);
  const res = st.scope.result;
  if (res) {
    og.font = `500 ${12 * px}px "IBM Plex Mono", monospace`;
    for (const r of res.regions) {
      const c = COLORS[r.type] || '#fff';
      og.strokeStyle = c;
      og.lineWidth = 2.5 * px;
      og.strokeRect(r.x, r.y, r.w, r.h);
      og.fillStyle = 'rgba(0,0,0,0.75)';
      const label = `${r.type}${r.count ? ' ×' + r.count : ''}`;
      og.fillRect(r.x, r.y, (label.length * 7.5 + 8) * px, 17 * px);
      og.fillStyle = c;
      og.fillText(label, r.x + 4 * px, r.y + 13 * px);
    }
  }
  // analyse at most ~8 times a second, after the poster settles
  if (st.scope.stale && !scopeTimer) {
    scopeTimer = setTimeout(() => {
      scopeTimer = 0;
      if (!st.scope.on) return;
      st.scope.stale = false;
      runScope();
      requestPaint();
    }, 120);
  }
}

function showScope() {
  const out = $('#scope-out');
  const res = st.scope.result;
  if (!res) return;
  if (!res.regions.length) {
    out.innerHTML = `<p>何も検出されません（${res.ms.toFixed(0)} ms）</p>`;
    return;
  }
  const rows = res.regions.map((r) => `<tr><td><span class="chip" style="background:${COLORS[r.type] || '#fff'}"></span>${r.type}</td>`
    + `<td>${r.count ? '×' + r.count + ' ' : ''}間隔 ${r.period.toFixed(0)}px</td><td>${Math.round(r.angle ?? 0)}°</td></tr>`);
  out.innerHTML = `<table>${rows.join('')}</table><p>${res.regions.length} 領域・${res.ms.toFixed(0)} ms（画角 ${st.scope.s}px）</p>`;
}

// ---------------------------------------------------------------- files

// one element per line: readable diffs, small file
function format(spec) {
  const { elements, ...head } = spec;
  const top = JSON.stringify(head, null, 2);
  return `${top.slice(0, -2)},\n  "elements": [\n${elements.map((e) => '    ' + JSON.stringify(e)).join(',\n')}\n  ]\n}\n`;
}

function showStatus(msg) {
  const s = $('#status');
  s.textContent = msg || (st.dirty ? '未保存の変更あり' : '保存済み');
  s.className = st.dirty && !msg ? 'dirty' : '';
}

async function save() {
  try {
    const res = await fetch(POSTER_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: format(st.spec) });
    if (!res.ok) throw new Error(`${res.status}`);
    st.dirty = false;
    showStatus(`保存しました ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    showStatus('保存できません（tools/poster-editor/serve.py で開いてください）。JSON を書き出します');
    download(new Blob([format(st.spec)], { type: 'application/json' }), 'poster.json');
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('#save').addEventListener('click', save);
  $('#undo').addEventListener('click', () => restore(st.undo, st.redo));
  $('#redo').addEventListener('click', () => restore(st.redo, st.undo));
  $('#zoom').addEventListener('change', (e) => setZoom(e.target.value));
  $('#ugrid').addEventListener('change', requestPaint);
  $('#scope').addEventListener('change', (e) => {
    st.scope.on = e.target.checked;
    st.scope.pinned = false;
    st.scope.stale = true;
    overlay.classList.toggle('scope', st.scope.on);
    requestPaint();
  });
  $('#scope-size').addEventListener('input', (e) => {
    st.scope.s = +e.target.value;
    st.scope.stale = true;
    requestPaint();
  });
  $('#up').addEventListener('click', () => reorder(1));
  $('#down').addEventListener('click', () => reorder(-1));
  $('#dup').addEventListener('click', duplicate);
  $('#del').addEventListener('click', remove);
  const addType = $('#add-type');
  for (const [type, T] of Object.entries(TYPES)) if (type !== 'frame') addType.append(new Option(T.label, type));
  $('#add').addEventListener('click', () => add(addType.value));
  $('#add-color').addEventListener('click', () => {
    const name = prompt('色の名前（英数字）', 'green');
    if (!name || !/^[\w-]+$/.test(name) || st.spec.palette[name]) return;
    willChange();
    st.spec.palette[name] = '#3A8F5C';
    renderPalette();
    changed();
  });
  $('#export-png').addEventListener('click', async () => {
    await document.fonts.ready;
    drawPoster(st.spec, 2).toBlob((b) => download(b, 'ostinascope-poster.png'), 'image/png');
  });
  $('#export-json').addEventListener('click', () => download(new Blob([format(st.spec)], { type: 'application/json' }), 'poster.json'));
  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const spec = JSON.parse(await file.text());
      if (!Array.isArray(spec.elements) || !spec.size) throw new Error('not a poster');
      willChange();
      st.spec = spec;
      st.sel = -1;
      renderPalette();
      setZoom($('#zoom').value);
      changed({ structure: true });
    } catch (err) {
      showStatus(`読み込めません: ${err.message}`);
    }
    e.target.value = '';
  });
  window.addEventListener('beforeunload', (e) => {
    if (st.dirty) e.preventDefault();
  });
  window.addEventListener('resize', () => {
    if ($('#zoom').value === 'fit') setZoom('fit');
  });
}

async function main() {
  wire();
  try {
    st.spec = await loadPoster();
  } catch (err) {
    showStatus(`poster.json を読めません: ${err.message}`);
    return;
  }
  await Promise.race([
    document.fonts.load('500 17px "IBM Plex Mono"').then(() => document.fonts.ready),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  renderPalette();
  renderLayers();
  renderPanel();
  setZoom('fit');
  showStatus();
  window.posterEditor = st; // for poking at from the console
}

main();
