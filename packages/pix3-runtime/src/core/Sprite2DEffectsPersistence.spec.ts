import { describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { BATCHABLE_2D_KEY } from './batch-2d';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Button2D } from '../nodes/2D/UI/Button2D';
import type { NodeBase } from '../nodes/NodeBase';
import { ShaderEffectStack } from '../shader-effects/ShaderEffectStack';

function makeLoader(): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  return new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
}

function serialize(node: NodeBase): string {
  return new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });
}

/** The batchable child render mesh of a 2D node. */
function renderMesh(node: NodeBase): Mesh {
  const meshes = node.children.filter(c => (c as { isMesh?: boolean }).isMesh) as unknown as Mesh[];
  return meshes.find(m => m.userData[BATCHABLE_2D_KEY] !== undefined) ?? meshes[0];
}

describe('Sprite2D / Button2D shader-effects', () => {
  it('round-trips an attached effect through SceneSaver + reload (Sprite2D)', async () => {
    const sprite = new Sprite2D({ id: 'fx-sprite' });
    expect(sprite.attachEffect('core:adjust', { params: { brightness: 1.5 } })).toBe(true);

    const yaml = serialize(sprite);
    expect(yaml).toContain('type: Sprite2D');
    expect(yaml).toContain('effects:');
    expect(yaml).toContain('type: core:adjust');
    expect(yaml).toContain('brightness: 1.5');
    // Default params (saturation/contrast) are omitted.
    expect(yaml).not.toContain('saturation:');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as Sprite2D;
    expect(loaded).toBeInstanceOf(Sprite2D);
    expect(loaded.getAttachedEffects().map(e => e.type)).toEqual(['core:adjust']);
    expect(loaded.getShaderEffectStack().getParam('adjust', 'brightness')).toBeCloseTo(1.5);
    // A default-valued param is restored to its registry default.
    expect(loaded.getShaderEffectStack().getParam('adjust', 'saturation')).toBeCloseTo(1);
  });

  it('drops the effects key when the stack empties (detach-all)', () => {
    const sprite = new Sprite2D({ id: 'fx-sprite' });
    sprite.attachEffect('core:grayscale');
    expect(serialize(sprite)).toContain('effects:');

    sprite.detachEffect('core:grayscale');
    expect(serialize(sprite)).not.toContain('effects:');
  });

  it('round-trips an attached effect on a Button2D skin', async () => {
    const button = new Button2D({ id: 'fx-button' });
    expect(button.attachEffect('core:tint', { params: { amount: 0.5 } })).toBe(true);

    const yaml = serialize(button);
    expect(yaml).toContain('type: Button2D');
    expect(yaml).toContain('type: core:tint');
    expect(yaml).toContain('amount: 0.5');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as Button2D;
    expect(loaded).toBeInstanceOf(Button2D);
    expect(loaded.getAttachedEffects().map(e => e.type)).toEqual(['core:tint']);
    expect(loaded.getShaderEffectStack().getParam('tint', 'amount')).toBeCloseTo(0.5);
  });

  it('opts the mesh out of the 2D batcher while an effect is attached', () => {
    const sprite = new Sprite2D({ id: 'batch-sprite' });
    const mesh = renderMesh(sprite);
    expect(mesh.userData[BATCHABLE_2D_KEY]).toBe(true);

    sprite.attachEffect('core:adjust');
    expect(mesh.userData[BATCHABLE_2D_KEY]).toBe(false);

    sprite.detachEffect('core:adjust');
    expect(mesh.userData[BATCHABLE_2D_KEY]).toBe(true);
  });

  it('refuses a standard-only effect on a basic (2D) host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sprite = new Sprite2D({ id: 'gate-sprite' });
    expect(sprite.attachEffect('core:rim')).toBe(false);
    expect(sprite.getAttachedEffects()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drives the defines of every installed material from one stack', () => {
    const stack = new ShaderEffectStack({ nodeType: 'Test', target: 'basic' });
    const m1 = new MeshBasicMaterial();
    const m2 = new MeshBasicMaterial();
    stack.install(m1);
    stack.install(m2);

    stack.attach('core:grayscale');
    expect(m1.defines?.PIX3_FX_GRAYSCALE).toBeDefined();
    expect(m2.defines?.PIX3_FX_GRAYSCALE).toBeDefined();

    const v1 = m1.version;
    const v2 = m2.version;
    stack.setEnabled('core:grayscale', false);
    expect(m1.defines?.PIX3_FX_GRAYSCALE).toBeUndefined();
    expect(m2.defines?.PIX3_FX_GRAYSCALE).toBeUndefined();
    expect(m1.version).toBeGreaterThan(v1);
    expect(m2.version).toBeGreaterThan(v2);
  });

  it('injects a color_fragment chunk into a meshbasic-shaped shader', () => {
    const material = new MeshBasicMaterial();
    const stack = new ShaderEffectStack({ nodeType: 'Test', target: 'basic' });
    stack.install(material);
    stack.attach('core:tint');

    const shader = {
      vertexShader: 'void main() {\n#include <uv_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}',
      uniforms: {} as Record<string, { value: unknown }>,
    };
    (material.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);

    expect(shader.fragmentShader).toContain('#ifdef PIX3_FX_TINT');
    expect(shader.fragmentShader).toContain('uniform vec3 uPix3TintColor;');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix(diffuseColor.rgb');
    // Uniform refs shared into the compiled program.
    const attached = stack.getAttached()[0];
    expect(shader.uniforms.uPix3TintColor).toBe(attached.uniforms.uPix3TintColor);
    // Cache key reflects the attached set.
    const key = (material.customProgramCacheKey as () => string)();
    expect(key).toContain('core:tint');
  });
});
