import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { SpotLightNode } from './SpotLightNode';

describe('SpotLightNode aim target', () => {
  it('defaults the target to local -Z (aims per transform, not the three.js origin default)', () => {
    const spot = new SpotLightNode({ id: 'spot', name: 'Spot' });
    const target = spot.getTargetPosition();
    expect(target.x).toBeCloseTo(0);
    expect(target.y).toBeCloseTo(0);
    expect(target.z).toBeCloseTo(-5);
  });

  it('constrains the target to a fixed distance along the aim direction', () => {
    const spot = new SpotLightNode({ id: 'spot', name: 'Spot' });
    spot.setTargetPosition(new Vector3(10, 0, 0));

    const target = spot.getTargetPosition();
    // Direction (1,0,0) at TARGET_DISTANCE 5 → (5,0,0).
    expect(target.x).toBeCloseTo(5);
    expect(target.y).toBeCloseTo(0);
    expect(target.z).toBeCloseTo(0);
  });

  it('aims the beam (node → target) toward the requested point', () => {
    const spot = new SpotLightNode({ id: 'spot', name: 'Spot' });
    spot.setTargetPosition(new Vector3(0, -8, 4));

    const origin = spot.getWorldPosition(new Vector3());
    const dir = spot.getTargetPosition().sub(origin).normalize();
    const expected = new Vector3(0, -8, 4).normalize();
    expect(dir.x).toBeCloseTo(expected.x);
    expect(dir.y).toBeCloseTo(expected.y);
    expect(dir.z).toBeCloseTo(expected.z);
  });
});
