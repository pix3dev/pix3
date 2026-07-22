import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Vector2 } from 'three';
import { InputService, Joystick2D } from '@pix3/runtime';

describe('Joystick2D floating mode', () => {
  it('is hidden by default in floating mode, follows press position, then fades out before resetting', () => {
    const joystick = new Joystick2D({
      id: 'joy-floating',
      name: 'Floating Stick',
      position: new Vector2(10, 20),
      floating: true,
      radius: 50,
    });

    const baseMesh = joystick.children[0] as unknown as Mesh;
    const handleMesh = joystick.children[1] as unknown as Mesh;
    const baseMaterial = baseMesh.material as MeshBasicMaterial;
    const handleMaterial = handleMesh.material as MeshBasicMaterial;

    expect(baseMaterial.opacity).toBe(0);
    expect(handleMaterial.opacity).toBe(0);

    const input = new InputService();
    input.width = 800;
    input.height = 600;
    joystick.input = input;

    input.isPointerDown = true;
    input.pointerPosition.set(500, 300);
    joystick.tick(1 / 60);

    expect(joystick.position.x).toBeCloseTo(100, 5);
    expect(joystick.position.y).toBeCloseTo(0, 5);
    expect(baseMaterial.opacity).toBeGreaterThan(0);

    input.pointerPosition.set(550, 300);
    joystick.tick(1 / 60);

    expect(input.getAxis('Horizontal')).toBeCloseTo(1, 5);
    expect(input.getAxis('Vertical')).toBeCloseTo(0, 5);

    input.isPointerDown = false;
    joystick.tick(1 / 60);

    expect(input.getAxis('Horizontal')).toBe(0);
    expect(input.getAxis('Vertical')).toBe(0);
    expect(joystick.position.x).toBeCloseTo(100, 5);
    expect(joystick.position.y).toBeCloseTo(0, 5);
    expect(baseMaterial.opacity).toBeLessThan(0.3);

    for (let i = 0; i < 20; i++) {
      joystick.tick(1 / 60);
    }

    expect(baseMaterial.opacity).toBe(0);
    expect(joystick.position.x).toBeCloseTo(10, 5);
    expect(joystick.position.y).toBeCloseTo(20, 5);
  });

  it('remains visible by default when floating mode is disabled', () => {
    const joystick = new Joystick2D({
      id: 'joy-fixed',
      name: 'Fixed Stick',
      position: new Vector2(0, 0),
      floating: false,
    });

    const baseMesh = joystick.children[0] as unknown as Mesh;
    const handleMesh = joystick.children[1] as unknown as Mesh;
    const baseMaterial = baseMesh.material as MeshBasicMaterial;
    const handleMaterial = handleMesh.material as MeshBasicMaterial;

    expect(baseMaterial.opacity).toBeCloseTo(0.3, 5);
    expect(handleMaterial.opacity).toBeCloseTo(0.8, 5);
  });
});
