// @ts-check

/**
 * Emit root-parented rigid-follow warps for extras (armature on, lattices off).
 *
 * Cubism has no modifier stack. Parenting those meshes through BodyX
 * FFD-squashes them in Viewer / Unity. This emit writes a 1×1 warp at
 * ROOT whose keyforms are the Kabsch R+T of the live-vs-rest body cage
 * — the same transform the editor ART_MESH kernel applies.
 *
 * Do NOT push these onto `rigWarpTargetNodesToReparent` (that would
 * hang them under BodyX and undo the point).
 *
 * @module io/live2d/cmo3/rigidFollowWarpEmit
 */

import { uuid } from '../xmlbuilder.js';
import { emitKfBinding, emitStructuralWarp } from './deformerEmit.js';
import { logger } from '../../../lib/logger.js';
import {
  buildRigidFollowWarpSpecs,
  isRigidFollowExtra,
} from '../rig/rigidFollowExtra.js';

/**
 * @param {import('./emitContext.js').EmitContext} ctx
 * @param {Object} opts
 * @param {Map<string, string>} opts.meshWarpDeformerGuids
 * @param {Map<string, {gridMinX: number, gridMinY: number, gridW: number, gridH: number}>} opts.rigWarpBbox
 * @param {any} opts.rootPart
 * @param {Array<{pid: string, tag: string}>} opts.allDeformerSources
 * @param {{specs?: Array<object>}|null} [opts.bodyWarpChain]
 */
