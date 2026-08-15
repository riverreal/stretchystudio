// Tests for src/io/live2d/moc3/meshDeformerParent.js
//
// Unity Cubism SDK rest-pose regression: bone-weighted leg meshes
// (jointBoneId set, parent bone = root which has NO GroupRotation)
// were encoded as canvas-px offsets from the root pivot, then parented
// to BodyXWarp (0..1). Cubism's RotationDeformer Setup probed the warp
// at a canvas-px origin and baked a ~90° rest rotation. Stretchy Studio
// never showed it because bone LBS runs after the deformer chain.
//
// Run: node scripts/test/test_meshDeformerParent.mjs

import {
  resolveMeshDeformerParent,
  encodeVertexInParentFrame,
  buildMeshDeformerParents,
} from '../../src/io/live2d/moc3/meshDeformerParent.js';
import { emitKeyformAndDeformerSections } from '../../src/io/live2d/moc3/keyformAndDeformerSections.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`FAIL: ${name}`);
}

function assertEq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++;
  console.error(`FAIL: ${name}`);
  console.error(`  expected: ${e}`);
  console.error(`  actual:   ${a}`);
}

function assertClose(actual, expected, name, eps = 1e-6) {
  if (Math.abs(actual - expected) <= eps) { passed++; return; }
  failed++;
  console.error(`FAIL: ${name}`);
  console.error(`  expected: ${expected}`);
  console.error(`  actual:   ${actual}`);
}

const canvasW = 1000;
const canvasH = 1000;
const innermostX = (x) => x / canvasW;
const innermostY = (y) => y / canvasH;

const bodyWarp = {
  id: 'BodyXWarp',
  parent: { type: 'root', id: null },
  gridSize: { rows: 1, cols: 1 },
  keyforms: [{ positions: [0, 0, 1, 0, 0, 1, 1, 1], opacity: 1 }],
  localFrame: 'normalized-0to1',
  isVisible: true,
};

const deformerIdToIndex = new Map([['BodyXWarp', 0]]);

function baseCtx(overrides = {}) {
  return {
    warpSpecs: [bodyWarp],
    rotationSpecs: [],
    deformerIdToIndex,
    meshDefaultDeformerIdx: 0,
    groups: [
      { id: 'root', name: 'root', parent: null, boneRole: 'root',
        transform: { pivotX: 500, pivotY: 400, rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 } },
      { id: 'leftLeg', name: 'leftLeg', parent: 'root', boneRole: 'leftLeg',
        transform: { pivotX: 480, pivotY: 500, rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 } },
    ],
    ...overrides,
  };
}

const legPart = {
  id: 'legwear-l',
  name: 'legs',
  parent: 'leftLeg',
  mesh: {
    vertices: [{ x: 520, y: 800 }],
    boneWeights: [1],
    jointBoneId: 'leftLeg',
  },
};

// ── 1. Untagged bone-weighted leg, parent bone = root, no GroupRotation ──
// Must parent to BodyXWarp and encode in innermost 0..1, NOT (vert - rootPivot).

{
  const ctx = baseCtx();
  const resolved = resolveMeshDeformerParent(legPart, ctx);
  assertEq(resolved.kind, 'bodyWarp', 'leg: kind is bodyWarp (no GroupRotation_root)');
  assertEq(resolved.deformerIndex, 0, 'leg: parent index is BodyXWarp');
  assert(resolved.rotationPivot === null, 'leg: no rotation pivot');

  const [lx, ly] = encodeVertexInParentFrame(520, 800, resolved, {
    rigSpec: { canvasToInnermostX: innermostX, canvasToInnermostY: innermostY },
    canvasW, canvasH,
  });
  assertClose(lx, 0.52, 'leg: x is innermost (520/1000), not pivot-relative 20');
  assertClose(ly, 0.80, 'leg: y is innermost (800/1000), not pivot-relative 400');

  // The pre-fix encoding would have been (520-500, 800-400) = (20, 400).
  assert(Math.abs(lx - 20) > 1, 'leg: must NOT be canvas-px offset from root pivot X');
  assert(Math.abs(ly - 400) > 1, 'leg: must NOT be canvas-px offset from root pivot Y');
}

// ── 2. Bone-weighted mesh whose parent group HAS a GroupRotation ──

