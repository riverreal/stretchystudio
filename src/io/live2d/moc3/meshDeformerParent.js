// @ts-check

/**
 * Mesh → parent_deformer_index assignment for the .moc3 generator.
 *
 * Lifted out of moc3writer.js (Phase 6 god-class breakup, sweep #39).
 *
 * `art_mesh.parent_deformer_indices` references the umbrella `deformer.*`
 * array (post-topo-sort), NOT the natural `warpSpecs` order. Using the
 * wrong index pointed meshes at the wrong deformer entirely (severe
 * misrendering: arms swapped, body collapsed). Resolution cascade:
 *
 *   1. **Per-mesh rig warp** — mesh has its own `RigWarp_*` with a
 *      `canvasBbox` (needed to encode verts in that warp's 0..1 frame)
 *      → parent to it.
 *   2. **Bone-baked mesh** — bone's parent group's rotation deformer
 *      (matches cmo3's `dfOwner = boneGroup.parent`). Only when that
 *      GroupRotation actually exists in `rotationSpecs`.
 *   3. **Group rotation** — mesh's own group's rotation deformer when
 *      one exists.
 *   4. **Rigid-follow extra** (armature on, every lattice off) with no
 *      dedicated `RigidFollow_*` warp → parent **-1** (root). Do **not**
 *      fall through to BodyX — that is the Unity FFD-squash bug.
 *   5. **Deepest body warp** (BodyXWarp / Breath / BodyWarpY/Z).
 *
 * Vertex keyform positions MUST use this same cascade. Encoding a
 * bone-weighted mesh as pivot-relative canvas-px while parenting it
 * to BodyXWarp (0..1) is what made Unity Cubism SDK swing legs ~90°
 * at rest: Cubism's RotationDeformer Setup probes the parent warp at
 * a canvas-px origin, gets a garbage Jacobian, and bakes that angle
 * into the rest pose. The editor never hits that path because it
 * applies bone LBS after the deformer chain.
 *
 * `art_mesh.parent_part_indices` is a separate concern: the drawing-tree
 * (visibility / draw-order organisation) hierarchy stays at the mesh's
 * group/root part regardless of any deformer chain. cmo3 emits
 * `meshSrc.parentGuid` the same way.
 *
 * @module io/live2d/moc3/meshDeformerParent
 */

import { isRigidFollowExtra } from '../rig/rigidFollowExtra.js';

/**
 * @typedef {'rigWarp'|'rotation'|'bodyWarp'} MeshDeformerParentKind
 *
 * @typedef {Object} MeshDeformerParentRef
 * @property {MeshDeformerParentKind} kind
 * @property {number} deformerIndex
 *   Unified (topo-sorted) deformer index. `-1` when `kind === 'bodyWarp'`
 *   and there is no body-warp chain.
 * @property {object|null} rigWarp
 *   The warp spec when `kind === 'rigWarp'` (has `canvasBbox`).
 * @property {{x:number, y:number}|null} rotationPivot
 *   Canvas-px pivot of the GroupRotation parent when `kind === 'rotation'`.
 */

/**
 * Resolve which deformer a mesh should parent to, and the canvas-space
 * pivot if that parent is a rotation deformer.
 *
 * Shared by `buildMeshDeformerParents` (writes `parent_deformer_indices`)
 * and `emitKeyformAndDeformerSections` (encodes vertex keyforms into the
 * matching local frame). The two MUST agree — a frame/parent mismatch is
 * a silent Unity-only rest-pose rotation.
 *
 * @param {object} part
 * @param {{
 *   warpSpecs: Array<object>,
 *   rotationSpecs: Array<object>,
 *   deformerIdToIndex: Map<string, number>,
 *   meshDefaultDeformerIdx: number,
 *   groups: Array<object>,
 * }} ctx
 * @returns {MeshDeformerParentRef}
 */
