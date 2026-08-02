import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { AnimationDocumentController } from '@/ui/sprite-editor/animation-document-controller';

import { AnimationPanel } from './animation-panel';

/**
 * Document logic lives in `AnimationDocumentController` and is covered by
 * `src/ui/sprite-editor/animation-document-controller.spec.ts`. What is left here
 * is what the panel still owns: DataTransfer parsing and the drag state machine.
 */
function createPanel(): AnimationPanel {
  const panel = new AnimationPanel();
  Object.defineProperty(panel, 'sceneManager', {
    value: {
      getActiveSceneGraph: () => ({
        nodeMap: new Map(),
      }),
    },
  });
  Object.defineProperty(panel, 'projectStorage', {
    value: {
      readBlob: vi.fn(),
      writeBinaryFile: vi.fn(),
    },
  });
  return panel;
}

function getController(panel: AnimationPanel): AnimationDocumentController {
  return (panel as unknown as { controller: AnimationDocumentController }).controller;
}

describe('AnimationPanel', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
  });

  it('loads an animation asset from the assigned editor tab', async () => {
    const panel = createPanel();
    const tabId = 'animation:res://animations/walk.pix3anim';
    const animationId = 'animations-walk';

    appState.animations.descriptors[animationId] = {
      id: animationId,
      filePath: 'res://animations/walk.pix3anim',
      name: 'walk.pix3anim',
      version: '1.0.0',
      isDirty: false,
      lastSavedAt: null,
      lastModifiedTime: null,
    };
    appState.animations.resources[animationId] = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [],
        },
      ],
    };

    appState.tabs.tabs = [
      {
        id: tabId,
        resourceId: 'res://animations/walk.pix3anim',
        type: 'animation',
        title: 'walk.pix3anim',
        isDirty: false,
      },
    ];
    panel.tabId = tabId;

    document.body.appendChild(panel);

    await vi.waitFor(() => {
      expect(getController(panel).activeClipName).toBe('idle');
    });

    expect(getController(panel).assetPath).toBe('res://animations/walk.pix3anim');

    await panel.updateComplete;
    expect(panel.querySelector('.editor-toolbar')).not.toBeNull();
    expect(panel.querySelector('.editor-status-row')?.textContent).toContain('idle');
    expect(panel.querySelector('.editor-surface--timeline')?.textContent).toContain(
      'This clip has no frames yet'
    );
  });

  it('accepts texture drops from the asset browser', async () => {
    const panel = createPanel();
    const panelState = panel as unknown as {
      onEditorDrop: (event: DragEvent) => Promise<void>;
    };
    const addFrameTextures = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(getController(panel), 'addFrameTextures', {
      value: addFrameTextures,
    });

    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        types: ['application/x-pix3-asset-resource'],
        getData: vi.fn((type: string) =>
          type === 'application/x-pix3-asset-resource' ? 'res://textures/player.png' : ''
        ),
      },
    } as unknown as DragEvent;

    await panelState.onEditorDrop(event);

    expect(addFrameTextures).toHaveBeenCalledWith(['res://textures/player.png']);
  });

  it('accepts multiple textures from a preview multi-drag payload', async () => {
    const panel = createPanel();
    const panelState = panel as unknown as {
      onEditorDrop: (event: DragEvent) => Promise<void>;
    };
    const addFrameTextures = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(getController(panel), 'addFrameTextures', {
      value: addFrameTextures,
    });

    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn((type: string) => {
          if (type === 'application/x-pix3-asset-resource-list') {
            return JSON.stringify(['res://textures/player-01.png', 'res://textures/player-02.png']);
          }
          return '';
        }),
        types: ['application/x-pix3-asset-resource-list'],
      },
    } as unknown as DragEvent;

    await panelState.onEditorDrop(event);

    expect(addFrameTextures).toHaveBeenCalledWith([
      'res://textures/player-01.png',
      'res://textures/player-02.png',
    ]);
  });

  it('does not enable the texture overlay during internal frame reordering drags', () => {
    const panel = createPanel();
    const setData = vi.fn();
    const dataTransfer = {
      effectAllowed: 'all',
      setData,
      types: ['application/x-pix3-animation-frame-reorder', 'text/plain'],
    } as unknown as DataTransfer;

    (
      panel as unknown as {
        onFrameDragStart: (event: DragEvent, index: number) => void;
      }
    ).onFrameDragStart(
      {
        dataTransfer,
      } as DragEvent,
      1
    );

    expect(setData).toHaveBeenCalledWith('application/x-pix3-animation-frame-reorder', '1');
    expect(getController(panel).selectedFrameIndices).toEqual([1]);

    (
      panel as unknown as {
        onEditorDragEnter: (event: DragEvent) => void;
      }
    ).onEditorDragEnter({
      dataTransfer,
    } as DragEvent);

    expect((panel as unknown as { isTextureDragOver: boolean }).isTextureDragOver).toBe(false);
  });
});
