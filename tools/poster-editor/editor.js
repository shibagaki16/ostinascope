// Ostinascope poster editor — edits poster/poster.json.
//
// Reads the app's poster renderer (element types, their fields and how they
// draw) and its detector (for "カメラで見る"); the app knows nothing about
// this tool. Saving needs tools/poster-editor/serve.py; without it the
// poster can still be exported as JSON / PNG.

import {
  TYPES, paint, drawPoster, loadPoster, boundsOf, moveElement, createElement, context, drawElement, debrisPieces,
  textLayout, remapKern, rotateElement, rotationCentre, PATTERN_DEFAULTS, SHAPE_DEFAULTS, POSTER_URL,
} from '../../src/poster/poster.js';
import { createDetector } from '../../src/detect/detector.js';
import { distanceField, scatterPieces } from './scatter.js';
import { COLORS } from '../../src/app/render.js';

const $ = (s) => document.querySelector(s);
const posterCv = $('#poster');
const overlay = $('#overlay');
const g = posterCv.getContext('2d');
const og = overlay.getContext('2d');

const st = {
  spec: null,
  sel: -1, // the element the panel shows (the last one clicked)
  multi: [], // every selected element (indices; includes sel)
  hover: -1,
  // the view: the sheet is drawn at `zoom` screen px per design px, its
  // top-left corner at (ox, oy) in the work area; `fit` follows the window
  zoom: 0.3,
  ox: 16,
  oy: 16,
  fit: true,
  pan: null, // dragging the view: { x, y, ox, oy }
  space: false, // space held: dragging moves the view
  dirty: false,
  undo: [],
  redo: [],
  drag: null,
  caret: null, // pair kerning: { i: element index, line, gap } (gap = after character `gap`)
  scope: { on: false, pinned: false, x: 900, y: 1200, s: 600, result: null, busy: false, stale: true },
};

// ---------------------------------------------------------------- helpers

const W = () => st.spec.size[0];
const H = () => st.spec.size[1];
const ctx = () => context(st.spec);
const selEl = () => st.spec.elements[st.sel] || null;
const selection = () => st.multi.filter((i) => i >= 0 && i < st.spec.elements.length);
const selEls = () => selection().map((i) => st.spec.elements[i]);
// one element selected (or none: -1)
function setSel(i) {
  st.sel = i;
  st.multi = i >= 0 ? [i] : [];
}
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
  st.multi = selection();
  if (!st.multi.includes(st.sel)) st.sel = st.multi.length ? st.multi.at(-1) : -1;
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

const BG = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#e6e3dd';
const dpr = () => window.devicePixelRatio || 1;

function paintPoster() {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = BG;
  g.fillRect(0, 0, posterCv.width, posterCv.height);
  const k = st.zoom * dpr();
  g.setTransform(k, 0, 0, k, st.ox * dpr(), st.oy * dpr());
  g.save();
  g.shadowColor = 'rgba(0, 0, 0, 0.15)'; // the sheet (shadows ignore the transform: device px)
  g.shadowBlur = 12 * dpr();
  g.shadowOffsetY = 2 * dpr();
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W(), H());
  g.restore();
  g.save();
  g.beginPath();
  g.rect(0, 0, W(), H()); // as on paper: nothing outside the sheet
  g.clip();
  paint(g, st.spec);
  g.restore();
}

function paintOverlay() {
  const k = st.zoom * dpr();
  og.setTransform(1, 0, 0, 1, 0, 0);
  og.clearRect(0, 0, overlay.width, overlay.height);
  og.setTransform(k, 0, 0, k, st.ox * dpr(), st.oy * dpr());
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
  if (st.hover >= 0 && !st.multi.includes(st.hover) && !st.scope.on) outline(st.spec.elements[st.hover], 'rgba(31,79,209,0.7)', [4, 3]);
  const sel = selEls();
  for (const s of sel) for (const o of linkedTo(s)) if (!sel.includes(o)) outline(o, 'rgba(215,38,43,0.5)', [2, 3]);
  for (const s of sel) outline(s, '#D7262B', s === selEl() ? [7, 4] : [3, 3]);
  if (sel.length > 1) {
    const b = unionBounds(sel);
    og.strokeStyle = 'rgba(215,38,43,0.35)';
    og.lineWidth = px;
    og.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }
  if (st.drag?.guides) paintGuides(st.drag.guides, px);

  const cr = caretAt();
  if (cr) {
    og.strokeStyle = '#D7262B';
    og.fillStyle = '#D7262B';
    og.lineWidth = 2 * px;
    og.beginPath();
    og.moveTo(cr.x, cr.y - cr.el.size * 0.95);
    og.lineTo(cr.x, cr.y + cr.el.size * 0.25);
    og.stroke();
    og.font = `500 ${12 * px}px "IBM Plex Mono", monospace`;
    og.fillText(cr.value > 0 ? `+${cr.value}` : String(cr.value), cr.x + 3 * px, cr.y - cr.el.size * 0.95 - 3 * px);
  }

  if (st.scope.on) paintScope(px);
}

