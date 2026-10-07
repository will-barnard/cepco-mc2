/**
 * "Refresh app" (Settings header + Account page) -- for a device that's stuck
 * on an old copy of the app. The typical case is an iPhone/iPad running it
 * from the Home Screen ("Open as Web App"): iOS keeps that app suspended in
 * the background and resumes it without reloading, so it can sit on old
 * JavaScript for days; and index.html itself used to carry no cache headers,
 * so even a normal reload could be answered from the HTTP cache with a page
 * that still points at the old hashed bundles (nginx.conf now sends
 * `Cache-Control: no-cache` for it).
 *
 * This does the heavy version of a reload, and only touches caches -- the
 * session cookie and localStorage (drafts, kiosk setting) are left alone, so
 * nobody is signed out:
 *   1. unregister any service worker (there isn't one today; this keeps the
 *      button honest if one is ever added);
 *   2. delete everything in Cache Storage;
 *   3. re-fetch index.html with `cache: 'reload'`, which bypasses the HTTP
 *      cache and replaces the stored copy;
 *   4. navigate to the same page with a throwaway `_r=<time>` query param, so
 *      the document itself can't come from cache either. main.js drops the
 *      param again once the router is up.
 * Every step is best-effort: if one throws (private mode, offline), the
 * navigation in step 4 still happens.
 */

// Injected by vite.config.js (`define`) at build time -- when *this copy of the
// JavaScript* was built, which is exactly what's useful when asking "is that
// device up to date?".
// eslint-disable-next-line no-undef
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : null;

export function builtLabel() {
  if (!BUILD_TIME) return null;
  const d = new Date(BUILD_TIME);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export async function hardRefresh() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* best effort */ }
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* best effort */ }
  try {
    await Promise.all([
      fetch('/index.html', { cache: 'reload' }),
      fetch('/', { cache: 'reload' }),
    ]);
  } catch { /* offline: the navigation below will say so */ }

  const url = new URL(window.location.href);
  url.searchParams.set('_r', String(Date.now()));
  window.location.replace(url.toString());
}

// Called from main.js once the router is ready: removes the `_r` param that
// hardRefresh() added, so it doesn't linger in the address bar / bookmarks.
export function dropRefreshParam(router) {
  const { _r: stale, ...query } = router.currentRoute.value.query;
  if (stale === undefined) return;
  router.replace({ query, hash: router.currentRoute.value.hash });
}
