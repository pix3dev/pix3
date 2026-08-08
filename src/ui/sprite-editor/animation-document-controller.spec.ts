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

  describe('trimClipFrames (§9.12.1)', () => {
    const ASSET_PATH = 'res://sprites/walk/walk.pix3anim';
    const ANIMATION_ID = 'sprites-walk-walk';

    /** A frame raster: fully opaque inside `opaque`, fully transparent outside. */
    interface FakeRaster {
      width: number;
      height: number;
      opaque: { x: number; y: number; width: number; height: number } | null;
    }

    /**
     * Let the REAL `trimImageBlob` run. happy-dom has neither `createImageBitmap`
     * nor a 2D canvas, so both are stood up over a synthetic alpha buffer — the
     * bounding-box scan, the padding/centering maths and therefore the crop origin
     * this spec is about are all the shipping implementation, not a double.
     *
     * Frame blobs carry their own texture path as text, which is how the bitmap
     * stub knows which raster it was handed.
     */
    function stubRasters(rasters: Record<string, FakeRaster>): void {
      // Unlike the other suites here, `readBlob` RESOLVES in this one, so the
      // controller's texture-preview loader gets as far as `new Image()` — which
      // happy-dom never settles, and `applyResourceUpdate` awaits it. Settle it as
      // "undecodable" (the preview is not what these tests are about).
      vi.stubGlobal(
        'Image',
        class {
          public onload: (() => void) | null = null;
          public onerror: (() => void) | null = null;
          public naturalWidth = 0;
          public naturalHeight = 0;
          public width = 0;
          public height = 0;
          set src(_value: string) {
            queueMicrotask(() => this.onerror?.());
          }
        }
      );

      vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
        const key = await blob.text();
        const raster = rasters[key];
        if (!raster) {
          throw new Error(`no raster stubbed for ${key}`);
        }
        return { width: raster.width, height: raster.height, raster, close: () => undefined };
      });

      const realCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(
        (tagName: string, options?: unknown) => {
          if (tagName !== 'canvas') {
            return realCreateElement(tagName, options as ElementCreationOptions | undefined);
          }
          let drawn: FakeRaster | null = null;
          const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({
              imageSmoothingEnabled: false,
              imageSmoothingQuality: 'low',
              drawImage: (bitmap: { raster?: FakeRaster }) => {
                drawn = bitmap.raster ?? null;
              },
              getImageData: (_x: number, _y: number, width: number, height: number) => {
                const data = new Uint8ClampedArray(width * height * 4);
                const raster: FakeRaster | null = drawn;
                const box = raster?.opaque ?? null;
                if (box) {
                  for (let y = box.y; y < box.y + box.height; y += 1) {
                    for (let x = box.x; x < box.x + box.width; x += 1) {
                      data[(y * width + x) * 4 + 3] = 255;
                    }
                  }
                }
                return { data };
              },
            }),
            toBlob: (callback: (blob: Blob | null) => void) =>
              callback(new Blob(['trimmed'], { type: 'image/png' })),
          };
          return canvas as unknown as HTMLElement;
        }
      );
    }

    function createTrimmableFrame(
      texturePath: string,
      sourceSize?: { width: number; height: number }
    ) {
      return {
        ...createFrame(texturePath, { x: 0.4, y: 0.25 }),
        ...(sourceSize ? { sourceSize } : {}),
      };
    }

    function seedTrimDocument(
      controller: AnimationDocumentController,
      frames: ReturnType<typeof createTrimmableFrame>[]
    ) {
      const resource: AnimationResource = {
        version: '1.0.0',
        texturePath: '',
        clips: [{ name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames }],
      };
      return seedDocument(controller, resource, {
        animationId: ANIMATION_ID,
        assetPath: ASSET_PATH,
        activeClipName: 'idle',
      });
    }

    /** Frame blobs are their own path, so `stubRasters` can identify them. */
    function readBlobByPath(): ReturnType<typeof vi.fn> {
      return vi.fn(async (texturePath: string) => new Blob([texturePath], { type: 'image/png' }));
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('trims the whole clip in ONE undo step and moves each anchor so the content stays put', async () => {
      stubRasters({
        'res://sprites/walk/idle_0001.png': {
          width: 100,
          height: 80,
          opaque: { x: 20, y: 10, width: 40, height: 30 },
        },
        'res://sprites/walk/idle_0002.png': {
          width: 100,
          height: 80,
          opaque: { x: 20, y: 10, width: 40, height: 30 },
        },
      });
      const { deps, invokeAndPush, writeBinaryFile, evictTexture } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedTrimDocument(controller, [
        createTrimmableFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
        createTrimmableFrame('res://sprites/walk/idle_0002.png', { width: 100, height: 80 }),
      ]);

      const report = await controller.trimClipFrames();

      expect(report).toEqual({ trimmed: 2, skipped: 0, failed: 0 });
      // One clip update for the whole clip — not one per frame (§9.12.1).
      expect(invokeAndPush).toHaveBeenCalledOnce();

      const storageWrites = (
        deps.projectStorage.writeBinaryFile as unknown as ReturnType<typeof vi.fn>
      ).mock;
      expect(storageWrites.calls.map(call => call[0])).toEqual([
        'res://sprites/walk/idle_0003.png',
        'res://sprites/walk/idle_0004.png',
      ]);
      // Every file lands BEFORE the document swap, so a throw mid-way leaves the
      // document untouched rather than half-trimmed.
      for (const order of storageWrites.invocationCallOrder) {
        expect(order).toBeLessThan(invokeAndPush.mock.invocationCallOrder[0]);
      }
      expect(writeBinaryFile).not.toHaveBeenCalled();

      const frames = controller.resource?.clips[0]?.frames ?? [];
      expect(frames.map(frame => frame.texturePath)).toEqual([
        'res://sprites/walk/idle_0003.png',
        'res://sprites/walk/idle_0004.png',
      ]);
      for (const frame of frames) {
        // R1/§8.8 — the editor stamps the new raster size.
        expect(frame.sourceSize).toEqual({ width: 40, height: 30 });
        // a' = (a·W − cropX) / w: 0.4·100 = 40 px, minus the 20 px cut, over 40 px.
        expect(frame.anchor.x).toBeCloseTo(0.5, 6);
        // 0.25·80 = 20 px, minus the 10 px cut, over 30 px.
        expect(frame.anchor.y).toBeCloseTo(1 / 3, 6);
      }

      // One invalidation pass covering both the retired and the new files.
      expect(evictTexture).toHaveBeenCalledWith('res://sprites/walk/idle_0001.png');
      expect(evictTexture).toHaveBeenCalledWith('res://sprites/walk/idle_0004.png');
    });

    it('derives the crop origin from the padded output size, not from the raw bounds', async () => {
      // THE TRAP: with padding the content is CENTERED in a bigger canvas, so the
      // crop origin is `bounds − (output − bounds)/2`. Using `bounds.x` directly
      // would leave the anchor at 0.4545 instead of the 0.5 the content deserves.
      stubRasters({
        'res://sprites/walk/idle_0001.png': {
          width: 100,
          height: 80,
          opaque: { x: 20, y: 10, width: 40, height: 30 },
        },
      });
      const { deps } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedTrimDocument(controller, [
        createTrimmableFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
      ]);

      const report = await controller.trimClipFrames({ padding: 2 });

      expect(report.trimmed).toBe(1);
      const frame = controller.resource?.clips[0]?.frames[0];
      expect(frame?.sourceSize).toEqual({ width: 44, height: 34 });
      // Content sits 2 px in on every side, so its centre is still the canvas centre.
      expect(frame?.anchor.x).toBeCloseTo(0.5, 6);
      // Source y=20 maps to 20 − (10 − 2) = 12 of 34.
      expect(frame?.anchor.y).toBeCloseTo(12 / 34, 6);
    });

    it('skips UV-window, unmeasured, empty and already-tight frames without burning a file number', async () => {
      stubRasters({
        'res://sprites/walk/sheet.png': { width: 100, height: 80, opaque: null },
        'res://sprites/walk/idle_0002.png': { width: 100, height: 80, opaque: null },
        'res://sprites/walk/idle_0003.png': {
          width: 100,
          height: 80,
          opaque: { x: 0, y: 0, width: 100, height: 80 },
        },
        'res://sprites/walk/idle_0004.png': {
          width: 100,
          height: 80,
          opaque: { x: 25, y: 25, width: 10, height: 10 },
        },
      });
      const readBlob = readBlobByPath();
      const { deps, invokeAndPush } = createDeps({
        projectStorage: {
          readBlob,
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedTrimDocument(controller, [
        // 1. A UV window into the shared sheet — trimming it would cut every frame.
        {
          ...createTrimmableFrame(''),
          repeat: { x: 0.5, y: 1 },
          sourceSize: { width: 50, height: 80 },
        },
        // 2. Own file, but its raster size is not known yet (no stamp, nothing decoded).
        createTrimmableFrame('res://sprites/walk/idle_0002.png'),
        // 3. Fully opaque already — the bounds fill the raster. Its size comes from
        //    the decoded-texture cache below rather than a stamp, which is the other
        //    half of "this frame has been measured".
        createTrimmableFrame('res://sprites/walk/idle_0003.png'),
        // 4. The only frame with anything to cut.
        createTrimmableFrame('res://sprites/walk/idle_0004.png', { width: 100, height: 80 }),
      ]);
      internals._resource = {
        ...(internals._resource as AnimationResource),
        texturePath: 'res://sprites/walk/sheet.png',
      };
      // Arranging state the real code fills: in the app the timeline thumbnails
      // decode every frame into this cache. happy-dom decodes nothing, so frame 3
      // would otherwise look "not measured yet" and skip for the wrong reason.
      internals.textureDimensionsCache.set('res://sprites/walk/idle_0003.png', {
        width: 100,
        height: 80,
      });

      const report = await controller.trimClipFrames();

      expect(report).toEqual({ trimmed: 1, skipped: 3, failed: 0 });
      // Frame 2 is skipped before any read: its raster size is unknown, so there is
      // nothing to restamp its geometry against. (The sheet is read by the preview
      // loader, which is why this asserts on the frame files rather than the total.)
      expect(readBlob).not.toHaveBeenCalledWith('res://sprites/walk/idle_0002.png');
      expect(readBlob).toHaveBeenCalledWith('res://sprites/walk/idle_0003.png');
      expect(readBlob).toHaveBeenCalledWith('res://sprites/walk/idle_0004.png');
      // Highest existing number is 4, so the single trim takes 5 — the three skips
      // burnt no file numbers.
      const storageWrites = (
        deps.projectStorage.writeBinaryFile as unknown as ReturnType<typeof vi.fn>
      ).mock;
      expect(storageWrites.calls.map(call => call[0])).toEqual([
        'res://sprites/walk/idle_0005.png',
      ]);
      expect(invokeAndPush).toHaveBeenCalledOnce();

      const frames = controller.resource?.clips[0]?.frames ?? [];
      expect(frames[0]?.texturePath).toBe('');
      expect(frames[2]?.texturePath).toBe('res://sprites/walk/idle_0003.png');
      expect(frames[3]?.sourceSize).toEqual({ width: 10, height: 10 });
    });

    it('reports a frame whose file cannot be read as failed and still trims the rest', async () => {
      stubRasters({
        'res://sprites/walk/idle_0002.png': {
          width: 100,
          height: 80,
          opaque: { x: 10, y: 10, width: 20, height: 20 },
        },
      });
      const readBlob = vi.fn(async (texturePath: string) => {
        if (texturePath.endsWith('idle_0001.png')) {
          throw new Error('missing file');
        }
        return new Blob([texturePath], { type: 'image/png' });
      });
      const { deps, invokeAndPush } = createDeps({
        projectStorage: {
          readBlob,
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const controller = new AnimationDocumentController(deps, '');
      seedTrimDocument(controller, [
        createTrimmableFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
        createTrimmableFrame('res://sprites/walk/idle_0002.png', { width: 100, height: 80 }),
      ]);

      const report = await controller.trimClipFrames();

      expect(report).toEqual({ trimmed: 1, skipped: 0, failed: 1 });
      expect(invokeAndPush).toHaveBeenCalledOnce();
      const frames = controller.resource?.clips[0]?.frames ?? [];
      expect(frames[0]?.texturePath).toBe('res://sprites/walk/idle_0001.png');
      expect(frames[1]?.texturePath).toBe('res://sprites/walk/idle_0003.png');
    });
  });

  /**
   * §9.12.2 — the auto collision polygon. As in the trim suite, the REAL alpha
   * reader (`readAlphaMask`) and the REAL tracer run: only `createImageBitmap` and
   * the 2D canvas are stood up, over a synthetic alpha buffer happy-dom cannot
   * produce. What is asserted is the *contract*: the trace lands in the draft (so
   * the existing overlay previews it), nothing reaches the document until the
   * draft is committed, and then it is one clip update.
   */
  describe('traceSelectedFramePolygon (§9.12.2)', () => {
    const ASSET_PATH = 'res://sprites/walk/walk.pix3anim';
    const ANIMATION_ID = 'sprites-walk-walk';

    /** A frame raster described by a predicate over its pixels. */
    interface AlphaRaster {
      width: number;
      height: number;
      isOpaque: (x: number, y: number) => boolean;
    }

    /** `#` is opaque; every other character is transparent. */
    function rasterFromRows(rows: string[]): AlphaRaster {
      return {
        width: rows[0]?.length ?? 0,
        height: rows.length,
        isOpaque: (x, y) => rows[y]?.[x] === '#',
      };
    }

    /** A filled disc — an outline whose vertex count actually moves with tolerance. */
    function discRaster(size: number, radius: number): AlphaRaster {
      const center = size / 2;
      return {
        width: size,
        height: size,
        isOpaque: (x, y) => Math.hypot(x + 0.5 - center, y + 0.5 - center) <= radius,
      };
    }

    function stubAlphaRasters(rasters: Record<string, AlphaRaster>): {
      decodes: ReturnType<typeof vi.fn>;
    } {
      // `readBlob` resolves here, so the texture-preview loader reaches `new Image()`,
      // which happy-dom never settles. Settle it as "undecodable" (the preview is not
      // what this suite is about).
      vi.stubGlobal(
        'Image',
        class {
          public onload: (() => void) | null = null;
          public onerror: (() => void) | null = null;
          public naturalWidth = 0;
          public naturalHeight = 0;
          public width = 0;
          public height = 0;
          set src(_value: string) {
            queueMicrotask(() => this.onerror?.());
          }
        }
      );

      const decodes = vi.fn();
      vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
        const key = await blob.text();
        const raster = rasters[key];
        if (!raster) {
          throw new Error(`no raster stubbed for ${key}`);
        }
        decodes(key);
        return { width: raster.width, height: raster.height, raster, close: () => undefined };
      });

      const realCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(
        (tagName: string, options?: unknown) => {
          if (tagName !== 'canvas') {
            return realCreateElement(tagName, options as ElementCreationOptions | undefined);
          }
          let drawn: AlphaRaster | null = null;
          const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({
              imageSmoothingEnabled: false,
              imageSmoothingQuality: 'low',
              drawImage: (bitmap: { raster?: AlphaRaster }) => {
                drawn = bitmap.raster ?? null;
              },
              getImageData: (_x: number, _y: number, width: number, height: number) => {
                const data = new Uint8ClampedArray(width * height * 4);
                const raster: AlphaRaster | null = drawn;
                if (raster) {
                  for (let y = 0; y < height; y += 1) {
                    for (let x = 0; x < width; x += 1) {
                      data[(y * width + x) * 4 + 3] = raster.isOpaque(x, y) ? 255 : 0;
                    }
                  }
                }
                return { data };
              },
            }),
            toBlob: (callback: (blob: Blob | null) => void) =>
              callback(new Blob(['baked'], { type: 'image/png' })),
          };
          return canvas as unknown as HTMLElement;
        }
      );
      return { decodes };
    }

    /** Frame blobs are their own path, so the bitmap stub can identify them. */
    function readBlobByPath(): ReturnType<typeof vi.fn> {
      return vi.fn(async (texturePath: string) => new Blob([texturePath], { type: 'image/png' }));
    }

    function seedPolygonDocument(
      controller: AnimationDocumentController,
      frames: AnimationResource['clips'][number]['frames']
    ): ControllerInternals {
      const resource: AnimationResource = {
        version: '1.0.0',
        texturePath: 'res://sprites/walk/sheet.png',
        clips: [{ name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames }],
      };
      const internals = seedDocument(controller, resource, {
        animationId: ANIMATION_ID,
        assetPath: ASSET_PATH,
        activeClipName: 'idle',
      });
      internals._selectedFrameIndex = 0;
      internals._selectedFrameIndices = [0];
      return internals;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('drops a trace whose frame stopped being the selected one mid-decode', async () => {
      stubAlphaRasters({
        'res://sprites/walk/idle_0001.png': rasterFromRows([
          '........',
          '..####..',
          '..####..',
          '........',
        ]),
      });
      let releaseFirstRead: () => void = () => undefined;
      const firstRead = new Promise<void>(resolve => {
        releaseFirstRead = resolve;
      });
      const readBlob = vi.fn(async (texturePath: string) => {
        if (texturePath.endsWith('idle_0001.png')) {
          await firstRead;
        }
        return new Blob([texturePath], { type: 'image/png' });
      });
      const { deps } = createDeps({
        projectStorage: {
          readBlob,
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedPolygonDocument(controller, [
        createFrame('res://sprites/walk/idle_0001.png'),
        createFrame('res://sprites/walk/idle_0002.png'),
      ]);

      const pending = controller.traceSelectedFramePolygon({ tolerance: 1 });
      // The timeline stays clickable while the first decode of a frame runs.
      internals._selectedFrameIndex = 1;
      internals._selectedFrameIndices = [1];
      releaseFirstRead();

      // Without the guard this outline would land in a draft cloned from frame 2.
      await expect(pending).resolves.toEqual({ status: 'stale', vertexCount: 0 });
      expect(controller.frameDraft).toBeNull();
    });

    it('traces into the frame DRAFT and writes nothing until the draft is committed', async () => {
      stubAlphaRasters({
        'res://sprites/walk/idle_0001.png': rasterFromRows([
          '........',
          '..####..',
          '..####..',
          '..####..',
          '........',
        ]),
      });
      const { deps, invokeAndPush } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedPolygonDocument(controller, [createFrame('res://sprites/walk/idle_0001.png')]);

      const report = await controller.traceSelectedFramePolygon({ tolerance: 1 });

      expect(report).toEqual({ status: 'traced', vertexCount: 4 });
      // The preview *is* the editable overlay: the polygon sits in the draft, in
      // absolute frame pixels, and the document has not been touched.
      expect(controller.frameDraft?.collisionPolygon).toEqual([
        { x: 6, y: 1 },
        { x: 6, y: 4 },
        { x: 2, y: 4 },
        { x: 2, y: 1 },
      ]);
      expect(invokeAndPush).not.toHaveBeenCalled();
      expect(controller.resource?.clips[0]?.frames[0]?.collisionPolygon).toEqual([]);

      await controller.commitFrameDraft('Auto collision polygon: idle');

      // ...and the commit is ONE clip update.
      expect(invokeAndPush).toHaveBeenCalledOnce();
      expect(controller.frameDraft).toBeNull();
      expect(controller.resource?.clips[0]?.frames[0]?.collisionPolygon).toEqual([
        { x: 6, y: 1 },
        { x: 6, y: 4 },
        { x: 2, y: 4 },
        { x: 2, y: 1 },
      ]);
    });

    it('decodes the texture once across re-traces, and a coarser tolerance yields fewer vertices', async () => {
      const { decodes } = stubAlphaRasters({
        'res://sprites/walk/idle_0001.png': discRaster(48, 20),
      });
      const readBlob = readBlobByPath();
      const { deps } = createDeps({
        projectStorage: {
          readBlob,
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedPolygonDocument(controller, [createFrame('res://sprites/walk/idle_0001.png')]);

      const fine = await controller.traceSelectedFramePolygon({ tolerance: 0.5 });
      const coarse = await controller.traceSelectedFramePolygon({ tolerance: 4 });

      expect(fine.status).toBe('traced');
      expect(coarse.vertexCount).toBeLessThan(fine.vertexCount);
      expect(coarse.vertexCount).toBeGreaterThanOrEqual(3);
      expect(controller.frameDraft?.collisionPolygon).toHaveLength(coarse.vertexCount);
      // The mask cache: dragging the tolerance slider must not re-decode the PNG
      // on every release. (`readBlob` is shared with the texture-preview loader, so
      // the decode count is the honest signal here.)
      expect(decodes).toHaveBeenCalledTimes(1);
      expect(decodes).toHaveBeenCalledWith('res://sprites/walk/idle_0001.png');

      // ...and invalidating the file drops the cached mask with everything else.
      controller.invalidateTexture('res://sprites/walk/idle_0001.png');
      await controller.traceSelectedFramePolygon({ tolerance: 4 });
      expect(decodes).toHaveBeenCalledTimes(2);
    });

    it('refuses a UV-window frame, whose file is the whole spritesheet', async () => {
      stubAlphaRasters({
        'res://sprites/walk/sheet.png': rasterFromRows(['####', '####']),
      });
      const { deps } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      const windowFrame = { ...createFrame(''), repeat: { x: 0.25, y: 1 } };
      seedPolygonDocument(controller, [windowFrame]);

      const report = await controller.traceSelectedFramePolygon();

      expect(report).toEqual({ status: 'no-frame', vertexCount: 0 });
      expect(controller.frameDraft).toBeNull();
    });

    it('reports an empty frame instead of clearing the polygon it already has', async () => {
      stubAlphaRasters({
        'res://sprites/walk/idle_0001.png': rasterFromRows(['....', '....']),
      });
      const { deps, invokeAndPush } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedPolygonDocument(controller, [
        {
          ...createFrame('res://sprites/walk/idle_0001.png'),
          collisionPolygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 2 },
          ],
        },
      ]);

      const report = await controller.traceSelectedFramePolygon();

      expect(report).toEqual({ status: 'empty', vertexCount: 0 });
      expect(controller.frameDraft).toBeNull();
      expect(invokeAndPush).not.toHaveBeenCalled();
      expect(controller.resource?.clips[0]?.frames[0]?.collisionPolygon).toHaveLength(3);
    });
  });

  /**
   * §9.12.4. Two shapes to hold apart: the parity delete touches no file at all
   * and is one plain clip update, while the raster map follows §9.12.1's batching
   * exactly — every file written first, then ONE clip update, then ONE
   * invalidation pass. The real `flipImageBlob` / `chromaKeyImage` run over a
   * synthetic raster; only `createImageBitmap` and the 2D canvas are stood up.
   */
  describe('bulk frame ops (§9.12.4)', () => {
    const ASSET_PATH = 'res://sprites/walk/walk.pix3anim';
    const ANIMATION_ID = 'sprites-walk-walk';

    interface BulkRaster {
      width: number;
      height: number;
      /** Uniform grey the whole raster is filled with (chroma-key input). */
      grey: number;
    }

    function stubBulkRasters(rasters: Record<string, BulkRaster>): void {
      // `readBlob` resolves here, so the texture-preview loader reaches
      // `new Image()`, which happy-dom never settles. Settle it as undecodable.
      vi.stubGlobal(
        'Image',
        class {
          public onload: (() => void) | null = null;
          public onerror: (() => void) | null = null;
          public naturalWidth = 0;
          public naturalHeight = 0;
          public width = 0;
          public height = 0;
          set src(_value: string) {
            queueMicrotask(() => this.onerror?.());
          }
        }
      );

      vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
        const key = await blob.text();
        const raster = rasters[key];
        if (!raster) {
          throw new Error(`no raster stubbed for ${key}`);
        }
        return { width: raster.width, height: raster.height, raster, close: () => undefined };
      });

      const realCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(
        (tagName: string, options?: unknown) => {
          if (tagName !== 'canvas') {
            return realCreateElement(tagName, options as ElementCreationOptions | undefined);
          }
          let drawn: BulkRaster | null = null;
          const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({
              imageSmoothingEnabled: false,
              imageSmoothingQuality: 'low',
              translate: () => undefined,
              scale: () => undefined,
              rotate: () => undefined,
              drawImage: (bitmap: { raster?: BulkRaster }) => {
                drawn = bitmap.raster ?? null;
              },
              getImageData: (_x: number, _y: number, width: number, height: number) => {
                const data = new Uint8ClampedArray(width * height * 4);
                const raster: BulkRaster | null = drawn;
                for (let index = 0; index < width * height; index += 1) {
                  data[index * 4] = raster?.grey ?? 0;
                  data[index * 4 + 1] = raster?.grey ?? 0;
                  data[index * 4 + 2] = raster?.grey ?? 0;
                  data[index * 4 + 3] = 255;
                }
                return { data, width, height };
              },
              putImageData: () => undefined,
            }),
            toBlob: (callback: (blob: Blob | null) => void) =>
              callback(new Blob(['baked'], { type: 'image/png' })),
          };
          return canvas as unknown as HTMLElement;
        }
      );
    }

    /** Frame blobs are their own path, so the bitmap stub can identify them. */
    function readBlobByPath(): ReturnType<typeof vi.fn> {
      return vi.fn(async (texturePath: string) => new Blob([texturePath], { type: 'image/png' }));
    }

    function bulkFrame(texturePath: string, sourceSize?: { width: number; height: number }) {
      return {
        ...createFrame(texturePath, { x: 0.4, y: 0.25 }),
        ...(sourceSize ? { sourceSize } : {}),
      };
    }

    function seedBulkDocument(
      controller: AnimationDocumentController,
      frames: ReturnType<typeof bulkFrame>[]
    ): ControllerInternals {
      const resource: AnimationResource = {
        version: '1.0.0',
        texturePath: '',
        clips: [{ name: 'idle', fps: 12, loop: true, playbackMode: 'normal', frames }],
      };
      return seedDocument(controller, resource, {
        animationId: ANIMATION_ID,
        assetPath: ASSET_PATH,
        activeClipName: 'idle',
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('drops every even frame in one clip update and writes no files', async () => {
      const { deps, invokeAndPush, writeBinaryFile } = createDeps();
      const controller = new AnimationDocumentController(deps, '');
      seedBulkDocument(
        controller,
        [1, 2, 3, 4, 5].map(number =>
          bulkFrame(`res://sprites/walk/idle_000${number}.png`, { width: 100, height: 80 })
        )
      );

      const report = await controller.deleteFramesByParity('even');

      // "Even" is the number the timeline shows, so frames 2 and 4 go.
      expect(report).toEqual({ processed: 2, skipped: 0, failed: 0 });
      expect(invokeAndPush).toHaveBeenCalledOnce();
      expect(writeBinaryFile).not.toHaveBeenCalled();
      expect(controller.resource?.clips[0]?.frames.map(frame => frame.texturePath)).toEqual([
        'res://sprites/walk/idle_0001.png',
        'res://sprites/walk/idle_0003.png',
        'res://sprites/walk/idle_0005.png',
      ]);
    });

    it('drops the odd frames instead when asked, and refuses UV-window frames', async () => {
      const { deps } = createDeps();
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedBulkDocument(controller, [
        // Frame 1 (odd) is a window into the shared sheet — halving *those* is a
        // slicing decision, so it is reported as a skip, not removed.
        { ...bulkFrame(''), repeat: { x: 0.5, y: 1 } },
        bulkFrame('res://sprites/walk/idle_0002.png'),
        bulkFrame('res://sprites/walk/idle_0003.png'),
      ]);
      internals._resource = {
        ...(internals._resource as AnimationResource),
        texturePath: 'res://sprites/walk/sheet.png',
      };

      const report = await controller.deleteFramesByParity('odd');

      expect(report).toEqual({ processed: 1, skipped: 1, failed: 0 });
      expect(controller.resource?.clips[0]?.frames.map(frame => frame.texturePath)).toEqual([
        '',
        'res://sprites/walk/idle_0002.png',
      ]);
    });

    it('maps a flip over the whole clip: all files first, ONE update, ONE invalidation', async () => {
      stubBulkRasters({
        'res://sprites/walk/idle_0001.png': { width: 100, height: 80, grey: 0 },
        'res://sprites/walk/idle_0002.png': { width: 100, height: 80, grey: 0 },
      });
      const { deps, invokeAndPush, evictTexture, invalidateTexture } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedBulkDocument(controller, [
        bulkFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
        bulkFrame('res://sprites/walk/idle_0002.png', { width: 100, height: 80 }),
      ]);

      const report = await controller.applyRasterOpToClipFrames({
        kind: 'flip',
        axis: 'horizontal',
      });

      expect(report).toEqual({ processed: 2, skipped: 0, failed: 0 });
      expect(invokeAndPush).toHaveBeenCalledOnce();

      const storageWrites = (
        deps.projectStorage.writeBinaryFile as unknown as ReturnType<typeof vi.fn>
      ).mock;
      expect(storageWrites.calls.map(call => call[0])).toEqual([
        'res://sprites/walk/idle_0003.png',
        'res://sprites/walk/idle_0004.png',
      ]);
      // Every file lands BEFORE the document swap (§9.12.1's shape), so a throw
      // mid-way leaves the document untouched rather than half-flipped.
      for (const order of storageWrites.invocationCallOrder) {
        expect(order).toBeLessThan(invokeAndPush.mock.invocationCallOrder[0]);
      }

      const frames = controller.resource?.clips[0]?.frames ?? [];
      expect(frames.map(frame => frame.texturePath)).toEqual([
        'res://sprites/walk/idle_0003.png',
        'res://sprites/walk/idle_0004.png',
      ]);
      for (const frame of frames) {
        // A mirror is not a resize: same box, mirrored anchor (0.4 → 0.6).
        expect(frame.sourceSize).toEqual({ width: 100, height: 80 });
        expect(frame.anchor.x).toBeCloseTo(0.6, 6);
        expect(frame.anchor.y).toBeCloseTo(0.25, 6);
      }

      // One invalidation pass covering both the retired and the new files.
      expect(evictTexture).toHaveBeenCalledWith('res://sprites/walk/idle_0001.png');
      expect(evictTexture).toHaveBeenCalledWith('res://sprites/walk/idle_0004.png');
      expect(invalidateTexture).toHaveBeenCalledWith('res://sprites/walk/idle_0004.png');
    });

    it('skips UV-window and unmeasured frames without burning a file number', async () => {
      stubBulkRasters({
        'res://sprites/walk/idle_0003.png': { width: 100, height: 80, grey: 0 },
      });
      const readBlob = readBlobByPath();
      const { deps } = createDeps({
        projectStorage: {
          readBlob,
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      const internals = seedBulkDocument(controller, [
        { ...bulkFrame(''), repeat: { x: 0.5, y: 1 }, sourceSize: { width: 50, height: 80 } },
        // Own file, but its raster size is not known — nothing to restamp against.
        bulkFrame('res://sprites/walk/idle_0002.png'),
        bulkFrame('res://sprites/walk/idle_0003.png', { width: 100, height: 80 }),
      ]);
      internals._resource = {
        ...(internals._resource as AnimationResource),
        texturePath: 'res://sprites/walk/sheet.png',
      };

      const report = await controller.applyRasterOpToClipFrames({
        kind: 'flip',
        axis: 'vertical',
      });

      expect(report).toEqual({ processed: 1, skipped: 2, failed: 0 });
      expect(readBlob).not.toHaveBeenCalledWith('res://sprites/walk/idle_0002.png');
      // Highest existing number is 3, so the single write takes 4.
      const storageWrites = (
        deps.projectStorage.writeBinaryFile as unknown as ReturnType<typeof vi.fn>
      ).mock;
      expect(storageWrites.calls.map(call => call[0])).toEqual([
        'res://sprites/walk/idle_0004.png',
      ]);
    });

    it('composes with the chroma key: same size, identity restamp', async () => {
      stubBulkRasters({
        'res://sprites/walk/idle_0001.png': { width: 100, height: 80, grey: 12 },
      });
      const { deps, invokeAndPush } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedBulkDocument(controller, [
        bulkFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
      ]);

      const report = await controller.applyRasterOpToClipFrames({
        kind: 'chroma-key',
        color: { r: 12, g: 12, b: 12 },
        tolerance: 0.05,
      });

      expect(report).toEqual({ processed: 1, skipped: 0, failed: 0 });
      expect(invokeAndPush).toHaveBeenCalledOnce();
      const frame = controller.resource?.clips[0]?.frames[0];
      expect(frame?.texturePath).toBe('res://sprites/walk/idle_0002.png');
      // Only alpha changed, so nothing about the frame's geometry may move.
      expect(frame?.sourceSize).toEqual({ width: 100, height: 80 });
      expect(frame?.anchor).toEqual({ x: 0.4, y: 0.25 });
    });

    it('reports a frame whose file cannot be read as failed and still maps the rest', async () => {
      stubBulkRasters({
        'res://sprites/walk/idle_0002.png': { width: 100, height: 80, grey: 0 },
      });
      const readBlob = vi.fn(async (texturePath: string) => {
        if (texturePath.endsWith('idle_0001.png')) {
          throw new Error('missing file');
        }
        return new Blob([texturePath], { type: 'image/png' });
      });
      const { deps, invokeAndPush } = createDeps({
        projectStorage: {
          readBlob,
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const controller = new AnimationDocumentController(deps, '');
      seedBulkDocument(controller, [
        bulkFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
        bulkFrame('res://sprites/walk/idle_0002.png', { width: 100, height: 80 }),
      ]);

      const report = await controller.applyRasterOpToClipFrames({
        kind: 'rotate',
        quarterTurns: 1,
      });

      expect(report).toEqual({ processed: 1, skipped: 0, failed: 1 });
      expect(invokeAndPush).toHaveBeenCalledOnce();
      const frames = controller.resource?.clips[0]?.frames ?? [];
      expect(frames[0]?.texturePath).toBe('res://sprites/walk/idle_0001.png');
      expect(frames[1]?.texturePath).toBe('res://sprites/walk/idle_0003.png');
      // A quarter-turn swaps the box: 100×80 becomes 80×100.
      expect(frames[1]?.sourceSize).toEqual({ width: 80, height: 100 });
    });

    it('leaves a frame the key colour never touches alone, and says it skipped it', async () => {
      stubBulkRasters({
        'res://sprites/walk/idle_0001.png': { width: 100, height: 80, grey: 12 },
        // Nowhere near the key: this frame comes back byte-identical.
        'res://sprites/walk/idle_0002.png': { width: 100, height: 80, grey: 200 },
      });
      const { deps, invokeAndPush } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedBulkDocument(controller, [
        bulkFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
        bulkFrame('res://sprites/walk/idle_0002.png', { width: 100, height: 80 }),
      ]);

      const report = await controller.applyRasterOpToClipFrames({
        kind: 'chroma-key',
        color: { r: 12, g: 12, b: 12 },
        tolerance: 0.05,
      });

      // §9.12.1's "already tight" skip, one op over: rewriting the second frame
      // would burn a file number and claim work that never happened.
      expect(report).toEqual({ processed: 1, skipped: 1, failed: 0 });
      expect(invokeAndPush).toHaveBeenCalledOnce();
      const storageWrites = (
        deps.projectStorage.writeBinaryFile as unknown as ReturnType<typeof vi.fn>
      ).mock;
      expect(storageWrites.calls.map(call => call[0])).toEqual([
        'res://sprites/walk/idle_0003.png',
      ]);
      expect(controller.resource?.clips[0]?.frames.map(frame => frame.texturePath)).toEqual([
        'res://sprites/walk/idle_0003.png',
        'res://sprites/walk/idle_0002.png',
      ]);
    });

    it('never hands a bake a file number an import already spent, even after an undo', async () => {
      stubBulkRasters({
        'res://sprites/walk/idle_0001.png': { width: 100, height: 80, grey: 0 },
      });
      const writeBinaryFile = vi.fn().mockResolvedValue(undefined);
      const { deps } = createDeps({
        projectStorage: {
          readBlob: readBlobByPath(),
          writeBinaryFile,
        } as unknown as AnimationDocumentControllerDeps['projectStorage'],
      });
      const controller = new AnimationDocumentController(deps, '');
      seedBulkDocument(controller, [
        bulkFrame('res://sprites/walk/idle_0001.png', { width: 100, height: 80 }),
      ]);

      // A video import (§9.12.5) lands as a run of files through this path.
      const imported = await controller.importOsFiles([
        new File(['a'], 'grab-1.png', { type: 'image/png' }),
        new File(['b'], 'grab-2.png', { type: 'image/png' }),
      ]);
      expect(imported).toEqual([
        'res://sprites/walk/idle_0002.png',
        'res://sprites/walk/idle_0003.png',
      ]);

      // Undo: the document never gained those frames, so nothing references
      // 0002/0003 any more — but a *redo* still points at those exact files.
      const report = await controller.applyRasterOpToClipFrames({
        kind: 'flip',
        axis: 'horizontal',
      });

      expect(report).toEqual({ processed: 1, skipped: 0, failed: 0 });
      expect(writeBinaryFile.mock.calls.map(call => call[0])).toEqual([
        'res://sprites/walk/idle_0002.png',
        'res://sprites/walk/idle_0003.png',
        // Not 0002 again: the bake counts past the imported run.
        'res://sprites/walk/idle_0004.png',
      ]);
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
