import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import * as runtime from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';

/**
 * Contract drift guard for the Flow "recipe" templates (`.plans/flow-recipes-contract.md`).
 *
 * `design/recipe.md` is a machine-read contract: the Flow expander patches the
 * scene YAML through it, and agents grep it. Every entry in its `tunables:`
 * block therefore has to keep pointing at a node that exists, a component that
 * is actually attached to that node, and a property that the component's
 * `getPropertySchema()` really declares. When any of those drift apart the
 * failure is silent in the field — so it fails here instead.
 */

const TEMPLATES_ROOT = resolve(process.cwd(), 'src/templates/projects');

/** Templates that ship a `design/recipe.md` and are therefore part of the catalog. */
const CATALOG_TEMPLATES = [
  'playable-2d',
  'recipe-arena-2d',
  'recipe-bouncer-2d',
  'recipe-tapper-2d',
];

const REQUIRED_SECTIONS = [
  '## What this is',
  '## Node map',
  '## Placeholders',
  '## Tunables',
  '## Extension points',
  '## Do not touch',
  '## Verify',
];

/**
 * Mirror of `MAX_RECIPE_MD_CHARS` in `AgentChatService`: the agent's system prompt
 * carries `design/recipe.md` verbatim up to this many characters and then cuts the
 * REST OFF. The tail is where "## Do not touch" and "## Verify" live, so a recipe
 * that grows past the limit silently stops shipping its own guardrails — assert the
 * size here instead of discovering it as a badly-behaved agent turn.
 */
const MAX_RECIPE_MD_CHARS = 8_000;

/** Lazily-loadable modules for every template script, keyed by glob path. */
const SCRIPT_MODULES = import.meta.glob('./*/files/scripts/*.ts') as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

interface TunableEntry {
  node: string;
  component?: string;
  property: string;
  min?: number;
  max?: number;
  default?: unknown;
}

interface SceneNode {
  id?: unknown;
  type?: unknown;
  properties?: Record<string, unknown>;
  components?: Array<{ type?: unknown }>;
  children?: SceneNode[];
}

interface SceneNodeInfo {
  /** Scene `type` string (`Sprite2D`, `PostProcess`, …). */
  type: string;
  properties: Record<string, unknown>;
  componentTypes: string[];
}

/**
 * Scene `type` string → the property names that node class's schema declares, built
 * from the live `@pix3/runtime` exports (the same trick `scene-nodes-dts.ts` uses).
 * Lets a node-level tunable be checked against a real schema, exactly as a
 * component-level one already is.
 */
const NODE_SCHEMA_PROPERTIES: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const value of Object.values(runtime as Record<string, unknown>)) {
    if (typeof value !== 'function') {
      continue;
    }
    const getSchema = (value as { getPropertySchema?: unknown }).getPropertySchema;
    if (typeof getSchema !== 'function') {
      continue;
    }
    try {
      const schema = (getSchema as () => PropertySchema).call(value);
      const nodeType = schema?.nodeType;
      if (typeof nodeType === 'string' && nodeType && !index.has(nodeType)) {
        index.set(
          nodeType,
          (schema.properties ?? []).map(property => property.name)
        );
      }
    } catch {
      // Not every export with that static is a node (and some need a live scene).
    }
  }
  return index;
})();

