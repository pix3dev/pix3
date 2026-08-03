import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { AnimationResource } from '@pix3/runtime';

import { OpenGeneratePanelCommand } from '@/features/editor/OpenGeneratePanelCommand';
import type { ImageEditTarget } from '@/services/image-gen/ImageEditTargetService';
import { setGenerationDragData } from '@/ui/shared/asset-drag-drop';

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
  placeSession: {
    blob: Blob;
    image: { width: number; height: number };
    frame: { width: number; height: number };
    frameIndex: number;
    prompt: string;
  } | null;
  placeRect: { x: number; y: number; w: number; h: number } | null;
  saveName: string;
  onApplyCrop(): Promise<void>;
  onApplyPlace(): Promise<void>;
}

/**
 * Give the controller the decoded size it would have read off the frame's texture.
 *
 * This is *arranging state the real code fills*, not stubbing behaviour: happy-dom
 * decodes no images, so `getFrameMetrics` would otherwise stay on its 256px
 * placeholder — and the place-mode gate deliberately refuses to open a session
 * against a placeholder rect (§9.7 risk 2), exactly as the crop tool already
 * refuses. Without this the tests below would be measuring a size the user never
 * saw.
 */
function seedFrameMetrics(
  controller: AnimationDocumentController | null,
  texturePath: string,
  size: { width: number; height: number }
): void {
  const cache = (controller as unknown as { textureDimensionsCache: Map<string, typeof size> })
    .textureDimensionsCache;
  cache.set(texturePath, size);
}

/** What a stubbed bake canvas recorded, so a test can assert the composite's shape. */
interface StubbedCanvas {
  width: number;
  height: number;
  drawArgs: unknown[][];
}

/**
 * happy-dom has no 2D canvas, and the crop/place bakes composite through one. Stand
 * in for it (only for `canvas`; Lit renders through `createElement` too) so the test
 * can reach the routing decision that follows the bake, and record what was drawn.
 */
