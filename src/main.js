// Ostinascope — app wiring: source → analysis (≈10 Hz) → tracks → voices,
// and the overlay at display rate. Between analyses the camera motion
// (≈30 Hz) keeps every track on the surface it was found on.

import { createAnalyzer } from './detect/analysis.js';
import { createTracker, toViewUnits } from './track/tracker.js';
import { greyOf } from './track/motion.js';
import { createFollower } from './track/follow.js';
import { AudioEngine } from './sound/audio.js';
import { specFor, levelFor, panFor, fadeBarsFor } from './sound/mapping.js';
import { createRenderer } from './app/render.js';
import { openCamera, createDemoSource } from './app/sources.js';
import { drawPoster, loadPoster } from './poster/poster.js';
import { registerUpdates, serverVersion, formatVersion, refreshApp, runningBuild, publishedBuild, formatBuild } from './app/update.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const UNIT = 192; // analysis resolution, short side (px)
const ANALYSIS_HZ = 10;
const MOTION_MS = 30; // camera motion: every new camera frame (≈30 Hz)

const analyzer = createAnalyzer();
const tracker = createTracker();
const follower = createFollower();
const motion = follower.motion;
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
  surfaces: [], // surfaces told apart by their motion (when more than one)
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
  paused: null, // the camera stopped: what the screen says instead of the loops
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
  if (aspectChanged) clearTracks(); // coordinates changed under the tracks; start over
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

