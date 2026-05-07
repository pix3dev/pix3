import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { EditorTabService } from './EditorTabService';

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
    expect(appState.tabs.tabs[0]?.title.startsWith('*')).toBe(true);

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
});
