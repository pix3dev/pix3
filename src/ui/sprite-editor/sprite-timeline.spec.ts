import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppState } from '@/state';
import type { GenerationRecord } from '@/services/image-gen/GenerationHistoryService';
import { FRAME_REORDER_MIME, GENERATION_DRAG_MIME } from '@/ui/shared/asset-drag-drop';
import type { AnimationFrame, AnimationResource } from '@pix3/runtime';

import {
  AnimationDocumentController,
  type AnimationDocumentControllerDeps,
} from './animation-document-controller';
import { getDroppedTextureResources, isPotentialTextureDrag } from './frame-texture-drop';
import { SpriteTimeline } from './sprite-timeline';

/**
 * The timeline takes a controller reference and emits no data events, so every
 * assertion below goes through controller state — exactly how the shell observes
 * it in the app.
 */
interface ControllerInternals {
  _assetPath: string | null;
  _resource: AnimationResource | null;
  _activeClipName: string;
  animationId: string | null;
}

function createDeps(): AnimationDocumentControllerDeps {
  return {
    operations: { invokeAndPush: vi.fn().mockResolvedValue(true) },
    commandDispatcher: { execute: vi.fn().mockResolvedValue(true) },
    // Reads never resolve to a decodable blob here: the texture-preview loader
    // swallows the failure, and no detached promise is left hanging.
    projectStorage: {
      readBlob: vi.fn().mockRejectedValue(new Error('no project storage in tests')),
      writeBinaryFile: vi.fn().mockResolvedValue(undefined),
    },
    animationEditorService: {
      getActiveController: vi.fn().mockReturnValue(null),
      setActiveController: vi.fn(),
    },
    autoSliceDialog: { showDialog: vi.fn().mockResolvedValue(null) },
    dialogService: { showConfirmation: vi.fn().mockResolvedValue(true) },
    sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map() }) },
  } as unknown as AnimationDocumentControllerDeps;
}

function createFrame(texturePath: string): AnimationFrame {
  return {
    textureIndex: 0,
    offset: { x: 0, y: 0 },
    repeat: { x: 1, y: 1 },
    durationMultiplier: 1,
    anchor: { x: 0.5, y: 1 },
    texturePath,
    boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    collisionPolygon: [],
  };
}

function createController(texturePaths = ['res://a.png', 'res://b.png', 'res://c.png']) {
  const controller = new AnimationDocumentController(createDeps(), '');
  const resource: AnimationResource = {
    version: '1.0.0',
    texturePath: '',
    clips: [
      {
        name: 'idle',
        fps: 12,
        loop: true,
        playbackMode: 'normal',
        frames: texturePaths.map(createFrame),
      },
    ],
  };

  const internals = controller as unknown as ControllerInternals;
  internals._assetPath = 'res://animations/walk/walk.pix3anim';
  internals.animationId = 'animations-walk';
  internals._resource = resource;
  internals._activeClipName = 'idle';
  return controller;
}

async function mountTimeline(controller: AnimationDocumentController): Promise<SpriteTimeline> {
  const timeline = new SpriteTimeline();
  timeline.controller = controller;
  document.body.appendChild(timeline);
  await timeline.updateComplete;
  return timeline;
}

function getFrameCards(timeline: SpriteTimeline): HTMLButtonElement[] {
  return Array.from(timeline.querySelectorAll<HTMLButtonElement>('.frame-card'));
}

/** A DataTransfer stand-in that remembers what was written, `types` included. */
function createDataTransfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    files: [] as unknown as FileList,
    get types(): string[] {
      return [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
  };
}

/** One stored generation, shaped as `GenerationHistoryService` hands it back. */
function createGenerationRecord(): GenerationRecord {
  return {
    id: 'rec-1',
    createdAt: 0,
    providerId: 'fake',
    modelId: 'fake-model',
    prompt: 'A brass gear',
    mimeType: 'image/png',
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    width: 64,
    height: 64,
  };
}

/**
 * Stand in for the injected `GenerationHistoryService`, which is IndexedDB-backed.
 * Only `get` is reached: the drag payload carries an id, and the timeline resolves
 * the pixels itself.
 */
function stubGenerationHistory(
  timeline: SpriteTimeline,
  record: GenerationRecord | undefined
): ReturnType<typeof vi.fn> {
  const get = vi.fn().mockResolvedValue(record);
  Object.defineProperty(timeline, 'generationHistory', { value: { get }, configurable: true });
  return get;
}

/** The controller's project-storage writer, so a real import can be observed. */
function getWriteBinaryFileStub(controller: AnimationDocumentController): ReturnType<typeof vi.fn> {
  const deps = (controller as unknown as { deps: AnimationDocumentControllerDeps }).deps;
  return deps.projectStorage.writeBinaryFile as unknown as ReturnType<typeof vi.fn>;
}

