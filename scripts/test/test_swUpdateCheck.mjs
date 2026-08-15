// scripts/test/test_swUpdateCheck.mjs
//
// Verifies periodic + visibility SW update probes:
//   §1 probeSwUpdate skips cancelled / installing / offline / non-200
//   §2 probeSwUpdate calls registration.update() on a 200 fetch
//   §3 startPeriodicSwUpdateChecks interval + visibility + min-gap
//   §4 stop() removes listeners and clears the interval
//
// Run: node scripts/test/test_swUpdateCheck.mjs

import {
  probeSwUpdate,
  startPeriodicSwUpdateChecks,
  SW_UPDATE_INTERVAL_MS,
  SW_UPDATE_MIN_GAP_MS,
} from '../../src/lib/swUpdateCheck.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(name);
  console.error(`FAIL: ${name}`);
}

function eq(actual, expected, name) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push(name);
  console.error(`FAIL: ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function makeRegistration(overrides = {}) {
  const calls = { update: 0 };
  return {
    calls,
    installing: overrides.installing ?? null,
    async update() {
      calls.update += 1;
      if (overrides.update) return overrides.update();
    },
  };
}

function makeFetch(status, { throwError = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwError) throw new Error('network down');
    return { status };
  };
  return { fetchImpl, calls };
}

// ── §1 probeSwUpdate guards ──────────────────────────────────────────
console.log('\n§1 probeSwUpdate guards');
{
  const { fetchImpl, calls } = makeFetch(200);
  const reg = makeRegistration();
  eq(await probeSwUpdate('/sw.js', reg, { fetchImpl, isCancelled: () => true }), false, '§1.1 cancelled → no update');
  eq(reg.calls.update, 0, '§1.1 cancelled does not call update()');
  eq(calls.length, 0, '§1.1 cancelled does not fetch');
}

{
  const { fetchImpl } = makeFetch(200);
  const reg = makeRegistration({ installing: {} });
  eq(await probeSwUpdate('/sw.js', reg, { fetchImpl }), false, '§1.2 installing → no update');
  eq(reg.calls.update, 0, '§1.2 installing does not call update()');
}

{
  const { fetchImpl, calls } = makeFetch(200);
  const reg = makeRegistration();
  eq(await probeSwUpdate('/sw.js', reg, { fetchImpl, onLine: false }), false, '§1.3 offline → no update');
  eq(calls.length, 0, '§1.3 offline does not fetch');
}

{
  const { fetchImpl } = makeFetch(404);
  const reg = makeRegistration();
  eq(await probeSwUpdate('/sw.js', reg, { fetchImpl }), false, '§1.4 non-200 → no update');
  eq(reg.calls.update, 0, '§1.4 404 does not call update()');
}

{
  const { fetchImpl } = makeFetch(200, { throwError: true });
  const reg = makeRegistration();
  eq(await probeSwUpdate('/sw.js', reg, { fetchImpl }), false, '§1.5 fetch throw → no update');
  eq(reg.calls.update, 0, '§1.5 fetch throw does not call update()');
}

{
  let cancelledAfterFetch = false;
  const fetchImpl = async () => {
    cancelledAfterFetch = true;
    return { status: 200 };
  };
  const reg = makeRegistration();
  eq(
    await probeSwUpdate('/sw.js', reg, {
      fetchImpl,
      isCancelled: () => cancelledAfterFetch,
    }),
    false,
    '§1.6 cancel after fetch → no update',
  );
  eq(reg.calls.update, 0, '§1.6 cancel after fetch does not call update()');
}

// ── §2 probeSwUpdate success ─────────────────────────────────────────
console.log('\n§2 probeSwUpdate success');
{
  const { fetchImpl, calls } = makeFetch(200);
  const reg = makeRegistration();
  eq(await probeSwUpdate('/sw.js', reg, { fetchImpl }), true, '§2.1 200 → update invoked');
  eq(reg.calls.update, 1, '§2.1 update() once');
  eq(calls.length, 1, '§2.1 fetch once');
  eq(calls[0].url, '/sw.js', '§2.1 fetches swUrl');
  eq(calls[0].init?.cache, 'no-store', '§2.1 cache: no-store');
}

// ── §3 startPeriodicSwUpdateChecks scheduling ────────────────────────
console.log('\n§3 startPeriodicSwUpdateChecks scheduling');
{
  eq(SW_UPDATE_INTERVAL_MS, 60 * 1000, '§3.0 default interval is 60s');
  eq(SW_UPDATE_MIN_GAP_MS, 15 * 1000, '§3.0 default min-gap is 15s');
}

{
  const { fetchImpl } = makeFetch(200);
  const reg = makeRegistration();
  /** @type {Array<{ handler: () => void, ms: number }>} */
  const intervals = [];
  const listeners = { document: [], window: [] };
  let now = 1_000_000;
  const doc = {
    visibilityState: 'visible',
    addEventListener(type, handler) { listeners.document.push({ type, handler }); },
    removeEventListener(type, handler) {
      listeners.document = listeners.document.filter((l) => l.type !== type || l.handler !== handler);
    },
  };
  const win = {
    addEventListener(type, handler) { listeners.window.push({ type, handler }); },
    removeEventListener(type, handler) {
      listeners.window = listeners.window.filter((l) => l.type !== type || l.handler !== handler);
    },
  };

  const stop = startPeriodicSwUpdateChecks('/sw.js', reg, {
    fetchImpl,
    intervalMs: 60_000,
    minGapMs: 15_000,
    nowImpl: () => now,
    setIntervalImpl: (handler, ms) => {
      intervals.push({ handler, ms });
      return 1;
    },
    clearIntervalImpl: () => {},
    documentRef: doc,
    windowRef: win,
  });

  eq(intervals.length, 1, '§3.1 starts one interval');
  eq(intervals[0].ms, 60_000, '§3.1 interval uses intervalMs');
  eq(reg.calls.update, 0, '§3.1 does not probe immediately');
  ok(listeners.document.some((l) => l.type === 'visibilitychange'), '§3.1 listens for visibilitychange');
  ok(listeners.window.some((l) => l.type === 'focus'), '§3.1 listens for focus');

  intervals[0].handler();
  await Promise.resolve();
  await Promise.resolve();
  eq(reg.calls.update, 1, '§3.2 interval tick probes');

  intervals[0].handler();
  await Promise.resolve();
  await Promise.resolve();
  eq(reg.calls.update, 1, '§3.3 second tick inside min-gap is skipped');

  now += 15_000;
  const vis = listeners.document.find((l) => l.type === 'visibilitychange');
  vis.handler();
  await Promise.resolve();
  await Promise.resolve();
  eq(reg.calls.update, 2, '§3.4 visibilitychange after min-gap probes');

  doc.visibilityState = 'hidden';
  now += 15_000;
  vis.handler();
  await Promise.resolve();
  await Promise.resolve();
  eq(reg.calls.update, 2, '§3.5 hidden visibilitychange does not probe');

  stop();
}

// ── §4 stop() cleanup ────────────────────────────────────────────────
console.log('\n§4 stop() cleanup');
{
  const { fetchImpl } = makeFetch(200);
  const reg = makeRegistration();
  let cleared = 0;
  const listeners = { document: [], window: [] };
  const doc = {
    visibilityState: 'visible',
    addEventListener(type, handler) { listeners.document.push({ type, handler }); },
    removeEventListener(type, handler) {
      listeners.document = listeners.document.filter((l) => l.type !== type || l.handler !== handler);
    },
  };
  const win = {
    addEventListener(type, handler) { listeners.window.push({ type, handler }); },
    removeEventListener(type, handler) {
      listeners.window = listeners.window.filter((l) => l.type !== type || l.handler !== handler);
    },
  };

  const stop = startPeriodicSwUpdateChecks('/sw.js', reg, {
    fetchImpl,
    setIntervalImpl: () => 42,
    clearIntervalImpl: (id) => { if (id === 42) cleared += 1; },
    documentRef: doc,
    windowRef: win,
  });
  stop();
  eq(cleared, 1, '§4.1 stop clears the interval');
  eq(listeners.document.length, 0, '§4.2 stop removes document listeners');
  eq(listeners.window.length, 0, '§4.3 stop removes window listeners');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
