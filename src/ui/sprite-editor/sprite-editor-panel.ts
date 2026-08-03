import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { createRef, ref } from 'lit/directives/ref.js';
import { DropdownPortal } from '@/ui/shared/dropdown-portal';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { AiImageSettingsService } from '@/services/image-gen/AiImageSettingsService';
import { ImageGenError } from '@/services/image-gen/ImageGenTypes';
import { GenerationHistoryService } from '@/services/image-gen/GenerationHistoryService';
import {
  ImageEditTargetService,
  type GeneratedImagePayload,
  type ImageEditTarget,
  type ImageEditTargetSnapshot,
} from '@/services/image-gen/ImageEditTargetService';
import {
  BackgroundRemovalService,
  type BgRemovalEngine,
  type BgRemovalProgress,
  type BgRemovalQuality,
} from '@/services/bg-removal/BackgroundRemovalService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { AnimationAutoSliceDialogService } from '@/services/animation/AnimationAutoSliceDialogService';
import { AnimationEditorService } from '@/services/animation/AnimationEditorService';
import { DialogService } from '@/services/editor/DialogService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { CreateAnimationAssetCommand } from '@/features/scene/CreateAnimationAssetCommand';
import { OpenGeneratePanelCommand } from '@/features/editor/OpenGeneratePanelCommand';
import {
  buildAnimationFrameResourcePath,
  buildManagedSpriteAssetPath,
  getAnimationAssetDirectory,
  deriveAnimationAssetStem,
} from '@/features/scene/animation-asset-utils';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import {
  AssetLoader,
  SceneManager,
  collectClipPointNames,
  findAnimationFramePoint,
  getAnimationFrameTexturePath,
  isSequenceAnimationFrame,
  normalizeAnimationResource,
  type AnimationFrame,
} from '@pix3/runtime';
import { toProjectResourcePath } from '@/ui/shared/asset-drag-drop';
import {
  StageZoomPanController,
  type StagePoint,
  type StageViewport,
} from '@/ui/shared/stage-zoom-pan';
import { AnimationDocumentController, type TrimClipReport } from './animation-document-controller';
import type { FrameRasterTransform } from './frame-restamp';
import {
  FrameOverlayController,
  renderAnchorOverlay,
  renderBboxOverlay,
  renderPointsOverlay,
  renderPolygonOverlay,
  type AnimationEditMode,
} from './frame-stage-overlays';
import {
  getDroppedImageFiles,
  getDroppedTextureResources,
  isPotentialTextureDrag,
} from './frame-texture-drop';
import { getGenerationDragData } from '@/ui/shared/asset-drag-drop';
import { getFrameImageStyle } from './sprite-timeline';
import './sprite-clips-rail';
import {
  applyCropDrag,
  clampToImage,
  cropRectToPixels,
  describeCropRect,
  initialCropRect,
  isApplicableCropRect,
  type CropDragState,
  type CropRect,
  type ImageSize,
} from './crop-geometry';
import {
  applyPlaceDrag,
  clampPlaceScale,
  describePlaceRect,
  isApplicablePlaceRect,
  quickFitRect,
  scalePlaceRect,
  type PlaceDragMode,
  type PlaceDragState,
  type PlaceQuickFit,
  type PlaceRect,
} from './place-geometry';
import {
  flipImageBlob,
  readBlobSize,
  resizeImageBlob,
  rotateImageBlob,
  scaledDimensions,
  sliceImageBlob,
  type FlipAxis,
} from '@/services/image-gen/image-ops';
import './sprite-editor-panel.ts.css';

/** Longest-edge downscale presets offered in the save popover (px); 0 = keep original size. */
const SAVE_SIZE_PRESETS: readonly number[] = [1024, 512, 256, 128, 64];

const EMPTY_RESOURCE_ID = 'sprite-editor://new';

/** Screen-pixel margin left around the image when the stage fits it to the viewport. */
const STAGE_FIT_PADDING = 16;

/** Above this zoom the working image is drawn with hard pixel edges, like the animation stage. */
const PIXELATED_ZOOM_THRESHOLD = 2;

const CROP_HANDLES: ReadonlyArray<{ pos: string; edges: string }> = [
  { pos: 'nw', edges: 'nw' },
  { pos: 'n', edges: 'n' },
  { pos: 'ne', edges: 'ne' },
  { pos: 'e', edges: 'e' },
  { pos: 'se', edges: 'se' },
  { pos: 's', edges: 's' },
  { pos: 'sw', edges: 'sw' },
  { pos: 'w', edges: 'w' },
];

/** Place mode has corner handles only — they scale, they never stretch (§9.11.1). */
const PLACE_HANDLES: readonly string[] = ['nw', 'ne', 'se', 'sw'];

/** Multiplier a plain wheel notch applies to the placed image's size. */
const PLACE_WHEEL_STEP = 1.1;

/**
 * Nine-up anchor grid. Icons, never arrow glyphs — `↖ ↑ ↗` ignore the theme and
 * render differently on every platform (the outgoing animation panel's version is
 * the exact violation §9.9 calls out).
 */
const ANCHOR_PRESETS: ReadonlyArray<{ icon: string; title: string; anchor: StagePoint }> = [
  { icon: 'arrow-up-left', title: 'Top left', anchor: { x: 0, y: 0 } },
  { icon: 'arrow-up', title: 'Top center', anchor: { x: 0.5, y: 0 } },
  { icon: 'arrow-up-right', title: 'Top right', anchor: { x: 1, y: 0 } },
  { icon: 'arrow-left', title: 'Center left', anchor: { x: 0, y: 0.5 } },
  { icon: 'disc', title: 'Center', anchor: { x: 0.5, y: 0.5 } },
  { icon: 'arrow-right', title: 'Center right', anchor: { x: 1, y: 0.5 } },
  { icon: 'arrow-down-left', title: 'Bottom left', anchor: { x: 0, y: 1 } },
  { icon: 'arrow-down', title: 'Bottom center', anchor: { x: 0.5, y: 1 } },
  { icon: 'arrow-down-right', title: 'Bottom right', anchor: { x: 1, y: 1 } },
];

/**
 * Which tool owns a plain left-drag on the canvas. `select` is the neutral state:
 * the frame overlays still *draw*, they just aren't editable, so scrubbing frames
 * can't nudge an anchor by accident.
 */
type StageTool = 'select' | AnimationEditMode;

const FRAME_TOOLS: ReadonlyArray<{ tool: AnimationEditMode; icon: string; title: string }> = [
  { tool: 'anchor', icon: 'crosshair', title: 'Anchor point' },
  { tool: 'points', icon: 'map-pin', title: 'Frame points (named sockets)' },
  { tool: 'polygon', icon: 'pen-tool', title: 'Collision polygon' },
  { tool: 'bbox', icon: 'square', title: 'Bounding box' },
];

type CurrentSource = 'file' | 'generated' | 'bg-removed' | 'cropped' | 'rotated' | 'flipped';

interface CurrentImage {
  blob: Blob;
  mimeType: string;
  objectUrl: string;
  source: CurrentSource;
  width?: number;
  height?: number;
}

/**
 * An incoming image being positioned by hand over the bound frame (§9.11). Opened
 * only when the frame can be written back to *and* the incoming raster is a
 * different size to the frame; nothing is written until Apply.
 */
interface PlaceSession {
  blob: Blob;
  mimeType: string;
  /** Tracked via {@link SpriteEditorPanel.trackUrl}, revoked when the session closes. */
  objectUrl: string;
  /** Intrinsic size of the incoming image. */
  image: ImageSize;
  /** The frame rect at session start — the canvas the composite is drawn onto. */
  frame: ImageSize;
  prompt: string;
  /** The frame this session belongs to; leaving it cancels. */
  frameIndex: number;
  /**
   * `boundFrameTexturePath` at session start. Recorded rather than compared
   * through Lit's `changed` map so the cancel is order-independent: the binding and
   * the session can land in the same update cycle.
   */
  texturePath: string;
}

@customElement('pix3-sprite-editor-panel')
export class SpriteEditorPanel extends ComponentBase implements ImageEditTarget {
  @inject(AiImageSettingsService)
  private readonly aiSettings!: AiImageSettingsService;

  @inject(GenerationHistoryService)
  private readonly history!: GenerationHistoryService;

  @inject(BackgroundRemovalService)
  private readonly bgRemoval!: BackgroundRemovalService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(EditorSettingsService)
  private readonly editorSettings!: EditorSettingsService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(AssetLibraryService)
  private readonly assetLibrary!: AssetLibraryService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(AnimationAutoSliceDialogService)
  private readonly sliceDialog!: AnimationAutoSliceDialogService;

  @inject(EditorTabService)
  private readonly editorTabs!: EditorTabService;

  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(AnimationEditorService)
  private readonly animationEditorService!: AnimationEditorService;

  @inject(ImageEditTargetService)
  private readonly imageEditTargets!: ImageEditTargetService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  @inject(AssetLoader)
  private readonly assetLoader!: AssetLoader;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private boundImagePath: string | null = null;
  @state() private current: CurrentImage | null = null;
  @state() private bgBusy = false;
  @state() private bgEngine: BgRemovalEngine = 'imgly';
  @state() private bgQuality: BgRemovalQuality = 'balanced';
  @state() private bgFillHoles = true;
  @state() private bgProgress: BgRemovalProgress | null = null;
  @state() private bgError: string | null = null;
  @state() private saveName = '';
  @state() private saveMessage: string | null = null;
  @state() private saveError: string | null = null;
  /** Longest-edge downscale cap applied at save time (px); 0 = keep original size. */
  @state() private saveMaxSize = 0;
  /** True while the user is entering a custom (non-preset) save size. */
  @state() private saveSizeCustom = false;
  @state() private savePopoverOpen = false;
  @state() private cropMode = false;
  @state() private cropRect: CropRect | null = null;
  /** Open place session (§9.11), mutually exclusive with {@link cropMode}. */
  @state() private placeSession: PlaceSession | null = null;
  /** Destination of the placed image, in frame pixels. */
  @state() private placeRect: PlaceRect | null = null;
  /** True while a rotate/flip transform is re-encoding the current image. */
  @state() private transformBusy = false;
  /** True while a slice / create-animation run is writing frame files. */
  @state() private sliceBusy = false;
  /** Outcome of the last slice / create-animation run, shown under the toolbar. */
  @state() private sliceStatus: { text: string; isError: boolean } | null = null;
  /** Grid the slice dialog opens with; remembered per panel instance. */
  private sliceColumns = 4;
  private sliceRows = 1;

  /** `.pix3anim` bound to this tab, or null when the tab holds a bare image. */
  @state() private animationResourcePath: string | null = null;
  /** Texture file the canvas is currently showing on behalf of a frame (§9.5). */
  @state() private boundFrameTexturePath: string | null = null;
  /** Which tool owns a plain left-drag; `crop` stays its own toggle below. */
  @state() private stageTool: StageTool = 'select';
  /** Editor-level texture drag (animation documents only) — appends frames on drop. */
  @state() private isTextureDragOver = false;

  /**
   * Prompt that produced the working image, handed over by the Generate panel
   * (§9.8). The shell no longer owns a prompt box, but the save name and the
   * library description still read better when they carry it.
   */
  private lastPrompt = '';

  private readonly stageRef = createRef<HTMLDivElement>();
  private readonly stageImageRef = createRef<HTMLImageElement>();
  /** The `<img>` place mode composites from — the incoming raster, not the frame's. */
  private readonly placeImageRef = createRef<HTMLImageElement>();
  private cropDrag: CropDragState | null = null;
  private placeDrag: PlaceDragState | null = null;

  /**
   * Zoom/pan of the canvas. Shared with the animation editor's frame stage so
   * both surfaces agree on wheel-zoom-to-cursor and pan feel (`src/ui/shared/`),
   * and — more importantly — on one coordinate model: the content element is
   * *sized* by zoom with the pan applied as a transform, so overlay geometry is
   * plain image pixels scaled by `zoom`.
   */
  private readonly stageView = new StageZoomPanController({
    minZoom: 0.1,
    maxZoom: 16,
    onChange: () => this.requestUpdate(),
  });

  /**
   * True once the user has zoomed or panned by hand. Until then the stage keeps
   * refitting the image on resize, which is how the old object-fit stage behaved.
   */
  private hasUserAdjustedView = false;
  /** Set when a new working image arrives; consumed by the next `load` event. */
  private pendingStageFit = false;
  private stageResizeObserver: ResizeObserver | null = null;
  /** `w×h` of the last rendered stage content; a change re-fits an unadjusted view. */
  private lastStageContentKey = '';

  /**
   * The animation document, for a `.pix3anim` tab only. Owned by this *instance* and
   * kept across a Golden Layout re-dock (disconnect → reconnect): `dispose()` only
   * unsubscribes, and `attach()` is idempotent, so re-connecting restores the
   * Inspector registration instead of orphaning it (§9.7 risk 6).
   */
  private documentController: AnimationDocumentController | null = null;
  private disposeDocumentSubscription?: () => void;
  private disposeOverlaySubscription?: () => void;
  private textureDragDepth = 0;

