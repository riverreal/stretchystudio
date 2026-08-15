// @ts-check

/**
 * Spring Chain section — add / remove a multi-joint warp-band chain
 * on the selected part. Visible when the part has a rig warp or an
 * existing chain.
 *
 * @module v3/editors/properties/sections/SpringChainSection
 */

import { useEffect, useMemo, useState } from 'react';
import { Wind } from 'lucide-react';
import { useProjectStore } from '../../../../store/projectStore.js';
import { SectionShell } from './SectionShell.jsx';
import { PropertyRow } from '../primitives/PropertyRow.jsx';
import { NumberField } from '../fields/NumberField.jsx';
import * as SelectImpl from '../../../../components/ui/select.jsx';
import {
  DEFAULT_JOINTS,
  DEFAULT_LAG,
  MAX_JOINTS,
  MAX_LAG,
  MIN_JOINTS,
  MIN_LAG,
  SPRING_AXES,
  SPRING_AXIS_AUTO,
  SPRING_AXIS_LABELS,
  addSpringChain,
  canAddSpringChain,
  findSpringChain,
  normalizeSpringAxis,
  normalizeSpringLag,
  removeSpringChain,
} from '../../../../io/live2d/rig/springChain.js';
import { getRigWarpNodes } from '../../../../io/live2d/rig/deformerNodeReaders.js';

/** @type {Record<string, React.ComponentType<any>>} */
const Sel = /** @type {any} */ (SelectImpl);
const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = Sel;

/**
 * @param {Object} props
 * @param {string} props.nodeId
 */
