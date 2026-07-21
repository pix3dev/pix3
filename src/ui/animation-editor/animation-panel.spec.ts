import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { AnimatedSprite2D } from '@pix3/runtime';

import { AnimationPanel } from './animation-panel';

function createAnimatedSprite(nodeId: string, animationResourcePath: string, currentClip = 'idle') {
  const sprite = Object.create(AnimatedSprite2D.prototype) as AnimatedSprite2D;
  Object.defineProperty(sprite, 'nodeId', {
    value: nodeId,
    configurable: true,
  });
  sprite.animationResourcePath = animationResourcePath;
  sprite.currentClip = currentClip;
  return sprite;
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
    const panel = new AnimationPanel();
    const panelState = panel as unknown as {
      activeClipName: string;
      assetPath: string | null;
    };
    const tabId = 'animation:res://animations/walk.pix3anim';
    const animationId = 'animations-walk';

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
      },
    });

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
      expect(panelState.activeClipName).toBe('idle');
    });

    expect(panelState.assetPath).toBe('res://animations/walk.pix3anim');
  });

  it('preserves the active clip when reloading the same asset', async () => {
    const panel = new AnimationPanel();
    const panelState = panel as unknown as {
      activeClipName: string;
      syncFromDocumentState: (preserveClip: boolean) => Promise<void>;
    };
    const selectedSprite = createAnimatedSprite(
      'sprite-1',
      'res://animations/walk.pix3anim',
      'idle'
    );
    const animationId = 'animations-walk';

    Object.defineProperty(panel, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({
          nodeMap: new Map([[selectedSprite.nodeId, selectedSprite]]),
        }),
      },
    });
    Object.defineProperty(panel, 'projectStorage', {
      value: {
        readBlob: vi.fn(),
      },
    });
    Object.defineProperty(panel, 'assetPath', {
      value: 'res://animations/walk.pix3anim',
      writable: true,
    });
    Object.defineProperty(panel, 'animationId', {
      value: animationId,
      writable: true,
    });
    Object.defineProperty(panel, 'activeClipName', {
      value: 'run',
      writable: true,
    });

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
        {
          name: 'run',
          fps: 16,
          loop: true,
          playbackMode: 'normal',
          frames: [],
        },
      ],
    };

    await panelState.syncFromDocumentState(true);

    expect(panelState.activeClipName).toBe('run');
  });

  it('accepts texture drops from the asset browser', async () => {
    const panel = new AnimationPanel();
    const panelState = panel as unknown as {
      onEditorDrop: (event: DragEvent) => Promise<void>;
    };
    const addFrameTextures = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(panel, 'onUpdateTexturePath', {
      value: vi.fn(),
    });
    Object.defineProperty(panel, 'onAddFrameTextures', {
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
    const panel = new AnimationPanel();
    const panelState = panel as unknown as {
      onEditorDrop: (event: DragEvent) => Promise<void>;
    };
    const addFrameTextures = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(panel, 'onAddFrameTextures', {
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
    const panel = new AnimationPanel();
    const setData = vi.fn();
    const dataTransfer = {
      effectAllowed: 'all',
      setData,
      types: ['application/x-pix3-animation-frame-reorder', 'text/plain'],
    } as unknown as DataTransfer;

    Object.defineProperty(panel, 'selectedFrameIndices', {
      value: [1],
      writable: true,
    });
    Object.defineProperty(panel, 'selectedFrameIndex', {
      value: 1,
      writable: true,
    });
    Object.defineProperty(panel, 'previewFrameIndex', {
      value: 1,
      writable: true,
    });
    Object.defineProperty(panel, 'selectionAnchorFrameIndex', {
      value: 1,
      writable: true,
    });
    Object.defineProperty(panel, 'persistSelectedFrameIndex', {
      value: vi.fn(),
    });

    (
      panel as unknown as {
        onFrameDragStart: (event: DragEvent, index: number) => void;
        onEditorDragEnter: (event: DragEvent) => void;
        isTextureDragOver: boolean;
      }
    ).onFrameDragStart(
      {
        dataTransfer,
      } as DragEvent,
      1
    );

    expect(setData).toHaveBeenCalledWith('application/x-pix3-animation-frame-reorder', '1');

    (
      panel as unknown as {
        onEditorDragEnter: (event: DragEvent) => void;
      }
    ).onEditorDragEnter({
      dataTransfer,
    } as DragEvent);

    expect((panel as unknown as { isTextureDragOver: boolean }).isTextureDragOver).toBe(false);
  });

  it('preserves the current clip when appending frame textures', async () => {
    const panel = new AnimationPanel();
    const invokeAndPush = vi.fn().mockResolvedValue(true);
    const animationId = 'animations-walk';

    Object.defineProperty(panel, 'operations', {
      value: { invokeAndPush },
    });
    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(true) },
    });
    Object.defineProperty(panel, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({
          nodeMap: new Map(),
        }),
      },
    });
    Object.defineProperty(panel, 'assetPath', {
      value: 'res://animations/walk/walk.pix3anim',
      writable: true,
    });
    Object.defineProperty(panel, 'animationId', {
      value: animationId,
      writable: true,
    });
    Object.defineProperty(panel, 'resource', {
      value: {
        version: '1.0.0',
        texturePath: '',
        clips: [
          { name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames: [] },
          { name: 'run', fps: 12, loop: true, playbackMode: 'normal', frames: [] },
        ],
      },
      writable: true,
    });
    Object.defineProperty(panel, 'activeClipName', {
      value: 'run',
      writable: true,
    });

    appState.animations.resources[animationId] = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        { name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames: [] },
        { name: 'run', fps: 12, loop: true, playbackMode: 'normal', frames: [] },
      ],
    };

    await (
      panel as unknown as { onAddFrameTextures: (paths: string[]) => Promise<void> }
    ).onAddFrameTextures(['res://textures/player.png']);

    expect((panel as unknown as { activeClipName: string }).activeClipName).toBe('run');
    expect(
      (
        panel as unknown as {
          resource: {
            clips: Array<{ name: string; frames: Array<{ anchor: { x: number; y: number } }> }>;
          };
        }
      ).resource.clips.find(clip => clip.name === 'run')?.frames[0]?.anchor
    ).toEqual({ x: 0.5, y: 0.5 });
    expect(invokeAndPush).toHaveBeenCalledOnce();
  });

  it('applies the selected anchor to every frame in every clip', async () => {
    const panel = new AnimationPanel();
    const animationId = 'animations-walk';

    Object.defineProperty(panel, 'operations', {
      value: { invokeAndPush: vi.fn().mockResolvedValue(true) },
    });
    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(true) },
    });
    Object.defineProperty(panel, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({
          nodeMap: new Map(),
        }),
      },
    });
    Object.defineProperty(panel, 'assetPath', {
      value: 'res://animations/walk/walk.pix3anim',
      writable: true,
    });
    Object.defineProperty(panel, 'animationId', {
      value: animationId,
      writable: true,
    });
    Object.defineProperty(panel, 'resource', {
      value: {
        version: '1.0.0',
        texturePath: '',
        clips: [
          {
            name: 'idle',
            fps: 12,
            loop: true,
            playbackMode: 'normal',
            frames: [
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 0.25, y: 0.75 },
                texturePath: 'res://a.png',
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 0, y: 1 },
                texturePath: 'res://b.png',
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
            ],
          },
          {
            name: 'run',
            fps: 12,
            loop: true,
            playbackMode: 'normal',
            frames: [
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 1, y: 0 },
                texturePath: 'res://c.png',
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
            ],
          },
        ],
      },
      writable: true,
    });
    Object.defineProperty(panel, 'activeClipName', {
      value: 'idle',
      writable: true,
    });
    Object.defineProperty(panel, 'selectedFrameIndex', {
      value: 0,
      writable: true,
    });
    Object.defineProperty(panel, 'selectedFrameIndices', {
      value: [0],
      writable: true,
    });

    appState.animations.resources[animationId] = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0.25, y: 0.75 },
              texturePath: 'res://a.png',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
            },
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0, y: 1 },
              texturePath: 'res://b.png',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
            },
          ],
        },
        {
          name: 'run',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 1, y: 0 },
              texturePath: 'res://c.png',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
            },
          ],
        },
      ],
    };

    await (
      panel as unknown as { onApplySelectedAnchorToAllClips: () => Promise<void> }
    ).onApplySelectedAnchorToAllClips();

    const clips = (
      panel as unknown as {
        resource: { clips: Array<{ frames: Array<{ anchor: { x: number; y: number } }> }> };
      }
    ).resource.clips;

    expect(clips[0]?.frames.map(frame => frame.anchor)).toEqual([
      { x: 0.25, y: 0.75 },
      { x: 0.25, y: 0.75 },
    ]);
    expect(clips[1]?.frames.map(frame => frame.anchor)).toEqual([{ x: 0.25, y: 0.75 }]);
  });

  it('deletes all selected frames from a ctrl-multiselection', async () => {
    const panel = new AnimationPanel();
    const animationId = 'animations-walk';

    Object.defineProperty(panel, 'operations', {
      value: { invokeAndPush: vi.fn().mockResolvedValue(true) },
    });
    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(true) },
    });
    Object.defineProperty(panel, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({
          nodeMap: new Map(),
        }),
      },
    });
    Object.defineProperty(panel, 'assetPath', {
      value: 'res://animations/walk/walk.pix3anim',
      writable: true,
    });
    Object.defineProperty(panel, 'animationId', {
      value: animationId,
      writable: true,
    });
    Object.defineProperty(panel, 'resource', {
      value: {
        version: '1.0.0',
        texturePath: '',
        clips: [
          {
            name: 'idle',
            fps: 12,
            loop: true,
            playbackMode: 'normal',
            frames: [
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 0.5, y: 1 },
                texturePath: 'res://a.png',
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 0.5, y: 1 },
                texturePath: 'res://b.png',
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 0.5, y: 1 },
                texturePath: 'res://c.png',
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 0.5, y: 1 },
                texturePath: 'res://d.png',
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
            ],
          },
        ],
      },
      writable: true,
    });
    Object.defineProperty(panel, 'activeClipName', {
      value: 'idle',
      writable: true,
    });

    appState.animations.resources[animationId] = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0.5, y: 1 },
              texturePath: 'res://a.png',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
            },
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0.5, y: 1 },
              texturePath: 'res://b.png',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
            },
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0.5, y: 1 },
              texturePath: 'res://c.png',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
            },
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0.5, y: 1 },
              texturePath: 'res://d.png',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
            },
          ],
        },
      ],
    };

    await (
      panel as unknown as { syncFrameStateToActiveClip: (preferFirstFrame?: boolean) => void }
    ).syncFrameStateToActiveClip();
    (
      panel as unknown as { onSelectFrame: (event: MouseEvent, index: number) => void }
    ).onSelectFrame({ ctrlKey: true, metaKey: false, shiftKey: false } as MouseEvent, 2);

    expect((panel as unknown as { selectedFrameIndices: number[] }).selectedFrameIndices).toEqual([
      0, 2,
    ]);

    await (
      panel as unknown as { onRemoveSelectedFrame: () => Promise<void> }
    ).onRemoveSelectedFrame();

    expect(
      (
        (
          panel as unknown as {
            resource: { clips: Array<{ frames: Array<{ texturePath?: string }> }> };
          }
        ).resource.clips[0]?.frames ?? []
      ).map(frame => frame.texturePath)
    ).toEqual(['res://b.png', 'res://d.png']);
    expect((panel as unknown as { selectedFrameIndices: number[] }).selectedFrameIndices).toEqual([
      0,
    ]);
    expect((panel as unknown as { selectedFrameIndex: number }).selectedFrameIndex).toBe(0);
  });

  it('prompts for autoslice when a texture is assigned to an animation without frames', async () => {
    const panel = new AnimationPanel();
    const panelState = panel as unknown as {
      onUpdateTexturePath: (texturePath: string) => Promise<void>;
    };
    const showDialog = vi.fn().mockResolvedValue({ columns: 4, rows: 2 });
    const applyResourceUpdate = vi.fn().mockResolvedValue(true);
    const addFramesFromGrid = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(panel, 'animationAutoSliceDialogService', {
      value: { showDialog },
    });
    Object.defineProperty(panel, 'applyResourceUpdate', {
      value: applyResourceUpdate,
    });
    Object.defineProperty(panel, 'onAddFramesFromGrid', {
      value: addFramesFromGrid,
    });
    Object.defineProperty(panel, 'resource', {
      value: {
        version: '1.0.0',
        texturePath: '',
        clips: [
          {
            name: 'idle',
            fps: 12,
            loop: true,
            frames: [],
          },
        ],
      },
      writable: true,
    });
    Object.defineProperty(panel, 'activeClipName', {
      value: 'idle',
      writable: true,
    });

    await panelState.onUpdateTexturePath('res://textures/player.png');

    expect(showDialog).toHaveBeenCalledWith({
      texturePath: 'res://textures/player.png',
      clipName: 'idle',
      defaultColumns: 1,
      defaultRows: 1,
    });
    expect(addFramesFromGrid).toHaveBeenCalledWith(4, 2);
  });
});
