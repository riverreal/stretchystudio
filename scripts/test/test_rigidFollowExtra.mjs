// Tests for src/io/live2d/rig/rigidFollowExtra.js
//
// Export-side rigid follow: extras (armature on, lattices off) must not
// parent through BodyX. Specs are root-parented 1×1 warps whose keyforms
// are Kabsch R+T of the body cage.
//
// Run: node scripts/test/test_rigidFollowExtra.mjs

import {
  isRigidFollowExtra,
  isRigidFollowWarpSpec,
  findInnermostBodyWarpId,
  resolveBodyFollowBindings,
  cartesianKeyCombos,
  rigidTransformFromGrids,
  applyRigidToPairs,
  bboxFromVerts,
  restQuadFromBbox,
  buildRigidFollowWarpSpecs,
} from '../../src/io/live2d/rig/rigidFollowExtra.js';

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

// ── isRigidFollowExtra ────────────────────────────────────────────

assert(!isRigidFollowExtra(null), 'null part is not an extra');
assert(!isRigidFollowExtra({ modifiers: [] }), 'empty modifiers is not an extra');
assert(
  isRigidFollowExtra({
    modifiers: [{ type: 'armature', enabled: true }],
  }),
  'armature-only is an extra',
);
assert(
  isRigidFollowExtra({
    modifiers: [
      { type: 'armature', enabled: true },
      { type: 'lattice', enabled: false },
      { type: 'warp', enabled: false },
    ],
  }),
  'armature + all lattices off is an extra',
);
assert(
  !isRigidFollowExtra({
    modifiers: [
      { type: 'armature', enabled: true },
      { type: 'lattice', enabled: true },
    ],
  }),
  'enabled lattice is not an extra',
);
assert(
  !isRigidFollowExtra({
    modifiers: [{ type: 'lattice', enabled: false }],
  }),
  'lattices off without armature is not an extra',
);
assert(
  !isRigidFollowExtra({
    modifiers: [
      { type: 'armature', enabled: false },
      { type: 'lattice', enabled: false },
    ],
  }),
  'disabled armature is not an extra',
);

assert(isRigidFollowWarpSpec({ id: 'RigidFollow_objects' }), 'id prefix matches');
assert(isRigidFollowWarpSpec({ id: 'RigWarp_x', rigidFollow: true }), 'flag matches');
assert(!isRigidFollowWarpSpec({ id: 'RigWarp_skirt' }), 'plain rig warp is not follow');

// ── findInnermostBodyWarpId ───────────────────────────────────────

assertEq(
  findInnermostBodyWarpId({
    nodes: [
      { id: 'BodyWarpZ', type: 'deformer', deformerKind: 'warp' },
      { id: 'BodyXWarp', type: 'deformer', deformerKind: 'warp' },
    ],
  }),
  'BodyXWarp',
  'prefers BodyX over BodyZ',
);
assertEq(
  findInnermostBodyWarpId({
    nodes: [{ id: 'BodyWarpZ', type: 'deformer', deformerKind: 'warp' }],
  }),
  'BodyWarpZ',
  'falls back to BodyZ',
);
assertEq(findInnermostBodyWarpId({ nodes: [] }), null, 'empty project → null');

// ── bindings + cartesian ──────────────────────────────────────────

{
  const bindings = resolveBodyFollowBindings([
    { id: 'ParamBodyAngleX', pid: 'px' },
    { id: 'ParamBreath', pid: 'pb' },
    { id: 'ParamAngleX', pid: 'ignore' },
  ]);
  assertEq(bindings.map((b) => b.parameterId), ['ParamBodyAngleX', 'ParamBreath'],
    'only body-follow params with pids');
  const { valCombos } = cartesianKeyCombos(bindings);
  assertEq(valCombos.length, 6, '3×2 cartesian');
  // binding[0] (X) varies fastest
  assertEq(valCombos[0], [-10, 0], 'first combo: X=-10 Breath=0');
  assertEq(valCombos[1], [0, 0], 'second combo: X=0 Breath=0');
  assertEq(valCombos[2], [10, 0], 'third combo: X=10 Breath=0');
}

// ── Kabsch translation ────────────────────────────────────────────

