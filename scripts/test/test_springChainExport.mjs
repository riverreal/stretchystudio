// Spring-chain Cubism export — warp must bind ParamSpring_*, not the
// tag default (ParamHairBack / ParamSkirt / …).
//
// Bug: generateCmo3 / perPartRigWarps always rebound per-part warps to
// TAG_PARAM_BINDINGS. Bake Physics and physics3 animate ParamSpring_*
// (the sliders move in Cubism Viewer) but the mesh stays still because
// the warp keyforms are still on ParamHairBack.
//
// Run: node scripts/test/test_springChainExport.mjs

import { strict as assert } from 'node:assert';
import { generateCmo3 } from '../../src/io/live2d/cmo3writer.js';
import { resolveRigWarps } from '../../src/io/live2d/rig/rigWarpsStore.js';
import { addSpringChain, springJointParamId } from '../../src/io/live2d/rig/springChain.js';
import { resolveAuthoredWarpBindings } from '../../src/io/live2d/cmo3/perPartRigWarps.js';

let passed = 0;
let failed = 0;

function expect(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
  }
}

async function expectAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
  }
}

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function makeHairProject() {
  const gW = 3;
  const gH = 4;
  const baseGrid = new Float64Array(gW * gH * 2);
  for (let r = 0; r < gH; r++) {
    for (let c = 0; c < gW; c++) {
      const i = (r * gW + c) * 2;
      baseGrid[i] = c * 10;
      baseGrid[i + 1] = r * 20;
    }
  }
  return {
    canvas: { width: 800, height: 600 },
    nodes: [
      {
        id: 'part_hair',
        type: 'part',
        name: 'back hair',
        tag: 'back hair',
        mesh: {
          vertices: [100, 100, 200, 100, 200, 300, 100, 300],
          triangles: [0, 1, 2, 0, 2, 3],
          uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        },
        modifiers: [],
      },
      {
        id: 'warp_hair',
        type: 'deformer',
        deformerKind: 'warp',
        targetPartId: 'part_hair',
        gridSize: { cols: 2, rows: 3 },
        baseGrid,
        bindings: [{ parameterId: 'ParamHairBack', keys: [-1, 0, 1], interpolation: 'LINEAR' }],
        keyforms: [{
          keyTuple: [0],
          positions: Array.from(baseGrid),
          opacity: 1,
        }],
      },
    ],
    parameters: [
      { id: 'ParamHairBack', name: 'Hair Back', min: -1, max: 1, default: 0 },
      { id: 'ParamAngleX', name: 'Angle X', min: -30, max: 30, default: 0 },
      { id: 'ParamAngleZ', name: 'Angle Z', min: -30, max: 30, default: 0 },
      { id: 'ParamBodyAngleX', name: 'Body X', min: -10, max: 10, default: 0 },
      { id: 'ParamBodyAngleZ', name: 'Body Z', min: -10, max: 10, default: 0 },
    ],
    springChains: [],
  };
}

function toGeneratorInput(project, rigWarps) {
  const meshes = project.nodes.filter((n) => n.type === 'part').map((n) => ({
    partId: n.id,
    name: n.name,
    tag: n.tag,
    parentGroupId: n.parent,
    vertices: n.mesh.vertices,
    uvs: n.mesh.uvs,
    triangles: n.mesh.triangles,
    visible: true,
    pngData: PNG_1x1,
  }));
  return {
    canvasW: project.canvas.width,
    canvasH: project.canvas.height,
    meshes,
    groups: [],
    parameters: project.parameters ?? [],
    modelName: 'spring-export',
    generateRig: true,
    generatePhysics: false,
    rigOnly: true,
    rigWarps,
  };
}

expect('resolveAuthoredWarpBindings ignores non-authored warps', () => {
  const stored = {
    bindings: [{ parameterId: 'ParamSpring_x_0', keys: [-1, 0, 1] }],
  };
  assert.equal(resolveAuthoredWarpBindings(stored, [
    { id: 'ParamSpring_x_0', pid: 'pid-s0' },
  ]), null);
});

expect('resolveAuthoredWarpBindings maps spring params to pids', () => {
  const stored = {
    _userAuthored: true,
    bindings: [
      { parameterId: 'ParamSpring_x_0', keys: [-1, 0, 1] },
      { parameterId: 'ParamSpring_x_1', keys: [-1, 0, 1] },
    ],
  };
  const got = resolveAuthoredWarpBindings(stored, [
    { id: 'ParamSpring_x_0', pid: 'pid-s0' },
    { id: 'ParamSpring_x_1', pid: 'pid-s1' },
    { id: 'ParamHairBack', pid: 'pid-hair' },
  ]);
  assert.ok(got);
  assert.equal(got.bindings.length, 2);
  assert.deepEqual(got.bindings.map((b) => b.desc), ['ParamSpring_x_0', 'ParamSpring_x_1']);
  assert.deepEqual(got.bindings.map((b) => b.pid), ['pid-s0', 'pid-s1']);
  assert.equal(got.shiftFn, null);
});

expect('resolveAuthoredWarpBindings falls through when a param is missing', () => {
  const stored = {
    _userAuthored: true,
    bindings: [{ parameterId: 'ParamSpring_x_0', keys: [-1, 0, 1] }],
  };
  assert.equal(resolveAuthoredWarpBindings(stored, [
    { id: 'ParamHairBack', pid: 'pid-hair' },
  ]), null);
});

await expectAsync('generateCmo3 without a spring chain keeps the tag binding', async () => {
  const project = makeHairProject();
  const result = await generateCmo3(toGeneratorInput(project, resolveRigWarps(project)));
  const warp = result.rigSpec.warpDeformers.find((w) => w.targetPartId === 'part_hair');
  assert.ok(warp, 'back-hair rig warp emitted');
  assert.deepEqual(warp.bindings.map((b) => b.parameterId), ['ParamHairBack']);
  assert.equal(warp.keyforms.length, 3);
});

await expectAsync('generateCmo3 with a spring chain binds ParamSpring_* and keeps the 3^N keyforms', async () => {
  const project = makeHairProject();
  const added = addSpringChain(project, 'part_hair', { jointCount: 3 });
  assert.equal(added.ok, true, added.ok ? '' : added.reason);
  const result = await generateCmo3(toGeneratorInput(project, resolveRigWarps(project)));
  const warp = result.rigSpec.warpDeformers.find((w) => w.targetPartId === 'part_hair');
  assert.ok(warp, 'back-hair rig warp emitted');
  const expected = [0, 1, 2].map((i) => springJointParamId('part_hair', i));
  assert.deepEqual(warp.bindings.map((b) => b.parameterId), expected);
  assert.equal(warp.keyforms.length, 27, '3 joints × 3 keys');
  const rest = warp.keyforms.find((k) => (k.keyTuple ?? []).every((v) => v === 0));
  assert.ok(rest, 'rest keyform present');
  const swung = warp.keyforms.find((k) => (k.keyTuple ?? []).some((v) => v !== 0));
  assert.ok(swung, 'non-rest spring keyform present');
  let moved = false;
  for (let i = 0; i < rest.positions.length; i++) {
    if (rest.positions[i] !== swung.positions[i]) { moved = true; break; }
  }
  assert.ok(moved, 'stored spring keyforms are not all rest');
});

console.log(`springChainExport: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
