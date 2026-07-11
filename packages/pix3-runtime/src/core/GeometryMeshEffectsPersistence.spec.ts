import { describe, expect, it, vi } from 'vitest';
import { MeshStandardMaterial, ShaderLib, Texture } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';
import { getNodePropertySchema } from '../fw/property-schema-utils';
import { createClipBindings, applyClipAtTime } from '../animation/clip-evaluator';
import type { KeyframeClip } from '../animation/keyframe-types';

function makeLoader(preloadTextures: string[] = []): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
  for (const url of preloadTextures) {
    cache.set(url, new Texture());
  }
  return new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
}

function serialize(node: GeometryMesh): string {
  return new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });
}

/** Read a property the way a schema consumer does — through the instance-merged schema. */
function getProp(node: GeometryMesh, name: string): unknown {
  const def = getNodePropertySchema(node).properties.find(p => p.name === name);
  if (!def) throw new Error(`no such property: ${name}`);
  return def.getValue(node);
}

function setProp(node: GeometryMesh, name: string, value: unknown): void {
  const def = getNodePropertySchema(node).properties.find(p => p.name === name);
  if (!def) throw new Error(`no such property: ${name}`);
  def.setValue(node, value);
}

function stdMaterial(node: GeometryMesh): MeshStandardMaterial {
  const mesh = node.children.find(c => (c as { isMesh?: boolean }).isMesh) as unknown as {
    material: MeshStandardMaterial;
  };
  return mesh.material;
}

function makeMesh(effects?: Array<string | Record<string, unknown>>): GeometryMesh {
  const entries = effects?.map(e => (typeof e === 'string' ? { type: e } : e));
  return new GeometryMesh({
    id: 'fx-box',
    geometry: 'box',
    size: [1, 1, 1],
    material: entries
      ? { color: '#ffffff', effects: entries as unknown as never }
      : { color: '#ffffff' },
  });
}

