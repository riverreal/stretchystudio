// @ts-check

/**
 * Periodic + visibility service-worker update probes.
 *
 * `registration.update()` runs on navigation (and a slow browser timer,
 * often ~24h). An open Stretchy Studio tab therefore never saw a deploy
 * until the user reloaded — which then only *discovered* the waiting
 * worker and still needed the "Update available" toast to activate it.
 *
 * These helpers re-ask the server for a new worker while the tab stays
 * open. Activation stays prompt-gated (`registerType: 'prompt'`).
 *
 * @module lib/swUpdateCheck
 */

/** How often a focused open tab re-asks for a new service worker. */
export const SW_UPDATE_INTERVAL_MS = 60 * 1000;

/** Collapse focus + visibilitychange into one probe. */
export const SW_UPDATE_MIN_GAP_MS = 15 * 1000;

/**
 * @typedef {object} SwUpdateProbeContext
 * @property {() => boolean} [isCancelled]
 * @property {typeof fetch} [fetchImpl]
 * @property {boolean} [onLine]
 */

/**
 * One update probe. Fetches the SW script with cache bypass (so a
 * cached `sw.js` does not hide a deploy), then calls
 * `registration.update()` when the server answers 200.
 *
 * @param {string} swUrl
 * @param {{ installing?: unknown, update: () => Promise<unknown> }} registration
 * @param {SwUpdateProbeContext} [ctx]
 * @returns {Promise<boolean>} whether `update()` was invoked
 */
export async function probeSwUpdate(swUrl, registration, ctx = {}) {
  if (ctx.isCancelled?.()) return false;
  if (registration.installing) return false;
  if (ctx.onLine === false) return false;

  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return false;

  try {
    const resp = await fetchImpl(swUrl, {
      cache: 'no-store',
      headers: {
        cache: 'no-store',
        'cache-control': 'no-cache',
      },
    });
    if (resp?.status !== 200) return false;
    if (ctx.isCancelled?.()) return false;
    await registration.update();
    return true;
  } catch {
    // Offline / transient — the next interval or focus retry.
    return false;
  }
}

/**
 * @typedef {object} SwUpdateCheckOptions
 * @property {() => boolean} [isCancelled]
 * @property {typeof fetch} [fetchImpl]
 * @property {boolean} [onLine]
 * @property {number} [intervalMs]
 * @property {number} [minGapMs]
 * @property {() => number} [nowImpl]
 * @property {(handler: () => void, ms: number) => unknown} [setIntervalImpl]
 * @property {(id: unknown) => void} [clearIntervalImpl]
 * @property {{ addEventListener?: Function, removeEventListener?: Function, visibilityState?: string }} [documentRef]
 * @property {{ addEventListener?: Function, removeEventListener?: Function }} [windowRef]
 */

/**
 * Start interval + visibility/focus probes. Returns a stop function.
 *
 * Does not probe immediately — `registerSW` already checks on register.
 *
 * @param {string} swUrl
 * @param {{ installing?: unknown, update: () => Promise<unknown> }} registration
 * @param {SwUpdateCheckOptions} [options]
 * @returns {() => void}
 */
export function startPeriodicSwUpdateChecks(swUrl, registration, options = {}) {
  const isCancelled = options.isCancelled ?? (() => false);
  const intervalMs = options.intervalMs ?? SW_UPDATE_INTERVAL_MS;
  const minGapMs = options.minGapMs ?? SW_UPDATE_MIN_GAP_MS;
  const nowImpl = options.nowImpl ?? Date.now;
  const setIntervalImpl = options.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  const doc = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
  const win = options.windowRef ?? (typeof window !== 'undefined' ? window : null);

  let lastCheckAt = 0;
  let inFlight = false;

  const run = () => {
    if (isCancelled() || inFlight) return;
    const now = nowImpl();
    if (now - lastCheckAt < minGapMs) return;
    lastCheckAt = now;
    inFlight = true;
    const onLine = options.onLine ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
    void probeSwUpdate(swUrl, registration, {
      isCancelled,
      fetchImpl: options.fetchImpl,
      onLine,
    }).finally(() => {
      inFlight = false;
    });
  };

  const intervalId = setIntervalImpl(run, intervalMs);

  const onVisible = () => {
    if (doc?.visibilityState && doc.visibilityState !== 'visible') return;
    run();
  };

  doc?.addEventListener?.('visibilitychange', onVisible);
  win?.addEventListener?.('focus', onVisible);

  return () => {
    clearIntervalImpl(intervalId);
    doc?.removeEventListener?.('visibilitychange', onVisible);
    win?.removeEventListener?.('focus', onVisible);
  };
}
