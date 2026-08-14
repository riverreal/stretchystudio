// @ts-check
/**
 * Bake Physics dialog — per-output strength + global wiggle/lag, then
 * bake onto the active action. Tuning is bake-time only: gathered
 * physics rules are cloned inside `bakePhysics`; project modifiers
 * stay at authored scale.
 *
 * @module v3/editors/actions/BakePhysicsDialog
 */

import { useEffect, useMemo, useState } from 'react';
import { Wind } from 'lucide-react';
import * as DialogImpl from '../../../components/ui/dialog.jsx';
import * as ButtonImpl from '../../../components/ui/button.jsx';
import * as LabelImpl from '../../../components/ui/label.jsx';
import * as InputImpl from '../../../components/ui/input.jsx';
import { useProjectStore } from '../../../store/projectStore.js';
import { useAnimationStore } from '../../../store/animationStore.js';
import { getActiveSceneAction } from '../../../anim/sceneAction.js';
import { getOperator } from '../../operators/registry.js';
import {
  getLastBakePhysicsTuning,
  listPhysicsBakeTargets,
} from '../../operators/bakePhysics.js';

/** @type {Record<string, React.ComponentType<any>>} */
const D = /** @type {any} */ (DialogImpl);
/** @type {Record<string, React.ComponentType<any>>} */
const Btn = /** @type {any} */ (ButtonImpl);
/** @type {Record<string, React.ComponentType<any>>} */
const Lbl = /** @type {any} */ (LabelImpl);
/** @type {Record<string, React.ComponentType<any>>} */
const Inp = /** @type {any} */ (InputImpl);
const { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } = D;
const { Button } = Btn;
const { Label } = Lbl;
const { Input } = Inp;

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {{open: boolean, onOpenChange: (b: boolean) => void}} props
 */
export function BakePhysicsDialog({ open, onOpenChange }) {
  const project = useProjectStore((s) => s.project);
  const activeActionId = useAnimationStore((s) => s.activeActionId);
  const targets = useMemo(() => listPhysicsBakeTargets(project), [project]);

  const [wiggle, setWiggle] = useState(1);
  const [lag, setLag] = useState(1);
  /** @type {[Record<string, number>, function(Record<string, number>): void]} */
  const [strength, setStrength] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const last = getLastBakePhysicsTuning();
    setWiggle(last.wiggle);
    setLag(last.lag);
    /** @type {Record<string, number>} */
    const next = {};
    for (const t of targets) {
      next[t.paramId] = last.outputStrength[t.paramId] ?? 1;
    }
    setStrength(next);
    setBusy(false);
  }, [open, targets]);

  function handleBake() {
    setBusy(true);
    try {
      const op = getOperator('anim.bakePhysics');
      if (!op) throw new Error('anim.bakePhysics is not registered');
      op.exec({
        editorType: 'timeline',
        bakePhysics: { wiggle, lag, outputStrength: strength },
      });
      onOpenChange(false);
    } catch {
      // Operator toasts known failures; keep the dialog open so the
      // user can retune.
    } finally {
      setBusy(false);
    }
  }

  const action = getActiveSceneAction(project, activeActionId);
  const canBake = !!action && targets.length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wind size={16} className="text-primary" />
            Bake Physics
          </DialogTitle>
          <DialogDescription>
            Step this action through the pendulums and write hair / clothing / arm
            sway as fcurves. Strength is bake-only — live modifiers stay as authored.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-3 items-center gap-3">
            <Label htmlFor="bake-wiggle">Wiggle</Label>
            <div className="col-span-2 flex flex-col gap-1">
              <Input
                id="bake-wiggle"
                type="number"
                min={0.05}
                max={8}
                step={0.05}
                value={wiggle}
                onChange={(e) => setWiggle(numOr(e.target.value, 1))}
              />
              <span className="text-[10px] text-muted-foreground">
                Global multiplier on every physics output. 1 = authored, 2 = twice as big.
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 items-center gap-3">
            <Label htmlFor="bake-lag">Lag</Label>
            <div className="col-span-2 flex flex-col gap-1">
              <Input
                id="bake-lag"
                type="number"
                min={0.25}
                max={3}
                step={0.05}
                value={lag}
                onChange={(e) => setLag(numOr(e.target.value, 1))}
              />
              <span className="text-[10px] text-muted-foreground">
                Pendulum delay. Above 1 adds bounce; below 1 snaps tighter.
              </span>
            </div>
          </div>

          {targets.length > 0 ? (
            <div className="grid gap-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Per output
              </div>
              {targets.map((t) => (
                <div key={t.paramId} className="grid grid-cols-3 items-center gap-3">
                  <Label htmlFor={`bake-out-${t.paramId}`} className="truncate" title={t.paramId}>
                    {t.label}
                  </Label>
                  <Input
                    id={`bake-out-${t.paramId}`}
                    className="col-span-2"
                    type="number"
                    min={0}
                    max={8}
                    step={0.1}
                    value={strength[t.paramId] ?? 1}
                    onChange={(e) => {
                      const v = numOr(e.target.value, 1);
                      setStrength({ ...strength, [t.paramId]: v });
                    }}
                  />
                </div>
              ))}
              <span className="text-[10px] text-muted-foreground">
                Composed with Wiggle. Hair is clamped to ±1 — past that the warp cannot
                travel further without a stronger Init Rig sway.
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No physics modifiers on this project. Run Initialize Rig with hair / arm
              physics on, then come back.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleBake} disabled={!canBake}>
            {busy ? 'Baking…' : 'Bake'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
