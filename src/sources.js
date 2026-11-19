// Ostinascope — image sources: the phone camera, or a pannable demo image.
// Both expose draw(ctx, w, h): render the current view, cover-cropped to
// the w:h aspect, into ctx at (0, 0, w, h).

export function coverCrop(sw, sh, aspect) {
  if (sw / sh > aspect) {
    const cw = sh * aspect;
    return { sx: (sw - cw) / 2, sy: 0, sw: cw, sh };
  }
  const ch = sw / aspect;
  return { sx: 0, sy: (sh - ch) / 2, sw, sh: ch };
}

export async function openCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      window.isSecureContext
        ? 'このブラウザではカメラを使えません。'
        : 'カメラには HTTPS 接続が必要です（localhost は例外）。',
    );
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  return {
    kind: 'camera',
    ready: () => video.readyState >= 2 && video.videoWidth > 0,
    /** short side of the visible crop, in source pixels */
    cropShort(aspect) {
      const c = coverCrop(video.videoWidth, video.videoHeight, aspect);
      return Math.min(c.sw, c.sh);
    },
    draw(ctx, w, h) {
      const c = coverCrop(video.videoWidth, video.videoHeight, w / h);
      ctx.drawImage(video, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
    },
    stop() {
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/**
 * A large image seen through a movable "camera": drag to move, wheel or
 * pinch to zoom. After a few idle seconds it drifts around on its own.
 */
export function createDemoSource(image, opts = {}) {
  const view = {
    cx: opts.cx ?? image.width * 0.3,
    cy: opts.cy ?? image.height * 0.3,
    s: opts.s ?? Math.min(image.width, image.height) * 0.36, // short side, image px
  };
  let img = image;
  let lastInput = -Infinity;
  let tourT = 0;
  const minS = () => Math.min(img.width, img.height) * 0.08;
  const maxS = () => Math.max(img.width, img.height) * 1.1;

  function rect(aspect) {
    const cw = aspect < 1 ? view.s : view.s * aspect;
    const ch = aspect < 1 ? view.s / aspect : view.s;
    return { x: view.cx - cw / 2, y: view.cy - ch / 2, w: cw, h: ch };
  }

  // Slow Lissajous wander across the image when nobody is steering.
  function step(dtMs, nowMs) {
    if (nowMs - lastInput < 6000) return;
    tourT += dtMs / 1000;
    const tx = img.width * (0.5 + 0.34 * Math.sin(tourT * 0.071));
    const ty = img.height * (0.5 + 0.37 * Math.sin(tourT * 0.047 + 1.3));
    const base = Math.min(img.width, img.height);
    const ts = base * (0.3 + 0.12 * Math.sin(tourT * 0.031 + 0.4));
    const k = Math.min(1, dtMs / 2500);
    view.cx += (tx - view.cx) * k;
    view.cy += (ty - view.cy) * k;
    view.s += (ts - view.s) * k;
  }

  function draw(ctx, w, h) {
    const r = rect(w / h);
    ctx.fillStyle = '#3a3936';
    ctx.fillRect(0, 0, w, h);
    // clip the source rect to the image manually (Safari dislikes
    // out-of-bounds source rects)
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(img.width, r.x + r.w);
    const y1 = Math.min(img.height, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return;
    const kx = w / r.w;
    const ky = h / r.h;
    ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - r.x) * kx, (y0 - r.y) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
  }

  function attach(el) {
    const pts = new Map();
    let pinch = null;
    const scale = () => view.s / Math.min(el.clientWidth, el.clientHeight);
    const touch = () => {
      lastInput = performance.now();
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.target !== el) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      touch();
    });
    el.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      touch();
      if (pts.size === 1) {
        view.cx -= (e.clientX - p.x) * scale();
        view.cy -= (e.clientY - p.y) * scale();
      }
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) view.s = clampS(view.s * (pinch / d));
        pinch = d;
      }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      pinch = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        touch();
        view.s = clampS(view.s * Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
  }
  const clampS = (s) => Math.min(maxS(), Math.max(minS(), s));

  return {
    kind: 'demo',
    view,
    ready: () => true,
    cropShort: () => view.s,
    draw,
    step,
    attach,
    /** Point the demo camera somewhere (pauses the auto tour for a while). */
    lookAt(cx, cy, s = view.s) {
      view.cx = cx;
      view.cy = cy;
      view.s = clampS(s);
      lastInput = performance.now();
    },
    setImage(next) {
      img = next;
      view.cx = img.width / 2;
      view.cy = img.height / 2;
      view.s = Math.min(img.width, img.height) * 0.5;
      lastInput = performance.now();
    },
    get image() {
      return img;
    },
  };
}