{
  const rest = [0, 0, 10, 0, 0, 10, 10, 10];
  const live = rest.map((v, i) => (i % 2 === 0 ? v + 5 : v + 3));
  const xf = rigidTransformFromGrids(rest, live);
  assert(xf != null, 'translation fit succeeds');
  assertClose(xf.cos, 1, 'translation: no rotation (cos)');
  assertClose(xf.sin, 0, 'translation: no rotation (sin)');
  assertClose(xf.lx - xf.rx, 5, 'translation: dx=5');
  assertClose(xf.ly - xf.ry, 3, 'translation: dy=3');

  const moved = applyRigidToPairs([100, 200], xf);
  assertClose(moved[0], 105, 'apply: x +5');
  assertClose(moved[1], 203, 'apply: y +3');
}

// ── bbox + rest quad ──────────────────────────────────────────────

{
  const bb = bboxFromVerts([100, 100, 140, 100, 140, 140, 100, 140]);
  assert(bb != null, 'bbox from square verts');
  // 10% pad of 40px = 4
  assertClose(bb.minX, 96, 'bbox pad minX');
  assertClose(bb.W, 48, 'bbox pad W');
  const q = restQuadFromBbox(bb);
  assertEq([...q], [96, 96, 144, 96, 96, 144, 144, 144], 'rest quad TL TR BL BR');
}

// ── buildRigidFollowWarpSpecs (injected cage xforms) ──────────────

{
  const project = {
    nodes: [
      { id: 'BodyXWarp', type: 'deformer', deformerKind: 'warp' },
      {
        id: 'objects',
        type: 'part',
        name: 'objects',
        modifiers: [
          { type: 'armature', enabled: true },
          { type: 'lattice', enabled: false },
        ],
      },
      {
        id: 'skirt',
        type: 'part',
        name: 'skirt',
        modifiers: [
          { type: 'armature', enabled: true },
          { type: 'lattice', enabled: true },
        ],
      },
    ],
  };
  const meshes = [
    { partId: 'objects', name: 'objects', vertices: [100, 100, 140, 100, 140, 140, 100, 140] },
    { partId: 'skirt', name: 'skirt', vertices: [200, 200, 260, 200, 260, 400, 200, 400] },
  ];
  const paramDefs = [
    { id: 'ParamBodyAngleX', pid: 'px' },
    { id: 'ParamBreath', pid: 'pb' },
  ];
  const specs = buildRigidFollowWarpSpecs({
    project,
    meshes,
    paramDefs,
    sampleXforms: (_p, _id, dicts) => dicts.map((d) => ({
      rx: 0, ry: 0,
      lx: (d.ParamBodyAngleX ?? 0) * 2,
      ly: 0,
      cos: 1, sin: 0,
    })),
  });
  assertEq(specs.length, 1, 'only the extra gets a follow warp');
  const spec = specs[0];
  assertEq(spec.id, 'RigidFollow_objects', 'id prefix + partId');
  assertEq(spec.parent, { type: 'root', id: null }, 'parent is ROOT — not BodyX');
  assert(spec.rigidFollow === true, 'rigidFollow flag set');
  assertEq(spec.localFrame, 'canvas-px', 'root warp is canvas-px');
  assertEq(spec.gridSize, { rows: 1, cols: 1 }, '1×1 grid');
  assertEq(spec.targetPartId, 'objects', 'targetPartId for moc3 parenting');
  assertEq(spec.keyforms.length, 6, '3×2 body-param keyforms');

  // X=10, Breath=0 is combo index 2; translation lx=20
  const kf = spec.keyforms[2];
  assertEq(kf.keyTuple, [10, 0], 'combo[2] is X=10 Breath=0');
  assertClose(kf.positions[0], spec.baseGrid[0] + 20, 'keyform X=10 shifts rest quad +20');
  assertClose(kf.positions[1], spec.baseGrid[1], 'keyform Y unchanged');
}

{
  const specs = buildRigidFollowWarpSpecs({
    project: { nodes: [] },
    meshes: [],
    paramDefs: [{ id: 'ParamBodyAngleX', pid: 'px' }],
  });
  assertEq(specs, [], 'empty project → no specs');
}

console.log(`rigidFollowExtra: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
