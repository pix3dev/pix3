import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { AnimationResource } from '@pix3/runtime';

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
  aiRailExpanded: boolean;
  isTextureDragOver: boolean;
  textureDragDepth: number;
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
    aiRailExpanded: null as boolean | null,
  };
}

interface PanelStubs {
  readBlob: ReturnType<typeof vi.fn>;
  updatePreferences: ReturnType<typeof vi.fn>;
  setActiveController: ReturnType<typeof vi.fn>;
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

  const stubs: Record<string, unknown> = {
    providers: { get: () => undefined, list: () => [], getDefault: () => undefined },
    aiSettings: {
      getPreferences: () => ({ ...preferences }),
      getSelectedProvider: () => undefined,
      getSelectedModelId: () => undefined,
      hasApiKey: vi.fn().mockResolvedValue(false),
      subscribe: vi.fn().mockReturnValue(() => undefined),
      updatePreferences,
    },
    history: {
      subscribe: vi.fn().mockReturnValue(() => undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    bgRemoval: { removeBackground: vi.fn() },
    storage: { readBlob, writeBinaryFile: vi.fn(), createDirectory: vi.fn() },
    editorSettings: { showSettings: vi.fn() },
    commandDispatcher: { execute: vi.fn().mockResolvedValue(true) },
    assetLibrary: { isUserScopeSupported: () => false },
    sliceDialog: { showDialog: vi.fn().mockResolvedValue(null) },
    editorTabs: { focusOrOpenAnimation: vi.fn() },
    operations: { invokeAndPush: vi.fn().mockResolvedValue(true) },
    animationEditorService: {
      getActiveController: () => activeController,
      setActiveController,
    },
    dialogService: { showConfirmation: vi.fn().mockResolvedValue(true) },
    sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map() }) },
  };

  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  return { panel, stubs: { readBlob, updatePreferences, setActiveController, preferences } };
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

  it('creates no controller for a bare image tab and expands the AI rail', async () => {
    seedImageTab();
    const { panel } = createPanel();
    await mount(panel, IMAGE_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    expect(internals.documentController).toBeNull();
    expect(panel.querySelector('pix3-sprite-clips-rail')).toBeNull();
    expect(panel.querySelector('pix3-sprite-timeline')).toBeNull();

    expect(internals.aiRailExpanded).toBe(true);
    expect(panel.querySelector('.ag-ai-rail.is-collapsed')).toBeNull();
    expect(panel.querySelector('.ag-prompt')).not.toBeNull();
  });

  it('collapses the AI rail by default when a .pix3anim is bound', async () => {
    seedAnimationTab();
    const { panel } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    expect((panel as unknown as PanelInternals).aiRailExpanded).toBe(false);
    expect(panel.querySelector('.ag-ai-rail.is-collapsed')).not.toBeNull();
    // Collapsed means collapsed: the prompt box is gone, not just hidden.
    expect(panel.querySelector('.ag-prompt')).toBeNull();
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

  it('persists the AI rail toggle', async () => {
    seedAnimationTab();
    const { panel, stubs } = createPanel();
    await mount(panel, ANIMATION_TAB_ID);

    const internals = panel as unknown as PanelInternals;
    expect(internals.aiRailExpanded).toBe(false);

    panel.querySelector<HTMLButtonElement>('.ag-ai-rail-toggle')?.click();
    await panel.updateComplete;

    expect(internals.aiRailExpanded).toBe(true);
    expect(stubs.updatePreferences).toHaveBeenCalledWith({ aiRailExpanded: true });
    expect(stubs.preferences.aiRailExpanded).toBe(true);
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
