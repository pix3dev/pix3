import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, getAppStateSnapshot, resetAppState } from '@/state';
import { UpdateAnimationDocumentOperation } from '@/features/properties/UpdateAnimationDocumentOperation';
import { AnimatedSprite2D, type AnimationResource } from '@pix3/runtime';

import {
  AnimationDocumentController,
  type AnimationDocumentControllerDeps,
} from './animation-document-controller';

/**
 * Private surface the specs seed directly. The controller mirrors editor state
 * through its appState subscriptions in the app; the tests below drive the
 * document math without a loaded project, exactly as the panel specs did before
 * the extraction.
 */
interface ControllerInternals {
  _assetPath: string | null;
  _resource: AnimationResource | null;
  _activeClipName: string;
  _selectedFrameIndex: number;
  _selectedFrameIndices: number[];
  animationId: string | null;
  texturePreviewCache: Map<string, string>;
  textureDimensionsCache: Map<string, { width: number; height: number }>;
  syncFromDocumentState(preserveClip: boolean): Promise<void>;
  addFramesFromGrid(columns: number, rows: number): Promise<void>;
  applyResourceUpdate(
    updater: (resource: AnimationResource) => AnimationResource,
    label: string,
    nextActiveClipName?: string
  ): Promise<boolean>;
}

function createDeps(overrides: Partial<AnimationDocumentControllerDeps> = {}) {
  const invokeAndPush = vi.fn().mockResolvedValue(true);
  const execute = vi.fn().mockResolvedValue(true);
  const showDialog = vi.fn().mockResolvedValue(null);
  const writeBinaryFile = vi.fn().mockResolvedValue(undefined);
  const evictTexture = vi.fn();
  const invalidateTexture = vi.fn();
  const deps = {
    operations: { invokeAndPush },
    commandDispatcher: { execute },
    // Reads never resolve to a decodable blob here: the texture-preview loader
    // swallows the failure, and no detached promise is left hanging.
    projectStorage: {
      readBlob: vi.fn().mockRejectedValue(new Error('no project storage in tests')),
      writeBinaryFile,
    },
    animationEditorService: {
      getActiveController: vi.fn().mockReturnValue(null),
      setActiveController: vi.fn(),
    },
    autoSliceDialog: { showDialog },
    dialogService: { showConfirmation: vi.fn().mockResolvedValue(true) },
    sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map() }) },
    assetLoader: { evictTexture },
    viewportRenderer: { invalidateTexture },
    ...overrides,
  } as unknown as AnimationDocumentControllerDeps;

  return {
    deps,
    invokeAndPush,
    execute,
    showDialog,
    writeBinaryFile,
    evictTexture,
    invalidateTexture,
  };
}

/** happy-dom has no `createImageBitmap`; the write-back measures the baked blob with it. */
function stubBakedBlobSize(width: number, height: number): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width, height, close: () => undefined })
  );
}

function createFrame(texturePath: string, anchor = { x: 0.5, y: 1 }) {
  return {
    textureIndex: 0,
    offset: { x: 0, y: 0 },
    repeat: { x: 1, y: 1 },
    durationMultiplier: 1,
    anchor,
    texturePath,
    boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    collisionPolygon: [],
  };
}

function seedDocument(
  controller: AnimationDocumentController,
  resource: AnimationResource,
  options: { animationId?: string; assetPath?: string; activeClipName?: string } = {}
): ControllerInternals {
  const internals = controller as unknown as ControllerInternals;
  internals._assetPath = options.assetPath ?? 'res://animations/walk/walk.pix3anim';
  internals.animationId = options.animationId ?? 'animations-walk';
  internals._resource = resource;
  internals._activeClipName = options.activeClipName ?? resource.clips[0]?.name ?? '';
  return internals;
}

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

