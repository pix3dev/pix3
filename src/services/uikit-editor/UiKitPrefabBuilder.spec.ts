import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Texture } from 'three';

import {
  AssetLoader,
  AudioService,
  Button2D,
  Label2D,
  Node2D,
  ResourceManager,
  SceneLoader,
  ScriptRegistry,
  TiledSprite2D,
} from '@pix3/runtime';
import { DEFAULT_THEME, buildTemplate, normalizeTheme, walkTemplate } from '@/services/uikit';
import { UiKitPrefabBuilder, UI_PREFAB_ROOT } from '@/services/uikit-editor/UiKitPrefabBuilder';
import {
  iconPartKey,
  partKey,
  type KitManifest,
  type KitPartRecord,
} from '@/services/uikit-editor/UiKitProjectWriter';
import { appState, resetAppState } from '@/state';

/**
 * Templates → prefabs (plan Ф3). The load-bearing claim is that the YAML this writes is an
 * ordinary `.pix3scene` the engine's own loader accepts — so every test here goes through
 * `SceneLoader`, never through a string match on the YAML.
 */

/**
 * happy-dom has no canvas 2D context, and `Label2D` lays its text out in one at construction —
 * the prefab tree contains labels, so without this stub the builder cannot run headless.
 */
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function stub(kind: string) {
    if (kind !== '2d') return null;
    return {
      setTransform: () => {},
      scale: () => {},
      fillRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      shadowColor: '',
      shadowBlur: 0,
      font: '',
      textAlign: 'center',
      textBaseline: 'middle',
    } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

const KIT_ID = 'feedface';

function createManifest(): KitManifest {
  const parts: Record<string, KitPartRecord> = {};
  const put = (key: string, over: Partial<KitPartRecord> = {}) => {
    parts[key] = {
      path: `sprites/ui/${KIT_ID}/${key.replace(/\//g, '_')}.png`,
      w: 128,
      h: 128,
      sliceBorder: { left: 16, right: 16, top: 12, bottom: 22 },
      role: null,
      component: 'panel-body',
      state: null,
      ...over,
    };
  };
  put(partKey('panel-body', 'sky'), { role: 'sky' });
  put(partKey('header-plate', 'sky'), { role: 'sky', component: 'header-plate' });
  for (const role of ['red', 'green', 'gray', 'blue'] as const) {
    for (const state of ['normal', 'hover', 'pressed', 'disabled'] as const) {
      put(partKey('button', role, state), { role, component: 'button', state });
      // A glyph button is not nine-sliced: its icon sits in the stretched middle.
      put(iconPartKey('close', role, state), {
        role,
        component: 'icon-button',
        state,
        icon: 'close',
        sliceBorder: null,
      });
    }
  }
  return {
    version: '1.0',
    generator: 'UI Kit Forge',
    kitId: KIT_ID,
    scale: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    theme: {} as KitManifest['theme'],
    parts,
    warnings: [],
  };
}

function createBuilder() {
  const builder = new UiKitPrefabBuilder();
  const written = new Map<string, string>();
  Object.defineProperty(builder, 'storage', {
    value: {
      createDirectory: vi.fn(async () => undefined),
      writeTextFile: vi.fn(async (path: string, contents: string) => {
        written.set(path, contents);
      }),
      readTextFile: vi.fn(async () => {
        throw new Error('missing');
      }),
    },
    configurable: true,
  });
  Object.defineProperty(builder, 'writer', {
    value: { readManifest: vi.fn(async () => createManifest()) },
    configurable: true,
  });
  return { builder, written };
}

/** Parse a serialized prefab with the engine's own loader, texture cache pre-seeded. */
async function parse(yaml: string, manifest: KitManifest) {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
  for (const part of Object.values(manifest.parts)) {
    cache.set(`res://${part.path}`, new Texture());
  }
  const loader = new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
  return loader.parseScene(yaml, {
    filePath: `res://${UI_PREFAB_ROOT}/dialog-${KIT_ID}.pix3scene`,
  });
}

describe('UiKitPrefabBuilder.buildYaml', () => {
  const theme = normalizeTheme(DEFAULT_THEME);

  it('round-trips through SceneLoader with unique node names', async () => {
    const { builder } = createBuilder();
    const manifest = createManifest();

    const { yaml, nodeNames } = builder.buildYaml('dialog', theme, manifest);
    const graph = await parse(yaml, manifest);

    expect(graph.rootNodes).toHaveLength(1);
    expect(graph.rootNodes[0].name).toBe('Dialog');
    expect(new Set(nodeNames).size).toBe(nodeNames.length);

    const names: string[] = [];
    graph.nodeMap.forEach(node => names.push(node.name));
    expect(new Set(names).size).toBe(names.length);
    // Every template node made it across.
    const templateNodes: string[] = [];
    walkTemplate(buildTemplate('dialog', theme).root, node => templateNodes.push(node.name));
    expect(names.length).toBe(templateNodes.length);
  });

  it('gives the frame its texture and nine-slice border', async () => {
    const { builder } = createBuilder();
    const manifest = createManifest();

    const graph = await parse(builder.buildYaml('dialog', theme, manifest).yaml, manifest);
    const frame = [...graph.nodeMap.values()].find(node => node.name === 'Frame');

    expect(frame).toBeInstanceOf(TiledSprite2D);
    const tiled = frame as TiledSprite2D;
    expect(tiled.texture?.url).toBe(`res://${manifest.parts[partKey('panel-body', 'sky')].path}`);
    expect(tiled.patchMode).toBe('nine-slice');
    expect(tiled.sliceBorder).toEqual({ left: 16, right: 16, top: 12, bottom: 22 });
  });

  it('gives the close button four GLYPH state textures and an anchor', async () => {
    const { builder } = createBuilder();
    const manifest = createManifest();

    const graph = await parse(builder.buildYaml('dialog', theme, manifest).yaml, manifest);
    const close = [...graph.nodeMap.values()].find(node => node.name === 'CloseButton');

    expect(close).toBeInstanceOf(Button2D);
    const button = close as Button2D;
    // Glyph, not the word "Close": the caption travels as art nowhere, and a translated word
    // would not fit a 54 px square.
    expect(button.label).toBe('');
    expect(button.textureNormal?.url).toContain('icon-button_close_red_normal');
    expect(button.textureHover?.url).toContain('icon-button_close_red_hover');
    expect(button.texturePressed?.url).toContain('icon-button_close_red_pressed');
    expect(button.textureDisabled?.url).toContain('icon-button_close_red_disabled');
    // No nine-slice: the glyph lives in the region a nine-slice would stretch.
    expect(button.sliceBorder).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(button.layoutEnabled).toBe(true);
    expect(button.horizontalAlign).toBe('right');
    expect(button.verticalAlign).toBe('top');
  });

  it('converts the template rectangle into a centre-origin, y-up position', async () => {
    const { builder } = createBuilder();
    const manifest = createManifest();
    const spec = buildTemplate('dialog', theme);

    const graph = await parse(builder.buildYaml('dialog', theme, manifest).yaml, manifest);
    const close = [...graph.nodeMap.values()].find(node => node.name === 'CloseButton') as Node2D;
    const template = (spec.root.children ?? []).find(child => child.name === 'CloseButton')!;

    expect(close.position.x).toBeCloseTo(template.x + template.w / 2 - spec.root.w / 2, 3);
    // Template y grows DOWN; pix3's 2D y grows UP.
    expect(close.position.y).toBeCloseTo(spec.root.h / 2 - (template.y + template.h / 2), 3);
  });

  it('carries the engine-drawn caption onto the Label2D rather than baking it', async () => {
    const { builder } = createBuilder();
    const manifest = createManifest();

    const graph = await parse(
      builder.buildYaml('dialog', theme, manifest, { lang: 'en', title: 'Are you sure?' }).yaml,
      manifest
    );
    const title = [...graph.nodeMap.values()].find(node => node.name === 'Title');

    expect(title).toBeInstanceOf(Label2D);
    expect((title as Label2D).label).toBe('Are you sure?');
  });

  it('builds the settings template with a row per setting', async () => {
    const { builder } = createBuilder();
    const manifest = createManifest();

    const graph = await parse(builder.buildYaml('settings', theme, manifest).yaml, manifest);
    const names: string[] = [];
    graph.nodeMap.forEach(node => names.push(node.name));

    expect(names).toContain('Row1Label');
    expect(names).toContain('Row1Toggle');
    expect(names).toContain('Row3Toggle');
  });

  it('warns instead of throwing when no kit has been baked', () => {
    const { builder } = createBuilder();
    const { warnings, yaml } = builder.buildYaml('dialog', theme, null);
    expect(warnings.join(' ')).toMatch(/design\/ui-kit\.json/);
    expect(yaml).toContain('Dialog');
  });
});

describe('UiKitPrefabBuilder.buildAndWrite', () => {
  it('writes prefabs/ui/<id>-<kitId>.pix3scene and reports the resource path', async () => {
    resetAppState();
    appState.project.status = 'ready';
    try {
      const { builder, written } = createBuilder();
      const result = await builder.buildAndWrite('dialog', normalizeTheme(DEFAULT_THEME));

      expect(result.path).toBe(`${UI_PREFAB_ROOT}/dialog-${KIT_ID}.pix3scene`);
      expect(result.resourcePath).toBe(`res://${result.path}`);
      expect(written.get(result.path)).toContain('Dialog');
    } finally {
      resetAppState();
    }
  });

  it('refuses without an open project', async () => {
    resetAppState();
    const { builder } = createBuilder();
    await expect(builder.buildAndWrite('dialog', normalizeTheme(DEFAULT_THEME))).rejects.toThrow(
      /No project/
    );
  });
});
