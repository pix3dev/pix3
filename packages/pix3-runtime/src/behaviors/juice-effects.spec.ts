import { describe, expect, it } from 'vitest';
import { NodeBase } from '../nodes/NodeBase';
import { ShakeBehavior } from './ShakeBehavior';
import { PunchScaleBehavior } from './PunchScaleBehavior';
import { PopInBehavior } from './PopInBehavior';

function makeNode(): NodeBase {
  return new NodeBase({ id: 'n', type: 'Node', name: 'Node' });
}

describe('ShakeBehavior', () => {
  it('displaces the node while active and restores exactly when finished', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 10, frequency: 20, duration: 0.2, decay: 1 });

    shake.onUpdate(0.05);
    const displaced = Math.abs(node.position.x) + Math.abs(node.position.y);
    expect(displaced).toBeGreaterThan(0);
    expect(Math.abs(node.position.x)).toBeLessThanOrEqual(10); // within amplitude

    // Advance past the duration → offset removed, back to origin.
    shake.onUpdate(0.2);
    expect(node.position.x).toBeCloseTo(0, 6);
    expect(node.position.y).toBeCloseTo(0, 6);
  });

  it('is additive: it re-centers on whatever else moved the node and leaves no residue', () => {
    const node = makeNode();
    node.position.set(100, 0, 0);
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 5, frequency: 30, duration: 0.2, decay: 1 });

    shake.onUpdate(0.05);
    expect(node.position.x).toBeGreaterThan(95);
    expect(node.position.x).toBeLessThan(105);

    // Simulate another writer (e.g. a mover) advancing the node by a delta
    // between frames — shake removes its prior offset first, so it re-centers
    // on the new base rather than accumulating.
    node.position.x += 100;
    shake.onUpdate(0.05);
    expect(node.position.x).toBeGreaterThan(195);
    expect(node.position.x).toBeLessThan(205);

    // Finish: the offset is subtracted, leaving the moved base intact.
    shake.onUpdate(0.2);
    expect(node.position.x).toBeCloseTo(200, 6);
  });

  it('stop() restores the position immediately', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.play({ amplitude: 8, duration: 0, frequency: 20 }); // duration 0 → runs until stopped
    shake.onUpdate(0.016);
    expect(Math.abs(node.position.x) + Math.abs(node.position.y)).toBeGreaterThan(0);
    shake.stop();
    expect(node.position.x).toBeCloseTo(0, 6);
    expect(node.position.y).toBeCloseTo(0, 6);
  });

  it('triggers on a node signal when configured', () => {
    const node = makeNode();
    const shake = new ShakeBehavior('shake', 'core:Shake');
    shake.node = node;
    shake.config.triggerEvent = 'hit';
    shake.config.amplitude = 6;
    shake.config.frequency = 20;
    shake.config.duration = 0.3;
    shake.onStart(); // binds the trigger

    shake.onUpdate(0.05);
    expect(node.position.x).toBe(0); // not triggered yet

    node.emit('hit');
    shake.onUpdate(0.05);
    expect(Math.abs(node.position.x) + Math.abs(node.position.y)).toBeGreaterThan(0);

    shake.onDetach();
  });
});

describe('PunchScaleBehavior', () => {
  it('pops the scale up immediately and settles back to the resting scale', () => {
    const node = makeNode();
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = node;
    punch.play({ amount: 0.5, duration: 0.2, vibrato: 1 });

    punch.onUpdate(0.001);
    expect(node.scale.x).toBeGreaterThan(1); // instant pop

    punch.onUpdate(0.2);
    expect(node.scale.x).toBeCloseTo(1, 6);
    expect(node.scale.y).toBeCloseTo(1, 6);
  });

  it('restores a non-uniform authored scale', () => {
    const node = makeNode();
    node.scale.set(2, 3, 1);
    const punch = new PunchScaleBehavior('punch', 'core:PunchScale');
    punch.node = node;
    punch.play({ amount: 0.4, duration: 0.15, vibrato: 2 });

    punch.onUpdate(0.05);
    // scaled uniformly around the authored ratio
    expect(node.scale.y / node.scale.x).toBeCloseTo(3 / 2, 5);

    punch.onUpdate(0.15);
    expect(node.scale.x).toBeCloseTo(2, 6);
    expect(node.scale.y).toBeCloseTo(3, 6);
    expect(node.scale.z).toBeCloseTo(1, 6);
  });
});

describe('PopInBehavior', () => {
  it('scales from zero up to the authored scale', () => {
    const node = makeNode();
    const pop = new PopInBehavior('pop', 'core:PopIn');
    pop.node = node;
    pop.config.playOnStart = false;
    pop.onStart(); // captures base (1,1,1)
    pop.play({ from: 0, duration: 0.2, easing: 'linear' });

    // Snaps to the starting scale on trigger.
    expect(node.scale.x).toBeCloseTo(0, 6);

    pop.onUpdate(0.1); // halfway, linear → 0.5
    expect(node.scale.x).toBeCloseTo(0.5, 5);

    pop.onUpdate(0.1); // done → authored scale
    expect(node.scale.x).toBeCloseTo(1, 6);
  });

  it('auto-plays on start by default', () => {
    const node = makeNode();
    node.scale.set(2, 2, 2);
    const pop = new PopInBehavior('pop', 'core:PopIn');
    pop.node = node;
    // playOnStart defaults to true.
    pop.onStart();
    // Snapped down to `from` (0) × authored scale.
    expect(node.scale.x).toBeCloseTo(0, 6);

    pop.onUpdate(1); // long tick → completes to authored scale
    expect(node.scale.x).toBeCloseTo(2, 6);
  });
});