describe('AnimationDocumentController', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    resetAppState();
  });

  it('preserves the active clip when reloading the same asset', async () => {
    const animationId = 'animations-walk';
    const selectedSprite = createAnimatedSprite(
      'sprite-1',
      'res://animations/walk.pix3anim',
      'idle'
    );
    const { deps } = createDeps({
      sceneManager: {
        getActiveSceneGraph: () => ({
          nodeMap: new Map([[selectedSprite.nodeId, selectedSprite]]),
        }),
      } as unknown as AnimationDocumentControllerDeps['sceneManager'],
    });
    const controller = new AnimationDocumentController(deps, '');

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
        { name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames: [] },
        { name: 'run', fps: 16, loop: true, playbackMode: 'normal', frames: [] },
      ],
    };

    const internals = controller as unknown as ControllerInternals;
    internals._assetPath = 'res://animations/walk.pix3anim';
    internals.animationId = animationId;
    internals._activeClipName = 'run';

    await internals.syncFromDocumentState(true);

    expect(controller.activeClipName).toBe('run');
  });

  it('preserves the current clip when appending frame textures', async () => {
    const animationId = 'animations-walk';
    const { deps, invokeAndPush } = createDeps();
    const controller = new AnimationDocumentController(deps, '');

    const resource: AnimationResource = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        { name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames: [] },
        { name: 'run', fps: 12, loop: true, playbackMode: 'normal', frames: [] },
      ],
    };
    seedDocument(controller, resource, { animationId, activeClipName: 'run' });
    appState.animations.resources[animationId] = structuredClone(resource);

    await controller.addFrameTextures(['res://textures/player.png']);

    expect(controller.activeClipName).toBe('run');
    expect(controller.resource?.clips.find(clip => clip.name === 'run')?.frames[0]?.anchor).toEqual(
      {
        x: 0.5,
        y: 0.5,
      }
    );
    expect(invokeAndPush).toHaveBeenCalledOnce();
  });

  it('applies the selected anchor to every frame in every clip', async () => {
    const { deps } = createDeps();
    const controller = new AnimationDocumentController(deps, '');

    const resource: AnimationResource = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [
            createFrame('res://a.png', { x: 0.25, y: 0.75 }),
            createFrame('res://b.png', { x: 0, y: 1 }),
          ],
        },
        {
          name: 'run',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [createFrame('res://c.png', { x: 1, y: 0 })],
        },
      ],
    };
    const internals = seedDocument(controller, resource, { activeClipName: 'idle' });
    internals._selectedFrameIndex = 0;
    internals._selectedFrameIndices = [0];

    await controller.applySelectedAnchorToAllClips();

    const clips = controller.resource?.clips ?? [];
    expect(clips[0]?.frames.map(frame => frame.anchor)).toEqual([
      { x: 0.25, y: 0.75 },
      { x: 0.25, y: 0.75 },
    ]);
    expect(clips[1]?.frames.map(frame => frame.anchor)).toEqual([{ x: 0.25, y: 0.75 }]);
  });

  it('deletes all selected frames from a ctrl-multiselection', async () => {
    const { deps } = createDeps();
    const controller = new AnimationDocumentController(deps, '');

    const resource: AnimationResource = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [
            createFrame('res://a.png'),
            createFrame('res://b.png'),
            createFrame('res://c.png'),
            createFrame('res://d.png'),
          ],
        },
      ],
    };
    seedDocument(controller, resource, { activeClipName: 'idle' });

    controller.selectFrame(0);
    controller.selectFrame(2, { ctrl: true });

    expect(controller.selectedFrameIndices).toEqual([0, 2]);

    await controller.removeSelectedFrames();

    expect(controller.resource?.clips[0]?.frames.map(frame => frame.texturePath)).toEqual([
      'res://b.png',
      'res://d.png',
    ]);
    expect(controller.selectedFrameIndices).toEqual([0]);
    expect(controller.selectedFrameIndex).toBe(0);
  });

  it('keeps a ctrl-multiselection across a spurious document re-sync', async () => {
    // Regression: selecting a frame persists the primary index into
    // `tab.contextState`, which mutates `appState.tabs` and re-enters
    // `syncFromDocumentState` on the next valtio flush. That re-entry used to
    // collapse the selection to a single frame, so multi-select lit up and then
    // silently reverted — and "delete selected frames" only deleted one.
    const { deps } = createDeps();
    const controller = new AnimationDocumentController(deps, '');

    const resource: AnimationResource = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [
            createFrame('res://a.png'),
            createFrame('res://b.png'),
            createFrame('res://c.png'),
            createFrame('res://d.png'),
          ],
        },
      ],
    };
    const internals = seedDocument(controller, resource, { activeClipName: 'idle' });
    appState.animations.resources[internals.animationId as string] = resource;

    controller.selectFrame(1);
    controller.selectFrame(3, { ctrl: true });
    expect(controller.selectedFrameIndices).toEqual([1, 3]);

    await internals.syncFromDocumentState(true);

    expect(controller.selectedFrameIndices).toEqual([1, 3]);
    expect(controller.selectedFrameIndex).toBe(3);

    // A deliberate reset (clip switch / fresh load) must still collapse it.
    await internals.syncFromDocumentState(false);
    expect(controller.selectedFrameIndices).toEqual([0]);
  });

  it('prompts for autoslice when a texture is assigned to an animation without frames', async () => {
    const { deps, showDialog } = createDeps();
    showDialog.mockResolvedValue({ columns: 4, rows: 2 });
    const controller = new AnimationDocumentController(deps, '');

    const resource: AnimationResource = {
      version: '1.0.0',
      texturePath: '',
      clips: [{ name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames: [] }],
    };
    const internals = seedDocument(controller, resource, { activeClipName: 'idle' });

    const applyResourceUpdate = vi.fn().mockResolvedValue(true);
    const addFramesFromGrid = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(internals, 'applyResourceUpdate', { value: applyResourceUpdate });
    Object.defineProperty(internals, 'addFramesFromGrid', { value: addFramesFromGrid });

    await controller.updateTexturePath('res://textures/player.png');

    expect(showDialog).toHaveBeenCalledWith({
      texturePath: 'res://textures/player.png',
      contextLabel: 'idle',
      defaultColumns: 1,
      defaultRows: 1,
    });
    expect(addFramesFromGrid).toHaveBeenCalledWith(4, 2);
  });

  it('keeps per-frame events across a document round-trip', async () => {
    const { deps } = createDeps();
    const controller = new AnimationDocumentController(deps, '');

    const resource: AnimationResource = {
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          playbackMode: 'normal',
          frames: [
            { ...createFrame('res://a.png'), events: [{ signal: 'footstep', args: 'left' }] },
            { ...createFrame('res://b.png'), events: [{ signal: 'attack', args: '' }] },
          ],
        },
      ],
    };
    const internals = seedDocument(controller, resource, { activeClipName: 'idle' });
    internals._selectedFrameIndex = 0;
    internals._selectedFrameIndices = [0];

    await controller.updateSelectedFrameAnchor('x', 0.25);

    const frames = controller.resource?.clips[0]?.frames ?? [];
    expect(frames[0]?.anchor.x).toBe(0.25);
    expect(frames[0]?.events).toEqual([{ signal: 'footstep', args: 'left' }]);
    expect(frames[1]?.events).toEqual([{ signal: 'attack', args: '' }]);
  });

  describe('replaceFrameTexture (§9.5 write-back)', () => {
    const ASSET_PATH = 'res://sprites/walk/walk.pix3anim';
    const ANIMATION_ID = 'sprites-walk-walk';
    const ORIGINAL_FRAME = 'res://sprites/walk/idle_0001.png';

    /** A 100×80 frame carrying one of every geometry field the restamp has to move. */
    function createCroppableResource(): AnimationResource {
      return {
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
                ...createFrame(ORIGINAL_FRAME, { x: 0.4, y: 0.25 }),
                boundingBox: { x: 20, y: 10, width: 40, height: 30 },
                collisionPolygon: [
                  { x: 30, y: 20 },
                  { x: 50, y: 35 },
                ],
                sourceSize: { width: 100, height: 80 },
                points: [{ name: 'muzzle', x: 0.6, y: 0.5 }],
              },
            ],
          },
        ],
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('writes a new numbered file, takes one undo step and restamps the frame', async () => {
      stubBakedBlobSize(40, 30);
      const { deps, invokeAndPush, writeBinaryFile } = createDeps();
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedDocument(controller, createCroppableResource(), {
        animationId: ANIMATION_ID,
        assetPath: ASSET_PATH,
        activeClipName: 'idle',
      });
      internals._selectedFrameIndex = 0;
      // A decoded copy of the frame the crop replaces — it must not survive.
      internals.texturePreviewCache.set(ORIGINAL_FRAME, 'blob:stale');
      internals.textureDimensionsCache.set(ORIGINAL_FRAME, { width: 100, height: 80 });

      const written = await controller.replaceFrameTexture(
        0,
        new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        { restamp: { kind: 'crop', x: 20, y: 10 } }
      );

      // A NEW file, not an in-place overwrite: undo has to land on untouched pixels.
      expect(written).toBe('res://sprites/walk/idle_0002.png');
      expect(writeBinaryFile).toHaveBeenCalledTimes(1);
      expect(writeBinaryFile.mock.calls[0][0]).toBe('res://sprites/walk/idle_0002.png');
      expect(invokeAndPush).toHaveBeenCalledOnce();

      const frame = controller.resource?.clips[0]?.frames[0];
      expect(frame?.texturePath).toBe('res://sprites/walk/idle_0002.png');
      // R1: the editor stamps the size so layout never waits on a texture load.
      expect(frame?.sourceSize).toEqual({ width: 40, height: 30 });
      // a' = (a·W − cropX) / w — the frame renders identically after the crop.
      expect(frame?.anchor.x).toBeCloseTo(0.5, 6);
      expect(frame?.anchor.y).toBeCloseTo(1 / 3, 6);
      expect(frame?.points?.[0]?.x).toBeCloseTo(1, 6);
      expect(frame?.points?.[0]?.y).toBeCloseTo(1, 6);
      // Absolute frame pixels, so they shift by −(cropX, cropY).
      expect(frame?.boundingBox).toEqual({ x: 0, y: 0, width: 40, height: 30 });
      expect(frame?.collisionPolygon).toEqual([
        { x: 10, y: 10 },
        { x: 30, y: 25 },
      ]);
    });

    it('evicts every cache that still holds the old pixels', async () => {
      stubBakedBlobSize(40, 30);
      const { deps, evictTexture, invalidateTexture } = createDeps();
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedDocument(controller, createCroppableResource(), {
        animationId: ANIMATION_ID,
        assetPath: ASSET_PATH,
        activeClipName: 'idle',
      });
      internals._selectedFrameIndex = 0;
      internals.texturePreviewCache.set(ORIGINAL_FRAME, 'blob:stale');
      internals.textureDimensionsCache.set(ORIGINAL_FRAME, { width: 100, height: 80 });

      await controller.replaceFrameTexture(0, new Blob([new Uint8Array([1])]), {
        restamp: { kind: 'crop', x: 20, y: 10 },
      });

      expect(internals.texturePreviewCache.has(ORIGINAL_FRAME)).toBe(false);
      expect(internals.textureDimensionsCache.has(ORIGINAL_FRAME)).toBe(false);
      // Play mode reloads from disk; the viewport proxies re-request and repaint.
      expect(evictTexture).toHaveBeenCalledWith(ORIGINAL_FRAME);
      expect(evictTexture).toHaveBeenCalledWith('res://sprites/walk/idle_0002.png');
      expect(invalidateTexture).toHaveBeenCalledWith(ORIGINAL_FRAME);
      expect(invalidateTexture).toHaveBeenCalledWith('res://sprites/walk/idle_0002.png');
    });

    it('undoes back to the original texture path', async () => {
      stubBakedBlobSize(40, 30);
      const commits: Array<{ undo: () => void }> = [];
      const invokeAndPush = vi.fn(async (operation: UpdateAnimationDocumentOperation) => {
        const result = await operation.perform({
          state: appState,
          snapshot: getAppStateSnapshot(),
          container: undefined,
          requestedAt: Date.now(),
        } as unknown as Parameters<UpdateAnimationDocumentOperation['perform']>[0]);
        if (result.didMutate && result.commit) {
          commits.push(result.commit);
        }
        return result.didMutate;
      });
      const { deps } = createDeps({
        operations: { invokeAndPush } as unknown as AnimationDocumentControllerDeps['operations'],
      });
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedDocument(controller, createCroppableResource(), {
        animationId: ANIMATION_ID,
        assetPath: ASSET_PATH,
        activeClipName: 'idle',
      });
      internals._selectedFrameIndex = 0;
      appState.animations.descriptors[ANIMATION_ID] = {
        id: ANIMATION_ID,
        filePath: ASSET_PATH,
        name: 'walk.pix3anim',
        version: '1.0.0',
        isDirty: false,
        lastSavedAt: null,
        lastModifiedTime: null,
      };
      appState.animations.resources[ANIMATION_ID] = createCroppableResource();

      await controller.replaceFrameTexture(0, new Blob([new Uint8Array([1])]), {
        restamp: { kind: 'crop', x: 20, y: 10 },
      });

      expect(appState.animations.resources[ANIMATION_ID]?.clips[0]?.frames[0]?.texturePath).toBe(
        'res://sprites/walk/idle_0002.png'
      );

      expect(commits).toHaveLength(1);
      commits[0]?.undo();

      const restored = appState.animations.resources[ANIMATION_ID]?.clips[0]?.frames[0];
      expect(restored?.texturePath).toBe(ORIGINAL_FRAME);
      expect(restored?.sourceSize).toEqual({ width: 100, height: 80 });
      expect(restored?.anchor).toEqual({ x: 0.4, y: 0.25 });
    });

    it('only restamps the size for a whole-frame replacement', async () => {
      stubBakedBlobSize(64, 64);
      const { deps } = createDeps();
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedDocument(controller, createCroppableResource(), {
        animationId: ANIMATION_ID,
        assetPath: ASSET_PATH,
        activeClipName: 'idle',
      });
      internals._selectedFrameIndex = 0;

      await controller.replaceFrameTexture(0, new Blob([new Uint8Array([1])]), {
        restamp: { kind: 'replace' },
      });

      const frame = controller.resource?.clips[0]?.frames[0];
      expect(frame?.sourceSize).toEqual({ width: 64, height: 64 });
      // Normalized fields describe a fraction of the frame, so they do not move.
      expect(frame?.anchor).toEqual({ x: 0.4, y: 0.25 });
      expect(frame?.points?.[0]).toMatchObject({ name: 'muzzle', x: 0.6, y: 0.5 });
    });
  });

  it('registers itself as the inspector controller only while its tab is active', async () => {
    const setActiveController = vi.fn();
    const activeControllers: unknown[] = [];
    const { deps } = createDeps({
      animationEditorService: {
        getActiveController: () => activeControllers.at(-1) ?? null,
        setActiveController: (controller: unknown) => {
          activeControllers.push(controller);
          setActiveController(controller);
        },
      } as unknown as AnimationDocumentControllerDeps['animationEditorService'],
    });

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
      clips: [{ name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames: [] }],
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
    appState.tabs.activeTabId = tabId;

    const controller = new AnimationDocumentController(deps, tabId);
    controller.attach();

    await vi.waitFor(() => {
      expect(controller.activeClipName).toBe('idle');
    });

    expect(controller.assetPath).toBe('res://animations/walk.pix3anim');
    expect(setActiveController).toHaveBeenCalledWith(controller);
    expect(appState.tabs.tabs[0]?.contextState?.activeClipName).toBe('idle');

    controller.dispose();
    expect(setActiveController).toHaveBeenLastCalledWith(null);
  });
});