// ---------------------------------------------------------------- view: zoom and pan
//
// The canvases fill the work area and the sheet is drawn into them at the
// view's zoom and offset, so zooming far in costs no larger canvas.
// Swipe / wheel moves the view, ⌘+wheel or a pinch zooms around the
// pointer, space+drag or the middle button drags it; ⌘+ ⌘− zoom in steps,
// ⌘0 shows the whole sheet, ⌘1 is 100% (as in Illustrator).

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;
const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.66, 1, 1.5, 2, 3, 4, 6, 8];
const ZOOM_MENU = [0.25, 0.5, 1, 2, 4]; // the presets in the menu (index.html)

function stageSize() {
  const stage = $('#stage');
  return { w: stage.clientWidth, h: stage.clientHeight };
}

// both canvases as large as the work area
function resizeCanvases() {
  const { w, h } = stageSize();
  for (const c of [posterCv, overlay]) {
    c.width = Math.round(w * dpr());
    c.height = Math.round(h * dpr());
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }
}

function viewChanged() {
  showZoom();
  requestPaint();
}

function fitView() {
  const { w, h } = stageSize();
  st.zoom = Math.min((w - 32) / W(), (h - 32) / H());
  st.ox = (w - W() * st.zoom) / 2;
  st.oy = (h - H() * st.zoom) / 2;
  st.fit = true;
  viewChanged();
}

// zoom to z, keeping what is under the work-area point (sx, sy) in place
function zoomAt(z, sx, sy) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  st.ox = sx - ((sx - st.ox) * z) / st.zoom;
  st.oy = sy - ((sy - st.oy) * z) / st.zoom;
  st.zoom = z;
  st.fit = false;
  viewChanged();
}

function zoomCentre(z) {
  const { w, h } = stageSize();
  zoomAt(z, w / 2, h / 2);
}

function zoomStep(dir) {
  const z = dir > 0 ? ZOOM_STEPS.find((s) => s > st.zoom * 1.01) : ZOOM_STEPS.findLast((s) => s < st.zoom / 1.01);
  if (z) zoomCentre(z);
}

function panBy(dx, dy) {
  st.ox += dx;
  st.oy += dy;
  st.fit = false;
  viewChanged();
}

// the menu: "全体（31%）", a preset, or the zoom as it is
function setZoom(z) {
  if (z === 'fit') fitView();
  else if (z !== 'now') zoomCentre(+z);
}
function showZoom() {
  const menu = $('#zoom');
  const pct = `${Math.round(st.zoom * 100)}%`;
  menu.querySelector('option[value="fit"]').textContent = st.fit ? `全体（${pct}）` : '全体';
  const preset = ZOOM_MENU.find((z) => Math.abs(z - st.zoom) < 1e-6);
  if (st.fit || preset) {
    menu.value = st.fit ? 'fit' : String(preset);
    return;
  }
  let now = menu.querySelector('option[value="now"]');
  if (!now) {
    now = new Option('', 'now');
    now.hidden = true;
    menu.prepend(now);
  }
  now.textContent = pct;
  menu.value = 'now';
}

