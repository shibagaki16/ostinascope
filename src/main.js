// Ostinascope — app wiring: source → analysis (≈10 Hz) → tracks → voices,
// and the overlay at display rate. Between analyses the camera motion
// (≈30 Hz) keeps every track on the surface it was found on.

import { createAnalyzer } from './analysis.js';
import { createTracker, warpRegion } from './tracker.js';
import { createMotion, greyOf } from './motion.js';
import { scaleH } from './homography.js';
import { AudioEngine } from './audio.js';
import { specFor, levelFor, panFor, fadeBarsFor } from './mapping.js';
import { createRenderer } from './render.js';
import { openCamera, createDemoSource } from './sources.js';
import { drawPoster, loadPoster } from './poster.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const UNIT = 192; // analysis resolution, short side (px)
const ANALYSIS_HZ = 10;
const MOTION_MS = 30; // camera motion: every new camera frame (≈30 Hz)

const analyzer = createAnalyzer();
const tracker = createTracker();
const motion = createMotion();
const audio = new AudioEngine();
const viewEl = $('#view');
const renderer = createRenderer(viewEl);

const state = {
  mode: null,
  source: null,
  camera: null,
  demo: null,
  running: false,
  debug: params.has('debug'),
  follow: !params.has('nofollow'), // move tracks with the camera motion
  motionOk: false,
  maxVoices: 6,
  insets: { top: 0, bottom: 0 },
  tracks: [],
  trackById: new Map(),
  followers: new Map(),
  result: null,
  stats: { ms: 0, hz: 0, regions: 0 },
  W: 0,
  H: 0,
  procW: UNIT,
  procH: UNIT,
  now: 0,
  audio,
};

// ---------------------------------------------------------------------------
// layout

const chain = [document.createElement('canvas'), document.createElement('canvas')];
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

function readInsets() {
  const cs = getComputedStyle($('#insets'));
  state.insets = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
}

function viewSize() {
  const r = viewEl.getBoundingClientRect();
  return [Math.round(r.width) || window.innerWidth, Math.round(r.height) || window.innerHeight];
}

function layout() {
  const [w, h] = viewSize();
  const aspectChanged = state.W && Math.abs(w / h - state.W / state.H) > 0.05;
  state.W = w;
  state.H = h;
  renderer.resize(w, h, Math.min(window.devicePixelRatio || 1, 2));
  if (w <= h) {
    state.procW = UNIT;
    state.procH = Math.round((UNIT * h) / w);
  } else {
    state.procH = UNIT;
    state.procW = Math.round((UNIT * w) / h);
  }
  proc.width = state.procW;
  proc.height = state.procH;
  readInsets();
  if (aspectChanged) {
    // coordinates changed under the tracks; start over
    tracker.reset();
    motion.reset();
    for (const id of audio.voices.keys()) audio.fadeOut(id, 1);
  }
}
window.addEventListener('resize', layout);
layout();

// ---------------------------------------------------------------------------
// analysis

function setSize(c, w, h) {
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
}

// Draw the visible view into the analysis canvas through a chain of 2×
// reductions — a single big drawImage downscale would alias fine patterns
// into fake moiré.
function grab() {
  const src = state.source;
  const short = src.cropShort(state.W / state.H);
  const halvings = Math.max(0, Math.min(2, Math.floor(Math.log2(short / UNIT))));
  let w = state.procW << halvings;
  let h = state.procH << halvings;
  let c = halvings ? chain[0] : proc;
  setSize(c, w, h);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  src.draw(g, w, h);
  for (let i = 0; i < halvings; i++) {
    w >>= 1;
    h >>= 1;
    const next = i === halvings - 1 ? proc : chain[1 - (i % 2)];
    setSize(next, w, h);
    const ng = next.getContext('2d');
    ng.imageSmoothingEnabled = true;
    ng.imageSmoothingQuality = 'high';
    ng.drawImage(c, 0, 0, c.width, c.height, 0, 0, w, h);
    c = next;
  }
  return pctx.getImageData(0, 0, state.procW, state.procH);
}