export function SpringChainSection({ nodeId }) {
  const nodes = useProjectStore((s) => s.project.nodes);
  const springChains = useProjectStore((s) => s.project.springChains);
  const updateProject = useProjectStore((s) => s.updateProject);
  const [jointCount, setJointCount] = useState(DEFAULT_JOINTS);
  const [axis, setAxis] = useState(SPRING_AXIS_AUTO);
  const [lag, setLag] = useState(DEFAULT_LAG);
  const [message, setMessage] = useState(/** @type {string|null} */ (null));

  const chain = useMemo(
    () => findSpringChain({ springChains }, nodeId),
    [springChains, nodeId],
  );
  const gate = useMemo(() => {
    const project = useProjectStore.getState().project;
    return canAddSpringChain(project, nodeId);
  }, [nodes, nodeId, springChains]);

  useEffect(() => {
    setAxis(normalizeSpringAxis(chain?.axis));
    if (chain?.jointCount) setJointCount(chain.jointCount);
    setLag(normalizeSpringLag(chain?.lag));
  }, [nodeId, chain?.axis, chain?.jointCount, chain?.lag]);

  function apply(fn) {
    setMessage(null);
    let result = /** @type {{ ok: boolean, reason?: string, warnings?: string[] }|null} */ (null);
    updateProject((proj, vc) => {
      result = fn(proj);
      if (result?.ok && vc) vc.geometryVersion = (vc.geometryVersion ?? 0) + 1;
    });
    if (!result) return;
    if (!result.ok) {
      setMessage(result.reason ?? 'Failed.');
      return;
    }
    if (result.warnings && result.warnings.length > 0) {
      setMessage(result.warnings.join(' '));
    }
  }

  function rebuild(nextAxis, nextJoints, nextLag) {
    apply((proj) => {
      const removed = removeSpringChain(proj, nodeId);
      if (!removed.ok) return removed;
      return addSpringChain(proj, nodeId, {
        jointCount: nextJoints ?? jointCount,
        axis: nextAxis ?? axis,
        lag: nextLag ?? lag,
      });
    });
  }

  const axisSelect = (
    <Select
      value={axis}
      onValueChange={(v) => {
        const next = normalizeSpringAxis(v);
        setAxis(next);
        if (chain) rebuild(next, jointCount);
      }}
    >
      <SelectTrigger className="h-6 text-xs px-2 py-0 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SPRING_AXES.map((id) => (
          <SelectItem key={id} value={id} className="text-xs">
            {SPRING_AXIS_LABELS[id]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <SectionShell id="springChain" label="Spring Chain" icon={<Wind size={11} />}>
      {chain ? (
        <>
          <PropertyRow label="Joints">
            <span className="text-[11px] text-foreground tabular-nums">
              {chain.jointCount}
            </span>
          </PropertyRow>
          <PropertyRow label="Axis" title="Which warp-grid edge stays pinned">
            {axisSelect}
          </PropertyRow>
          <NumberField
            label="Wave lag"
            title="How late the tip follows the root. 0 is snappier; 1 is a slower travelling wave — the chain still swings."
            value={lag}
            min={MIN_LAG}
            max={MAX_LAG}
            step={0.05}
            precision={2}
            onCommit={(v) => {
              const next = normalizeSpringLag(v);
              setLag(next);
              rebuild(axis, jointCount, next);
            }}
          />
          <PropertyRow label="Params" alignTop>
            <span className="text-[10px] text-muted-foreground font-mono break-all">
              {(chain.paramIds ?? []).join(', ')}
            </span>
          </PropertyRow>
          <p className="px-2 pb-1 text-[10px] text-muted-foreground leading-snug">
            Idle generation keys ParamWind. The first joints stay quiet; the
            tip carries the wave. Bake is automatic when you generate a motion.
          </p>
          <div className="flex gap-1 px-2 pb-2">
            <button
              type="button"
              className="h-6 px-2 text-[11px] rounded border border-border bg-background hover:bg-muted"
              onClick={() => rebuild(axis, jointCount, lag)}
            >
              Rebuild ({jointCount})
            </button>
            <button
              type="button"
              className="h-6 px-2 text-[11px] rounded border border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => apply((proj) => removeSpringChain(proj, nodeId))}
            >
              Remove
            </button>
          </div>
          <NumberField
            label="Rebuild joints"
            value={jointCount}
            min={MIN_JOINTS}
            max={MAX_JOINTS}
            step={1}
            precision={0}
            onCommit={(v) => setJointCount(Math.max(MIN_JOINTS, Math.min(MAX_JOINTS, Math.round(v))))}
          />
        </>
      ) : (
        <>
          <p className="px-2 pb-1 text-[10px] text-muted-foreground leading-snug">
            Attach 2–4 spring joints to this part. They deform the existing
            warp (one mesh, traveling wave) and simulate during idle generation.
          </p>
          <NumberField
            label="Joints"
            value={jointCount}
            min={MIN_JOINTS}
            max={MAX_JOINTS}
            step={1}
            precision={0}
            disabled={!gate.ok}
            onCommit={(v) => setJointCount(Math.max(MIN_JOINTS, Math.min(MAX_JOINTS, Math.round(v))))}
          />
          <PropertyRow label="Axis" title="Which warp-grid edge stays pinned">
            {axisSelect}
          </PropertyRow>
          <NumberField
            label="Wave lag"
            title="How late the tip follows the root. 0 is snappier; 1 is a slower travelling wave — the chain still swings."
            value={lag}
            min={MIN_LAG}
            max={MAX_LAG}
            step={0.05}
            precision={2}
            disabled={!gate.ok}
            onCommit={(v) => setLag(normalizeSpringLag(v))}
          />
          <div className="px-2 pb-2">
            <button
              type="button"
              className="h-6 px-2 text-[11px] rounded border border-border bg-background hover:bg-muted disabled:opacity-50"
              disabled={!gate.ok}
              title={gate.ok ? 'Add a spring chain to this part' : gate.reason}
              onClick={() => apply((proj) => addSpringChain(proj, nodeId, { jointCount, axis, lag }))}
            >
              Add spring chain
            </button>
          </div>
          {!gate.ok ? (
            <p className="px-2 pb-2 text-[10px] text-muted-foreground">{gate.reason}</p>
          ) : null}
        </>
      )}
      {message ? (
        <p className="px-2 pb-2 text-[10px] text-amber-600 dark:text-amber-400">{message}</p>
      ) : null}
    </SectionShell>
  );
}

/**
 * @param {{ type: string, id: string }} active
 * @param {object} project
 */
export function isSpringChainSectionVisible(active, project) {
  if (active?.type !== 'part') return false;
  if (findSpringChain(project, active.id)) return true;
  return getRigWarpNodes(project).has(active.id);
}
