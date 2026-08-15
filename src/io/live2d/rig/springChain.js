// @ts-check

/**
 * Spring Chain — multi-joint warp-band secondary motion on one part.
 *
 * Authoring contract (see the 2026-08-15 design):
 *   1. User selects a meshed part that already has a per-part rig warp
 *      (Init Rig has run).
 *   2. Add a chain with N joints (2–4). Each joint is a ±1 parameter
 *      bound to that same warp; keyforms move a band of grid rows
 *      (or columns, if the part is wider than it is tall).
 *   3. A Cubism pendulum with N+1 particles writes those params. The
 *      idle generator keys `ParamWind` as an INPUT so the chain waves
 *      even when the body is still. Bake Physics turns the sim into
 *      motion3 curves.
 *
 * This is Cubism-legal: params + warp keyforms + physics3 outputs.
 * It is NOT Spine multi-bone LBS — one mesh, one warp parent, N params.
 *
 * Persistence: `project.springChains[]`. Params and physics modifiers
 * are `_userAuthored` so Init Rig merge keeps them; `reseedSpringChains`
 * rebuilds warp keyforms + physics after any Init Rig mode.
 *
 * @module io/live2d/rig/springChain
 */

import { sanitisePartName } from '../../../lib/partId.js';
import { coerceNumberArray } from '../../../lib/numberArrayCoerce.js';
import { matchTag } from '../../armatureMeta.js';
import { getMesh } from '../../../store/objectDataAccess.js';
import { getRigWarpNodes } from './deformerNodeReaders.js';
import { getWarpRestGrid } from '../../../store/warpLatticeAccess.js';
import { buildTagWarpBindingRules } from './tagWarpBindings.js';
import { DEFAULT_AUTO_RIG_CONFIG } from './autoRigConfig.js';

export const PARAM_WIND_ID = 'ParamWind';
export const MIN_JOINTS = 2;
export const MAX_JOINTS = 4;
export const DEFAULT_JOINTS = 3;

const JOINT_KEYS = Object.freeze([-1, 0, 1]);
const DEFAULT_MIGRATED_MODE = 7;
const SWAY_PARAM_IDS = new Set([
  'ParamHairFront', 'ParamHairBack',
  'ParamSkirt', 'ParamShirt', 'ParamPants', 'ParamBust',
]);

/**
 * @typedef {Object} SpringChainRecord
 * @property {string} partId
 * @property {number} jointCount
 * @property {string[]} paramIds
 * @property {string} physicsRuleId
 * @property {string} [replacedParamId]
 * @property {boolean} [_userAuthored]
 */

/**
 * @typedef {{ ok: true, chain: SpringChainRecord, warnings: string[] } | { ok: false, reason: string }} SpringChainResult
 */

/** @param {string} partId */
export function springChainRuleId(partId) {
  return `PhysicsSetting_SpringChain_${partId}`;
}

/**
 * @param {string} partId
 * @param {number} index
 */
export function springJointParamId(partId, index) {
  return `ParamSpring_${sanitisePartName(partId)}_${index}`;
}

/**
 * @param {object|null|undefined} project
 * @param {string} partId
 * @returns {SpringChainRecord|null}
 */
export function findSpringChain(project, partId) {
  if (!project || !Array.isArray(project.springChains)) return null;
  return project.springChains.find((c) => c && c.partId === partId) ?? null;
}

/**
 * @param {object|null|undefined} project
 * @param {string} partId
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canAddSpringChain(project, partId) {
  if (!project || typeof partId !== 'string' || partId.length === 0) {
    return { ok: false, reason: 'No part selected.' };
  }
  const part = (project.nodes ?? []).find((n) => n && n.id === partId);
  if (!part || part.type !== 'part') {
    return { ok: false, reason: 'Select a part.' };
  }
  const mesh = getMesh(part, project);
  const vertCount = Array.isArray(mesh?.vertices) ? mesh.vertices.length : 0;
  if (vertCount < 3) {
    return { ok: false, reason: 'Part has no mesh. Mesh the layer first.' };
  }
  const warp = getRigWarpNodes(project).get(partId);
  if (!warp) {
    return { ok: false, reason: 'Run Init Rig first — this part needs a warp deformer.' };
  }
  return { ok: true };
}

/**
 * Band weight for joint `j` of `n` at normalised length `frac` (0 = root, 1 = tip).
 * Root row stays pinned (`frac` factor). Peaks are spaced toward the tip.
 *
 * @param {number} frac
 * @param {number} j
 * @param {number} n
 */
