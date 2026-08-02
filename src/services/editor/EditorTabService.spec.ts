import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { EditorTabService } from '@/services/editor/EditorTabService';

describe('EditorTabService (code tabs)', () => {
  beforeEach(() => {
    resetAppState();
    vi.restoreAllMocks();
    appState.project.status = 'ready';
  });

  const createService = () => {
    const service = new EditorTabService();
    let documentSnapshot = {
      resourcePath: 'res://scripts/player.ts',
      language: 'typescript' as const,
      text: 'export class Player {}',
      savedText: 'export class Player {}',
      isDirty: false,
      lastModifiedTime: 1,
    };
    let listener: (() => void) | null = null;

    Object.defineProperty(service, 'layoutManager', {
      value: {
        subscribeEditorTabFocused: vi.fn().mockReturnValue(() => undefined),
        subscribeEditorTabCloseRequested: vi.fn(),
        ensureEditorTab: vi.fn(),
        focusEditorTab: vi.fn(),
        removeEditorTab: vi.fn(),
        updateEditorTabTitle: vi.fn(),
      },
    });
    Object.defineProperty(service, 'dialogService', {
      value: { showChoice: vi.fn().mockResolvedValue('confirm') },
    });
    Object.defineProperty(service, 'commandDispatcher', {
      value: { execute: vi.fn(), executeById: vi.fn() },
    });
    Object.defineProperty(service, 'viewportRenderer', {
      value: { captureCameraState: vi.fn(), applyCameraState: vi.fn() },
    });
    Object.defineProperty(service, 'sceneManager', {
      value: { removeSceneGraph: vi.fn() },
    });
    Object.defineProperty(service, 'operationService', {
      value: { invoke: vi.fn() },
    });
    Object.defineProperty(service, 'animationEditorService', {
      value: { setActiveAssetPath: vi.fn(), getActiveAssetPath: vi.fn().mockReturnValue(null) },
    });
    Object.defineProperty(service, 'codeDocumentService', {
      value: {
        subscribeAll: (next: () => void) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
        ensureLoaded: vi.fn(async () => documentSnapshot),
        getDocument: vi.fn(() => documentSnapshot),
        save: vi.fn(async () => {
          documentSnapshot = {
            ...documentSnapshot,
            savedText: documentSnapshot.text,
            isDirty: false,
          };
          listener?.();
          return documentSnapshot;
        }),
        close: vi.fn(),
      },
    });

    Object.defineProperty(service, 'previewHostService', {
      value: { isActive: vi.fn().mockReturnValue(false), stop: vi.fn() },
    });
    Object.defineProperty(service, 'projectScriptLoader', {
      value: { waitForScripts: vi.fn(async () => undefined) },
    });
    Object.defineProperty(service, 'storage', {
      value: { getLastModified: vi.fn(async () => 1) },
      configurable: true,
    });

    return {
      service,
      setDocument(next: Partial<typeof documentSnapshot>) {
        documentSnapshot = { ...documentSnapshot, ...next };
        listener?.();
      },
    };
  };

  it('opens, syncs dirty state, and saves code tabs', async () => {
    const { service, setDocument } = createService();

    await service.openResourceTab('code', 'res://scripts/player.ts');
    expect(appState.tabs.activeTabId).toBe('code:res://scripts/player.ts');
    expect(appState.tabs.tabs[0]?.type).toBe('code');

    setDocument({ isDirty: true });
    expect(appState.tabs.tabs[0]?.isDirty).toBe(true);
    // Dirty state is shown by a tab dot now, not a `*` title prefix — the title stays clean.
    expect(appState.tabs.tabs[0]?.title).toBe('player.ts');

    await service.saveActiveTab();
    expect(appState.tabs.tabs[0]?.isDirty).toBe(false);
    expect(appState.tabs.tabs[0]?.title).toBe('player.ts');
  });

  it('keeps dirty code tabs saveable in cloud projects', () => {
    const { service } = createService();
    appState.project.backend = 'cloud';
    appState.tabs.tabs = [
      {
        id: 'code:res://scripts/player.ts',
        resourceId: 'res://scripts/player.ts',
        type: 'code',
        title: '*player.ts',
        isDirty: true,
        contextState: {},
      },
      {
        id: 'scene:res://scenes/main.pix3scene',
        resourceId: 'res://scenes/main.pix3scene',
        type: 'scene',
        title: '*main.pix3scene',
        isDirty: true,
        contextState: {},
      },
    ];

    const dirtyTabs = service.getDirtyTabs();
    expect(dirtyTabs).toHaveLength(1);
    expect(dirtyTabs[0]?.type).toBe('code');
  });

  // Valtio batches subscription callbacks into a microtask.
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  it('discards tabs on a project switch instead of persisting them under the new project', async () => {
    const { service } = createService();
    appState.project.id = 'project-a';

    await service.openResourceTab('code', 'res://scripts/player.ts');
    await flush();
    expect(localStorage.getItem('pix3.projectTabs:project-a')).toContain('res://scripts/player.ts');

    appState.project.id = 'project-b';
    await flush();

    expect(appState.tabs.tabs).toHaveLength(0);
    expect(appState.tabs.activeTabId).toBeNull();
    // project-a keeps its session; project-b never inherits the foreign tab.
    expect(localStorage.getItem('pix3.projectTabs:project-a')).toContain('res://scripts/player.ts');
    expect(localStorage.getItem('pix3.projectTabs:project-b')).toBeNull();
  });

  it('skips restored tabs whose project resource no longer exists', async () => {
    const { service } = createService();
    appState.project.id = 'project-a';
    Object.defineProperty(service, 'storage', {
      value: {
        getLastModified: vi.fn(async (path: string) =>
          path === 'res://scripts/player.ts' ? 1 : null
        ),
      },
    });

    localStorage.setItem(
      'pix3.projectTabs:project-a',
      JSON.stringify({
        tabs: [
          { resourceId: 'res://scripts/player.ts', type: 'code', title: 'player.ts' },
          { resourceId: 'res://scenes/gone.pix3scene', type: 'scene', title: 'gone.pix3scene' },
        ],
        activeTabId: 'code:res://scripts/player.ts',
      })
    );

    await service.restoreProjectSession('project-a');

    expect(appState.tabs.tabs.map(tab => tab.resourceId)).toEqual(['res://scripts/player.ts']);
  });

  it('drops a stored session whose resources have all disappeared', async () => {
    const { service } = createService();
    appState.project.id = 'project-a';
    Object.defineProperty(service, 'storage', {
      value: { getLastModified: vi.fn(async () => null) },
    });

    localStorage.setItem(
      'pix3.projectTabs:project-a',
      JSON.stringify({
        tabs: [{ resourceId: 'res://scenes/castle.pix3scene', type: 'scene', title: 'castle' }],
        activeTabId: 'scene:res://scenes/castle.pix3scene',
      })
    );

    await expect(service.restoreProjectSession('project-a')).resolves.toBe(false);
    expect(appState.tabs.tabs).toHaveLength(0);
    expect(localStorage.getItem('pix3.projectTabs:project-a')).toBeNull();
  });

  /**
   * §9.8 — double-clicking a second image used to spawn a *second* editor beside
   * the first. There is one Sprite Editor; it gets pointed at the new image.
   */
  it('rebinds the open Sprite Editor instead of opening a second one', async () => {
    const { service } = createService();
    const layoutManager = (
      service as unknown as {
        layoutManager: { rebindEditorTab: ReturnType<typeof vi.fn> };
      }
    ).layoutManager;
    layoutManager.rebindEditorTab = vi.fn();

    await service.focusOrOpenSpriteEditor();
    expect(appState.tabs.tabs.map(tab => tab.id)).toEqual(['sprite-editor:sprite-editor://new']);

    await service.focusOrOpenSpriteEditor('res://sprites/ex0059.png');

    expect(appState.tabs.tabs).toHaveLength(1);
    const [tab] = appState.tabs.tabs;
    expect(tab.id).toBe('sprite-editor:res://sprites/ex0059.png');
    expect(tab.resourceId).toBe('res://sprites/ex0059.png');
    expect(tab.title).toBe('ex0059.png');
    expect(appState.tabs.activeTabId).toBe('sprite-editor:res://sprites/ex0059.png');
    expect(layoutManager.rebindEditorTab).toHaveBeenCalledWith(
      'sprite-editor:sprite-editor://new',
      'sprite-editor:res://sprites/ex0059.png',
      'ex0059.png'
    );

    // Rebinding again from the menu (no path) keeps the current binding.
    await service.focusOrOpenSpriteEditor();
    expect(appState.tabs.tabs).toHaveLength(1);
    expect(appState.tabs.tabs[0]?.resourceId).toBe('res://sprites/ex0059.png');
  });

  it('leaves other editor tabs alone when the Sprite Editor rebinds', async () => {
    const { service } = createService();
    const layoutManager = (
      service as unknown as {
        layoutManager: { rebindEditorTab: ReturnType<typeof vi.fn> };
      }
    ).layoutManager;
    layoutManager.rebindEditorTab = vi.fn();

    await service.openResourceTab('code', 'res://scripts/player.ts');
    await service.focusOrOpenSpriteEditor('res://sprites/a.png');
    await service.focusOrOpenSpriteEditor('res://sprites/b.png');

    expect(appState.tabs.tabs.map(tab => tab.id)).toEqual([
      'code:res://scripts/player.ts',
      'sprite-editor:res://sprites/b.png',
    ]);
  });
});
