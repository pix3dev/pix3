import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { FRAME_REORDER_MIME } from '@/ui/shared/asset-drag-drop';
import type { AnimationDocumentController } from '@/ui/sprite-editor/animation-document-controller';

import { AnimationPanel } from './animation-panel';

/**
 * Document logic lives in `AnimationDocumentController` and the frame strip in
 * `<pix3-sprite-timeline>`, both covered by their own specs under
 * `src/ui/sprite-editor/`. What is left here is what the panel still owns: the
 * editor-level texture drop and the overlay it raises.
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

    // The strip itself is the timeline component's business; the panel only has to
    // host it and hand it the one controller instance it owns.
    const timeline = panel.querySelector('pix3-sprite-timeline');
    expect(timeline).not.toBeNull();
    expect(timeline?.controller).toBe(getController(panel));
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

  it('takes its drop overlay down even when the frame strip swallows the drop', async () => {
    const panel = createPanel();
    document.body.appendChild(panel);
    await panel.updateComplete;

    const panelState = panel as unknown as {
      isTextureDragOver: boolean;
      textureDragDepth: number;
    };
    panelState.isTextureDragOver = true;
    panelState.textureDragDepth = 1;

    // A frame card inserts the texture itself and stops the event, so the
    // editor-level drop handler never runs.
    const card = document.createElement('div');
    card.addEventListener('drop', event => event.stopPropagation());
    panel.appendChild(card);
    card.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

    expect(panelState.isTextureDragOver).toBe(false);
    expect(panelState.textureDragDepth).toBe(0);
  });

  /**
   * The other half of this contract — the frame strip *writing* `FRAME_REORDER_MIME`
   * on dragstart — now lives in `src/ui/sprite-editor/sprite-timeline.spec.ts`. The
   * shell's job is to stay out of the way while such a drag is in flight, which is
   * why the MIME is a shared constant rather than a component-private string.
   */
  it('does not enable the texture overlay during internal frame reordering drags', () => {
    const panel = createPanel();
    const dataTransfer = {
      effectAllowed: 'move',
      types: [FRAME_REORDER_MIME, 'text/plain'],
      getData: vi.fn(() => '1'),
    } as unknown as DataTransfer;

    (
      panel as unknown as {
        onEditorDragEnter: (event: DragEvent) => void;
      }
    ).onEditorDragEnter({
      dataTransfer,
    } as DragEvent);

    expect((panel as unknown as { isTextureDragOver: boolean }).isTextureDragOver).toBe(false);

    (
      panel as unknown as {
        onEditorDragEnter: (event: DragEvent) => void;
      }
    ).onEditorDragEnter({
      dataTransfer: {
        types: ['application/x-pix3-asset-resource'],
        getData: vi.fn(() => 'res://textures/player.png'),
      },
    } as unknown as DragEvent);

    expect((panel as unknown as { isTextureDragOver: boolean }).isTextureDragOver).toBe(true);
  });
});