// work-area px of a pointer event
function stagePoint(e) {
  const r = overlay.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

let gesture = null; // Safari's pinch (it sends gestures, not ⌘+wheel)
function wireView() {
  const stage = $('#stage');
  stage.addEventListener('wheel', (e) => {
    e.preventDefault(); // neither the page nor the browser's own zoom
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageSize().h : 1;
    if (e.ctrlKey || e.metaKey) {
      if (gesture) return;
      // a pinch on a trackpad comes as ctrl+wheel; a mouse notch is ~100
      const d = Math.max(-50, Math.min(50, e.deltaY * unit));
      const { sx, sy } = stagePoint(e);
      zoomAt(st.zoom * Math.exp(-d * 0.01), sx, sy);
    } else {
      panBy(-e.deltaX * unit, -e.deltaY * unit);
    }
  }, { passive: false });
  stage.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gesture = { zoom: st.zoom };
  });
  stage.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const { sx, sy } = stagePoint(e);
    zoomAt(gesture.zoom * e.scale, sx, sy);
  });
  stage.addEventListener('gestureend', () => {
    gesture = null;
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll on the middle button
  });
  // the work area changes with the window (and the panes): keep the
  // canvases its size, and a fitted sheet fitted
  new ResizeObserver(() => {
    if (!st.spec) return;
    resizeCanvases();
    if (st.fit) fitView();
    else requestPaint();
  }).observe(stage);
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') setSpace(false);
  });
  window.addEventListener('blur', () => setSpace(false));
}

function setSpace(on) {
  st.space = on;
  overlay.classList.toggle('grab', on);
}

// space+drag or the middle button: drag the view. True when it started.
function startPan(e) {
  if (e.button !== 1 && !st.space) return false;
  e.preventDefault();
  overlay.setPointerCapture(e.pointerId);
  st.pan = { x: e.clientX, y: e.clientY, ox: st.ox, oy: st.oy };
  overlay.classList.add('grabbing');
  return true;
}

// ---------------------------------------------------------------- layers

function renderLayers() {
  const list = $('#layer-list');
  list.textContent = '';
  const linked = new Set(selEls().flatMap(linkedTo));
  // topmost first
  for (let i = st.spec.elements.length - 1; i >= 0; i--) {
    const e = st.spec.elements[i];
    const li = document.createElement('li');
    li.className = (i === st.sel ? 'sel ' : st.multi.includes(i) ? 'multi ' : '') + (e.hidden ? 'hidden ' : '') + (linked.has(e) ? 'linked' : '');
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
    li.addEventListener('click', (ev) => select(i, { toggle: ev.shiftKey }));
    list.append(li);
  }
}

// select one element (-1: none), or with toggle add it to / take it out of
// the selection
function select(i, { toggle = false } = {}) {
  const before = st.sel;
  if (toggle && i >= 0) {
    const at = st.multi.indexOf(i);
    if (at < 0) {
      st.multi.push(i);
      st.sel = i;
    } else {
      st.multi.splice(at, 1);
      if (st.sel === i) st.sel = st.multi.length ? st.multi.at(-1) : -1;
    }
  } else {
    setSel(i);
  }
  if (st.sel !== before || st.multi.length > 1) st.caret = null;
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
  const n = selection().length;
  $('#props-title').textContent = el ? `${nameOf(el)}${n > 1 ? ` ほか ${n - 1} 個` : ''} — ${TYPES[el.type]?.label || el.type}` : '（要素を選んでください）';
  if (!el) return;
  if (n > 1) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `${n} 個を選んでいます。下の項目は「${nameOf(el)}」だけに効きます。整列は左の欄のボタンで、移動はまとめてできます。`;
    form.append(note);
  }
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
  if (el.type === 'text') form.append(kernActions(el));
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
      input.value = v ?? f.def ?? '';
      input.addEventListener('input', () => {
        if (input.value === '' || !Number.isFinite(+input.value)) return;
        if (f.key === 'rotation' && linkedTo(el).length) {
          // what follows it turns with it, about its centre
          willChange(key);
          const [cx, cy] = rotationCentre(el, g, ctx());
          for (const o of linkedTo(el)) rotateElement(o, +input.value - (el.rotation || 0), cx, cy, g, ctx());
          el.rotation = +input.value;
          if (el.type === 'piece') el.pin = true;
          changed();
          return;
        }
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
      input.addEventListener('input', () => {
        const lines = input.value.split('\n');
        willChange(key);
        // pair kerning stays on its two characters
        if (el.kern) {
          el.kern = remapKern(el.kern, getPath(el, f.key) || [], lines);
          if (!el.kern) delete el.kern;
        }
        setPath(el, f.key, lines);
        changed();
      });
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
  const { sx, sy } = stagePoint(e);
  return { x: (sx - st.ox) / st.zoom, y: (sy - st.oy) / st.zoom };
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
  if (startPan(e)) return;
  const p = toDesign(e);
  if (st.scope.on) {
    st.scope.pinned = !st.scope.pinned;
    Object.assign(st.scope, p, { stale: true });
    requestPaint();
    return;
  }
  const i = hitTest(p);
  if (caretAt() && i === st.sel && !e.shiftKey) {
    placeCaret(selEl(), p); // kerning: a click moves the caret, it does not drag
    return;
  }
  // ⇧: add to / take out of the selection; a click on one of several
  // selected keeps them all (to drag them together; a click alone, without
  // dragging, then selects just that one)
  let only = -1;
  if (e.shiftKey) select(i, { toggle: true });
  else if (i >= 0 && st.multi.length > 1 && st.multi.includes(i)) only = i;
  else select(i);
  if (i < 0 || !st.multi.includes(i)) return;
  if (only >= 0 && st.sel !== i) {
    st.sel = i;
    renderLayers();
    renderPanel();
  }
  overlay.setPointerCapture(e.pointerId);
  willChange(`drag:${performance.now()}`);
  const moving = movingSet(e.altKey);
  st.drag = { start: p, moved: { x: 0, y: 0 }, alone: e.altKey, only, box: unionBounds(selEls()), targets: snapTargets(moving), guides: null };
});