export function resolveMeshDeformerParent(part, ctx) {
  const {
    warpSpecs, rotationSpecs, deformerIdToIndex, meshDefaultDeformerIdx, groups,
  } = ctx;

  // 1. Per-mesh rig warp. Require canvasBbox so vertex encoding can use
  //    the same 0..1 box Cubism will interpret as this warp's local frame.
  for (const w of warpSpecs) {
    if (w.targetPartId !== part.id || !w.canvasBbox) continue;
    const ui = deformerIdToIndex.get(w.id);
    if (ui == null) continue;
    return { kind: 'rigWarp', deformerIndex: ui, rigWarp: w, rotationPivot: null };
  }

  // groupId → { idx, pivot } for GroupRotation_* deformers that made it
  // into the unified deformer list.
  /** @type {Map<string, {idx: number, pivot: {x:number, y:number}}>} */
  const groupIdToRot = new Map();
  for (const r of rotationSpecs) {
    if (!r.id?.startsWith('GroupRotation_')) continue;
    const gid = r.id.substring('GroupRotation_'.length);
    const ui = deformerIdToIndex.get(r.id);
    if (ui == null) continue;
    const g = groups.find((x) => x.id === gid);
    groupIdToRot.set(gid, {
      idx: ui,
      pivot: {
        x: g?.transform?.pivotX ?? 0,
        y: g?.transform?.pivotY ?? 0,
      },
    });
  }

  // 2. Bone-baked → bone's parent group's rotation, only if that
  //    GroupRotation actually exists. Leg bones parent to `root`, and
  //    root never gets a GroupRotation (bones with ParamRotation_* skip
  //    rotation-deformer emission) — previously we still subtracted
  //    root's canvas pivot and then parented the mesh to BodyXWarp.
  const jointBoneId = part.mesh?.jointBoneId;
  if (jointBoneId && part.mesh?.boneWeights) {
    const boneGroup = groups.find((g) => g.id === jointBoneId);
    const armGroupId = boneGroup?.parent;
    if (armGroupId && groupIdToRot.has(armGroupId)) {
      const hit = /** @type {{idx: number, pivot: {x:number, y:number}}} */ (
        groupIdToRot.get(armGroupId)
      );
      return {
        kind: 'rotation',
        deformerIndex: hit.idx,
        rigWarp: null,
        rotationPivot: hit.pivot,
      };
    }
  }

  // 3. Mesh's own group rotation.
  if (part.parent && groupIdToRot.has(part.parent)) {
    const hit = /** @type {{idx: number, pivot: {x:number, y:number}}} */ (
      groupIdToRot.get(part.parent)
    );
    return {
      kind: 'rotation',
      deformerIndex: hit.idx,
      rigWarp: null,
      rotationPivot: hit.pivot,
    };
  }

  // 4. Rigid-follow extra without a dedicated warp: stay at root.
  //    BodyX FFD is exactly what the editor's disabled lattices avoid.
  if (isRigidFollowExtra(part)) {
    return {
      kind: 'bodyWarp',
      deformerIndex: -1,
      rigWarp: null,
      rotationPivot: null,
    };
  }

  // 5. Deepest body warp (or -1 when the rig has no chain).
  return {
    kind: 'bodyWarp',
    deformerIndex: meshDefaultDeformerIdx,
    rigWarp: null,
    rotationPivot: null,
  };
}

/**
 * Encode one canvas-px vertex into the parent deformer's local frame.
 *
 * @param {number} x
 * @param {number} y
 * @param {MeshDeformerParentRef} resolved
 * @param {{
 *   rigSpec: object|null,
 *   canvasW: number,
 *   canvasH: number,
 * }} ctx
 * @returns {[number, number]}
 */
export function encodeVertexInParentFrame(x, y, resolved, ctx) {
  const { rigSpec, canvasW, canvasH } = ctx;
  if (resolved.kind === 'rigWarp' && resolved.rigWarp?.canvasBbox) {
    const bb = resolved.rigWarp.canvasBbox;
    return [(x - bb.minX) / bb.W, (y - bb.minY) / bb.H];
  }
  if (resolved.kind === 'rotation' && resolved.rotationPivot) {
    return [x - resolved.rotationPivot.x, y - resolved.rotationPivot.y];
  }
  if (rigSpec?.canvasToInnermostX && resolved.deformerIndex >= 0) {
    return [rigSpec.canvasToInnermostX(x), rigSpec.canvasToInnermostY(y)];
  }
  const ppu = Math.max(canvasW, canvasH);
  return [(x - canvasW / 2) / ppu, (y - canvasH / 2) / ppu];
}

/**
 * @param {Object} opts
 * @returns {{
 *   parentDeformerIndices: number[],
 *   parentPartIndices: number[],
 * } | null}
 *   `null` when the rig has no body warp chain (no reparenting needed).
 */
export function buildMeshDeformerParents(opts) {
  const {
    meshParts, groups,
    warpSpecs, rotationSpecs,
    deformerIdToIndex, meshDefaultDeformerIdx,
    partIdMap,
  } = opts;

  if (meshDefaultDeformerIdx < 0) return null;

  const parentDeformerIndices = meshParts.map((p) =>
    resolveMeshDeformerParent(p, {
      warpSpecs, rotationSpecs, deformerIdToIndex, meshDefaultDeformerIdx, groups,
    }).deformerIndex);

  const parentPartIndices = meshParts.map((p) => {
    if (p.parent && partIdMap.has(p.parent)) return partIdMap.get(p.parent);
    return 0;
  });

  return { parentDeformerIndices, parentPartIndices };
}
