import { describe, expect, it } from 'vitest';

import { generateSceneNodesLib } from './scene-nodes-dts';

/**
 * Minimal stand-ins for runtime node classes. The generator only relies on the
 * prototype chain and static `getPropertySchema().nodeType`, so tiny classes
 * suffice — no Three.js needed.
 */
class NodeBase {
  static getPropertySchema() {
    return { nodeType: 'Node' };
  }
}
class Node2D extends NodeBase {
  static getPropertySchema() {
    return { nodeType: 'Node2D' };
  }
}
class Sprite2D extends Node2D {
  static getPropertySchema() {
    return { nodeType: 'Sprite2D' };
  }
}
class Label2D extends Node2D {
  static getPropertySchema() {
    return { nodeType: 'Label2D' };
  }
}
class DirectionalLightNode extends NodeBase {
  // Scene `type` differs from the class name — the classic mismatch case.
  static getPropertySchema() {
    return { nodeType: 'DirectionalLight' };
  }
}

const RUNTIME_EXPORTS: Record<string, unknown> = {
  NodeBase,
  Node2D,
  Sprite2D,
  Label2D,
  DirectionalLightNode,
  // A non-node export that must be ignored:
  assignRenderOrder: () => undefined,
};

interface FakeNode {
  nodeId: string;
  name: string;
  type: string;
  children?: FakeNode[];
}

const node = (nodeId: string, name: string, type: string, children?: FakeNode[]): FakeNode => ({
  nodeId,
  name,
  type,
  children,
});

describe('generateSceneNodesLib', () => {
  it('emits typed path and bare-name keys for a single scene', () => {
    const roots = [
      node('1', 'Root', 'Node2D', [node('2', 'Hero', 'Sprite2D'), node('3', 'Score', 'Label2D')]),
    ];

    const lib = generateSceneNodesLib([roots], RUNTIME_EXPORTS);

    expect(lib).toContain("declare module '@pix3/runtime'");
    expect(lib).toContain('interface SceneNodeNames');
    // bare names (unique) + full paths
    expect(lib).toContain('"Hero": Sprite2D;');
    expect(lib).toContain('"Root/Hero": Sprite2D;');
    expect(lib).toContain('"Score": Label2D;');
    // only the classes actually used are imported, plus NodeBase
    expect(lib).toMatch(
      /import type \{ Label2D, Node2D, NodeBase, Sprite2D \} from '@pix3\/runtime';/
    );
  });

  it('maps a scene type that differs from the class name', () => {
    const roots = [node('1', 'Sun', 'DirectionalLight')];
    const lib = generateSceneNodesLib([roots], RUNTIME_EXPORTS);
    expect(lib).toContain('"Sun": DirectionalLightNode;');
  });

  it('falls back to NodeBase for an unknown node type', () => {
    const roots = [node('1', 'Mystery', 'SomeFutureNode')];
    const lib = generateSceneNodesLib([roots], RUNTIME_EXPORTS);
    expect(lib).toContain('"Mystery": NodeBase;');
  });

  it('drops ambiguous bare names but keeps their paths', () => {
    const sceneA = [node('1', 'A', 'Node2D', [node('2', 'Icon', 'Sprite2D')])];
    const sceneB = [node('3', 'B', 'Node2D', [node('4', 'Icon', 'Label2D')])];

    const lib = generateSceneNodesLib([sceneA, sceneB], RUNTIME_EXPORTS);

    // Ambiguous bare "Icon" (Sprite2D vs Label2D) is omitted...
    expect(lib).not.toContain('"Icon":');
    // ...but the distinct paths survive.
    expect(lib).toContain('"A/Icon": Sprite2D;');
    expect(lib).toContain('"B/Icon": Label2D;');
  });

  it('widens a conflicting path to the nearest common base', () => {
    // Same path "Root/Thing" resolves to Sprite2D in one scene, Label2D in the
    // other → widen to their common ancestor Node2D.
    const sceneA = [node('1', 'Root', 'Node2D', [node('2', 'Thing', 'Sprite2D')])];
    const sceneB = [node('3', 'Root', 'Node2D', [node('4', 'Thing', 'Label2D')])];

    const lib = generateSceneNodesLib([sceneA, sceneB], RUNTIME_EXPORTS);
    expect(lib).toContain('"Root/Thing": Node2D;');
  });

  it('returns a no-op module when there are no named nodes', () => {
    expect(generateSceneNodesLib([], RUNTIME_EXPORTS)).toBe('export {};\n');
    expect(generateSceneNodesLib([[]], RUNTIME_EXPORTS)).toBe('export {};\n');
  });

  it('descends through unnamed nodes and ignores non-scene children', () => {
    const roots = [node('1', '', 'Node2D', [node('2', 'Deep', 'Sprite2D')])];
    // Inject a THREE-style child with no nodeId that must be skipped.
    (roots[0].children as unknown[]).push({ type: 'Mesh', name: 'InternalMesh' });

    const lib = generateSceneNodesLib([roots], RUNTIME_EXPORTS);
    expect(lib).toContain('"Deep": Sprite2D;');
    expect(lib).not.toContain('InternalMesh');
  });
});