export function springBandWeight(frac, j, n) {
  if (!(frac > 0) || n <= 0) return 0;
  const peak = (j + 1) / n;
  const sigma = Math.max(0.18, 0.65 / n);
  const d = (frac - peak) / sigma;
  return frac * Math.exp(-0.5 * d * d);
}

/**
 * Shift a rest grid by N joint values. Long-axis banding: Y if the
 * bbox is taller than wide, otherwise X (sideways straps).
 *
 * @param {Float64Array|number[]} grid
 * @param {number} gW
 * @param {number} gH
 * @param {number[]} keyValues
 * @param {number} gxSpan
 * @param {number} gySpan
 * @param {{ xSway?: number, yCurl?: number }} [magnitudes]
 * @returns {Float64Array}
 */
export function springChainShift(grid, gW, gH, keyValues, gxSpan, gySpan, magnitudes = {}) {
  const pos = new Float64Array(grid);
  const n = keyValues.length;
  if (n === 0 || gW < 1 || gH < 1) return pos;
  const alongY = Math.abs(gySpan) >= Math.abs(gxSpan);
  const xSway = Number.isFinite(magnitudes.xSway) ? /** @type {number} */ (magnitudes.xSway) : 0.10;
  const yCurl = Number.isFinite(magnitudes.yCurl) ? /** @type {number} */ (magnitudes.yCurl) : 0.025;
  const scale = Math.min(Math.abs(gxSpan) || 1, Math.abs(gySpan) || 1);

  for (let r = 0; r < gH; r++) {
    for (let c = 0; c < gW; c++) {
      const frac = alongY
        ? (gH <= 1 ? 0 : r / (gH - 1))
        : (gW <= 1 ? 0 : c / (gW - 1));
      let dx = 0;
      let dy = 0;
      for (let j = 0; j < n; j++) {
        const k = keyValues[j];
        if (!k) continue;
        const w = springBandWeight(frac, j, n);
        if (w === 0) continue;
        if (alongY) {
          dx += k * xSway * scale * w;
          dy += k * yCurl * scale * w;
        } else {
          dx += k * yCurl * scale * w;
          dy += k * xSway * scale * w;
        }
      }
      const idx = (r * gW + c) * 2;
      pos[idx] += dx;
      pos[idx + 1] += dy;
    }
  }
  return pos;
}

/**
 * Cartesian product of binding keys. Binding[0] is the fastest axis
 * (matches `perPartRigWarps.js` / Cubism column-major order).
 *
 * @param {Array<{keys: number[]}>} bindings
 * @returns {number[][]}
 */
export function cartesianKeyTuples(bindings) {
  const numBindings = bindings.length;
  if (numBindings === 0) return [[]];
  /** @type {number[][]} */
  const out = [];
  const valBuf = new Array(numBindings);
  const walk = (dim) => {
    if (dim === numBindings) {
      out.push(valBuf.slice());
      return;
    }
    const inv = numBindings - 1 - dim;
    const keys = bindings[inv].keys;
    for (let i = 0; i < keys.length; i++) {
      valBuf[inv] = keys[i];
      walk(dim + 1);
    }
  };
  walk(0);
  return out;
}

/**
 * @param {object} project
 * @returns {object} the ParamWind entry
 */
export function ensureParamWind(project) {
  if (!Array.isArray(project.parameters)) project.parameters = [];
  const existing = project.parameters.find((p) => p && p.id === PARAM_WIND_ID);
  if (existing) return existing;
  const wind = {
    id: PARAM_WIND_ID,
    name: 'Wind',
    role: 'custom',
    min: -1,
    max: 1,
    default: 0,
    decimalPlaces: 3,
    keys: [-1, 0, 1],
    _userAuthored: true,
    _userAuthoredKeys: [-1, 0, 1],
  };
  project.parameters.push(wind);
  return wind;
}

/**
 * @param {string} partId
 * @param {string[]} paramIds
 * @param {{ tag?: string|null }} [opts]
 */
