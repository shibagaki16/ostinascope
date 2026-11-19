// Radix-2 complex FFT (in place). Works on strided data so the same
// instance can transform rows and columns of an N×N block.

export function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error(`FFT size must be a power of 2: ${n}`);

  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
    rev[i] = r;
  }

  function transform(re, im, off, stride) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = off + i * stride;
        const b = off + j * stride;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = off + (i + j) * stride;
          const b = off + (i + j + half) * stride;
          const tre = re[b] * cos[k] + im[b] * sin[k];
          const tim = im[b] * cos[k] - re[b] * sin[k];
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

/** 2D FFT of an n×n block stored row-major in re/im. */
export function fft2d(fft, re, im) {
  const n = fft.n;
  for (let y = 0; y < n; y++) fft.transform(re, im, y * n, 1);
  for (let x = 0; x < n; x++) fft.transform(re, im, x, n);
}
