// Open a bench page in headless Chrome and print window.benchResult once set.
// usage: node bench/page.mjs <url> [timeoutSeconds]
// macOS: Chrome is started through `arch -arm64` (Node may run under Rosetta).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [,, url, secs = '900'] = process.argv;
const port = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'osc-'));
const chrome = spawn('arch', ['-arm64', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') console.error('[exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.navigate', { url });
const t0 = Date.now();
let res = null;
while (Date.now() - t0 < secs * 1000) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.benchResult)', returnByValue: true });
  const v = r.result?.result?.value;
  if (v && v !== 'null') { res = JSON.parse(v); break; }
}
ws.close();
chrome.kill();
if (!res) { console.error('timed out'); process.exit(1); }
if (res.error) { console.error(res.error); process.exit(1); }
if (Array.isArray(res)) console.table(res);
else {
  for (const [k, v] of Object.entries(res)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      console.log(k);
      console.table(v);
    } else console.log(k, JSON.stringify(v));
  }
}
