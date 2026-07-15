import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { ScriptRegistry } from './ScriptRegistry';
import { Script } from './ScriptComponent';
import type { PropertyDefinition, PropertySchema } from '../fw/property-schema';

/**
 * A user-authored component whose static getPropertySchema() forgets the
 * `properties` array — a common mistake in project scripts. Loading a scene
 * that references such a component must not abort the whole scene load.
 */
class MalformedSchemaComponent extends Script {
  static override getPropertySchema(): PropertySchema {
    // Intentionally missing `properties: []`.
    return { nodeType: 'MalformedSchemaComponent' } as unknown as PropertySchema;
  }
}

/**
 * A component whose schema has one well-formed property and one malformed entry
 * that forgets its `getValue`/`setValue` closures — a common AI/hand-authoring
 * mistake (returning bare `{ name, type }` objects). The good property must still
 * apply; only the bad one is skipped, and the load must not throw.
 */
class PartlyMalformedPropertyComponent extends Script {
  speed = 0;

  static override getPropertySchema(): PropertySchema {
    return {
      nodeType: 'PartlyMalformedPropertyComponent',
      properties: [
        {
          name: 'speed',
          type: 'number',
          getValue: (node: unknown) => (node as PartlyMalformedPropertyComponent).speed,
          setValue: (node: unknown, value: unknown) => {
            (node as PartlyMalformedPropertyComponent).speed = value as number;
          },
        },
        // Malformed: no getValue/setValue closures.
        { name: 'brokenProp', type: 'number' } as unknown as PropertyDefinition,
      ],
    };
  }
}

function makeLoader(): { loader: SceneLoader; registry: ScriptRegistry } {
  const registry = new ScriptRegistry();
  const loader = new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    registry,
    new ResourceManager('/')
  );
  return { loader, registry };
}

const SCENE_YAML = `version: '1.0.0'
root:
  - id: panel
    type: ColorRect2D
    name: Panel
    components:
      - id: comp-1
        type: 'user:MalformedSchemaComponent'
        enabled: true
        config:
          foo: 42
`;

describe('SceneLoader component schema robustness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not abort scene load when a component schema is missing its properties array', async () => {
    const { loader, registry } = makeLoader();
    registry.registerComponent({
      id: 'user:MalformedSchemaComponent',
      displayName: 'MalformedSchemaComponent',
      description: 'test',
      category: 'Project',
      componentClass: MalformedSchemaComponent,
      keywords: [],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const graph = await loader.parseScene(SCENE_YAML, {
      filePath: 'res://scenes/main.pix3scene',
    });

    // The scene loads and the node is created with its component still attached.
    expect(graph.rootNodes).toHaveLength(1);
    const root = graph.rootNodes[0];
    expect(root.components).toHaveLength(1);
    expect(root.components[0].type).toBe('user:MalformedSchemaComponent');

    // The malformed schema is reported (naming the component) rather than thrown.
    expect(
      warnSpy.mock.calls.some(
        ([message]) =>
          typeof message === 'string' &&
          message.includes('MalformedSchemaComponent') &&
          message.includes('malformed property schema')
      )
    ).toBe(true);
  });

  it('applies well-formed properties and skips a property definition missing setValue', async () => {
    const { loader, registry } = makeLoader();
    registry.registerComponent({
      id: 'user:PartlyMalformedPropertyComponent',
      displayName: 'PartlyMalformedPropertyComponent',
      description: 'test',
      category: 'Project',
      componentClass: PartlyMalformedPropertyComponent,
      keywords: [],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const yaml = `version: '1.0.0'
root:
  - id: panel
    type: ColorRect2D
    name: Panel
    components:
      - id: comp-1
        type: 'user:PartlyMalformedPropertyComponent'
        enabled: true
        config:
          speed: 7
          brokenProp: 42
`;

    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });

    // The scene loads and the well-formed property was applied from config.
    expect(graph.rootNodes).toHaveLength(1);
    const component = graph.rootNodes[0].components[0] as PartlyMalformedPropertyComponent;
    expect(component.speed).toBe(7);

    // The malformed property is reported (naming it) rather than thrown.
    expect(
      warnSpy.mock.calls.some(
        ([message]) =>
          typeof message === 'string' &&
          message.includes('brokenProp') &&
          message.includes('malformed property definition')
      )
    ).toBe(true);
  });
});