export function emitRigidFollowWarps(ctx, opts) {
  const {
    x, meshes, perMesh, generateRig, project,
    pidDeformerRoot, pidCoord, paramDefs, rigCollector,
  } = ctx;
  const {
    meshWarpDeformerGuids, rigWarpBbox, rootPart, allDeformerSources,
    bodyWarpChain = null,
  } = opts;

  if (!generateRig || !project?.nodes) return;

  const meshByPartId = new Map();
  for (const pm of perMesh ?? []) {
    const m = meshes[pm.mi];
    if (!m?.partId) continue;
    meshByPartId.set(m.partId, {
      partId: m.partId,
      name: pm.meshName || m.name || m.partId,
      vertices: pm.vertices ?? m.vertices,
    });
  }
  // Fallback when perMesh isn't filled yet (shouldn't happen at the
  // section-3c call site, but keep generateCmo3-less unit tests working).
  if (meshByPartId.size === 0) {
    for (const m of meshes ?? []) {
      if (!m?.partId) continue;
      meshByPartId.set(m.partId, {
        partId: m.partId,
        name: m.name || m.partId,
        vertices: m.vertices,
      });
    }
  }

  const extras = [];
  for (const n of project.nodes) {
    if (n?.type !== 'part' || !isRigidFollowExtra(n)) continue;
    const mesh = meshByPartId.get(n.id);
    if (!mesh) continue;
    if (meshWarpDeformerGuids.has(n.id)) continue;
    extras.push(mesh);
  }
  if (extras.length === 0) return;

  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const specs = buildRigidFollowWarpSpecs({
    project,
    meshes: extras,
    paramDefs,
    bodyWarpChain: bodyWarpChain ?? ctx.bodyWarpChain ?? null,
  });
  const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
  if (specs.length === 0) {
    logger.info('rigidFollowWarpEmit', 'no specs (missing body warp or body params)', {
      extras: extras.length,
    });
    return;
  }
  const rest0 = specs[0]?.baseGrid;
  let peakMove = 0;
  for (const kf of specs[0]?.keyforms ?? []) {
    const pos = kf.positions;
    if (!rest0 || !pos) continue;
    for (let i = 0; i < pos.length && i < rest0.length; i += 2) {
      const d = Math.hypot(pos[i] - rest0[i], pos[i + 1] - rest0[i + 1]);
      if (d > peakMove) peakMove = d;
    }
  }
  logger.info('rigidFollowWarpEmit', `emitted ${specs.length} root follow warp(s)`, {
    extras: specs.length,
    keyforms: specs[0]?.keyforms?.length ?? 0,
    peakMovePx: Math.round(peakMove * 10) / 10,
    ms: Math.round(elapsed),
  });
  if (peakMove < 0.5) {
    logger.warn('rigidFollowWarpEmit', 'follow keyforms are nearly identity — extras will look static in Cubism', {
      peakMovePx: peakMove,
    });
  }

  const pidByParamId = new Map();
  for (const p of paramDefs ?? []) {
    if (p?.id && p.pid) pidByParamId.set(p.id, p.pid);
  }

  for (const spec of specs) {
    const bindings = spec.bindings
      .map((b) => {
        const pid = pidByParamId.get(b.parameterId);
        if (!pid) return null;
        return { pid, keys: b.keys, desc: b.parameterId };
      })
      .filter(Boolean);
    if (bindings.length === 0) continue;

    const numBindings = bindings.length;
    const totalKf = spec.keyforms.length;
    const formGuids = [];

    const kfbs = bindings.map((b) => {
      const [kfb, pidKfb] = x.shared('KeyformBindingSource');
      return { kfb, pidKfb, ...b };
    });
    const [kfg, pidKfg] = x.shared('KeyformGridSource');
    const kfogList = x.sub(kfg, 'array_list', {
      'xs.n': 'keyformsOnGrid', count: String(totalKf),
    });
    for (let ki = 0; ki < totalKf; ki++) {
      const tuple = spec.keyforms[ki].keyTuple ?? [];
      const [, pidForm] = x.shared('CFormGuid', {
        uuid: uuid(), note: `${spec.id}_${tuple.join('_')}`,
      });
      formGuids.push(pidForm);
      const kog = x.sub(kfogList, 'KeyformOnGrid');
      const ak = x.sub(kog, 'KeyformGridAccessKey', { 'xs.n': 'accessKey' });
      const kop = x.sub(ak, 'array_list', {
        'xs.n': '_keyOnParameterList', count: String(numBindings),
      });
      // Reconstruct key indices from the stored keyTuple.
      for (let bi = 0; bi < numBindings; bi++) {
        const keyVal = tuple[bi];
        const keyIndex = bindings[bi].keys.indexOf(keyVal);
        const kon = x.sub(kop, 'KeyOnParameter');
        x.subRef(kon, 'KeyformBindingSource', kfbs[bi].pidKfb, { 'xs.n': 'binding' });
        x.sub(kon, 'i', { 'xs.n': 'keyIndex' }).text = String(keyIndex >= 0 ? keyIndex : 0);
      }
      x.subRef(kog, 'CFormGuid', pidForm, { 'xs.n': 'keyformGuid' });
    }
    const kfbList = x.sub(kfg, 'array_list', {
      'xs.n': 'keyformBindings', count: String(numBindings),
    });
    for (const kfb of kfbs) {
      x.subRef(kfbList, 'KeyformBindingSource', kfb.pidKfb);
      emitKfBinding(x, kfb.kfb, pidKfg, kfb.pid, kfb.keys.map((k) => k + '.0'), kfb.desc);
    }

    const [, pidFollowGuid] = x.shared('CDeformerGuid', { uuid: uuid(), note: spec.id });
    meshWarpDeformerGuids.set(spec.targetPartId, pidFollowGuid);
    rigWarpBbox.set(spec.targetPartId, {
      gridMinX: spec.canvasBbox.minX,
      gridMinY: spec.canvasBbox.minY,
      gridW: spec.canvasBbox.W,
      gridH: spec.canvasBbox.H,
    });

    emitStructuralWarp(
      x,
      { allDeformerSources, pidPartGuid: ctx.pidPartGuid, rootPart },
      spec.name, spec.id, spec.gridSize.cols, spec.gridSize.rows,
      pidFollowGuid, pidDeformerRoot, pidKfg, pidCoord,
      formGuids, spec.keyforms.map((kf) => kf.positions),
    );

    // Stay at ROOT. Section 3d reparent would hang this under BodyX.
    rigCollector.warpDeformers.push(spec);
  }
}
