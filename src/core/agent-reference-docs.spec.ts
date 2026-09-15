import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  KNOWN_SCENE_NODE_TYPES,
  ScriptRegistry,
  registerBuiltInScripts,
  type ComponentTypeInfo,
} from '@pix3/runtime';

/**
 * Coverage guards for the two documents that ARE the external agent's engine knowledge.
 *
 * `ProjectTemplateService` copies `docs/nodes-and-systems.md` and `docs/node-types-reference.md`
 * into every new project as `.claude/skills/pix3-game-dev/references/`, and the project's
 * `AGENTS.md` rule 1 sends the agent to them before it writes any game logic. An agent working in a
 * folder has no `engine_search` and no registry to enumerate — those files are the whole catalog.
 * So a node type or behaviour missing from them is not a documentation gap, it is a capability the
 * external pipeline cannot see at all, and the agent's confident "the engine has no solid-colour
 * primitive" is indistinguishable from a correct answer.
 *
 * Building Carrom found this the expensive way: `ColorRect2D` — the engine's only solid-colour 2D
 * node, and the placeholder both skills tell agents to reach for — had zero mentions in the
 * per-node reference, along with eleven other types.
 *
 * Both guards re-derive from the runtime's own registries rather than from a hand-kept list, which
 * is the point: adding a node type or a `core:*` behaviour and shipping it undocumented fails here.
 */

const repoFile = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), 'utf8');

/** `### Sprite2D`, `### `Sprite2D`` and `### Sprite2D — a thing` all count as a section. */
const documentedSections = (markdown: string): ReadonlySet<string> =>
  new Set(
    [...markdown.matchAll(/^#{2,4}\s+(.+)$/gm)].map(
      match =>
        match[1]
          .trim()
          .replace(/`/g, '')
          .split(/[\s—:(]/)[0]
    )
  );

describe('docs/node-types-reference.md', () => {
  it('has a section for every node type a scene file may declare', () => {
    const documented = documentedSections(repoFile('docs/node-types-reference.md'));
    const missing = KNOWN_SCENE_NODE_TYPES.filter(type => !documented.has(type));

    expect(
      missing,
      `These node types can be authored in a .pix3scene but have no section in the per-node ` +
        `reference, so an external agent following AGENTS.md rule 1 concludes they do not exist: ` +
        `${missing.join(', ')}.`
    ).toEqual([]);
  });
});

describe('docs/nodes-and-systems.md', () => {
  it('names every built-in behaviour an agent can attach', () => {
    const registry = new ScriptRegistry();
    registerBuiltInScripts(registry);
    const builtIns = registry
      .getAllComponentTypes()
      .map((info: ComponentTypeInfo) => info.id)
      .filter((id: string) => id.startsWith('core:'));

    // Sanity floor: an empty list would make this guard vacuously green.
    expect(builtIns.length).toBeGreaterThan(15);

    const catalog = repoFile('docs/nodes-and-systems.md');
    const missing = builtIns.filter(id => !catalog.includes(id));

    expect(
      missing,
      `These behaviours are registered and attachable but are not named in the capability ` +
        `catalog, which is the only behaviour list an external agent has: ${missing.join(', ')}.`
    ).toEqual([]);
  });
});
