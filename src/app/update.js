// Ostinascope — staying up to date on a phone (see sw.js): registers the
// service worker, shows which version is running, notices when a newer one
// has been published, and can force a fresh copy of everything.

import { BUILD } from './build.js';

/** The version running: { commit, time } from the deploy, or null locally. */
export const runningBuild = BUILD;

/**
 * The version published now (version.json, written by the deploy): an
 * object, null when there is none (local), or 'offline'.
 */
export async function publishedBuild() {
  try {
    const res = await fetch(new URL('../../version.json', import.meta.url), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return 'offline';
  }
}

/** "版：d3c8457（11/21 10:02 公開）" for a build. */
export function formatBuild(b) {
  const d = new Date(b.time);
  const p = (n) => String(n).padStart(2, '0');
  const when = Number.isNaN(d.getTime()) ? '' : `（${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())} 公開）`;
  return `版：${b.commit}${when}`;
}

/**
 * Register the service worker. On the very first visit with it, the page
 * was loaded without it (possibly from old cached files): once it takes
 * over, reload — unless the app has started (`busy()`), never in the middle.
 */
export function registerUpdates(busy = () => false) {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('service worker', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController || busy()) return;
    try {
      if (sessionStorage.getItem('osc-sw-reload')) return;
      sessionStorage.setItem('osc-sw-reload', '1');
    } catch {
      return; // no storage: do not risk a reload loop
    }
    location.reload();
  });
}

/**
 * When the site was last updated on the server (its Last-Modified): a Date,
 * null when the server does not say, or 'offline'.
 */
export async function serverVersion() {
  try {
    const res = await fetch(location.href.split('#')[0], { method: 'HEAD', cache: 'no-store' });
    const lm = res.headers.get('last-modified');
    return lm ? new Date(lm) : null;
  } catch {
    return 'offline';
  }
}

export function formatVersion(d) {
  if (d === 'offline') return '版：オフライン（前に読み込んだもの）';
  if (!d || Number.isNaN(d.getTime())) return '版：不明';
  const p = (n) => String(n).padStart(2, '0');
  return `版：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 更新`;
}

/**
 * Fetch every file of this site the page has loaded again, bypassing every
 * cache (which also refreshes the browser's own copies and the service
 * worker's), then reload. Offline it does nothing (returns false), so the
 * copies that let the app open without a network stay as they are.
 */
export async function refreshApp() {
  const page = location.href.split('#')[0];
  try {
    const res = await fetch(page, { cache: 'reload' });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  const urls = new Set();
  for (const e of performance.getEntriesByType('resource')) {
    try {
      const u = new URL(e.name);
      if (u.origin === location.origin) urls.add(u.href);
    } catch {
      /* ignore */
    }
  }
  await Promise.all([...urls].map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg) await reg.update();
  } catch {
    /* best effort */
  }
  location.reload();
  return true;
}