function normalise(r, unit) {
  return {
    ...r,
    cx: r.cx / unit,
    cy: r.cy / unit,
    w: r.w / unit,
    h: r.h / unit,
    period: r.period / unit,
    period2: r.period2 ? r.period2 / unit : undefined,
    center: r.center ? { x: r.center.x / unit, y: r.center.y / unit } : null,
    size: r.size ? r.size / unit : undefined,
    members: r.members
      ? r.members.map((m) => ({ ...m, x: m.x / unit, y: m.y / unit, w: m.w / unit, h: m.h / unit, t: m.t / unit }))
      : undefined,
  };
}

// One camera frame: how did the camera move since the last one? Every
// track moves with it, so outlines stay on their surface between analyses.
// Returns the frame's motion index (-1 when not following).
function follow(img, now) {
  if (!state.follow) return -1;
  const t0 = performance.now();
  grey = greyOf(img.data, img.width, img.height, grey);
  const m = motion.push(grey, img.width, img.height);
  state.motionOk = m.ok;
  const ms = performance.now() - t0;
  state.stats.motionMs = state.stats.motionMs ? state.stats.motionMs * 0.9 + ms * 0.1 : ms;
  if (state.debug) {
    state.motionPoints = motion.points;
    state.motionStats = `${motion.stats.inliers}/${motion.stats.tracked} ${state.stats.motionMs.toFixed(1)}ms`;
  }
  if (m.H) {
    tracker.warp(scaleH(m.H, 1 / Math.min(img.width, img.height)), now);
    state.tracks = tracker.tracks;
  }
  return m.k;
}
let grey = null;

// Hand a frame to the analyser (a worker when possible). The result comes
// back a little later: when following, it is moved by the camera motion
// since its frame was taken, so it lands where its surface is now;
// otherwise it is stamped with the capture time, as seen.
function analyze(now, img, k) {
  if (analyzer.busy) return false;
  const procW = state.procW;
  const procH = state.procH;
  return analyzer.submit(img, state.debug, (res) => {
    if (!res || procW !== state.procW || procH !== state.procH) return; // layout changed meanwhile
    const unit = Math.min(procW, procH);
    const viewN = { w: procW / unit, h: procH / unit };
    let dets = res.regions.map((r) => normalise(r, unit));
    let t = now;
    const C = k >= 0 && state.follow ? motion.chain(k) : null;
    if (C) {
      const Cv = scaleH(C, 1 / unit);
      dets = dets.map((d) => warpRegion(d, Cv));
      t = state.now;
    }
    tracker.update(dets, t, viewN, (tr) => fadeBarsFor(tr) * audio.bar * 1000 + 150);
    state.tracks = tracker.tracks;
    state.trackById = new Map(state.tracks.map((t) => [t.id, t]));
    syncVoices(viewN);
    state.result = res;
    state.stats.ms = state.stats.ms ? state.stats.ms * 0.85 + res.ms * 0.15 : res.ms;
    state.stats.regions = res.regions.length;
    if (state.stats.lastResult) {
      const hz = 1000 / Math.max(1, now - state.stats.lastResult);
      state.stats.hz = state.stats.hz ? state.stats.hz * 0.9 + hz * 0.1 : hz;
    }
    state.stats.lastResult = now;
  });
}