function dispatchDragEvent(
  target: HTMLElement,
  type: string,
  dataTransfer: ReturnType<typeof createDataTransfer>
): void {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    dataTransfer,
  });
  target.dispatchEvent(event);
}

describe('SpriteTimeline', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders one frame card per frame of the active clip', async () => {
    const controller = createController();
    const timeline = await mountTimeline(controller);

    expect(getFrameCards(timeline)).toHaveLength(3);
    expect(timeline.querySelector('.timeline-transport')).not.toBeNull();
  });

  it('renders the empty state for a clip without frames', async () => {
    const controller = createController([]);
    const timeline = await mountTimeline(controller);

    expect(getFrameCards(timeline)).toHaveLength(0);
    expect(timeline.textContent).toContain('This clip has no frames yet');
  });

  it('selects a frame through the controller when its card is clicked', async () => {
    const controller = createController();
    const timeline = await mountTimeline(controller);

    getFrameCards(timeline)[1].click();
    await timeline.updateComplete;

    expect(controller.selectedFrameIndex).toBe(1);
    expect(controller.selectedFrameIndices).toEqual([1]);
    expect(getFrameCards(timeline)[1].classList.contains('is-selected')).toBe(true);
  });

  it('extends the selection with ctrl-click and shift-click', async () => {
    const controller = createController();
    const timeline = await mountTimeline(controller);

    getFrameCards(timeline)[0].click();
    getFrameCards(timeline)[2].dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true })
    );
    expect(controller.selectedFrameIndices).toEqual([0, 2]);

    getFrameCards(timeline)[0].click();
    getFrameCards(timeline)[2].dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true })
    );
    expect(controller.selectedFrameIndices).toEqual([0, 1, 2]);
  });

  it('reorders through the controller when a card is dropped on another card', async () => {
    const controller = createController();
    const reorderFrame = vi.spyOn(controller, 'reorderFrame');
    const timeline = await mountTimeline(controller);
    const cards = getFrameCards(timeline);
    const dataTransfer = createDataTransfer();

    dispatchDragEvent(cards[0], 'dragstart', dataTransfer);
    expect(dataTransfer.getData(FRAME_REORDER_MIME)).toBe('0');

    dispatchDragEvent(cards[2], 'drop', dataTransfer);

    await vi.waitFor(() => {
      expect(reorderFrame).toHaveBeenCalledWith(0, 2);
    });
    expect(controller.resource?.clips[0]?.frames.map(frame => frame.texturePath)).toEqual([
      'res://b.png',
      'res://c.png',
      'res://a.png',
    ]);
  });

  it('collapses the selection onto the dragged card and hides it from texture-drop targets', async () => {
    const controller = createController();
    const timeline = await mountTimeline(controller);
    const dataTransfer = createDataTransfer();

    dispatchDragEvent(getFrameCards(timeline)[1], 'dragstart', dataTransfer);

    expect(controller.selectedFrameIndices).toEqual([1]);
    // The editor shell around the strip reads the very same predicate to decide
    // whether to raise its "drop image to add frames" overlay (§9.7 risk 3).
    expect(isPotentialTextureDrag(dataTransfer as unknown as DataTransfer)).toBe(false);
  });

  it('inserts dropped asset textures before the card they landed on', async () => {
    const controller = createController();
    const addFrameTextures = vi
      .spyOn(controller, 'addFrameTextures')
      .mockResolvedValue(undefined as void);
    const timeline = await mountTimeline(controller);
    const dataTransfer = createDataTransfer({
      'application/x-pix3-asset-resource': 'res://textures/player.png',
    });

    dispatchDragEvent(getFrameCards(timeline)[1], 'drop', dataTransfer);

    await vi.waitFor(() => {
      expect(addFrameTextures).toHaveBeenCalledWith(['res://textures/player.png'], 1);
    });
  });

  it('imports a generation dragged out of the Generate panel as a frame (P5b)', async () => {
    const controller = createController();
    const writeBinaryFile = getWriteBinaryFileStub(controller);
    const timeline = await mountTimeline(controller);
    const record = createGenerationRecord();
    const get = stubGenerationHistory(timeline, record);
    // Exactly what `setGenerationDragData` writes: the record id, plus the
    // suggested *file name* on text/plain — which must never be read as a path.
    const dataTransfer = createDataTransfer({
      [GENERATION_DRAG_MIME]: JSON.stringify({ id: 'rec-1', suggestedName: 'a-brass-gear.png' }),
      'text/plain': 'a-brass-gear.png',
    });

    dispatchDragEvent(getFrameCards(timeline)[1], 'drop', dataTransfer);

    await vi.waitFor(() => {
      expect(writeBinaryFile).toHaveBeenCalledTimes(1);
    });
    expect(get).toHaveBeenCalledWith('rec-1');
    // Shared with the OS-file import: the blob lands in the clip's own numbered
    // frame sequence, not under the dragged name.
    expect(writeBinaryFile.mock.calls[0][0]).toBe('res://animations/walk/idle_0001.png');
    await vi.waitFor(() => {
      expect(controller.resource?.clips[0]?.frames.map(frame => frame.texturePath)).toEqual([
        'res://a.png',
        'res://animations/walk/idle_0001.png',
        'res://b.png',
        'res://c.png',
      ]);
    });
  });

  it('inserts nothing when the dragged generation is gone from history', async () => {
    const controller = createController();
    const writeBinaryFile = getWriteBinaryFileStub(controller);
    const timeline = await mountTimeline(controller);
    // Deleted between dragstart and drop: the text/plain file name left behind
    // must not be turned into a `res://` frame that does not exist.
    const get = stubGenerationHistory(timeline, undefined);
    const dataTransfer = createDataTransfer({
      [GENERATION_DRAG_MIME]: JSON.stringify({ id: 'rec-1', suggestedName: 'a-brass-gear.png' }),
      'text/plain': 'a-brass-gear.png',
    });

    dispatchDragEvent(getFrameCards(timeline)[1], 'drop', dataTransfer);

    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledWith('rec-1');
    });
    await Promise.resolve();

    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(controller.resource?.clips[0]?.frames).toHaveLength(3);
  });

  it('treats a generation drag as a potential texture drop, not as a path', () => {
    // `dragover` can only see the MIME list, so the card's preventDefault — and
    // hence the drop event at all — hangs off this predicate.
    const idOnly = createDataTransfer({
      [GENERATION_DRAG_MIME]: JSON.stringify({ id: 'rec-1' }),
    });
    expect(isPotentialTextureDrag(idOnly as unknown as DataTransfer)).toBe(true);

    // The suggested file name rides along on text/plain and looks exactly like a
    // relative image path; reading it as one would invent a `res://` asset. The
    // shell around the strip shares this parser, so the guard lives there.
    const withSuggestedName = createDataTransfer({
      [GENERATION_DRAG_MIME]: JSON.stringify({ id: 'rec-1', suggestedName: 'a-brass-gear.png' }),
      'text/plain': 'a-brass-gear.png',
    });
    expect(getDroppedTextureResources(withSuggestedName as unknown as DataTransfer)).toEqual([]);
  });

  it('deletes a single frame from its card affordance', async () => {
    const controller = createController();
    const timeline = await mountTimeline(controller);

    timeline.querySelectorAll<HTMLElement>('.frame-delete-button')[1].click();

    await vi.waitFor(() => {
      expect(controller.resource?.clips[0]?.frames.map(frame => frame.texturePath)).toEqual([
        'res://a.png',
        'res://c.png',
      ]);
    });
  });

  it('drives playback state from the transport buttons', async () => {
    const controller = createController();
    const timeline = await mountTimeline(controller);
    const [play, stop] = Array.from(
      timeline.querySelectorAll<HTMLButtonElement>('.timeline-transport .editor-toolbar-button')
    );

    play.click();
    expect(controller.isPreviewPlaying).toBe(true);

    stop.click();
    expect(controller.isPreviewPlaying).toBe(false);
  });

  it('commits the scrubbed FPS once, on release rather than per preview step', async () => {
    const controller = createController();
    const updateClipFps = vi.spyOn(controller, 'updateClipFps').mockResolvedValue(undefined);
    const timeline = await mountTimeline(controller);
    const field = timeline.querySelector<HTMLElement>('.timeline-fps-input');

    expect(field?.tagName.toLowerCase()).toBe('pix3-number-field');

    // Scrubbing streams `preview-change`; each one would be its own undo entry
    // (`updateClipFps` → `applyResourceUpdate` → `invokeAndPush`), so only the
    // release must reach the controller.
    field?.dispatchEvent(
      new CustomEvent('preview-change', { detail: { value: 19 }, bubbles: true })
    );
    expect(updateClipFps).not.toHaveBeenCalled();

    field?.dispatchEvent(
      new CustomEvent('commit-change', { detail: { value: 24 }, bubbles: true })
    );
    expect(updateClipFps).toHaveBeenCalledExactlyOnceWith(24);
  });

  it('stops observing its controller once disconnected', async () => {
    const controller = createController();
    const unsubscribe = vi.fn();
    const subscribe = vi.spyOn(controller, 'subscribe').mockReturnValue(unsubscribe);
    const timeline = await mountTimeline(controller);

    expect(subscribe).toHaveBeenCalledOnce();

    timeline.remove();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
