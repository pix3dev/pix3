import { render } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppState } from '@/state';
import type { AnimationFrame, AnimationResource } from '@pix3/runtime';

import {
  AnimationDocumentController,
  type AnimationDocumentControllerDeps,
} from './animation-document-controller';
import {
  FrameOverlayController,
  renderBboxOverlay,
  renderPointsOverlay,
  renderPolygonOverlay,
} from './frame-stage-overlays';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * The overlay controller is a pure pointer state machine over the document
 * controller's frame-draft API: nothing it does touches the DOM beyond pointer
 * capture, and every coordinate crossing its boundary is in frame-pixel space.
 * So the tests drive it with synthetic pointer events and a stub `toFramePoint`,
 * then assert on the frame the document ends up with.
 */
interface ControllerInternals {
  _assetPath: string | null;
  _resource: AnimationResource | null;
  _activeClipName: string;
  _selectedFrameIndex: number;
  _previewFrameIndex: number;
  animationId: string | null;
  textureDimensionsCache: Map<string, { width: number; height: number }>;
}

const FRAME_TEXTURE_PATH = 'res://frames/hero-0000.png';

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

/**
 * A document with one 3-frame clip. `textureDimensions` seeds the decoded-size
 * cache — leave it out to reproduce the pre-decode state where `getFrameMetrics`
 * still reports its 256px placeholder (§9.7 risk 2).
 */
function createDocument(
  options: {
    textureDimensions?: { width: number; height: number };
    points?: AnimationFrame['points'];
  } = {}
): AnimationDocumentController {
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
        frames: [
          {
            textureIndex: 0,
            offset: { x: 0, y: 0 },
            repeat: { x: 1, y: 1 },
            durationMultiplier: 1,
            anchor: { x: 0.5, y: 1 },
            texturePath: FRAME_TEXTURE_PATH,
            boundingBox: { x: 0, y: 0, width: 0, height: 0 },
            collisionPolygon: [],
            points: options.points,
          },
        ],
      },
    ],
  };

  const internals = controller as unknown as ControllerInternals;
  internals._assetPath = 'res://animations/hero/hero.pix3anim';
  internals.animationId = 'animations-hero';
  internals._resource = resource;
  internals._activeClipName = 'idle';
  internals._selectedFrameIndex = 0;
  internals._previewFrameIndex = 0;
  if (options.textureDimensions) {
    internals.textureDimensionsCache.set(FRAME_TEXTURE_PATH, options.textureDimensions);
  }

  return controller;
}

/**
 * Wires the overlay controller onto a document with a scripted stream of
 * frame-pixel points — one per pointer event, in order.
 */
function createOverlays(
  document: AnimationDocumentController,
  framePoints: { x: number; y: number }[]
) {
  let pointIndex = 0;
  const overlays = new FrameOverlayController({
    getDocument: () => document,
    toFramePoint: () => framePoints[Math.min(pointIndex++, framePoints.length - 1)] ?? null,
  });
  return overlays;
}

/** A pointer event stand-in: the state machine only reads ids and DOM attributes. */
function createPointerEvent(
  options: { pointerId?: number; attributes?: Record<string, string> } = {}
): PointerEvent {
  const target = {
    getAttribute: (name: string) => options.attributes?.[name] ?? null,
  };
  return {
    pointerId: options.pointerId ?? 1,
    target,
    currentTarget: null,
  } as unknown as PointerEvent;
}

function getStoredFrame(document: AnimationDocumentController): AnimationFrame {
  const frame = document.resource?.clips[0]?.frames[0];
  if (!frame) {
    throw new Error('The test document lost its frame');
  }
  return frame;
}

async function drag(
  overlays: FrameOverlayController,
  options: { attributes?: Record<string, string> } = {}
): Promise<void> {
  overlays.handlePointerDown(createPointerEvent(options));
  overlays.handlePointerMove(createPointerEvent(options));
  await overlays.handlePointerUp(createPointerEvent(options));
}

