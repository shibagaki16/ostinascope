// Ostinascope — keeping each track on its own surface: the glue between
// the camera motion (motion.js) and the tracker, shared by the app and the
// bench.
//
// Every camera frame, a track moves with the surface whose corners lie
// inside its outline (the floor under a floor pattern, the wall under a
// poster); when it cannot tell, with the dominant motion. A detection that
// comes back late from the worker is moved the same way, from the frame it
// was taken in to now.
//
// Pure module (no DOM).

import { createMotion } from './motion.js';
import { scaleH } from '../homography.js';
import { warpRegion } from './tracker.js';

export const FOLLOW_DEFAULTS = Object.freeze({
  minShare: 0.6, // share of the corners inside an outline that must agree on a surface
  minPoints: 4, // … and how many corners that takes
});

export function createFollower(options = {}) {
  const opt = { ...FOLLOW_DEFAULTS, ...(options.follow || {}) };
  const motion = createMotion(options.motion || {});
  let last = { surfaces: new Map() };

  // the surface under an outline (level-0 px), or null
  function surfaceUnder(quadPx) {
    const s = motion.surfaceIn(quadPx);
    return s && s.n >= opt.minPoints && s.share >= opt.minShare ? s.id : null;
  }
  const toPx = (q, unit) => q.map(([x, y]) => [x * unit, y * unit]);

  /**
   * One camera frame (grey 0..1): estimate the motion and move every track
   * of `tracker` with its surface. Returns the motion step ({ k, H, … }).
   */
  function step(grey, w, h, tracker, t) {
    const m = motion.push(grey, w, h);
    last = m;
    const unit = Math.min(w, h);
    if (m.H) {
      tracker.warp((tr) => {
        let id = surfaceUnder(toPx(tr.quad, unit));
        // no clear say from the corners: stay with the surface it was on
        if (id === null && tr.surface != null && m.surfaces.has(tr.surface)) id = tr.surface;
        tr.surface = id;
        return scaleH((id !== null && m.surfaces.get(id)) || m.H, 1 / unit);
      }, t);
    }
    return m;
  }

  /**
   * Detections (view units) analysed in frame k0, moved to the current
   * frame — each with the surface it lies on (d.surface). null when the
   * motion since k0 is unknown (use them as they are).
   */
  function place(dets, k0, unit) {
    const base = motion.chain(k0);
    if (!base) return null;
    const B = scaleH(base, 1 / unit);
    return dets.map((d) => {
      const moved = warpRegion({ ...d }, B);
      const id = surfaceUnder(toPx(moved.quad, unit));
      if (id === null) return { ...moved, surface: null };
      const C = motion.chain(k0, motion.frame, id);
      return { ...warpRegion({ ...d }, scaleH(C, 1 / unit)), surface: id };
    });
  }

  return {
    motion,
    step,
    place,
    /** the surfaces told apart in the last frame (level-0 px hulls) */
    surfaces: () => (last.surfaces && last.surfaces.size > 1 ? motion.surfaces() : []),
    reset() {
      motion.reset();
      last = { surfaces: new Map() };
    },
    options: opt,
  };
}