function syncVoices(viewN) {
  const active = state.tracks.filter((t) => t.state === 'active');
  for (const tr of active) tr.spec = specFor(tr);

  // Patterns that would play exactly the same loop (e.g. a field of
  // identical figures) sound once, in unison; the others point to it.
  const groups = new Map();
  for (const tr of active) {
    const g = groups.get(tr.spec.sig);
    if (g) g.push(tr);
    else groups.set(tr.spec.sig, [tr]);
  }
  state.followers = new Map();
  for (const g of groups.values()) {
    g.sort((a, b) => audio.voices.has(b.id) - audio.voices.has(a.id) || b.w * b.h - a.w * a.h);
    const [leader, ...rest] = g;
    leader.unison = 0;
    leader.groupArea = g.reduce((sum, t) => sum + t.w * t.h, 0);
    for (const tr of rest) {
      tr.unison = leader.id;
      if (audio.voices.has(tr.id)) audio.fadeOut(tr.id, 0.5);
    }
    if (rest.length) state.followers.set(leader.id, rest);
  }

  for (const tr of state.tracks) {
    if (tr.state === 'cand') continue;
    const has = audio.voices.has(tr.id);
    if (tr.state === 'active') {
      if (tr.unison) {
        tr.muted = false;
        continue;
      }
      const lvl = levelFor(tr, tr.spec, viewN, tr.groupArea);
      const pan = panFor(tr, viewN);
      if (!has) {
        tr.muted = audio.playingCount >= state.maxVoices;
        if (!tr.muted && audio.ctx) audio.addVoice(tr.id, tr.spec, lvl, pan);
      } else {
        tr.muted = false;
        if (tr.resumed) audio.resume(tr.id);
        audio.updateVoice(tr.id, tr.spec, lvl, pan);
      }
    } else if (tr.state === 'fading' && has) {
      audio.fadeOut(tr.id, fadeBarsFor(tr));
    }
  }
  for (const id of audio.voices.keys()) {
    if (!state.trackById.has(id)) audio.fadeOut(id, 0.5);
  }
}

// ---------------------------------------------------------------------------
// frame loop

let lastFrame = 0;
let lastAnalysis = 0;
let lastGrab = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  const dt = lastFrame ? Math.min(100, ts - lastFrame) : 16;
  lastFrame = ts;
  state.now = ts;
  const [vw, vh] = viewSize();
  if (vw !== state.W || vh !== state.H) layout(); // rotation, URL bar, etc.
  const src = state.source;
  if (!src) return;
  if (!src.ready()) {
    stalled(src, ts);
    return;
  }
  stall = 0;
  if (src.step) src.step(dt, ts);

  const analysisDue = ts - lastAnalysis >= 1000 / ANALYSIS_HZ - 4;
  if (state.follow ? ts - lastGrab >= MOTION_MS : analysisDue && !analyzer.busy) {
    lastGrab = ts;
    const img = grab();
    const k = follow(img, ts);
    if (analysisDue && analyze(ts, img, k)) lastAnalysis = ts;
  }

  if (audio.ctx) {
    for (const e of audio.drainEvents()) {
      const tr = state.trackById.get(e.id);
      const f = 0.5 + 0.5 * e.vel;
      if (tr) tr.flash = Math.max(tr.flash || 0, f);
      if (tr && tr.type === 'ROW') {
        tr.memberFlash ??= [];
        tr.memberFlash[e.step] = 1;
      }
      for (const t of state.followers.get(e.id) || []) t.flash = Math.max(t.flash || 0, f);
      const v = audio.voices.get(e.id);
      if (v) v.lastHit.set(e.step, ts);
    }
  }
  const decay = Math.exp(-dt / 130);
  for (const tr of state.tracks) {
    if (tr.flash) tr.flash *= decay;
    if (tr.memberFlash) for (let i = 0; i < tr.memberFlash.length; i++) tr.memberFlash[i] = (tr.memberFlash[i] || 0) * decay;
  }

  renderer.draw(state);
}

// The camera stopped delivering frames (page was in the background, the
// camera went to another app). The last view must not keep sounding:
// after a moment, let everything go; meanwhile try to get the camera back.
let stall = 0;
let reopening = false;
let reopenAt = 0;
function stalled(src, ts) {
  if (!stall) stall = ts;
  if (src.kind !== 'camera' || document.hidden) return;
  if (ts - stall > 400 && state.tracks.length) {
    tracker.reset();
    motion.reset();
    state.tracks = [];
    state.trackById = new Map();
    state.followers = new Map();
    for (const id of audio.voices.keys()) audio.fadeOut(id, 0.5);
  }
  if (src.ended) {
    if (reopening || ts - reopenAt < 3000) return;
    reopening = true;
    reopenAt = ts;
    src.stop();
    openCamera($('#video'))
      .then((cam) => {
        if (state.camera === src) state.camera = cam;
        if (state.source === src) state.source = cam;
        else cam.stop();
      })
      .catch((err) => console.warn('camera reopen failed', err))
      .finally(() => {
        reopening = false;
      });
  } else src.resume(ts);
}

// ---------------------------------------------------------------------------
// start / modes

