// Tests for src/io/live2d/rig/springChain.js
//
// Run: node scripts/test/test_springChain.mjs

import { strict as assert } from 'node:assert';
import {
  PARAM_WIND_ID,
  addSpringChain,
  buildSpringChainPhysicsRule,
  canAddSpringChain,
  cartesianKeyTuples,
  findSpringChain,
  removeSpringChain,
  reseedSpringChains,
  resolveSpringAxis,
  resolveWarpGridDims,
  springBandWeight,
  springChainRuleId,
  springChainShift,
  springJointParamId,
} from '../../src/io/live2d/rig/springChain.js';
import { gatherPhysicsRules } from '../../src/io/live2d/rig/physicsConfig.js';
import { buildMotion3 } from '../../src/io/live2d/idle/builder.js';
import { IDLE_PARAMS } from '../../src/io/live2d/idle/paramDefaults.js';
import {
  bakeTargetLabel,
  groupPhysicsBakeTargets,
  listPhysicsBakeTargets,
} from '../../src/v3/operators/bakePhysics.js';
import { migrateProject, CURRENT_SCHEMA_VERSION } from '../../src/store/projectMigrations.js';

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
    nodes: [
      {
        id: 'part_hair',
        type: 'part',
        name: 'back hair',
        mesh: { vertices: [0, 0, 10, 0, 0, 20], triangles: [0, 1, 2] },
        modifiers: [{
          type: 'physicsModifier',
          ruleId: 'PhysicsSetting2',
          name: 'Hair Back',
          category: 'hair',
          inputs: [],
          vertices: [{ x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 }, { x: 0, y: 15, mobility: 0.9, delay: 0.8, acceleration: 1.5, radius: 15 }],
          normalization: {},
          output: { paramId: 'ParamHairBack', vertexIndex: 1, scale: 2, isReverse: false },
          enabled: true,
          mode: 7,
        }],
      },
      {
        id: 'warp_hair',
        type: 'deformer',
        deformerKind: 'warp',
        targetPartId: 'part_hair',
        gridSize: { cols: 2, rows: 3 },
        baseGrid,
        bindings: [{ parameterId: 'ParamHairBack', keys: [-1, 0, 1], interpolation: 'LINEAR' }],
        keyforms: [],
      },
    ],
    parameters: [
      { id: 'ParamHairBack', name: 'Hair Back', min: -1, max: 1, default: 0 },
      { id: 'ParamAngleX', name: 'Angle X', min: -30, max: 30, default: 0 },
    ],
    springChains: [],
  };
}

expect('springBandWeight pins the root', () => {
  assert.equal(springBandWeight(0, 0, 3), 0);
  assert.equal(springBandWeight(0, 2, 3), 0);
});

expect('springBandWeight last joint peaks near the tip', () => {
  const tip0 = springBandWeight(1, 0, 3);
  const tip2 = springBandWeight(1, 2, 3);
  assert.ok(tip2 > tip0, `tip joint should outweigh root joint at frac=1 (${tip2} vs ${tip0})`);
});

expect('springChainShift is identity at rest keys', () => {
  const grid = new Float64Array([0, 0, 1, 0, 0, 1, 1, 1]);
  const out = springChainShift(grid, 2, 2, [0, 0], 1, 1);
  assert.deepEqual(Array.from(out), Array.from(grid));
});

function makeGrid(gW, gH) {
  const grid = new Float64Array(gW * gH * 2);
  for (let r = 0; r < gH; r++) {
    for (let c = 0; c < gW; c++) {
      grid[(r * gW + c) * 2] = c;
      grid[(r * gW + c) * 2 + 1] = r;
    }
  }
  return grid;
}

expect('springChainShift moves the tip more than the root', () => {
  const gW = 2;
  const gH = 4;
  const grid = makeGrid(gW, gH);
  const out = springChainShift(grid, gW, gH, [0, 0, 1], 2, 4, { xSway: 0.2, yCurl: 0.05 });
  const rootDx = Math.abs(out[0] - grid[0]);
  const tipIdx = ((gH - 1) * gW) * 2;
  const tipDx = Math.abs(out[tipIdx] - grid[tipIdx]);
  assert.ok(rootDx < 1e-9, `root should stay pinned, dx=${rootDx}`);
  assert.ok(tipDx > 0.01, `tip should move, dx=${tipDx}`);
});

expect('resolveSpringAxis Auto follows the long bbox side', () => {
  assert.equal(resolveSpringAxis('auto', 2, 8), 'topDown');
  assert.equal(resolveSpringAxis('auto', 8, 2), 'leftRight');
  assert.equal(resolveSpringAxis('downTop', 8, 2), 'downTop');
});

