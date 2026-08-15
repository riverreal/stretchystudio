// @ts-check

/**
 * Rigid-follow extras (held props / PSD "objects").
 *
 * Editor: armature on + every lattice/warp off → Kabsch R+T of the live
 * body cage (no per-vertex FFD). Cubism has no modifier stack, so export
 * must not parent those meshes through BodyX. Instead it emits a
 * root-parented 1×1 warp whose keyforms are that same rigid transform.
 *
 * @module io/live2d/rig/rigidFollowExtra
 */

import { evalProjectFrameViaDepgraph } from '../../../anim/depgraph/evalProjectFrame.js';

export const RIGID_FOLLOW_WARP_PREFIX = 'RigidFollow_';

/** Prefer innermost (BodyX) so extras ride the full BodyZ→Y→Breath→X chain. */
export const INNERMOST_BODY_WARP_IDS = Object.freeze([
  'BodyXWarp', 'BreathWarp', 'BodyWarpY', 'BodyWarpZ',
]);

/** Same keys the body-warp chain authors. binding[0] is the fastest Cubism axis. */
export const BODY_FOLLOW_PARAM_DEFAULTS = Object.freeze([
  { parameterId: 'ParamBodyAngleX', keys: Object.freeze([-10, 0, 10]) },
  { parameterId: 'ParamBreath', keys: Object.freeze([0, 1]) },
  { parameterId: 'ParamBodyAngleY', keys: Object.freeze([-10, 0, 10]) },
  { parameterId: 'ParamBodyAngleZ', keys: Object.freeze([-10, 0, 10]) },
]);

const IDENTITY_XF = Object.freeze({ rx: 0, ry: 0, lx: 0, ly: 0, cos: 1, sin: 0 });

/**
 * Armature enabled, and every lattice/warp disabled (or none present).
 *
 * @param {object|null|undefined} part
 * @returns {boolean}
 */
export function isRigidFollowExtra(part) {
  const mods = part?.modifiers;
  if (!Array.isArray(mods) || mods.length === 0) return false;
  let hasArmature = false;
  for (const m of mods) {
    if (!m) continue;
    if (m.type === 'armature' && m.enabled !== false) hasArmature = true;
    if ((m.type === 'lattice' || m.type === 'warp') && m.enabled !== false) {
      return false;
    }
  }
  return hasArmature;
}

/**
 * @param {string|null|undefined} id
 * @returns {boolean}
 */
export function isRigidFollowWarpId(id) {
  return typeof id === 'string' && id.startsWith(RIGID_FOLLOW_WARP_PREFIX);
}

/**
 * @param {object|null|undefined} spec
 * @returns {boolean}
 */
export function isRigidFollowWarpSpec(spec) {
  if (!spec) return false;
  if (spec.rigidFollow === true) return true;
  return isRigidFollowWarpId(spec.id);
}

/**
 * @param {object|null|undefined} project
 * @returns {string|null}
 */
export function findInnermostBodyWarpId(project) {
  const ids = new Set();
  for (const n of project?.nodes ?? []) {
    if (!n || typeof n.id !== 'string') continue;
    if (n.type === 'deformer' && n.deformerKind && n.deformerKind !== 'warp') continue;
    if (n.type === 'deformer' || n.type === 'warp' || n.type === 'lattice') {
      ids.add(n.id);
    }
  }
  for (const id of INNERMOST_BODY_WARP_IDS) {
    if (ids.has(id)) return id;
  }
  return null;
}

/**
 * Bindings that exist on the Cubism param list (pid present).
 *
 * @param {Array<{id?: string, pid?: string}>|null|undefined} paramDefs
 * @returns {Array<{parameterId: string, pid: string, keys: number[], desc: string}>}
 */
export function resolveBodyFollowBindings(paramDefs) {
  const pidById = new Map();
  for (const p of paramDefs ?? []) {
    if (p?.id && p.pid) pidById.set(p.id, p.pid);
  }
  /** @type {Array<{parameterId: string, pid: string, keys: number[], desc: string}>} */
  const out = [];
  for (const def of BODY_FOLLOW_PARAM_DEFAULTS) {
    const pid = pidById.get(def.parameterId);
    if (!pid) continue;
    out.push({
      parameterId: def.parameterId,
      pid,
      keys: def.keys.slice(),
      desc: def.parameterId,
    });
  }
  return out;
}