overlay.addEventListener('pointermove', (e) => {
  const p = toDesign(e);
  $('#coords').textContent = `x ${Math.round(p.x)}  y ${Math.round(p.y)}  (u ${(p.x / (st.spec.unit || 12)).toFixed(1)}, ${(p.y / (st.spec.unit || 12)).toFixed(1)})`;
  if (st.pan) {
    st.ox = st.pan.ox + e.clientX - st.pan.x;
    st.oy = st.pan.oy + e.clientY - st.pan.y;
    st.fit = false;
    viewChanged();
    return;
  }
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
  const step = e.shiftKey ? u : 1;
  dx = Math.round(dx / step) * step;
  dy = Math.round(dy / step) * step;
  // ⇧ is the u grid; otherwise edges and middles snap (⌘ held: not now)
  const snapped = !e.shiftKey && !(e.metaKey || e.ctrlKey) && $('#snap').checked ? smartSnap(st.drag, dx, dy) : null;
  if (snapped) ({ dx, dy } = snapped);
  st.drag.guides = snapped?.guides || null;
  const ddx = dx - st.drag.moved.x;
  const ddy = dy - st.drag.moved.y;
  if (!ddx && !ddy) {
    requestPaint(); // the guides may have changed
    return;
  }
  moveSelected(ddx, ddy, st.drag.alone);
  st.drag.moved = { x: dx, y: dy };
});

overlay.addEventListener('pointerup', () => {
  if (st.pan) {
    st.pan = null;
    overlay.classList.remove('grabbing');
    return;
  }
  const d = st.drag;
  st.drag = null;
  if (d && (d.moved.x || d.moved.y)) renderPanel();
  else if (d && d.only >= 0) select(d.only);
  requestPaint();
});
overlay.addEventListener('pointerleave', () => {
  st.hover = -1;
  requestPaint();
});
overlay.addEventListener('dblclick', (e) => {
  const el = selEl();
  if (!st.scope.on && el?.type === 'text') placeCaret(el, toDesign(e));
});

// what moves with the selection: the selected elements and, unless alone,
// what follows them (each once)
function movingSet(alone = false) {
  const sel = selEls();
  const set = new Set(sel);
  if (!alone) for (const el of sel) for (const o of linkedTo(el)) set.add(o);
  return [...set];
}

function moveSelected(dx, dy, alone = false) {
  const sel = selEls();
  if (!sel.length) return;
  for (const el of movingSet(alone)) moveElement(el, dx, dy);
  for (const el of sel) if (el.type === 'piece') el.pin = true; // placed by hand: keep it when scattering again
  st.dirty = true;
  st.scope.stale = true;
  showStatus();
  requestPaint();
}

