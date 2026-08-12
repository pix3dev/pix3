import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';

import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';
import { MeshInstance } from './MeshInstance';

describe('MeshInstance script assignments', () => {
  it('propagates castShadow/receiveShadow assignments to the loaded child meshes', () => {
    const node = new MeshInstance({ id: 'm1', name: 'Model' }); // defaults: both true
    // Stand-in for a resolved GLTF: a mesh hierarchy under the container node.
    const child = new Mesh();
    const grandchild = new Mesh();
    child.add(grandchild);
    node.add(child);
    node.applyLoadedShadowProperties(); // what the load path does once the model resolves

    node.castShadow = false;

    // The consequence, not the field: the real renderable meshes stopped casting.
    expect(child.castShadow).toBe(false);
    expect(grandchild.castShadow).toBe(false);
    expect(child.receiveShadow).toBe(true); // the sibling flag is untouched

    node.receiveShadow = false;
    expect(grandchild.receiveShadow).toBe(false);

    node.castShadow = true;
    expect(child.castShadow).toBe(true);
    expect(grandchild.castShadow).toBe(true);
  });

  it('accepts shadow assignments before the GLTF resolves and applies them on load', () => {
    const node = new MeshInstance({ id: 'm2', name: 'Model' });

    // No children yet: the propagation walk visits nothing and must not throw.
    node.castShadow = false;

    const mesh = new Mesh();
    node.add(mesh);
    node.applyLoadedShadowProperties();
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(true);
  });

  it('installs reactive accessors for the plain fields; isPlaying/isLoop keep their accessors', () => {
    const node = new MeshInstance({ id: 'm3', name: 'Model' });
    const reactive = reactiveSchemaPropertyNames(node);
    for (const name of ['castShadow', 'receiveShadow', 'initialAnimation']) {
      expect(reactive.has(name), `${name} should be reactive`).toBe(true);
    }
    // Already accessor pairs on the class — the install must leave them alone.
    expect(reactive.has('isPlaying')).toBe(false);
    expect(reactive.has('isLoop')).toBe(false);
  });
});
