// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { registerBuiltInScripts } from '../behaviors/register-behaviors';
import { getNodePropertySchema } from '../fw/property-schema-utils';
import { NodeBase } from '../nodes/NodeBase';
import { describeUnknownNodeType, resolveSceneNodeType } from './node-type-registry';
import { isInertNode } from './renderability-lint';
import {
  DiskResourceManager,
  installCanvasOnlyDocument,
  MissingResourceError,
  NodeAssetLoader,
  ResourceNotDecodedError,
} from '../node';
import { isProjectScriptEntry, registerProjectScriptExports } from './project-script-registration';
import { getSceneNodeDiskFormat, resolveSceneDiskKey } from './scene-disk-format';
import { SceneLoader, SceneValidationError, type SceneNodeDefinition } from './SceneLoader';
import type { SceneGraph } from './SceneManager';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';

/**
 * The real `SceneLoader` in a plain Node environment — no happy-dom, no browser.
 *
 * This is the golden test for `pix3 validate` level 2 (`.plans/external-agent-authoring.md`, §5 A;
 * measurements in `.plans/measurements/external-agent-phase0-strict-profile.md`). Every scene and
 * prefab shipped under `src/templates/projects/` must hydrate through the real loader, with the
 * built-in `core:*` behaviours AND the template's own `user:*` scripts registered, and come out
 * with nothing parked, nothing inert, no missing `res://` texture and no loader warning.
 *
 * What Node needs, and nothing more (all of it in `@pix3/runtime/node`, which `pix3 validate` uses
 * too):
 * - A `ResourceManager` whose `fetchText`/`fetchBlob` read the project folder from disk (the base
 *   class resolves `res://x` to `/x` and would `fetch()` it, which Node refuses for a relative URL).
 * - An `AssetLoader` whose `loadTexture` checks the file exists and hands back an empty `Texture`
 *   (three's `TextureLoader` goes through `document.createElementNS('img')`) — `NodeAssetLoader`.
 * - A small `document.createElement('canvas')` shim (`installCanvasOnlyDocument`), because `Label2D` and every `UIControl2D`
 *   measure and paint their caption on a 2D canvas **in the constructor**. The first `describe`
 *   below pins that requirement; if it starts failing, the text nodes became lazy and the shim can
 *   go. Everything else — importing the runtime, `getPropertySchema()`, `registerBuiltInScripts`,
 *   importing the template scripts — needs no DOM at all.
 */

const TEMPLATES_ROOT = fileURLToPath(
  new URL('../../../../src/templates/projects/', import.meta.url)
);

/** Placeholders the project scaffolder substitutes on copy. */
const substitutePlaceholders = (text: string): string =>
  text.split('{{PROJECT_NAME}}').join('Validate Test');

/**
 * Authored keys the loader never reads — real defects in shipped templates. They load "fine" and do
 * nothing, which is exactly what `validate` exists to catch. Keyed `<template>/<file>#<nodeId>`.
 * When a template is fixed, delete its entry: the golden test demands this table match what it
 * finds, in both directions. (The disk-format table that decides "never read" is
 * `scene-disk-format.ts`, pinned against the loader and saver by `scene-disk-format.spec.ts`.)
 */
const KNOWN_TEMPLATE_DEFECTS: Readonly<Record<string, readonly string[]>> = {};

// --- Node harness (shared with `pix3 validate`: `@pix3/runtime/node`) -----------------------------

let uninstallDocument: () => void = () => {};

const installCanvasShim = (): void => {
  beforeAll(() => {
    uninstallDocument = installCanvasOnlyDocument();
  });
  afterAll(() => {
    uninstallDocument();
  });
};

/**
 * Register a template's `scripts/*.ts` the way `ProjectScriptLoaderService` does: every exported
 * class that extends `Script` becomes `user:<ExportName>` (`registerProjectScriptExports`).
 */
async function registerTemplateScripts(
  templateDir: string,
  registry: ScriptRegistry
): Promise<void> {
  const scriptsDir = join(templateDir, 'files', 'scripts');
  if (!existsSync(scriptsDir)) {
    return;
  }
  for (const file of readdirSync(scriptsDir).filter(entry => entry.endsWith('.ts'))) {
    const source = readFileSync(join(scriptsDir, file), 'utf8');
    if (!isProjectScriptEntry(`scripts/${file}`, source)) continue;
    const module = (await import(/* @vite-ignore */ join(scriptsDir, file))) as Record<
      string,
      unknown
    >;
    registerProjectScriptExports(registry, module, file);
  }
}

