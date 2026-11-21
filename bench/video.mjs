// Phone videos → frame sequences for bench/seq.mjs: each video is played in
// headless Chrome (it decodes H.264 and HEVC; seeking in .mov files did not
// return the right frames, so frames are taken while it plays) and every
// 1/fps seconds a frame is kept, scaled to a short side of 192 px.
// usage: node bench/video.mjs <outDir> <video…> [--fps 10] [--short 192]
//   writes <outDir>/s<NN>_f<MMM>.rgba / .png and index.json
//   ({ view, seq, frame, w, h, file, gt: [] }; fill gt by hand or from labels)
import { createServer } from 'node:http';
import { createReadStream, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { openChrome, sleep } from './chrome.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? +args.splice(i, 2)[1] : d;
};
const fps = opt('--fps', 10);
const short = opt('--short', 192);
const [out, ...videos] = args;
if (!out || !videos.length) {
  console.error('usage: node bench/video.mjs <outDir> <video…> [--fps 10] [--short 192]');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// the videos, served to the page (no range requests needed: frames are
// taken while playing)
const files = videos.map((v) => resolve(v));
const server = createServer((req, res) => {
  const m = req.url.match(/^\/v(\d+)$/);
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><body>');
    return;
  }
  if (!m || !files[+m[1]]) {
    res.writeHead(404);
    res.end();
    return;
  }
  const f = files[+m[1]];
  res.writeHead(200, { 'content-type': 'video/quicktime', 'content-length': statSync(f).size });
  createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const chrome = await openChrome({ flags: ['--autoplay-policy=no-user-gesture-required'] });
const ev = chrome.evaluate;
await chrome.send('Runtime.enable');
await chrome.send('Page.navigate', { url: `${base}/` });
await sleep(1000);

const index = [];
for (let s = 0; s < files.length; s++) {
  // play it through; keep a frame (raw RGBA and PNG) every 1/fps seconds
  const n = await ev(`(async () => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = '/v${s}';
    document.body.appendChild(v);
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('cannot decode')); });
    const k = ${short} / Math.min(v.videoWidth, v.videoHeight);
    const W = Math.round(v.videoWidth * k), H = Math.round(v.videoHeight * k);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    const frames = [];
    let next = 0;
    await v.play();
    await new Promise((res) => {
      const cb = (now, md) => {
        if (md.mediaTime >= next - 1e-3) {
          g.drawImage(v, 0, 0, W, H);
          const px = g.getImageData(0, 0, W, H).data;
          let bin = '';
          for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
          frames.push({ t: md.mediaTime, w: W, h: H, rgba: btoa(bin), png: c.toDataURL('image/png') });
          next += ${1 / fps};
        }
        if (v.ended) res(); else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.onended = res;
    });
    v.remove();
    window.__frames = frames;
    return frames.length;
  })()`);
  const name = basename(files[s]);
  for (let f = 0; f < n; f++) {
    const fr = await ev(`window.__frames[${f}]`);
    const view = `s${String(s).padStart(2, '0')}_f${String(f).padStart(3, '0')}`;
    writeFileSync(`${out}/${view}.rgba`, Buffer.from(fr.rgba, 'base64'));
    writeFileSync(`${out}/${view}.png`, Buffer.from(fr.png.split(',')[1], 'base64'));
    index.push({ view, seq: s, frame: f, w: fr.w, h: fr.h, file: name, t: +fr.t.toFixed(3), gt: [] });
  }
  console.log(`${name}: ${n} frames`);
}
writeFileSync(`${out}/index.json`, JSON.stringify(index));
chrome.close();
server.close();