// ---------------------------------------------------------------- snapping and aligning

const r2 = (v) => Math.round(v * 100) / 100 || 0; // (never −0)

function unionBounds(els) {
  const c = ctx();
  const bs = els.map((el) => boundsOf(el, g, c)).filter(Boolean);
  if (!bs.length) return null;
  return {
    x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)),
    x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)),
  };
}

// What a drag can snap to: the edges and middles of every other visible
// element and of the sheet. x targets carry the y extent of what they come
// from (for drawing the guide), y targets the x extent.
const NO_SNAP = new Set(['frame', 'debris', 'scatter']); // areas, not things
function snapTargets(moving) {
  const c = ctx();
  const skip = new Set(moving);
  const xs = [];
  const ys = [];
  const add = (b, sheet = false) => {
    for (const v of [b.x0, (b.x0 + b.x1) / 2, b.x1]) xs.push({ v, lo: b.y0, hi: b.y1, sheet });
    for (const v of [b.y0, (b.y0 + b.y1) / 2, b.y1]) ys.push({ v, lo: b.x0, hi: b.x1, sheet });
  };
  add({ x0: 0, y0: 0, x1: W(), y1: H() }, true);
  for (const el of st.spec.elements) {
    if (el.hidden || skip.has(el) || NO_SNAP.has(el.type)) continue;
    const b = boundsOf(el, g, c);
    if (b) add(b);
  }
  return { xs, ys };
}

