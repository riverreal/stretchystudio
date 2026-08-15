// Keyframe reduction — keep endpoints / extrema, drop samples that
// interpolation can reconstruct.
//
// Run: node scripts/test/test_simplifyKeyframes.mjs

import {
  selectSparseKeyframes,
  selectSparseKeyframesGrouped,
} from '../../src/anim/simplifyKeyframes.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`FAIL: ${msg}`); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function sineSamples(n, cycles = 2, amp = 1) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 1000 * cycles;
    out.push({ time: t, value: amp * Math.sin((2 * Math.PI * cycles * i) / n) });
  }
  return out;
}

// ── empty / tiny inputs ──────────────────────────────────────────────

ok(selectSparseKeyframes(null).length === 0, 'null → []');
ok(selectSparseKeyframes([]).length === 0, '[] → []');
{
  const two = [{ time: 0, value: 1 }, { time: 10, value: 2 }];
  const out = selectSparseKeyframes(two);
  ok(out.length === 2, 'two samples kept as-is');
  ok(out !== two, 'two-sample input is copied');
}

// ── constant series collapses to endpoints ───────────────────────────

{
  const flat = [];
  for (let i = 0; i <= 40; i++) flat.push({ time: i * 25, value: 0.5 });
  const out = selectSparseKeyframes(flat);
  ok(out.length === 2, `flat series → 2 keys (got ${out.length})`);
  ok(out[0].time === 0 && out[1].time === 1000, 'flat series keeps endpoints');
  ok(out[0].value === 0.5 && out[1].value === 0.5, 'flat series values preserved');
}

// ── linear ramp: only endpoints (RDP error is 0) ─────────────────────

{
  const ramp = [];
  for (let i = 0; i <= 20; i++) ramp.push({ time: i * 50, value: i / 20 });
  const out = selectSparseKeyframes(ramp);
  ok(out.length === 2, `linear ramp → 2 keys (got ${out.length})`);
  ok(near(out[0].value, 0) && near(out[1].value, 1), 'ramp endpoints keep 0 and 1');
}

// ── sine: far fewer keys than samples, extrema kept ──────────────────

{
  const dense = sineSamples(240, 4, 1);
  const out = selectSparseKeyframes(dense);
  ok(out.length < dense.length * 0.25,
    `sine 241 samples → sparse (got ${out.length} / ${dense.length})`);
  ok(out.length >= 8, `sine 4 cycles keeps extrema (got ${out.length})`);
  ok(out[0].time === dense[0].time && out[out.length - 1].time === dense[dense.length - 1].time,
    'sine keeps first/last time');

  // Peaks at +1 and troughs at -1 must survive.
  const hasPeak = out.some((k) => near(k.value, 1, 1e-6));
  const hasTrough = out.some((k) => near(k.value, -1, 1e-6));
  ok(hasPeak, 'sine keeps a +1 peak');
  ok(hasTrough, 'sine keeps a -1 trough');
}

// ── reconstruct error stays within tolerance ─────────────────────────

{
  const dense = sineSamples(180, 3, 2);
  const rel = 0.03;
  const out = selectSparseKeyframes(dense, { relativeTolerance: rel });
  const range = 4; // amp 2 → [-2, 2]
  const eps = rel * range;
  let maxErr = 0;
  let j = 0;
  for (const s of dense) {
    while (j < out.length - 2 && out[j + 1].time < s.time) j++;
    const a = out[j];
    const b = out[j + 1];
    const dt = b.time - a.time;
    const expected = dt === 0 ? a.value : a.value + ((s.time - a.time) / dt) * (b.value - a.value);
    const err = Math.abs(s.value - expected);
    if (err > maxErr) maxErr = err;
  }
  ok(maxErr <= eps + 1e-9,
    `reconstruct error ${maxErr.toFixed(4)} ≤ tolerance ${eps.toFixed(4)}`);
}

// ── extra fields (rnaPath) survive ───────────────────────────────────

{
  const samples = [
    { time: 0, value: 0, rnaPath: 'p' },
    { time: 10, value: 1, rnaPath: 'p' },
    { time: 20, value: 0, rnaPath: 'p' },
  ];
  const out = selectSparseKeyframes(samples);
  ok(out.every((k) => k.rnaPath === 'p'), 'rnaPath preserved on kept samples');
}

// ── grouped: each path thinned independently ─────────────────────────

{
  const records = [];
  for (let i = 0; i <= 40; i++) {
    records.push({ rnaPath: 'a', time: i * 25, value: 0.5 });
    records.push({ rnaPath: 'b', time: i * 25, value: Math.sin((i / 40) * Math.PI * 2) });
  }
  const out = selectSparseKeyframesGrouped(records, 'rnaPath');
  const a = out.filter((r) => r.rnaPath === 'a');
  const b = out.filter((r) => r.rnaPath === 'b');
  ok(a.length === 2, `grouped flat path → 2 keys (got ${a.length})`);
  ok(b.length > 2 && b.length < 20, `grouped sine path is sparse (got ${b.length})`);
}

// ── does not mutate input ────────────────────────────────────────────

{
  const src = sineSamples(20, 1, 1);
  const snapshot = JSON.stringify(src);
  selectSparseKeyframes(src);
  ok(JSON.stringify(src) === snapshot, 'input array not mutated');
}

console.log(`simplifyKeyframes: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
