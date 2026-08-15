// @ts-check

/**
 * v53 — recover `project.springChains[]` from authored spring
 * physics modifiers. v52 seeded the array; `projectStore.loadProject`
 * never copied it back, so a save-after-load persisted `[]` while
 * the mesh still had the joints.
 *
 * @param {*} project
 */
import { recoverSpringChains } from '../../io/live2d/rig/springChain.js';

export function migrateRecoverSpringChains(project) {
  if (!project || typeof project !== 'object') return project;
  recoverSpringChains(project);
  return project;
}