expect('springChainShift axis override pins the chosen edge', () => {
  const gW = 4;
  const gH = 3;
  const grid = makeGrid(gW, gH);
  const mag = { xSway: 0.2, yCurl: 0.05, axis: 'leftRight' };
  const out = springChainShift(grid, gW, gH, [0, 0, 1], 6, 2, mag);
  const leftIdx = 0;
  const rightIdx = (gW - 1) * 2;
  assert.ok(Math.abs(out[leftIdx] - grid[leftIdx]) < 1e-9, 'leftRight pins column 0');
  assert.ok(Math.abs(out[rightIdx] - grid[rightIdx]) > 0.01, 'leftRight moves last column');

  const flip = springChainShift(grid, gW, gH, [0, 0, 1], 6, 2, { ...mag, axis: 'rightLeft' });
  assert.ok(Math.abs(flip[rightIdx] - grid[rightIdx]) < 1e-9, 'rightLeft pins last column');
  assert.ok(Math.abs(flip[leftIdx] - grid[leftIdx]) > 0.01, 'rightLeft moves column 0');

  const down = springChainShift(grid, gW, gH, [0, 0, 1], 6, 2, { ...mag, axis: 'topDown' });
  const topIdx = 0;
  const botIdx = ((gH - 1) * gW) * 2;
  assert.ok(Math.abs(down[topIdx] - grid[topIdx]) < 1e-9, 'topDown pins row 0');
  assert.ok(Math.abs(down[botIdx] - grid[botIdx]) > 0.01, 'topDown moves last row');

  const up = springChainShift(grid, gW, gH, [0, 0, 1], 6, 2, { ...mag, axis: 'downTop' });
  assert.ok(Math.abs(up[botIdx] - grid[botIdx]) < 1e-9, 'downTop pins last row');
  assert.ok(Math.abs(up[topIdx] - grid[topIdx]) > 0.01, 'downTop moves row 0');
});

expect('cartesianKeyTuples is 3^N with binding[0] fastest', () => {
  const tuples = cartesianKeyTuples([
    { keys: [-1, 0, 1] },
    { keys: [-1, 0, 1] },
  ]);
  assert.equal(tuples.length, 9);
  assert.deepEqual(tuples[0], [-1, -1]);
  assert.deepEqual(tuples[1], [0, -1]);
  assert.deepEqual(tuples[2], [1, -1]);
});

expect('resolveWarpGridDims treats gridSize as cells', () => {
  const rest = new Float64Array(3 * 4 * 2);
  const dims = resolveWarpGridDims({ gridSize: { cols: 2, rows: 3 } }, rest);
  assert.deepEqual(dims, { gW: 3, gH: 4 });
});

expect('canAddSpringChain requires a warp', () => {
  const p = { nodes: [{ id: 'p', type: 'part', mesh: { vertices: [0, 0, 1, 0, 0, 1] } }], springChains: [] };
  const gate = canAddSpringChain(p, 'p');
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /Init Rig/);
});

expect('addSpringChain writes params, warp bands, physics, and the record', () => {
  const project = makeHairProject();
  const result = addSpringChain(project, 'part_hair', { jointCount: 3 });
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  assert.equal(result.chain.jointCount, 3);
  assert.equal(result.chain.paramIds.length, 3);
  assert.ok(project.parameters.some((p) => p.id === PARAM_WIND_ID), 'ParamWind created');
  for (let i = 0; i < 3; i++) {
    assert.ok(project.parameters.some((p) => p.id === springJointParamId('part_hair', i)));
  }
  const warp = project.nodes.find((n) => n.id === 'warp_hair');
  assert.equal(warp.bindings.length, 3);
  assert.equal(warp.keyforms.length, 27);
  assert.equal(warp._userAuthored, true);
  assert.equal(result.chain.axis, 'auto');
  for (const kf of warp.keyforms) {
    assert.ok(Array.isArray(kf.positions), 'keyform positions must be a plain Array (KEYFORM_EVAL skips TypedArrays)');
  }
  const restKf = warp.keyforms.find((k) => (k.keyTuple ?? []).every((v) => v === 0));
  assert.ok(restKf, 'rest (0,0,0) keyform exists');
  assert.deepEqual(restKf.positions, Array.from(project.nodes[1].baseGrid));
  const hairPhys = project.nodes[0].modifiers.find((m) => m.ruleId === 'PhysicsSetting2');
  assert.equal(hairPhys.enabled, false, 'default hair physics disabled');
  const springMods = project.nodes[0].modifiers.filter((m) => m.ruleId === springChainRuleId('part_hair'));
  assert.equal(springMods.length, 3);
  assert.ok(springMods.every((m) => m._userAuthored === true));
  const rules = gatherPhysicsRules(project);
  const spring = rules.find((r) => r.id === springChainRuleId('part_hair'));
  assert.ok(spring, 'gathered spring rule');
  assert.equal(spring.outputs.length, 3);
  assert.ok(spring.inputs.some((i) => i.paramId === PARAM_WIND_ID));
});

