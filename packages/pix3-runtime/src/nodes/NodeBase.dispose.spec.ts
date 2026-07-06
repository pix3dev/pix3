import { describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';

import { NodeBase } from './NodeBase';
import { Script } from '../core/ScriptComponent';

class DetachSpyScript extends Script {
  detachCalls = 0;

  override onDetach(): void {
    this.detachCalls += 1;
  }
}

function meshWithSpies(): { mesh: Mesh; geometry: PlaneGeometry; material: MeshBasicMaterial } {
  const geometry = new PlaneGeometry(1, 1);
  const material = new MeshBasicMaterial();
  return { mesh: new Mesh(geometry, material), geometry, material };
}

describe('NodeBase.dispose', () => {
  it('disposes the geometry and material of its own visual meshes', () => {
    const node = new NodeBase({ id: 'sprite' });
    const { mesh, geometry, material } = meshWithSpies();
    node.add(mesh);
    const geometrySpy = vi.spyOn(geometry, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');

    node.dispose();

    expect(geometrySpy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
  });

  it('recurses into NodeBase children, disposing their resources too', () => {
    const parent = new NodeBase({ id: 'parent' });
    const child = new NodeBase({ id: 'child' });
    const { mesh, geometry } = meshWithSpies();
    child.add(mesh);
    parent.adoptChild(child);
    const childGeometrySpy = vi.spyOn(geometry, 'dispose');

    parent.dispose();

    expect(childGeometrySpy).toHaveBeenCalledTimes(1);
    // Child is detached from its parent as part of teardown.
    expect(parent.children).toHaveLength(0);
  });

  it('drops component references without firing onDetach (that is the runner’s job)', () => {
    const node = new NodeBase({ id: 'scripted' });
    const script = new DetachSpyScript('script', 'DetachSpyScript');
    node.addComponent(script);

    node.dispose();

    expect(script.detachCalls).toBe(0);
    expect(node.components).toHaveLength(0);
    expect(script.node).toBeNull();
  });

  it('is idempotent — a second dispose is a no-op', () => {
    const node = new NodeBase({ id: 'sprite' });
    const { mesh, geometry } = meshWithSpies();
    node.add(mesh);
    const geometrySpy = vi.spyOn(geometry, 'dispose');

    node.dispose();
    node.dispose();

    expect(geometrySpy).toHaveBeenCalledTimes(1);
  });
});
