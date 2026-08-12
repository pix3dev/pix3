import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

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
  properties?: Record<string, unknown>;
  components?: Array<{ type?: unknown }>;
  children?: SceneNode[];
}

interface SceneNodeInfo {
  properties: Record<string, unknown>;
  componentTypes: string[];
}

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
  }
});
