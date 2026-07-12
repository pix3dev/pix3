import { describe, expect, it } from 'vitest';
import { NodeBase } from '@pix3/runtime';
import {
  clearErrors,
  componentToDTO,
  errors,
  installErrorCapture,
  liveObjectToDTO,
  nodeToDTO,
  safeSerialize,
  type Object3DLike,
} from './agent-introspection';

describe('agent-introspection', () => {
  describe('safeSerialize', () => {
    it('collapses pure vectors and preserves richer objects', () => {
      expect(safeSerialize({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
      expect(safeSerialize({ x: 1, y: 2, z: 3, w: 4 })).toEqual({ x: 1, y: 2, z: 3, w: 4 });
      // An object that merely carries x/y/z plus another key must NOT be flattened.
      expect(safeSerialize({ x: 1, y: 2, z: 3, label: 'p' })).toEqual({
        x: 1,
        y: 2,
        z: 3,
        label: 'p',
      });
    });

    it('drops functions and underscore-prefixed keys, truncates depth', () => {
      const out = safeSerialize({ keep: 1, fn: () => 0, _hidden: 2 }, 2) as Record<string, unknown>;
      expect(out.keep).toBe(1);
      expect(out.fn).toBeNull();
      expect('_hidden' in out).toBe(false);
      expect(safeSerialize({ a: { b: { c: 1 } } }, 0)).toBe('[Object]');
    });
  });

  it('componentToDTO exposes data fields and skips framework refs', () => {
    const dto = componentToDTO({ scriptId: 'core:spin', speed: 2, node: {}, _internal: 1 }, 3);
    expect(dto).toMatchObject({ index: 3, scriptId: 'core:spin' });
    // state carries the component's own data fields (incl. scriptId), but never framework refs
    // (node/input/scene/constructor) or underscore-prefixed internals.
    expect(dto.state).toEqual({ scriptId: 'core:spin', speed: 2 });
  });

  it('liveObjectToDTO reads three-object shape and flags', () => {
    const obj: Object3DLike = {
      type: 'Mesh',
      name: 'crate',
      uuid: 'u1',
      visible: true,
      renderOrder: 5,
      position: { x: 1.23456, y: 0, z: 0 },
      children: [],
      userData: { droppableItemRef: {} },
    };
    const dto = liveObjectToDTO(obj, 1);
    expect(dto).toMatchObject({
      threeType: 'Mesh',
      name: 'crate',
      uuid: 'u1',
      isNodeBase: false,
      nodeId: null,
      renderOrder: 5,
    });
    expect(dto.flags.droppable).toBe(true);
    expect(dto.worldPos).toEqual({ x: 1.235, y: 0, z: 0 });
  });

  it('nodeToDTO serialises a NodeBase-shaped fixture', () => {
    const node = Object.create(NodeBase.prototype) as Record<string, unknown>;
    Object.assign(node, {
      nodeId: 'n1',
      type: 'Node3D',
      name: 'Root',
      visible: true,
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      groups: ['ui'],
      components: [],
      children: [],
      properties: { color: '#fff' },
    });

    const dto = nodeToDTO(node as unknown as NodeBase, 0);
    expect(dto).toMatchObject({
      nodeId: 'n1',
      type: 'Node3D',
      name: 'Root',
      visible: true,
      componentCount: 0,
      groups: ['ui'],
    });
    expect(dto.transform.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(dto.properties).toEqual({ color: '#fff' });
  });

  it('captures console.error into the ring buffer', () => {
    installErrorCapture();
    clearErrors();
    console.error('smoke-test-error');
    const captured = errors();
    expect(captured.some(e => e.message.includes('smoke-test-error'))).toBe(true);
    clearErrors();
    expect(errors()).toEqual([]);
  });
});