  /**
   * Stage overlays (anchor / bbox / polygon / points) and their pointer state
   * machine. Coordinates cross this boundary in frame-pixel space only — supplied
   * by {@link toFramePoint} below, which is `StageZoomPanController.toStageCoords`
   * against the same viewport the crop tool uses. One coordinate model, two tools.
   */
  private readonly overlays = new FrameOverlayController({
    getDocument: () => this.documentController,
    toFramePoint: event => this.toFramePoint(event),
  });

  /**
   * A texture dropped on a timeline frame card is inserted by
   * `<pix3-sprite-timeline>`, which stops the event so the shell-level handler
   * never runs — and that handler is what normally takes the drag overlay back
   * down. Capture runs before both, so this is the one place that reliably sees the
   * end of a texture drag wherever it landed.
   */
  private readonly onDropCapture = (): void => {
    this.textureDragDepth = 0;
    this.isTextureDragOver = false;
  };

  private disposeTabsSubscription?: () => void;
  private disposeAiSettingsSubscription?: () => void;
  private readonly onDocPointerDown = (event: PointerEvent): void => {
    if (this.savePopoverOpen) {
      const wrap = this.querySelector('.ag-save-wrap');
      // The popover itself lives in a body-level portal while open (it would be
      // clipped by Golden Layout's overflow:hidden otherwise), so it is NOT inside
      // `wrap` — test it separately or every click on the popover closes it.
      const target = event.target as Node;
      const insideTrigger = wrap?.contains(target) ?? false;
      if (!insideTrigger && !this.savePortal.contains(target)) {
        this.savePopoverOpen = false;
      }
    }
  };
  private readonly onDocKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    if (this.savePopoverOpen) {
      this.savePopoverOpen = false;
      return;
    }
    if (this.placeSession) {
      this.closePlaceSession();
    }
  };
  private readonly ownedUrls = new Set<string>();
  private syncedResourceId: string | null = null;

  /**
   * The save popover is 260px wide and right-aligned to a toolbar button that can sit
   * close to the panel's left edge, so as a plain absolutely-positioned child it was
   * sliced off by Golden Layout's `overflow: hidden` on `.lm_content`. The portal
   * re-parents it to a fixed-position container on `document.body` while open.
   */
  private readonly savePortal = new DropdownPortal({ minWidth: '260px' });

  /** Listeners on this shell's {@link ImageEditTargetSnapshot} (the Generate panel). */
  private readonly imageEditListeners = new Set<() => void>();
  /** Last broadcast snapshot key — notifications only fire when it actually changed. */
  private lastImageEditKey = '';

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeTabsSubscription = subscribe(appState.tabs, () => {
      this.syncFromTabState();
      this.syncActiveImageEditTarget();
    });
    this.disposeAiSettingsSubscription = this.aiSettings.subscribe(() => this.loadPreferences());
    this.addEventListener('drop', this.onDropCapture, { capture: true });
    this.disposeOverlaySubscription = this.overlays.subscribe(() => this.requestUpdate());
    window.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('keydown', this.onDocKeyDown);
    // On a Golden Layout re-dock the same instance is disconnected then reconnected; its blobs
    // survive but their object URLs were revoked on disconnect, so re-mint them.
    this.rehydrateObjectUrls();
    this.syncFromTabState();
    this.syncActiveImageEditTarget();
  }

  disconnectedCallback(): void {
    // Before Lit tears the tree down, or the portal keeps a detached popover on body.
    this.savePortal.close();
    this.disposeTabsSubscription?.();
    this.disposeTabsSubscription = undefined;
    this.disposeAiSettingsSubscription?.();
    this.disposeAiSettingsSubscription = undefined;
    this.imageEditTargets.clearActiveTarget(this);
    this.removeEventListener('drop', this.onDropCapture, { capture: true });
    this.disposeOverlaySubscription?.();
    this.disposeOverlaySubscription = undefined;
    // The controller itself is kept: a re-dock reconnects the same instance and
    // re-`attach()`es it, which is what restores its Inspector registration.
    this.disposeDocumentSubscription?.();
    this.disposeDocumentSubscription = undefined;
    this.documentController?.dispose();
    window.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('keydown', this.onDocKeyDown);
    this.stageResizeObserver?.disconnect();
    this.stageResizeObserver = null;
    // An un-applied placement does not survive a re-dock: its object URL is about
    // to be revoked, and the generation itself is still in the Generate panel's
    // history strip, which is what makes losing it acceptable (§9.11.2).
    this.closePlaceSession();
    this.revokeAllUrls();
    // Force a full re-sync (and bound-image reload) if this instance is reconnected.
    this.syncedResourceId = null;
    this.boundFrameTexturePath = null;
    super.disconnectedCallback();
  }

  /** Re-mint object URLs from retained blobs after a disconnect revoked the previous ones. */
  private rehydrateObjectUrls(): void {
    if (this.current) {
      this.current = {
        ...this.current,
        objectUrl: this.trackUrl(URL.createObjectURL(this.current.blob)),
      };
    }
  }

  // -- image-edit target (§9.8, the Generate panel's binding) ------------------

  getImageEditSnapshot(): ImageEditTargetSnapshot {
    const resourcePath = this.animationResourcePath ?? this.boundImagePath;
    return {
      targetId: this.tabId,
      label: resourcePath ? (resourcePath.split('/').pop() ?? resourcePath) : 'Sprite Editor',
      resourcePath,
      boundFrameTexturePath: this.boundFrameTexturePath,
      // While a placement is open the frame is spoken for: a second generation
      // must not land on top of one being positioned, so the Generate panel falls
      // back to its own save block (§9.11.2).
      acceptsFrameWriteBack: this.canWriteBackToFrame && !this.placeSession,
    };
  }

  /**
   * Whether baked pixels have a frame to land in (§9.5). True for any frame of an
   * open document, including a UV-window one — the write-back gives that frame a
   * raster file of its own, which is exactly what turns it into a sequence frame.
   */
  private get canWriteBackToFrame(): boolean {
    return Boolean(
      this.documentController &&
        this.boundFrameTexturePath &&
        this.documentController.selectedFrameIndex >= 0
    );
  }

  subscribeImageEditTarget(listener: () => void): () => void {
    this.imageEditListeners.add(listener);
    return () => this.imageEditListeners.delete(listener);
  }

  /**
   * The Generate panel's result. With a frame bound it goes into that frame as a
   * new frame file (§9.5); the canvas then reloads from it through the ordinary
   * frame→canvas binding. Same-size results land immediately; a differently-sized
   * one opens a **place session** instead and writes nothing until Apply (§9.11.0).
   *
   * Otherwise it becomes the transient working image, exactly as before.
   */
  applyGeneratedImage(image: GeneratedImagePayload): void {
    this.lastPrompt = image.prompt;
    if (this.canWriteBackToFrame) {
      void this.routeGeneratedImageToFrame(image);
      return;
    }

    const objectUrl = this.trackUrl(URL.createObjectURL(image.blob));
    this.setCurrent({
      blob: image.blob,
      mimeType: image.mimeType,
      objectUrl,
      source: 'generated',
      width: image.width,
      height: image.height,
    });
    this.saveName = deriveSaveName(image.prompt, this.boundImagePath, image.mimeType);
  }

  /**
   * The §9.11.0 scope gate. "Frame size" is the document's own
   * {@link getStageContentSize} — its `getFrameMetrics`, not the decoded raster,
   * the same rule every other overlay follows. An indeterminate incoming size
   * falls back to the equal-size branch rather than opening a session against an
   * unknown rect.
   */
  private async routeGeneratedImageToFrame(image: GeneratedImagePayload): Promise<void> {
    // §9.7 risk 2: until the frame's texture has decoded, `getStageContentSize()`
    // reports the 256px placeholder, and a session opened against that would bake a
    // composite the size of a rect the user never saw. Fall through to the straight
    // write-back instead — it does not depend on the frame rect at all.
    const boundFrame = this.boundFrame;
    const metricsResolved = Boolean(
      boundFrame && this.documentController?.hasResolvedFrameMetrics(boundFrame)
    );
    const frame = metricsResolved ? this.getStageContentSize() : null;
    const incoming =
      image.width && image.height
        ? { width: image.width, height: image.height }
        : await readBlobSize(image.blob);

    if (
      frame &&
      incoming &&
      incoming.width > 0 &&
      incoming.height > 0 &&
      (incoming.width !== frame.width || incoming.height !== frame.height) &&
      this.openPlaceSession(image, incoming, frame)
    ) {
      return;
    }
    await this.writeBlobToBoundFrame(image.blob, { kind: 'replace' }, 'Generate into frame');
  }

  /**
   * Register/deregister as the active image-edit target. Mirrors
   * `AnimationDocumentController.syncActiveInspectorController` (§9.3): the
   * registration follows the *active tab*, and the clear is conditional so a
   * second shell taking over is not undone by the first one's teardown.
   */
  private syncActiveImageEditTarget(): void {
    if (this.isConnected && this.tabId && appState.tabs.activeTabId === this.tabId) {
      this.imageEditTargets.setActiveTarget(this);
      return;
    }
    this.imageEditTargets.clearActiveTarget(this);
  }

  /** Fan out a snapshot change to the Generate panel — only when it really changed. */
  private notifyImageEditTarget(): void {
    const snapshot = this.getImageEditSnapshot();
    const key = `${snapshot.targetId}|${snapshot.resourcePath ?? ''}|${snapshot.boundFrameTexturePath ?? ''}|${snapshot.acceptsFrameWriteBack}`;
    if (key === this.lastImageEditKey) {
      return;
    }
    this.lastImageEditKey = key;
    for (const listener of this.imageEditListeners) {
      listener();
    }
  }

  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('tabId')) {
      // A rebind (§9.8) re-keys the tab in place, so the `tab-id` attribute changing
      // is the only signal the panel gets that it now edits something else — force a
      // full re-sync past the resource-id early-out. Not on the first update, where
      // the "previous" value is just the empty initializer and `connectedCallback`
      // has already synced.
      const previousTabId = changed.get('tabId');
      if (typeof previousTabId === 'string' && previousTabId !== '') {
        this.syncedResourceId = null;
      }
      this.syncFromTabState();
      this.syncActiveImageEditTarget();
    }
    this.notifyImageEditTarget();
    // Re-established on every update rather than in `firstUpdated`: a Golden Layout
    // re-dock disconnects the observer but never fires `firstUpdated` again.
    this.observeStageResize();
    // A rebind, or a write-back that gave the frame a new file, moves the pixels
    // out from under an open placement — the rect no longer describes anything the
    // user aimed at, so drop it.
    this.syncPlaceSessionToFrame();
    if (changed.has('cropMode') && this.cropMode && !this.cropRect) {
      // The stage image may still be decoding on a fresh mount; give it a frame.
      requestAnimationFrame(() => this.initCropRect());
    }
    this.syncSavePortal();
    this.refitOnContentSizeChange();
  }

  // -- tab / preferences sync ------------------------------------------------

  private syncFromTabState(): void {
    const tab = appState.tabs.tabs.find(t => t.id === this.tabId);
    const resourceId = tab?.resourceId ?? null;
    if (resourceId === this.syncedResourceId) {
      return;
    }
    this.syncedResourceId = resourceId;

    // A `.pix3anim` binds a *document*; a bare image binds the raster canvas
    // directly. The two never coexist — §9.4's "at most one animation document and
    // one raster working image". Resolved before preferences load, because the
    // AI rail's default state depends on which of the two this is.
    const isAnimation =
      Boolean(resourceId) &&
      (tab?.type === 'animation' || isAnimationResourcePath(resourceId ?? ''));
    this.animationResourcePath = isAnimation ? resourceId : null;

    this.loadPreferences();

    if (isAnimation && resourceId) {
      this.boundImagePath = null;
      this.bindDocumentController(resourceId);
      return;
    }

    this.releaseDocumentController();
    this.boundFrameTexturePath = null;
    const isBound = Boolean(resourceId) && resourceId !== EMPTY_RESOURCE_ID;
    this.boundImagePath = isBound ? resourceId : null;
    if (isBound && resourceId) {
      void this.loadBoundImage(resourceId);
    }
  }

  // -- animation document ----------------------------------------------------

  /**
   * Create (once) and attach the document controller for this tab. Built lazily
   * rather than in the constructor: `@inject` is a prototype accessor that resolves
   * through the container on *read*, so the deps object must not be assembled
   * before the container is ready (or before a spec has swapped a service out).
   */
  private bindDocumentController(resourcePath: string): AnimationDocumentController {
    if (!this.documentController) {
      this.documentController = new AnimationDocumentController(
        {
          operations: this.operations,
          commandDispatcher: this.commandDispatcher,
          projectStorage: this.storage,
          animationEditorService: this.animationEditorService,
          autoSliceDialog: this.sliceDialog,
          dialogService: this.dialogService,
          sceneManager: this.sceneManager,
          assetLoader: this.assetLoader,
          viewportRenderer: this.viewportRenderer,
        },
        this.tabId,
        resourcePath
      );
    }

    const controller = this.documentController;
    controller.setContext(this.tabId, resourcePath);
    if (!this.disposeDocumentSubscription) {
      this.disposeDocumentSubscription = controller.subscribe(() => this.onDocumentChanged());
    }
    controller.attach();
    this.onDocumentChanged();
    return controller;
  }

  /** Tear the document down for good — the tab no longer holds a `.pix3anim`. */
  private releaseDocumentController(): void {
    if (!this.documentController) {
      return;
    }
    this.disposeDocumentSubscription?.();
    this.disposeDocumentSubscription = undefined;
    this.documentController.dispose();
    this.documentController = null;
    this.stageTool = 'select';
  }

  private onDocumentChanged(): void {
    // A document reload drops the transient draft under an in-flight stage drag;
    // the drag has nothing left to edit, so end it.
    this.overlays.handleDocumentChanged();
    this.syncPlaceSessionToFrame();
    void this.syncCanvasToSelectedFrame();
    this.requestUpdate();
  }

  /**
   * Frame → canvas binding (§9.5, the binding half). Selecting a frame points the
   * one canvas at that frame's texture through the very same `loadBoundImage` an
   * image tab uses, so crop/zoom/pan/overlays all operate on one working image.
   * Write-back (`replaceFrameTexture` and its invalidation fan-out) is C7.
   */
  private async syncCanvasToSelectedFrame(): Promise<void> {
    const controller = this.documentController;
    if (!controller) {
      return;
    }

    const texturePath = getAnimationFrameTexturePath(controller.resource, controller.selectedFrame);
    if (!texturePath) {
      // Every frame deleted (or a clip that never had one): drop the working image
      // too, or the canvas keeps showing a frame the document no longer has.
      this.boundFrameTexturePath = null;
      this.clearCurrent();
      return;
    }
    if (texturePath === this.boundFrameTexturePath) {
      return;
    }

    this.boundFrameTexturePath = texturePath;
    await this.loadBoundImage(texturePath);
  }

  /** The frame the canvas stands in for, or null when no document is bound. */
  private get boundFrame(): AnimationFrame | null {
    return this.documentController?.selectedFrame ?? null;
  }

  /**
   * Only the raster-side preferences remain here: save-time downscale and the
   * background-removal engine. Everything generation-related moved to the
   * Generate panel with the chrome that used it (§9.8).
   */
  private loadPreferences(): void {
    const prefs = this.aiSettings.getPreferences();
    this.saveMaxSize = prefs.defaultSaveMaxSize;
    this.saveSizeCustom =
      prefs.defaultSaveMaxSize > 0 && !SAVE_SIZE_PRESETS.includes(prefs.defaultSaveMaxSize);
    this.bgEngine = prefs.bgRemovalEngine;
    this.bgQuality = prefs.bgRemovalQuality;
    this.bgFillHoles = prefs.bgFillHoles;
  }

  private async loadBoundImage(resourceId: string): Promise<void> {
    try {
      const blob = await this.storage.readBlob(resourceId);
      const objectUrl = this.trackUrl(URL.createObjectURL(blob));
      const size = await readImageSize(objectUrl);
      this.setCurrent({
        blob,
        mimeType: blob.type || 'image/png',
        objectUrl,
        source: 'file',
        width: size?.width,
        height: size?.height,
      });
      this.saveName = deriveSaveName(this.lastPrompt, resourceId, blob.type || 'image/png');
    } catch (error) {
      console.warn('[SpriteEditor] Failed to load bound image', error);
    }
  }

  // -- rendering -------------------------------------------------------------

  /**
   * The unified shell (§9.8): clips rail | canvas, with the frame timeline as a
   * full-width band underneath. Everything animation-specific renders only when a
   * document is bound, so an image tab is exactly the editor it was — minus the
   * width the references sidebar, prompt bar and history strip used to take from a
   * 646×123 canvas. That chrome is now `<pix3-generate-panel>`, a dock panel of its
   * own, so the canvas gets the whole shell rather than "shell minus rail".
   */
  protected render() {
    const controller = this.documentController;
    const hasDocument = Boolean(controller?.assetPath && controller.resource);

    return html`
      <section
        class="sprite-editor"
        @dragenter=${this.onDragEnter}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${this.renderToolbar()} ${this.renderSliceStatus()} ${this.renderDocumentError()}
        <div class="ag-workspace">
          ${hasDocument && controller
            ? html`<aside class="ag-clips-rail">
                <pix3-sprite-clips-rail .controller=${controller}></pix3-sprite-clips-rail>
              </aside>`
            : null}
          <main class="ag-main">${this.renderStage()}</main>
        </div>
        ${hasDocument && controller
          ? html`<section class="ag-timeline" aria-label="Animation frames">
              <pix3-sprite-timeline .controller=${controller}></pix3-sprite-timeline>
            </section>`
          : null}
        ${this.renderDropOverlay()}
      </section>
    `;
  }

  private renderDocumentError() {
    const message = this.documentController?.errorMessage;
    return message ? html`<div class="ag-slice-status is-error">${message}</div>` : null;
  }

  private renderDropOverlay() {
    return this.isTextureDragOver
      ? html`<div class="ag-drop-overlay">Drop image to append frames</div>`
      : null;
  }

  /**
   * One toolbar for both documents: `select | crop | rotate/flip | anchor | points |
   * polygon | generate | bg-remove | save` (§9.8). The frame tools appear only for a
   * `.pix3anim`; the raster tools disable while the canvas stands in for a frame,
   * because writing those pixels back into the document is C7.
   */
  private renderToolbar() {
    const rasterHint = this.frameRasterHint;
    const rasterBusy = Boolean(rasterHint) || !this.current || this.bgBusy;
    return html`
      <header class="ag-toolbar">
        <div class="ag-title">Sprite Editor</div>
        <button
          class="ag-icon-button"
          title="AI generation settings"
          aria-label="AI generation settings"
          @click=${this.openSettings}
        >
          ${this.icons.getIcon('settings', IconSize.SMALL)}
        </button>
        <div class="ag-toolbar-spacer"></div>
        ${this.renderFrameTools()}
        <button
          class="ag-toolbar-button ${this.cropMode ? 'is-active' : ''}"
          title=${rasterHint ?? 'Select a region and crop the image'}
          @click=${this.onToggleCrop}
          ?disabled=${rasterBusy}
        >
          ${this.icons.getIcon('crop', IconSize.SMALL)} Crop
        </button>
        <button
          class="ag-icon-button"
          title=${rasterHint ?? 'Rotate 90° clockwise'}
          aria-label="Rotate 90° clockwise"
          @click=${this.onRotate}
          ?disabled=${rasterBusy || this.cropMode || this.transformBusy}
        >
          ${this.icons.getIcon('rotate-cw', IconSize.SMALL)}
        </button>
        <button
          class="ag-icon-button"
          title=${rasterHint ?? 'Flip horizontally'}
          aria-label="Flip horizontally"
          @click=${this.onFlipHorizontal}
          ?disabled=${rasterBusy || this.cropMode || this.transformBusy}
        >
          ${this.icons.getIcon('flip-horizontal', IconSize.SMALL)}
        </button>
        <button
          class="ag-icon-button"
          title=${rasterHint ?? 'Flip vertically'}
          aria-label="Flip vertically"
          @click=${this.onFlipVertical}
          ?disabled=${rasterBusy || this.cropMode || this.transformBusy}
        >
          ${this.icons.getIcon('flip-vertical', IconSize.SMALL)}
        </button>
        <span class="ag-toolbar-separator" aria-hidden="true"></span>
        <button
          class="ag-toolbar-button ag-generate-action"
          type="button"
          title="Open the Generate panel — results land on this canvas"
          @click=${this.onOpenGeneratePanel}
        >
          ${this.icons.getIcon('sparkles', IconSize.SMALL)} Generate…
        </button>
        <button
          class="ag-toolbar-button"
          title=${rasterHint ?? 'Remove the image background'}
          @click=${this.onRemoveBackground}
          ?disabled=${rasterBusy || this.cropMode}
        >
          ${this.bgBusy ? 'Removing…' : 'Remove background'}
        </button>
        ${this.renderSpritesheetActions()} ${this.renderZoomActions()} ${this.renderSaveMenu()}
      </header>
    `;
  }

  /**
   * §9.8's mitigation for the split: the prompt now lives in another dock, so the
   * shell keeps a one-click route to it. Goes through the command gateway rather
   * than the LayoutManager directly, so the View-menu item and this button are the
   * same action.
   */
  private onOpenGeneratePanel = (): void => {
    void this.commandDispatcher.execute(new OpenGeneratePanelCommand());
  };

  /**
   * Why the raster tools are off, or null when they are available. Since C7 a
   * frame-bound canvas writes its bakes back into the frame (§9.5), so the only
   * remaining blockers are the two cases where the canvas is not showing the
   * frame's own pixels 1:1 and a crop rect would therefore mean the wrong thing.
   */
  private get frameRasterHint(): string | null {
    const frame = this.boundFrame;
    if (!frame || !this.boundFrameTexturePath) {
      return null;
    }
    if (!isSequenceAnimationFrame(frame)) {
      // A UV-window frame reads a rect out of the shared spritesheet, but the
      // canvas is showing that whole sheet — cropping it would cut every frame.
      return 'This frame is a window into the shared spritesheet, which is what the canvas shows. Slice it into frame files first to edit its pixels.';
    }
    if (!this.documentController?.hasResolvedFrameMetrics(frame)) {
      return 'Waiting for the frame texture to decode…';
    }
    return null;
  }

  /**
   * The write-back half of §9.5: hand baked pixels to the document, which writes
   * a new `<clip>_<nnnn>.png` and records one undo step pointing the frame at it.
   * The canvas is not touched here — the frame's `texturePath` changed, so the
   * shell's own frame→canvas binding reloads it from the file that now exists.
   *
   * Returns true when the bake landed in the document.
   */
  private async writeBlobToBoundFrame(
    blob: Blob,
    restamp: FrameRasterTransform,
    label?: string
  ): Promise<boolean> {
    const controller = this.documentController;
    const frameIndex = controller?.selectedFrameIndex ?? -1;
    if (!controller || frameIndex < 0 || !this.boundFrameTexturePath) {
      return false;
    }

    const sourceSize = this.getImageSize();
    try {
      const written = await controller.replaceFrameTexture(frameIndex, blob, {
        restamp,
        sourceSize: sourceSize ?? undefined,
        label: label ? `${label} ${frameIndex + 1}: ${controller.activeClipName}` : undefined,
      });
      if (!written) {
        this.sliceStatus = { text: 'Could not write the frame file.', isError: true };
        return false;
      }
      // The toolbar status line, not `saveMessage` — that one only exists inside
      // the save popover, and a frame bake never opens it.
      this.sliceStatus = {
        text: `Frame ${frameIndex + 1} now uses ${written.split('/').pop() ?? written}`,
        isError: false,
      };
      return true;
    } catch (error) {
      this.sliceStatus = {
        text: `Frame write-back failed: ${describeError(error)}`,
        isError: true,
      };
      return false;
    }
  }

  /** Anchor / points / polygon / bounding-box tools — animation documents only. */
  private renderFrameTools() {
    if (!this.documentController?.resource) {
      return null;
    }

    return html`
      <button
        class="ag-icon-button ${this.stageTool === 'select' && !this.cropMode ? 'is-active' : ''}"
        type="button"
        title="Select (no frame overlay editing)"
        aria-label="Select"
        @click=${() => this.setStageTool('select')}
      >
        ${this.icons.getIcon('mouse-pointer', IconSize.SMALL)}
      </button>
      ${FRAME_TOOLS.map(
        entry => html`
          <button
            class="ag-icon-button ${this.stageTool === entry.tool && !this.cropMode
              ? 'is-active'
              : ''}"
            type="button"
            title=${entry.title}
            aria-label=${entry.title}
            ?disabled=${!this.boundFrame}
            @click=${() => this.setStageTool(entry.tool)}
          >
            ${this.icons.getIcon(entry.icon, IconSize.SMALL)}
          </button>
        `
      )}
      ${this.renderTrimFramesAction()} ${this.renderDeleteFramesAction()}
      <span class="ag-toolbar-separator" aria-hidden="true"></span>
    `;
  }

  /**
   * §9.12.1 — trim the whole clip in one undo step. A clip-wide action, so it sits
   * next to "delete selected frames" rather than on a frame card: the frame the
   * canvas happens to show says nothing about which frames have transparent margins.
   */
  private renderTrimFramesAction() {
    const frameCount = this.documentController?.activeClip?.frames.length ?? 0;
    const busy = this.sliceBusy || this.bgBusy || this.cropMode;
    const title =
      frameCount === 0
        ? 'Trim frames (this clip has no frames)'
        : `Trim transparent margins from ${frameCount} frame${frameCount === 1 ? '' : 's'}`;
    return html`
      <button
        class="ag-icon-button ag-trim-frames"
        type="button"
        title=${title}
        aria-label="Trim frames"
        ?disabled=${frameCount === 0 || busy}
        @click=${this.onTrimFrames}
      >
        ${this.icons.getIcon('scissors', IconSize.SMALL)}
      </button>
    `;
  }

  /**
   * Destructive and bulk, so it goes through a confirm (§9.12). The two confirm
   * buttons are the alpha threshold: "Trim" cuts only fully transparent pixels,
   * "Trim including halo" raises the threshold to 8 so the near-transparent fringe
   * a background removal leaves behind goes too (the hint `TrimOptions` carries).
   * Padding stays at the §9.12.1 default of 0 — the point of the tool is tightness.
   */
  private onTrimFrames = async (): Promise<void> => {
    const controller = this.documentController;
    const clip = controller?.activeClip;
    if (!controller || !clip || clip.frames.length === 0 || this.sliceBusy) {
      return;
    }

    const frameCount = clip.frames.length;
    const choice = await this.dialogService.showChoice({
      title: 'Trim frames?',
      message: `Crop the transparent margins off ${frameCount} frame${
        frameCount === 1 ? '' : 's'
      } of "${clip.name}". Each frame's anchor, points and boxes move with the crop, so nothing shifts on screen.`,
      confirmLabel: 'Trim frames',
      secondaryLabel: 'Trim including halo',
      cancelLabel: 'Cancel',
      isDangerous: true,
      disclaimer:
        'Every trimmed frame is written as a new file. Undo restores the document, not the pixels on disk. "Trim including halo" also cuts near-transparent pixels (alpha ≤ 8), which is what background removal leaves behind.',
    });
    if (choice === 'cancel') {
      return;
    }

    this.sliceBusy = true;
    this.sliceStatus = null;
    try {
      const report = await controller.trimClipFrames({
        padding: 0,
        alphaThreshold: choice === 'secondary' ? 8 : 0,
      });
      this.sliceStatus = {
        text: describeTrimReport(report, clip.name),
        isError: report.failed > 0,
      };
    } catch (error) {
      this.sliceStatus = { text: `Trim failed: ${describeError(error)}`, isError: true };
    } finally {
      this.sliceBusy = false;
    }
  };

  /**
   * Delete every selected frame. Multi-select is authored in the timeline
   * (ctrl/shift-click), but the *action* has to live somewhere that sees the whole
   * selection — a frame card's own trash icon only ever removes that one frame.
   */
  private renderDeleteFramesAction() {
    const controller = this.documentController;
    const selectedCount = controller?.getSelectedFrameIndices().length ?? 0;
    const title =
      selectedCount > 1 ? `Delete ${selectedCount} selected frames` : 'Delete selected frame';
    return html`
      <button
        class="ag-icon-button ag-delete-frames"
        type="button"
        title=${title}
        aria-label=${title}
        ?disabled=${selectedCount === 0}
        @click=${() => void controller?.removeSelectedFrames()}
      >
        ${this.icons.getIcon('trash-2', IconSize.SMALL)}
      </button>
    `;
  }

  private setStageTool(tool: StageTool): void {
    this.stageTool = tool;
    if (tool !== 'select') {
      this.overlays.setEditMode(tool);
      // Crop, place and an overlay tool all want a plain left-drag; the last click wins.
      this.cropMode = false;
      this.cropRect = null;
      this.cropDrag = null;
      this.closePlaceSession();
    }
  }

  /** Stage zoom affordances — the same trio (and icons) the animation stage carries. */
  private renderZoomActions() {
    const disabled = !this.current;
    return html`
      <span class="ag-toolbar-separator" aria-hidden="true"></span>
      <button
        class="ag-icon-button"
        title="Zoom out"
        aria-label="Zoom out"
        @click=${() => this.onAdjustZoom(-1)}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-out', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title="Reset zoom to 100%"
        aria-label="Reset zoom to 100%"
        @click=${this.onResetZoom}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-default', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title="Zoom in"
        aria-label="Zoom in"
        @click=${() => this.onAdjustZoom(1)}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-in', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title="Fit the image to the view"
        aria-label="Fit the image to the view"
        @click=${this.onFitStageToView}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-fit', IconSize.SMALL)}
      </button>
      <span class="ag-zoom-readout" title="Stage zoom"
        >${Math.round(this.stageView.zoom * 100)}%</span
      >
    `;
  }

  /**
   * Spritesheet actions. Both need the image to exist as a project file (the frame files are
   * written next to it), so they stay disabled until the panel is bound to one — save the image
   * first and the tab rebinds.
   */
  private renderSpritesheetActions() {
    const busy = this.sliceBusy || this.bgBusy || this.cropMode;
    const canSlice = Boolean(this.boundImagePath) && !busy;
    const hint = this.boundImagePath
      ? undefined
      : 'Save the image into the project first — frame files are written next to it.';

    return html`
      <button
        class="ag-icon-button"
        title=${hint ?? 'Slice this spritesheet into individual frame files'}
        aria-label="Slice into frames"
        @click=${this.onSliceIntoFrames}
        ?disabled=${!canSlice}
      >
        ${this.icons.getIcon('grid', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title=${hint ?? 'Create an animation (sprite folder) from this image'}
        aria-label="Create animation"
        @click=${this.onCreateAnimation}
        ?disabled=${!canSlice}
      >
        ${this.icons.getIcon('film', IconSize.SMALL)}
      </button>
    `;
  }

  private renderSliceStatus() {
    if (this.sliceBusy) {
      return html`<div class="ag-slice-status">Writing frame files…</div>`;
    }
    if (!this.sliceStatus) {
      return null;
    }
    return html`<div class="ag-slice-status ${this.sliceStatus.isError ? 'is-error' : ''}">
      ${this.sliceStatus.text}
      <button
        class="ag-icon-button ag-slice-status-close"
        title="Dismiss"
        aria-label="Dismiss"
        @click=${() => {
          this.sliceStatus = null;
        }}
      >
        ${this.icons.getIcon('x', IconSize.SMALL)}
      </button>
    </div>`;
  }

  private renderSaveMenu() {
    return html`
      <div class="ag-save-wrap">
        <button
          class="ag-toolbar-button ag-save-button ${this.savePopoverOpen ? 'is-open' : ''}"
          title="Save options"
          ?disabled=${!this.current || this.cropMode}
          @click=${this.toggleSavePopover}
        >
          ${this.icons.getIcon('save', IconSize.SMALL)} Save
          ${this.icons.getIcon('chevron-down', IconSize.SMALL)}
        </button>
        ${this.savePopoverOpen && this.current ? this.renderSavePopover() : null}
      </div>
    `;
  }

  private renderSavePopover() {
    const projectReady = appState.project.status === 'ready';
    return html`
      <div class="ag-save-popover" @click=${(e: Event) => e.stopPropagation()}>
        <div class="ag-popover-title">Save asset</div>
        <input
          class="ag-save-name"
          type="text"
          placeholder="folder/name.png"
          .value=${this.saveName}
          @input=${this.onSaveNameInput}
        />
        ${this.renderSaveResize()}
        <div class="ag-save-actions">
          <button
            class="ag-action-button"
            ?disabled=${!projectReady || !this.saveName.trim()}
            @click=${this.onSaveToProject}
          >
            Save to project
          </button>
          <button
            class="ag-action-button"
            ?disabled=${!projectReady || !this.saveName.trim()}
            @click=${this.onInsertSprite}
          >
            Insert as Sprite2D
          </button>
          <button
            class="ag-action-button"
            ?disabled=${!this.saveName.trim() || !this.assetLibrary.isUserScopeSupported()}
            @click=${this.onSaveToLibrary}
          >
            Save to Library
          </button>
          ${this.boundImagePath
            ? html`<button
                class="ag-action-button"
                ?disabled=${!projectReady}
                @click=${this.onOverwriteOriginal}
              >
                Overwrite original
              </button>`
            : null}
          <button class="ag-action-button" @click=${this.onDownload}>Download</button>
        </div>
        ${this.saveMessage ? html`<div class="ag-success">${this.saveMessage}</div>` : null}
        ${this.saveError ? html`<div class="ag-error">${this.saveError}</div>` : null}
        ${projectReady ? null : html`<div class="ag-hint">Open a project to save into it.</div>`}
      </div>
    `;
  }

  private renderSaveResize() {
    const current = this.current;
    const selectValue = this.saveSizeCustom
      ? 'custom'
      : this.saveMaxSize > 0
        ? String(this.saveMaxSize)
        : '0';
    const target =
      current?.width && current.height
        ? scaledDimensions(current.width, current.height, this.saveMaxSize)
        : null;
    const sourceLabel =
      current?.width && current.height ? `${current.width}×${current.height}` : '?';
    const targetLabel = target ? `${target.width}×${target.height}` : '?';
    return html`
      <label class="ag-field ag-save-resize">
        <span class="ag-field-label">Resize on save (longest edge)</span>
        <select @change=${this.onSaveResizeChange}>
          <option value="0" ?selected=${selectValue === '0'}>Original size</option>
          ${SAVE_SIZE_PRESETS.map(
            size =>
              html`<option value=${String(size)} ?selected=${selectValue === String(size)}>
                ≤ ${size} px
              </option>`
          )}
          <option value="custom" ?selected=${selectValue === 'custom'}>Custom…</option>
        </select>
      </label>
      ${this.saveSizeCustom
        ? html`<input
            class="ag-save-custom-size"
            type="number"
            min="1"
            step="1"
            placeholder="Max px"
            .value=${this.saveMaxSize > 0 ? String(this.saveMaxSize) : ''}
            @input=${this.onSaveCustomSizeInput}
          />`
        : null}
      <div class="ag-hint">
        ${this.saveMaxSize > 0
          ? html`Source ${sourceLabel} → saved at <strong>${targetLabel}</strong> px`
          : html`Saved at full generated size (${sourceLabel} px)`}
      </div>
    `;
  }

  /**
   * One stage for every mode. The image is *sized* by zoom (never CSS-scaled) and
   * the pan rides on a transform, so overlays laid out in image pixels × zoom
   * land exactly on the pixels they describe while their chrome — the crop
   * border, the handles — stays screen-sized and grabbable at any zoom.
   */
  private renderStage() {
    const current = this.current;
    const size = this.getStageContentSize();
    const zoom = this.stageView.zoom;
    const frame = this.boundFrame;
    const contentStyle = size
      ? `width:${size.width * zoom}px; height:${size.height * zoom}px;`
      : '';
    // A frame windows its texture (`offset`/`repeat`) into a fixed box; a bare image
    // *is* the box. Either way the content element is sized in stage pixels × zoom,
    // which is the model `toStageCoords` and `fitToViewport` assume.
    const imageStyle = frame ? getFrameImageStyle(frame) : contentStyle;

    return html`
      <div
        class="ag-stage ${this.cropMode ? 'is-cropping' : ''} ${this.stageView.isPanning
          ? 'is-panning'
          : ''}"
        ${ref(this.stageRef)}
        @wheel=${this.onStageWheel}
        @pointerdown=${this.onStagePointerDown}
        @pointermove=${this.onStagePointerMove}
        @pointerup=${this.onStagePointerUp}
        @pointercancel=${this.onStagePointerUp}
      >
        ${current
          ? html`<div
              class="ag-stage-content ${frame ? 'is-frame-box' : ''} ${this.placeSession
                ? 'is-placing'
                : ''}"
              style="transform: translate(${this.stageView.panX}px, ${this.stageView
                .panY}px); ${frame ? contentStyle : ''}"
            >
              <img
                class="ag-stage-image ${frame ? 'is-frame-image' : ''} ${zoom >=
                PIXELATED_ZOOM_THRESHOLD
                  ? 'is-pixelated'
                  : ''}"
                src=${this.getStageImageSrc(current.objectUrl)}
                alt="Working image"
                draggable="false"
                style=${imageStyle}
                ${ref(this.stageImageRef)}
                @load=${this.onStageImageLoad}
              />
              ${frame && size ? this.renderFrameOverlays(frame, size) : null}
              ${this.cropMode && this.cropRect ? this.renderCropRect(this.cropRect, zoom) : null}
              ${this.placeSession && this.placeRect
                ? this.renderPlaceOverlay(this.placeSession, this.placeRect, zoom)
                : null}
            </div>`
          : html`<div class="ag-empty">
              <div class="ag-empty-title">${this.renderEmptyTitle()}</div>
              <div class="ag-empty-body">${this.renderEmptyBody()}</div>
            </div>`}
        ${this.renderAnchorTools(frame)} ${this.renderPointTools(frame)}
        ${this.bgBusy ? html`<div class="ag-progress">${this.renderBgProgress()}</div>` : null}
      </div>
      ${this.placeSession
        ? this.renderPlaceToolbar()
        : this.cropMode
          ? this.renderCropToolbar()
          : null}
      ${this.bgError ? html`<div class="ag-error ag-stage-error">${this.bgError}</div>` : null}
    `;
  }

  private renderEmptyTitle(): string {
    return this.animationResourcePath ? 'No frame selected' : 'Nothing here yet';
  }

  private renderEmptyBody(): string {
    return this.animationResourcePath
      ? 'Pick a clip with frames, or drop images onto the editor to append sequence frames.'
      : 'Enter a prompt and press Generate, or open an image asset to edit it.';
  }

  /**
   * While the preview is running the canvas follows `previewFrameIndex` off the
   * controller's own texture cache; the *working* image stays the selected frame, so
   * a crop or a save still acts on what the user picked.
   */
  private getStageImageSrc(fallbackUrl: string): string {
    const controller = this.documentController;
    if (!controller?.isPreviewPlaying) {
      return fallbackUrl;
    }
    return controller.getTexturePreviewUrl(controller.previewFrame) || fallbackUrl;
  }

  /** Anchor / bbox / polygon / points, in frame-pixel space over the canvas. */
  private renderFrameOverlays(frame: AnimationFrame, size: ImageSize) {
    const controller = this.documentController;
    if (!controller) {
      return null;
    }

    const metrics = { frameWidth: size.width, frameHeight: size.height };
    const previousFrame = controller.activeClip?.frames[controller.selectedFrameIndex - 1] ?? null;
    return html`
      <svg
        class="ag-stage-overlay"
        viewBox=${`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        ${renderBboxOverlay(frame)}
        ${renderPolygonOverlay(frame, { editable: this.canEditOverlay('polygon') })}
        ${renderPointsOverlay({
          frame,
          previousFrame,
          metrics,
          editable: this.canEditOverlay('points'),
          selectedPointName: this.overlays.selectedPointName,
        })}
      </svg>
      ${renderAnchorOverlay(frame, { editable: this.canEditOverlay('anchor') })}
    `;
  }

  /** A tool edits only when it is the active tool *and* the overlay controller agrees. */
  private canEditOverlay(mode: AnimationEditMode): boolean {
    return this.stageTool === mode && !this.cropMode && this.overlays.canEdit(mode);
  }

  /** Anchor presets, floating over the canvas so they cost it no width. */
  private renderAnchorTools(frame: AnimationFrame | null) {
    if (this.stageTool !== 'anchor' || this.cropMode || !frame || !this.documentController) {
      return null;
    }

    const controller = this.documentController;
    return html`
      <div class="ag-frame-tools" aria-label="Anchor point tools">
        <div class="ag-frame-tools-head">
          <span class="ag-frame-tools-title">Anchor</span>
          <span class="ag-frame-tools-value">
            ${frame.anchor.x.toFixed(2)}, ${frame.anchor.y.toFixed(2)}
          </span>
        </div>
        <div class="ag-anchor-grid">
          ${ANCHOR_PRESETS.map(
            preset => html`
              <button
                class="ag-frame-tools-button ${frame.anchor.x === preset.anchor.x &&
                frame.anchor.y === preset.anchor.y
                  ? 'is-active'
                  : ''}"
                type="button"
                title=${preset.title}
                aria-label=${preset.title}
                @click=${() => void controller.applyAnchorPreset(preset.anchor)}
              >
                ${this.icons.getIcon(preset.icon, IconSize.SMALL)}
              </button>
            `
          )}
        </div>
        <div class="ag-frame-tools-row">
          <button
            class="ag-frame-tools-wide"
            type="button"
            title="Apply this anchor to every frame of the active clip"
            @click=${() => void controller.applySelectedAnchorToActiveClip()}
          >
            Clip
          </button>
          <button
            class="ag-frame-tools-wide"
            type="button"
            title="Apply this anchor to every frame of every clip"
            @click=${() => void controller.applySelectedAnchorToAllClips()}
          >
            All
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Points-mode side panel: the union of point names across the clip, so adding one
   * seeds it into every frame and the list doesn't flicker as you scrub.
   */
  private renderPointTools(frame: AnimationFrame | null) {
    if (this.stageTool !== 'points' || this.cropMode || !frame || !this.documentController) {
      return null;
    }

    const controller = this.documentController;
    const names = collectClipPointNames(controller.activeClip);
    return html`
      <div class="ag-frame-tools" aria-label="Frame point tools">
        <div class="ag-frame-tools-head">
          <span class="ag-frame-tools-title">Points</span>
          <span class="ag-frame-tools-value">${names.length}</span>
        </div>
        ${names.length === 0
          ? html`<p class="ag-frame-tools-hint">
              Add a named socket (muzzle, hand) and drag it per frame. Scripts read it with
              <code>getFramePoint()</code>.
            </p>`
          : html`
              <ul class="ag-point-list">
                ${names.map(name => this.renderPointEntry(frame, name))}
              </ul>
            `}
        <button
          class="ag-frame-tools-wide"
          type="button"
          title="Add a named point to every frame of this clip"
          @click=${() => void this.onAddPoint()}
        >
          Add point
        </button>
      </div>
    `;
  }

  private renderPointEntry(frame: AnimationFrame, name: string) {
    const controller = this.documentController;
    if (!controller) {
      return null;
    }

    const point = findAnimationFramePoint(frame, name);
    return html`
      <li class="ag-point-list-item ${point ? '' : 'is-missing'}">
        <input
          class="ag-point-list-name"
          type="text"
          .value=${name}
          aria-label=${`Point name: ${name}`}
          title=${point
            ? `${(point.x * 100).toFixed(0)}%, ${(point.y * 100).toFixed(0)}%, ${Math.round(point.angle ?? 0)}°`
            : 'Not defined on this frame'}
          ?data-selected=${this.overlays.selectedPointName === name}
          @focus=${() => this.overlays.setSelectedPointName(name)}
          @change=${(event: Event) =>
            void this.onRenamePoint(name, (event.target as HTMLInputElement).value)}
        />
        <button
          type="button"
          class="ag-point-list-action"
          title="Copy this frame's position to every frame of the clip"
          aria-label=${`Copy ${name} to every frame`}
          @click=${() => void controller.copyFramePointToClip(name)}
        >
          ${this.icons.getIcon('copy', 12)}
        </button>
        <button
          type="button"
          class="ag-point-list-action is-danger"
          title="Remove from every frame of the clip"
          aria-label=${`Remove ${name}`}
          @click=${() => void this.onRemovePoint(name)}
        >
          ${this.icons.getIcon('trash-2', 12)}
        </button>
      </li>
    `;
  }

  private async onAddPoint(): Promise<void> {
    const name = await this.documentController?.addFramePoint();
    if (name) {
      this.overlays.setSelectedPointName(name);
    }
  }

  private async onRenamePoint(name: string, rawNextName: string): Promise<void> {
    const appliedName = await this.documentController?.renameFramePoint(name, rawNextName);
    if (!appliedName) {
      // Restore the input to the stored name on an empty / no-op / duplicate edit.
      this.requestUpdate();
      return;
    }
    this.overlays.setSelectedPointName(appliedName);
  }

  private async onRemovePoint(name: string): Promise<void> {
    if (this.overlays.selectedPointName === name) {
      this.overlays.setSelectedPointName(null);
    }
    await this.documentController?.removeFramePoint(name);
  }

  private renderCropRect(rect: CropRect, zoom: number) {
    return html`<div
      class="ag-crop-rect"
      style="left:${rect.x * zoom}px; top:${rect.y * zoom}px; width:${rect.w *
      zoom}px; height:${rect.h * zoom}px"
      @pointerdown=${(event: PointerEvent) => this.beginCropDrag(event, 'move', '')}
    >
      ${CROP_HANDLES.map(handle => this.renderCropHandle(handle))}
    </div>`;
  }

  private renderCropToolbar() {
    const rect = this.cropRect;
    return html`
      <div class="ag-crop-toolbar">
        <span class="ag-crop-dims"
          >${rect ? describeCropRect(rect) : 'Drag on the image to select a region'}</span
        >
        <div class="ag-prompt-spacer"></div>
        <button class="ag-cancel-button" @click=${this.onCancelCrop}>Cancel</button>
        <button
          class="ag-generate-button ag-crop-apply"
          ?disabled=${!isApplicableCropRect(this.cropRect)}
          @click=${this.onApplyCrop}
        >
          Apply crop
        </button>
      </div>
    `;
  }

  private renderCropHandle(handle: { pos: string; edges: string }) {
    return html`<span
      class="ag-crop-handle ag-crop-handle--${handle.pos}"
      @pointerdown=${(event: PointerEvent) => this.beginCropDrag(event, 'resize', handle.edges)}
    ></span>`;
  }

  private renderBgProgress() {
    const progress = this.bgProgress;
    const pct =
      typeof progress?.progress === 'number' ? ` ${Math.round(progress.progress * 100)}%` : '';
    const label = !progress
      ? 'Preparing…'
      : progress.phase === 'downloading'
        ? `Downloading model…${pct}`
        : progress.phase === 'loading'
          ? `Loading model…${pct}`
          : 'Removing background…';
    return html`<div class="ag-progress-inner"><span class="ag-spinner"></span>${label}</div>`;
  }

  // -- input handlers --------------------------------------------------------

  /**
   * Keep the body-level portal in step with `savePopoverOpen`. Lit re-renders the
   * popover's contents in place while it is portaled — the element itself is only
   * moved, so its bindings keep working — but the portal has to be (re)opened after
   * the element exists and closed before Lit removes it.
   */
  private syncSavePortal(): void {
    const shouldBeOpen = this.savePopoverOpen && Boolean(this.current);
    if (!shouldBeOpen) {
      if (this.savePortal.isOpen()) {
        this.savePortal.close();
      }
      return;
    }
    if (this.savePortal.isOpen()) {
      const trigger = this.querySelector<HTMLElement>('.ag-save-button');
      if (trigger) {
        this.savePortal.reposition(trigger);
      }
      return;
    }
    const trigger = this.querySelector<HTMLElement>('.ag-save-button');
    const popover = this.querySelector<HTMLElement>('.ag-save-popover');
    if (trigger && popover) {
      this.savePortal.open(trigger, popover);
    }
  }

  private toggleSavePopover(): void {
    this.savePopoverOpen = !this.savePopoverOpen;
    if (this.savePopoverOpen) {
      this.saveMessage = null;
      this.saveError = null;
    }
  }

  private onSaveNameInput(event: Event): void {
    this.saveName = (event.target as HTMLInputElement).value;
    this.saveMessage = null;
    this.saveError = null;
  }

  private onSaveResizeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'custom') {
      this.saveSizeCustom = true;
      // Keep whatever custom value was there; seed a sensible default the first time.
      if (this.saveMaxSize <= 0) {
        this.saveMaxSize = 256;
      }
    } else {
      this.saveSizeCustom = false;
      this.saveMaxSize = Number(value) || 0;
    }
    this.aiSettings.updatePreferences({ defaultSaveMaxSize: this.saveMaxSize });
  }

  private onSaveCustomSizeInput(event: Event): void {
    const parsed = Math.round(Number((event.target as HTMLInputElement).value));
    this.saveMaxSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    this.aiSettings.updatePreferences({ defaultSaveMaxSize: this.saveMaxSize });
  }

  /**
   * Resolve the bytes to write for the current image, applying the save-time downscale when one is
   * set and the image is larger than the cap. Returns the original blob unchanged otherwise.
   */
  private async resolveSaveBlob(): Promise<{ blob: Blob; mimeType: string } | null> {
    const current = this.current;
    if (!current) {
      return null;
    }
    const longest = Math.max(current.width ?? 0, current.height ?? 0);
    // No cap, or the image already fits within it → write the exact generated bytes untouched.
    if (this.saveMaxSize <= 0 || (longest > 0 && longest <= this.saveMaxSize)) {
      return { blob: current.blob, mimeType: current.mimeType };
    }
    try {
      // Preserve the source format so alpha (transparent PNGs / cut-outs) survives the resize.
      const result = await resizeImageBlob(current.blob, {
        maxSize: this.saveMaxSize,
        mimeType: current.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      });
      return { blob: result.blob, mimeType: result.blob.type || current.mimeType };
    } catch (error) {
      console.warn('[SpriteEditor] Resize on save failed; writing original size', error);
      return { blob: current.blob, mimeType: current.mimeType };
    }
  }

  private openSettings(): void {
    void this.editorSettings.showSettings('images');
  }

  // -- frame texture drops -----------------------------------------------------

  /**
   * With a document bound, an image drop appends frames (the old animation editor's
   * behaviour). A frame *reorder* drag is filtered out by `isPotentialTextureDrag`
   * through the shared `FRAME_REORDER_MIME`, which is why that constant is not
   * private to the strip. Reference drops belong to the Generate panel now (§9.8).
   */
  private onDragEnter(event: DragEvent): void {
    if (!this.documentController?.resource || !isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }
    this.textureDragDepth += 1;
    this.isTextureDragOver = true;
  }

  private onDragOver(event: DragEvent): void {
    if (!this.documentController?.resource || !isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    this.isTextureDragOver = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private onDragLeave(event: DragEvent): void {
    if (!this.documentController?.resource || !isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }
    this.textureDragDepth = Math.max(0, this.textureDragDepth - 1);
    if (this.textureDragDepth === 0) {
      this.isTextureDragOver = false;
    }
  }

  private onDrop(event: DragEvent): void {
    if (event.dataTransfer && this.documentController?.resource) {
      void this.onFrameTextureDrop(event);
    }
  }

  private async onFrameTextureDrop(event: DragEvent): Promise<void> {
    const controller = this.documentController;
    if (!controller || !isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    this.textureDragDepth = 0;
    this.isTextureDragOver = false;

    // §8.4: a generation dropped on the *canvas* goes into the current frame
    // (place mode when the sizes differ), not onto the end of the clip — that is
    // the timeline's row of the matrix. Without this the drop would light the
    // append overlay and then do nothing, because the shared parser deliberately
    // refuses to read a `res://` path out of a generation's suggested file name.
    if (await this.applyDroppedGeneration(event.dataTransfer)) {
      return;
    }

    const droppedFiles = getDroppedImageFiles(event.dataTransfer);
    const texturePaths =
      droppedFiles.length > 0
        ? await controller.importOsFiles(droppedFiles)
        : getDroppedTextureResources(event.dataTransfer);
    if (texturePaths.length === 0) {
      return;
    }

    await controller.addFrameTextures(texturePaths);
  }

  /**
   * Route a dragged Generate-panel history entry into the bound frame. Returns
   * true when the drop was a generation — handled or not — so the caller stops
   * rather than falling through to the append path. The drag carries only a record
   * id; the pixels come back out of {@link GenerationHistoryService}.
   */
  private async applyDroppedGeneration(transfer: DataTransfer | null): Promise<boolean> {
    const payload = getGenerationDragData(transfer);
    if (!payload) {
      return false;
    }

    try {
      const record = await this.history.get(payload.id);
      if (record) {
        this.applyGeneratedImage({
          blob: record.blob,
          mimeType: record.mimeType,
          prompt: record.prompt,
          width: record.width,
          height: record.height,
        });
      }
    } catch (error) {
      console.warn('[SpriteEditor] Failed to read the dropped generation', error);
    }
    return true;
  }

  // -- background removal ----------------------------------------------------

  private async onRemoveBackground(): Promise<void> {
    if (!this.current) {
      return;
    }
    this.bgBusy = true;
    this.bgError = null;
    this.bgProgress = null;
    const sourceBlob = this.current.blob;

    try {
      const output = await this.bgRemoval.removeBackground(sourceBlob, {
        engine: this.bgEngine,
        quality: this.bgQuality,
        fillHoles: this.bgFillHoles,
        onProgress: progress => {
          this.bgProgress = progress;
        },
      });
      if (this.canWriteBackToFrame) {
        // Same-size replacement, so the restamp only re-stamps `sourceSize`.
        await this.writeBlobToBoundFrame(output, { kind: 'replace' }, 'Remove frame background');
        return;
      }
      const objectUrl = this.trackUrl(URL.createObjectURL(output));
      const size = await readImageSize(objectUrl);
      this.setCurrent({
        blob: output,
        mimeType: 'image/png',
        objectUrl,
        source: 'bg-removed',
        width: size?.width,
        height: size?.height,
      });
      // Background-removed output is transparent PNG — force a .png name so alpha is preserved.
      this.saveName = setImageExt(
        `${stripImageExt(normalizeRelativePath(this.saveName) || 'cutout')}-nobg`,
        'png'
      );
    } catch (error) {
      this.bgError = `Background removal failed: ${describeError(error)}`;
    } finally {
      this.bgBusy = false;
      this.bgProgress = null;
    }
  }

  // -- rotate / flip ---------------------------------------------------------

  private onRotate(): void {
    void this.applyTransform('rotated', { kind: 'rotate', quarterTurns: 1 }, blob =>
      rotateImageBlob(blob, 1)
    );
  }

  private onFlipHorizontal(): void {
    void this.applyFlip('horizontal');
  }

  private onFlipVertical(): void {
    void this.applyFlip('vertical');
  }

  private applyFlip(axis: FlipAxis): Promise<void> {
    return this.applyTransform('flipped', { kind: 'flip', axis }, blob =>
      flipImageBlob(blob, axis)
    );
  }

  /**
   * Run a geometric transform over the current working image and swap it in. The transform is a
   * plain canvas re-encode (no network / model), so it's cheap; `transformBusy` just guards against
   * overlapping clicks. The save name is intentionally left untouched.
   *
   * Frame-bound, the result is committed instead of held: a transient bake would
   * vanish on the next frame click, so each transform writes a new frame file and
   * takes one undo step (§9.5). `restamp` is how the document re-derives the
   * frame's anchor / points / bbox / polygon against the new raster.
   */
  private async applyTransform(
    source: CurrentSource,
    restamp: FrameRasterTransform,
    transform: (blob: Blob) => Promise<{ blob: Blob; width: number; height: number }>
  ): Promise<void> {
    if (!this.current || this.transformBusy || this.cropMode) {
      return;
    }
    this.transformBusy = true;
    try {
      const result = await transform(this.current.blob);
      if (this.canWriteBackToFrame) {
        await this.writeBlobToBoundFrame(result.blob, restamp, 'Transform frame');
        return;
      }
      const objectUrl = this.trackUrl(URL.createObjectURL(result.blob));
      this.setCurrent({
        blob: result.blob,
        mimeType: result.blob.type || this.current.mimeType,
        objectUrl,
        source,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      this.bgError = `Transform failed: ${describeError(error)}`;
    } finally {
      this.transformBusy = false;
    }
  }

  // -- stage view (zoom / pan) -----------------------------------------------

  /** Intrinsic size of the working image; the decoded element wins over cached metadata. */
  private getImageSize(): ImageSize | null {
    const image = this.stageImageRef.value;
    if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
      return { width: image.naturalWidth, height: image.naturalHeight };
    }
    const width = this.current?.width;
    const height = this.current?.height;
    if (width && height) {
      return { width, height };
    }
    return null;
  }

  /**
   * Size of the box the stage lays out and every overlay is measured against.
   *
   * For a bare image that is the image's intrinsic size. For a frame it is the
   * document controller's own `getFrameMetrics` — deliberately *its* number rather
   * than the decoded raster's, because that is the space the overlay pointer state
   * machine clamps and rounds in (`FrameOverlayController.resolveFramePoint`). Two
   * sources here would put a dragged vertex a few pixels off the one the user aimed
   * at on a UV-window frame.
   */
  private getStageContentSize(): ImageSize | null {
    const frame = this.boundFrame;
    const controller = this.documentController;
    if (frame && controller) {
      const metrics = controller.getFrameMetrics(frame);
      return { width: metrics.frameWidth, height: metrics.frameHeight };
    }
    return this.getImageSize();
  }

  /**
   * The content box the zoom/pan controller reasons about: the stage's own rect,
   * with the content's intrinsic size as the content size. The content element sits
   * at the stage's top-left and is moved by the pan, which is exactly the model
   * `toStageCoords` and `fitToViewport` assume.
   */
  private getStageViewport(): StageViewport | null {
    const stage = this.stageRef.value;
    const size = this.getStageContentSize();
    if (!stage || !size) {
      return null;
    }
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return { rect, contentWidth: size.width, contentHeight: size.height };
  }

  /** Pointer event → image pixels. Returns null before the image size is known. */
  private toImagePoint(event: PointerEvent): { point: StagePoint; size: ImageSize } | null {
    const viewport = this.getStageViewport();
    if (!viewport) {
      return null;
    }
    return {
      point: this.stageView.toStageCoords(event, viewport),
      size: { width: viewport.contentWidth, height: viewport.contentHeight },
    };
  }

  /**
   * The shell's half of the overlay coordinate contract (§9.2): a pointer event in
   * frame-pixel space, unclamped (the overlay controller clamps and rounds). One
   * line, because the canvas already uses the canonical model the overlays want —
   * content anchored top-left, pan the sole offset, content sized `size × zoom`.
   */
  private toFramePoint(event: PointerEvent): StagePoint | null {
    const viewport = this.getStageViewport();
    return viewport ? this.stageView.toStageCoords(event, viewport) : null;
  }

  private onStageWheel(event: WheelEvent): void {
    const viewport = this.getStageViewport();
    if (!viewport) {
      return;
    }
    event.preventDefault();
    // While placing, a plain wheel scales the *image* about the cursor; the stage's
    // own zoom moves to Ctrl+wheel so both are still reachable (§9.11.3).
    const session = this.placeSession;
    if (session && this.placeRect && !event.ctrlKey) {
      const pivot = this.stageView.toStageCoords(event, viewport);
      const factor = event.deltaY < 0 ? PLACE_WHEEL_STEP : 1 / PLACE_WHEEL_STEP;
      this.placeRect = clampPlaceScale(
        scalePlaceRect(this.placeRect, factor, pivot),
        session.image
      );
      return;
    }
    this.stageView.zoomAtPointer(event, viewport);
    this.hasUserAdjustedView = true;
  }

  private onAdjustZoom(direction: -1 | 1): void {
    this.stageView.adjustZoom(direction * 2);
    this.hasUserAdjustedView = true;
  }

  private onResetZoom(): void {
    this.stageView.reset();
    this.hasUserAdjustedView = true;
  }

  private onFitStageToView(): void {
    this.fitStageToViewport();
  }

  private fitStageToViewport(): void {
    const viewport = this.getStageViewport();
    if (!viewport) {
      return;
    }
    this.stageView.fitToViewport(viewport, STAGE_FIT_PADDING);
    // An explicit fit hands the view back to the stage, so resizes refit again.
    this.hasUserAdjustedView = false;
  }

  private observeStageResize(): void {
    if (this.stageResizeObserver || typeof ResizeObserver === 'undefined') {
      return;
    }
    const stage = this.stageRef.value;
    if (!stage) {
      return;
    }
    this.stageResizeObserver = new ResizeObserver(() => {
      if (!this.hasUserAdjustedView) {
        this.fitStageToViewport();
      }
    });
    this.stageResizeObserver.observe(stage);
  }

  /**
   * A frame's metrics can land *after* its raster decoded (the document reads the
   * texture on its own schedule and reports 256×256 until it does), so the fit
   * queued by `setCurrent` can be against the wrong box. Re-fit whenever the content
   * box changes and the user hasn't taken the view over.
   */
  private refitOnContentSizeChange(): void {
    const size = this.getStageContentSize();
    const key = size ? `${size.width}x${size.height}` : '';
    if (key === this.lastStageContentKey) {
      return;
    }
    this.lastStageContentKey = key;
    if (key && !this.hasUserAdjustedView) {
      this.fitStageToViewport();
    }
  }

  private onStageImageLoad(): void {
    if (this.pendingStageFit) {
      this.pendingStageFit = false;
      this.fitStageToViewport();
      return;
    }
    // The size may only now be known (element mounted before `current.width` was set).
    this.requestUpdate();
  }

  private onStagePointerDown(event: PointerEvent): void {
    // Middle-drag (or Alt+left) pans; plain left-drag belongs to the crop tool.
    if (this.stageView.beginPan(event)) {
      this.hasUserAdjustedView = true;
      // begin/endPan don't notify (only `setPan` does), so ask for the repaint
      // that swaps the grab cursor in and out.
      this.requestUpdate();
      event.preventDefault();
      return;
    }
    // A placement owns the stage while it is open: only its rect and handles start
    // a drag (they stop propagation before this runs), so a plain left-drag on the
    // background does nothing — there is no rubber-band in place mode.
    if (this.placeSession) {
      return;
    }
    // A frame overlay tool owns the plain left-drag when one is picked; crop keeps
    // it otherwise. They are mutually exclusive by construction (`setStageTool`).
    if (!this.cropMode && this.stageTool !== 'select' && this.boundFrame) {
      this.overlays.handlePointerDown(event);
      return;
    }
    if (!this.cropMode || event.button !== 0) {
      return;
    }
    const resolved = this.toImagePoint(event);
    if (!resolved) {
      return;
    }
    const point = clampToImage(resolved.point, resolved.size);
    this.cropDrag = {
      mode: 'draw',
      edges: '',
      originX: point.x,
      originY: point.y,
      startRectX: point.x,
      startRectY: point.y,
      startRectW: 0,
      startRectH: 0,
    };
    this.cropRect = { x: point.x, y: point.y, w: 0, h: 0 };
    this.stageRef.value?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private onStagePointerMove(event: PointerEvent): void {
    if (this.stageView.updatePan(event)) {
      return;
    }
    const placeDrag = this.placeDrag;
    if (placeDrag) {
      const placePoint = this.toImagePoint(event);
      if (placePoint) {
        this.placeRect = applyPlaceDrag(placeDrag, placePoint.point);
      }
      return;
    }
    if (this.overlays.isDragging) {
      this.overlays.handlePointerMove(event);
      return;
    }
    const drag = this.cropDrag;
    if (!drag) {
      return;
    }
    const resolved = this.toImagePoint(event);
    if (!resolved) {
      return;
    }
    this.cropRect = applyCropDrag(drag, resolved.point, resolved.size);
  }

  private onStagePointerUp(event: PointerEvent): void {
    if (this.stageView.endPan(event)) {
      this.requestUpdate();
      return;
    }
    if (this.placeDrag) {
      this.releaseStagePointer(event);
      this.placeDrag = null;
      return;
    }
    if (this.overlays.isDragging) {
      void this.overlays.handlePointerUp(event);
      return;
    }
    if (!this.cropDrag) {
      return;
    }
    this.releaseStagePointer(event);
    this.cropDrag = null;
  }

  private releaseStagePointer(event: PointerEvent): void {
    const stage = this.stageRef.value;
    if (stage?.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
  }

  // -- crop ------------------------------------------------------------------

  private onToggleCrop(): void {
    if (!this.current) {
      return;
    }
    // Crop and place own the same left-drag; opening one closes the other.
    this.closePlaceSession();
    this.cropMode = !this.cropMode;
    this.cropRect = null;
    this.cropDrag = null;
    if (this.cropMode) {
      this.stageTool = 'select';
    }
  }

  private onCancelCrop(): void {
    this.cropMode = false;
    this.cropRect = null;
    this.cropDrag = null;
  }

  private initCropRect(): void {
    if (this.cropRect || !this.cropMode) {
      return;
    }
    const size = this.getImageSize();
    if (!size) {
      return;
    }
    this.cropRect = initialCropRect(size);
  }

  private beginCropDrag(event: PointerEvent, mode: 'move' | 'resize', edges: string): void {
    // Pan gestures (middle button, Alt+left) belong to the stage even when they
    // start on the selection — let them bubble instead of grabbing them here.
    if (event.button !== 0 || event.altKey || !this.cropRect) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const resolved = this.toImagePoint(event);
    if (!resolved) {
      return;
    }
    this.cropDrag = {
      mode,
      edges,
      originX: resolved.point.x,
      originY: resolved.point.y,
      startRectX: this.cropRect.x,
      startRectY: this.cropRect.y,
      startRectW: this.cropRect.w,
      startRectH: this.cropRect.h,
    };
    this.stageRef.value?.setPointerCapture(event.pointerId);
  }

  private async onApplyCrop(): Promise<void> {
    const image = this.stageImageRef.value;
    const rect = this.cropRect;
    const size = this.getImageSize();
    if (!image || !rect || !size || !this.current) {
      return;
    }

    const pixels = cropRectToPixels(rect, size);
    if (!pixels) {
      return;
    }
    const { sx, sy, sw, sh } = pixels;

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(result => resolve(result), 'image/png')
    );
    if (!blob) {
      return;
    }

    this.cropMode = false;
    this.cropRect = null;
    this.cropDrag = null;

    if (this.canWriteBackToFrame) {
      // §9.5 in one line: the crop origin is all the document needs to keep the
      // frame's anchor, points, bbox and polygon on the same pixels.
      await this.writeBlobToBoundFrame(blob, { kind: 'crop', x: sx, y: sy }, 'Crop frame');
    } else {
      const objectUrl = this.trackUrl(URL.createObjectURL(blob));
      this.setCurrent({
        blob,
        mimeType: 'image/png',
        objectUrl,
        source: 'cropped',
        width: sw,
        height: sh,
      });
      this.saveName = setImageExt(
        `${stripImageExt(normalizeRelativePath(this.saveName) || 'cropped')}-crop`,
        'png'
      );
    }

    // Crop bakes keep landing in the generation history: it is the cheap escape
    // hatch for a pixel-destructive edit undo cannot restore (§9.7 risk 7), and it
    // is now the Generate panel that shows the strip. The generation metadata comes
    // straight from the stored preferences — the shell no longer owns a model picker.
    const prefs = this.aiSettings.getPreferences();
    const providerId = prefs.selectedProviderId;
    try {
      await this.history.add({
        providerId,
        modelId: this.aiSettings.getSelectedModelId(providerId) ?? '',
        prompt: this.lastPrompt.trim() ? `${this.lastPrompt.trim()} (crop)` : 'Cropped image',
        aspectRatio: prefs.defaultAspectRatio,
        imageSize: prefs.defaultImageSize,
        mimeType: 'image/png',
        blob,
        width: sw,
        height: sh,
      });
    } catch (error) {
      console.warn('[SpriteEditor] Failed to add crop to history', error);
    }
  }

  // -- place mode (§9.11) ----------------------------------------------------

  /**
   * Start positioning `image` over the bound frame. Returns false when there is no
   * frame to place into, in which case the caller falls back to the straight
   * write-back. Seeds `fit` deliberately: nothing is cut before the user has said
   * anything.
   */
  private openPlaceSession(
    image: GeneratedImagePayload,
    incoming: ImageSize,
    frame: ImageSize
  ): boolean {
    const controller = this.documentController;
    const frameIndex = controller?.selectedFrameIndex ?? -1;
    const texturePath = this.boundFrameTexturePath;
    if (!controller || frameIndex < 0 || !texturePath) {
      return false;
    }

    this.closePlaceSession();
    this.placeSession = {
      blob: image.blob,
      mimeType: image.mimeType,
      objectUrl: this.trackUrl(URL.createObjectURL(image.blob)),
      image: incoming,
      frame,
      prompt: image.prompt,
      frameIndex,
      texturePath,
    };
    this.placeRect = quickFitRect(incoming, frame, 'fit');
    // Crop and the overlay tools all want the plain left-drag place mode now owns.
    this.cropMode = false;
    this.cropRect = null;
    this.cropDrag = null;
    this.stageTool = 'select';
    return true;
  }

  /** Discard the session and give its object URL back. Safe to call with none open. */
  private closePlaceSession(): void {
    const session = this.placeSession;
    this.placeDrag = null;
    if (!session) {
      return;
    }
    this.placeSession = null;
    this.placeRect = null;
    this.revokeUrl(session.objectUrl);
  }

  /**
   * A frame click — or anything else that repoints the canvas — while a placement
   * is open throws it away. Acceptable *only* because the generation is still in
   * the Generate panel's history strip, which is the escape hatch for every
   * pixel-level action here (§9.7 risk 7).
   */
  private syncPlaceSessionToFrame(): void {
    const session = this.placeSession;
    if (!session) {
      return;
    }
    const controller = this.documentController;
    if (
      !controller ||
      controller.selectedFrameIndex !== session.frameIndex ||
      this.boundFrameTexturePath !== session.texturePath
    ) {
      this.closePlaceSession();
    }
  }

  /**
   * The placed image, its scrim and its rect — laid out in frame pixels × zoom
   * inside `.ag-stage-content`, exactly like the crop rect. The image itself takes
   * no pointer events; the outline and its four corner handles do.
   *
   * Paint order is load-bearing and none of these carry a `z-index`: the image goes
   * down **first**, the scrims over it, the outline last. Dimming has to fall on the
   * overhang — that is the whole message ("this part will be cut"), and with the
   * scrims underneath the image it read as if the overhang would be kept.
   */
  private renderPlaceOverlay(session: PlaceSession, rect: PlaceRect, zoom: number) {
    const style = `left:${rect.x * zoom}px; top:${rect.y * zoom}px; width:${rect.w * zoom}px; height:${rect.h * zoom}px`;
    // The raster's *own* magnification, not the stage's: a 32px sprite blown up to
    // fill a 256px frame wants hard edges even at 100% stage zoom.
    const rasterZoom = session.image.width > 0 ? (rect.w / session.image.width) * zoom : zoom;
    return html`
      <img
        class="ag-place-image ${rasterZoom >= PIXELATED_ZOOM_THRESHOLD ? 'is-pixelated' : ''}"
        src=${session.objectUrl}
        alt="Image being placed"
        draggable="false"
        style=${style}
        ${ref(this.placeImageRef)}
      />
      <div class="ag-place-scrim ag-place-scrim--top" aria-hidden="true"></div>
      <div class="ag-place-scrim ag-place-scrim--right" aria-hidden="true"></div>
      <div class="ag-place-scrim ag-place-scrim--bottom" aria-hidden="true"></div>
      <div class="ag-place-scrim ag-place-scrim--left" aria-hidden="true"></div>
      <div
        class="ag-place-rect"
        style=${style}
        @pointerdown=${(event: PointerEvent) => this.beginPlaceDrag(event, 'move', '')}
      >
        ${PLACE_HANDLES.map(
          corner =>
            html`<span
              class="ag-place-handle ag-place-handle--${corner}"
              @pointerdown=${(event: PointerEvent) => this.beginPlaceDrag(event, 'resize', corner)}
            ></span>`
        )}
      </div>
    `;
  }

  /**
   * Replaces the crop toolbar while a placement is open — the two can never both be
   * active. The three quick actions are plain text buttons on purpose: this toolbar
   * is transient and words beat three invented glyphs (§9.11.3).
   */
  private renderPlaceToolbar() {
    const session = this.placeSession;
    if (!session) {
      return null;
    }
    const rect = this.placeRect;
    return html`
      <div class="ag-place-toolbar">
        <span class="ag-place-dims">${rect ? describePlaceRect(rect, session.image) : ''}</span>
        <button
          class="ag-place-quick"
          type="button"
          title="Scale the whole image to fit inside the frame"
          @click=${() => this.onPlaceQuickFit('fit')}
        >
          Fit
        </button>
        <button
          class="ag-place-quick"
          type="button"
          title="Scale the image to cover the frame, cutting the overflow"
          @click=${() => this.onPlaceQuickFit('fill')}
        >
          Fill
        </button>
        <button
          class="ag-place-quick"
          type="button"
          title="Write the image as-is and let the frame take its size"
          @click=${this.onResizeFrameToImage}
        >
          Resize frame to image
        </button>
        <div class="ag-prompt-spacer"></div>
        <button class="ag-cancel-button" @click=${this.onCancelPlace}>Cancel</button>
        <button
          class="ag-generate-button ag-crop-apply"
          ?disabled=${!isApplicablePlaceRect(rect)}
          @click=${this.onApplyPlace}
        >
          Apply
        </button>
      </div>
    `;
  }

  private onPlaceQuickFit(mode: PlaceQuickFit): void {
    const session = this.placeSession;
    if (!session) {
      return;
    }
    this.placeRect = quickFitRect(session.image, session.frame, mode);
  }

  private onCancelPlace = (): void => {
    this.closePlaceSession();
  };

  private beginPlaceDrag(event: PointerEvent, mode: PlaceDragMode, corner: string): void {
    // Pan gestures (middle button, Alt+left) belong to the stage even when they
    // start on the placement — let them bubble instead of grabbing them here.
    if (event.button !== 0 || event.altKey || !this.placeRect) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const resolved = this.toImagePoint(event);
    if (!resolved) {
      return;
    }
    this.placeDrag = {
      mode,
      corner,
      originX: resolved.point.x,
      originY: resolved.point.y,
      startRect: { ...this.placeRect },
    };
    this.stageRef.value?.setPointerCapture(event.pointerId);
  }

  /**
   * Bake the placement (§9.11.4). The canvas is the *frame's* size, not the
   * incoming image's, so `buildFramePixelMap`'s `replace` case is the identity:
   * anchor, points, bbox and polygon all survive untouched and `sourceSize` is
   * re-stamped to the same numbers. The frame rect did not move — only its pixels.
   */
  private onApplyPlace = async (): Promise<void> => {
    const session = this.placeSession;
    const rect = this.placeRect;
    const image = this.placeImageRef.value;
    if (!session || !rect || !image || !isApplicablePlaceRect(rect)) {
      return;
    }

    const width = Math.max(1, Math.round(session.frame.width));
    const height = Math.max(1, Math.round(session.frame.height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    // No fill: `fit` letterboxing has to be alpha, not black.
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      image,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.max(1, Math.round(rect.w)),
      Math.max(1, Math.round(rect.h))
    );

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(result => resolve(result), 'image/png')
    );
    if (!blob) {
      return;
    }

    const prompt = session.prompt;
    // Closed before the write-back, exactly as crop does — the frame is about to
    // rebind onto the file this bake creates.
    this.closePlaceSession();
    await this.writeBlobToBoundFrame(blob, { kind: 'replace' }, 'Place into frame');
    await this.addBakeToHistory(
      blob,
      prompt.trim() ? `${prompt.trim()} (placed)` : 'Placed image',
      width,
      height
    );
  };

  /**
   * "Resize frame to image" is not a composite: the incoming bytes go through
   * untouched and the frame takes their size, which is precisely the pre-place-mode
   * behaviour. Deliberately not routed through the canvas.
   */
  private onResizeFrameToImage = async (): Promise<void> => {
    const session = this.placeSession;
    if (!session) {
      return;
    }
    const blob = session.blob;
    this.closePlaceSession();
    await this.writeBlobToBoundFrame(blob, { kind: 'replace' }, 'Resize frame to image');
  };

  /**
   * Push a bake into the generation strip. Undo cannot restore pixels (§9.7 risk
   * 7), so every destructive bake leaves a copy there as the escape hatch. The
   * generation metadata comes from the stored preferences — the shell no longer
   * owns a model picker.
   */
  private async addBakeToHistory(
    blob: Blob,
    prompt: string,
    width: number,
    height: number
  ): Promise<void> {
    const prefs = this.aiSettings.getPreferences();
    const providerId = prefs.selectedProviderId;
    try {
      await this.history.add({
        providerId,
        modelId: this.aiSettings.getSelectedModelId(providerId) ?? '',
        prompt,
        aspectRatio: prefs.defaultAspectRatio,
        imageSize: prefs.defaultImageSize,
        mimeType: 'image/png',
        blob,
        width,
        height,
      });
    } catch (error) {
      console.warn('[SpriteEditor] Failed to add bake to history', error);
    }
  }

  // -- result actions --------------------------------------------------------

  private async onSaveToProject(): Promise<string | null> {
    if (!this.current) {
      return null;
    }
    const output = await this.resolveSaveBlob();
    if (!output) {
      return null;
    }
    const relativePath = ensureImageExt(normalizeRelativePath(this.saveName), output.mimeType);
    if (!relativePath) {
      this.saveError = 'Enter a file name.';
      return null;
    }
    this.saveError = null;
    this.saveMessage = null;
    try {
      await this.ensureParentDirectory(relativePath);
      const buffer = await output.blob.arrayBuffer();
      await this.storage.writeBinaryFile(relativePath, buffer);
      this.saveMessage = this.describeSaveResult(relativePath, output.blob);
      return relativePath;
    } catch (error) {
      this.saveError = `Save failed: ${describeError(error)}`;
      return null;
    }
  }

  /**
   * Save the current image into the personal Asset Library (editor-level; no project needed).
   * The blob becomes a one-file `image` bundle; the file name (minus folders) seeds the item name.
   */
  private onSaveToLibrary = async (): Promise<void> => {
    if (!this.current) {
      return;
    }
    const output = await this.resolveSaveBlob();
    if (!output) {
      return;
    }
    const fileName = ensureImageExt(normalizeRelativePath(this.saveName), output.mimeType)
      .split('/')
      .pop();
    if (!fileName) {
      this.saveError = 'Enter a file name.';
      return;
    }
    const name = fileName.replace(/\.[^.]+$/, '') || 'Generated image';
    this.saveError = null;
    this.saveMessage = null;
    try {
      const slug = await this.assetLibrary.suggestSlug(name);
      const files = new Map<string, Blob>([[fileName, output.blob]]);
      await this.assetLibrary.putUserItem({
        manifest: {
          id: crypto.randomUUID(),
          slug,
          name,
          type: 'image',
          tags: ['generated'],
          description: this.lastPrompt || undefined,
          preview: fileName,
          entry: fileName,
          files: [fileName],
          source: 'generated',
          createdAt: 0,
          updatedAt: 0,
        },
        files,
      });
      this.saveMessage = `Saved "${name}" to your library.`;
    } catch (error) {
      this.saveError = `Save to Library failed: ${describeError(error)}`;
    }
  };

  /** Human-readable confirmation, noting the downscaled dimensions when a resize was applied. */
  private describeSaveResult(path: string, blob: Blob): string {
    if (this.saveMaxSize > 0 && this.current?.width && this.current.height) {
      const target = scaledDimensions(this.current.width, this.current.height, this.saveMaxSize);
      return `Saved to ${path} (${target.width}×${target.height}, ${formatBytes(blob.size)})`;
    }
    return `Saved to ${path}`;
  }

  private async onInsertSprite(): Promise<void> {
    const savedPath = await this.onSaveToProject();
    if (!savedPath) {
      return;
    }
    try {
      const texturePath = toProjectResourcePath(savedPath);
      const didMutate = await this.commandDispatcher.execute(
        new CreateSprite2DCommand({
          texturePath,
          spriteName: deriveNodeName(savedPath),
        })
      );
      this.saveMessage = didMutate
        ? `Inserted Sprite2D from ${savedPath}`
        : 'Could not insert Sprite2D — open a 2D scene first.';
    } catch (error) {
      this.saveError = `Insert failed: ${describeError(error)}`;
    }
  }

  private async onOverwriteOriginal(): Promise<void> {
    if (!this.current || !this.boundImagePath) {
      return;
    }
    const output = await this.resolveSaveBlob();
    if (!output) {
      return;
    }
    this.saveError = null;
    this.saveMessage = null;
    try {
      const buffer = await output.blob.arrayBuffer();
      await this.storage.writeBinaryFile(this.boundImagePath, buffer);
      this.saveMessage = this.describeSaveResult(this.boundImagePath, output.blob).replace(
        'Saved to',
        'Overwrote'
      );
    } catch (error) {
      this.saveError = `Overwrite failed: ${describeError(error)}`;
    }
  }

  private async onDownload(): Promise<void> {
    if (!this.current) {
      return;
    }
    const output = await this.resolveSaveBlob();
    if (!output) {
      return;
    }
    const url = URL.createObjectURL(output.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = ensureImageExt(
      normalizeRelativePath(this.saveName) || 'generated',
      output.mimeType
    )
      .split('/')
      .pop()!;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // -- spritesheet actions ----------------------------------------------------

  /**
   * Ask for a slice grid. Shares the animation editor's dialog (generalised in Phase 2) so the
   * grid preview/overlay is identical wherever slicing is offered.
   */
  private async askForSliceGrid(
    copy: Pick<
      Parameters<AnimationAutoSliceDialogService['showDialog']>[0],
      'contextCaption' | 'confirmNote' | 'confirmLabel' | 'cancelLabel'
    >
  ): Promise<{ columns: number; rows: number } | null> {
    const imagePath = this.boundImagePath;
    if (!imagePath) {
      return null;
    }
    const result = await this.sliceDialog.showDialog({
      texturePath: imagePath,
      contextLabel: deriveNodeName(imagePath),
      defaultColumns: this.sliceColumns,
      defaultRows: this.sliceRows,
      ...copy,
    });
    if (!result) {
      return null;
    }
    this.sliceColumns = result.columns;
    this.sliceRows = result.rows;
    return result;
  }

  /**
   * Cut the bound image into individual PNG files in a `<name>_frames/` folder next to it. Pure
   * file output — no `.pix3anim` and no scene mutation, so no Command/Operation (matching the
   * Save-to-project precedent: project-file writes are not undoable app-state mutations).
   */
  private async onSliceIntoFrames(): Promise<void> {
    const imagePath = this.boundImagePath;
    if (!imagePath || this.sliceBusy) {
      return;
    }
    const stem = deriveNodeName(imagePath);
    const relative = normalizeRelativePath(imagePath);
    const slashIndex = relative.lastIndexOf('/');
    const folder = `${slashIndex >= 0 ? `${relative.slice(0, slashIndex)}/` : ''}${stem}_frames`;

    const grid = await this.askForSliceGrid({
      contextCaption: 'Spritesheet',
      confirmNote: `Frames are written to ${folder}/frame_0001.png …`,
      confirmLabel: 'Slice Into Files',
      cancelLabel: 'Cancel',
    });
    if (!grid) {
      return;
    }

    this.sliceBusy = true;
    this.sliceStatus = null;
    try {
      const source = this.current?.blob ?? (await this.storage.readBlob(imagePath));
      const cells = await sliceImageBlob(source, grid);
      await this.ensureParentDirectory(`${folder}/frame.png`);
      for (const [index, cell] of cells.entries()) {
        const framePath = `${folder}/frame_${String(index + 1).padStart(4, '0')}.png`;
        await this.storage.writeBinaryFile(framePath, await cell.arrayBuffer());
      }
      this.sliceStatus = {
        text: `Sliced into ${cells.length} frames in ${folder}/`,
        isError: false,
      };
    } catch (error) {
      this.sliceStatus = { text: `Slice failed: ${describeError(error)}`, isError: true };
    } finally {
      this.sliceBusy = false;
    }
  }

  /**
   * Turn the bound image into a **managed sprite folder**: `<dir>/<stem>/<stem>.pix3anim` plus
   * `<clip>_<nnnn>.png` frame files, then open the animation editor on it. A 1×1 grid is a valid
   * answer — it produces a one-frame clip from a single image.
   */
  private async onCreateAnimation(): Promise<void> {
    const imagePath = this.boundImagePath;
    if (!imagePath || this.sliceBusy) {
      return;
    }
    const assetPath = buildManagedSpriteAssetPath(imagePath);
    const folder = getAnimationAssetDirectory(assetPath).replace(/^res:\/\//, '');
    const clipName = 'idle';

    const grid = await this.askForSliceGrid({
      contextCaption: 'New animation',
      confirmNote: `Creates ${folder}/${deriveAnimationAssetStem(assetPath)}.pix3anim with the frames beside it.`,
      confirmLabel: 'Create Animation',
      cancelLabel: 'Cancel',
    });
    if (!grid) {
      return;
    }

    this.sliceBusy = true;
    this.sliceStatus = null;
    try {
      const source = this.current?.blob ?? (await this.storage.readBlob(imagePath));
      const cells = await sliceImageBlob(source, grid);
      await this.ensureParentDirectory(`${folder}/frame.png`);

      // Every cell of a grid slice is the same size — decode one and stamp all
      // frames with it so `sizeMode: 'native'` layout never waits on a load.
      const cellSize = cells.length > 0 ? await readBlobSize(cells[0]) : null;
      const framePaths: string[] = [];
      for (const [index, cell] of cells.entries()) {
        const framePath = buildAnimationFrameResourcePath(assetPath, index + 1, { clipName });
        await this.storage.writeBinaryFile(framePath, await cell.arrayBuffer());
        framePaths.push(framePath);
      }

      const resource = normalizeAnimationResource({
        version: '1.0.0',
        texturePath: '',
        clips: [
          {
            name: clipName,
            fps: 12,
            loop: true,
            playbackMode: 'normal',
            frames: framePaths.map(texturePath => ({
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0.5, y: 0.5 },
              texturePath,
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
              sourceSize: cellSize ? { width: cellSize.width, height: cellSize.height } : undefined,
            })),
          },
        ],
      });

      const didMutate = await this.commandDispatcher.execute(
        new CreateAnimationAssetCommand({
          assetPath,
          texturePath: '',
          initialClipName: clipName,
          resource,
          overwrite: true,
        })
      );
      if (!didMutate) {
        this.sliceStatus = { text: 'Could not create the animation asset.', isError: true };
        return;
      }

      this.sliceStatus = {
        text: `Created a ${framePaths.length}-frame animation in ${folder}/`,
        isError: false,
      };
      await this.editorTabs.focusOrOpenAnimation(assetPath);
    } catch (error) {
      this.sliceStatus = {
        text: `Create animation failed: ${describeError(error)}`,
        isError: true,
      };
    } finally {
      this.sliceBusy = false;
    }
  }

  // -- helpers ---------------------------------------------------------------

  private clearCurrent(): void {
    const previous = this.current;
    if (!previous) {
      return;
    }
    this.current = null;
    this.revokeUrl(previous.objectUrl);
    this.cropMode = false;
    this.cropRect = null;
    this.cropDrag = null;
  }

  private setCurrent(next: CurrentImage): void {
    const previous = this.current;
    this.current = next;
    if (previous && previous.objectUrl !== next.objectUrl) {
      this.revokeUrl(previous.objectUrl);
    }
    // A new working image gets a fresh view: the fit runs once the <img> has
    // decoded and can report its intrinsic size.
    this.pendingStageFit = true;
  }

  private async ensureParentDirectory(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    segments.pop();
    let accumulated = '';
    for (const segment of segments) {
      if (!segment) {
        continue;
      }
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      try {
        await this.storage.createDirectory(accumulated);
      } catch {
        // directory likely already exists
      }
    }
  }

  private trackUrl(url: string): string {
    this.ownedUrls.add(url);
    return url;
  }

  private revokeUrl(url: string): void {
    if (this.ownedUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.ownedUrls.delete(url);
    }
  }

  private revokeAllUrls(): void {
    for (const url of this.ownedUrls) {
      URL.revokeObjectURL(url);
    }
    this.ownedUrls.clear();
  }
}

// -- module-level utilities --------------------------------------------------

const readImageSize = (objectUrl: string): Promise<{ width: number; height: number } | null> =>
  new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = objectUrl;
  });

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * Whether a tab's resource is an animation *document*. The tab type is the real
 * signal; this is the fallback for the synthetic/detached cases (and it keeps the
 * shell honest if a `.pix3anim` ever arrives on a differently-typed tab).
 */
const isAnimationResourcePath = (resourceId: string): boolean =>
  /\.pix3anim$/i.test(resourceId.split('?')[0]);

const normalizeRelativePath = (path: string): string =>
  path
    .trim()
    .replace(/^res:\/\//, '')
    .replace(/\\+/g, '/')
    .replace(/^\/+/, '');

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

const extForMime = (mimeType: string): string =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';

const stripImageExt = (path: string): string => path.replace(IMAGE_EXT_RE, '');

/** Append a mime-derived extension only when the path doesn't already carry an image extension. */
const ensureImageExt = (path: string, mimeType: string): string => {
  if (!path) {
    return path;
  }
  return IMAGE_EXT_RE.test(path) ? path : `${path}.${extForMime(mimeType)}`;
};

/** Force a specific extension (used for background-removed output, which must stay PNG). */
const setImageExt = (path: string, ext: string): string => `${stripImageExt(path)}.${ext}`;

const deriveSaveName = (prompt: string, boundPath: string | null, mimeType: string): string => {
  const base = slugify(prompt) || 'generated';
  if (boundPath) {
    const relative = normalizeRelativePath(boundPath);
    const slashIndex = relative.lastIndexOf('/');
    const folder = slashIndex >= 0 ? relative.slice(0, slashIndex) : '';
    return ensureImageExt(folder ? `${folder}/${base}` : base, mimeType);
  }
  // Images live under the project-root `sprites/` folder (flat project layout); the
  // `generated/` bucket keeps AI output out of the hand-curated sprites.
  return ensureImageExt(`sprites/generated/${base}`, mimeType);
};

const deriveNodeName = (path: string): string => {
  const fileName = path.split('/').pop() ?? 'Sprite2D';
  const dotIndex = fileName.lastIndexOf('.');
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return base || 'Sprite2D';
};

const describeError = (error: unknown): string => {
  if (error instanceof ImageGenError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
};

/**
 * §9.12.1 step 6 — say what happened. A clip of UV-window frames trims *nothing*,
 * and silence there reads as a broken button, so the skips are always spelled out.
 */
const describeTrimReport = (report: TrimClipReport, clipName: string): string => {
  const parts: string[] = [];
  if (report.trimmed > 0) {
    parts.push(`Trimmed ${report.trimmed} frame${report.trimmed === 1 ? '' : 's'} of ${clipName}`);
  } else {
    parts.push(`Nothing to trim in ${clipName}`);
  }
  if (report.skipped > 0) {
    parts.push(`${report.skipped} skipped`);
  }
  if (report.failed > 0) {
    parts.push(`${report.failed} failed`);
  }
  return `${parts.join(', ')}.`;
};

declare global {
  interface HTMLElementTagNameMap {
    'pix3-sprite-editor-panel': SpriteEditorPanel;
  }
}
