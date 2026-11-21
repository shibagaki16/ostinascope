// Open a bench page in headless Chrome and print window.benchResult once set.
// usage: node bench/page.mjs <url> [timeoutSeconds]
import { openChrome, sleep, exceptionText } from './chrome.mjs';

const [,, url, secs = '900'] = process.argv;
const chrome = await openChrome({
  onEvent: (m) => { if (m.method === 'Runtime.exceptionThrown') console.error('[exception]', exceptionText(m)); },
});
await chrome.send('Runtime.enable');
await chrome.send('Page.navigate', { url });
const t0 = Date.now();
let res = null;
while (Date.now() - t0 < secs * 1000) {
  await sleep(1000);
  const v = await chrome.evaluate('JSON.stringify(window.benchResult)');
  if (v && v !== 'null') { res = JSON.parse(v); break; }
}
chrome.close();
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
