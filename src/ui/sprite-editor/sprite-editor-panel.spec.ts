import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { AnimationResource } from '@pix3/runtime';

import { OpenGeneratePanelCommand } from '@/features/editor/OpenGeneratePanelCommand';
import type { ImageEditTarget } from '@/services/image-gen/ImageEditTargetService';

import type { AnimationDocumentController } from './animation-document-controller';
import { SpriteEditorPanel } from './sprite-editor-panel';

/**
 * The unified shell (C6). Everything animation-specific is driven by the one
 * `AnimationDocumentController` the shell owns, so the assertions below go through
 * controller state and the services it was handed — never through DOM events, which
 * this side of the editor deliberately does not use for data.
 *
 * Every `@inject` field is shadowed with a stub: the real graph reaches
 * IndexedDB, the Golden Layout manager and the File System Access API, none of
 * which say anything about the shell's behaviour.
 */
const ANIMATION_PATH = 'res://sprites/walk/walk.pix3anim';
const ANIMATION_ID = 'sprites-walk-walk';
const ANIMATION_TAB_ID = `animation:${ANIMATION_PATH}`;
const IMAGE_PATH = 'res://sprites/ex0059.png';
const IMAGE_TAB_ID = `sprite-editor:${IMAGE_PATH}`;

interface PanelInternals {
  documentController: AnimationDocumentController | null;
  boundFrameTexturePath: string | null;
  isTextureDragOver: boolean;
  textureDragDepth: number;
  current: {
    blob: Blob;
    mimeType: string;
    objectUrl: string;
    source: string;
    width?: number;
    height?: number;
  } | null;
  cropMode: boolean;
  cropRect: { x: number; y: number; w: number; h: number } | null;
  saveName: string;
  onApplyCrop(): Promise<void>;
}

/**
 * happy-dom has no 2D canvas, and the crop bake composites through one. Stand in
 * for it (only for `canvas`; Lit renders through `createElement` too) so the test
 * can reach the routing decision that follows the bake.
 */
function stubCropCanvas(output: Blob): void {
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: unknown) => {
    if (tagName !== 'canvas') {
      return realCreateElement(tagName, options as ElementCreationOptions | undefined);
    }
    const canvas = realCreateElement('canvas');
    Object.defineProperties(canvas, {
      getContext: { value: () => ({ drawImage: vi.fn() }), configurable: true },
      toBlob: {
        value: (callback: (blob: Blob | null) => void) => callback(output),
        configurable: true,
      },
    });
    return canvas;
  });
}

function createPreferences() {
  return {
    selectedProviderId: '',
    modelByProvider: {},
    defaultAspectRatio: 'Auto' as const,
    defaultImageSize: '1K',
    defaultQuality: '',
    transparentBackground: false,
    defaultSaveMaxSize: 0,
    bgRemovalEngine: 'imgly' as const,
    bgRemovalQuality: 'balanced' as const,
    bgFillHoles: true,
  };
}

interface PanelStubs {
  readBlob: ReturnType<typeof vi.fn>;
  updatePreferences: ReturnType<typeof vi.fn>;
  setActiveController: ReturnType<typeof vi.fn>;
  setActiveTarget: ReturnType<typeof vi.fn>;
  clearActiveTarget: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  preferences: ReturnType<typeof createPreferences>;
}