export function buildSpringChainPhysicsRule(partId, paramIds, opts = {}) {
  const n = paramIds.length;
  const tag = opts.tag ?? null;
  const hairLike = tag === 'front hair' || tag === 'back hair';
  const step = hairLike ? 8 : 6;
  /** @type {Array<{x:number,y:number,mobility:number,delay:number,acceleration:number,radius:number}>} */
  const vertices = [
    { x: 0, y: 0, mobility: 1.0, delay: 1.0, acceleration: 1.0, radius: 0 },
  ];
  for (let i = 1; i <= n; i++) {
    const y = i * step;
    vertices.push({
      x: 0,
      y,
      mobility: Math.max(0.75, 0.95 - i * 0.04),
      delay: Math.max(0.45, 0.85 - i * 0.08),
      acceleration: 1.2 + i * 0.1,
      radius: step,
    });
  }
  const inputs = [
    { paramId: PARAM_WIND_ID, type: 'SRC_TO_X', weight: 80 },
    { paramId: 'ParamAngleX', type: 'SRC_TO_X', weight: hairLike ? 50 : 20 },
    { paramId: 'ParamAngleZ', type: 'SRC_TO_G_ANGLE', weight: hairLike ? 50 : 20 },
    { paramId: 'ParamBodyAngleX', type: 'SRC_TO_X', weight: hairLike ? 30 : 60 },
    { paramId: 'ParamBodyAngleZ', type: 'SRC_TO_G_ANGLE', weight: hairLike ? 30 : 60 },
  ];
  const outputs = paramIds.map((paramId, i) => ({
    paramId,
    vertexIndex: i + 1,
    scale: 1.0,
    isReverse: false,
  }));
  return {
    id: springChainRuleId(partId),
    name: 'Spring Chain',
    category: 'spring',
    inputs,
    vertices,
    outputs,
    normalization: {
      posMin: -10, posDef: 0, posMax: 10,
      angleMin: -10, angleDef: 0, angleMax: 10,
    },
    _userAuthored: true,
  };
}

/**
 * @param {Float64Array|number[]} grid
 * @param {number} gW
 * @param {number} gH
 */
function gridSpans(grid, gW, gH) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const n = gW * gH;
  for (let i = 0; i < n; i++) {
    const x = grid[i * 2];
    const y = grid[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    gxSpan: Number.isFinite(maxX - minX) ? maxX - minX : 1,
    gySpan: Number.isFinite(maxY - minY) ? maxY - minY : 1,
  };
}

/**
 * Resolve warp grid point counts from `gridSize` (cells) + rest length.
 *
 * @param {object} warp
 * @param {Float64Array|number[]} rest
 * @returns {{ gW: number, gH: number } | null}
 */
export function resolveWarpGridDims(warp, rest) {
  if (!rest || rest.length < 2 || rest.length % 2 !== 0) return null;
  const nPts = rest.length / 2;
  const cols = warp?.gridSize?.cols;
  const rows = warp?.gridSize?.rows;
  if (Number.isFinite(cols) && Number.isFinite(rows)) {
    if ((cols + 1) * (rows + 1) === nPts) return { gW: cols + 1, gH: rows + 1 };
    if (cols * rows === nPts) return { gW: cols, gH: rows };
  }
  // Fallback: prefer a tall grid (hair hangs down).
  const gW = Number.isFinite(cols) && cols > 0 ? cols + 1 : 3;
  const gH = Math.round(nPts / gW);
  if (gW * gH === nPts && gH >= 1) return { gW, gH };
  return null;
}

/**
 * @param {object} project
 * @param {object} warp
 * @param {Array<{parameterId:string, keys:number[], interpolation?:string}>} bindings
 * @param {(grid: Float64Array, gW: number, gH: number, keys: number[], gx: number, gy: number) => Float64Array} shiftFn
 */
function writeWarpKeyforms(project, warp, bindings, shiftFn) {
  const restRaw = getWarpRestGrid(warp, project);
  if (!restRaw) return false;
  const rest = restRaw instanceof Float64Array ? restRaw : Float64Array.from(restRaw);
  const dims = resolveWarpGridDims(warp, rest);
  if (!dims) return false;
  const { gW, gH } = dims;
  const { gxSpan, gySpan } = gridSpans(rest, gW, gH);
  const tuples = cartesianKeyTuples(bindings);
  warp.bindings = bindings.map((b) => ({
    parameterId: b.parameterId,
    keys: b.keys.slice(),
    interpolation: b.interpolation ?? 'LINEAR',
  }));
  warp.keyforms = tuples.map((keyTuple, i) => ({
    keyTuple: keyTuple.slice(),
    // Persist plain arrays — KEYFORM_EVAL skips Float64Array
    // (`Array.isArray` is false) and interpolates a zero grid, which
    // collapses the part to a point (artMeshDisappearDiag).
    positions: coerceNumberArray(
      shiftFn(rest, gW, gH, keyTuple, gxSpan, gySpan),
      `springChain.keyforms[${i}].positions`,
    ),
    opacity: 1,
  }));
  warp._userAuthored = true;
  return true;
}

/**
 * @param {object} project
 * @param {string} partId
 * @param {string[]} paramIds
 */