{
  const armRot = {
    id: 'GroupRotation_leftArm',
    parent: { type: 'warp', id: 'BodyXWarp' },
    keyforms: [{ angle: 0, originX: 0.2, originY: 0.3 }],
    baseAngle: 0,
  };
  const ctx = baseCtx({
    rotationSpecs: [armRot],
    deformerIdToIndex: new Map([['BodyXWarp', 0], ['GroupRotation_leftArm', 1]]),
    groups: [
      { id: 'leftArm', name: 'leftArm', parent: 'root', boneRole: 'leftArm',
        transform: { pivotX: 200, pivotY: 300, rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 } },
      { id: 'leftElbow', name: 'leftElbow', parent: 'leftArm', boneRole: 'leftElbow',
        transform: { pivotX: 250, pivotY: 400, rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 } },
    ],
  });
  const hand = {
    id: 'handwear-l',
    parent: 'leftElbow',
    mesh: {
      vertices: [{ x: 260, y: 450 }],
      boneWeights: [1],
      jointBoneId: 'leftElbow',
    },
  };
  const resolved = resolveMeshDeformerParent(hand, ctx);
  assertEq(resolved.kind, 'rotation', 'arm: kind is rotation (parent group has GroupRotation)');
  assertEq(resolved.deformerIndex, 1, 'arm: parent index is GroupRotation_leftArm');
  assertEq(resolved.rotationPivot, { x: 200, y: 300 }, 'arm: pivot is the PARENT bone (leftArm), not elbow');

  const [lx, ly] = encodeVertexInParentFrame(260, 450, resolved, {
    rigSpec: { canvasToInnermostX: innermostX, canvasToInnermostY: innermostY },
    canvasW, canvasH,
  });
  assertClose(lx, 60, 'arm: x is canvas-px offset from leftArm pivot');
  assertClose(ly, 150, 'arm: y is canvas-px offset from leftArm pivot');
}

// ── 3. Per-mesh rig warp wins over bone-weighted rotation ──

{
  const rigWarp = {
    id: 'RigWarp_legwear-l',
    targetPartId: 'legwear-l',
    canvasBbox: { minX: 400, minY: 600, W: 200, H: 300 },
    parent: { type: 'warp', id: 'BodyXWarp' },
    gridSize: { rows: 1, cols: 1 },
    keyforms: [{ positions: [0, 0, 1, 0, 0, 1, 1, 1], opacity: 1 }],
    localFrame: 'normalized-0to1',
  };
  const ctx = baseCtx({
    warpSpecs: [bodyWarp, rigWarp],
    deformerIdToIndex: new Map([['BodyXWarp', 0], ['RigWarp_legwear-l', 1]]),
  });
  const resolved = resolveMeshDeformerParent(legPart, ctx);
  assertEq(resolved.kind, 'rigWarp', 'rigWarp: kind is rigWarp');
  assertEq(resolved.deformerIndex, 1, 'rigWarp: parent index is the per-mesh warp');

  const [lx, ly] = encodeVertexInParentFrame(520, 800, resolved, {
    rigSpec: { canvasToInnermostX: innermostX, canvasToInnermostY: innermostY },
    canvasW, canvasH,
  });
  assertClose(lx, (520 - 400) / 200, 'rigWarp: x is 0..1 of canvasBbox');
  assertClose(ly, (800 - 600) / 300, 'rigWarp: y is 0..1 of canvasBbox');
}

// ── 4. buildMeshDeformerParents agrees with resolveMeshDeformerParent ──

{
  const ctx = baseCtx();
  const reparent = buildMeshDeformerParents({
    meshParts: [legPart],
    groups: ctx.groups,
    warpSpecs: ctx.warpSpecs,
    rotationSpecs: ctx.rotationSpecs,
    deformerIdToIndex: ctx.deformerIdToIndex,
    meshDefaultDeformerIdx: 0,
    partIdMap: new Map([['leftLeg', 1]]),
  });
  assert(reparent !== null, 'reparent: returns a result when body warp exists');
  assertEq(reparent.parentDeformerIndices, [0], 'reparent: leg → BodyXWarp');
  assertEq(reparent.parentPartIndices, [1], 'reparent: part index follows group parent');
}

// ── 5. emitKeyform rest verts for the Unity-leg case are innermost, not pivot-relative ──

