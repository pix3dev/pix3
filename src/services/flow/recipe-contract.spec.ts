import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  applyScenePatches,
  clampTunable,
  looksLikeScene,
  paletteColorForRole,
  parseRecipePlaceholders,
  parseRecipeTunables,
  resolveTunables,
} from './recipe-contract';

/** A `design/recipe.md` in the shape the contract fixes (`.plans/flow-recipes-contract.md` §4). */
const RECIPE_MD = `# Recipe: recipe-arena-2d

## What this is
An avatar in a bounded field.

## Node map
- \`player\` — the avatar
- \`game-background\` — the field

## Placeholders

| role | file | node/prefab |
| --- | --- | --- |
| player | sprites/ph-player.png | player |
| enemy | \`sprites/ph-enemy.png\` | prefabs/enemy.pix3scene |
| background | res://sprites/ph-bg.png | game-background |

## Tunables

\`\`\`yaml
tunables:
  playerSpeed: { node: player, component: "user:PlayerController", property: speed, min: 100, max: 900, default: 420 }
  bgColor:     { node: game-background, property: color, default: "#0f3460" }
  spawnEvery:  { node: spawner, component: "user:Spawner", property: interval, min: 0.2, max: 5 }
\`\`\`

## Do not touch
Node ids above.
`;

const SCENE = `# Pix3 Scene File (YAML)
# A header comment the recipe author wrote and expects to survive.
version: 1.0.0
root:
  - id: game-root
    type: Group2D
    children:
      - id: game-background
        type: ColorRect2D
        properties:
          color: "#0f3460"
          width: 1920
      - id: player
        type: Sprite2D
        properties:
          texture: res://sprites/ph-player.png
        components:
          - id: controller
            type: "user:PlayerController"
            enabled: true
            config:
              speed: 420
`;

describe('parseRecipeTunables', () => {
  it('reads the declared tuning points out of the fenced yaml block', () => {
    const tunables = parseRecipeTunables(RECIPE_MD);

    expect([...tunables.keys()]).toEqual(['playerSpeed', 'bgColor', 'spawnEvery']);
    expect(tunables.get('playerSpeed')).toEqual({
      key: 'playerSpeed',
      node: 'player',
      component: 'user:PlayerController',
      property: 'speed',
      min: 100,
      max: 900,
      default: 420,
    });
    // No `component` means the value lives on the node itself.
    expect(tunables.get('bgColor')?.component).toBeUndefined();
  });

  it('degrades to "nothing declared" rather than throwing on a broken recipe', () => {
    expect(parseRecipeTunables('# Recipe\n\n```yaml\ntunables:\n  - [oops\n```').size).toBe(0);
    expect(parseRecipeTunables('').size).toBe(0);
    // Entries without the two required fields are skipped, the rest survive.
    const partial = parseRecipeTunables(
      '```yaml\ntunables:\n  a: { property: speed }\n  b: { node: player, property: speed }\n```'
    );
    expect([...partial.keys()]).toEqual(['b']);
  });
});

describe('parseRecipePlaceholders', () => {
  it('reads role → file rows and strips decoration', () => {
    expect(parseRecipePlaceholders(RECIPE_MD)).toEqual([
      { role: 'player', file: 'sprites/ph-player.png', target: 'player' },
      { role: 'enemy', file: 'sprites/ph-enemy.png', target: 'prefabs/enemy.pix3scene' },
      { role: 'background', file: 'sprites/ph-bg.png', target: 'game-background' },
    ]);
  });

  it('returns nothing when the recipe has no placeholders section', () => {
    expect(parseRecipePlaceholders('# Recipe\n\n## Tunables\n')).toEqual([]);
  });
});

/**
 * The three-way split is the safety property: applied / clamped, unknown (handed to the agent as
 * text), rejected. A model inventing a tuning point must never end up writing into a scene.
 */
describe('resolveTunables', () => {
  const declared = parseRecipeTunables(RECIPE_MD);

  it('applies declared keys and clamps them into the documented range', () => {
    const resolution = resolveTunables({ playerSpeed: 5000, spawnEvery: 0.05 }, declared);

    expect(resolution.applied).toHaveLength(2);
    expect(resolution.applied[0]).toMatchObject({ value: 900, clamped: true, requested: 5000 });
    expect(resolution.applied[1]).toMatchObject({ value: 0.2, clamped: true, requested: 0.05 });
    expect(resolution.unknown).toEqual([]);
  });

  it('leaves an in-range value exactly as asked', () => {
    const resolution = resolveTunables({ playerSpeed: 500 }, declared);

    expect(resolution.applied[0]).toMatchObject({ value: 500, clamped: false });
    expect(resolution.applied[0].requested).toBeUndefined();
  });

  it('records unknown keys instead of guessing where they belong', () => {
    const resolution = resolveTunables({ enemyWaves: 3, playerSpeed: 300 }, declared);

    expect(resolution.unknown).toEqual([{ key: 'enemyWaves', value: 3 }]);
    expect(resolution.applied.map(entry => entry.tunable.key)).toEqual(['playerSpeed']);
  });

  it('passes strings and booleans through, and rejects everything else', () => {
    const resolution = resolveTunables(
      { bgColor: '#123456', playerSpeed: Number.NaN, spawnEvery: { fast: true } },
      declared
    );

    expect(resolution.applied).toHaveLength(1);
    expect(resolution.applied[0]).toMatchObject({ value: '#123456' });
    expect(resolution.rejected.map(entry => entry.key).sort()).toEqual([
      'playerSpeed',
      'spawnEvery',
    ]);
  });

  it('clamps against a one-sided range', () => {
    expect(clampTunable({ key: 'a', node: 'n', property: 'p', min: 10 }, 4)).toBe(10);
    expect(clampTunable({ key: 'a', node: 'n', property: 'p', max: 10 }, 40)).toBe(10);
    expect(clampTunable({ key: 'a', node: 'n', property: 'p' }, -7)).toBe(-7);
  });
});

