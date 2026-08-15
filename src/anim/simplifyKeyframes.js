// @ts-check

/**
 * Pick a sparse subset of densely sampled `{time, value}` points that
 * still reconstructs the curve via interpolation.
 *
 * Physics bake and the idle generators sample every frame (or every
 * ~16 ms) so the source curve is accurate. Writing all of those as
 * keyforms makes the dopesheet / F-curve editor unusable — a single
 * 8 s idle at 30 fps plants ~240 keys on every spring joint. This
 * module keeps the endpoints, the local extrema, and only those
 * in-between samples whose value would drift more than `tolerance`
 * if we interpolated across the gap.
 *
 * Error is measured vertically (value at that time vs. the linear
 * interpolant between keepers), not as 2D perpendicular distance.
 * Time is in ms and values are often ±1, so a geometric RDP would
 * let the time axis dominate and keep almost every sample.
 *
 * @module anim/simplifyKeyframes
 */

/**
 * @typedef {Object} TimedSample
 * @property {number} time
 * @property {number} value
 */

/**
 * @typedef {Object} SimplifyKeyframesOpts
 * @property {number} [relativeTolerance=0.03]  Fraction of the
 *   series' value range. Used when `tolerance` is omitted.
 * @property {number} [tolerance]  Absolute value error. Overrides
 *   `relativeTolerance` when finite.
 * @property {number} [minTolerance=1e-4]  Floor on the effective
 *   epsilon so a nearly-flat series still collapses to endpoints.
 * @property {boolean} [keepExtrema=true]  Always keep local peaks
 *   and troughs (sign change of the discrete derivative).
 */

const DEFAULT_RELATIVE_TOLERANCE = 0.03;
const DEFAULT_MIN_TOLERANCE = 1e-4;

/**
 * @param {unknown} samples
 * @param {SimplifyKeyframesOpts} [opts]
 * @returns {TimedSample[]}
 */
export function selectSparseKeyframes(samples, opts = {}) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  if (samples.length <= 2) return samples.slice();

  /** @type {TimedSample[]} */
  const pts = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    if (!Number.isFinite(s.time) || !Number.isFinite(s.value)) continue;
    pts.push(/** @type {TimedSample} */ (s));
  }
  if (pts.length <= 2) return pts.slice();

  pts.sort((a, b) => a.time - b.time);

  let vmin = Infinity;
  let vmax = -Infinity;
  for (const p of pts) {
    if (p.value < vmin) vmin = p.value;
    if (p.value > vmax) vmax = p.value;
  }
  const range = vmax - vmin;
  const minTol = Number.isFinite(opts.minTolerance) ? /** @type {number} */ (opts.minTolerance) : DEFAULT_MIN_TOLERANCE;
  const rel = Number.isFinite(opts.relativeTolerance)
    ? /** @type {number} */ (opts.relativeTolerance)
    : DEFAULT_RELATIVE_TOLERANCE;
  const eps = Number.isFinite(opts.tolerance)
    ? Math.max(/** @type {number} */ (opts.tolerance), 0)
    : Math.max(rel * range, minTol);

  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  if (opts.keepExtrema !== false && range > eps) {
    const prominence = Math.max(range * 0.01, minTol);
    for (let i = 1; i < n - 1; i++) {
      const left = pts[i].value - pts[i - 1].value;
      const right = pts[i + 1].value - pts[i].value;
      if (left * right < 0 && Math.min(Math.abs(left), Math.abs(right)) >= prominence) {
        keep[i] = 1;
      }
    }
  }

  /** @type {number[]} */
  const anchors = [];
  for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i);
  for (let a = 0; a < anchors.length - 1; a++) {
    rdpMark(pts, anchors[a], anchors[a + 1], eps, keep);
  }

  /** @type {TimedSample[]} */
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Group records by `groupKey`, thin each series independently, then
 * flatten. Used by physics bake so each output param is simplified
 * on its own time series.
 *
 * @param {Array<TimedSample & Record<string, unknown>>} records
 * @param {string} groupKey
 * @param {SimplifyKeyframesOpts} [opts]
 * @returns {Array<TimedSample & Record<string, unknown>>}
 */
export function selectSparseKeyframesGrouped(records, groupKey, opts) {
  if (!Array.isArray(records) || records.length === 0) return [];
  if (typeof groupKey !== 'string' || groupKey.length === 0) {
    return selectSparseKeyframes(records, opts);
  }

  /** @type {Map<unknown, typeof records>} */
  const groups = new Map();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const k = rec[groupKey];
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(rec);
  }

  /** @type {typeof records} */
  const out = [];
  for (const arr of groups.values()) {
    out.push(.../** @type {typeof records} */ (selectSparseKeyframes(arr, opts)));
  }
  return out;
}

/**
 * Ramer–Douglas–Peucker using vertical (value) error.
 *
 * @param {TimedSample[]} pts
 * @param {number} i0
 * @param {number} i1
 * @param {number} eps
 * @param {Uint8Array} keep
 */
function rdpMark(pts, i0, i1, eps, keep) {
  if (i1 - i0 <= 1) return;
  const a = pts[i0];
  const b = pts[i1];
  const dt = b.time - a.time;
  if (dt === 0) return;

  let maxErr = 0;
  let maxI = -1;
  for (let i = i0 + 1; i < i1; i++) {
    const t = (pts[i].time - a.time) / dt;
    const expected = a.value + t * (b.value - a.value);
    const err = Math.abs(pts[i].value - expected);
    if (err > maxErr) {
      maxErr = err;
      maxI = i;
    }
  }
  if (maxErr > eps && maxI > i0) {
    keep[maxI] = 1;
    rdpMark(pts, i0, maxI, eps, keep);
    rdpMark(pts, maxI, i1, eps, keep);
  }
}