describe('GeometryMesh shader-effects (list model)', () => {
  it('exposes attached-effect params via the instance schema, not the static schema', () => {
    const mesh = makeMesh();
    // Static schema never carries fx.* props (the tripwire against a future
    // direct `getPropertySchema()` call that would bypass the instance merge).
    const staticNames = GeometryMesh.getPropertySchema().properties.map(p => p.name);
    expect(staticNames.some(n => n.startsWith('fx.'))).toBe(false);

    expect(getNodePropertySchema(mesh).properties.some(n => n.name.startsWith('fx.'))).toBe(false);

    mesh.attachEffect('core:dissolve');
    const names = getNodePropertySchema(mesh).properties.map(p => p.name);
    expect(names).toContain('fx.dissolve.enabled');
    expect(names).toContain('fx.dissolve.amount');
    expect(names).toContain('fx.dissolve.edgeColor');
    // still absent from the static schema
    expect(GeometryMesh.getPropertySchema().properties.some(p => p.name.startsWith('fx.'))).toBe(
      false
    );

    mesh.detachEffect('core:dissolve');
    expect(getNodePropertySchema(mesh).properties.some(p => p.name.startsWith('fx.'))).toBe(false);
  });

  it('keeps instance-schema property definitions stable until the attach-list changes', () => {
    const mesh = makeMesh(['core:dissolve']);
    const a = getNodePropertySchema(mesh).properties.find(p => p.name === 'fx.dissolve.amount');
    const b = getNodePropertySchema(mesh).properties.find(p => p.name === 'fx.dissolve.amount');
    expect(a).toBe(b); // cached (identity-stable) across calls
    mesh.attachEffect('core:rim');
    const c = getNodePropertySchema(mesh).properties.find(p => p.name === 'fx.dissolve.amount');
    expect(c).not.toBe(a); // rebuilt after an attach
  });

  it('round-trips a numeric param through schema + uniform, and a color as sRGB hex', () => {
    const mesh = makeMesh(['core:dissolve']);
    setProp(mesh, 'fx.dissolve.amount', 0.4);
    expect(getProp(mesh, 'fx.dissolve.amount')).toBeCloseTo(0.4);
    const uniforms = mesh.getAttachedEffects()[0].uniforms as {
      uPix3DissolveAmount: { value: number };
    };
    expect(uniforms.uPix3DissolveAmount.value).toBeCloseTo(0.4);

    setProp(mesh, 'fx.dissolve.edgeColor', '#00ff00');
    expect(getProp(mesh, 'fx.dissolve.edgeColor')).toBe('#00ff00');
  });

  it('toggles the material define on/off with a recompile', () => {
    const mesh = makeMesh(['core:dissolve']);
    const material = stdMaterial(mesh);
    expect(material.defines?.PIX3_FX_DISSOLVE).toBeDefined(); // enabled by default

    const versionBefore = material.version;
    setProp(mesh, 'fx.dissolve.enabled', false);
    expect(material.defines?.PIX3_FX_DISSOLVE).toBeUndefined();
    expect(material.version).toBeGreaterThan(versionBefore);

    setProp(mesh, 'fx.dissolve.enabled', true);
    expect(material.defines?.PIX3_FX_DISSOLVE).toBeDefined();
  });

  it('skips unknown effect types on attach', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = makeMesh([{ type: 'core:bogus' }, { type: 'core:rim' }]);
    expect(mesh.getAttachedEffects().map(e => e.type)).toEqual(['core:rim']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('serializes an ordered array of only non-default params, and reloads it', async () => {
    const mesh = makeMesh(['core:dissolve', 'core:flash']);
    setProp(mesh, 'fx.dissolve.amount', 0.6);
    setProp(mesh, 'fx.dissolve.edgeColor', '#123456');
    setProp(mesh, 'fx.flash.enabled', false);

    const yaml = serialize(mesh);
    expect(yaml).toContain('effects:');
    expect(yaml).toContain('type: core:dissolve');
    expect(yaml).toContain('type: core:flash');
    expect(yaml).toContain('enabled: false'); // flash
    expect(yaml).toContain('amount: 0.6');
    expect(yaml).toContain('123456'); // edgeColor hex (YAML quotes the leading '#')
    // Default params (dissolve.scale/edgeWidth) are omitted → the reload below
    // restores them to their registry defaults.

    const graph = await makeLoader().parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as GeometryMesh;
    const types = loaded.getAttachedEffects().map(e => e.type);
    expect(types).toEqual(['core:dissolve', 'core:flash']); // order preserved
    expect(getProp(loaded, 'fx.dissolve.amount')).toBeCloseTo(0.6);
    expect(getProp(loaded, 'fx.dissolve.edgeColor')).toBe('#123456');
    expect(getProp(loaded, 'fx.dissolve.scale')).toBeCloseTo(8); // default restored
    expect(getProp(loaded, 'fx.flash.enabled')).toBe(false);

    const mat = stdMaterial(loaded);
    expect(mat.defines?.PIX3_FX_DISSOLVE).toBeDefined();
    expect(mat.defines?.PIX3_FX_FLASH).toBeUndefined(); // disabled → no define
  });

  it('injects composed GLSL at every anchor, ordered by attachment (guards three upgrades)', () => {
    const mesh = makeMesh(['core:dissolve', 'core:rim', 'core:uv-scroll', 'core:flash']);
    const material = stdMaterial(mesh);
    expect(material.onBeforeCompile).toBeTypeOf('function');

    const shader = {
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    };
    (material.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);

    // Every anchor matched.
    expect(shader.vertexShader).toContain('vPix3Uv = uv;');
    expect(shader.vertexShader).toContain('vMapUv += uPix3UvOffset;');
    expect(shader.fragmentShader).toContain('uniform float uPix3DissolveAmount;');
    expect(shader.fragmentShader).toContain('if (pix3N < 0.0) discard;');
    expect(shader.fragmentShader).toContain('outgoingLight = mix(outgoingLight, uPix3FlashColor');
    // Chunk order follows attach order (dissolve before rim at the same anchor).
    expect(shader.fragmentShader.indexOf('#ifdef PIX3_FX_DISSOLVE')).toBeLessThan(
      shader.fragmentShader.indexOf('#ifdef PIX3_FX_RIM')
    );
    // Uniform refs shared into the compiled program.
    const flashUniforms = mesh.getAttachedEffects().find(e => e.type === 'core:flash')!.uniforms;
    expect(shader.uniforms.uPix3FlashColor).toBe(flashUniforms.uPix3FlashColor);

    // Cache key reflects the set + order.
    const key = (material.customProgramCacheKey as () => string)();
    expect(key).toBe('pix3-gmesh-fx-v2:core:dissolve+core:rim+core:uv-scroll+core:flash');
    const other = makeMesh(['core:rim', 'core:dissolve']);
    const otherKey = (stdMaterial(other).customProgramCacheKey as () => string)();
    expect(otherKey).not.toBe(key);
  });

  it('advances uv-scroll only when enabled, and still ticks components', () => {
    const mesh = makeMesh(['core:uv-scroll']);
    setProp(mesh, 'fx.uvScroll.speed', { x: 0.2, y: 0 });
    setProp(mesh, 'fx.uvScroll.enabled', false);

    let updates = 0;
    mesh.components.push({
      id: 'stub',
      type: 'test:stub',
      node: mesh,
      enabled: true,
      config: {},
      _started: false,
      onUpdate: () => {
        updates += 1;
      },
    });

    const offset = mesh.getAttachedEffects()[0].uniforms.uPix3UvOffset as {
      value: { x: number; y: number };
    };
    mesh.tick(0.5); // disabled → no advance, but components still tick
    expect(offset.value.x).toBeCloseTo(0);
    expect(updates).toBe(1);

    setProp(mesh, 'fx.uvScroll.enabled', true);
    mesh.tick(0.5);
    expect(offset.value.x).toBeCloseTo(0.1);
    expect(updates).toBe(2);
  });

  it('binds and drives an fx param from a keyframe clip', () => {
    const mesh = makeMesh(['core:dissolve']);
    const clip: KeyframeClip = {
      name: 'dissolve',
      duration: 1,
      loop: false,
      tracks: [
        {
          id: 't1',
          kind: 'property',
          targetPath: '',
          property: 'fx.dissolve.amount',
          valueType: 'number',
          enabled: true,
          keys: [
            { time: 0, value: 0, easing: 'linear' },
            { time: 1, value: 1, easing: 'linear' },
          ],
        },
      ],
    };
    const binding = createClipBindings(mesh, clip);
    expect(binding.missingTargets).toEqual([]);
    expect(binding.entries).toHaveLength(1);

    applyClipAtTime(binding, 1);
    expect(getProp(mesh, 'fx.dissolve.amount')).toBeCloseTo(1);
    const uniforms = mesh.getAttachedEffects()[0].uniforms as {
      uPix3DissolveAmount: { value: number };
    };
    expect(uniforms.uPix3DissolveAmount.value).toBeCloseTo(1);
  });
});