expect('buildSpringChainPhysicsRule has N+1 vertices and wind input', () => {
  const rule = buildSpringChainPhysicsRule('p', ['a', 'b'], { tag: 'back hair' });
  assert.equal(rule.vertices.length, 3);
  assert.equal(rule.outputs[1].vertexIndex, 2);
  assert.equal(rule.inputs[0].paramId, PARAM_WIND_ID);
});

expect('removeSpringChain restores the tag warp and default physics', () => {
  const project = makeHairProject();
  addSpringChain(project, 'part_hair', { jointCount: 3 });
  const removed = removeSpringChain(project, 'part_hair');
  assert.equal(removed.ok, true);
  assert.equal(findSpringChain(project, 'part_hair'), null);
  assert.ok(!project.parameters.some((p) => p.id.startsWith('ParamSpring_')));
  const warp = project.nodes.find((n) => n.id === 'warp_hair');
  assert.equal(warp.bindings[0].parameterId, 'ParamHairBack');
  const hairPhys = project.nodes[0].modifiers.find((m) => m.ruleId === 'PhysicsSetting2');
  assert.equal(hairPhys.enabled, true);
  assert.equal(
    project.nodes[0].modifiers.filter((m) => m.ruleId === springChainRuleId('part_hair')).length,
    0,
  );
});

expect('reseedSpringChains rebuilds after a wipe', () => {
  const project = makeHairProject();
  addSpringChain(project, 'part_hair', { jointCount: 2, axis: 'topDown' });
  project.nodes[0].modifiers = project.nodes[0].modifiers.filter((m) => m.type !== 'physicsModifier');
  const n = reseedSpringChains(project);
  assert.equal(n, 1);
  const rules = gatherPhysicsRules(project);
  assert.ok(rules.some((r) => r.id === springChainRuleId('part_hair')));
  assert.equal(findSpringChain(project, 'part_hair')?.jointCount, 2);
  assert.equal(findSpringChain(project, 'part_hair')?.axis, 'topDown');
});

expect('idle gen keys ParamWind and skips spring outputs', () => {
  assert.ok(IDLE_PARAMS.ParamWind, 'ParamWind in idle table');
  const joint = springJointParamId('part_hair', 0);
  const result = buildMotion3({
    preset: 'idle',
    paramIds: ['ParamAngleX', PARAM_WIND_ID, joint],
    physicsOutputIds: new Set([joint]),
    durationSec: 8,
    fps: 30,
    personality: 'calm',
    seed: 1,
  });
  assert.ok(result.animatedIds.includes(PARAM_WIND_ID), 'ParamWind animated');
  assert.ok(!result.animatedIds.includes(joint), 'joint param skipped');
  assert.ok(result.skipped.some((s) => s.id === joint && s.reason === 'physics-output'));
});

expect('bakeTargetLabel names spring joints', () => {
  assert.equal(bakeTargetLabel('ParamSpring_part_hair_0'), 'Spring 1');
  assert.equal(bakeTargetLabel('ParamSpring_part_hair_0', 'Spring Chain', 'back hair'), 'back hair · Spring 1');
  assert.equal(bakeTargetLabel('ParamHairBack'), 'Hair Back');
});

expect('listPhysicsBakeTargets groups springs by part name', () => {
  const project = makeHairProject();
  addSpringChain(project, 'part_hair', { jointCount: 2 });
  project.nodes.push({
    id: 'part_strap',
    type: 'part',
    name: 'neckwear',
    mesh: { vertices: [0, 0, 10, 0, 0, 20], triangles: [0, 1, 2] },
  });
  project.nodes.push({
    id: 'warp_strap',
    type: 'deformer',
    deformerKind: 'warp',
    targetPartId: 'part_strap',
    gridSize: { cols: 2, rows: 3 },
    baseGrid: project.nodes[1].baseGrid,
    bindings: [],
    keyforms: [],
  });
  addSpringChain(project, 'part_strap', { jointCount: 2 });
  const targets = listPhysicsBakeTargets(project);
  const groups = groupPhysicsBakeTargets(targets);
  const springGroups = groups.filter((g) => g.kind === 'spring');
  assert.equal(springGroups.length, 2);
  const labels = springGroups.map((g) => g.label).sort();
  assert.deepEqual(labels, ['back hair', 'neckwear']);
  for (const g of springGroups) {
    assert.ok(g.items.every((t) => t.label.startsWith('Spring ')));
  }
});

expect('v52 migration seeds springChains and bumps schema', () => {
  const project = { schemaVersion: 51, nodes: [], parameters: [] };
  migrateProject(project);
  assert.equal(project.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.ok(Array.isArray(project.springChains));
  assert.equal(project.springChains.length, 0);
});

console.log(`springChain: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