describe('FrameOverlayController', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    resetAppState();
    vi.restoreAllMocks();
  });

  it('turns an anchor drag into a normalized anchor', async () => {
    const document = createDocument({ textureDimensions: { width: 64, height: 32 } });
    const overlays = createOverlays(document, [
      { x: 10, y: 4 },
      { x: 16, y: 8 },
    ]);
    overlays.setEditMode('anchor');

    await drag(overlays);

    expect(getStoredFrame(document).anchor).toEqual({ x: 0.25, y: 0.25 });
  });

  it('turns a bbox drag into the rectangle spanned by its two corners', async () => {
    const document = createDocument({ textureDimensions: { width: 64, height: 32 } });
    // Dragged up and to the left, so the rectangle has to be normalized.
    const overlays = createOverlays(document, [
      { x: 40, y: 24 },
      { x: 12, y: 6 },
    ]);
    overlays.setEditMode('bbox');

    await drag(overlays);

    expect(getStoredFrame(document).boundingBox).toEqual({ x: 12, y: 6, width: 28, height: 18 });
  });

  it('appends a polygon vertex on empty stage and drags it, in absolute frame pixels', async () => {
    const document = createDocument({ textureDimensions: { width: 64, height: 32 } });
    const overlays = createOverlays(document, [
      { x: 8, y: 8 },
      { x: 20, y: 14 },
    ]);
    overlays.setEditMode('polygon');

    await drag(overlays);

    expect(getStoredFrame(document).collisionPolygon).toEqual([{ x: 20, y: 14 }]);
  });

  it('moves an existing polygon vertex instead of appending when one is grabbed', async () => {
    const document = createDocument({ textureDimensions: { width: 64, height: 32 } });
    const overlays = createOverlays(document, [
      { x: 8, y: 8 },
      { x: 20, y: 14 },
      { x: 30, y: 4 },
      { x: 2, y: 2 },
    ]);
    overlays.setEditMode('polygon');

    await drag(overlays);
    // The vertex handle carries its index; grabbing it must not grow the polygon.
    await drag(overlays, { attributes: { 'data-vertex-index': '0' } });

    expect(getStoredFrame(document).collisionPolygon).toEqual([{ x: 2, y: 2 }]);
  });

  it('drags a named point by name and its handle by angle', async () => {
    const document = createDocument({
      textureDimensions: { width: 100, height: 100 },
      points: [{ name: 'muzzle', x: 0.5, y: 0.5, angle: 0 }],
    });
    const overlays = createOverlays(document, [
      { x: 50, y: 50 },
      { x: 20, y: 80 },
      { x: 20, y: 80 },
      // Straight up from the point it was just moved to: -90 degrees, y down.
      { x: 20, y: 40 },
    ]);
    overlays.setEditMode('points');

    await drag(overlays, { attributes: { 'data-point-name': 'muzzle' } });
    // `normalizeAnimationResource` drops a zero angle again on the way back in.
    expect(getStoredFrame(document).points).toEqual([{ name: 'muzzle', x: 0.2, y: 0.8 }]);
    expect(overlays.selectedPointName).toBe('muzzle');

    await drag(overlays, { attributes: { 'data-point-angle': 'muzzle' } });
    expect(getStoredFrame(document).points).toEqual([
      { name: 'muzzle', x: 0.2, y: 0.8, angle: -90 },
    ]);
  });

  it('ignores a points-mode press that grabs nothing, leaving no draft behind', async () => {
    const document = createDocument({
      textureDimensions: { width: 100, height: 100 },
      points: [{ name: 'muzzle', x: 0.5, y: 0.5 }],
    });
    const overlays = createOverlays(document, [{ x: 10, y: 10 }]);
    overlays.setEditMode('points');

    overlays.handlePointerDown(createPointerEvent());

    expect(overlays.isDragging).toBe(false);
    expect(document.frameDraft).toBeNull();
  });

  it('clamps and snaps host coordinates to whole in-frame pixels', async () => {
    const document = createDocument({ textureDimensions: { width: 64, height: 32 } });
    const overlays = createOverlays(document, [
      { x: -12, y: -3 },
      { x: 999, y: 20.4 },
    ]);
    overlays.setEditMode('bbox');

    await drag(overlays);

    expect(getStoredFrame(document).boundingBox).toEqual({ x: 0, y: 0, width: 64, height: 20 });
  });

  it('drops an in-flight drag when the document reloads under it', () => {
    const document = createDocument({ textureDimensions: { width: 64, height: 32 } });
    const overlays = createOverlays(document, [{ x: 10, y: 10 }]);
    overlays.setEditMode('bbox');

    overlays.handlePointerDown(createPointerEvent());
    expect(overlays.isDragging).toBe(true);

    document.clearFrameDraft();
    overlays.handleDocumentChanged();

    expect(overlays.isDragging).toBe(false);
  });

  describe('before the frame texture has decoded (§9.7 risk 2)', () => {
    it('suppresses bbox, polygon and point editing', async () => {
      const document = createDocument();
      // The placeholder metrics the geometry would have been authored against.
      expect(document.getFrameMetrics(getStoredFrame(document))).toEqual({
        frameWidth: 256,
        frameHeight: 256,
      });
      expect(document.hasResolvedFrameMetrics(getStoredFrame(document))).toBe(false);

      for (const mode of ['bbox', 'polygon', 'points'] as const) {
        const overlays = createOverlays(document, [
          { x: 10, y: 10 },
          { x: 40, y: 40 },
        ]);
        overlays.setEditMode(mode);

        expect(overlays.canEdit(mode)).toBe(false);
        await drag(overlays, { attributes: { 'data-point-name': 'muzzle' } });

        expect(overlays.isDragging).toBe(false);
        expect(document.frameDraft).toBeNull();
      }

      const frame = getStoredFrame(document);
      expect(frame.boundingBox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
      expect(frame.collisionPolygon).toEqual([]);
    });

    it('still allows anchor editing, which is a ratio of the same box', async () => {
      const document = createDocument();
      const overlays = createOverlays(document, [
        { x: 64, y: 64 },
        { x: 128, y: 192 },
      ]);
      overlays.setEditMode('anchor');

      expect(overlays.canEdit('anchor')).toBe(true);
      await drag(overlays);

      expect(getStoredFrame(document).anchor).toEqual({ x: 0.5, y: 0.75 });
    });
  });

  /**
   * The overlays are child parts of the host's `<svg>`, so they must be authored
   * with lit's `svg` tag: an `html` template is parsed in the HTML namespace and
   * would yield unknown elements that draw nothing. That failure is invisible to
   * a "does the element exist" assertion, hence the namespace check.
   */
  describe('svg fragments', () => {
    it('renders bbox, polygon and point overlays into the SVG namespace', () => {
      // `render` is typed for HTML hosts; an `<svg>` root is exactly the point here.
      const host = window.document.createElementNS(SVG_NAMESPACE, 'svg') as unknown as HTMLElement;
      const frame: AnimationFrame = {
        textureIndex: 0,
        offset: { x: 0, y: 0 },
        repeat: { x: 1, y: 1 },
        durationMultiplier: 1,
        anchor: { x: 0.5, y: 1 },
        texturePath: FRAME_TEXTURE_PATH,
        boundingBox: { x: 1, y: 2, width: 8, height: 4 },
        collisionPolygon: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 4 },
        ],
        points: [{ name: 'muzzle', x: 0.5, y: 0.5, angle: 45 }],
      };

      render(
        [
          renderBboxOverlay(frame),
          renderPolygonOverlay(frame, { editable: true }),
          renderPointsOverlay({
            frame,
            previousFrame: null,
            metrics: { frameWidth: 32, frameHeight: 32 },
            editable: true,
            selectedPointName: 'muzzle',
          }),
        ],
        host
      );

      for (const selector of [
        '.stage-bbox',
        '.stage-polygon',
        '.stage-point',
        '.stage-point-angle',
      ]) {
        const element = host.querySelector(selector);
        expect(element, selector).not.toBeNull();
        expect(element?.namespaceURI, selector).toBe(SVG_NAMESPACE);
      }
      expect(host.querySelectorAll('.stage-polygon-vertex')).toHaveLength(3);
    });
  });
});
