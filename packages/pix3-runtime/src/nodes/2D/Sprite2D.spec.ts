import { describe, expect, it } from 'vitest';
import type { Mesh, MeshBasicMaterial } from 'three';

import { Sprite2D } from './Sprite2D';
import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';

/** The rendered surface: size lives on mesh.scale, the pivot on mesh.position. */
const meshOf = (sprite: Sprite2D): Mesh => (sprite as unknown as { mesh: Mesh }).mesh;
const materialOf = (sprite: Sprite2D): MeshBasicMaterial =>
  (sprite as unknown as { material: MeshBasicMaterial }).material;

describe('Sprite2D schema-property reactivity (direct script assignment)', () => {
  it('installs the schema-backed fields as reactive accessors', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S' });
    const reactive = reactiveSchemaPropertyNames(sprite);
    // updateSize/applyAnchorOffset are private — before the install these writes had no
    // working script spelling at all.
    for (const name of ['width', 'height', 'anchor', 'texture', 'textureKey']) {
      expect(reactive.has(name), `expected "${name}" to be reactive`).toBe(true);
    }
  });

  it('width/height assignment rescales the mesh (not just the field)', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S', width: 100, height: 50 });
    expect(meshOf(sprite).scale.x).toBe(100);

    sprite.width = 200;
    expect(meshOf(sprite).scale.x).toBe(200);
    expect(meshOf(sprite).scale.y).toBe(50);

    sprite.height = 80;
    expect(meshOf(sprite).scale.y).toBe(80);
  });

  it('width assignment on an unsized sprite uses the placeholder height, like the Inspector', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S' });
    sprite.width = 200;
    expect(meshOf(sprite).scale.x).toBe(200);
    expect(meshOf(sprite).scale.y).toBe(64);
  });

  it('anchor assignment moves the mesh pivot offset', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S', width: 100, height: 100 });
    expect(meshOf(sprite).position.x).toBe(0); // default centre anchor

    sprite.anchor = { x: 0, y: 0 };
    expect(meshOf(sprite).position.x).toBe(50);
    expect(meshOf(sprite).position.y).toBe(50);
  });

  it('leaves the material untouched by unrelated writes (sanity)', () => {
    const sprite = new Sprite2D({ id: 's', name: 'S', width: 10, height: 10, color: '#ff0000' });
    sprite.width = 20;
    expect(materialOf(sprite).color.getHex()).toBe(0xff0000);
  });
});
