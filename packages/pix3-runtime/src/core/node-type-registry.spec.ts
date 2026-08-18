import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_SCENE_NODE_TYPES,
  describeUnknownNodeType,
  isKnownSceneNodeType,
  resolveSceneNodeType,
  suggestSceneNodeType,
} from './node-type-registry';

/** The `case` labels of `SceneLoader.createNodeFromDefinition`'s switch, read from source. */
const loaderCaseLabels = (): string[] => {
  const source = readFileSync(
    `${process.cwd()}/packages/pix3-runtime/src/core/SceneLoader.ts`,
    'utf8'
  );
  const start = source.indexOf('async createNodeFromDefinition');
  expect(start, 'createNodeFromDefinition not found in SceneLoader').toBeGreaterThan(-1);
  // The switch ends at its `default:` arm — the method calls other loaders by name before that,
  // so anchoring on a callee name would cut the body short.
  const end = source.indexOf('      default:', start);
  expect(end, 'the node-type switch has no default arm any more').toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...new Set([...body.matchAll(/case '([A-Za-z0-9_]+)':/g)].map(match => match[1]))];
};

describe('scene node type vocabulary', () => {
  it('knows every type the loader can build', () => {
    // Drift guard: a new `case` in SceneLoader without an entry here would be a type that loads
    // fine but reads as "unknown" to the lint and the did-you-mean — the exact silence this
    // module exists to end.
    const known = new Set(KNOWN_SCENE_NODE_TYPES);
    const missing = loaderCaseLabels().filter(type => !known.has(type));

    expect(
      missing,
      `SceneLoader builds node type(s) the vocabulary does not list: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('lists no type the loader cannot build', () => {
    const cases = new Set(loaderCaseLabels());
    const phantom = KNOWN_SCENE_NODE_TYPES.filter(type => !cases.has(type));

    expect(
      phantom,
      `Vocabulary lists type(s) with no SceneLoader case: ${phantom.join(', ')}`
    ).toEqual([]);
  });

  it('resolves the light spellings a scene-tree dump teaches you to write', () => {
    // `node.type` reports the un-suffixed name, so this is what gets copied back into YAML.
    expect(resolveSceneNodeType('DirectionalLight')).toBe('DirectionalLightNode');
    expect(resolveSceneNodeType('DirectionalLight3D')).toBe('DirectionalLightNode');
    expect(resolveSceneNodeType('ambient-light')).toBe('AmbientLightNode');
    expect(resolveSceneNodeType('HemisphereLight')).toBe('HemisphereLightNode');
    expect(resolveSceneNodeType('PointLight3D')).toBe('PointLightNode');
    expect(resolveSceneNodeType('SpotLight')).toBe('SpotLightNode');
    expect(resolveSceneNodeType('MeshInstance3D')).toBe('MeshInstance');
  });

  it('resolves case and separator variants of a canonical name', () => {
    expect(resolveSceneNodeType('sprite2d')).toBe('Sprite2D');
    expect(resolveSceneNodeType('Geometry Mesh')).toBe('GeometryMesh');
    expect(isKnownSceneNodeType('button2D')).toBe(true);
  });

  it('reports genuinely unknown types as unknown', () => {
    expect(resolveSceneNodeType('VoxelChunk3D')).toBeNull();
    expect(resolveSceneNodeType('')).toBeNull();
    expect(resolveSceneNodeType(undefined)).toBeNull();
    expect(isKnownSceneNodeType('VoxelChunk3D')).toBe(false);
  });

  it('suggests a near miss and stays quiet on a far one', () => {
    expect(suggestSceneNodeType('Sprit2D')).toBe('Sprite2D');
    expect(suggestSceneNodeType('Labl2D')).toBe('Label2D');
    expect(suggestSceneNodeType('CompletelyMadeUpThing')).toBeUndefined();
    // The commonest invention is an extra word, not a typo — distance never catches those.
    expect(suggestSceneNodeType('DirectionalLightSource')).toBe('DirectionalLightNode');
    expect(suggestSceneNodeType('VoxelSprite2DThing')).toBe('Sprite2D');
  });

  it('names the fix in the message', () => {
    const message = describeUnknownNodeType('Sun', 'DirectionalLights');
    expect(message).toContain('"DirectionalLights"');
    expect(message).toContain('"Sun"');
    expect(message).toContain('inert');
    expect(message).toContain('DirectionalLightNode');
  });
});