/**
 * Cubism column-major cartesian product: binding[0] varies fastest.
 *
 * @param {Array<{keys: number[]}>} bindings
 * @returns {{keyCombos: number[][], valCombos: number[][]}}
 */
export function cartesianKeyCombos(bindings) {
  /** @type {number[][]} */
  const keyCombos = [];
  /** @type {number[][]} */
  const valCombos = [];
  const num = bindings.length;
  if (num === 0) return { keyCombos, valCombos };
  const idxBuf = new Array(num);
  const valBuf = new Array(num);
  const rec = (dim) => {
    if (dim === num) {
      keyCombos.push(idxBuf.slice());
      valCombos.push(valBuf.slice());
      return;
    }
    const inv = num - 1 - dim;
    const b = bindings[inv];
    for (let i = 0; i < b.keys.length; i++) {
      idxBuf[inv] = i;
      valBuf[inv] = b.keys[i];
      rec(dim + 1);
    }
  };
  rec(0);
  return { keyCombos, valCombos };
}

/**
 * 2D Kabsch (rotation + translation, no scale) mapping rest CPs → live.
 * Same fit the ART_MESH rigid-follow kernel uses.
 *
 * @param {ArrayLike<number>} rest
 * @param {ArrayLike<number>} live
 * @returns {{rx:number, ry:number, lx:number, ly:number, cos:number, sin:number}|null}
 */
export function rigidTransformFromGrids(rest, live) {
  const n = Math.min(rest.length, live.length) >> 1;
  if (n < 2) return null;
  let rx = 0, ry = 0, lx = 0, ly = 0;
  for (let i = 0; i < n; i++) {
    rx += rest[i * 2];
    ry += rest[i * 2 + 1];
    lx += live[i * 2];
    ly += live[i * 2 + 1];
  }
  rx /= n;
  ry /= n;
  lx /= n;
  ly /= n;
  let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0;
  for (let i = 0; i < n; i++) {
    const rxi = rest[i * 2] - rx;
    const ryi = rest[i * 2 + 1] - ry;
    const lxi = live[i * 2] - lx;
    const lyi = live[i * 2 + 1] - ly;
    Sxx += rxi * lxi;
    Sxy += rxi * lyi;
    Syx += ryi * lxi;
    Syy += ryi * lyi;
  }
  const a = Sxx + Syy;
  const b = Syx - Sxy;
  const mag = Math.hypot(a, b);
  return {
    rx, ry, lx, ly,
    cos: mag > 1e-8 ? a / mag : 1,
    sin: mag > 1e-8 ? b / mag : 0,
  };
}

/**
 * @param {ArrayLike<number>} src
 * @param {{rx:number, ry:number, lx:number, ly:number, cos:number, sin:number}|null|undefined} xf
 * @returns {Float64Array}
 */
export function applyRigidToPairs(src, xf) {
  const out = new Float64Array(src.length);
  const t = xf && Number.isFinite(xf.cos) ? xf : IDENTITY_XF;
  for (let i = 0; i < src.length; i += 2) {
    const dx = src[i] - t.rx;
    const dy = src[i + 1] - t.ry;
    out[i] = t.lx + dx * t.cos - dy * t.sin;
    out[i + 1] = t.ly + dx * t.sin + dy * t.cos;
  }
  return out;
}

/**
 * Padded canvas bbox of a flat [x,y,…] vertex list.
 *
 * @param {ArrayLike<number>} verts
 * @returns {{minX:number, minY:number, W:number, H:number}|null}
 */
