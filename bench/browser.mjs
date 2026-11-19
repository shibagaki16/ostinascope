// Drive the app in headless Chrome (real time) and report what plays.
// usage: node bench/browser.mjs <baseUrl> <outDir> demo "cx,cy,s;cx,cy,s;…"
//        node bench/browser.mjs <baseUrl> <outDir> camera <video.y4m> <seconds>
// macOS: Chrome is started through `arch -arm64` (Node may run under Rosetta).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [,, base, outDir, mode, arg, secs = '30'] = process.argv;
mkdirSync(outDir, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 600);
const flags = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${outDir}/profile-${port}`, '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (mode === 'camera') flags.push(`--use-file-for-fake-video-capture=${arg}`);
const chrome = spawn('arch', ['-arm64', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ...flags, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 150; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; } catch { /* starting */ }
  await sleep(200);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pend = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};
const state = () => ev(`(() => { const o = ostinascope, s = o.state; return { ms: +s.stats.ms.toFixed(1), hz: +s.stats.hz.toFixed(1),
  playing: s.tracks.filter(t => t.state === 'active').map(t => t.type + ' ' + (t.spec ? (t.spec.pattern || t.spec.rhythm) : '')) }; })()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const q = mode === 'demo' ? '?mode=demo&debug' : '?debug';
await send('Page.navigate', { url: base + q });
for (let i = 0; i < 300; i++) { if (await ev('typeof window.ostinascope') === 'object') break; await sleep(100); }
if (mode === 'demo') {
  await sleep(1500);
  for (const [i, spot] of arg.split(';').entries()) {
    const [cx, cy, s] = spot.split(',').map(Number);
    await ev(`ostinascope.state.demo.lookAt(${cx}, ${cy}, ${s})`);
    await sleep(3200);
    await shot(`demo${i}`);
    console.log(spot, JSON.stringify(await state()));
  }
} else {
  await ev(`document.querySelector('#btn-camera').click()`);
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < +secs * 1000) {
    await sleep(2000);
    console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(await state()));
    if (n++ % 3 === 0) await shot(`cam${n}`);
  }
}
console.log(logs.join('\n') || '(no console output)');
ws.close();
chrome.kill();
