// Radix-2 FFT, and the power spectrum of a real n×n block.

export function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error(`FFT size must be a power of 2: ${n}`);

  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const swaps = [];
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
    if (r > i) swaps.push(i, r);
  }
  const sw = Int32Array.from(swaps);

  /** In-place complex FFT of n samples at re/im[off + i*stride]. */
  function transform(re, im, off, stride) {
    for (let s = 0; s < sw.length; s += 2) {
      const a = off + sw[s] * stride;
      const b = off + sw[s + 1] * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = off + (i + j) * stride;
          const b = off + (i + j + half) * stride;
          const c = cos[k];
          const s = sin[k];
          const tre = re[b] * c + im[b] * s;
          const tim = im[b] * c - re[b] * s;
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
  }

  return { n, transform };
}

/** 2D FFT of an n×n complex block stored row-major in re/im. */
export function fft2d(fft, re, im) {
  const n = fft.n;
  for (let y = 0; y < n; y++) fft.transform(re, im, y * n, 1);
  for (let x = 0; x < n; x++) fft.transform(re, im, x, n);
}

/**
 * Power spectrum of a real n×n block. Two real rows go through one complex
 * FFT, and only the non-redundant half of the columns is transformed
 * (a real image's spectrum is symmetric: P(k) = P(-k)) — about half the
 * work of a full complex 2D FFT.
 */
export function makePowerSpectrum(n) {
  const fft = makeFFT(n);
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  const h = n / 2;
  return function power(src, P) {
    for (let y = 0; y < n; y += 2) {
      const a = y * n;
      const b = a + n;
      for (let x = 0; x < n; x++) {
        re[a + x] = src[a + x];
        im[a + x] = src[b + x];
      }
      fft.transform(re, im, a, 1);
      // split Z = FFT(ra + i·rb) into A = FFT(ra), B = FFT(rb)
      for (let k = 0; k <= h; k++) {
        const j = (n - k) & (n - 1);
        const zr = re[a + k];
        const zi = im[a + k];
        const wr = re[a + j];
        const wi = im[a + j];
        re[a + k] = 0.5 * (zr + wr);
        im[a + k] = 0.5 * (zi - wi);
        re[b + k] = 0.5 * (zi + wi);
        im[b + k] = -0.5 * (zr - wr);
      }
    }
    for (let x = 0; x <= h; x++) fft.transform(re, im, x, n);
    for (let y = 0; y < n; y++) {
      const row = y * n;
      const mrow = ((n - y) & (n - 1)) * n;
      for (let x = 0; x <= h; x++) {
        const i = row + x;
        const p = re[i] * re[i] + im[i] * im[i];
        P[i] = p;
        if (x > 0 && x < h) P[mrow + n - x] = p;
      }
    }
  };
}
