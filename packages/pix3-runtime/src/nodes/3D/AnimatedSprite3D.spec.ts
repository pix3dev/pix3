import { describe, expect, it } from 'vitest';
import { Mesh, type MeshBasicMaterial, type PlaneGeometry } from 'three';

import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';
import { AnimatedSprite3D } from './AnimatedSprite3D';

const spriteMesh = (sprite: AnimatedSprite3D): Mesh =>
  sprite.children.find(child => child instanceof Mesh) as Mesh;

describe('AnimatedSprite3D script assignments', () => {
  it('rebuilds the plane geometry when a script assigns width/height directly', () => {
    const sprite = new AnimatedSprite3D({ id: 'a1', name: 'Anim' });

    sprite.width = 5;
    sprite.height = 2;

    // The consequence, not the field: the mounted geometry was actually rebuilt at the new size.
    const parameters = (spriteMesh(sprite).geometry as PlaneGeometry).parameters;
    expect(parameters.width).toBe(5);
    expect(parameters.height).toBe(2);
  });

  it('refreshes the material tint when a script assigns color directly', () => {
    const sprite = new AnimatedSprite3D({ id: 'a2', name: 'Anim' });

    sprite.color = '#ff0000';

    // With no frame texture loaded, updateTexture paints the material with the tint color.
    const material = spriteMesh(sprite).material as MeshBasicMaterial;
    expect(material.color.getHexString()).toBe('ff0000');
  });

  it('installs reactive accessors for the plain fields; currentFrame keeps its class accessor', () => {
    const sprite = new AnimatedSprite3D({ id: 'a3', name: 'Anim' });
    const reactive = reactiveSchemaPropertyNames(sprite);
    for (const name of ['width', 'height', 'color', 'fps', 'playing', 'loop', 'freeOnFinish']) {
      expect(reactive.has(name), `${name} should be reactive`).toBe(true);
    }
    // Already an accessor pair on the class — the install must leave it alone.
    expect(reactive.has('currentFrame')).toBe(false);
  });
});
