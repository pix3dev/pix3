import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { Node3D } from '../Node3D';
import { Camera3D } from './Camera3D';
import { VirtualCamera3D } from './VirtualCamera3D';
import { CameraBrainBehavior } from '../../behaviors/CameraBrainBehavior';

function makeRoot(): Node3D {
  return new Node3D({ id: 'root', name: 'Root' });
}

function forwardOf(node: VirtualCamera3D): Vector3 {
  const quat = node.getWorldQuaternion(new Quaternion());
  return new Vector3(0, 0, -1).applyQuaternion(quat);
}

describe('VirtualCamera3D.solve — follow', () => {
  it('snaps to target + offset with zero damping', () => {
    const root = makeRoot();
    const target = new Node3D({ id: 'target', name: 'Target' });
    target.position.set(5, 2, -3);
    const vcam = new VirtualCamera3D({
      id: 'vcam',
      name: 'VCam',
      followTargetId: 'target',
      followDamping: 0,
      followOffset: { x: 0, y: 1, z: 0 },
    });
    root.add(target, vcam);

    vcam.solve(1);

    const pos = vcam.getWorldPosition(new Vector3());
    expect(pos.x).toBeCloseTo(5);
    expect(pos.y).toBeCloseTo(3); // 2 + offset 1
    expect(pos.z).toBeCloseTo(-3);
  });

  it('eases toward the target over time with damping', () => {
    const root = makeRoot();
    const target = new Node3D({ id: 'target', name: 'Target' });
    target.position.set(10, 0, 0);
    const vcam = new VirtualCamera3D({
      id: 'vcam',
      name: 'VCam',
      followTargetId: 'target',
      followDamping: 8,
    });
    root.add(target, vcam);

    vcam.solve(1 / 60);
    const x = vcam.getWorldPosition(new Vector3()).x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(10);
  });

  it('leaves position untouched when there is no follow target', () => {
    const root = makeRoot();
    const vcam = new VirtualCamera3D({ id: 'vcam', name: 'VCam' });
    vcam.position.set(3, 4, 5);
    root.add(vcam);

    vcam.solve(1);

    const pos = vcam.getWorldPosition(new Vector3());
    expect(pos.x).toBeCloseTo(3);
    expect(pos.y).toBeCloseTo(4);
    expect(pos.z).toBeCloseTo(5);
  });

  it('does not follow while the target stays inside the deadzone', () => {
    const root = makeRoot();
    const target = new Node3D({ id: 'target', name: 'Target' });
    const vcam = new VirtualCamera3D({
      id: 'vcam',
      name: 'VCam',
      followTargetId: 'target',
      followDamping: 0,
      deadzone: { x: 2, y: 2, z: 2 },
    });
    root.add(target, vcam);

    // Target within the deadzone half-extent → no movement.
    target.position.set(1.5, 0, 0);
    vcam.solve(1);
    expect(vcam.getWorldPosition(new Vector3()).x).toBeCloseTo(0);

    // Target beyond the deadzone → follows so the target rests at the box edge.
    target.position.set(5, 0, 0);
    vcam.solve(1);
    expect(vcam.getWorldPosition(new Vector3()).x).toBeCloseTo(3); // 5 - deadzone 2
  });
});

describe('VirtualCamera3D.solve — look-at', () => {
  it('orients toward the look-at target at full weight', () => {
    const root = makeRoot();
    const target = new Node3D({ id: 'target', name: 'Target' });
    target.position.set(5, 0, 3);
    const vcam = new VirtualCamera3D({
      id: 'vcam',
      name: 'VCam',
      lookAtTargetId: 'target',
      lookAtWeight: 1,
      rotationDamping: 0,
    });
    root.add(target, vcam);

    vcam.solve(1);

    const forward = forwardOf(vcam);
    const expected = new Vector3(5, 0, 3).normalize();
    expect(forward.x).toBeCloseTo(expected.x);
    expect(forward.y).toBeCloseTo(expected.y);
    expect(forward.z).toBeCloseTo(expected.z);
  });

  it('keeps authored orientation at zero look-at weight', () => {
    const root = makeRoot();
    const target = new Node3D({ id: 'target', name: 'Target' });
    target.position.set(5, 0, 0);
    const vcam = new VirtualCamera3D({
      id: 'vcam',
      name: 'VCam',
      lookAtTargetId: 'target',
      lookAtWeight: 0,
      rotationDamping: 0,
    });
    root.add(target, vcam);

    vcam.solve(1);

    const forward = forwardOf(vcam);
    expect(forward.z).toBeCloseTo(-1); // still looking down -Z (authored)
  });
});