function applySpringChainWarpKeyforms(project, partId, paramIds) {
  const warp = getRigWarpNodes(project).get(partId);
  if (!warp) return false;
  const bindings = paramIds.map((parameterId) => ({
    parameterId,
    keys: JOINT_KEYS.slice(),
    interpolation: 'LINEAR',
  }));
  const mags = DEFAULT_AUTO_RIG_CONFIG.tagWarpMagnitudes;
  return writeWarpKeyforms(project, warp, bindings, (grid, gW, gH, keys, gx, gy) => (
    springChainShift(grid, gW, gH, keys, gx, gy, {
      xSway: mags.hairBackXSway,
      yCurl: mags.hairBackYCurl,
    })
  ));
}

/**
 * @param {object} project
 * @param {object} part
 */
function restoreTagWarpBindings(project, part) {
  const warp = getRigWarpNodes(project).get(part.id);
  if (!warp) return;
  const tag = matchTag(part.name ?? '') ?? part.tag ?? null;
  const rules = buildTagWarpBindingRules();
  const rule = tag ? rules.get(tag) : null;
  if (!rule || !Array.isArray(rule.bindings) || rule.bindings.length === 0) {
    const restRaw = getWarpRestGrid(warp, project);
    if (!restRaw) return;
    warp.bindings = [];
    warp.keyforms = [{
      keyTuple: [],
      positions: coerceNumberArray(restRaw, 'springChain.restore.positions'),
      opacity: 1,
    }];
    delete warp._userAuthored;
    return;
  }
  const bindings = rule.bindings.map((b) => ({
    parameterId: b.paramId,
    keys: b.keys.slice(),
    interpolation: 'LINEAR',
  }));
  writeWarpKeyforms(project, warp, bindings, rule.shiftFn);
  delete warp._userAuthored;
}

/**
 * @param {object} project
 * @param {Set<string>} paramIds
 * @param {boolean} enabled
 */
function setConflictingPhysicsEnabled(project, paramIds, enabled) {
  for (const node of project.nodes ?? []) {
    if (!Array.isArray(node?.modifiers)) continue;
    for (const mod of node.modifiers) {
      if (!mod || mod.type !== 'physicsModifier') continue;
      if (typeof mod.ruleId === 'string' && mod.ruleId.startsWith('PhysicsSetting_SpringChain_')) continue;
      if (paramIds.has(mod.output?.paramId)) mod.enabled = enabled;
    }
  }
}

/**
 * @param {object} warp
 * @returns {string[]}
 */
function swayBindingsOnWarp(warp) {
  const out = [];
  for (const b of warp?.bindings ?? []) {
    if (b?.parameterId && SWAY_PARAM_IDS.has(b.parameterId)) out.push(b.parameterId);
  }
  return out;
}

/**
 * @param {object} project
 * @param {string} ruleId
 */
function stripSpringPhysicsModifiers(project, ruleId) {
  for (const node of project.nodes ?? []) {
    if (!Array.isArray(node?.modifiers)) continue;
    const kept = node.modifiers.filter((m) => !(m && m.type === 'physicsModifier' && m.ruleId === ruleId));
    if (kept.length !== node.modifiers.length) {
      if (kept.length === 0) delete node.modifiers;
      else node.modifiers = kept;
    }
  }
}

/**
 * @param {object} part
 * @param {object} rule
 */
function attachSpringPhysicsModifiers(part, rule) {
  if (!Array.isArray(part.modifiers)) part.modifiers = [];
  for (const output of rule.outputs) {
    part.modifiers.push({
      type: 'physicsModifier',
      ruleId: rule.id,
      name: rule.name,
      category: rule.category,
      inputs: rule.inputs.map((i) => ({ ...i })),
      vertices: rule.vertices.map((v) => ({ ...v })),
      normalization: { ...rule.normalization },
      output: {
        paramId: output.paramId,
        vertexIndex: output.vertexIndex,
        scale: output.scale,
        isReverse: !!output.isReverse,
      },
      enabled: true,
      mode: DEFAULT_MIGRATED_MODE,
      showInEditor: true,
      _userAuthored: true,
    });
  }
}

/**
 * @param {object} project
 * @param {string} partId
 * @param {number} index
 */
function ensureJointParam(project, partId, index) {
  const id = springJointParamId(partId, index);
  if (!Array.isArray(project.parameters)) project.parameters = [];
  const existing = project.parameters.find((p) => p && p.id === id);
  if (existing) {
    existing._userAuthored = true;
    if (!Array.isArray(existing.keys) || existing.keys.length === 0) {
      existing.keys = JOINT_KEYS.slice();
    }
    return existing;
  }
  const param = {
    id,
    name: `Spring ${index + 1}`,
    role: 'custom',
    min: -1,
    max: 1,
    default: 0,
    decimalPlaces: 3,
    keys: JOINT_KEYS.slice(),
    _userAuthored: true,
    _userAuthoredKeys: JOINT_KEYS.slice(),
  };
  project.parameters.push(param);
  return param;
}