// One camera frame: how did the camera move since the last one? Every
// track moves with the surface it is on, so outlines stay put between
// analyses. Returns the frame's motion index (-1 when not following).
function follow(img, now) {
  if (!state.follow) return -1;
  const t0 = performance.now();
  grey = greyOf(img.data, img.width, img.height, grey);
  const m = follower.step(grey, img.width, img.height, tracker, now);
  state.motionOk = m.ok;
  state.tracks = tracker.tracks;
  state.surfaces = follower.surfaces();
  const ms = performance.now() - t0;
  state.stats.motionMs = state.stats.motionMs ? state.stats.motionMs * 0.9 + ms * 0.1 : ms;
  if (state.debug) {
    state.motionPoints = motion.points;
    state.motionStats = `${motion.stats.inliers}/${motion.stats.tracked} ${state.stats.motionMs.toFixed(1)}ms` +
      (motion.stats.planes > 1 ? ` ${motion.stats.planes} surfaces` : '');
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
    let dets = res.regions.map((r) => toViewUnits(r, unit));
    let t = now;
    const placed = k >= 0 && state.follow ? follower.place(dets, k, unit) : null;
    if (placed) {
      dets = placed;
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
  audio.watch(ts); // a context iOS broke in the background: noticed here, made anew on a tap
  const src = state.source;
  if (!src) return;
  // An error in one frame (an odd frame size, a browser quirk) must not stop
  // the drawing: the screen would freeze with the last loops on it.
  let ready = false;
  try {
    ready = src.ready();
    if (ready) {
      if (stall) recovered();
      frame(src, ts, dt);
    } else {
      stalled(src, ts);
    }
  } catch (err) {
    oops(err);
  }
  if (!ready && !state.paused) return; // a short hiccup: keep the last picture
  try {
    renderer.draw(state);
  } catch (err) {
    oops(err);
  }
}

function frame(src, ts, dt) {
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
}

let lastOops = 0;
function oops(err) {
  const t = performance.now();
  if (t - lastOops < 2000) return; // not every frame
  lastOops = t;
  console.error('frame failed', err);
}

// Let every pattern go: no tracks, their voices fade.
function clearTracks() {
  tracker.reset();
  follower.reset();
  state.tracks = [];
  state.trackById = new Map();
  state.followers = new Map();
  state.result = null;
  state.motionPoints = null;
  state.stats.regions = 0;
  for (const id of audio.voices.keys()) audio.fadeOut(id, 0.5);
}

// The camera stopped delivering frames (page was in the background, the
// camera went to another app, iOS froze the track). The last view must not
// stay on screen or keep sounding: after a moment, let everything go and
// say so; meanwhile try to get the camera back — the video restarted, or
// the camera opened again when that does not help.
const PAUSED = 'カメラの映像が止まっています — 戻るまでお待ちください（タップで再開）';
let stall = 0;
let reopening = false;
let reopenAt = -1e9;
let reopenFails = 0;
function stalled(src, ts) {
  if (!stall) stall = ts;
  if (src.kind !== 'camera' || document.hidden) return;
  const ms = ts - stall;
  if (ms > 400) {
    if (state.tracks.length || audio.voices.size) clearTracks();
    state.paused = PAUSED;
  }
  if (src.ended || ms > 2500) reopenCamera(src, ts);
  else src.resume(ts);
}

function recovered() {
  stall = 0;
  reopenFails = 0;
  state.paused = null;
}

function reopenCamera(src, ts, now = false) {
  if (reopening || (!now && ts - reopenAt < 3000)) return;
  reopening = true;
  reopenAt = ts;
  src.stop();
  openCamera($('#video'))
    .then((cam) => {
      if (state.source === src) {
        state.source = cam;
        state.camera = cam;
      } else {
        // switched to the demo meanwhile
        cam.stop();
        if (state.camera === src) state.camera = null;
      }
    })
    .catch((err) => {
      console.warn('camera reopen failed', err);
      reopenFails++;
      // taken away for good (permission withdrawn) or again and again
      // (another app keeps it): back to the start, saying why
      if (state.source === src && (err?.name === 'NotAllowedError' || reopenFails >= 3)) cameraLost(err);
    })
    .finally(() => {
      reopening = false;
    });
}

function cameraLost(err) {
  clearTracks();
  if (state.camera) state.camera.stop();
  state.camera = null;
  state.source = null;
  state.paused = null;
  stall = 0;
  reopenFails = 0;
  showStart(startError('camera', err), refusedHelp(err));
}

// The start screen again, with what went wrong (and, for a refused camera,
// how to allow it again).
function showStart(message, help = null) {
  const box = $('#start-error');
  box.textContent = '';
  const line = (text, cls) => {
    const el = document.createElement('p');
    if (cls) el.className = cls;
    el.textContent = text;
    box.append(el);
  };
  line(message);
  if (help) {
    if (help.lead) line(help.lead, 'lead-in');
    if (help.steps) {
      const ol = document.createElement('ol');
      ol.className = 'steps';
      for (const step of help.steps) {
        const li = document.createElement('li');
        li.textContent = step;
        ol.append(li);
      }
      box.append(ol);
    }
    if (help.reload) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary';
      b.textContent = '読み込み直す';
      b.addEventListener('click', () => {
        try {
          sessionStorage.setItem('osc-camera-retry', '1');
        } catch {
          /* no storage: reload anyway */
        }
        location.reload();
      });
      box.append(b);
    }
    if (help.after) line(help.after, 'after');
  }
  $('#panel').hidden = true;
  $('#start').hidden = false;
  document.body.classList.remove('running');
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

// ---------------------------------------------------------------------------
// a refused camera: how to allow it again, and opening it once allowed
//
// Once "blocked", a browser does not ask again by itself — getUserMedia is
// refused at once, with no dialog (that is how browsers keep sites from
// asking over and over). Only its setting brings the camera back; so say
// where it is, and watch the permission: once it is "allow" (or "ask"
// again), open the camera without a reload.

let cameraPerm = null; // the browser's camera permission, when it tells (PermissionStatus)
let awaitingCamera = false; // refused: open the camera once it is allowed
if (navigator.permissions?.query) {
  navigator.permissions.query({ name: 'camera' }).then((p) => {
    cameraPerm = p;
    p.addEventListener('change', () => cameraAllowed(p.state));
  }, () => {
    /* this browser cannot tell: the steps say to reload */
  });
}

// back from "読み込み直す": say what comes next
try {
  if (sessionStorage.getItem('osc-camera-retry')) {
    sessionStorage.removeItem('osc-camera-retry');
    const p = document.createElement('p');
    p.className = 'after';
    p.textContent = '読み込み直しました。「タップして開始」を押すと、もう一度カメラの許可を聞かれます。聞かれないときは、Web サイトの設定でカメラを「確認」か「許可」にしてください。';
    $('#start-error').append(p);
  }
} catch {
  /* no storage */
}

function cameraAllowed(st) {
  if (!awaitingCamera || st === 'denied' || $('#start').hidden) return;
  awaitingCamera = false;
  start('camera');
}

// some browsers change the setting in another window without telling the
// page: look again when it is back
function recheckCamera() {
  if (!awaitingCamera || document.hidden || !navigator.permissions?.query) return;
  navigator.permissions.query({ name: 'camera' }).then((p) => cameraAllowed(p.state), () => {});
}
window.addEventListener('focus', recheckCamera);
document.addEventListener('visibilitychange', recheckCamera);

function browserKind() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return /CriOS/.test(ua) ? 'ios-chrome' : 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

const ALLOW_STEPS = {
  chrome: ['アドレスバーの左端のアイコン（サイト情報）をクリック', '「カメラ」を「許可」（オン）にする'],
  edge: ['アドレスバーの左端のアイコン（サイト情報）をクリック', '「このサイトのアクセス許可」で「カメラ」を「許可」にする'],
  firefox: ['アドレスバーの左の、斜線の入ったカメラのアイコンをクリック', '「ブロック」の横の × を押して外す'],
  // Safari (WebKit — every browser on an iPhone): the first step is a reload
  safari: [
    '下の「読み込み直す」を押し、「タップして開始」→「許可」を選ぶ',
    '聞かれないときは、メニューの「Safari」→「設定…」→「Web サイト」→「カメラ」で、このサイトを「確認」か「許可」にして、読み込み直す',
  ],
  ios: [
    '下の「読み込み直す」を押し、「タップして開始」→「許可」を選ぶ',
    '聞かれないときは、アドレスバーの左端のボタン（「ぁあ」など）→「Web サイトの設定」→「カメラ」を「確認」か「許可」にして、読み込み直す',
    'それでも聞かれないときは、「設定」アプリの「Safari」（iOS 18 からは「アプリ」の中）→「カメラ」を「確認」か「許可」にする',
  ],
  'ios-chrome': [
    '下の「読み込み直す」を押し、「タップして開始」→「許可」を選ぶ',
    '聞かれないときは、「設定」アプリの「Chrome」（iOS 18 からは「アプリ」の中）→「カメラ」をオンにする',
  ],
  android: ['アドレスバーの左端のアイコンをタップ →「権限」（または「サイトの設定」）', '「カメラ」を「許可」にする'],
  other: ['ブラウザの設定で、このサイトのカメラを「許可」にする'],
};

// How to get a refused camera back: null when that is not what happened.
function refusedHelp(err) {
  if (err?.name !== 'NotAllowedError') return null;
  const ua = navigator.userAgent;
  // the system keeps the browser from the camera (Chrome says "by system")
  if (/system/i.test(err.message || '') && /Mac|Windows/.test(ua)) {
    awaitingCamera = false;
    return /Mac/.test(ua)
      ? { lead: 'Mac の設定で、このブラウザのカメラが止められています。',
        steps: ['「システム設定」→「プライバシーとセキュリティ」→「カメラ」を開く', 'このブラウザをオンにする（ブラウザを開き直すよう求められます）'],
        after: 'ブラウザを開き直したら、もう一度「タップして開始」を押してください。' }
      : { lead: 'Windows の設定で、カメラが止められています。',
        steps: ['「設定」→「プライバシーとセキュリティ」→「カメラ」を開く', '「カメラへのアクセス」と「デスクトップ アプリがカメラにアクセスできるようにする」をオンにする'],
        after: 'オンにしたら、もう一度「タップして開始」を押してください。' };
  }
  // Safari (WebKit) remembers a refusal until the page is loaded again:
  // until then every tap is refused at once, with no dialog — and its
  // permission still says "ask", so it looks like "only closed". A reload
  // is the way back (and, if its setting is "deny", the setting first).
  const kind = browserKind();
  if (kind === 'safari' || kind.startsWith('ios')) {
    awaitingCamera = true; // if it does tell of a change, try at once
    return {
      lead: 'Safari は、一度拒否すると、ページを読み込み直すまでカメラの許可を聞き直しません。',
      steps: ALLOW_STEPS[kind],
      reload: true,
      after: 'デモで試すこともできます。',
    };
  }
  // only closed (×), not blocked: the next tap asks again
  if (cameraPerm && cameraPerm.state === 'prompt') {
    return { after: 'もう一度「タップして開始」を押すと、また聞かれます。' };
  }
  awaitingCamera = true;
  return {
    lead: 'ブラウザは、一度拒否するとダイアログを出し直しません。許可し直すには：',
    steps: ALLOW_STEPS[browserKind()],
    after: cameraPerm
      ? '許可に変えると、自動でカメラが開きます。デモで試すこともできます。'
      : '許可に変えたら、ページを再読み込みしてください。デモで試すこともできます。',
  };
}

// What went wrong when starting, in words.
function startError(mode, err) {
  const why = (err && err.message) || String(err || '');
  if (mode === 'demo') return `デモポスターを読み込めませんでした（${why}）。通信を確かめて、もう一度試してください。`;
  switch (err && err.name) {
    case 'NotAllowedError':
      return 'カメラの使用が許可されませんでした。';
    case 'SecurityError':
      return 'このページではカメラを使えません（HTTPS で開いてください）。デモで試すこともできます。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりませんでした。デモで試してください。';
    case 'NotReadableError':
    case 'AbortError':
      return 'カメラを開けませんでした。ほかのアプリ（ビデオ通話など）が使っていないか確かめて、もう一度試してください。';
    default:
      return `カメラを開けませんでした：${why}`;
  }
}

// One start at a time: a second tap while the camera is opening must not
// open a second one (the first would stay on, out of reach).
let starting = null;
function start(mode) {
  if (starting) return starting;
  starting = begin(mode).finally(() => {
    starting = null;
    for (const b of document.querySelectorAll('#btn-camera, #btn-demo, #switch-mode')) b.disabled = false;
  });
  return starting;
}

async function begin(mode) {
  try {
    audio.unlock(); // synchronously, inside the tap
  } catch (err) {
    console.warn('audio', err); // no sound, but the picture still works
  }
  for (const b of document.querySelectorAll('#btn-camera, #btn-demo, #switch-mode')) b.disabled = true;
  $('#start-error').textContent = '';
  try {
    if (mode === 'camera') {
      if (!state.camera || state.camera.ended) state.camera = await openCamera($('#video'));
      state.source = state.camera;
    } else {
      // the demo first: if it cannot load, the camera is still there
      const demo = await demoSource();
      if (state.camera) {
        state.camera.stop();
        state.camera = null;
      }
      state.source = demo;
    }
  } catch (err) {
    console.error(err);
    showStart(startError(mode, err), mode === 'camera' ? refusedHelp(err) : null);
    return;
  }
  awaitingCamera = false;
  state.mode = mode;
  document.body.dataset.mode = mode;
  clearTracks();
  recovered();
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
// leaving (closed from the app switcher, another page): silence first, so
// nothing is left sounding when the phone stops the page
window.addEventListener('pagehide', () => audio.suspend());
// back from the browser's page cache (the back button, iOS restoring the
// tab): the camera has usually been stopped — the frame loop notices
window.addEventListener('pageshow', (e) => {
  if (e.persisted && state.running) {
    audio.resumeContext();
    requestWakeLock();
  }
});

$('#btn-camera').addEventListener('click', () => start('camera'));
$('#btn-demo').addEventListener('click', () => start('demo'));
// a tap anywhere brings back sound that iOS stopped (inside a gesture it
// always may)
document.addEventListener('pointerdown', () => {
  if (state.running && !audio.running) {
    // a context that did not come back (iOS) is made anew — only a reload
    // helped before; one that is only stopped is started again
    if (audio.broken) audio.revive();
    else audio.resumeContext();
  }
  // the camera stopped: inside a tap the phone allows more — try now
  const src = state.source;
  if (state.paused && src && src.kind === 'camera') {
    const now = performance.now();
    if (src.ended || (stall && now - stall > 1200)) reopenCamera(src, now, true);
    else src.resume(now);
  }
}, { passive: true });

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
  follower.reset();
  state.surfaces = [];
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

const demoNote = (text) => {
  $('#demo-note').textContent = text;
};

$('#file').addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ''; // the same file again is a change too
  if (!file) return;
  demoNote('');
  try {
    const bmp = await createImageBitmap(file);
    const demo = await demoSource();
    demo.setImage(bmp);
    if (state.mode !== 'demo') await start('demo');
    clearTracks();
  } catch (err) {
    console.warn(err);
    demoNote(`この画像は読み込めませんでした（${file.name}）。JPEG か PNG で試してください。`);
  }
});

$('#save-poster').addEventListener('click', async () => {
  demoNote('');
  try {
    const [spec] = await Promise.all([posterSpec(), fontsReady()]);
    const cv = drawPoster(spec, 2);
    cv.toBlob((blob) => {
      if (!blob) {
        demoNote('画像を作れませんでした（端末のメモリが足りないかもしれません）。');
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ostinascope-specimen.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  } catch (err) {
    console.warn(err);
    demoNote('デモポスターを読み込めませんでした。通信を確かめて、もう一度試してください。');
  }
});

// ---------------------------------------------------------------------------
// staying up to date (sw.js): always the newest files, the version on show,
// and a button that fetches everything again

registerUpdates(() => state.running);
const showVersion = (text) => {
  for (const el of document.querySelectorAll('.version-text')) el.textContent = text;
};
if (runningBuild) {
  // published: the commit it was built from; and is a newer one out?
  showVersion(formatBuild(runningBuild));
  publishedBuild().then((latest) => {
    if (!latest || latest === 'offline' || latest.commit === runningBuild.commit) return;
    for (const btn of document.querySelectorAll('.refresh-app')) {
      btn.textContent = `新しい版があります（${latest.commit}）— 更新`;
      btn.classList.add('attention');
    }
  });
} else {
  // a local copy: when its files were last changed
  serverVersion().then((d) => showVersion(`${formatVersion(d)}（開発版）`));
}
for (const btn of document.querySelectorAll('.refresh-app')) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '読み込み直しています…';
    if (!(await refreshApp())) {
      btn.textContent = 'オフラインのため更新できません';
      setTimeout(() => {
        btn.textContent = label;
        btn.disabled = false;
      }, 2500);
    }
  });
}

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
