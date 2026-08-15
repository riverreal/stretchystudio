// @ts-check

/**
 * v52 — seed `project.springChains` (manual multi-joint warp-band
 * secondary motion). Older saves have no field; runtime code treats
 * missing as []. This migration writes the empty array so save/load
 * round-trips a stable key.
 *
 * @param {*} project
 */
export function migrateSpringChains(project) {
  if (!project || typeof project !== 'object') return project;
  if (!Array.isArray(project.springChains)) project.springChains = [];
  return project;
}