{
  const ctx = baseCtx();
  const kfd = emitKeyformAndDeformerSections({
    meshParts: [legPart],
    meshBindingPlan: [{
      paramId: 'ParamOpacity',
      keys: [1],
      keyformOpacities: [1],
      perVertexPositions: null,
    }],
    meshInfos: [{
      renderVertCount: 1,
      flatIndexCount: 0,
      uvBeginIndex: 0,
      positionIndexBeginIndex: 0,
      keyformPositionBeginIndex: 0,
    }],
    rigSpec: { canvasToInnermostX: innermostX, canvasToInnermostY: innermostY },
    warpSpecs: ctx.warpSpecs,
    rotationSpecs: ctx.rotationSpecs,
    allDeformerSpecs: [bodyWarp],
    allDeformerKinds: ['warp'],
    allDeformerSrcIndices: [0],
    deformerIdToIndex: ctx.deformerIdToIndex,
    deformerBandIndex: [0],
    meshDefaultDeformerIdx: 0,
    groups: ctx.groups,
    canvasW, canvasH,
  });
  assertClose(kfd.allKeyformPositions[0], 0.52, 'emit: rest x is innermost 0.52');
  assertClose(kfd.allKeyformPositions[1], 0.80, 'emit: rest y is innermost 0.80');
}

// ── 6. Rig warp without canvasBbox does not steal parenting ──

{
  const incomplete = {
    id: 'RigWarp_orphan',
    targetPartId: 'legwear-l',
    // no canvasBbox
    parent: { type: 'warp', id: 'BodyXWarp' },
    gridSize: { rows: 1, cols: 1 },
    keyforms: [{ positions: [0, 0, 1, 0, 0, 1, 1, 1], opacity: 1 }],
  };
  const ctx = baseCtx({
    warpSpecs: [bodyWarp, incomplete],
    deformerIdToIndex: new Map([['BodyXWarp', 0], ['RigWarp_orphan', 1]]),
  });
  const resolved = resolveMeshDeformerParent(legPart, ctx);
  assertEq(resolved.kind, 'bodyWarp', 'incomplete rigWarp: fall through to BodyXWarp');
  assertEq(resolved.deformerIndex, 0, 'incomplete rigWarp: parent stays BodyXWarp');
}

// ── 7. Rigid-follow extra without a dedicated warp must NOT parent to BodyX ──

{
  const extra = {
    id: 'objects',
    name: 'objects',
    parent: 'torso',
    modifiers: [
      { type: 'armature', enabled: true },
      { type: 'lattice', enabled: false },
    ],
    mesh: { vertices: [{ x: 100, y: 200 }] },
  };
  const ctx = baseCtx();
  const resolved = resolveMeshDeformerParent(extra, ctx);
  assertEq(resolved.kind, 'bodyWarp', 'rigid extra (no warp): kind stays bodyWarp sentinel');
  assertEq(resolved.deformerIndex, -1, 'rigid extra (no warp): parent is root, not BodyX');
}

// ── 8. Rigid-follow extra with RigidFollow_* warp parents to that warp ──

{
  const follow = {
    id: 'RigidFollow_objects',
    targetPartId: 'objects',
    canvasBbox: { minX: 80, minY: 180, W: 40, H: 40 },
    parent: { type: 'root', id: null },
    gridSize: { rows: 1, cols: 1 },
    keyforms: [{ positions: [80, 180, 120, 180, 80, 220, 120, 220], opacity: 1 }],
    localFrame: 'canvas-px',
    rigidFollow: true,
  };
  const extra = {
    id: 'objects',
    name: 'objects',
    modifiers: [
      { type: 'armature', enabled: true },
      { type: 'lattice', enabled: false },
    ],
    mesh: { vertices: [{ x: 100, y: 200 }] },
  };
  const ctx = baseCtx({
    warpSpecs: [bodyWarp, follow],
    deformerIdToIndex: new Map([['BodyXWarp', 0], ['RigidFollow_objects', 1]]),
  });
  const resolved = resolveMeshDeformerParent(extra, ctx);
  assertEq(resolved.kind, 'rigWarp', 'rigid extra + follow warp: kind is rigWarp');
  assertEq(resolved.deformerIndex, 1, 'rigid extra + follow warp: parent is RigidFollow_*');

  const [lx, ly] = encodeVertexInParentFrame(100, 200, resolved, {
    rigSpec: { canvasToInnermostX: innermostX, canvasToInnermostY: innermostY },
    canvasW, canvasH,
  });
  assertClose(lx, (100 - 80) / 40, 'rigid extra: x is 0..1 of follow canvasBbox');
  assertClose(ly, (200 - 180) / 40, 'rigid extra: y is 0..1 of follow canvasBbox');
}

console.log(`meshDeformerParent: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