/**
 * Add or replace a spring chain on `partId`.
 *
 * @param {object} project
 * @param {string} partId
 * @param {{ jointCount?: number }} [opts]
 * @returns {SpringChainResult}
 */
export function addSpringChain(project, partId, opts = {}) {
  const gate = canAddSpringChain(project, partId);
  if (!gate.ok) return gate;

  let jointCount = Number.isFinite(opts.jointCount) ? Math.round(/** @type {number} */ (opts.jointCount)) : DEFAULT_JOINTS;
  if (jointCount < MIN_JOINTS) jointCount = MIN_JOINTS;
  if (jointCount > MAX_JOINTS) jointCount = MAX_JOINTS;

  if (findSpringChain(project, partId)) {
    const removed = removeSpringChain(project, partId);
    if (!removed.ok) return removed;
  }

  const part = project.nodes.find((n) => n && n.id === partId);
  const warp = getRigWarpNodes(project).get(partId);
  const replaced = swayBindingsOnWarp(warp);
  if (replaced.length > 0) {
    setConflictingPhysicsEnabled(project, new Set(replaced), false);
  }

  ensureParamWind(project);
  const paramIds = [];
  for (let i = 0; i < jointCount; i++) {
    paramIds.push(ensureJointParam(project, partId, i).id);
  }

  if (!applySpringChainWarpKeyforms(project, partId, paramIds)) {
    return { ok: false, reason: 'Could not write warp keyforms on this part.' };
  }

  const tag = matchTag(part.name ?? '') ?? part.tag ?? null;
  const rule = buildSpringChainPhysicsRule(partId, paramIds, { tag });
  stripSpringPhysicsModifiers(project, rule.id);
  attachSpringPhysicsModifiers(part, rule);

  if (!Array.isArray(project.springChains)) project.springChains = [];
  /** @type {SpringChainRecord} */
  const chain = {
    partId,
    jointCount,
    paramIds: paramIds.slice(),
    physicsRuleId: rule.id,
    replacedParamId: replaced[0],
    _userAuthored: true,
  };
  project.springChains.push(chain);

  /** @type {string[]} */
  const warnings = [];
  const rest = getWarpRestGrid(warp, project);
  const dims = rest ? resolveWarpGridDims(warp, rest) : null;
  if (dims && dims.gH < jointCount + 1) {
    warnings.push('Warp grid is coarse for this many joints — the wave will look stepped. Re-Init Rig after increasing warp rows for a smoother cascade.');
  }

  return { ok: true, chain, warnings };
}

/**
 * @param {object} project
 * @param {string} partId
 * @returns {SpringChainResult}
 */
export function removeSpringChain(project, partId) {
  const chain = findSpringChain(project, partId);
  if (!chain) return { ok: false, reason: 'No spring chain on this part.' };

  const part = (project.nodes ?? []).find((n) => n && n.id === partId);
  stripSpringPhysicsModifiers(project, chain.physicsRuleId);

  const drop = new Set(chain.paramIds ?? []);
  if (Array.isArray(project.parameters)) {
    project.parameters = project.parameters.filter((p) => p && !drop.has(p.id));
  }

  if (part) restoreTagWarpBindings(project, part);

  if (chain.replacedParamId) {
    setConflictingPhysicsEnabled(project, new Set([chain.replacedParamId]), true);
  }

  project.springChains = (project.springChains ?? []).filter((c) => c && c.partId !== partId);
  return { ok: true, chain, warnings: [] };
}

/**
 * Rebuild every stored chain after Init Rig (replace or merge).
 * Params / records survive; warp keyforms and physics modifiers are
 * rewritten so they match the post-seed warp lattice.
 *
 * @param {object} project
 * @returns {number} chains reapplied
 */
export function reseedSpringChains(project) {
  if (!project || !Array.isArray(project.springChains) || project.springChains.length === 0) {
    return 0;
  }
  const snapshot = project.springChains.map((c) => ({
    partId: c.partId,
    jointCount: c.jointCount,
  }));
  project.springChains = [];
  let applied = 0;
  for (const rec of snapshot) {
    if (!rec?.partId) continue;
    const result = addSpringChain(project, rec.partId, { jointCount: rec.jointCount });
    if (result.ok) applied += 1;
  }
  return applied;
}