export function bboxFromVerts(verts) {
  if (!verts || verts.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < verts.length; i += 2) {
    const x = verts[i], y = verts[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const padX = (maxX - minX) * 0.1 || 10;
  const padY = (maxY - minY) * 0.1 || 10;
  minX -= padX;
  minY -= padY;
  maxX += padX;
  maxY += padY;
  const W = maxX - minX;
  const H = maxY - minY;
  if (!(W > 0) || !(H > 0)) return null;
  return { minX, minY, W, H };
}

/**
 * 1×1 rest cage: TL, TR, BL, BR in canvas-px (row-major, Y down).
 *
 * @param {{minX:number, minY:number, W:number, H:number}} bbox
 * @returns {Float64Array}
 */
export function restQuadFromBbox(bbox) {
  const { minX, minY, W, H } = bbox;
  return new Float64Array([
    minX, minY,
    minX + W, minY,
    minX, minY + H,
    minX + W, minY + H,
  ]);
}

/**
 * Sample live-vs-rest body-cage Kabsch at each param tuple.
 *
 * @param {object} project
 * @param {string} bodyWarpId
 * @param {Array<Record<string, number>>} paramDicts
 * @returns {Array<{rx:number, ry:number, lx:number, ly:number, cos:number, sin:number}|null>}
 */
export function sampleBodyCageXforms(project, bodyWarpId, paramDicts) {
  /** @type {Record<string, number>} */
  const restValues = {};
  for (const d of paramDicts) {
    for (const k of Object.keys(d)) restValues[k] = 0;
  }
  const restGrids = new Map();
  evalProjectFrameViaDepgraph(project, restValues, { liftedGrids: restGrids });
  const restCage = restGrids.get(bodyWarpId);
  if (!restCage) {
    return paramDicts.map(() => null);
  }

  return paramDicts.map((vals) => {
    const liveGrids = new Map();
    evalProjectFrameViaDepgraph(project, vals, { liftedGrids: liveGrids });
    const liveCage = liveGrids.get(bodyWarpId);
    if (!liveCage) return null;
    return rigidTransformFromGrids(restCage, liveCage);
  });
}

/**
 * Build moc3/cmo3 warp specs for every rigid-follow extra.
 *
 * `sampleXforms` is injectable so tests can skip a full depgraph eval.
 *
 * @param {object} opts
 * @param {object} opts.project
 * @param {Array<{partId?: string, name?: string, vertices?: ArrayLike<number>}>} opts.meshes
 * @param {Array<{id?: string, pid?: string}>} [opts.paramDefs]
 * @param {(project: object, bodyWarpId: string, paramDicts: Array<Record<string, number>>) => Array<object|null>} [opts.sampleXforms]
 * @returns {Array<object>}
 */
export function buildRigidFollowWarpSpecs(opts) {
  const { project, meshes, paramDefs = [], sampleXforms = sampleBodyCageXforms } = opts;
  if (!project?.nodes || !Array.isArray(meshes) || meshes.length === 0) return [];

  const partsById = new Map();
  for (const n of project.nodes) {
    if (n?.type === 'part' && typeof n.id === 'string') partsById.set(n.id, n);
  }

  /** @type {Array<{partId: string, name: string, bbox: {minX:number, minY:number, W:number, H:number}}>} */
  const extras = [];
  for (const m of meshes) {
    if (!m?.partId || !partsById.has(m.partId)) continue;
    if (!isRigidFollowExtra(partsById.get(m.partId))) continue;
    const bbox = bboxFromVerts(m.vertices);
    if (!bbox) continue;
    extras.push({ partId: m.partId, name: m.name || m.partId, bbox });
  }
  if (extras.length === 0) return [];

  const bodyWarpId = findInnermostBodyWarpId(project);
  if (!bodyWarpId) return [];

  const bindings = resolveBodyFollowBindings(paramDefs);
  if (bindings.length === 0) return [];

  const { valCombos } = cartesianKeyCombos(bindings);
  const paramDicts = valCombos.map((vals) => {
    /** @type {Record<string, number>} */
    const d = {};
    for (let i = 0; i < bindings.length; i++) d[bindings[i].parameterId] = vals[i];
    return d;
  });

  const xforms = sampleXforms(project, bodyWarpId, paramDicts);

  return extras.map((extra) => {
    const restQuad = restQuadFromBbox(extra.bbox);
    const keyforms = valCombos.map((vals, ki) => ({
      keyTuple: vals.slice(),
      positions: applyRigidToPairs(restQuad, xforms[ki]),
      opacity: 1,
    }));
    return {
      id: `${RIGID_FOLLOW_WARP_PREFIX}${extra.partId}`,
      name: `${extra.name} Follow`,
      parent: { type: 'root', id: null },
      targetPartId: extra.partId,
      canvasBbox: {
        minX: extra.bbox.minX,
        minY: extra.bbox.minY,
        W: extra.bbox.W,
        H: extra.bbox.H,
      },
      gridSize: { rows: 1, cols: 1 },
      baseGrid: restQuad,
      localFrame: 'canvas-px',
      bindings: bindings.map((b) => ({
        parameterId: b.parameterId,
        keys: b.keys.slice(),
        interpolation: 'LINEAR',
      })),
      keyforms,
      isVisible: true,
      isLocked: false,
      isQuadTransform: false,
      rigidFollow: true,
    };
  });
}