function listSceneFiles(dir: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      listSceneFiles(fullPath, collected);
    } else if (entry.endsWith('.pix3scene')) {
      collected.push(fullPath);
    }
  }
  return collected;
}

interface TemplateScene {
  templateId: string;
  templateDir: string;
  /** Project-relative path, e.g. `scenes/prefabs/target.pix3scene`. */
  relPath: string;
}

const TEMPLATE_SCENES: TemplateScene[] = readdirSync(TEMPLATES_ROOT)
  .filter(entry => existsSync(join(TEMPLATES_ROOT, entry, 'files')))
  .flatMap(templateId => {
    const templateDir = join(TEMPLATES_ROOT, templateId);
    const filesDir = join(templateDir, 'files');
    return listSceneFiles(filesDir).map(path => ({
      templateId,
      templateDir,
      relPath: relative(filesDir, path).replace(/\\/g, '/'),
    }));
  });

interface Harness {
  loader: SceneLoader;
  registry: ScriptRegistry;
  assets: NodeAssetLoader;
}

function createHarness(projectDir: string): Harness {
  const disk = new DiskResourceManager(projectDir, { transformText: substitutePlaceholders });
  const assets = new NodeAssetLoader(disk);
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  return { loader: new SceneLoader(assets, registry, disk), registry, assets };
}

/**
 * `@pix3/runtime`'s index re-exports `lit/decorators.js`, and under Vite's development condition
 * Lit announces itself once per worker through `console.warn`. Not a scene problem.
 */
const LIT_DEV_MODE_NOTICE = /^Lit is in dev mode/;

/** Collect `console.warn` for the duration of a test; silence the loader's debug chatter. */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (args.some(arg => arg instanceof ResourceNotDecodedError)) return;
    const message = args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    if (!LIT_DEV_MODE_NOTICE.test(message)) warnings.push(message);
  });
  return warnings;
}