// The drag (dx, dy) moved so that an edge or the middle of the selection
// meets the nearest target within 6 screen px, on each axis; and the guides
// of everything it then lines up with.
function smartSnap(drag, dx, dy) {
  const b = drag.box;
  if (!b) return null;
  const reach = 6 / st.zoom;
  const axis = (lo, hi, d, targets) => {
    const ms = [lo + d, (lo + hi) / 2 + d, hi + d];
    let best = null;
    for (const t of targets) for (const m of ms) if (Math.abs(t.v - m) <= reach && (best == null || Math.abs(t.v - m) < Math.abs(best))) best = t.v - m;
    return best == null ? d : r2(d + best);
  };
  dx = axis(b.x0, b.x1, dx, drag.targets.xs);
  dy = axis(b.y0, b.y1, dy, drag.targets.ys);
  const nb = { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
  const on = (v, ms) => ms.some((m) => Math.abs(v - m) < 0.01);
  const mx = [nb.x0, (nb.x0 + nb.x1) / 2, nb.x1];
  const my = [nb.y0, (nb.y0 + nb.y1) / 2, nb.y1];
  const guides = [
    ...drag.targets.xs.filter((t) => on(t.v, mx)).map((t) => ({ x: t.v, lo: Math.min(t.lo, nb.y0), hi: Math.max(t.hi, nb.y1) })),
    ...drag.targets.ys.filter((t) => on(t.v, my)).map((t) => ({ y: t.v, lo: Math.min(t.lo, nb.x0), hi: Math.max(t.hi, nb.x1) })),
  ];
  return { dx, dy, guides };
}

function paintGuides(guides, px) {
  og.strokeStyle = '#E6007E';
  og.lineWidth = px;
  og.beginPath();
  for (const gd of guides) {
    if (gd.x != null) {
      og.moveTo(gd.x, gd.lo);
      og.lineTo(gd.x, gd.hi);
    } else {
      og.moveTo(gd.lo, gd.y);
      og.lineTo(gd.hi, gd.y);
    }
  }
  og.stroke();
}

// Line the selection up: several selected, with each other (the box around
// them); one, with the sheet. What follows an element moves with it.
function align(edge) {
  const sel = selEls();
  if (!sel.length) return;
  const c = ctx();
  const boxes = sel.map((el) => boundsOf(el, g, c));
  const t = sel.length > 1 ? unionBounds(sel) : { x0: 0, y0: 0, x1: W(), y1: H() };
  const mid = (a, b) => (a + b) / 2;
  willChange();
  sel.forEach((el, k) => {
    const b = boxes[k];
    if (!b) return;
    const dx = r2({ left: t.x0 - b.x0, centre: mid(t.x0, t.x1) - mid(b.x0, b.x1), right: t.x1 - b.x1 }[edge] ?? 0);
    const dy = r2({ top: t.y0 - b.y0, middle: mid(t.y0, t.y1) - mid(b.y0, b.y1), bottom: t.y1 - b.y1 }[edge] ?? 0);
    if (!dx && !dy) return;
    moveElement(el, dx, dy);
    if (el.type === 'piece') el.pin = true;
    for (const o of linkedTo(el)) if (!sel.includes(o)) moveElement(o, dx, dy);
  });
  changed({ panel: true });
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
  if (e.code === 'Space') {
    e.preventDefault();
    if (!st.space) setSpace(true);
    return;
  }
  // zoom (⌘+ is shift+; on a JIS keyboard, ⌘^ next to −)
  if (mod && (['+', '=', ';', '^'].includes(e.key) || ['Equal', 'Semicolon', 'NumpadAdd'].includes(e.code))) {
    e.preventDefault();
    zoomStep(1);
    return;
  }
  if (mod && (e.key === '-' || ['Minus', 'NumpadSubtract'].includes(e.code))) {
    e.preventDefault();
    zoomStep(-1);
    return;
  }
  if (mod && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
    e.preventDefault();
    fitView();
    return;
  }
  if (mod && (e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1')) {
    e.preventDefault();
    zoomCentre(1);
    return;
  }
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
  if (caretAt() && caretKey(e)) {
    e.preventDefault();
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

// every selected element, each copy right above its original; the copies
// become the selection
function duplicate() {
  const sel = selEls();
  if (!sel.length) return;
  willChange();
  const els = st.spec.elements;
  const primary = selEl();
  let main = null;
  const copies = sel.map((el) => {
    const copy = structuredClone(el);
    if (copy.id) copy.id = uniqueId(copy.id);
    moveElement(copy, 24, 24);
    els.splice(els.indexOf(el) + 1, 0, copy);
    if (el === primary) main = copy;
    return copy;
  });
  st.multi = copies.map((c) => els.indexOf(c));
  st.sel = els.indexOf(main);
  changed({ structure: true });
}

function remove() {
  const idx = selection();
  if (!idx.length) return;
  willChange();
  const drop = new Set(idx.map((i) => st.spec.elements[i]));
  st.spec.elements = st.spec.elements.filter((el) => !drop.has(el));
  setSel(Math.min(Math.min(...idx), st.spec.elements.length - 1));
  changed({ structure: true });
}

function reorder(delta) {
  const i = st.sel;
  const j = i + delta;
  if (i < 0 || j < 0 || j >= st.spec.elements.length) return;
  willChange();
  const els = st.spec.elements;
  [els[i], els[j]] = [els[j], els[i]];
  setSel(j);
  changed({ structure: true });
}

function add(type) {
  // the middle of what is on screen
  const { w, h } = stageSize();
  const cx = Math.max(0, (w / 2 - st.ox) / st.zoom);
  const cy = Math.max(0, (h / 2 - st.oy) / st.zoom);
  willChange();
  const el = createElement(type, Math.round(Math.min(cx, W() / 2 + 400)), Math.round(Math.min(cy, H() - 200)));
  el.id = uniqueId(type);
  st.spec.elements.push(el);
  setSel(st.spec.elements.length - 1);
  changed({ structure: true });
}

// ---------------------------------------------------------------- text: pair kerning

// lines that have a gap (two characters or more), and where a gap is drawn
const gapped = (lines) => lines.flatMap((l, i) => (l.chars.length > 1 ? [i] : []));
const gapX = (chars, i) => (chars[i].x + chars[i].w + chars[i + 1].x) / 2;

function nearestGap(chars, x) {
  let best = 0;
  for (let i = 1; i < chars.length - 1; i++) if (Math.abs(gapX(chars, i) - x) < Math.abs(gapX(chars, best) - x)) best = i;
  return best;
}

// The caret in the selected text, kept inside its lines (undo or editing
// the text can shorten them); null when there is none.
function caretAt() {
  const el = selEl();
  if (!st.caret || st.caret.i !== st.sel || el?.type !== 'text') return null;
  const lines = textLayout(g, el);
  const ok = gapped(lines);
  if (!ok.length) return null;
  const want = st.caret.line;
  const line = ok.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  const { chars, y } = lines[line];
  const gap = Math.max(0, Math.min(st.caret.gap, chars.length - 2));
  Object.assign(st.caret, { line, gap });
  return { el, lines, line, gap, x: gapX(chars, gap), y, value: el.kern?.[`${line}:${gap}`] || 0 };
}

// the caret in the gap nearest to p
function placeCaret(el, p) {
  const lines = textLayout(g, el);
  const ok = gapped(lines);
  if (!ok.length) return;
  const mid = (i) => lines[i].y - el.size * 0.35;
  const line = ok.reduce((a, b) => (Math.abs(mid(b) - p.y) < Math.abs(mid(a) - p.y) ? b : a));
  st.caret = { i: st.sel, line, gap: nearestGap(lines[line].chars, p.x) };
  requestPaint();
}

// one gap's kerning; 0 removes it (kept in reading order for tidy diffs)
function setKern(el, key, value) {
  const kern = { ...el.kern, [key]: value };
  const order = (k) => k.split(':').map(Number);
  const keys = Object.keys(kern).filter((k) => kern[k]).sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  if (keys.length) el.kern = Object.fromEntries(keys.map((k) => [k, kern[k]]));
  else delete el.kern;
}

// Keys while the caret is shown; true when used. ⌥←/⌥→ kern by 10/1000 em
// (100 with ⇧), ←→↑↓ move the caret, Delete sets the gap back to 0 (it
// never deletes the element here), Esc ends.
function caretKey(e) {
  const cr = caretAt();
  const { el, lines, line, gap } = cr;
  const key = `${line}:${gap}`;
  const ok = gapped(lines);
  const k = ok.indexOf(line);
  switch (e.key) {
    case 'Escape':
      st.caret = null;
      break;
    case 'Delete':
    case 'Backspace':
      if (!cr.value) break;
      willChange();
      setKern(el, key, 0);
      changed({ panel: true });
      break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.altKey) {
        willChange(`kern:${st.sel}:${key}`);
        setKern(el, key, cr.value + d * (e.shiftKey ? 100 : 10));
        changed({ panel: true });
      } else if (gap + d >= 0 && gap + d <= lines[line].chars.length - 2) {
        st.caret.gap = gap + d;
      } else if (ok[k + d] != null) {
        const next = ok[k + d];
        Object.assign(st.caret, { line: next, gap: d < 0 ? lines[next].chars.length - 2 : 0 });
      }
      break;
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      const next = ok[k + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next != null) Object.assign(st.caret, { line: next, gap: nearestGap(lines[next].chars, cr.x) });
      break;
    }
    default:
      return false;
  }
  requestPaint();
  return true;
}

function kernActions(el) {
  const box = document.createElement('div');
  box.className = 'actions';
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'ペアカーニング：紙面の文字をダブルクリックすると、文字の間にカーソルが出ます。'
    + '⌥← ⌥→ でその間を 10 ずつ詰める／空ける（⇧ も押すと 100）。← → ↑ ↓ でカーソルを動かし、'
    + 'Delete でその間を 0 に戻し、Esc で終わります。カーソルが出ている間、文字はドラッグで動きません。';
  box.append(note);
  const n = Object.keys(el.kern || {}).length;
  if (n) {
    const row = document.createElement('div');
    row.className = 'row';
    const b = document.createElement('button');
    b.type = 'button'; // inside the form: not a submit
    b.textContent = `ペアカーニングを消す（${n} か所）`;
    b.addEventListener('click', () => {
      willChange();
      delete el.kern;
      changed({ panel: true });
    });
    row.append(b);
    box.append(row);
  }
  return box;
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
  setSel(st.spec.elements.indexOf(el));
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
  setSel(st.spec.elements.indexOf(el));
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
  for (const b of document.querySelectorAll('[data-align]')) b.addEventListener('click', () => align(b.dataset.align));
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
      setSel(-1);
      renderPalette();
      fitView(); // the sheet may have another size
      changed({ structure: true });
    } catch (err) {
      showStatus(`読み込めません: ${err.message}`);
    }
    e.target.value = '';
  });
  window.addEventListener('beforeunload', (e) => {
    if (st.dirty) e.preventDefault();
  });
  wireView();
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
  resizeCanvases();
  fitView();
  showStatus();
  window.posterEditor = st; // for poking at from the console
}

main();
