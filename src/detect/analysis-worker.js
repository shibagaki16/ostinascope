// Ostinascope — runs the detector off the main thread, so drawing and the
// audio scheduler never wait for an analysis (≈10–40 ms on a phone).
//
// in:  { type: 'options', options }
//      { type: 'frame', id, buffer, W, H, cells }   (buffer: RGBA, transferred)
// out: { type: 'result', id, result, buffer }       (buffer handed back)

import { createDetector } from './detector.js';
import { slimResult } from './analysis.js';

// rows: half of the search each frame (see DETECTOR_DEFAULTS.rowSplit)
const detector = createDetector({ rowSplit: 2 });

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'options') {
    detector.setOptions(m.options);
    return;
  }
  if (m.type !== 'frame') return;
  const rgba = new Uint8ClampedArray(m.buffer);
  // a frame the detector cannot take must not end the worker: answer
  // "nothing" and go on with the next one
  let result = null;
  try {
    result = slimResult(detector.analyze(rgba, m.W, m.H), m.cells);
  } catch (err) {
    console.warn('analysis failed', err);
  }
  self.postMessage({ type: 'result', id: m.id, result, buffer: m.buffer }, [m.buffer]);
};
