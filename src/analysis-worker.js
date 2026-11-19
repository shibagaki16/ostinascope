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
  const res = detector.analyze(rgba, m.W, m.H);
  self.postMessage({ type: 'result', id: m.id, result: slimResult(res, m.cells), buffer: m.buffer }, [m.buffer]);
};
