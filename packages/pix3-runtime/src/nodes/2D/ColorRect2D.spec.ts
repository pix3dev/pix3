import { describe, expect, it } from 'vitest';
import type { Mesh, MeshBasicMaterial } from 'three';

import { ColorRect2D } from './ColorRect2D';
import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';

const meshOf = (rect: ColorRect2D): Mesh => (rect as unknown as { mesh: Mesh }).mesh;
const materialOf = (rect: ColorRect2D): MeshBasicMaterial =>
  (rect as unknown as { material: MeshBasicMaterial }).material;

describe('ColorRect2D schema-property reactivity (direct script assignment)', () => {
  it('installs the schema-backed fields as reactive accessors', () => {
    const rect = new ColorRect2D({ id: 'r', name: 'R' });
    const reactive = reactiveSchemaPropertyNames(rect);
    for (const name of ['width', 'height', 'color']) {
      expect(reactive.has(name), `expected "${name}" to be reactive`).toBe(true);
    }
  });

  it('color assignment recolours the material — the script flash/fade case', () => {
    const rect = new ColorRect2D({ id: 'r', name: 'R', color: '#ffffff' });
    rect.color = '#ff0000';
    // The proof is the MATERIAL, not the field: before the fix the field changed and the
    // quad stayed white.
    expect(materialOf(rect).color.getHex()).toBe(0xff0000);
  });

  it('width/height assignment rescales the mesh', () => {
    const rect = new ColorRect2D({ id: 'r', name: 'R', width: 100, height: 100 });
    rect.width = 300;
    expect(meshOf(rect).scale.x).toBe(300);
    rect.height = 40;
    expect(meshOf(rect).scale.y).toBe(40);
  });
});