function listSceneFiles(dir: string, collected: string[] = []): string[] {
  if (!existsSync(dir)) {
    return collected;
  }
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

/** id → node info, across every scene (and prefab) the template ships. */
function collectSceneNodes(templateDir: string): Map<string, SceneNodeInfo> {
  const nodes = new Map<string, SceneNodeInfo>();
  const visit = (node: SceneNode): void => {
    if (typeof node.id === 'string') {
      nodes.set(node.id, {
        type: typeof node.type === 'string' ? node.type : '',
        properties: node.properties ?? {},
        componentTypes: (node.components ?? [])
          .map(component => component?.type)
          .filter((type): type is string => typeof type === 'string'),
      });
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const scenePath of listSceneFiles(join(templateDir, 'files', 'scenes'))) {
    const text = readFileSync(scenePath, 'utf8').replaceAll('{{PROJECT_NAME}}', 'Test Project');
    const doc = parseYaml(text) as { root?: SceneNode[] } | null;
    // A malformed scene is a hard failure: every template scene must parse.
    expect(Array.isArray(doc?.root), `${scenePath} has no root array`).toBe(true);
    for (const root of doc?.root ?? []) {
      visit(root);
    }
  }
  return nodes;
}

function parseTunables(recipeMarkdown: string): Record<string, TunableEntry> {
  const block = /```yaml\s*\n([\s\S]*?)```/.exec(recipeMarkdown);
  expect(block, 'recipe.md must contain a ```yaml tunables block').not.toBeNull();
  const parsed = parseYaml(block?.[1] ?? '') as { tunables?: Record<string, TunableEntry> } | null;
  expect(parsed?.tunables, 'the yaml block must have a top-level `tunables:` key').toBeTruthy();
  return parsed?.tunables ?? {};
}

/** `user:PlayerController` → the property names its getPropertySchema() declares. */
async function loadSchemaProperties(templateId: string, componentType: string): Promise<string[]> {
  const className = componentType.replace(/^user:/, '');
  const key = `./${templateId}/files/scripts/${className}.ts`;
  const load = SCRIPT_MODULES[key];
  expect(
    load,
    `${templateId}: no script file for component "${componentType}" (${key})`
  ).toBeTruthy();

  const module = await load();
  const ctor = module[className] as { getPropertySchema?: () => PropertySchema } | undefined;
  expect(
    typeof ctor?.getPropertySchema,
    `${key} must export class ${className} with getPropertySchema()`
  ).toBe('function');
  return (ctor?.getPropertySchema?.().properties ?? []).map(property => property.name);
}

describe('flow recipe contract', () => {
  it('every recipe-* template is in the catalog list', () => {
    const shipped = readdirSync(TEMPLATES_ROOT)
      .filter(entry => statSync(join(TEMPLATES_ROOT, entry)).isDirectory())
      .filter(entry => entry.startsWith('recipe-'));
    for (const templateId of shipped) {
      expect(CATALOG_TEMPLATES).toContain(templateId);
    }
  });

  for (const templateId of CATALOG_TEMPLATES) {
    const templateDir = join(TEMPLATES_ROOT, templateId);
    const recipePath = join(templateDir, 'files', 'design', 'recipe.md');

    it(`${templateId}: design/recipe.md has the contract sections`, () => {
      expect(existsSync(recipePath), `${recipePath} is missing`).toBe(true);
      const markdown = readFileSync(recipePath, 'utf8');
      for (const heading of REQUIRED_SECTIONS) {
        expect(markdown, `missing section ${heading}`).toContain(heading);
      }
    });

    it(`${templateId}: design/recipe.md fits the agent prompt budget`, () => {
      const markdown = readFileSync(recipePath, 'utf8');
      expect(
        markdown.length,
        `recipe.md is ${markdown.length} chars; over ${MAX_RECIPE_MD_CHARS} the agent prompt ` +
          `truncates it and the tail sections ("Do not touch", "Verify") stop shipping`
      ).toBeLessThanOrEqual(MAX_RECIPE_MD_CHARS);
    });

    it(`${templateId}: every tunable points at a real node`, () => {
      const tunables = parseTunables(readFileSync(recipePath, 'utf8'));
      const nodes = collectSceneNodes(templateDir);
      expect(Object.keys(tunables).length).toBeGreaterThan(0);

      for (const [key, entry] of Object.entries(tunables)) {
        const node = nodes.get(entry.node);
        expect(node, `tunable "${key}" → unknown node id "${entry.node}"`).toBeTruthy();

        if (entry.component) {
          expect(
            node?.componentTypes,
            `tunable "${key}" → node "${entry.node}" does not carry ${entry.component}`
          ).toContain(entry.component);
        } else {
          // Without a component the expander writes a NODE property, so the
          // scene must author it (otherwise there is nothing to patch).
          expect(
            Object.keys(node?.properties ?? {}),
            `tunable "${key}" → node "${entry.node}" does not author property "${entry.property}"`
          ).toContain(entry.property);
        }
      }
    });

    it(`${templateId}: every tunable property is declared in its script schema`, async () => {
      const tunables = parseTunables(readFileSync(recipePath, 'utf8'));
      for (const [key, entry] of Object.entries(tunables)) {
        if (!entry.component) {
          continue;
        }
        const declared = await loadSchemaProperties(templateId, entry.component);
        expect(
          declared,
          `tunable "${key}" → ${entry.component}.getPropertySchema() does not declare "${entry.property}"`
        ).toContain(entry.property);
      }
    });

    it(`${templateId}: every node-level tunable is declared by its node type`, () => {
      const tunables = parseTunables(readFileSync(recipePath, 'utf8'));
      const nodes = collectSceneNodes(templateDir);

      for (const [key, entry] of Object.entries(tunables)) {
        if (entry.component) {
          continue;
        }
        // A node tunable is written straight into the scene YAML, so the node class
        // has to own the property — a typo here reaches the field as a scene key
        // nothing reads, with no warning anywhere.
        const nodeType = nodes.get(entry.node)?.type ?? '';
        const declared = NODE_SCHEMA_PROPERTIES.get(nodeType);
        expect(declared, `tunable "${key}" → unknown node type "${nodeType}"`).toBeTruthy();
        expect(
          declared,
          `tunable "${key}" → ${nodeType}.getPropertySchema() does not declare "${entry.property}"`
        ).toContain(entry.property);
      }
    });
  }

  /**
   * The bouncer is the recipe whose ready-made look the Flow theme packs drive
   * (`THEME_TUNABLES` sets `bloomIntensity` for neon/pastel/retro). An intensity
   * patched onto a node with bloom switched off — or one the renderer never reaches
   * because the 2D band opted out of post-processing — silently buys nothing.
   */
  it('recipe-bouncer-2d: every PostProcess node blooms and affects 2D', () => {
    const nodes = collectSceneNodes(join(TEMPLATES_ROOT, 'recipe-bouncer-2d'));
    const postProcess = [...nodes].filter(([, info]) => info.type === 'PostProcess');
    expect(postProcess.length, 'the recipe ships no PostProcess node').toBeGreaterThan(0);

    for (const [id, info] of postProcess) {
      expect(info.properties.affect2D, `${id}: affect2D must be true in a 2D scene`).toBe(true);
      expect(info.properties.bloomEnabled, `${id}: bloomEnabled must be authored true`).toBe(true);
      expect(
        Number(info.properties.bloomIntensity),
        `${id}: bloomIntensity must be authored above 0`
      ).toBeGreaterThan(0);
    }
  });
});
