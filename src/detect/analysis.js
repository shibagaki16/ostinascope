// Ostinascope — frame analysis, in a worker when the browser allows it and
// on the main thread otherwise. Only one frame is in flight at a time: if
// the analysis is slower than the camera, frames are skipped, never queued.

import { createDetector } from './detector.js';

/** What the main thread needs from a detector result (cheap to clone). */
export function slimResult(res, withCells) {
  return {
    W: res.W,
    H: res.H,
    ms: res.ms,
    regions: res.regions.map(({ cellRefs, dirs, ...r }) => r),
    levels: res.levels.map((lv) => ({
      level: lv.level,
      scale: lv.scale,
      cols: lv.cols,
      rows: lv.rows,
      size: lv.size,
      step: lv.step,
      origin: lv.cells[0] ? { x: lv.cells[0].x, y: lv.cells[0].y } : { x: 0, y: 0 },
      cells: withCells
        ? lv.cells.filter((c) => c.type).map((c) => ({
          type: c.type, weak: c.weak, cx: c.cx, cy: c.cy, core: c.core, p1: c.p1,
        }))
        : [],
    })),
  };
}

// No answer for this long: the worker was stopped (the phone froze the
// page) or hangs. Without this the analyser would stay busy for good, and
// the tracks — updated only by results — would stay on screen and sound.
const ANSWER_MS = 3000;

export function createAnalyzer() {
  let worker = null;
  let local = null;
  let busy = false;
  let sentAt = 0;
  let nextId = 1;
  let spare = null; // a buffer handed back by the worker, reused for the next frame
  const pending = new Map();
  let options = {};

  function dropPending() {
    busy = false;
    for (const done of pending.values()) done(null);
    pending.clear();
  }

  function startWorker() {
    try {
      const w = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type !== 'result' || w !== worker) return;
        busy = false;
        spare = m.buffer;
        const done = pending.get(m.id);
        pending.delete(m.id);
        if (done) done(m.result);
      };
      w.onerror = (err) => {
        // module workers unsupported or failed to load: analyse here instead
        console.warn('analysis worker failed, using the main thread', err.message || err);
        if (w !== worker) return;
        worker = null;
        dropPending();
      };
      if (Object.keys(options).length) w.postMessage({ type: 'options', options });
      return w;
    } catch {
      return null;
    }
  }
  worker = startWorker();

  function localDetector() {
    if (!local) local = createDetector(options);
    return local;
  }

  return {
    get busy() {
      if (busy && worker && performance.now() - sentAt > ANSWER_MS) {
        console.warn('analysis worker did not answer; starting a new one');
        const old = worker;
        worker = null;
        try {
          old.terminate();
        } catch {
          /* gone already */
        }
        dropPending();
        spare = null;
        worker = startWorker();
      }
      return busy;
    },
    get threaded() {
      return !!worker;
    },
    setOptions(o) {
      options = { ...options, ...o };
      if (local) local.setOptions(o);
      if (worker) worker.postMessage({ type: 'options', options: o });
    },
    /**
     * Analyse one RGBA frame. `onResult(result | null)` is called later
     * (worker) or right away (main thread). Returns false if a frame is
     * still being analysed.
     */
    submit(imageData, withCells, onResult) {
      if (this.busy) return false;
      const { width: W, height: H, data } = imageData;
      if (!worker) {
        onResult(slimResult(localDetector().analyze(data, W, H), withCells));
        return true;
      }
      let buf = spare && spare.byteLength === data.byteLength ? spare : new ArrayBuffer(data.byteLength);
      spare = null;
      new Uint8ClampedArray(buf).set(data);
      const id = nextId++;
      pending.set(id, onResult);
      busy = true;
      sentAt = performance.now();
      worker.postMessage({ type: 'frame', id, buffer: buf, W, H, cells: withCells }, [buf]);
      return true;
    },
    /** The main-thread detector, for poking at from the console. */
    get detector() {
      return localDetector();
    },
  };
}