function createPanel(): { panel: SpriteEditorPanel; stubs: PanelStubs } {
  const panel = new SpriteEditorPanel();
  const preferences = createPreferences();
  // Reads never resolve to a decodable blob: the texture-preview loader swallows
  // the failure, and no detached promise is left hanging (the `.finally` gotcha).
  const readBlob = vi.fn().mockRejectedValue(new Error('no project storage in tests'));
  const updatePreferences = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(preferences, patch);
  });
  let activeController: AnimationDocumentController | null = null;
  const setActiveController = vi.fn((controller: AnimationDocumentController | null) => {
    activeController = controller;
  });
  // §9.8's mediation: the shell registers itself as the active image-edit target,
  // and the Generate panel (a different dock) renders against that registration.
  let activeTarget: ImageEditTarget | null = null;
  const setActiveTarget = vi.fn((target: ImageEditTarget | null) => {
    activeTarget = target;
  });
  const clearActiveTarget = vi.fn((target: ImageEditTarget) => {
    if (activeTarget === target) {
      activeTarget = null;
    }
  });
  const execute = vi.fn().mockResolvedValue(true);

  const stubs: Record<string, unknown> = {
    aiSettings: {
      getPreferences: () => ({ ...preferences }),
      getSelectedProvider: () => undefined,
      getSelectedModelId: () => undefined,
      hasApiKey: vi.fn().mockResolvedValue(false),
      subscribe: vi.fn().mockReturnValue(() => undefined),
      updatePreferences,
    },
    history: { add: vi.fn().mockResolvedValue(undefined) },
    bgRemoval: { removeBackground: vi.fn() },
    storage: { readBlob, writeBinaryFile: vi.fn(), createDirectory: vi.fn() },
    editorSettings: { showSettings: vi.fn() },
    commandDispatcher: { execute },
    assetLibrary: { isUserScopeSupported: () => false },
    sliceDialog: { showDialog: vi.fn().mockResolvedValue(null) },
    editorTabs: { focusOrOpenAnimation: vi.fn() },
    operations: { invokeAndPush: vi.fn().mockResolvedValue(true) },
    animationEditorService: {
      getActiveController: () => activeController,
      setActiveController,
    },
    imageEditTargets: {
      getActiveTarget: () => activeTarget,
      setActiveTarget,
      clearActiveTarget,
    },
    dialogService: { showConfirmation: vi.fn().mockResolvedValue(true) },
    sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map() }) },
    // §9.5's invalidation fan-out. Both are pure side-effect sinks here; the
    // controller spec asserts they are actually reached.
    viewportRenderer: { invalidateTexture: vi.fn(), requestRender: vi.fn() },
    assetLoader: { evictTexture: vi.fn() },
  };

  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  return {
    panel,
    stubs: {
      readBlob,
      updatePreferences,
      setActiveController,
      setActiveTarget,
      clearActiveTarget,
      execute,
      preferences,
    },
  };
}

function createResource(texturePaths: string[]): AnimationResource {
  return {
    version: '1.0.0',
    texturePath: '',
    clips: [
      {
        name: 'idle',
        fps: 12,
        loop: true,
        playbackMode: 'normal',
        frames: texturePaths.map(texturePath => ({
          textureIndex: 0,
          offset: { x: 0, y: 0 },
          repeat: { x: 1, y: 1 },
          durationMultiplier: 1,
          anchor: { x: 0.5, y: 1 },
          texturePath,
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        })),
      },
    ],
  };
}

function seedAnimationTab(texturePaths = ['res://sprites/walk/idle_0001.png']): void {
  appState.animations.descriptors[ANIMATION_ID] = {
    id: ANIMATION_ID,
    filePath: ANIMATION_PATH,
    name: 'walk.pix3anim',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    lastModifiedTime: null,
  };
  appState.animations.resources[ANIMATION_ID] = createResource(texturePaths);
  appState.tabs.tabs = [
    {
      id: ANIMATION_TAB_ID,
      resourceId: ANIMATION_PATH,
      type: 'animation',
      title: 'walk.pix3anim',
      isDirty: false,
    },
  ];
  appState.tabs.activeTabId = ANIMATION_TAB_ID;
}

function seedImageTab(): void {
  appState.tabs.tabs = [
    {
      id: IMAGE_TAB_ID,
      resourceId: IMAGE_PATH,
      type: 'sprite-editor',
      title: 'ex0059.png',
      isDirty: false,
    },
  ];
  appState.tabs.activeTabId = IMAGE_TAB_ID;
}