function walkDefinitions(
  definitions: readonly SceneNodeDefinition[] | undefined,
  visit: (definition: SceneNodeDefinition) => void
): void {
  for (const definition of definitions ?? []) {
    visit(definition);
    walkDefinitions(definition.children, visit);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- 1. What forces a shim at all -----------------------------------------------------------------

describe('scene hydration without any DOM', () => {
  it('fails only on text nodes, which paint a canvas in their constructor', async () => {
    captureWarnings();
    const { loader } = createHarness(TEMPLATES_ROOT);
    // A scene without UI text hydrates with no DOM whatsoever…
    await expect(
      loader.parseScene('root:\n  - id: a\n    type: ColorRect2D\n    properties: { width: 10 }\n')
    ).resolves.toBeTruthy();
    // …and one Label2D is enough to need `document`. When this stops throwing, drop the shim.
    await expect(
      loader.parseScene('root:\n  - id: a\n    type: Label2D\n    properties: { label: hi }\n')
    ).rejects.toThrow(/document is not defined/);
  });
});

// --- 2. Golden: every shipped scene and prefab --------------------------------------------------

describe('pix3 validate level 2 golden: template scenes load clean in node', () => {
  installCanvasShim();

  it('finds the template scenes', () => {
    expect(TEMPLATE_SCENES.length).toBeGreaterThan(20);
  });

  const foundDefects: Record<string, string[]> = {};

  for (const scene of TEMPLATE_SCENES) {
    const label = `${scene.templateId}/${scene.relPath}`;

    it(`${label} hydrates with every component resolved and every res:// present`, async () => {
      const warnings = captureWarnings();
      const { loader, registry, assets } = createHarness(join(scene.templateDir, 'files'));
      await registerTemplateScripts(scene.templateDir, registry);

      const text = substitutePlaceholders(
        readFileSync(join(scene.templateDir, 'files', scene.relPath), 'utf8')
      );
      const graph: SceneGraph = await loader.parseScene(text, {
        filePath: `res://${scene.relPath}`,
      });

      expect(graph.rootNodes.length).toBeGreaterThan(0);
      const nodes = [...graph.nodeMap.values()];
      expect(
        nodes.flatMap(node => node.pendingComponents.map(c => `${node.nodeId}:${c.type}`))
      ).toEqual([]);
      expect(nodes.filter(isInertNode).map(node => `${node.nodeId}:${node.type}`)).toEqual([]);
      expect(assets.missing).toEqual([]);
      expect(warnings).toEqual([]);

      // Component config keys are declared by the component's schema (core: and user: alike).
      const document = parseYaml(text) as { root?: SceneNodeDefinition[] };
      const undeclaredConfig: string[] = [];
      walkDefinitions(document.root, definition => {
        for (const component of definition.components ?? []) {
          const schema = registry.getComponentPropertySchema(component.type);
          const declared = new Set((schema?.properties ?? []).map(property => property.name));
          for (const key of Object.keys(component.config ?? {})) {
            if (!declared.has(key))
              undeclaredConfig.push(`${definition.id}/${component.type}.${key}`);
          }
        }
      });
      expect(undeclaredConfig).toEqual([]);

      // Node property keys must be keys the disk format accepts for that type.
      walkDefinitions(document.root, definition => {
        if (definition.instance) return; // instance roots carry overrides, checked against the prefab
        const node = graph.nodeMap.get(definition.id);
        expect(node, `node "${definition.id}" is missing from the graph`).toBeInstanceOf(NodeBase);
        if (!node) return;
        const canonicalType = resolveSceneNodeType(definition.type) ?? definition.type ?? 'Node3D';
        const format = getSceneNodeDiskFormat(canonicalType);
        expect(format, `no disk format for ${canonicalType}`).not.toBeNull();
        if (!format) return;
        const schema = getNodePropertySchema(node).properties;
        const unknown = Object.keys(definition.properties ?? {})
          .filter(key => {
            const kind = resolveSceneDiskKey(format, schema, key).kind;
            return kind !== 'schema' && kind !== 'extra' && kind !== 'write-only';
          })
          .sort();
        if (unknown.length > 0) foundDefects[`${label}#${definition.id}`] = unknown;
      });
    });
  }

  it('the only undeclared node properties are the known template defects', () => {
    expect(foundDefects).toEqual(KNOWN_TEMPLATE_DEFECTS);
  });
});

// --- 3. What the loader enforces on its own, and what it waves through ---------------------------

describe('SceneLoader strictness, as measured (what validate must add on top)', () => {
  installCanvasShim();

  const PREFAB_DIR = join(TEMPLATES_ROOT, 'recipe-tapper-2d', 'files');

  const load = async (yaml: string, projectDir = PREFAB_DIR) => {
    const harness = createHarness(projectDir);
    const graph = await harness.loader.parseScene(yaml, {
      filePath: 'res://scenes/test.pix3scene',
    });
    return { graph, ...harness };
  };

  it('rejects a duplicate node id with SceneValidationError', async () => {
    captureWarnings();
    await expect(
      load('root:\n  - id: a\n    type: Node2D\n  - id: a\n    type: Group2D\n')
    ).rejects.toBeInstanceOf(SceneValidationError);
  });

  it('rejects malformed YAML and the removed Layout2D with SceneValidationError', async () => {
    captureWarnings();
    await expect(load('root: [\n')).rejects.toBeInstanceOf(SceneValidationError);
    await expect(load('root:\n  - id: a\n    type: Layout2D\n')).rejects.toBeInstanceOf(
      SceneValidationError
    );
  });

  it('rejects an instance cycle with SceneValidationError', async () => {
    captureWarnings();
    const harness = createHarness(PREFAB_DIR);
    // The prefab stack already contains the path it is about to instantiate.
    await expect(
      harness.loader.parseScene(
        'root:\n  - id: a\n    instance: res://scenes/prefabs/target.pix3scene\n',
        {
          filePath: 'res://scenes/prefabs/target.pix3scene',
          instanceStack: ['res://scenes/prefabs/target.pix3scene'],
        }
      )
    ).rejects.toBeInstanceOf(SceneValidationError);
  });

  it('a missing prefab is NOT a SceneValidationError — it is the resolver error, unwrapped', async () => {
    captureWarnings();
    const rejection = load('root:\n  - id: a\n    instance: res://scenes/prefabs/nope.pix3scene\n');
    await expect(rejection).rejects.toBeInstanceOf(MissingResourceError);
    await expect(rejection).rejects.not.toBeInstanceOf(SceneValidationError);
  });

  it('malformed structure surfaces as a bare TypeError or is accepted outright', async () => {
    captureWarnings();
    await expect(load('root: { a: 1 }\n')).rejects.toBeInstanceOf(TypeError);
    await expect(load('root:\n  - id: a\n    children: { x: 1 }\n')).rejects.toBeInstanceOf(
      TypeError
    );
    // No `root`, a scalar document, or a node without `id` all load without complaint.
    expect((await load('version: 1.0.0\n')).graph.rootNodes).toHaveLength(0);
    expect((await load('hello\n')).graph.rootNodes).toHaveLength(0);
    const { graph } = await load('root:\n  - type: Node2D\n');
    expect(graph.rootNodes[0]?.nodeId).toBeUndefined();
  });

  it('an unknown type becomes an inert NodeBase; case variants resolve silently', async () => {
    captureWarnings();
    const { graph } = await load(
      'root:\n  - id: a\n    type: Sprit2D\n  - id: b\n    type: sprite2d\n'
    );
    const [typo, lowercase] = graph.rootNodes;
    expect(Object.getPrototypeOf(typo)).toBe(NodeBase.prototype);
    expect(isInertNode(typo)).toBe(true);
    expect(describeUnknownNodeType('a', 'Sprit2D')).toContain('Did you mean "Sprite2D"?');
    expect(lowercase.type).toBe('Sprite2D');
    expect(isInertNode(lowercase)).toBe(false);
  });

  it('an unknown property is kept silently and written back on save', async () => {
    captureWarnings();
    const { graph } = await load(
      'root:\n  - id: a\n    type: ColorRect2D\n    properties: { width: 10, bogusKey: 42 }\n'
    );
    expect(graph.rootNodes[0].properties.bogusKey).toBe(42);
    expect(new SceneSaver().serializeScene(graph)).toContain('bogusKey: 42');
  });

  it('a wrong-typed value falls back to the default; the saver may then rewrite it', async () => {
    captureWarnings();
    const { graph } = await load(
      'root:\n  - id: a\n    type: ColorRect2D\n    properties: { width: wide, color: 123 }\n'
    );
    const rect = graph.rootNodes[0] as NodeBase & { width: number; color: string };
    expect(rect.width).toBe(100);
    expect(rect.color).toBe('#ffffff');
    // The raw bag still holds the bad value; for these keys the saver overwrites it with the
    // live default, so a load/save round trip silently "repairs" the file.
    expect(rect.properties.width).toBe('wide');
    const saved = new SceneSaver().serializeScene(graph);
    expect(saved).toContain('width: 100');
    expect(saved).not.toContain('wide');
  });

  it('an unregistered component warns, is parked in pendingComponents, and survives a save', async () => {
    const warnings = captureWarnings();
    const { graph } = await load(
      'root:\n  - id: a\n    type: Node2D\n    components:\n      - id: c\n        type: user:Nope\n        config: { speed: 3 }\n'
    );
    expect(graph.rootNodes[0].pendingComponents.map(c => c.type)).toEqual(['user:Nope']);
    expect(warnings.some(w => w.includes('"user:Nope" is not registered yet'))).toBe(true);
    expect(new SceneSaver().serializeScene(graph)).toContain('user:Nope');
  });

  it("component config: unknown keys are kept, a wrong type is the component's business, no warning", async () => {
    const warnings = captureWarnings();
    const { graph } = await load(
      'root:\n  - id: a\n    type: Node3D\n    components:\n      - id: c\n        type: core:Rotate\n        config: { rotationSpeed: fast, bogus: 1 }\n'
    );
    const [component] = graph.rootNodes[0].components;
    // The unknown key rides along in `config` and is saved back; `rotationSpeed: fast` was
    // ignored by the schema's setValue and normalised to the default by `onAttach` — another
    // component could just as well keep the string. Either way nothing is reported.
    expect(component.config).toMatchObject({ rotationSpeed: 1, bogus: 1 });
    expect(new SceneSaver().serializeScene(graph)).toContain('bogus: 1');
    expect(warnings).toEqual([]);
  });

  it('a missing res:// texture warns and the node stays', async () => {
    const warnings = captureWarnings();
    const { graph, assets } = await load(
      "root:\n  - id: a\n    type: Sprite2D\n    properties:\n      texture: { type: texture, url: 'res://sprites/nope.png' }\n"
    );
    expect(graph.rootNodes).toHaveLength(1);
    expect(assets.missing).toEqual(['res://sprites/nope.png']);
    expect(warnings.some(w => w.includes('Error loading texture for Sprite2D "a"'))).toBe(true);
  });
});
