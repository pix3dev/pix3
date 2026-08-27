import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import * as runtime from '@pix3/runtime';
import { normalizeNodeTypeName } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';
import { parseRoutine } from '@/services/agent/game-routines';
import { RECIPE_CATALOG, RECIPE_TEMPLATE_ALIASES } from '@/services/flow/PrototypeBootstrapService';
import { IDEA_PRESERVED_PATHS } from '@/services/flow/recipe-contract';

/**
 * Contract drift guard for the Flow "recipe" templates (`.plans/done/flow-recipes-contract.md`).
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
  'playable-3d',
  'recipe-arena-2d',
  'recipe-blank-2d',
  'recipe-bouncer-2d',
  'recipe-grid-3d',
  'recipe-tapper-2d',
];

/**
 * Schema properties for a scene `type:`, tolerating the `*Node` suffix the light nodes carry on
 * disk but not in their schemas.
 */
const schemaPropertiesFor = (nodeType: string): string[] | undefined => {
  const key = normalizeNodeTypeName(nodeType);
  return NODE_SCHEMA_PROPERTIES.get(key) ?? NODE_SCHEMA_PROPERTIES.get(key.replace(/node$/, ''));
};

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
      // Keyed by the NORMALIZED name: a scene says `DirectionalLightNode` while the class's own
      // schema says `DirectionalLight`, and that gap is exactly the kind of mismatch this file
      // exists to catch rather than to trip over.
      const key = normalizeNodeTypeName(nodeType ?? '');
      if (key && !index.has(key)) {
        index.set(
          key,
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
  /**
   * Both directions of catalog↔template, because each gap fails silently in a different way.
   *
   * A catalog id with no template folder reaches the user as a project quietly started from the
   * fallback recipe — the planner's correct answer, discarded. A shipped template missing from the
   * catalog is simply unreachable from a prompt: that is how `empty-2d` sat in the repo for months
   * while every unmatched idea was answered with a full game the agent had to demolish first.
   */
  it('the recipe catalog and the shipped templates agree, both ways', () => {
    const shipped = new Set(
      readdirSync(TEMPLATES_ROOT).filter(entry =>
        statSync(join(TEMPLATES_ROOT, entry)).isDirectory()
      )
    );

    for (const recipe of RECIPE_CATALOG) {
      const templateId = RECIPE_TEMPLATE_ALIASES[recipe.id] ?? recipe.id;
      expect(
        shipped.has(templateId),
        `catalog id "${recipe.id}" resolves to template "${templateId}", which is not shipped`
      ).toBe(true);
    }

    const catalogTemplates = new Set(
      RECIPE_CATALOG.map(recipe => RECIPE_TEMPLATE_ALIASES[recipe.id] ?? recipe.id)
    );
    for (const templateId of shipped) {
      if (!templateId.startsWith('recipe-')) continue;
      expect(
        catalogTemplates.has(templateId),
        `template "${templateId}" ships but no catalog entry resolves to it, so no prompt can reach it`
      ).toBe(true);
    }
  });

  /**
   * A recipe that boots a menu keeps the menu OUT of the gameplay scene.
   *
   * The whole prototyping loop runs on the gameplay scene, so a `MenuFlow` that drifted into
   * `main.pix3scene` would put a start screen in front of every iteration. Templates without an
   * `entryScene` are exempt by construction — the playables' inline tap gate is an audio-unlock
   * requirement of the ad container, not chrome.
   */
  it('a template that boots a menu keeps it out of main.pix3scene', () => {
    for (const templateId of CATALOG_TEMPLATES) {
      const templateDir = join(TEMPLATES_ROOT, templateId);
      const metaPath = join(templateDir, 'template.yaml');
      const meta = parseYaml(readFileSync(metaPath, 'utf8')) as { entryScene?: unknown } | null;
      if (typeof meta?.entryScene !== 'string' || meta.entryScene.length === 0) {
        continue;
      }
      const mainPath = join(templateDir, 'files', 'scenes', 'main.pix3scene');
      expect(existsSync(mainPath), `${templateId}: ${mainPath} is missing`).toBe(true);
      expect(
        readFileSync(mainPath, 'utf8'),
        `${templateId}: main.pix3scene carries a MenuFlow — the menu belongs in its own scene`
      ).not.toContain('user:MenuFlow');
    }
  });

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
        const declared = schemaPropertiesFor(nodeType);
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

/**
 * Testability contract for every template that ships a game (`.plans/done/agent-gameplay-testing.md`,
 * phase 0).
 *
 * The agent copies whatever the template started it with: a template whose state is legible
 * (`GameDebugProvider`), whose roots are named the same everywhere (`game-root`), and whose
 * `design/tests/` folder already has the shape, produces testable games without a word in the
 * prompt. Drift here is invisible in the field — it shows up as an agent verifying by screenshot
 * because there was no snapshot to read.
 *
 * `empty-*` is deliberately exempt: being bare is the point of those templates.
 */
const EMPTY_TEMPLATE_PREFIX = 'empty-';

/**
 * Bare templates whose id does not start with `empty-`. `idea-blank` scaffolds the Flow IDEA stage
 * — a project that has a design document and deliberately no game yet — so demanding a debug
 * provider and a routine of it would be demanding the very thing the stage exists to defer.
 */
const BARE_TEMPLATES = new Set(['idea-blank']);

/** Every shipped template that carries a game. */
const GAMEPLAY_TEMPLATES = readdirSync(TEMPLATES_ROOT)
  .filter(entry => statSync(join(TEMPLATES_ROOT, entry)).isDirectory())
  .filter(entry => !entry.startsWith(EMPTY_TEMPLATE_PREFIX) && !BARE_TEMPLATES.has(entry))
  .sort();

/** The root id routines and assertions are written against, in every template. */
const CANONICAL_GAME_ROOT_ID = 'game-root';

/** Fields a routine header must carry (`.plans/done/agent-gameplay-testing.md` §5.7.1). */
const REQUIRED_ROUTINE_FIELDS = ['name', 'description', 'scope', 'uses', 'steps'] as const;

function listScriptSources(templateDir: string): string[] {
  const scriptsDir = join(templateDir, 'files', 'scripts');
  if (!existsSync(scriptsDir)) {
    return [];
  }
  return readdirSync(scriptsDir)
    .filter(entry => entry.endsWith('.ts'))
    .map(entry => readFileSync(join(scriptsDir, entry), 'utf8'));
}

describe('template testability contract', () => {
  it('there is at least one gameplay template to check', () => {
    expect(GAMEPLAY_TEMPLATES.length).toBeGreaterThan(0);
  });

  for (const templateId of GAMEPLAY_TEMPLATES) {
    const templateDir = join(TEMPLATES_ROOT, templateId);

    it(`${templateId}: registers a GameDebugProvider`, () => {
      const sources = listScriptSources(templateDir);
      expect(
        sources.length,
        `${templateId} ships no scripts to register a provider from`
      ).toBeGreaterThan(0);
      // Without a provider every gameplay check degrades to a screenshot: `game.changed`
      // is the only state-level proof `game_input`/`game_observe` can carry.
      expect(
        sources.some(source => source.includes('registerGameDebug')),
        `${templateId}: no files/scripts/*.ts calls registerGameDebug({ name, snapshot })`
      ).toBe(true);
    });

    it(`${templateId}: uses the canonical "${CANONICAL_GAME_ROOT_ID}" root id`, () => {
      const nodes = collectSceneNodes(templateDir);
      expect(nodes.size, `${templateId} ships no scene nodes`).toBeGreaterThan(0);
      // Portable routines/assertions address roots by a fixed id rather than per-template names.
      expect(
        [...nodes.keys()],
        `${templateId}: no scene declares a node with id "${CANONICAL_GAME_ROOT_ID}"`
      ).toContain(CANONICAL_GAME_ROOT_ID);
    });

    it(`${templateId}: design/tests, when present, matches the fixed format`, () => {
      const testsDir = join(templateDir, 'files', 'design', 'tests');
      if (!existsSync(testsDir)) {
        // The skeleton is not required of every template yet — but when it ships it is a
        // contract the (in-progress) harness reads, so the shape is asserted here.
        return;
      }

      const reachabilityPath = join(testsDir, 'reachability.json');
      expect(existsSync(reachabilityPath), `${reachabilityPath} is missing`).toBe(true);
      const reachability = JSON.parse(readFileSync(reachabilityPath, 'utf8')) as {
        version?: unknown;
        proven?: unknown;
      };
      expect(reachability.version, `${reachabilityPath}: no "version"`).toBeDefined();
      expect(
        Array.isArray(reachability.proven),
        `${reachabilityPath}: "proven" must be an array (empty in a fresh template)`
      ).toBe(true);

      const routinesDir = join(testsDir, 'routines');
      expect(existsSync(routinesDir), `${routinesDir} is missing`).toBe(true);
      const routineFiles = readdirSync(routinesDir).filter(entry => entry.endsWith('.json'));
      expect(
        routineFiles.length,
        `${routinesDir}: ships no example routine, so the format is documented nowhere`
      ).toBeGreaterThan(0);

      for (const fileName of routineFiles) {
        const routinePath = join(routinesDir, fileName);
        const text = readFileSync(routinePath, 'utf8');
        const routine = JSON.parse(text) as Record<string, unknown>;
        for (const field of REQUIRED_ROUTINE_FIELDS) {
          expect(routine[field], `${routinePath}: missing "${field}"`).toBeDefined();
        }
        expect(Array.isArray(routine.uses), `${routinePath}: "uses" must be an array`).toBe(true);
        expect(Array.isArray(routine.steps), `${routinePath}: "steps" must be an array`).toBe(true);

        // And the whole file goes through the ACTUAL loader. A template is what the agent
        // copies from, so an example the harness cannot execute teaches a format the tools
        // do not speak — which is precisely how two shipped examples drifted into two
        // different dialects while nothing but a field-name check guarded them.
        const parsed = parseRoutine(routine);
        expect(
          'error' in parsed ? `${routinePath}: ${parsed.error}` : null,
          `${routinePath} does not load with parseRoutine`
        ).toBeNull();

        // Every intent a command step dispatches must be registered by one of the
        // template's own scripts — a routine that dispatches a name nobody registered
        // fails at run time with "no registered handler took it".
        if ('routine' in parsed) {
          const sources = listScriptSources(templateDir).join('\n');
          for (const step of parsed.routine.steps) {
            if (step.type !== 'command') continue;
            // Whitespace-agnostic on purpose. Matching the two literal spellings a
            // formatter happens to produce made this guard fail on a Windows checkout
            // and pass in CI: a multi-line `register(` reads as `register(\r\n        '`
            // there, and the LF spelling never matched. A guard whose red depends on
            // the checkout's line endings teaches everyone to ignore it.
            const registered = new RegExp(
              `register\\(\\s*'${step.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`
            );
            expect(
              registered.test(sources),
              `${routinePath}: dispatches "${step.name}", which no files/scripts/*.ts registers`
            ).toBe(true);
          }
        }
      }
    });
  }
});

/**
 * The Flow idea→prototype transition lays a recipe over a project that is ALREADY the user's
 * (`.plans/vibe-idea-stage.md` §3.1): the design document, the decisions log, the source documents
 * they attached and the whole references folder are theirs, and `applyTemplateFiles(…, { skip })`
 * refuses to overwrite them.
 *
 * That skip list is a safety net over a contract this spec is the enforcement of: no template ships
 * those paths. Should one ever start to, the file would be quietly dropped on transition (worse: a
 * recipe author would think it shipped) — so it fails here, at the moment the file is added, rather
 * than in a project nobody can recover.
 */
describe('idea-stage files a recipe may not ship', () => {
  const listAllFiles = (dir: string, base = dir, collected: string[] = []): string[] => {
    if (!existsSync(dir)) {
      return collected;
    }
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        listAllFiles(fullPath, base, collected);
      } else {
        collected.push(relative(base, fullPath).split(sep).join('/'));
      }
    }
    return collected;
  };

  const ALL_TEMPLATES = readdirSync(TEMPLATES_ROOT)
    .filter(entry => statSync(join(TEMPLATES_ROOT, entry)).isDirectory())
    .sort();

  it('the preserved-path list is not empty', () => {
    // A typo that emptied the list would make every assertion below pass while the transition
    // overwrote everything.
    expect(IDEA_PRESERVED_PATHS.length).toBeGreaterThan(0);
    expect(IDEA_PRESERVED_PATHS).toContain('design/gdd.md');
  });

  for (const templateId of ALL_TEMPLATES) {
    it(`${templateId}: ships no file the transition would have to skip`, () => {
      const shipped = listAllFiles(join(TEMPLATES_ROOT, templateId, 'files'));
      for (const preserved of IDEA_PRESERVED_PATHS) {
        const prefix = preserved.replace(/\/+$/, '');
        const offenders = shipped.filter(path => path === prefix || path.startsWith(`${prefix}/`));
        expect(
          offenders,
          `${templateId} ships ${offenders.join(', ')}, which the idea→prototype transition ` +
            `refuses to overwrite — the user's own "${preserved}" would win and this file would ` +
            'never reach a project that came through the idea stage'
        ).toEqual([]);
      }
    });
  }

  it('the agent overlay ships none of them either', () => {
    // The overlay (AGENTS.md, CLAUDE.md, design/README.md, .claude/skills/**) is written into every
    // project by the same call, so it is under the same rule.
    const overlay = listAllFiles(resolve(process.cwd(), 'src/templates/agent'));
    for (const preserved of IDEA_PRESERVED_PATHS) {
      const prefix = preserved.replace(/\/+$/, '');
      expect(overlay.filter(path => path === prefix || path.startsWith(`${prefix}/`))).toEqual([]);
    }
  });
});