async function mount(panel: SpriteEditorPanel, tabId: string): Promise<void> {
  panel.tabId = tabId;
  document.body.appendChild(panel);
  await panel.updateComplete;
}

describe('SpriteEditorPanel (unified shell)', () => {
  beforeEach(() => {
    resetAppState();
    // `readBlob` rejects on purpose (see `createPanel`); the shell logs that and
    // carries on, which is the behaviour under test, not a failure to report.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('mounts the clips rail and timeline for a .pix3anim tab and owns one controller', async () => {
    seedAnimationTab();
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    expect(internals.documentController).not.toBeNull();
    expect(internals.documentController?.assetPath).toBe(ANIMATION_PATH);
    expect(internals.documentController?.activeClipName).toBe('idle');

    const rail = panel.querySelector('pix3-sprite-clips-rail');
    const timeline = panel.querySelector('pix3-sprite-timeline');
    expect(rail).not.toBeNull();
    expect(timeline).not.toBeNull();
    // Both surfaces drive the very same instance, so they cannot drift.
    expect(rail?.controller).toBe(internals.documentController);
    expect(timeline?.controller).toBe(internals.documentController);

    // §9.3 — the Inspector never sees a component, only this registration.
    expect(stubs.setActiveController).toHaveBeenCalledWith(internals.documentController);
  });

  it('creates no controller for a bare image tab and hosts no generation chrome', async () => {
    seedImageTab();
    const { panel } = createPanel();
    await mount(panel, IMAGE_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    expect(internals.documentController).toBeNull();
    expect(panel.querySelector('pix3-sprite-clips-rail')).toBeNull();
    expect(panel.querySelector('pix3-sprite-timeline')).toBeNull();

    // C6b lifted the AI rail out into <pix3-generate-panel>; the canvas gets the
    // whole shell instead of "shell minus rail".
    expect(panel.querySelector('.ag-ai-rail')).toBeNull();
    expect(panel.querySelector('.ag-prompt')).toBeNull();
    expect(panel.querySelector('.ag-history')).toBeNull();
    expect(panel.querySelector('.ag-references')).toBeNull();
  });

  it('rebinds the canvas to the texture of the frame selected in the timeline', async () => {
    seedAnimationTab(['res://sprites/walk/idle_0001.png', 'res://sprites/walk/idle_0002.png']);
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/idle_0001.png');
    });

    stubs.readBlob.mockClear();
    internals.documentController?.selectFrame(1);

    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/idle_0002.png');
    });
    // The binding runs the same `loadBoundImage` an image tab uses (§9.5).
    expect(stubs.readBlob).toHaveBeenCalledWith('res://sprites/walk/idle_0002.png');
  });

  /**
   * C8 gate — session restore. `animation` tabs are the only editor tabs of the two
   * that persist, so a stored `animation:res://…` entry must still reopen on the
   * shell *and* land on the clip/frame its `contextState` recorded.
   */
  it('opens a restored animation session tab on the clip and frame it stored', async () => {
    seedAnimationTab(['res://sprites/walk/idle_0001.png']);
    const runClip = createResource([
      'res://sprites/walk/run_0001.png',
      'res://sprites/walk/run_0002.png',
    ]).clips[0];
    appState.animations.resources[ANIMATION_ID].clips.push({ ...runClip, name: 'run' });
    appState.tabs.tabs[0].contextState = { activeClipName: 'run', selectedFrameIndex: 1 };

    const { panel } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    await vi.waitFor(() => {
      expect(internals.documentController?.activeClipName).toBe('run');
    });
    expect(internals.documentController?.selectedFrameIndex).toBe(1);
    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/run_0002.png');
    });
  });

  /**
   * C8 gate — multi-select. The timeline authors it (ctrl/shift-click) but the
   * action needs a host that sees the whole selection; a card's own trash icon only
   * ever removes that one frame.
   */
  it('deletes every selected frame from the toolbar action', async () => {
    seedAnimationTab([
      'res://sprites/walk/idle_0001.png',
      'res://sprites/walk/idle_0002.png',
      'res://sprites/walk/idle_0003.png',
    ]);
    const { panel } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const controller = (panel as unknown as PanelInternals).documentController;
    expect(controller).not.toBeNull();
    controller?.selectFrame(0);
    controller?.selectFrame(2, { ctrl: true });
    expect(controller?.getSelectedFrameIndices()).toEqual([0, 2]);

    const removeSelectedFrames = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(controller, 'removeSelectedFrames', {
      value: removeSelectedFrames,
      configurable: true,
    });
    await panel.updateComplete;

    const action = panel.querySelector<HTMLButtonElement>('.ag-delete-frames');
    expect(action?.disabled).toBe(false);
    expect(action?.title).toBe('Delete 2 selected frames');
    action?.click();

    expect(removeSelectedFrames).toHaveBeenCalledTimes(1);
  });

  it('registers as the active image-edit target and reports its frame binding', async () => {
    seedAnimationTab();
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    expect(stubs.setActiveTarget).toHaveBeenCalledWith(panel);

    await vi.waitFor(() => {
      expect((panel as unknown as PanelInternals).boundFrameTexturePath).toBe(
        'res://sprites/walk/idle_0001.png'
      );
    });

    const snapshot = panel.getImageEditSnapshot();
    expect(snapshot.targetId).toBe(ANIMATION_TAB_ID);
    expect(snapshot.label).toBe('walk.pix3anim');
    expect(snapshot.resourcePath).toBe(ANIMATION_PATH);
    expect(snapshot.boundFrameTexturePath).toBe('res://sprites/walk/idle_0001.png');
    // C7: baked pixels now have a frame to land in, so the Generate panel is
    // allowed to push straight at it.
    expect(snapshot.acceptsFrameWriteBack).toBe(true);
  });

  it('deregisters as the image-edit target when another tab becomes active', async () => {
    seedImageTab();
    const { panel, stubs } = createPanel();
    await mount(panel, IMAGE_TAB_ID);

    expect(stubs.setActiveTarget).toHaveBeenCalledWith(panel);
    stubs.clearActiveTarget.mockClear();

    appState.tabs.activeTabId = 'viewport:res://scenes/main.pix3scene';
    await vi.waitFor(() => {
      expect(stubs.clearActiveTarget).toHaveBeenCalledWith(panel);
    });

    // ...and on teardown, conditionally — a second shell that already took over
    // must not be unbound by this one's disconnect.
    stubs.clearActiveTarget.mockClear();
    panel.remove();
    expect(stubs.clearActiveTarget).toHaveBeenCalledWith(panel);
  });

  it('takes a generated image from the Generate panel as its working image', async () => {
    seedImageTab();
    const { panel } = createPanel();
    await mount(panel, IMAGE_TAB_ID);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    panel.applyGeneratedImage({
      blob,
      mimeType: 'image/png',
      prompt: 'A brass gear',
      width: 64,
      height: 64,
    });
    await panel.updateComplete;

    const internals = panel as unknown as PanelInternals;
    expect(internals.current?.blob).toBe(blob);
    expect(internals.current?.source).toBe('generated');
    // The prompt travels with the image so the save name still reads from it.
    expect(internals.saveName).toBe('sprites/a-brass-gear.png');
  });

  it('opens the Generate panel from the toolbar action', async () => {
    seedImageTab();
    const { panel, stubs } = createPanel();
    await mount(panel, IMAGE_TAB_ID);

    const action = panel.querySelector<HTMLButtonElement>('.ag-generate-action');
    expect(action).not.toBeNull();
    action?.click();

    expect(stubs.execute).toHaveBeenCalledTimes(1);
    expect(stubs.execute.mock.calls[0][0]).toBeInstanceOf(OpenGeneratePanelCommand);
  });

  it('keeps the controller and its inspector registration across a re-dock', async () => {
    seedAnimationTab();
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    const controller = internals.documentController;
    expect(controller).not.toBeNull();

    // Golden Layout re-dock: the same instance is disconnected then reconnected.
    panel.remove();
    expect(stubs.setActiveController).toHaveBeenLastCalledWith(null);

    stubs.setActiveController.mockClear();
    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(internals.documentController).toBe(controller);
    expect(stubs.setActiveController).toHaveBeenCalledWith(controller);
    expect(panel.querySelector('pix3-sprite-timeline')?.controller).toBe(controller);
  });

  it('routes a crop Apply on a frame-bound canvas into the frame (§9.5)', async () => {
    seedAnimationTab();
    const { panel } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/idle_0001.png');
    });

    const controller = internals.documentController;
    const replaceFrameTexture = vi.fn().mockResolvedValue('res://sprites/walk/idle_0002.png');
    Object.defineProperty(controller, 'replaceFrameTexture', {
      value: replaceFrameTexture,
      configurable: true,
    });

    // The canvas normally holds the frame's decoded raster; `readBlob` rejects in
    // these tests, so stand it up directly.
    internals.current = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      mimeType: 'image/png',
      objectUrl: 'blob:working-image',
      source: 'file',
      width: 100,
      height: 80,
    };
    internals.cropMode = true;
    internals.cropRect = { x: 20, y: 10, w: 40, h: 30 };
    await panel.updateComplete;

    const cropped = new Blob([new Uint8Array([9])], { type: 'image/png' });
    stubCropCanvas(cropped);
    await internals.onApplyCrop();

    expect(replaceFrameTexture).toHaveBeenCalledTimes(1);
    const [frameIndex, appliedBlob, options] = replaceFrameTexture.mock.calls[0];
    expect(frameIndex).toBe(0);
    expect(appliedBlob).toBe(cropped);
    // The crop origin is what lets the document keep anchor/points/bbox on the
    // same pixels; the source size is the raster the rect was measured against.
    expect(options.restamp).toEqual({ kind: 'crop', x: 20, y: 10 });
    expect(options.sourceSize).toEqual({ width: 100, height: 80 });
    // The bake is committed, not held: crop mode closes and nothing waits on Save.
    expect(internals.cropMode).toBe(false);
  });

  it('drops a generated image straight into the bound frame', async () => {
    seedAnimationTab();
    const { panel } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/idle_0001.png');
    });

    const replaceFrameTexture = vi.fn().mockResolvedValue('res://sprites/walk/idle_0002.png');
    Object.defineProperty(internals.documentController, 'replaceFrameTexture', {
      value: replaceFrameTexture,
      configurable: true,
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    panel.applyGeneratedImage({
      blob,
      mimeType: 'image/png',
      prompt: 'A brass gear',
      width: 64,
      height: 64,
    });

    await vi.waitFor(() => {
      expect(replaceFrameTexture).toHaveBeenCalledTimes(1);
    });
    expect(replaceFrameTexture.mock.calls[0][1]).toBe(blob);
    // v1 accepts a size mismatch and restamps `sourceSize`; place mode is Phase 5.
    expect(replaceFrameTexture.mock.calls[0][2].restamp).toEqual({ kind: 'replace' });
    // ...and it does NOT become a transient working image needing a Save.
    expect(internals.current?.blob).not.toBe(blob);
  });

  it('takes the drag overlay down even when the frame strip swallows the drop', async () => {
    seedAnimationTab();
    const { panel } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    internals.isTextureDragOver = true;
    internals.textureDragDepth = 1;

    // A frame card inserts the texture itself and stops the event, so the
    // shell-level drop handler never runs — only the capture-phase guard does.
    const card = document.createElement('div');
    card.addEventListener('drop', event => event.stopPropagation());
    panel.appendChild(card);
    card.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

    expect(internals.isTextureDragOver).toBe(false);
    expect(internals.textureDragDepth).toBe(0);
  });
});
