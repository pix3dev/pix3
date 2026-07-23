import { describe, expect, it } from 'vitest';
import { SceneValidationError, type SceneGraph, type SceneManager } from '@pix3/runtime';
import {
  ALLOWED_SCENE_NODE_TYPES,
  collectResAndTypeIssues,
  normalizeResPath,
  validateSceneYaml,
} from '@/services/model-gen/scene/scene-validate';

const KNOWN_PATHS = new Set(['models/rock.glb', 'prefabs/shrine.pix3scene']);

/** A stub SceneManager whose parseScene either resolves a graph or rejects. */
function stubSceneManager(behavior: {
  graph?: SceneGraph;
  error?: unknown;
}): SceneManager {
  return {
    async parseScene(): Promise<SceneGraph> {
      if (behavior.error) {
        throw behavior.error;
      }
      return behavior.graph ?? emptyGraph();
    },
  } as unknown as SceneManager;
}

function emptyGraph(): SceneGraph {
  return { version: '1.0', rootNodes: [], nodeMap: new Map(), metadata: {} };
}

describe('collectResAndTypeIssues', () => {
  it('reports nothing for a clean doc with allowed types and known refs', () => {
    const doc = {
      version: '1.0',
      root: [
        {
          id: 'ground',
          type: 'GeometryMesh',
          properties: { geometry: 'plane', material: { type: 'standard', color: '#888888' } },
          children: [{ id: 'rock', type: 'MeshInstance', properties: { src: 'res://models/rock.glb' } }],
        },
      ],
    };
    expect(collectResAndTypeIssues(doc, ALLOWED_SCENE_NODE_TYPES, KNOWN_PATHS)).toEqual([]);
  });

  it('flags an unknown node type', () => {
    const doc = { root: [{ id: 'a', type: 'NotARealNode' }] };
    const errors = collectResAndTypeIssues(doc, ALLOWED_SCENE_NODE_TYPES, KNOWN_PATHS);
    expect(errors.some(error => error.includes('NotARealNode'))).toBe(true);
  });

  it('does NOT flag component or material type fields as node types', () => {
    const doc = {
      root: [
        {
          id: 'a',
          type: 'GeometryMesh',
          properties: { material: { type: 'physical' } },
          components: [{ type: 'core:Spin' }],
        },
      ],
    };
    expect(collectResAndTypeIssues(doc, ALLOWED_SCENE_NODE_TYPES, KNOWN_PATHS)).toEqual([]);
  });

  it('flags a dangling res:// reference', () => {
    const doc = {
      root: [{ id: 'a', type: 'MeshInstance', properties: { src: 'res://models/ghost.glb' } }],
    };
    const errors = collectResAndTypeIssues(doc, ALLOWED_SCENE_NODE_TYPES, KNOWN_PATHS);
    expect(errors.some(error => error.includes('ghost.glb'))).toBe(true);
  });

  it('accepts a prefab instance (no type) whose instance path is known', () => {
    const doc = { root: [{ id: 'a', instance: 'res://prefabs/shrine.pix3scene' }] };
    expect(collectResAndTypeIssues(doc, ALLOWED_SCENE_NODE_TYPES, KNOWN_PATHS)).toEqual([]);
  });

  it('flags a prefab instance whose instance path is unknown', () => {
    const doc = { root: [{ id: 'a', instance: 'res://prefabs/missing.pix3scene' }] };
    const errors = collectResAndTypeIssues(doc, ALLOWED_SCENE_NODE_TYPES, KNOWN_PATHS);
    expect(errors.some(error => error.includes('missing.pix3scene'))).toBe(true);
  });

  it('normalizes windows slashes and res:// prefixes consistently', () => {
    expect(normalizeResPath('res://models\\rock.glb')).toBe('models/rock.glb');
    expect(normalizeResPath('./models/rock.glb')).toBe('models/rock.glb');
  });
});

describe('validateSceneYaml', () => {
  const cleanYaml = [
    'version: "1.0"',
    'root:',
    '  - id: ground',
    '    type: GeometryMesh',
    '    properties:',
    '      geometry: plane',
  ].join('\n');

  it('passes a valid scene and returns the graph', async () => {
    const graph = emptyGraph();
    const result = await validateSceneYaml(cleanYaml, stubSceneManager({ graph }), {
      knownAssetPaths: KNOWN_PATHS,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.graph).toBe(graph);
  });

  it('surfaces SceneValidationError details and returns a null graph', async () => {
    const error = new SceneValidationError('bad scene', ['duplicate id "ground"']);
    const result = await validateSceneYaml(cleanYaml, stubSceneManager({ error }), {
      knownAssetPaths: KNOWN_PATHS,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('duplicate id "ground"');
    expect(result.graph).toBeNull();
  });

  it('fails an unknown node type even when parseScene resolves', async () => {
    const yaml = ['version: "1.0"', 'root:', '  - id: a', '    type: BogusNode'].join('\n');
    const result = await validateSceneYaml(yaml, stubSceneManager({ graph: emptyGraph() }), {
      knownAssetPaths: KNOWN_PATHS,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(errorText => errorText.includes('BogusNode'))).toBe(true);
    expect(result.graph).toBeNull();
  });

  it('fails a dangling res:// reference even when parseScene resolves', async () => {
    const yaml = [
      'version: "1.0"',
      'root:',
      '  - id: a',
      '    type: MeshInstance',
      '    properties:',
      "      src: 'res://models/ghost.glb'",
    ].join('\n');
    const result = await validateSceneYaml(yaml, stubSceneManager({ graph: emptyGraph() }), {
      knownAssetPaths: KNOWN_PATHS,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(errorText => errorText.includes('ghost.glb'))).toBe(true);
  });
});
