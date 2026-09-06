import { describe, expect, it, vi } from 'vitest';

import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { Bar2D, Button2D, NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { ApplyUiKitSkinOperation } from '@/features/uikit/ApplyUiKitSkinOperation';
import { ApplyUiKitSkinCommand } from '@/features/uikit/ApplyUiKitSkinCommand';
import {
  partKey,
  type KitManifest,
  type KitPartRecord,
} from '@/services/uikit-editor/UiKitProjectWriter';

/**
 * Applying a baked kit to a selection. The whole point of routing through
 * `UpdateObjectPropertyOperation` is that it is undoable, so every assertion here is paired with a
 * Ctrl+Z assertion — a skin that cannot be taken off is worse than no skin.
 */

const record = (path: string, over: Partial<KitPartRecord> = {}): KitPartRecord => ({
  path,
  w: 250,
  h: 88,
  sliceBorder: { left: 24, right: 24, top: 20, bottom: 30 },
  role: 'blue',
  component: 'button',
  state: null,
  ...over,
});

function createManifest(): KitManifest {
  const parts: Record<string, KitPartRecord> = {};
  for (const state of ['normal', 'hover', 'pressed', 'disabled'] as const) {
    parts[partKey('button', 'blue', state)] = record(`sprites/ui/abcd1234/btn_blue_${state}.png`, {
      state,
    });
  }
  parts[partKey('bar-trough')] = record('sprites/ui/abcd1234/bar-trough.png', {
    component: 'bar-trough',
    role: null,
    sliceBorder: { left: 8, right: 8, top: 6, bottom: 6 },
  });
  parts[partKey('bar-fill', 'blue')] = record('sprites/ui/abcd1234/bar-fill_blue.png', {
    component: 'bar-fill',
  });
  parts[partKey('panel-body', 'blue')] = record('sprites/ui/abcd1234/panel-body_blue.png', {
    component: 'panel-body',
  });
  return {
    version: '1.0',
    generator: 'UI Kit Forge',
    kitId: 'abcd1234',
    scale: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    typography: {
      family: 'Lilita One',
      cyrFamily: 'Rubik',
      weight: 400,
      cyrWeight: 800,
      outlineWidth: 1.5,
      outlineColor: '#181410',
      shadowColor: '#181410',
      shadowOffsetX: 0,
      shadowOffsetY: 2,
      letterSpacing: 1,
      inkColor: '#ffffff',
    },
    theme: {} as KitManifest['theme'],
    parts,
    warnings: [],
  };
}

function createContext(nodes: NodeBase[]) {
  const state = createInitialAppState();
  state.project.status = 'ready';
  state.scenes.activeSceneId = 'scene-1';
  state.scenes.descriptors['scene-1'] = {
    id: 'scene-1',
    filePath: 'res://scene.pix3scene',
    name: 'Scene',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };
  state.selection.nodeIds = nodes.map(node => node.nodeId);
  state.selection.primaryNodeId = nodes[0]?.nodeId ?? null;

  const sceneGraph = {
    version: '1.0.0',
    description: 'Scene',
    metadata: {},
    rootNodes: nodes,
    nodeMap: new Map(nodes.map(node => [node.nodeId, node])),
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) {
        return { getActiveSceneGraph: () => sceneGraph } as T;
      }
      if (token === ViewportRendererService) {
        return {
          updateNodeTransform: vi.fn(),
          updateNodeVisibility: vi.fn(),
          updateSelection: vi.fn(),
        } as T;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  return {
    state,
    snapshot: structuredClone(state),
    container: container as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;
}

describe('ApplyUiKitSkinOperation', () => {
  it('gives a Button2D all four state textures plus the nine-slice border, and undoes them', async () => {
    const button = new Button2D({ id: 'btn-1', name: 'Play', width: 250, height: 88 });
    const context = createContext([button]);
    const manifest = createManifest();

    const result = await new ApplyUiKitSkinOperation({
      nodeIds: ['btn-1'],
      colorRole: 'blue',
      manifest,
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(button.textureNormal?.url).toBe('res://sprites/ui/abcd1234/btn_blue_normal.png');
    expect(button.textureHover?.url).toBe('res://sprites/ui/abcd1234/btn_blue_hover.png');
    expect(button.texturePressed?.url).toBe('res://sprites/ui/abcd1234/btn_blue_pressed.png');
    expect(button.textureDisabled?.url).toBe('res://sprites/ui/abcd1234/btn_blue_disabled.png');
    expect(button.sliceBorder).toEqual({ left: 24, right: 24, top: 20, bottom: 30 });

    await result.commit?.undo();
    expect(button.textureNormal).toBeNull();
    expect(button.textureHover).toBeNull();
    expect(button.sliceBorder).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });

    await result.commit?.redo();
    expect(button.textureNormal?.url).toBe('res://sprites/ui/abcd1234/btn_blue_normal.png');
    expect(button.sliceBorder.left).toBe(24);
  });

  it('skins a Bar2D from the trough/fill pair and takes its border from the trough', async () => {
    const bar = new Bar2D({ id: 'bar-1', name: 'HP', width: 240, height: 36 });
    const context = createContext([bar]);

    const result = await new ApplyUiKitSkinOperation({
      nodeIds: ['bar-1'],
      colorRole: 'blue',
      manifest: createManifest(),
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(bar.textureTrough?.url).toBe('res://sprites/ui/abcd1234/bar-trough.png');
    expect(bar.textureFill?.url).toBe('res://sprites/ui/abcd1234/bar-fill_blue.png');
    expect(bar.sliceBorder).toEqual({ left: 8, right: 8, top: 6, bottom: 6 });
  });

  it('leaves node types the kit has nothing for alone', async () => {
    const sprite = new Sprite2D({ id: 'sprite-1', name: 'Bg', width: 64, height: 64 });
    const plain = new NodeBase({ id: 'plain-1', type: 'Node3D', name: 'Rig' });
    const context = createContext([sprite, plain]);

    const result = await new ApplyUiKitSkinOperation({
      nodeIds: ['sprite-1', 'plain-1'],
      colorRole: 'blue',
      manifest: createManifest(),
    }).perform(context);

    expect(result.didMutate).toBe(true);
    // Sprite2D wears the panel body; the Node3D is untouched.
    expect(sprite.texture?.url).toBe('res://sprites/ui/abcd1234/panel-body_blue.png');
    expect(plain.properties.texture).toBeUndefined();
  });

  /**
   * The asymmetry the T0 expander depends on. A caption colour is a CHOICE — the recipe picks one
   * for its placeholder ground, the user picks one in the inspector — so a re-skin may not repaint
   * it. Only a caller dressing a node for the first time passes `inkColor`.
   */
  it('leaves labelColor alone unless the caller passes inkColor', async () => {
    const button = new Button2D({
      id: 'btn-ink',
      name: 'Play',
      width: 250,
      height: 88,
      labelColor: '#141a2e',
    });
    const context = createContext([button]);

    await new ApplyUiKitSkinOperation({
      nodeIds: ['btn-ink'],
      colorRole: 'blue',
      manifest: createManifest(),
    }).perform(context);

    // The art and the face changed; the colour did not.
    expect(button.textureNormal?.url).toBe('res://sprites/ui/abcd1234/btn_blue_normal.png');
    expect(button.labelFontFamily).toBe('Lilita One');
    expect(button.labelColor).toBe('#141a2e');
  });

  it('writes labelColor — and undoes it — when inkColor is given', async () => {
    const button = new Button2D({
      id: 'btn-ink-2',
      name: 'Play',
      width: 250,
      height: 88,
      labelColor: '#141a2e',
    });
    const context = createContext([button]);

    const result = await new ApplyUiKitSkinOperation({
      nodeIds: ['btn-ink-2'],
      colorRole: 'blue',
      manifest: createManifest(),
      inkColor: '#fff8e7',
    }).perform(context);

    expect(button.labelColor).toBe('#fff8e7');
    await result.commit?.undo();
    expect(button.labelColor).toBe('#141a2e');
  });

  it('does nothing when nothing in the selection is skinnable', async () => {
    const plain = new NodeBase({ id: 'plain-2', type: 'Node3D', name: 'Rig' });
    const context = createContext([plain]);

    const result = await new ApplyUiKitSkinOperation({
      nodeIds: ['plain-2'],
      colorRole: 'blue',
      manifest: createManifest(),
    }).perform(context);

    expect(result.didMutate).toBe(false);
  });
});

describe('ApplyUiKitSkinCommand', () => {
  it('is reachable from the agent: a `properties.`-prefixed id with a usable zero-argument form', () => {
    const command = new ApplyUiKitSkinCommand();
    expect(command.metadata.id).toBe('properties.apply-uikit-skin');
    expect(command.metadata.id.startsWith('properties.')).toBe(true);
  });

  it('blocks with a reason when the selection is empty', () => {
    const button = new Button2D({ id: 'btn-2', name: 'Play' });
    const context = createContext([button]);
    context.state.selection.nodeIds = [];

    const result = new ApplyUiKitSkinCommand().preconditions(context);
    expect(result.canExecute).toBe(false);
    expect(result.canExecute === false && result.scope).toBe('selection');
  });

  /**
   * `inkColor` has to survive the hop through the command, because that is the only door
   * `create_node`'s auto-skin has to the operation.
   */
  it('forwards inkColor to the operation, and omits it when unset', async () => {
    const forwarded: Record<string, unknown>[] = [];
    const button = new Button2D({ id: 'btn-4', name: 'Play', width: 250, height: 88 });
    const context = createContext([button]);
    const manifest = createManifest();
    const container = {
      getOrCreateToken: <T>(token: T): T => token,
      getService: (token: unknown): unknown => {
        if (String((token as { name?: string })?.name) === 'UiKitProjectWriter') {
          return { readManifest: async () => manifest };
        }
        return {
          invokeAndPush: async (operation: unknown) => {
            forwarded.push(
              (operation as { params: Record<string, unknown> }).params as Record<string, unknown>
            );
            return true;
          },
        };
      },
    };
    const commandContext = {
      ...context,
      container: container as unknown as OperationContext['container'],
    } as unknown as Parameters<ApplyUiKitSkinCommand['execute']>[0];

    await new ApplyUiKitSkinCommand({
      nodeIds: ['btn-4'],
      colorRole: 'green',
      manifest,
      inkColor: '#101010',
    }).execute(commandContext);
    await new ApplyUiKitSkinCommand({ nodeIds: ['btn-4'], colorRole: 'green', manifest }).execute(
      commandContext
    );

    expect(forwarded[0].inkColor).toBe('#101010');
    expect(forwarded[1]).not.toHaveProperty('inkColor');
  });

  it('blocks when no project is open', () => {
    const button = new Button2D({ id: 'btn-3', name: 'Play' });
    const context = createContext([button]);
    context.state.project.status = 'idle';

    const result = new ApplyUiKitSkinCommand().preconditions(context);
    expect(result.canExecute).toBe(false);
    expect(result.canExecute === false && result.scope).toBe('project');
  });
});
