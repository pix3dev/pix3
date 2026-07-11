import { describe, expect, it } from 'vitest';
import { Camera3D } from '../nodes/3D/Camera3D';
import { VirtualCamera3D } from '../nodes/3D/VirtualCamera3D';
import type { SceneService } from '../core/SceneService';
import { CameraBrainBehavior } from './CameraBrainBehavior';

/**
 * Host Camera3D plus two authored-pose virtual cameras (no follow/look-at, so
 * they sit at their local positions). The vcams are kept *unparented* and fed to
 * the brain via a `getRootNodes` scene stub, so moving the host never drags their
 * world positions — mid-blend positions stay exact fractions. vcamA (pri 10) at
 * x=10, vcamB (pri 5) at y=10; both blend linearly.
 */
function makeBrainSetup() {
  const host = new Camera3D({ id: 'cam', name: 'Render', projection: 'perspective' });
  host.position.set(0, 0, 0);
  const brain = new CameraBrainBehavior('core:CameraBrain', 'core:CameraBrain');
  host.addComponent(brain);

  const vcamA = new VirtualCamera3D({
    id: 'vA',
    name: 'A',
    priority: 10,
    blendDuration: 1,
    blendEasing: 'linear',
  });
  const vcamB = new VirtualCamera3D({
    id: 'vB',
    name: 'B',
    priority: 5,
    blendDuration: 1,
    blendEasing: 'linear',
  });
  vcamA.position.set(10, 0, 0);
  vcamB.position.set(0, 10, 0);

  brain.scene = {
    getRootNodes: () => [host, vcamA, vcamB],
  } as unknown as SceneService;

  return { host, brain, vcamA, vcamB };
}

describe('CameraBrainBehavior.overrideNextBlend', () => {
  it('forces the next activation to use the override duration', () => {
    const { host, brain } = makeBrainSetup();

    brain.overrideNextBlend(0.5, 'linear');
    brain.onUpdate(0); // activate vcamA, consume override (0.5s), elapsed 0 → at start pose
    expect(host.position.x).toBeCloseTo(0, 5);

    brain.onUpdate(0.25); // raw = 0.25 / 0.5 = 0.5 → halfway to x=10
    expect(host.position.x).toBeCloseTo(5, 5);
    // (Without the override the vcam's own 1s duration would give raw 0.25 → x=2.5.)
  });

  it('wins over blendEnabled:false (an explicit override still blends, not hard-cut)', () => {
    const { host, brain } = makeBrainSetup();
    brain.config.blendEnabled = false;

    brain.overrideNextBlend(0.5, 'linear');
    brain.onUpdate(0);
    brain.onUpdate(0.25);

    // With blendEnabled off and no override the switch would hard-cut to x=10 on
    // the first frame; the override forces a real blend, so we sit mid-way.
    expect(host.position.x).toBeCloseTo(5, 5);
  });

  it('is consumed after one activation and does not leak into the next switch', () => {
    const { host, brain, vcamB } = makeBrainSetup();
    vcamB.blendDuration = 2;

    brain.overrideNextBlend(0.5, 'linear');
    brain.onUpdate(0); // activate A with the override
    brain.onUpdate(1); // finish the A blend (elapsed 1 ≥ 0.5) → parked at x=10
    expect(host.position.x).toBeCloseTo(10, 5);

    // Flip B to the top with NO new override — it must use its own 2s blend.
    vcamB.priority = 20;
    brain.onUpdate(0); // activate B
    brain.onUpdate(0.5); // raw = 0.5 / 2 = 0.25 → 25% from A(10,0,0) toward B(0,10,0)
    expect(host.position.x).toBeCloseTo(7.5, 5);
    expect(host.position.y).toBeCloseTo(2.5, 5);
    // (A leaked 0.5s override would have raced the blend to completion at x=0.)
  });
});
