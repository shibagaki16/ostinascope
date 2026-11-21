// Headless Chrome for the bench scripts, over the DevTools protocol.
// macOS: Chrome is started through `arch -arm64` (Node may run under Rosetta).
//
//   const chrome = await openChrome({ flags, profile, onEvent });
//   await chrome.send('Page.navigate', { url });
//   const value = await chrome.evaluate('1 + 1');   // awaits promises
//   chrome.close();
//
// flags: extra command-line flags; profile: user-data dir (default: a fresh
// temporary one, removed on close); onEvent(message): protocol events.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openChrome({ flags = [], profile, onEvent = () => {} } = {}) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const dir = profile ?? mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'osc-'));
  const proc = spawn('arch', ['-arm64', CHROME, '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', ...flags, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 150; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.length) break;
    } catch { /* starting */ }
    await sleep(200);
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
      return;
    }
    onEvent(m);
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  // the value of an expression (a promise is awaited); throws on an exception
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const close = () => {
    ws.close();
    proc.kill();
    if (!profile) try { rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ }
  };
  return { send, evaluate, close };
}

/** Exception text from a Runtime.exceptionThrown event. */
export const exceptionText = (m) => m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text;