describe('VirtualCamera3D.solve — confiner', () => {
  it('clamps the solved position inside the confiner box', () => {
    const root = makeRoot();
    const target = new Node3D({ id: 'target', name: 'Target' });
    target.position.set(100, 0, 0);
    const vcam = new VirtualCamera3D({
      id: 'vcam',
      name: 'VCam',
      followTargetId: 'target',
      followDamping: 0,
      confinerEnabled: true,
      confinerCenter: { x: 0, y: 0, z: 0 },
      confinerSize: { x: 10, y: 10, z: 10 },
    });
    root.add(target, vcam);

    vcam.solve(1);

    expect(vcam.getWorldPosition(new Vector3()).x).toBeCloseTo(5); // clamped to +half
  });
});

describe('CameraBrainBehavior', () => {
  function setup(): { root: Node3D; host: Camera3D; brain: CameraBrainBehavior } {
    const root = makeRoot();
    const host = new Camera3D({ id: 'host', name: 'Camera' });
    root.add(host);
    const brain = new CameraBrainBehavior('brain', 'core:CameraBrain');
    brain.node = host;
    brain.onStart();
    return { root, host, brain };
  }

  it('drives the host camera to the highest-priority visible virtual camera', () => {
    const { root, host, brain } = setup();
    const a = new VirtualCamera3D({ id: 'a', name: 'A', priority: 10, blendDuration: 0 });
    a.position.set(1, 0, 0);
    const b = new VirtualCamera3D({ id: 'b', name: 'B', priority: 20, blendDuration: 0 });
    b.position.set(2, 0, 0);
    root.add(a, b);

    brain.onUpdate(1 / 60);

    expect(host.getWorldPosition(new Vector3()).x).toBeCloseTo(2);
  });

  it('ignores hidden virtual cameras', () => {
    const { root, host, brain } = setup();
    const a = new VirtualCamera3D({ id: 'a', name: 'A', priority: 10, blendDuration: 0 });
    a.position.set(1, 0, 0);
    const b = new VirtualCamera3D({ id: 'b', name: 'B', priority: 20, blendDuration: 0 });
    b.position.set(2, 0, 0);
    b.visible = false;
    root.add(a, b);

    brain.onUpdate(1 / 60);

    expect(host.getWorldPosition(new Vector3()).x).toBeCloseTo(1);
  });

  it('leaves the host untouched when no virtual camera exists', () => {
    const { host, brain } = setup();
    host.position.set(7, 8, 9);

    brain.onUpdate(1 / 60);

    const pos = host.getWorldPosition(new Vector3());
    expect(pos.x).toBeCloseTo(7);
    expect(pos.y).toBeCloseTo(8);
    expect(pos.z).toBeCloseTo(9);
  });

  it('blends from the current pose to the target over the blend duration', () => {
    const { root, host, brain } = setup();
    host.position.set(0, 0, 0);
    const b = new VirtualCamera3D({
      id: 'b',
      name: 'B',
      priority: 20,
      blendDuration: 1,
      blendEasing: 'linear',
    });
    b.position.set(10, 0, 0);
    root.add(b);

    brain.onUpdate(0.5);
    expect(host.getWorldPosition(new Vector3()).x).toBeCloseTo(5); // halfway, linear

    brain.onUpdate(0.5);
    expect(host.getWorldPosition(new Vector3()).x).toBeCloseTo(10); // blend complete
  });

  it('re-targets when priorities change', () => {
    const { root, host, brain } = setup();
    const a = new VirtualCamera3D({ id: 'a', name: 'A', priority: 10, blendDuration: 0 });
    a.position.set(1, 0, 0);
    const b = new VirtualCamera3D({ id: 'b', name: 'B', priority: 20, blendDuration: 0 });
    b.position.set(2, 0, 0);
    root.add(a, b);

    brain.onUpdate(1 / 60);
    expect(host.getWorldPosition(new Vector3()).x).toBeCloseTo(2);

    a.priority = 30;
    brain.onUpdate(1 / 60);
    expect(host.getWorldPosition(new Vector3()).x).toBeCloseTo(1);
  });
});