describe('applyScenePatches', () => {
  it('sets a node property addressed by its stable id', () => {
    const result = applyScenePatches(SCENE, [
      { node: 'game-background', property: 'color', value: '#123456' },
    ]);

    expect(result.applied).toHaveLength(1);
    expect(result.missing).toEqual([]);
    const parsed = parse(result.text);
    expect(parsed.root[0].children[0].properties.color).toBe('#123456');
    // Untouched siblings keep their values.
    expect(parsed.root[0].children[0].properties.width).toBe(1920);
  });

  it('writes into a component config when the tunable names a component', () => {
    const result = applyScenePatches(SCENE, [
      { node: 'player', component: 'user:PlayerController', property: 'speed', value: 640 },
    ]);

    expect(parse(result.text).root[0].children[1].components[0].config.speed).toBe(640);
  });

  it('keeps the recipe author comments and formatting', () => {
    const result = applyScenePatches(SCENE, [
      { node: 'game-background', property: 'color', value: '#123456' },
    ]);

    expect(result.text).toContain('# Pix3 Scene File (YAML)');
    expect(result.text).toContain('a header comment the recipe author wrote'.replace('a', 'A'));
  });

  it('reports a node it cannot find instead of creating it', () => {
    const patch = { node: 'spawner', property: 'interval', value: 2 };
    const result = applyScenePatches(SCENE, [patch]);

    expect(result.missing).toEqual([patch]);
    expect(result.applied).toEqual([]);
    // Nothing was rewritten, so the file is byte-identical.
    expect(result.text).toBe(SCENE);
  });

  it('reports a component the node does not carry', () => {
    const patch = { node: 'player', component: 'user:Nope', property: 'speed', value: 1 };
    expect(applyScenePatches(SCENE, [patch]).missing).toEqual([patch]);
  });

  it('leaves an unparseable scene alone', () => {
    const broken = 'root:\n  - id: a\n   bad indent: [';
    const result = applyScenePatches(broken, [{ node: 'a', property: 'x', value: 1 }]);

    expect(result.text).toBe(broken);
    expect(result.applied).toEqual([]);
  });

  it('recognises scene files and rejects other yaml', () => {
    expect(looksLikeScene(SCENE)).toBe(true);
    expect(looksLikeScene('title: Recipe\norder: 2\n')).toBe(false);
  });
});

describe('paletteColorForRole', () => {
  const palette = ['#101820', '#274060', '#5c8374', '#f5ae39'];

  it('gives the dominant colour to the background and the accent to the player', () => {
    expect(paletteColorForRole('background', palette)).toBe('#101820');
    expect(paletteColorForRole('player', palette)).toBe('#f5ae39');
    expect(paletteColorForRole('enemy', palette)).toBe('#5c8374');
  });

  it('folds the role synonyms recipes actually use onto the same colours', () => {
    // recipe-arena-2d writes `avatar`/`threat` where others write `player`/`enemy`; both must land
    // on the same swatch or the two recipes would come out looking unrelated.
    expect(paletteColorForRole('avatar', palette)).toBe(paletteColorForRole('player', palette));
    expect(paletteColorForRole('threat', palette)).toBe(paletteColorForRole('enemy', palette));
    expect(paletteColorForRole('pickup', palette)).toBe(
      paletteColorForRole('collectible', palette)
    );
    // …and the three of them stay distinct from each other.
    expect(
      new Set([
        paletteColorForRole('avatar', palette),
        paletteColorForRole('threat', palette),
        paletteColorForRole('background', palette),
      ]).size
    ).toBe(3);
  });

  it('normalises role spelling and falls back for unknown roles', () => {
    expect(paletteColorForRole('  Background ', palette)).toBe('#101820');
    expect(paletteColorForRole('power-up', palette)).toBe(
      paletteColorForRole('collectible', palette)
    );
  });

  it('never indexes past a short palette, and reports nothing for an empty one', () => {
    expect(paletteColorForRole('ui', ['#ffffff'])).toBe('#ffffff');
    expect(paletteColorForRole('player', ['#ffffff'])).toBe('#ffffff');
    expect(paletteColorForRole('player', [])).toBeNull();
  });
});