function stubCropCanvas(output: Blob): StubbedCanvas[] {
  const recorded: StubbedCanvas[] = [];
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: unknown) => {
    if (tagName !== 'canvas') {
      return realCreateElement(tagName, options as ElementCreationOptions | undefined);
    }
    const canvas = realCreateElement('canvas');
    const record: StubbedCanvas = { width: 0, height: 0, drawArgs: [] };
    recorded.push(record);
    Object.defineProperties(canvas, {
      width: {
        get: () => record.width,
        set: (value: number) => {
          record.width = value;
        },
        configurable: true,
      },
      height: {
        get: () => record.height,
        set: (value: number) => {
          record.height = value;
        },
        configurable: true,
      },
      getContext: {
        value: () => ({
          imageSmoothingEnabled: false,
          drawImage: (...args: unknown[]) => {
            record.drawArgs.push(args);
          },
        }),
        configurable: true,
      },
      toBlob: {
        value: (callback: (blob: Blob | null) => void) => callback(output),
        configurable: true,
      },
    });
    return canvas;
  });
  return recorded;
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
  showChoice: ReturnType<typeof vi.fn>;
  showConfirmation: ReturnType<typeof vi.fn>;
  historyGet: ReturnType<typeof vi.fn>;
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
  const historyGet = vi.fn().mockResolvedValue(undefined);
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
  // §9.12.1's confirm: two confirm buttons (the alpha threshold) plus cancel.
  const showChoice = vi.fn().mockResolvedValue('confirm');
  // §9.12.4's raster ops take the plain two-way confirm.
  const showConfirmation = vi.fn().mockResolvedValue(true);

  const stubs: Record<string, unknown> = {
    aiSettings: {
      getPreferences: () => ({ ...preferences }),
      getSelectedProvider: () => undefined,
      getSelectedModelId: () => undefined,
      hasApiKey: vi.fn().mockResolvedValue(false),
      subscribe: vi.fn().mockReturnValue(() => undefined),
      updatePreferences,
    },
    history: { add: vi.fn().mockResolvedValue(undefined), get: historyGet },
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
    dialogService: {
      showConfirmation,
      showChoice: showChoice,
    },
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
      showChoice,
      showConfirmation,
      historyGet,
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

  /**
   * §9.12.1 — the clip-wide trim. The maths lives in the controller (and is tested
   * there); what the shell owes is the confirm, the parameters it carries and a
   * status line that states the outcome, so a clip of UV-window frames does not
   * look like a dead button.
   */
  it('trims the whole clip from the toolbar after a confirm and states the outcome', async () => {
    seedAnimationTab(['res://sprites/walk/idle_0001.png', 'res://sprites/walk/idle_0002.png']);
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const controller = (panel as unknown as PanelInternals).documentController;
    const trimClipFrames = vi.fn().mockResolvedValue({ trimmed: 1, skipped: 1, failed: 0 });
    Object.defineProperty(controller, 'trimClipFrames', {
      value: trimClipFrames,
      configurable: true,
    });
    await panel.updateComplete;

    const action = panel.querySelector<HTMLButtonElement>('.ag-trim-frames');
    expect(action?.disabled).toBe(false);
    expect(action?.title).toBe('Trim transparent margins from 2 frames');
    action?.click();

    await vi.waitFor(() => {
      expect(trimClipFrames).toHaveBeenCalledWith({ padding: 0, alphaThreshold: 0 });
    });
    expect(stubs.showChoice).toHaveBeenCalledOnce();

    await panel.updateComplete;
    expect(panel.querySelector('.ag-slice-status')?.textContent).toContain(
      'Trimmed 1 frame of idle, 1 skipped.'
    );
  });

  it('raises the alpha threshold when the confirm takes the halo option, and writes nothing on cancel', async () => {
    seedAnimationTab(['res://sprites/walk/idle_0001.png']);
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const controller = (panel as unknown as PanelInternals).documentController;
    const trimClipFrames = vi.fn().mockResolvedValue({ trimmed: 1, skipped: 0, failed: 0 });
    Object.defineProperty(controller, 'trimClipFrames', {
      value: trimClipFrames,
      configurable: true,
    });
    await panel.updateComplete;

    stubs.showChoice.mockResolvedValueOnce('cancel');
    panel.querySelector<HTMLButtonElement>('.ag-trim-frames')?.click();
    await vi.waitFor(() => {
      expect(stubs.showChoice).toHaveBeenCalledOnce();
    });
    expect(trimClipFrames).not.toHaveBeenCalled();

    stubs.showChoice.mockResolvedValueOnce('secondary');
    panel.querySelector<HTMLButtonElement>('.ag-trim-frames')?.click();
    await vi.waitFor(() => {
      // The `TrimOptions` hint made reachable: ~8 also cuts the halo a background
      // removal leaves behind.
      expect(trimClipFrames).toHaveBeenCalledWith({ padding: 0, alphaThreshold: 8 });
    });
  });

  /**
   * §9.12.2 — the auto collision polygon. Nothing is doubled here beyond the two
   * browser APIs happy-dom lacks (`createImageBitmap` and the 2D canvas): the real
   * alpha reader, the real tracer and the real document controller all run, so
   * these assertions are about the shipping path from the toolbar button to the
   * polygon the stage draws.
   */
  describe('auto collision polygon (§9.12.2)', () => {
    const FRAME_PATH = 'res://sprites/walk/idle_0001.png';
    /**
     * A 32×24 frame with a 16×14 opaque block at (8, 4) — corners (8,4) (24,4)
     * (24,18) (8,18). Big enough to clear `getFrameMetrics`'s 24 px floor, so the
     * overlay's viewBox is the frame's real pixel space.
     */
    const FRAME_ROWS = Array.from({ length: 24 }, (_unusedRow, y) =>
      Array.from({ length: 32 }, (_unusedColumn, x) =>
        x >= 8 && x < 24 && y >= 4 && y < 18 ? '#' : '.'
      ).join('')
    );
    const TRACED_POLYGON = [
      { x: 24, y: 4 },
      { x: 24, y: 18 },
      { x: 8, y: 18 },
      { x: 8, y: 4 },
    ];

    /**
     * Stand up the two browser APIs happy-dom lacks, over a synthetic buffer: the
     * `<img>` decode both the stage's working image and the controller's texture
     * preview await (which is also what fills `textureDimensionsCache`, so the
     * frame's metrics resolve exactly as they do in the app), and the
     * `createImageBitmap` + 2D canvas pair `readAlphaMask` reads the alpha through.
     */
    function stubAlphaDecode(rows: string[]): void {
      const width = rows[0]?.length ?? 0;
      const height = rows.length;
      vi.stubGlobal(
        'Image',
        class {
          public onload: (() => void) | null = null;
          public onerror: (() => void) | null = null;
          public naturalWidth = width;
          public naturalHeight = height;
          set src(_value: string) {
            queueMicrotask(() => this.onload?.());
          }
        }
      );
      vi.stubGlobal('createImageBitmap', async () => ({
        width: rows[0]?.length ?? 0,
        height: rows.length,
        close: () => undefined,
      }));

      const realCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(
        (tagName: string, options?: unknown) => {
          if (tagName !== 'canvas') {
            return realCreateElement(tagName, options as ElementCreationOptions | undefined);
          }
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: () => undefined,
              getImageData: (_x: number, _y: number, width: number, height: number) => {
                const data = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y += 1) {
                  for (let x = 0; x < width; x += 1) {
                    data[(y * width + x) * 4 + 3] = rows[y]?.[x] === '#' ? 255 : 0;
                  }
                }
                return { data };
              },
            }),
          } as unknown as HTMLElement;
        }
      );
    }

    async function mountTracablePanel(): Promise<{
      panel: SpriteEditorPanel;
      controller: AnimationDocumentController;
    }> {
      seedAnimationTab([FRAME_PATH]);
      const { panel, stubs } = createPanel();
      // The frame's file has to actually read for the stage to bind to it.
      stubs.readBlob.mockImplementation(
        async (path: string) => new Blob([path], { type: 'image/png' })
      );
      await mount(panel, ANIMATION_TAB_ID);

      const controller = (panel as unknown as PanelInternals).documentController;
      if (!controller) {
        throw new Error('no document controller');
      }
      // The stage has to hold the frame's image, and the frame's metrics have to
      // have resolved, before the tool is offered at all (§9.7 risk 2) — both come
      // out of the real texture load above.
      await vi.waitFor(() => {
        expect((panel as unknown as PanelInternals).current).not.toBeNull();
        expect(controller.getFrameMetrics(controller.selectedFrame!)).toEqual({
          frameWidth: 32,
          frameHeight: 24,
        });
      });
      panel.requestUpdate();
      await panel.updateComplete;
      return { panel, controller };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('traces the frame into the live polygon overlay and commits it on Apply', async () => {
      stubAlphaDecode(FRAME_ROWS);
      const { panel, controller } = await mountTracablePanel();

      const action = panel.querySelector<HTMLButtonElement>('.ag-auto-polygon');
      expect(action?.disabled).toBe(false);
      action?.click();

      // The trace lands in the frame DRAFT, which is what the *existing* overlay
      // renders — the preview is the editable polygon, not a second overlay.
      await vi.waitFor(() => {
        expect(controller.frameDraft?.collisionPolygon).toEqual(TRACED_POLYGON);
      });
      await panel.updateComplete;
      expect(panel.querySelector('.stage-polygon')?.getAttribute('points')).toBe(
        '24,4 24,18 8,18 8,4'
      );
      expect(panel.querySelector('.ag-slice-status')?.textContent).toContain('Traced 4 vertices');
      // Tracing switches to the polygon tool, so the vertices are draggable at once.
      expect(panel.querySelector('[aria-label="Collision polygon tools"]')).not.toBeNull();

      // Nothing is written until Apply.
      expect(controller.resource?.clips[0]?.frames[0]?.collisionPolygon).toEqual([]);
      panel.querySelector<HTMLButtonElement>('.ag-polygon-apply')?.click();

      await vi.waitFor(() => {
        expect(controller.resource?.clips[0]?.frames[0]?.collisionPolygon).toEqual(TRACED_POLYGON);
      });
    });

    it('re-traces at the tolerance the slider carries, and Discard leaves the frame alone', async () => {
      stubAlphaDecode(FRAME_ROWS);
      const { panel, controller } = await mountTracablePanel();

      panel.querySelector<HTMLButtonElement>('.ag-auto-polygon')?.click();
      await vi.waitFor(() => {
        expect(controller.frameDraft?.collisionPolygon).toHaveLength(4);
      });
      await panel.updateComplete;

      // A tolerance far past the shape still yields a usable collider, never a
      // one-vertex "polygon" (the contour-trace guard, reached through the UI).
      const slider = panel.querySelector<HTMLInputElement>('.ag-polygon-tolerance input');
      expect(slider?.value).toBe('2');
      if (!slider) {
        throw new Error('no tolerance slider');
      }
      slider.value = '8';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => {
        expect(controller.frameDraft?.collisionPolygon.length).toBeGreaterThanOrEqual(3);
      });
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('.ag-frame-tools .ag-frame-tools-wide + *');
      const discard = [...panel.querySelectorAll<HTMLButtonElement>('.ag-frame-tools-wide')].find(
        button => button.textContent?.trim() === 'Discard'
      );
      discard?.click();
      await panel.updateComplete;

      expect(controller.frameDraft).toBeNull();
      expect(controller.resource?.clips[0]?.frames[0]?.collisionPolygon).toEqual([]);
      expect(panel.querySelector('.ag-polygon-apply')).toBeNull();
    });

    it('refuses to trace while the frame texture has not decoded', async () => {
      stubAlphaDecode(FRAME_ROWS);
      seedAnimationTab([FRAME_PATH]);
      const { panel } = createPanel();
      await mount(panel, ANIMATION_TAB_ID);
      await panel.updateComplete;

      // No decoded size: absolute-pixel geometry would be authored against the
      // 256 px placeholder, so the tool shares the raster tools' gate.
      const action = panel.querySelector<HTMLButtonElement>('.ag-auto-polygon');
      expect(action?.disabled).toBe(true);
      expect(action?.title).toBe('Waiting for the frame texture to decode…');
    });
  });

  /**
   * §9.12.3 — the chroma key. Only the two browser APIs happy-dom lacks are stood
   * up (`createImageBitmap` and the 2D canvas, over a real RGBA strip) plus the
   * stage's rect, which happy-dom reports as 0×0 so no pointer could ever land on
   * a pixel. Everything else — the transient mode, the pointer routing, the
   * sample, and `chromaKeyImage` itself — is the shipping code.
   */
  describe('chroma key (§9.12.3)', () => {
    /**
     * A uniform-grey raster of `width × height`, or an explicit 1-row strip of
     * greys. Grey is convenient: against a grey key the RGB distance is exactly
     * |a − b|·√3, so what gets keyed is arithmetic anyone can check.
     */
    function stubGreyDecode(greys: readonly number[], width: number, height: number): void {
      vi.stubGlobal(
        'Image',
        class {
          public onload: (() => void) | null = null;
          public onerror: (() => void) | null = null;
          public naturalWidth = width;
          public naturalHeight = height;
          set src(_value: string) {
            queueMicrotask(() => this.onload?.());
          }
        }
      );
      vi.stubGlobal('createImageBitmap', async () => ({ width, height, close: () => undefined }));

      const realCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(
        (tagName: string, options?: unknown) => {
          if (tagName !== 'canvas') {
            return realCreateElement(tagName, options as ElementCreationOptions | undefined);
          }
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              imageSmoothingEnabled: false,
              imageSmoothingQuality: 'low',
              drawImage: () => undefined,
              getImageData: (_x: number, _y: number, w: number, h: number) => {
                const data = new Uint8ClampedArray(w * h * 4);
                for (let index = 0; index < w * h; index += 1) {
                  const grey = greys[index % greys.length];
                  data[index * 4] = grey;
                  data[index * 4 + 1] = grey;
                  data[index * 4 + 2] = grey;
                  data[index * 4 + 3] = 255;
                }
                return { data, width: w, height: h };
              },
              putImageData: () => undefined,
            }),
            toBlob: (callback: (blob: Blob | null) => void) =>
              callback(new Blob(['keyed'], { type: 'image/png' })),
          } as unknown as HTMLElement;
        }
      );
    }

    /**
     * happy-dom measures every element as 0×0, which makes `getStageViewport()`
     * return null and no pointer can reach a pixel. Give the stage a real rect —
     * arranging state the browser fills, not stubbing behaviour — and make sure
     * pointer capture exists on it.
     */
    function giveStageARect(panel: SpriteEditorPanel): HTMLElement {
      const stage = panel.querySelector<HTMLElement>('.ag-stage');
      if (!stage) {
        throw new Error('no stage');
      }
      stage.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 400,
          bottom: 400,
          width: 400,
          height: 400,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      stage.setPointerCapture = () => undefined;
      stage.hasPointerCapture = () => true;
      stage.releasePointerCapture = () => undefined;
      return stage;
    }

    /** The stage sits at (0,0) with zoom 1 and no pan, so client == image pixels. */
    function pickAt(stage: HTMLElement, x: number, y: number): void {
      stage.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: x,
          clientY: y,
        })
      );
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('picks a colour off the canvas and keys it out of the working image', async () => {
      // 0, 51, 102, 204 — 0 %, 20 %, 40 % and 80 % of the way from black.
      stubGreyDecode([0, 51, 102, 204], 4, 1);
      seedImageTab();
      const { panel, stubs } = createPanel();
      stubs.readBlob.mockImplementation(
        async (path: string) => new Blob([path], { type: 'image/png' })
      );
      await mount(panel, IMAGE_TAB_ID);
      const internals = panel as unknown as PanelInternals;
      await vi.waitFor(() => {
        expect(internals.current).not.toBeNull();
      });
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('.ag-chroma-toggle')?.click();
      await vi.waitFor(() => {
        expect(panel.querySelector('.ag-chroma-toolbar')).not.toBeNull();
      });
      await panel.updateComplete;

      // Nothing picked yet: the swatch says so rather than pretending to be black.
      expect(panel.querySelector('.ag-chroma-swatch')?.className).toContain('is-empty');
      expect(panel.querySelector<HTMLButtonElement>('.ag-chroma-apply')?.disabled).toBe(true);

      pickAt(giveStageARect(panel), 2.5, 0.5);
      await panel.updateComplete;
      expect(panel.querySelector('.ag-chroma-toolbar .ag-crop-dims')?.textContent).toBe(
        'rgb(102, 102, 102)'
      );

      panel.querySelector<HTMLButtonElement>('.ag-chroma-apply')?.click();
      await vi.waitFor(() => {
        expect(internals.current?.source).toBe('chroma-keyed');
      });
      await panel.updateComplete;

      // At the 10 % default tolerance only the picked grey itself is within range
      // (51 and 204 sit 20 % and 40 % away), so exactly one pixel loses its alpha.
      expect(panel.querySelector('.ag-slice-status')?.textContent).toContain('Keyed out 1 pixel.');
      // Keyed output carries alpha, so the save name is forced to .png.
      expect(internals.saveName.endsWith('-keyed.png')).toBe(true);
      // Applying closes the transient mode, exactly as crop does.
      expect(panel.querySelector('.ag-chroma-toolbar')).toBeNull();
    });

    it('writes the picked colour back into the bound frame, not the working image', async () => {
      stubGreyDecode([70], 32, 24);
      seedAnimationTab(['res://sprites/walk/idle_0001.png']);
      const { panel, stubs } = createPanel();
      stubs.readBlob.mockImplementation(
        async (path: string) => new Blob([path], { type: 'image/png' })
      );
      await mount(panel, ANIMATION_TAB_ID);

      const controller = (panel as unknown as PanelInternals).documentController;
      if (!controller) {
        throw new Error('no document controller');
      }
      const replaceFrameTexture = vi.fn().mockResolvedValue('res://sprites/walk/idle_0002.png');
      Object.defineProperty(controller, 'replaceFrameTexture', {
        value: replaceFrameTexture,
        configurable: true,
      });
      await vi.waitFor(() => {
        expect((panel as unknown as PanelInternals).current).not.toBeNull();
      });
      panel.requestUpdate();
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('.ag-chroma-toggle')?.click();
      await vi.waitFor(() => {
        expect(panel.querySelector('.ag-chroma-toolbar')).not.toBeNull();
      });
      await panel.updateComplete;

      pickAt(giveStageARect(panel), 10.5, 10.5);
      await panel.updateComplete;
      panel.querySelector<HTMLButtonElement>('.ag-chroma-apply')?.click();

      await vi.waitFor(() => {
        expect(replaceFrameTexture).toHaveBeenCalled();
      });
      // The keyed image is the same size as the frame, so the restamp is the
      // identity — §9.12.3's "unchanged size" write-back.
      expect(replaceFrameTexture.mock.calls[0][2]).toMatchObject({
        restamp: { kind: 'replace' },
        label: 'Chroma key frame 1: idle',
      });
      // The working image stays the frame's own file; a frame bake is committed,
      // never held on the canvas.
      expect((panel as unknown as PanelInternals).current?.source).toBe('file');
    });

    it('hands the picked colour to the clip-wide op after a confirm', async () => {
      stubGreyDecode([70], 32, 24);
      seedAnimationTab(['res://sprites/walk/idle_0001.png', 'res://sprites/walk/idle_0002.png']);
      const { panel, stubs } = createPanel();
      stubs.readBlob.mockImplementation(
        async (path: string) => new Blob([path], { type: 'image/png' })
      );
      await mount(panel, ANIMATION_TAB_ID);

      const controller = (panel as unknown as PanelInternals).documentController;
      const applyRasterOpToClipFrames = vi
        .fn()
        .mockResolvedValue({ processed: 2, skipped: 0, failed: 0 });
      Object.defineProperty(controller, 'applyRasterOpToClipFrames', {
        value: applyRasterOpToClipFrames,
        configurable: true,
      });
      await vi.waitFor(() => {
        expect((panel as unknown as PanelInternals).current).not.toBeNull();
      });
      panel.requestUpdate();
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('.ag-chroma-toggle')?.click();
      await vi.waitFor(() => {
        expect(panel.querySelector('.ag-chroma-clip')).not.toBeNull();
      });
      await panel.updateComplete;
      pickAt(giveStageARect(panel), 5.5, 5.5);
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('.ag-chroma-clip')?.click();
      await vi.waitFor(() => {
        expect(applyRasterOpToClipFrames).toHaveBeenCalledWith({
          kind: 'chroma-key',
          color: { r: 70, g: 70, b: 70 },
          tolerance: 0.1,
          softness: 0,
        });
      });
      expect(stubs.showConfirmation).toHaveBeenCalledOnce();
      await panel.updateComplete;
      expect(panel.querySelector('.ag-slice-status')?.textContent).toContain(
        'Chroma key: idle — 2 frames.'
      );
    });

    it('writes nothing when the clip-wide confirm is declined', async () => {
      stubGreyDecode([70], 32, 24);
      seedAnimationTab(['res://sprites/walk/idle_0001.png']);
      const { panel, stubs } = createPanel();
      stubs.readBlob.mockImplementation(
        async (path: string) => new Blob([path], { type: 'image/png' })
      );
      stubs.showConfirmation.mockResolvedValue(false);
      await mount(panel, ANIMATION_TAB_ID);

      const controller = (panel as unknown as PanelInternals).documentController;
      const applyRasterOpToClipFrames = vi.fn();
      Object.defineProperty(controller, 'applyRasterOpToClipFrames', {
        value: applyRasterOpToClipFrames,
        configurable: true,
      });
      await vi.waitFor(() => {
        expect((panel as unknown as PanelInternals).current).not.toBeNull();
      });
      panel.requestUpdate();
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('.ag-chroma-toggle')?.click();
      await vi.waitFor(() => {
        expect(panel.querySelector('.ag-chroma-clip')).not.toBeNull();
      });
      await panel.updateComplete;
      pickAt(giveStageARect(panel), 5.5, 5.5);
      await panel.updateComplete;
      panel.querySelector<HTMLButtonElement>('.ag-chroma-clip')?.click();

      await vi.waitFor(() => {
        expect(stubs.showConfirmation).toHaveBeenCalledOnce();
      });
      expect(applyRasterOpToClipFrames).not.toHaveBeenCalled();
    });

    it('is mutually exclusive with the crop tool', async () => {
      stubGreyDecode([70], 32, 24);
      seedImageTab();
      const { panel, stubs } = createPanel();
      stubs.readBlob.mockImplementation(
        async (path: string) => new Blob([path], { type: 'image/png' })
      );
      await mount(panel, IMAGE_TAB_ID);
      await vi.waitFor(() => {
        expect((panel as unknown as PanelInternals).current).not.toBeNull();
      });
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('.ag-chroma-toggle')?.click();
      await panel.updateComplete;
      expect(panel.querySelector('.ag-chroma-toolbar')).not.toBeNull();

      // Both own the plain left-press on the canvas; the last click wins.
      const crop = [...panel.querySelectorAll<HTMLButtonElement>('.ag-toolbar-button')].find(
        button => button.textContent?.trim() === 'Crop'
      );
      crop?.click();
      await panel.updateComplete;
      expect(panel.querySelector('.ag-chroma-toolbar')).toBeNull();
      expect((panel as unknown as PanelInternals).cropMode).toBe(true);
    });
  });

  /**
   * §9.12.4 — bulk frame ops. The batching is the controller's job (and is tested
   * there); what the shell owes is the confirm, the parameter it carries and a
   * status line that spells out the skips.
   */
  describe('bulk frame ops (§9.12.4)', () => {
    async function mountBulkPanel(): Promise<{
      panel: SpriteEditorPanel;
      stubs: PanelStubs;
      controller: AnimationDocumentController;
    }> {
      seedAnimationTab([
        'res://sprites/walk/idle_0001.png',
        'res://sprites/walk/idle_0002.png',
        'res://sprites/walk/idle_0003.png',
        'res://sprites/walk/idle_0004.png',
      ]);
      const { panel, stubs } = createPanel();
      await mount(panel, ANIMATION_TAB_ID);
      const controller = (panel as unknown as PanelInternals).documentController;
      if (!controller) {
        throw new Error('no document controller');
      }
      panel.querySelector<HTMLButtonElement>('.ag-bulk-frames')?.click();
      await panel.updateComplete;
      return { panel, stubs, controller };
    }

    function findBulkButton(panel: SpriteEditorPanel, label: string): HTMLButtonElement {
      const button = [
        ...panel.querySelectorAll<HTMLButtonElement>('.ag-bulk-tools .ag-frame-tools-wide'),
      ].find(candidate => candidate.textContent?.trim() === label);
      if (!button) {
        throw new Error(`no bulk button labelled "${label}"`);
      }
      return button;
    }

    it('drops every second frame through the confirm that carries the parity', async () => {
      const { panel, stubs, controller } = await mountBulkPanel();
      const deleteFramesByParity = vi
        .fn()
        .mockResolvedValue({ processed: 2, skipped: 0, failed: 0 });
      Object.defineProperty(controller, 'deleteFramesByParity', {
        value: deleteFramesByParity,
        configurable: true,
      });

      expect(panel.querySelector('[aria-label="Bulk frame tools"]')).not.toBeNull();
      findBulkButton(panel, 'Drop every 2nd').click();

      await vi.waitFor(() => {
        expect(deleteFramesByParity).toHaveBeenCalledWith('even');
      });
      // The confirm's two buttons ARE the parameter — `DialogService` has no radio
      // group, so the choice carries it exactly as §9.12.1's trim confirm does.
      expect(stubs.showChoice.mock.calls[0][0]).toMatchObject({
        confirmLabel: 'Drop 2 even',
        secondaryLabel: 'Drop 2 odd',
      });
      await panel.updateComplete;
      expect(panel.querySelector('.ag-slice-status')?.textContent).toContain(
        'Dropped even frames of idle — 2 frames.'
      );
    });

    it('takes the odd half from the secondary button and nothing on cancel', async () => {
      const { panel, stubs, controller } = await mountBulkPanel();
      const deleteFramesByParity = vi
        .fn()
        .mockResolvedValue({ processed: 2, skipped: 0, failed: 0 });
      Object.defineProperty(controller, 'deleteFramesByParity', {
        value: deleteFramesByParity,
        configurable: true,
      });

      stubs.showChoice.mockResolvedValueOnce('cancel');
      findBulkButton(panel, 'Drop every 2nd').click();
      await vi.waitFor(() => {
        expect(stubs.showChoice).toHaveBeenCalledOnce();
      });
      expect(deleteFramesByParity).not.toHaveBeenCalled();

      stubs.showChoice.mockResolvedValueOnce('secondary');
      findBulkButton(panel, 'Drop every 2nd').click();
      await vi.waitFor(() => {
        expect(deleteFramesByParity).toHaveBeenCalledWith('odd');
      });
    });

    it('maps a raster op over the clip after a confirm and states the skips', async () => {
      const { panel, stubs, controller } = await mountBulkPanel();
      const applyRasterOpToClipFrames = vi
        .fn()
        .mockResolvedValue({ processed: 3, skipped: 1, failed: 0 });
      Object.defineProperty(controller, 'applyRasterOpToClipFrames', {
        value: applyRasterOpToClipFrames,
        configurable: true,
      });

      findBulkButton(panel, 'Flip H').click();

      await vi.waitFor(() => {
        expect(applyRasterOpToClipFrames).toHaveBeenCalledWith({
          kind: 'flip',
          axis: 'horizontal',
        });
      });
      expect(stubs.showConfirmation.mock.calls[0][0]).toMatchObject({
        title: 'Flip horizontally every frame?',
        isDangerous: true,
      });
      await panel.updateComplete;
      // A clip of UV-window frames processes nothing; silence there would read as
      // a dead button, so the skips are always spelled out.
      expect(panel.querySelector('.ag-slice-status')?.textContent).toContain(
        'Flip horizontally: idle — 3 frames, 1 skipped.'
      );
    });

    it('writes nothing when the raster-op confirm is declined', async () => {
      const { panel, stubs, controller } = await mountBulkPanel();
      const applyRasterOpToClipFrames = vi.fn();
      Object.defineProperty(controller, 'applyRasterOpToClipFrames', {
        value: applyRasterOpToClipFrames,
        configurable: true,
      });
      stubs.showConfirmation.mockResolvedValueOnce(false);

      findBulkButton(panel, 'Rotate 90°').click();
      await vi.waitFor(() => {
        expect(stubs.showConfirmation).toHaveBeenCalledOnce();
      });
      expect(applyRasterOpToClipFrames).not.toHaveBeenCalled();
    });
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

  it('drops an equally-sized generated image straight into the bound frame', async () => {
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

    seedFrameMetrics(internals.documentController, 'res://sprites/walk/idle_0001.png', {
      width: 256,
      height: 256,
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    // 256x256 is the frame's decoded size, so this is the equal-size fast path
    // (§9.11.0 measures the frame with `getFrameMetrics`, never the incoming raster).
    panel.applyGeneratedImage({
      blob,
      mimeType: 'image/png',
      prompt: 'A brass gear',
      width: 256,
      height: 256,
    });

    await vi.waitFor(() => {
      expect(replaceFrameTexture).toHaveBeenCalledTimes(1);
    });
    expect(replaceFrameTexture.mock.calls[0][1]).toBe(blob);
    expect(replaceFrameTexture.mock.calls[0][2].restamp).toEqual({ kind: 'replace' });
    // ...and it does NOT become a transient working image needing a Save.
    expect(internals.current?.blob).not.toBe(blob);
    // No placement was needed, so none was opened.
    expect(internals.placeSession).toBeNull();
  });

  /** §9.11.0 — the scope gate. A size mismatch is a placement, not a write. */
  it('opens a place session for a differently-sized generation and writes nothing', async () => {
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

    seedFrameMetrics(internals.documentController, 'res://sprites/walk/idle_0001.png', {
      width: 256,
      height: 256,
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    panel.applyGeneratedImage({
      blob,
      mimeType: 'image/png',
      prompt: 'A brass gear',
      width: 128,
      height: 64,
    });

    await vi.waitFor(() => {
      expect(internals.placeSession).not.toBeNull();
    });
    expect(internals.placeSession?.blob).toBe(blob);
    expect(internals.placeSession?.image).toEqual({ width: 128, height: 64 });
    expect(internals.placeSession?.frame).toEqual({ width: 256, height: 256 });
    expect(internals.placeSession?.frameIndex).toBe(0);
    // `fit` is the default seed, so nothing is cut before the user has said
    // anything: 128x64 contained in 256x256 is 256x128, centred.
    expect(internals.placeRect).toEqual({ x: 0, y: 64, w: 256, h: 128 });

    // Nothing was written, and the canvas was not hijacked either.
    expect(replaceFrameTexture).not.toHaveBeenCalled();
    expect(internals.current?.blob).not.toBe(blob);

    // §9.11.2 — a second generation must not land on top of one being placed.
    expect(panel.getImageEditSnapshot().acceptsFrameWriteBack).toBe(false);
  });

  /**
   * §9.7 risk 2. With the frame's texture still undecoded, `getFrameMetrics` reports
   * its 256px placeholder — a rect the user has never seen. Opening a placement
   * against it would bake a composite of an invented size, so the gate falls through
   * to the straight write-back instead, which does not depend on the frame rect.
   */
  it('does not open a placement while the frame metrics are still the placeholder', async () => {
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

    // Deliberately NOT seeded — this is the undecoded window.
    expect(
      internals.documentController?.hasResolvedFrameMetrics(
        internals.documentController.activeClip!.frames[0]
      )
    ).toBe(false);

    panel.applyGeneratedImage({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      mimeType: 'image/png',
      prompt: 'A brass gear',
      width: 128,
      height: 64,
    });

    await vi.waitFor(() => {
      expect(replaceFrameTexture).toHaveBeenCalledTimes(1);
    });
    expect(internals.placeSession).toBeNull();
  });

  it('cancels an open placement when another frame is selected', async () => {
    seedAnimationTab(['res://sprites/walk/idle_0001.png', 'res://sprites/walk/idle_0002.png']);
    const { panel } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/idle_0001.png');
    });

    seedFrameMetrics(internals.documentController, 'res://sprites/walk/idle_0001.png', {
      width: 256,
      height: 256,
    });

    panel.applyGeneratedImage({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      mimeType: 'image/png',
      prompt: 'A brass gear',
      width: 128,
      height: 64,
    });
    await vi.waitFor(() => {
      expect(internals.placeSession).not.toBeNull();
    });

    // Losing the generation to a stray frame click is acceptable because the
    // Generate panel's history strip still holds it (§9.11.2).
    internals.documentController?.selectFrame(1);

    expect(internals.placeSession).toBeNull();
    expect(internals.placeRect).toBeNull();
    // ...and the frame is available for a straight write-back again.
    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/idle_0002.png');
    });
    expect(panel.getImageEditSnapshot().acceptsFrameWriteBack).toBe(true);
  });

  it('bakes a placement onto a canvas the size of the frame, not the image', async () => {
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

    // The canvas normally holds the frame's decoded raster; `readBlob` rejects in
    // these tests, so stand it up directly — the placed <img> only renders inside
    // `.ag-stage-content`, which needs a working image.
    internals.current = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      mimeType: 'image/png',
      objectUrl: 'blob:working-image',
      source: 'file',
      width: 256,
      height: 256,
    };
    seedFrameMetrics(internals.documentController, 'res://sprites/walk/idle_0001.png', {
      width: 256,
      height: 256,
    });
    panel.applyGeneratedImage({
      blob: new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }),
      mimeType: 'image/png',
      prompt: 'A brass gear',
      width: 128,
      height: 64,
    });
    await vi.waitFor(() => {
      expect(internals.placeSession).not.toBeNull();
    });
    await panel.updateComplete;
    expect(panel.querySelector('.ag-place-image')).not.toBeNull();
    expect(panel.querySelectorAll('.ag-place-handle')).toHaveLength(4);

    const placed = new Blob([new Uint8Array([9])], { type: 'image/png' });
    const canvases = stubCropCanvas(placed);
    await internals.onApplyPlace();

    expect(canvases).toHaveLength(1);
    // Frame-sized output, so `replace` restamps the geometry as the identity.
    expect(canvases[0].width).toBe(256);
    expect(canvases[0].height).toBe(256);
    expect(canvases[0].drawArgs[0].slice(1)).toEqual([0, 64, 256, 128]);

    expect(replaceFrameTexture).toHaveBeenCalledTimes(1);
    expect(replaceFrameTexture.mock.calls[0][1]).toBe(placed);
    expect(replaceFrameTexture.mock.calls[0][2].restamp).toEqual({ kind: 'replace' });
    // The session is closed before the write-back, exactly as crop does.
    expect(internals.placeSession).toBeNull();
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

  /**
   * §8.4 — a generation dropped on the canvas goes into the *current* frame, not
   * onto the end of the clip (that is the timeline's row of the matrix). Here the
   * sizes differ, so it opens a placement rather than writing.
   */
  it('routes a generation dropped on the canvas into the bound frame', async () => {
    seedAnimationTab();
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    await vi.waitFor(() => {
      expect(internals.boundFrameTexturePath).toBe('res://sprites/walk/idle_0001.png');
    });
    seedFrameMetrics(internals.documentController, 'res://sprites/walk/idle_0001.png', {
      width: 256,
      height: 256,
    });

    const blob = new Blob([new Uint8Array([7, 7, 7])], { type: 'image/png' });
    stubs.historyGet.mockResolvedValue({
      id: 'rec-1',
      createdAt: 0,
      providerId: '',
      modelId: '',
      prompt: 'A brass gear',
      mimeType: 'image/png',
      blob,
      width: 128,
      height: 64,
    });

    const transfer = new DataTransfer();
    setGenerationDragData(transfer, { id: 'rec-1', suggestedName: 'a-brass-gear.png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: transfer, configurable: true });
    panel.querySelector('.ag-stage')?.dispatchEvent(drop);

    await vi.waitFor(() => {
      expect(internals.placeSession).not.toBeNull();
    });
    expect(stubs.historyGet).toHaveBeenCalledWith('rec-1');
    expect(internals.placeSession?.blob).toBe(blob);
    expect(internals.placeSession?.image).toEqual({ width: 128, height: 64 });
    // ...and it did NOT fall through to the append path.
    expect(internals.documentController?.activeClip?.frames).toHaveLength(1);
  });
});
