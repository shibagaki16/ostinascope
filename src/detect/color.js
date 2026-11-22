// Ostinascope — the colour of a detected pattern (sets its pitch, see mapping.js).

// Colour of the pattern inside a region: split pixels at the mean
// luminance and take whichever half is more saturated (coloured ink on
// paper, or black ink on coloured paper).
export function regionColor(rgba, W, H, box) {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(W, Math.ceil(box.x + box.w));
  const y1 = Math.min(H, Math.ceil(box.y + box.h));
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 1200)));
  let n = 0;
  let lsum = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const j = (y * W + x) * 4;
      lsum += 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      n++;
    }
  }
  if (!n) return { hue: 0, sat: 0, light: 0.5 };
  const lm = lsum / n;
  const acc = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const j = (y * W + x) * 4;
      const l = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      const a = acc[l < lm ? 0 : 1];
      a[0] += rgba[j];
      a[1] += rgba[j + 1];
      a[2] += rgba[j + 2];
      a[3]++;
    }
  }
  let best = { hue: 0, sat: 0, light: lm / 255 };
  for (const a of acc) {
    if (!a[3]) continue;
    const hsv = rgbToHueSat(a[0] / a[3], a[1] / a[3], a[2] / a[3]);
    if (hsv.sat > best.sat) best = hsv;
  }
  return best;
}

function rgbToHueSat(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const c = mx - mn;
  let h = 0;
  if (c > 1e-6) {
    if (mx === r) h = ((g - b) / c) % 6;
    else if (mx === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { hue: h, sat: c, light: (mx + mn) / 2 };
}
