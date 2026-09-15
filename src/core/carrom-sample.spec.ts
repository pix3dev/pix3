import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AssetLoader,
  AudioService,
  registerBuiltInScripts,
  ResourceManager,
  SceneLoader,
  ScriptRegistry,
  type NodeBase,
} from '@pix3/runtime';

/**
 * Parse-check for the Carrom sample.
 *
 * The sample's whole physics contract is positional: pockets, cushions and the
 * baseline are hand-authored numbers that the rules code re-derives from its own
 * constants. A node that loads at the wrong place — or silently drops its
 * transform — turns into "the pockets don't work", which is expensive to chase in
 * a running editor. This loads the real YAML through the real `SceneLoader` and
 * pins the handful of facts everything else rides on.
 */

const SAMPLE_ROOT = 'samples/Carrom';

/**
 * happy-dom has no 2D canvas, and `Label2D` builds its texture by measuring and
 * painting text in its constructor — so a scene with any UI text cannot be
 * parsed headlessly at all without this. The stub answers every call; only
 * `measureText` has to return something shaped, and nothing here asserts on
 * glyphs, so a flat width estimate is enough.
 */
function installCanvas2DStub(): void {
  const proto = globalThis.HTMLCanvasElement?.prototype as
    | (HTMLCanvasElement & { getContext: unknown })
    | undefined;
  if (!proto) return;
  proto.getContext = function stubGetContext(kind: string) {
    if (kind !== '2d') return null;
    const gradient = { addColorStop: () => {} };
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'measureText') {
            return (text: string) => ({
              width: text.length * 10,
              actualBoundingBoxAscent: 10,
              actualBoundingBoxDescent: 3,
              actualBoundingBoxLeft: 0,
              actualBoundingBoxRight: text.length * 10,
            });
          }
          if (prop === 'canvas') return { width: 1, height: 1 };
          if (prop.startsWith('create')) return () => gradient;
          if (prop === 'getImageData') {
            return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
          }
          return () => undefined;
        },
        set: () => true,
      }
    );
  } as unknown as HTMLCanvasElement['getContext'];
}

/** The sample's `user:` scripts are not registered here, so the loader must tolerate unknown ones. */
function createLoader(): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  return new SceneLoader(assetLoader, registry, new ResourceManager('/'));
}

async function loadScene(relative: string) {
  const yaml = readFileSync(resolve(process.cwd(), SAMPLE_ROOT, relative), 'utf8');
  return createLoader().parseScene(yaml, { filePath: `res://${relative}` });
}

function walk(nodes: readonly NodeBase[], visit: (node: NodeBase) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children as NodeBase[], visit);
  }
}

function findByName(nodes: readonly NodeBase[], name: string): NodeBase | null {
  let found: NodeBase | null = null;
  walk(nodes, node => {
    if (!found && node.name === name) found = node;
  });
  return found;
}

/** World-space x/y of a 2D node, walking up through its parents. */
function worldXY(node: NodeBase): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cursor: NodeBase | null = node;
  while (cursor) {
    const pos = (cursor as unknown as { position?: { x: number; y: number } }).position;
    if (pos) {
      x += pos.x;
      y += pos.y;
    }
    cursor = (cursor as unknown as { parent?: NodeBase | null }).parent ?? null;
  }
  return { x, y };
}

describe('Carrom sample', () => {
  beforeAll(() => {
    installCanvas2DStub();
  });

  it('parses the main scene with every node type the engine knows', async () => {
    const scene = await loadScene('scenes/main.pix3scene');
    expect(scene.rootNodes.length).toBeGreaterThan(0);

    const unknown: string[] = [];
    walk(scene.rootNodes, node => {
      // The loader falls back to a bare node for a type it does not know; such a
      // node keeps neither the sprite nor the collider, so the board would render
      // empty and nothing would collide.
      if (node.constructor.name === 'Object' || node.constructor.name === 'NodeBase') {
        unknown.push(`${node.name} (${node.constructor.name})`);
      }
    });
    expect(unknown).toEqual([]);
  });

  it('keeps the striker on the human baseline', async () => {
    const scene = await loadScene('scenes/main.pix3scene');
    const striker = findByName(scene.rootNodes, 'Striker');
    expect(striker).not.toBeNull();
    const at = worldXY(striker as NodeBase);
    // Spec §3: the striker sits on the placement line, midway between the two
    // baselines, at negative y (the human's edge).
    expect(at.y).toBeCloseTo(-346, 3);
    expect(Math.abs(at.x)).toBeLessThanOrEqual(240);
  });

  it('places the four cushions so their inner faces land on the playfield edge', async () => {
    const scene = await loadScene('scenes/main.pix3scene');
    // Faces at ±440 with 80-thick rects means centres at ±480.
    for (const [name, axis, sign] of [
      ['CushionTop', 'y', 1],
      ['CushionBottom', 'y', -1],
      ['CushionLeft', 'x', -1],
      ['CushionRight', 'x', 1],
    ] as const) {
      const node = findByName(scene.rootNodes, name);
      expect(node, `${name} missing`).not.toBeNull();
      const at = worldXY(node as NodeBase);
      expect(at[axis], `${name} ${axis}`).toBeCloseTo(480 * sign, 3);
    }
  });

  it('parses all three disc prefabs and gives each a body and a collider', async () => {
    for (const file of ['man-white', 'man-black', 'queen']) {
      const scene = await loadScene(`scenes/${file}.pix3scene`);
      expect(scene.rootNodes.length, file).toBe(1);
      const root = scene.rootNodes[0];
      const types = root.components.map(c => c.constructor.name);
      expect(types.join(','), file).toMatch(/PhysicsBody2D/);
      expect(types.join(','), file).toMatch(/Collider2D/);
    }
  });
});
