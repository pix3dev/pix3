// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import { runTreeCli } from './command.ts';
import type { TreeNode } from './tree.ts';

/**
 * `pix3 tree` on a real recipe (scaffolded by `pix3 new`) and on a scene that instances a prefab
 * with overrides. Asserted through the CLI entry, so the printed form is what an agent reads.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-tree-spec-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = async (
  cwd: string,
  argv: string[]
): Promise<{ code: number; out: string; err: string }> => {
  let out = '';
  let err = '';
  const code = await runTreeCli(argv, {
    cwd,
    stdout: text => void (out += text),
    stderr: text => void (err += text),
  });
  return { code, out, err };
};

const flatten = (nodes: readonly TreeNode[]): TreeNode[] =>
  nodes.flatMap(node => [node, ...flatten(node.children)]);

describe('pix3 tree on the tapper recipe', () => {
  const dir = join(scratch, 'tapper');
  beforeAll(() => {
    const template = listTemplates().find(t => t.id === 'recipe-tapper-2d');
    if (!template) throw new Error('recipe-tapper-2d template missing');
    createProject({ template, dir, projectName: 'Tapper' });
  });

  it('prints one line per node, indented, with position/size/layout/components', async () => {
    const { code, out } = await run(dir, ['scenes/main.pix3scene']);
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toBe('scenes/main.pix3scene — 12 nodes');
    expect(lines).toContain(
      'Group2D#game-root "Game Root" size=1080x1920 layout=stretch/stretch  components=[user:GameRules, user:TouchRules]'
    );
    expect(lines).toContain(
      '    Label2D#score-label "Score Label" text="SCORE 0" pos=(-340,850) layout=left/top'
    );
    expect(lines).toContain(
      '    Group2D#result-overlay "Result Overlay" ↳ instance res://scenes/ui/result.pix3scene (1 property) hidden'
    );
  });

  it('--depth cuts subtrees and says how much is below', async () => {
    const { out } = await run(dir, ['res://scenes/main.pix3scene', '--depth', '0']);
    expect(out.split('\n')[0]).toBe('scenes/main.pix3scene — 12 nodes, 1 shown to depth 0');
    expect(out).toContain('components=[user:GameRules, user:TouchRules]  … +11 below');
  });

  it('--types keeps matches and their ancestors as context', async () => {
    const { out } = await run(dir, ['scenes/main.pix3scene', '--types', 'label2d,instance']);
    const lines = out.trimEnd().split('\n').slice(1);
    expect(lines.map(line => line.trim().split(' ')[0])).toEqual([
      '·',
      '·',
      'Label2D#score-label',
      'Label2D#time-label',
      'Group2D#result-overlay',
    ]);
  });

  it('--props prints only what differs from the type defaults', async () => {
    const { out } = await run(dir, ['scenes/main.pix3scene', '--props']);
    const lines = out.split('\n');
    const background = lines.findIndex(line => line.includes('ColorRect2D#game-background'));
    // Authored transform scale (1,1) / rotation 0 and layout.enabled are defaults or on the line.
    expect(lines[background + 1].trim()).toBe('color=#141a2e');
    const bar = lines.findIndex(line => line.includes('Bar2D#lives-bar'));
    expect(lines[bar + 1]).toContain('barColor=#ff4d6d');
    expect(lines[bar + 1]).not.toContain('transform.');
  });

  it('--json returns the same as a nested structure', async () => {
    const { code, out } = await run(dir, ['scenes/main.pix3scene', '--json']);
    expect(code).toBe(0);
    const json = JSON.parse(out) as { scene: string; nodes: TreeNode[] };
    expect(json.scene).toBe('scenes/main.pix3scene');
    const all = flatten(json.nodes);
    expect(all).toHaveLength(12);
    expect(all.find(n => n.id === 'hud')).toMatchObject({
      type: 'CanvasLayer2D',
      name: 'HUD',
      depth: 1,
      layout: 'stretch/stretch',
      components: [{ type: 'user:ScoreHud', enabled: true }],
    });
    expect(all.find(n => n.id === 'result-overlay')).toMatchObject({
      type: 'Group2D',
      hidden: true,
      instance: {
        path: 'res://scenes/ui/result.pix3scene',
        rootType: 'Group2D',
        overrides: 0,
        properties: 1,
      },
    });
  });

  it('with no scene: the project overview', async () => {
    const { code, out } = await run(dir, []);
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toBe('"Tapper" — 2d, 1080x1920, entry scenes/menu.pix3scene (*)');
    expect(lines[1]).toBe(
      'scripts: user:GameRules user:MenuFlow user:ScoreHud user:Spawner user:TouchRules'
    );
    expect(out).toMatch(/scenes\/main\.pix3scene +scene +12 nodes +Group2D×4/);
    expect(out).toMatch(/scenes\/menu\.pix3scene \* +scene/);
    expect(out).toMatch(/scenes\/prefabs\/target\.pix3scene +prefab +1 node +Sprite2D/);
    expect(out).toMatch(/scenes\/ui\/result\.pix3scene +overlay/);
    expect(out).toContain('instances: scenes/ui/result.pix3scene');
    expect(lines.length).toBeLessThan(25);
  });
});

describe('pix3 tree on a prefab-instance scene', () => {
  const dir = join(scratch, 'instances');
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  beforeAll(() => {
    write('pix3project.yaml', 'version: 1.0.0\nprojectType: 2d\n');
    write(
      'scenes/prefabs/enemy.pix3scene',
      `version: 1.0.0
root:
  - id: enemy
    type: Sprite2D
    name: Enemy
    properties:
      width: 64
      height: 64
    children:
      - id: hp
        type: Bar2D
        name: HP
`
    );
    write(
      'scenes/level.pix3scene',
      `version: 1.0.0
root:
  - id: world
    type: Group2D
    name: World
    children:
      - id: enemy-a
        name: Enemy A
        instance: res://scenes/prefabs/enemy.pix3scene
        properties:
          transform:
            position: [100, 200]
          visible: true
        overrides:
          byLocalId:
            hp:
              properties:
                value: 3
                maxValue: 5
      - id: enemy-b
        instance: res://scenes/prefabs/missing.pix3scene
`
    );
  });

  it('shows each instance with its prefab, root type, and overrides apart from own properties', async () => {
    const { code, out } = await run(dir, ['scenes/level.pix3scene']);
    expect(code).toBe(0);
    expect(out.split('\n')).toEqual([
      'scenes/level.pix3scene — 3 nodes',
      'Group2D#world "World"',
      // 2 keys under overrides.byLocalId.hp.properties; 1 key (transform) in the instance's own block.
      '  Sprite2D#enemy-a "Enemy A" ↳ instance res://scenes/prefabs/enemy.pix3scene (2 overrides, 2 properties) pos=(100,200)',
      '  Instance#enemy-b ↳ instance res://scenes/prefabs/missing.pix3scene (no overrides)',
      '',
    ]);
  });

  it('--props on an instance lists its overrides verbatim', async () => {
    const { out } = await run(dir, ['scenes/level.pix3scene', '--props', '--json']);
    const json = JSON.parse(out) as { nodes: TreeNode[] };
    const enemy = flatten(json.nodes).find(n => n.id === 'enemy-a');
    expect(enemy?.instance).toEqual({
      path: 'res://scenes/prefabs/enemy.pix3scene',
      rootType: 'Sprite2D',
      rootName: 'Enemy',
      overrides: 2,
      properties: 2,
    });
  });

  it('the prefab itself is a prefab in the overview', async () => {
    const { out } = await run(dir, ['--json']);
    const json = JSON.parse(out) as {
      scenes: Array<{ path: string; kind: string; nodes: number }>;
    };
    expect(json.scenes.map(s => [s.path, s.kind, s.nodes])).toEqual([
      ['scenes/level.pix3scene', 'scene', 3],
      ['scenes/prefabs/enemy.pix3scene', 'prefab', 2],
    ]);
  });

  it('exit codes: missing file 2, unparsable scene 1, bad flag 2', async () => {
    expect((await run(dir, ['scenes/nope.pix3scene'])).code).toBe(2);
    write('scenes/broken.pix3scene', 'root: [\n');
    expect((await run(dir, ['scenes/broken.pix3scene'])).code).toBe(1);
    expect((await run(dir, ['--depth', '-1'])).code).toBe(2);
  });
});
