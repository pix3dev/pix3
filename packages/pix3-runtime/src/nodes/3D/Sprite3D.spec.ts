import { describe, expect, it } from 'vitest';
import { Mesh, type PlaneGeometry } from 'three';

import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';
import { Sprite3D } from './Sprite3D';

/** Read the opacity of the sprite's plane material. */
const materialOpacity = (sprite: Sprite3D): number => {
  const mesh = sprite.children.find(child => child instanceof Mesh) as Mesh | undefined;
  const material = mesh?.material as { opacity: number } | undefined;
  return material?.opacity ?? Number.NaN;
};

describe('Sprite3D opacity', () => {
  it('defaults to fully opaque and binds the material', () => {
    const sprite = new Sprite3D({ id: 's1', name: 'Sprite' });
    expect(sprite.opacity).toBe(1);
    expect(materialOpacity(sprite)).toBeCloseTo(1);
  });

  it('drives the material opacity and clamps to [0, 1]', () => {
    const sprite = new Sprite3D({ id: 's2', name: 'Sprite' });

    sprite.opacity = 0.4;
    expect(sprite.opacity).toBeCloseTo(0.4);
    expect(materialOpacity(sprite)).toBeCloseTo(0.4);

    sprite.opacity = 5;
    expect(sprite.opacity).toBe(1);

    sprite.opacity = -2;
    expect(sprite.opacity).toBe(0);
  });

  it('respects an initial opacity passed to the constructor', () => {
    const sprite = new Sprite3D({ id: 's3', name: 'Sprite', opacity: 0.25 });
    expect(sprite.opacity).toBeCloseTo(0.25);
    expect(materialOpacity(sprite)).toBeCloseTo(0.25);
  });

  it('hide(0) immediately hides and zeroes opacity; show(0) restores it', () => {
    const sprite = new Sprite3D({ id: 's4', name: 'Sprite', opacity: 0.8 });

    sprite.hide();
    expect(sprite.visible).toBe(false);
    expect(sprite.opacity).toBe(0);

    sprite.show();
    expect(sprite.visible).toBe(true);
    expect(sprite.opacity).toBeCloseTo(0.8);
  });

  it('fades out over time and hides when complete, invoking onComplete', () => {
    const sprite = new Sprite3D({ id: 's5', name: 'Sprite', opacity: 1 });
    let completed = false;

    sprite.hide(1, () => {
      completed = true;
    });

    // Still visible while fading.
    expect(sprite.visible).toBe(true);

    sprite.tick(0.5);
    expect(sprite.opacity).toBeCloseTo(0.5);
    expect(completed).toBe(false);

    sprite.tick(0.5);
    expect(sprite.opacity).toBe(0);
    expect(sprite.visible).toBe(false);
    expect(completed).toBe(true);
  });

  it('fades in from the current opacity to the last visible opacity', () => {
    const sprite = new Sprite3D({ id: 's6', name: 'Sprite', opacity: 1 });
    sprite.hide();
    expect(sprite.opacity).toBe(0);

    sprite.show(1);
    expect(sprite.visible).toBe(true);

    sprite.tick(0.5);
    expect(sprite.opacity).toBeCloseTo(0.5);

    sprite.tick(0.5);
    expect(sprite.opacity).toBeCloseTo(1);
  });
});

/** Parameters of the plane geometry currently mounted on the sprite's mesh. */
const planeParameters = (sprite: Sprite3D): { width: number; height: number } => {
  const mesh = sprite.children.find(child => child instanceof Mesh) as Mesh;
  return (mesh.geometry as PlaneGeometry).parameters;
};

describe('Sprite3D script assignments', () => {
  it('rebuilds the plane geometry when a script assigns width/height directly', () => {
    const sprite = new Sprite3D({ id: 's7', name: 'Sprite' });

    sprite.width = 4;
    sprite.height = 3;

    // The consequence, not the field: the mounted geometry was actually rebuilt at the new size.
    expect(planeParameters(sprite).width).toBe(4);
    expect(planeParameters(sprite).height).toBe(3);
  });

  it('routes assignments through setSize, so invalid sizes are rejected like the Inspector', () => {
    const sprite = new Sprite3D({ id: 's8', name: 'Sprite', width: 2, height: 2 });

    sprite.width = -5;

    expect(sprite.width).toBe(2);
    expect(planeParameters(sprite).width).toBe(2);
  });

  it('installs reactive accessors for the schema-backed plain fields', () => {
    const sprite = new Sprite3D({ id: 's9', name: 'Sprite' });
    const reactive = reactiveSchemaPropertyNames(sprite);
    for (const name of ['width', 'height', 'texture', 'billboard', 'billboardRoll']) {
      expect(reactive.has(name), `${name} should be reactive`).toBe(true);
    }
  });
});