async function fontsReady() {
  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* ignore */
  }
}

let posterPromise = null;
function posterSpec() {
  posterPromise ??= loadPoster().catch((err) => {
    posterPromise = null;
    throw err;
  });
  return posterPromise;
}

async function demoSource() {
  if (!state.demo) {
    const [spec] = await Promise.all([posterSpec(), fontsReady()]);
    state.demo = createDemoSource(drawPoster(spec, 1));
    state.demo.attach(viewEl);
  }
  return state.demo;
}

async function start(mode) {
  audio.unlock(); // synchronously, inside the tap
  $('#start-error').textContent = '';
  try {
    if (mode === 'camera') {
      if (!state.camera) state.camera = await openCamera($('#video'));
      state.source = state.camera;
    } else {
      if (state.camera) {
        state.camera.stop();
        state.camera = null;
      }
      state.source = await demoSource();
    }
  } catch (err) {
    console.error(err);
    const msg = err && err.name === 'NotAllowedError'
      ? 'カメラの使用が許可されませんでした。ブラウザの設定で許可するか、デモで試してください。'
      : `カメラを開けませんでした：${err.message || err}`;
    $('#start-error').textContent = msg;
    $('#start').hidden = false;
    return;
  }
  state.mode = mode;
  document.body.dataset.mode = mode;
  tracker.reset();
  motion.reset();
  for (const id of audio.voices.keys()) audio.fadeOut(id, 0.5);
  $('#start').hidden = true;
  document.body.classList.add('running');
  if (audio.ctx) audio.start();
  requestWakeLock();
  if (!state.running) {
    state.running = true;
    requestAnimationFrame(loop);
  }
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    /* not available — fine */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend();
  else if (state.running) {
    audio.resumeContext();
    requestWakeLock();
  }
});

$('#btn-camera').addEventListener('click', () => start('camera'));
$('#btn-demo').addEventListener('click', () => start('demo'));

// ---------------------------------------------------------------------------
// settings panel

function bindRange(id, fmt, fn) {
  const input = $(`#${id}`);
  const out = $(`#${id}-out`);
  const apply = () => {
    const v = parseFloat(input.value);
    out.textContent = fmt(v);
    fn(v);
  };
  input.addEventListener('input', apply);
  apply();
}

bindRange('bpm', (v) => String(v), (v) => audio.setBpm(v));
bindRange('sens', (v) => v.toFixed(2), (v) => analyzer.setOptions({ sensitivity: v }));
bindRange('maxv', (v) => String(v), (v) => {
  state.maxVoices = v;
});
bindRange('vol', (v) => v.toFixed(2), (v) => audio.setVolume(v));

const followEl = $('#follow');
followEl.checked = state.follow;
followEl.addEventListener('change', () => {
  state.follow = followEl.checked;
  motion.reset();
});

const dbg = $('#dbg');
dbg.checked = state.debug;
dbg.addEventListener('change', () => {
  state.debug = dbg.checked;
});

$('#btn-settings').addEventListener('click', () => {
  $('#panel').hidden = !$('#panel').hidden;
});
$('#panel-close').addEventListener('click', () => {
  $('#panel').hidden = true;
});
$('#switch-mode').addEventListener('click', () => {
  $('#panel').hidden = true;
  start(state.mode === 'camera' ? 'demo' : 'camera');
});

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const bmp = await createImageBitmap(file);
  const demo = await demoSource();
  demo.setImage(bmp);
  if (state.mode !== 'demo') start('demo');
  tracker.reset();
});

$('#save-poster').addEventListener('click', async () => {
  const [spec] = await Promise.all([posterSpec(), fontsReady()]);
  const cv = drawPoster(spec, 2);
  cv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ostinascope-specimen.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
});

// handle for poking at the app from the console (?debug)
if (params.has('debug')) window.ostinascope = { state, analyzer, tracker, audio, motion };

// dev shortcut: ?mode=demo starts without the splash (audio stays locked
// until the first tap)
if (params.get('mode') === 'demo') {
  start('demo');
  window.addEventListener('pointerdown', () => {
    audio.unlock();
    audio.start();
  }, { once: true });
}
