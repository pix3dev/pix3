import { subscribe } from 'valtio/vanilla';

import { UpdateAnimationDocumentOperation } from '@/features/properties/UpdateAnimationDocumentOperation';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import {
  buildAnimationFrameResourcePath,
  deriveAnimationDocumentId,
  normalizeAnimationAssetPath,
  sanitizeFrameFilePrefix,
} from '@/features/scene/animation-asset-utils';
import { appState } from '@/state';
import {
  readAlphaMask,
  readBlobSize,
  sliceImageBlob,
  trimImageBlob,
  type AlphaMask,
} from '@/services/image-gen/image-ops';
import type { AnimationAutoSliceDialogService } from '@/services/animation/AnimationAutoSliceDialogService';
import type {
  AnimationEditorService,
  AnimationInspectorController,
  AnimationInspectorSnapshot,
} from '@/services/animation/AnimationEditorService';
import type { CommandDispatcher } from '@/services/core/CommandDispatcher';
import type { DialogService } from '@/services/editor/DialogService';
import type { OperationService } from '@/services/core/OperationService';
import type { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import type { StagePoint } from '@/ui/shared/stage-zoom-pan';
import { traceCollisionPolygon, DEFAULT_CONTOUR_TOLERANCE } from './contour-trace';
import { restampFrameGeometry, type FrameRasterTransform } from './frame-restamp';
import {
  AnimatedSprite2D,
  collectClipPointNames,
  findAnimationFramePoint,
  getAnimationFrameTexturePath,
  isSequenceAnimationFrame,
  normalizeAnimationResource,
  type AnimationClip,
  type AnimationFrame,
  type AnimationPlaybackMode,
  type AnimationResource,
  type AnimationSize,
  type AssetLoader,
  type SceneManager,
} from '@pix3/runtime';

/**
 * Services the controller needs. Deliberately a plain object rather than `@inject`
 * decorators: the controller is shared by several Lit roots at once (the editor
 * shell, the timeline, the clips rail and — through {@link AnimationEditorService} —
 * the Inspector in a different Golden Layout panel), so DI stays in the host
 * component and the controller takes what it is handed.
 */
export interface AnimationDocumentControllerDeps {
  /** Every document mutation goes through `invokeAndPush(UpdateAnimationDocumentOperation)`. */
  operations: OperationService;
  /** Keeps a selected AnimatedSprite2D's `currentClip` in step with the editor. */
  commandDispatcher: CommandDispatcher;
  /** Frame-file writes and texture-preview reads. */
  projectStorage: ProjectStorageService;
  /** Registration point for the Inspector-facing controller. */
  animationEditorService: AnimationEditorService;
  autoSliceDialog: AnimationAutoSliceDialogService;
  /** Remove-clip confirmation. */
  dialogService: DialogService;
  sceneManager: SceneManager;
  /**
   * Play-mode texture cache to evict when frame pixels change on disk (§9.5
   * step 4). Optional: only a host that offers the raster tools has to wire it,
   * so headless specs and the legacy animation panel stay dependency-free.
   */
  assetLoader?: AssetLoader;
  /**
   * Editor viewport, for the proxy-cache eviction plus the mandatory repaint —
   * file writes sit outside the dirty-marking paths, so without it the change
   * only shows up on the ≤500 ms heartbeat (CLAUDE.md render-on-demand rule).
   * Optional for the same reason as {@link assetLoader}.
   */
  viewportRenderer?: ViewportRendererService;
}

/**
 * Everything {@link AnimationDocumentController.replaceFrameTexture} needs beyond
 * the pixels themselves.
 */
export interface ReplaceFrameTextureOptions {
  /** How the new raster relates to the old one; drives the geometry restamp. */
  restamp: FrameRasterTransform;
  /**
   * Pixel size the transform was authored against. Defaults to the frame's own
   * `sourceSize`/decoded metrics; pass it when the caller *knows* better — the
   * crop tool does, because it measured the decoded raster it cut.
   */
  sourceSize?: AnimationSize;
  /** Undo-history label; defaults to "Replace frame N pixels: <clip>". */
  label?: string;
  /** File extension for the new frame file (no dot). Defaults to `png`. */
  extension?: string;
}

/** Knobs {@link AnimationDocumentController.trimClipFrames} hands to `trimImageBlob`. */
export interface TrimClipFramesOptions {
  /** Transparent margin (px) kept around the content on every side. Default 0. */
  padding?: number;
  /**
   * Alpha (0..255) at or below which a pixel counts as empty. Default 0 — only
   * fully transparent pixels trim away. ~8 also eats the near-transparent halo a
   * background removal leaves behind (see `TrimOptions`).
   */
  alphaThreshold?: number;
}

/**
 * Outcome of a clip-wide trim. `skipped` is the *expected* category (UV-window
 * frames, frames whose raster size isn't known yet, empty frames, frames that are
 * already tight); `failed` means a read/trim/write threw for that frame.
 */
export interface TrimClipReport {
  trimmed: number;
  skipped: number;
  failed: number;
}

/**
 * Knobs {@link AnimationDocumentController.traceSelectedFramePolygon} hands to the
 * §9.12.2 tracer.
 */
export interface AutoPolygonOptions {
  /**
   * Douglas–Peucker tolerance in frame pixels: no polygon edge strays further than
   * this from the traced alpha outline. Default {@link DEFAULT_CONTOUR_TOLERANCE}.
   */
  tolerance?: number;
  /**
   * Alpha (0..255) at or below which a pixel counts as empty. Default 0 — the same
   * meaning it has for a trim.
   */
  alphaThreshold?: number;
}

/** Outcome of one auto-trace. Nothing is committed; the polygon lands in the draft. */
export interface AutoPolygonReport {
  /**
   * `traced` — the frame draft now carries the polygon, awaiting a commit;
   * `no-frame` — no frame selected, or the frame is a UV window into a shared
   * sheet whose alpha is not this frame's outline; `unreadable` — the texture
   * could not be decoded; `empty` — the frame has no opaque pixels, and the
   * existing polygon was left alone rather than replaced with nothing.
   */
  status: 'traced' | 'no-frame' | 'unreadable' | 'empty';
  vertexCount: number;
}

export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'tif',
  'tiff',
  'avif',
]);

export function hasSupportedImageExtension(path: string): boolean {
  const cleaned = path.split('?')[0].split('#')[0];
  const extension = cleaned.includes('.') ? (cleaned.split('.').pop()?.toLowerCase() ?? '') : '';
  return IMAGE_EXTENSIONS.has(extension);
}

interface TextureDimensions {
  width: number;
  height: number;
}

const DEFAULT_FRAME_ANCHOR: StagePoint = { x: 0.5, y: 0.5 };

/**
 * The animation *document*: everything about a `.pix3anim` that is not markup —
 * which clip and frames are selected, the preview transport, the texture-preview
 * cache, and every mutation (all of which flow through
 * {@link UpdateAnimationDocumentOperation}, never a direct write to `appState` or
 * the resource).
 *
 * A plain class, not a Lit `ReactiveController`: hosts subscribe with
 * {@link subscribe} and re-render, so one instance can drive several components at
 * once. The host owns the rAF ticker for preview playback (a DOM concern) and
 * calls {@link advancePlayback}; the *state and stepping math* live here because
 * the stage renders `previewFrameIndex` too.
 */
export class AnimationDocumentController implements AnimationInspectorController {
  private tabId: string;
  private resourcePath: string;

  private _assetPath: string | null = null;
  private _resource: AnimationResource | null = null;
  private _activeClipName = '';
  private _selectedFrameIndex = -1;
  private _selectedFrameIndices: number[] = [];
  private _previewFrameIndex = -1;
  private _isPreviewPlaying = false;
  private _frameDraft: AnimationFrame | null = null;
  private _errorMessage: string | null = null;

  private animationId: string | null = null;
  private isAttached = false;
  private loadToken = 0;
  private previewElapsedSeconds = 0;
  private previewDirection = 1;
  private selectionAnchorFrameIndex = -1;
  private slicerColumns = 1;
  private slicerRows = 1;
  private previewTexturePath = '';
  private texturePreviewUrl = '';
  private textureDimensions: TextureDimensions = { width: 0, height: 0 };

  private readonly texturePreviewCache = new Map<string, string>();
  private readonly textureDimensionsCache = new Map<string, TextureDimensions>();
  private readonly texturePreviewLoads = new Map<string, Promise<void>>();
  /**
   * Decoded alpha masks for the auto-polygon tracer (§9.12.2), keyed
   * `<texturePath>|<alphaThreshold>`. Dragging the tolerance slider re-traces on
   * every release; re-decoding the PNG each time would make it feel like treacle.
   */
  private readonly alphaMaskCache = new Map<string, AlphaMask>();

  /** Highest `<clip>_<nnnn>` this session already wrote, by sanitized clip prefix. */
  private readonly reservedFrameFileNumbers = new Map<string, number>();

  /**
   * Host listeners fire on every change; Inspector listeners only when the
   * snapshot they read can actually differ. Keeping them apart preserves the
   * pre-extraction behaviour, where the Inspector was driven by Lit's
   * `changedProperties` gate and therefore did *not* re-render 60 times a second
   * while the preview plays.
   */
  private readonly listeners = new Set<() => void>();
  private readonly inspectorListeners = new Set<() => void>();

  private disposeTabsSubscription?: () => void;
  private disposeProjectSubscription?: () => void;
  private disposeAnimationsSubscription?: () => void;

  private lastNotifiedAssetPath: string | null = null;
  private lastNotifiedResource: AnimationResource | null = null;
  private lastNotifiedActiveClipName = '';
  private lastNotifiedSelectedFrameIndex = -1;
  private lastNotifiedPreviewFrameIndex = -1;

  constructor(
    private readonly deps: AnimationDocumentControllerDeps,
    tabId: string,
    resourcePath = ''
  ) {
    this.tabId = tabId;
    this.resourcePath = resourcePath;
  }

  // --- lifetime ------------------------------------------------------------

  /**
   * Start mirroring editor state. Safe to call again after {@link dispose} — the
   * controller is owned by the host *instance* and has to survive a Golden Layout
   * re-dock (disconnect → reconnect) without losing its Inspector registration.
   */
  attach(): void {
    if (this.isAttached) {
      return;
    }

    this.isAttached = true;
    this.disposeTabsSubscription = subscribe(appState.tabs, () => {
      void this.syncFromResourceContext(true);
    });
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      void this.syncFromResourceContext(true);
    });
    this.disposeAnimationsSubscription = subscribe(appState.animations, () => {
      void this.syncFromDocumentState(true);
    });
    void this.syncFromResourceContext(false);
  }

  dispose(): void {
    this.stopPlayback();
    this.disposeTabsSubscription?.();
    this.disposeProjectSubscription?.();
    this.disposeAnimationsSubscription?.();
    this.disposeTabsSubscription = undefined;
    this.disposeProjectSubscription = undefined;
    this.disposeAnimationsSubscription = undefined;
    if (this.deps.animationEditorService.getActiveController() === this) {
      this.deps.animationEditorService.setActiveController(null);
    }
    this.clearTexturePreviewCache();
    this.isAttached = false;
  }

  /**
   * Point the controller at another tab / resource path. The host mirrors its own
   * `tab-id` / `resource-path` properties here.
   */
  setContext(tabId: string, resourcePath: string): void {
    if (tabId === this.tabId && resourcePath === this.resourcePath) {
      return;
    }

    this.tabId = tabId;
    this.resourcePath = resourcePath;
    if (this.isAttached) {
      void this.syncFromResourceContext(false);
    }
  }

  // --- observable document state -------------------------------------------

  get assetPath(): string | null {
    return this._assetPath;
  }

  get resource(): AnimationResource | null {
    return this._resource;
  }

  get activeClip(): AnimationClip | null {
    return this._resource?.clips.find(clip => clip.name === this._activeClipName) ?? null;
  }

  get activeClipName(): string {
    return this._activeClipName;
  }

  get selectedFrameIndex(): number {
    return this._selectedFrameIndex;
  }

  /** The raw multi-selection (may be empty even when a primary frame exists). */
  get selectedFrameIndices(): readonly number[] {
    return this._selectedFrameIndices;
  }

  get previewFrameIndex(): number {
    return this._previewFrameIndex;
  }

  get isPreviewPlaying(): boolean {
    return this._isPreviewPlaying;
  }

  /** Transient in-flight edit (a stage drag); overrides the stored frame while set. */
  get frameDraft(): AnimationFrame | null {
    return this._frameDraft;
  }

  get errorMessage(): string | null {
    return this._errorMessage;
  }

  get selectedFrame(): AnimationFrame | null {
    return this.getSelectedFrame();
  }

  get previewFrame(): AnimationFrame | null {
    return this.getPreviewFrame();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Effective selection: falls back to the primary frame when nothing is multi-selected. */
  getSelectedFrameIndices(): number[] {
    if (this._selectedFrameIndices.length > 0) {
      return this._selectedFrameIndices;
    }

    return this._selectedFrameIndex >= 0 ? [this._selectedFrameIndex] : [];
  }

  // --- selection & playback ------------------------------------------------

  selectFrame(index: number, modifiers: { shift?: boolean; ctrl?: boolean } = {}): void {
    const currentSelection = this.getSelectedFrameIndices();
    let nextSelectedFrameIndices: number[];
    let nextPrimaryIndex = index;

    if (modifiers.shift && this.selectionAnchorFrameIndex >= 0) {
      const [rangeStart, rangeEnd] =
        this.selectionAnchorFrameIndex <= index
          ? [this.selectionAnchorFrameIndex, index]
          : [index, this.selectionAnchorFrameIndex];
      nextSelectedFrameIndices = [];
      for (let frameIndex = rangeStart; frameIndex <= rangeEnd; frameIndex += 1) {
        nextSelectedFrameIndices.push(frameIndex);
      }
    } else if (modifiers.ctrl) {
      const nextSelection = new Set(currentSelection);
      if (nextSelection.has(index) && nextSelection.size > 1) {
        nextSelection.delete(index);
      } else {
        nextSelection.add(index);
      }
      nextSelectedFrameIndices = [...nextSelection].sort((left, right) => left - right);
      if (!nextSelectedFrameIndices.includes(index)) {
        nextPrimaryIndex = nextSelectedFrameIndices.at(-1) ?? -1;
      }
    } else {
      nextSelectedFrameIndices = [index];
    }

    this._frameDraft = null;
    this._selectedFrameIndices = nextSelectedFrameIndices;
    this._selectedFrameIndex = nextPrimaryIndex;
    this._previewFrameIndex = nextPrimaryIndex;
    this.previewElapsedSeconds = 0;
    this.selectionAnchorFrameIndex = index;
    this.persistSelectedFrameIndex(nextPrimaryIndex);
    this.notify();
  }

  /**
   * Collapse the selection onto the frame a reorder drag started on — but only
   * when that frame isn't already the single selected one, so dragging a
   * multi-selection's member doesn't silently drop the rest.
   */
  selectFrameForDrag(frameIndex: number): void {
    if (this._selectedFrameIndices.includes(frameIndex) && this._selectedFrameIndices.length <= 1) {
      return;
    }

    this._selectedFrameIndices = [frameIndex];
    this._selectedFrameIndex = frameIndex;
    this._previewFrameIndex = frameIndex;
    this.selectionAnchorFrameIndex = frameIndex;
    this.persistSelectedFrameIndex(frameIndex);
    this.notify();
  }

  togglePlayback(): void {
    if (this._isPreviewPlaying) {
      this.stopPlayback();
      return;
    }

    this.startPlayback();
  }

  startPlayback(): void {
    const activeClip = this.activeClip;
    if (!activeClip || activeClip.frames.length === 0 || this._isPreviewPlaying) {
      return;
    }

    this._isPreviewPlaying = true;
    this.previewDirection = 1;
    this.notify();
  }

  stopPlayback(): void {
    if (!this._isPreviewPlaying && this.previewElapsedSeconds === 0) {
      return;
    }

    this._isPreviewPlaying = false;
    this.previewElapsedSeconds = 0;
    this.notify();
  }

  /** Stop and park the preview on the selected frame (the transport's Stop button). */
  stopPlaybackAndRewind(): void {
    this.stopPlayback();
    const activeClip = this.activeClip;
    if (!activeClip || activeClip.frames.length === 0) {
      this._previewFrameIndex = -1;
      this.notify();
      return;
    }

    const fallbackIndex = this._selectedFrameIndex >= 0 ? this._selectedFrameIndex : 0;
    this._previewFrameIndex = Math.min(fallbackIndex, activeClip.frames.length - 1);
    this.previewElapsedSeconds = 0;
    this.notify();
  }

  /**
   * Consume `deltaSeconds` of preview time, flipping frames as their durations
   * elapse. The host drives this from its rAF ticker.
   */
  advancePlayback(deltaSeconds: number): void {
    if (!this._isPreviewPlaying) {
      return;
    }

    let remainingDelta = deltaSeconds;
    while (remainingDelta > 0) {
      const currentClip = this.activeClip;
      const currentFrame = this.getPreviewFrame(currentClip);
      if (!currentClip || !currentFrame) {
        break;
      }

      const frameDuration = this.getFrameDurationSeconds(currentClip, currentFrame);
      const remaining = frameDuration - this.previewElapsedSeconds;
      if (remainingDelta < remaining) {
        this.previewElapsedSeconds += remainingDelta;
        remainingDelta = 0;
        break;
      }

      remainingDelta -= remaining;
      this.previewElapsedSeconds = 0;
      if (!this.stepPreviewFrame(currentClip)) {
        this.stopPlayback();
        break;
      }
    }

    this.notify();
  }

  getFrameDurationSeconds(clip: AnimationClip, frame: AnimationFrame): number {
    const fps = Math.max(1, clip.fps);
    const multiplier = Math.max(0.001, frame.durationMultiplier);
    return (1 / fps) * multiplier;
  }

  // --- frame metrics & texture previews ------------------------------------

  getFrameMetrics(frame: AnimationFrame): { frameWidth: number; frameHeight: number } {
    const resolvedTexturePath = this.getResolvedFrameTexturePath(frame);
    const cachedDimensions = resolvedTexturePath
      ? (this.textureDimensionsCache.get(resolvedTexturePath) ?? null)
      : null;
    const textureWidth = cachedDimensions?.width || this.textureDimensions.width || 256;
    const textureHeight = cachedDimensions?.height || this.textureDimensions.height || 256;

    if (isSequenceAnimationFrame(frame)) {
      return {
        frameWidth: Math.max(24, Math.round(textureWidth)),
        frameHeight: Math.max(24, Math.round(textureHeight)),
      };
    }

    return {
      frameWidth: Math.max(24, Math.round(textureWidth * Math.max(frame.repeat.x, 0.05))),
      frameHeight: Math.max(24, Math.round(textureHeight * Math.max(frame.repeat.y, 0.05))),
    };
  }

  /**
   * Whether {@link getFrameMetrics} is backed by a decoded texture rather than its
   * 256px placeholder. Frame geometry that is stored in *absolute* frame pixels
   * (`boundingBox`, `collisionPolygon`) — and anything derived from the frame's
   * aspect ratio, such as a frame point's angle — would be authored into a fake
   * 256x256 space while this is false, so editing those is suppressed until the
   * texture decodes (§9.7 risk 2). Mirrors `getFrameMetrics`'s own fallback chain
   * exactly, including its use of the *current preview* texture's dimensions for
   * a frame whose own texture has not been read yet.
   */
  hasResolvedFrameMetrics(frame: AnimationFrame): boolean {
    const resolvedTexturePath = this.getResolvedFrameTexturePath(frame);
    const cachedDimensions = resolvedTexturePath
      ? (this.textureDimensionsCache.get(resolvedTexturePath) ?? null)
      : null;
    const textureWidth = cachedDimensions?.width || this.textureDimensions.width;
    const textureHeight = cachedDimensions?.height || this.textureDimensions.height;
    return textureWidth > 0 && textureHeight > 0;
  }

  getTexturePreviewUrl(frame: AnimationFrame | null): string {
    const texturePath = this.getResolvedFrameTexturePath(frame);
    if (!texturePath) {
      return '';
    }

    if (texturePath === this.previewTexturePath && this.texturePreviewUrl) {
      return this.texturePreviewUrl;
    }

    const cachedTextureUrl = this.texturePreviewCache.get(texturePath);
    if (cachedTextureUrl) {
      return cachedTextureUrl;
    }

    void this.ensureTexturePreviewLoaded(texturePath);
    return '';
  }

  /**
   * Drop every cached artefact for a texture file whose pixels changed on disk, so
   * the next read re-decodes it (the §9.5 write-back hook).
   */
  invalidateTexture(texturePath: string): void {
    const normalizedTexturePath = texturePath.trim();
    if (!normalizedTexturePath) {
      return;
    }

    const cachedTextureUrl = this.texturePreviewCache.get(normalizedTexturePath);
    if (cachedTextureUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(cachedTextureUrl);
    }

    this.texturePreviewCache.delete(normalizedTexturePath);
    this.textureDimensionsCache.delete(normalizedTexturePath);
    this.texturePreviewLoads.delete(normalizedTexturePath);
    // The mask cache is keyed by path *and* alpha threshold, so drop every entry
    // this file produced rather than one.
    for (const key of this.alphaMaskCache.keys()) {
      if (key.startsWith(`${normalizedTexturePath}|`)) {
        this.alphaMaskCache.delete(key);
      }
    }
    if (this.previewTexturePath === normalizedTexturePath) {
      this.resetCurrentTexturePreview();
      void this.syncPreviewTexture();
    }

    this.notify();
  }

  // --- frame drafts (stage drags) ------------------------------------------

  beginFrameDraft(): AnimationFrame | null {
    const frame = this.getSelectedFrame();
    if (!frame) {
      return null;
    }

    const draft = cloneFrame(frame);
    this._frameDraft = draft;
    this.notify();
    return draft;
  }

  updateFrameDraft(mutate: (draft: AnimationFrame) => AnimationFrame): void {
    if (!this._frameDraft) {
      return;
    }

    this._frameDraft = mutate(this._frameDraft);
    this.notify();
  }

  clearFrameDraft(): void {
    if (!this._frameDraft) {
      return;
    }

    this._frameDraft = null;
    this.notify();
  }

  async commitFrameDraft(label: string): Promise<void> {
    const draft = this._frameDraft;
    this._frameDraft = null;
    if (!draft) {
      this.notify();
      return;
    }

    await this.applySelectedFrameUpdate(() => draft, label);
  }

  // --- clip CRUD -----------------------------------------------------------

  async selectClip(clipName: string): Promise<void> {
    this._activeClipName = clipName;
    this.persistActiveClipName(clipName);
    this.syncFrameStateToActiveClip(true);
    this.notify();

    const selectedSprite = this.getSelectedAnimatedSprite();
    if (
      selectedSprite &&
      selectedSprite.animationResourcePath === this._assetPath &&
      selectedSprite.currentClip !== clipName
    ) {
      await this.deps.commandDispatcher.execute(
        new UpdateObjectPropertyCommand({
          nodeId: selectedSprite.nodeId,
          propertyPath: 'currentClip',
          value: clipName,
        })
      );
    }
  }

  async addClip(): Promise<void> {
    if (!this._resource) {
      return;
    }

    const existingNames = new Set(this._resource.clips.map(clip => clip.name));
    let index = this._resource.clips.length + 1;
    let nextName = `clip-${index}`;
    while (existingNames.has(nextName)) {
      index += 1;
      nextName = `clip-${index}`;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: [
          ...resource.clips,
          {
            name: nextName,
            fps: 12,
            loop: true,
            playbackMode: 'normal',
            frames: [],
          },
        ],
      }),
      `Add clip: ${nextName}`,
      nextName
    );
  }

  async removeClip(): Promise<void> {
    if (!this._resource || !this._activeClipName || this._resource.clips.length === 0) {
      return;
    }

    const confirmed = await this.deps.dialogService.showConfirmation({
      title: 'Delete clip?',
      message: `Remove clip "${this._activeClipName}" from this animation?`,
      confirmLabel: 'Delete clip',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (!confirmed) {
      return;
    }

    const remainingClips = this._resource.clips.filter(clip => clip.name !== this._activeClipName);
    const nextActiveClipName = remainingClips[0]?.name ?? '';

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.filter(clip => clip.name !== this._activeClipName),
      }),
      `Remove clip: ${this._activeClipName}`,
      nextActiveClipName
    );
  }

  async renameClip(nextName: string): Promise<void> {
    if (!this._resource || !this._activeClipName || !nextName) {
      return;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this._activeClipName ? { ...clip, name: nextName } : clip
        ),
      }),
      `Rename clip: ${this._activeClipName} -> ${nextName}`,
      nextName
    );
  }

  async updateClipFps(nextFps: number): Promise<void> {
    if (!Number.isFinite(nextFps) || nextFps <= 0) {
      return;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this._activeClipName ? { ...clip, fps: Math.round(nextFps) } : clip
        ),
      }),
      `Update clip fps: ${this._activeClipName}`
    );
  }

  async updateClipLoop(nextLoop: boolean): Promise<void> {
    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this._activeClipName ? { ...clip, loop: nextLoop } : clip
        ),
      }),
      `Update clip loop: ${this._activeClipName}`
    );
  }

  async updateClipPlaybackMode(mode: AnimationPlaybackMode): Promise<void> {
    await this.applyClipUpdate(
      clip => ({ ...clip, playbackMode: mode }),
      `Update clip playback mode: ${this._activeClipName}`
    );
  }

  // --- frame CRUD ----------------------------------------------------------

  /**
   * Append (or, with `insertAtIndex`, splice in) frames referencing the given textures. Dropping
   * onto a frame card inserts before it; dropping anywhere else in the editor appends.
   */
  async addFrameTextures(texturePaths: string[], insertAtIndex?: number): Promise<void> {
    if (!this._resource || !this._activeClipName) {
      return;
    }

    const normalizedTexturePaths = texturePaths.map(path => path.trim()).filter(Boolean);
    if (normalizedTexturePaths.length === 0) {
      return;
    }

    const sourceSizes = await Promise.all(
      normalizedTexturePaths.map(texturePath => this.readFrameSourceSize(texturePath))
    );
    const generatedFrames: AnimationFrame[] = normalizedTexturePaths.map((texturePath, index) => ({
      textureIndex: 0,
      offset: { x: 0, y: 0 },
      repeat: { x: 1, y: 1 },
      durationMultiplier: 1,
      anchor: { ...DEFAULT_FRAME_ANCHOR },
      texturePath,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      collisionPolygon: [],
      sourceSize: sourceSizes[index],
    }));

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(existingClip => {
          if (existingClip.name !== this._activeClipName) {
            return existingClip;
          }
          const frames = [...existingClip.frames];
          const at =
            insertAtIndex === undefined
              ? frames.length
              : Math.min(Math.max(0, insertAtIndex), frames.length);
          frames.splice(at, 0, ...generatedFrames);
          return { ...existingClip, frames };
        }),
      }),
      `Add ${generatedFrames.length} frame texture${generatedFrames.length === 1 ? '' : 's'}: ${this._activeClipName}`,
      this._activeClipName
    );
  }

  async removeSelectedFrames(): Promise<void> {
    await this.removeFrames(this.getSelectedFrameIndices());
  }

  async removeFrames(frameIndices: number[]): Promise<void> {
    const clip = this.activeClip;
    const normalizedFrameIndices = [...new Set(frameIndices)]
      .filter(frameIndex => frameIndex >= 0 && frameIndex < (clip?.frames.length ?? 0))
      .sort((left, right) => left - right);

    if (!clip || normalizedFrameIndices.length === 0) {
      return;
    }

    const indexSet = new Set(normalizedFrameIndices);
    const firstRemovedIndex = normalizedFrameIndices[0] ?? -1;
    const isBatchDelete = normalizedFrameIndices.length > 1;

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(existingClip =>
          existingClip.name === this._activeClipName
            ? {
                ...existingClip,
                frames: existingClip.frames.filter((_, index) => !indexSet.has(index)),
              }
            : existingClip
        ),
      }),
      isBatchDelete
        ? `Delete ${normalizedFrameIndices.length} frames: ${this._activeClipName}`
        : `Delete frame ${firstRemovedIndex + 1}: ${this._activeClipName}`,
      this._activeClipName
    );

    const nextClip = this.activeClip;
    const nextFrameCount = nextClip?.frames.length ?? 0;
    const nextSelectedIndex =
      nextFrameCount === 0 ? -1 : Math.min(firstRemovedIndex, nextFrameCount - 1);
    this._selectedFrameIndex = nextSelectedIndex;
    this._selectedFrameIndices = nextSelectedIndex >= 0 ? [nextSelectedIndex] : [];
    this._previewFrameIndex = nextSelectedIndex;
    this.selectionAnchorFrameIndex = nextSelectedIndex;
    this.persistSelectedFrameIndex(nextSelectedIndex);
    this.notify();
  }

  async reorderFrame(fromIndex: number, toIndex: number): Promise<void> {
    const clip = this.activeClip;
    if (
      !clip ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= clip.frames.length ||
      toIndex >= clip.frames.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(existingClip => {
          if (existingClip.name !== this._activeClipName) {
            return existingClip;
          }

          const nextFrames = [...existingClip.frames];
          const [movedFrame] = nextFrames.splice(fromIndex, 1);
          if (!movedFrame) {
            return existingClip;
          }
          nextFrames.splice(toIndex, 0, movedFrame);
          return { ...existingClip, frames: nextFrames };
        }),
      }),
      `Reorder frame ${fromIndex + 1} -> ${toIndex + 1}: ${this._activeClipName}`,
      this._activeClipName
    );

    this._selectedFrameIndex = toIndex;
    this._selectedFrameIndices = [toIndex];
    this._previewFrameIndex = toIndex;
    this.selectionAnchorFrameIndex = toIndex;
    this.persistSelectedFrameIndex(toIndex);
    this.notify();
  }

  /**
   * Copy OS-dropped images into the animation's own folder as `<clip>_<nnnn>.<ext>` (the managed
   * sprite-folder convention), so a drag from the desktop lands as project files the resource can
   * reference. Returns the written resource paths in drop order.
   */
  async importOsFiles(files: File[]): Promise<string[]> {
    const assetPath = this._assetPath ? normalizeAnimationAssetPath(this._assetPath) : '';
    if (!assetPath || files.length === 0) {
      return [];
    }

    const clipName = this._activeClipName || this._resource?.clips[0]?.name || 'idle';
    let frameNumber = this.nextFrameFileNumber(clipName);
    const written: string[] = [];

    for (const file of files) {
      const extension = file.name.split('.').pop()?.toLowerCase();
      const framePath = buildAnimationFrameResourcePath(assetPath, frameNumber, {
        clipName,
        extension: extension && IMAGE_EXTENSIONS.has(extension) ? extension : 'png',
      });
      await this.deps.projectStorage.writeBinaryFile(framePath, await file.arrayBuffer());
      written.push(framePath);
      frameNumber += 1;
    }

    return written;
  }

  // --- frame pixel write-back (§9.5) ----------------------------------------

  /**
   * Point a frame at freshly baked pixels: write them as a **new** frame file,
   * restamp the frame's metadata against the new raster, and invalidate every
   * cache that still holds the old bytes.
   *
   * The new file is deliberate (§9.5 step 2). An in-place overwrite would leave
   * undo restoring metadata that describes destroyed pixels; writing
   * `<clip>_<nnnn>.png` instead means undo of the single operation below puts
   * `texturePath` back on an untouched original. In-place stays reserved for the
   * explicit "Overwrite original" button and the future bulk "Trim frames";
   * orphaned bakes are handled by export pruning.
   *
   * Returns the new resource path, or null when nothing was written.
   */
  async replaceFrameTexture(
    frameIndex: number,
    blob: Blob,
    options: ReplaceFrameTextureOptions
  ): Promise<string | null> {
    const clip = this.activeClip;
    const frame = clip?.frames[frameIndex] ?? null;
    const assetPath = this._assetPath ? normalizeAnimationAssetPath(this._assetPath) : '';
    if (!clip || !frame || !assetPath) {
      return null;
    }

    // The measured size is authoritative for `sourceSize` (R1: the editor stamps
    // it so layout never waits on a texture load) and is what the restamp maps
    // the frame's geometry into.
    const measured = await readBlobSize(blob);
    const toSize: AnimationSize = measured
      ? { width: measured.width, height: measured.height }
      : { width: 0, height: 0 };
    const fromSize = options.sourceSize ?? this.resolveFrameSourceSize(frame);

    const clipName = clip.name;
    const frameNumber = this.reserveFrameFileNumber(clipName);
    const framePath = buildAnimationFrameResourcePath(assetPath, frameNumber, {
      clipName,
      extension: options.extension ?? 'png',
    });
    await this.deps.projectStorage.writeBinaryFile(framePath, await blob.arrayBuffer());

    const previousTexturePath = this.getResolvedFrameTexturePath(frame);
    const restamped = fromSize
      ? restampFrameGeometry(frame, options.restamp, fromSize, toSize)
      : { ...frame, sourceSize: toSize };

    this._frameDraft = null;
    const didMutate = await this.applyClipUpdate(
      candidate => ({
        ...candidate,
        frames: candidate.frames.map((existingFrame, index) =>
          index === frameIndex
            ? {
                ...restamped,
                texturePath: framePath,
                // The frame now owns a file of its own: any UV window it used to
                // read out of the resource spritesheet is baked into those pixels.
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
              }
            : existingFrame
        ),
      }),
      options.label ?? `Replace frame ${frameIndex + 1} pixels: ${clipName}`
    );
    if (!didMutate) {
      return null;
    }

    this.invalidateTextureEverywhere(previousTexturePath, framePath);
    return framePath;
  }

  /**
   * §9.12.1 — crop the transparent margins off **every** frame of the active clip,
   * moving each frame's anchor/points/bbox/polygon so the animation is pixel-
   * identical on screen while the PNGs (and the atlas that packs them) shrink.
   *
   * Deliberately **not** a loop over {@link replaceFrameTexture}: that would push
   * one undo step per frame and leave a half-trimmed clip if the fifth frame threw.
   * Instead every new file is written first, then **one** `applyClipUpdate` swaps
   * them all in, then **one** invalidation pass runs. A frame that cannot be
   * trimmed is reported as a skip, never as an error, and never burns a frame file
   * number.
   */
  async trimClipFrames(options: TrimClipFramesOptions = {}): Promise<TrimClipReport> {
    const report: TrimClipReport = { trimmed: 0, skipped: 0, failed: 0 };
    const clip = this.activeClip;
    const assetPath = this._assetPath ? normalizeAnimationAssetPath(this._assetPath) : '';
    if (!clip || !assetPath || clip.frames.length === 0) {
      return report;
    }

    const padding = Math.max(0, Math.round(options.padding ?? 0));
    const alphaThreshold = Math.max(0, Math.round(options.alphaThreshold ?? 0));
    const clipName = clip.name;
    const writes: Array<{ index: number; framePath: string; restamped: AnimationFrame }> = [];
    const previousTexturePaths: string[] = [];

    for (const [frameIndex, frame] of clip.frames.entries()) {
      // A UV window into the shared spritesheet: trimming those pixels would cut
      // every other frame that reads the same sheet.
      if (!isSequenceAnimationFrame(frame)) {
        report.skipped += 1;
        continue;
      }
      // Absolute-pixel geometry would be re-authored into the 256px placeholder
      // space while the raster size is unknown (§9.7 risk 2) — the
      // `hasResolvedFrameMetrics` gate, applied per frame.
      const fromSize = this.resolveTrimSourceSize(frame);
      const texturePath = this.getResolvedFrameTexturePath(frame);
      if (!fromSize || !texturePath) {
        report.skipped += 1;
        continue;
      }

      try {
        const source = await this.deps.projectStorage.readBlob(texturePath);
        const result = await trimImageBlob(source, { padding, alphaThreshold });
        const bounds = result.bounds;
        if (result.empty || !bounds) {
          report.skipped += 1;
          continue;
        }
        if (
          bounds.x === 0 &&
          bounds.y === 0 &&
          bounds.width === fromSize.width &&
          bounds.height === fromSize.height
        ) {
          // Already tight — rewriting it would only burn a file number.
          report.skipped += 1;
          continue;
        }

        // THE TRAP (§9.12.1): `bounds` is the raw content box, but the output
        // canvas *centres* that content inside `padding` (and inside a square, if
        // asked). The crop origin is therefore the content box shifted back by the
        // margin the encoder added, which is derived from the returned size — not
        // `bounds.x` and not the padding constant.
        const dx = Math.round((result.width - bounds.width) / 2);
        const dy = Math.round((result.height - bounds.height) / 2);
        const restamped = restampFrameGeometry(
          frame,
          { kind: 'crop', x: bounds.x - dx, y: bounds.y - dy },
          fromSize,
          { width: result.width, height: result.height }
        );

        const frameNumber = this.reserveFrameFileNumber(clipName);
        const framePath = buildAnimationFrameResourcePath(assetPath, frameNumber, {
          clipName,
          extension: 'png',
        });
        await this.deps.projectStorage.writeBinaryFile(framePath, await result.blob.arrayBuffer());
        writes.push({ index: frameIndex, framePath, restamped });
        previousTexturePaths.push(texturePath);
      } catch (error) {
        console.warn('[SpriteEditor] Failed to trim frame', texturePath, error);
        report.failed += 1;
      }
    }

    if (writes.length === 0) {
      return report;
    }

    const writesByIndex = new Map(writes.map(write => [write.index, write]));
    this._frameDraft = null;
    const didMutate = await this.applyClipUpdate(
      candidate => ({
        ...candidate,
        frames: candidate.frames.map((existingFrame, frameIndex) => {
          const write = writesByIndex.get(frameIndex);
          return write
            ? {
                ...write.restamped,
                texturePath: write.framePath,
                // Same reset as `replaceFrameTexture`: the trimmed file *is* the
                // frame now, so any leftover UV window is baked into its pixels.
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
              }
            : existingFrame;
        }),
      }),
      `Trim ${writes.length} frame${writes.length === 1 ? '' : 's'}: ${clipName}`
    );
    if (!didMutate) {
      // The files exist but the document refused the swap; nothing was trimmed as
      // far as the user can tell, and the orphans are export-pruned like any bake.
      report.failed += writes.length;
      return report;
    }

    this.invalidateTextureEverywhere(
      ...previousTexturePaths,
      ...writes.map(write => write.framePath)
    );
    report.trimmed = writes.length;
    return report;
  }

  /**
   * The frame's own raster size for a trim, or null when it is genuinely unknown —
   * which is {@link hasResolvedFrameMetrics}'s question asked per frame.
   *
   * Neither of the existing resolvers can be reused as-is for a clip-wide pass:
   * both {@link hasResolvedFrameMetrics} and {@link resolveFrameSourceSize} fall
   * back to the *current preview* texture's dimensions, so in a loop they would
   * hand one frame's size to another and silently restamp geometry into the wrong
   * space. A stamped `sourceSize` (§8.8, written by the editor on every add /
   * replace / crop) counts as measured even while the decode cache is cold.
   */
  private resolveTrimSourceSize(frame: AnimationFrame): AnimationSize | null {
    const stamped = frame.sourceSize;
    if (stamped && stamped.width > 0 && stamped.height > 0) {
      return { width: stamped.width, height: stamped.height };
    }
    const cached = this.textureDimensionsCache.get(this.getResolvedFrameTexturePath(frame));
    if (cached && cached.width > 0 && cached.height > 0) {
      return { width: cached.width, height: cached.height };
    }
    return null;
  }

  // --- auto collision polygon (§9.12.2) -------------------------------------

  /**
   * §9.12.2 — trace the selected frame's alpha into a collision polygon: marching
   * squares over the opaque mask, Douglas–Peucker down to `tolerance`, straight
   * into `collisionPolygon` in absolute frame pixels (the space
   * {@link restampFrameGeometry} already maps, so a later crop moves it correctly).
   *
   * The result lands in the **frame draft**, not in the document. That is the whole
   * preview mechanism: the stage already renders the draft through
   * `renderPolygonOverlay`, and that overlay is already editable, so the traced
   * polygon *is* the live preview and the user can drag its vertices before
   * committing. Nothing is written until the host calls
   * {@link commitFrameDraft} — one `applyClipUpdate`, one undo step — and
   * {@link clearFrameDraft} discards the trace entirely.
   *
   * A UV-window frame is refused: its file is the shared spritesheet, so the
   * outline of that file's alpha is the sheet's, not the frame's. Hosts should
   * additionally gate on {@link hasResolvedFrameMetrics} — the polygon is authored
   * in the raster's own pixels, and an overlay laid out against the 256 px
   * placeholder would draw it in the wrong place (§9.7 risk 2).
   */
  async traceSelectedFramePolygon(options: AutoPolygonOptions = {}): Promise<AutoPolygonReport> {
    const frame = this.getSelectedFrame();
    if (!frame || this._selectedFrameIndex < 0 || !isSequenceAnimationFrame(frame)) {
      return { status: 'no-frame', vertexCount: 0 };
    }

    const texturePath = this.getResolvedFrameTexturePath(frame);
    if (!texturePath) {
      return { status: 'no-frame', vertexCount: 0 };
    }

    const alphaThreshold = Math.min(255, Math.max(0, Math.round(options.alphaThreshold ?? 0)));
    const mask = await this.loadAlphaMask(texturePath, alphaThreshold);
    if (!mask) {
      return { status: 'unreadable', vertexCount: 0 };
    }

    const polygon = traceCollisionPolygon(mask, {
      tolerance: Math.max(0, options.tolerance ?? DEFAULT_CONTOUR_TOLERANCE),
    });
    if (polygon.length < 3) {
      // Nothing opaque to trace — leave whatever polygon the frame already has.
      return { status: 'empty', vertexCount: 0 };
    }

    if (!this._frameDraft && !this.beginFrameDraft()) {
      return { status: 'no-frame', vertexCount: 0 };
    }
    this.updateFrameDraft(draft => ({ ...draft, collisionPolygon: polygon }));
    return { status: 'traced', vertexCount: polygon.length };
  }

  /** Decode (once per path + threshold) the opacity mask the tracer walks. */
  private async loadAlphaMask(
    texturePath: string,
    alphaThreshold: number
  ): Promise<AlphaMask | null> {
    const key = `${texturePath}|${alphaThreshold}`;
    const cached = this.alphaMaskCache.get(key);
    if (cached) {
      return cached;
    }

    const blob = await this.deps.projectStorage.readBlob(texturePath);
    const mask = await readAlphaMask(blob, { alphaThreshold });
    if (mask) {
      this.alphaMaskCache.set(key, mask);
    }
    return mask;
  }

  /**
   * §9.5 step 4 — the invalidation fan-out. Three caches hold decoded copies of a
   * texture file: this controller's preview cache (timeline thumbs + stage), the
   * shared {@link AssetLoader} (the next play-mode start), and the viewport's 2D
   * proxy visuals. The trailing repaint is not optional: a file write marks
   * nothing dirty, so the viewport would otherwise show the old pixels until the
   * heartbeat.
   */
  private invalidateTextureEverywhere(...texturePaths: string[]): void {
    const unique = [...new Set(texturePaths.map(path => path.trim()).filter(Boolean))];
    for (const texturePath of unique) {
      this.invalidateTexture(texturePath);
      this.deps.assetLoader?.evictTexture(texturePath);
      this.deps.viewportRenderer?.invalidateTexture(texturePath);
    }
  }

  /**
   * The frame's raster size when it is actually known — its stamped `sourceSize`
   * first, then a decoded texture. Null while neither is available, which
   * suppresses the geometry restamp rather than authoring it into the 256px
   * placeholder space (§9.7 risk 2).
   */
  private resolveFrameSourceSize(frame: AnimationFrame): AnimationSize | null {
    const stamped = frame.sourceSize;
    if (stamped && stamped.width > 0 && stamped.height > 0) {
      return { width: stamped.width, height: stamped.height };
    }
    if (!this.hasResolvedFrameMetrics(frame)) {
      return null;
    }
    const metrics = this.getFrameMetrics(frame);
    return { width: metrics.frameWidth, height: metrics.frameHeight };
  }

  // --- frame property edits -------------------------------------------------

  async applySelectedFrameUpdate(
    updater: (frame: AnimationFrame) => AnimationFrame,
    label: string
  ): Promise<void> {
    const frameIndex = this._selectedFrameIndex;
    if (frameIndex < 0) {
      return;
    }

    // Drop the transient draft first and tell hosts: the update below may be
    // rejected (nothing to mutate), and the stage must not keep drawing it.
    this._frameDraft = null;
    this.notify();

    await this.applyClipUpdate(
      clip => ({
        ...clip,
        frames: clip.frames.map((frame, index) => (index === frameIndex ? updater(frame) : frame)),
      }),
      label
    );
  }

  async updateSelectedFrameDurationMultiplier(value: number): Promise<void> {
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }

    await this.applySelectedFrameUpdate(
      frame => ({ ...frame, durationMultiplier: Math.max(0.05, value) }),
      `Update frame duration multiplier: ${this._activeClipName}`
    );
  }

  async updateSelectedFrameTexturePath(value: string): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({ ...frame, texturePath: value }),
      `Update frame texture override: ${this._activeClipName}`
    );
  }

  async updateSelectedFrameAnchor(axis: 'x' | 'y', value: number): Promise<void> {
    if (!Number.isFinite(value)) {
      return;
    }

    const clampedValue = Math.min(1, Math.max(0, value));
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        anchor: { ...frame.anchor, [axis]: clampedValue },
      }),
      `Update frame anchor: ${this._activeClipName}`
    );
  }

  async updateSelectedFrameBoundingBox(
    field: 'x' | 'y' | 'width' | 'height',
    value: number
  ): Promise<void> {
    if (!Number.isFinite(value)) {
      return;
    }

    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        boundingBox: {
          ...frame.boundingBox,
          [field]:
            field === 'width' || field === 'height'
              ? Math.max(0, Math.round(value))
              : Math.round(value),
        },
      }),
      `Update frame bounding box: ${this._activeClipName}`
    );
  }

  async addPolygonVertex(): Promise<void> {
    const selectedFrame = this.getSelectedFrame();
    if (!selectedFrame) {
      return;
    }

    const metrics = this.getFrameMetrics(selectedFrame);
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        collisionPolygon: [
          ...frame.collisionPolygon,
          { x: Math.round(metrics.frameWidth / 2), y: Math.round(metrics.frameHeight / 2) },
        ],
      }),
      `Add frame polygon vertex: ${this._activeClipName}`
    );
  }

  async clearPolygon(): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({ ...frame, collisionPolygon: [] }),
      `Clear frame polygon: ${this._activeClipName}`
    );
  }

  async resetBoundingBox(): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      }),
      `Reset frame bounding box: ${this._activeClipName}`
    );
  }

  async applyAnchorPreset(anchor: StagePoint): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        anchor: { x: anchor.x, y: anchor.y },
      }),
      `Set frame anchor preset: ${this._activeClipName}`
    );
  }

  async applySelectedAnchorToActiveClip(): Promise<void> {
    const anchor = this.getSelectedAnchor();
    if (!anchor) {
      return;
    }

    this._frameDraft = null;
    await this.applyClipUpdate(
      clip => ({
        ...clip,
        frames: clip.frames.map(frame => ({
          ...frame,
          anchor: { x: anchor.x, y: anchor.y },
        })),
      }),
      `Apply frame anchor to clip: ${this._activeClipName}`
    );
  }

  async applySelectedAnchorToAllClips(): Promise<void> {
    const anchor = this.getSelectedAnchor();
    if (!anchor) {
      return;
    }

    this._frameDraft = null;
    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip => ({
          ...clip,
          frames: clip.frames.map(frame => ({
            ...frame,
            anchor: { x: anchor.x, y: anchor.y },
          })),
        })),
      }),
      `Apply frame anchor to all clips: ${this._activeClipName}`,
      this._activeClipName
    );
  }

  // --- named frame points ---------------------------------------------------

  /**
   * Add a named point to **every** frame of the clip at the same normalized spot.
   * A point that exists on only some frames is almost always an accident; scripts
   * read it by name every tick and a hole reads as "the socket vanished".
   * Returns the generated name so the host can highlight it.
   */
  async addFramePoint(): Promise<string | null> {
    const clip = this.activeClip;
    if (!clip) {
      return null;
    }

    const existing = new Set(collectClipPointNames(clip));
    let suggestion = 'point';
    for (let index = 1; existing.has(suggestion); index += 1) {
      suggestion = `point${index}`;
    }

    // Auto-named like clips are; the list row is an input, so renaming is inline.
    const name = suggestion;
    this._frameDraft = null;
    await this.applyClipUpdate(
      candidate => ({
        ...candidate,
        frames: candidate.frames.map(frame => ({
          ...frame,
          points: [...(frame.points ?? []), { name, x: 0.5, y: 0.5, angle: 0 }],
        })),
      }),
      `Add frame point "${name}": ${this._activeClipName}`
    );

    return name;
  }

  /** Returns the applied name, or `null` when the rename was a no-op / a duplicate. */
  async renameFramePoint(name: string, rawNextName: string): Promise<string | null> {
    const nextName = rawNextName.trim();
    const clip = this.activeClip;
    if (!clip || !nextName || nextName === name) {
      return null;
    }
    if (collectClipPointNames(clip).includes(nextName)) {
      return null;
    }

    this._frameDraft = null;
    await this.applyClipUpdate(
      candidate => ({
        ...candidate,
        frames: candidate.frames.map(frame => ({
          ...frame,
          points: (frame.points ?? []).map(point =>
            point.name === name ? { ...point, name: nextName } : point
          ),
        })),
      }),
      `Rename frame point: ${name} -> ${nextName}`
    );

    return nextName;
  }

  async removeFramePoint(name: string): Promise<void> {
    this._frameDraft = null;
    await this.applyClipUpdate(
      clip => ({
        ...clip,
        frames: clip.frames.map(frame => ({
          ...frame,
          points: (frame.points ?? []).filter(point => point.name !== name),
        })),
      }),
      `Remove frame point "${name}": ${this._activeClipName}`
    );
  }

  /** Stamp the selected frame's version of a point onto every frame of the clip. */
  async copyFramePointToClip(name: string): Promise<void> {
    const source = findAnimationFramePoint(this.getSelectedFrame(), name);
    if (!source) {
      return;
    }

    this._frameDraft = null;
    await this.applyClipUpdate(
      clip => ({
        ...clip,
        frames: clip.frames.map(frame => {
          const points = frame.points ?? [];
          const replacement = { ...source };
          return {
            ...frame,
            points: points.some(point => point.name === name)
              ? points.map(point => (point.name === name ? replacement : point))
              : [...points, replacement],
          };
        }),
      }),
      `Copy frame point "${name}" to clip: ${this._activeClipName}`
    );
  }

  // --- spritesheet / slicing ------------------------------------------------

  async updateTexturePath(nextTexturePath: string): Promise<void> {
    const trimmedTexturePath = nextTexturePath.trim();
    const currentResource = this._resource;
    const shouldPromptForAutoSlice =
      Boolean(trimmedTexturePath) &&
      currentResource !== null &&
      !this.hasAnyFrames(currentResource);

    const didMutate = await this.applyResourceUpdate(
      resource => ({
        ...resource,
        texturePath: trimmedTexturePath,
      }),
      trimmedTexturePath ? `Update spritesheet: ${trimmedTexturePath}` : 'Clear spritesheet texture'
    );

    if (!didMutate || !trimmedTexturePath || !shouldPromptForAutoSlice) {
      return;
    }

    await this.openSlicerDialog(trimmedTexturePath);
  }

  async openTextureSlicer(): Promise<void> {
    const texturePath = this._resource?.texturePath?.trim() ?? '';
    if (!texturePath) {
      return;
    }

    await this.openSlicerDialog(texturePath);
  }

  // --- Inspector-facing contract (AnimationInspectorController) --------------

  getInspectorSnapshot(): AnimationInspectorSnapshot {
    const activeClip = this.activeClip;
    return {
      assetPath: this._assetPath,
      resource: this._resource,
      clips: this._resource?.clips ?? [],
      activeClip,
      activeClipName: this._activeClipName,
      selectedFrame: this.getSelectedFrame(activeClip),
      selectedFrameIndex: this._selectedFrameIndex,
    };
  }

  subscribeInspector(listener: () => void): () => void {
    this.inspectorListeners.add(listener);
    return () => {
      this.inspectorListeners.delete(listener);
    };
  }

  // --- internals ------------------------------------------------------------

  private getSelectedFrame(
    activeClip: AnimationClip | null = this.activeClip
  ): AnimationFrame | null {
    if (!activeClip || activeClip.frames.length === 0) {
      return null;
    }

    const frame = activeClip.frames[this._selectedFrameIndex] ?? null;
    if (!frame) {
      return null;
    }

    return this._frameDraft ?? frame;
  }

  private getPreviewFrame(
    activeClip: AnimationClip | null = this.activeClip
  ): AnimationFrame | null {
    if (!activeClip || activeClip.frames.length === 0) {
      return null;
    }

    const frame = activeClip.frames[this._previewFrameIndex] ?? activeClip.frames[0] ?? null;
    if (!frame) {
      return null;
    }

    return this._frameDraft && this._previewFrameIndex === this._selectedFrameIndex
      ? this._frameDraft
      : frame;
  }

  private getSelectedAnchor(): StagePoint | null {
    const selectedFrame = this.getSelectedFrame();
    if (!selectedFrame) {
      return null;
    }

    return {
      x: selectedFrame.anchor.x,
      y: selectedFrame.anchor.y,
    };
  }

  private stepPreviewFrame(activeClip: AnimationClip): boolean {
    if (activeClip.frames.length === 0) {
      return false;
    }

    if (activeClip.playbackMode === 'ping-pong') {
      const nextIndex = this._previewFrameIndex + this.previewDirection;
      if (nextIndex >= 0 && nextIndex < activeClip.frames.length) {
        this._previewFrameIndex = nextIndex;
        return true;
      }

      if (activeClip.frames.length === 1) {
        return activeClip.loop;
      }

      this.previewDirection *= -1;
      const bouncedIndex = this._previewFrameIndex + this.previewDirection;
      if (bouncedIndex >= 0 && bouncedIndex < activeClip.frames.length) {
        this._previewFrameIndex = bouncedIndex;
        if (!activeClip.loop && bouncedIndex === 0) {
          return false;
        }
        return true;
      }

      return false;
    }

    const nextIndex = this._previewFrameIndex + 1;
    if (nextIndex < activeClip.frames.length) {
      this._previewFrameIndex = nextIndex;
      return true;
    }

    if (!activeClip.loop) {
      this._previewFrameIndex = activeClip.frames.length - 1;
      return false;
    }

    this._previewFrameIndex = 0;
    return true;
  }

  private async applyClipUpdate(
    updater: (clip: AnimationClip) => AnimationClip,
    label: string
  ): Promise<boolean> {
    return this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this._activeClipName ? updater(clip) : clip
        ),
      }),
      label
    );
  }

  private async applyResourceUpdate(
    updater: (resource: AnimationResource) => AnimationResource,
    label: string,
    nextActiveClipName?: string
  ): Promise<boolean> {
    if (!this._assetPath || !this._resource || !this.animationId) {
      return false;
    }

    const nextResource = updater(this._resource);
    const pushed = await this.deps.operations.invokeAndPush(
      new UpdateAnimationDocumentOperation({
        animationId: this.animationId,
        nextResource,
        label,
      })
    );
    if (!pushed) {
      return false;
    }

    this._resource = normalizeAnimationResource(nextResource);
    const preservedActiveClipName =
      nextActiveClipName ??
      (this._activeClipName && nextResource.clips.some(clip => clip.name === this._activeClipName)
        ? this._activeClipName
        : (nextResource.clips[0]?.name ?? ''));
    this._activeClipName = preservedActiveClipName;
    this.persistActiveClipName(this._activeClipName);
    this.syncFrameStateToActiveClip(Boolean(nextActiveClipName));
    this.notify();

    await this.syncPreviewTexture();

    const selectedSprite = this.getSelectedAnimatedSprite();
    if (
      selectedSprite &&
      selectedSprite.animationResourcePath === this._assetPath &&
      this._activeClipName &&
      selectedSprite.currentClip !== this._activeClipName
    ) {
      await this.deps.commandDispatcher.execute(
        new UpdateObjectPropertyCommand({
          nodeId: selectedSprite.nodeId,
          propertyPath: 'currentClip',
          value: this._activeClipName,
        })
      );
    }

    return true;
  }

  private hasAnyFrames(resource: AnimationResource): boolean {
    return resource.clips.some(clip => clip.frames.length > 0);
  }

  private async addFramesFromGrid(
    columns: number = this.slicerColumns,
    rows: number = this.slicerRows
  ): Promise<void> {
    const clip = this.activeClip;
    const texturePath = this._resource?.texturePath?.trim() ?? '';
    if (!clip || columns <= 0 || rows <= 0 || !texturePath) {
      return;
    }

    const sliced = await this.sliceSpritesheetIntoFrameFiles(
      texturePath,
      columns,
      rows,
      clip.frames.length + 1,
      clip.name
    );
    const generatedFrames: AnimationFrame[] = sliced.map(cell => ({
      textureIndex: 0,
      offset: { x: 0, y: 0 },
      repeat: { x: 1, y: 1 },
      durationMultiplier: 1,
      anchor: { ...DEFAULT_FRAME_ANCHOR },
      texturePath: cell.texturePath,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      collisionPolygon: [],
      sourceSize: cell.sourceSize,
    }));

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        texturePath: '',
        clips: resource.clips.map(existingClip =>
          existingClip.name === this._activeClipName
            ? { ...existingClip, frames: [...existingClip.frames, ...generatedFrames] }
            : existingClip
        ),
      }),
      `Slice spritesheet into ${generatedFrames.length} frames`
    );
  }

  /**
   * Cut the bound spritesheet into per-frame PNG files inside the animation's folder. Cell
   * extraction is the shared pure {@link sliceImageBlob}; this method owns only the
   * `.pix3anim`-specific naming (clip-scoped so two clips can't overwrite each other) and writing.
   */
  private async sliceSpritesheetIntoFrameFiles(
    texturePath: string,
    columns: number,
    rows: number,
    startFrameNumber: number,
    clipName: string
  ): Promise<Array<{ texturePath: string; sourceSize?: AnimationSize }>> {
    const assetPath = this._assetPath ? normalizeAnimationAssetPath(this._assetPath) : '';
    if (!assetPath) {
      return [];
    }

    const sourceBlob = await this.deps.projectStorage.readBlob(texturePath);
    const cells = await sliceImageBlob(sourceBlob, { columns, rows });
    // Every cell of a grid slice is the same size — decode one, stamp all.
    const cellSize = cells.length > 0 ? await readBlobSize(cells[0]) : null;
    const generated: Array<{ texturePath: string; sourceSize?: AnimationSize }> = [];

    for (const cell of cells) {
      const framePath = buildAnimationFrameResourcePath(
        assetPath,
        startFrameNumber + generated.length,
        { clipName }
      );
      await this.deps.projectStorage.writeBinaryFile(framePath, await cell.arrayBuffer());
      generated.push({
        texturePath: framePath,
        sourceSize: cellSize ? { width: cellSize.width, height: cellSize.height } : undefined,
      });
    }

    return generated;
  }

  private async openSlicerDialog(texturePath: string): Promise<void> {
    const clipName = this._activeClipName || this._resource?.clips[0]?.name || 'idle';
    const result = await this.deps.autoSliceDialog.showDialog({
      texturePath,
      contextLabel: clipName,
      defaultColumns: this.slicerColumns,
      defaultRows: this.slicerRows,
    });

    if (!result) {
      return;
    }

    this.slicerColumns = result.columns;
    this.slicerRows = result.rows;
    await this.addFramesFromGrid(result.columns, result.rows);
  }

  /**
   * Intrinsic pixel size of a frame's raster, stamped into the document so
   * `sizeMode: 'native'` layout never has to wait on a texture load. Undefined
   * when the file can't be read or decoded — the frame then falls back to
   * stretch layout, exactly as legacy content does.
   */
  private async readFrameSourceSize(texturePath: string): Promise<AnimationSize | undefined> {
    try {
      const blob = await this.deps.projectStorage.readBlob(texturePath);
      const size = await readBlobSize(blob);
      return size ? { width: size.width, height: size.height } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Highest `<clip>_<nnnn>` number already referenced by the document, so imports keep counting up
   * instead of overwriting files that earlier slices produced.
   */
  private nextFrameFileNumber(clipName: string): number {
    const prefix = sanitizeFrameFilePrefix(clipName);
    const pattern = new RegExp(`/${prefix}_(\\d+)\\.[^./]+$`, 'i');
    let highest = this.reservedFrameFileNumbers.get(prefix) ?? 0;

    for (const clip of this._resource?.clips ?? []) {
      for (const frame of clip.frames) {
        const match = pattern.exec(getAnimationFrameTexturePath(this._resource, frame));
        if (match) {
          highest = Math.max(highest, Number(match[1]) || 0);
        }
      }
    }

    return highest + 1;
  }

  /**
   * {@link nextFrameFileNumber}, but the number is remembered for the rest of the
   * session. Undoing a bake un-references its file, which would otherwise let the
   * next bake reuse the number and overwrite pixels a *redo* still points at.
   */
  private reserveFrameFileNumber(clipName: string): number {
    const frameNumber = this.nextFrameFileNumber(clipName);
    this.reservedFrameFileNumbers.set(sanitizeFrameFilePrefix(clipName), frameNumber);
    return frameNumber;
  }

  private getSelectedAnimatedSprite(): AnimatedSprite2D | null {
    const primaryNodeId = appState.selection.primaryNodeId;
    if (!primaryNodeId) {
      return null;
    }

    const graph = this.deps.sceneManager.getActiveSceneGraph();
    const node = graph?.nodeMap.get(primaryNodeId);
    return node instanceof AnimatedSprite2D ? node : null;
  }

  private resolveAssetPath(): string | null {
    const directResourcePath = this.resourcePath.trim();
    if (directResourcePath) {
      return directResourcePath;
    }

    const tab = this.tabId
      ? appState.tabs.tabs.find(
          candidate => candidate.id === this.tabId && candidate.type === 'animation'
        )
      : null;

    return tab?.resourceId ?? null;
  }

  private async syncFromResourceContext(preserveClip: boolean): Promise<void> {
    const nextAssetPath = this.resolveAssetPath();
    const assetChanged = nextAssetPath !== this._assetPath;
    const nextAnimationId = nextAssetPath ? deriveAnimationDocumentId(nextAssetPath) : null;
    const animationChanged = nextAnimationId !== this.animationId;

    this._assetPath = nextAssetPath;
    this.animationId = nextAnimationId;
    this.syncActiveInspectorController();
    await this.syncFromDocumentState(preserveClip && !assetChanged && !animationChanged);
  }

  private async syncFromDocumentState(preserveClip: boolean): Promise<void> {
    const assetPath = this._assetPath;
    const animationId = this.animationId;

    if (!assetPath || !animationId) {
      this.stopPlayback();
      this._resource = null;
      this._activeClipName = '';
      this._errorMessage = null;
      this.resetCurrentTexturePreview();
      this.syncFrameStateToActiveClip();
      this.syncActiveInspectorController();
      this.notify();
      return;
    }

    const resource = appState.animations.resources[animationId] ?? null;
    const isActiveLoadError =
      appState.animations.activeAnimationId === animationId &&
      appState.animations.loadState === 'error';

    this._errorMessage = isActiveLoadError ? appState.animations.loadError : null;

    if (!resource) {
      this.stopPlayback();
      this._resource = null;
      this._activeClipName = '';
      this.resetCurrentTexturePreview();
      this.syncFrameStateToActiveClip();
      this.syncActiveInspectorController();
      this.notify();
      return;
    }

    this._resource = resource;

    const clipNames = new Set(resource.clips.map(clip => clip.name));
    const selectedSprite = this.getSelectedAnimatedSprite();
    const selectedClipName =
      selectedSprite?.animationResourcePath === assetPath ? selectedSprite.currentClip : '';
    const storedClipName = this.getStoredActiveClipName();
    const preferredClipName =
      preserveClip && clipNames.has(this._activeClipName)
        ? this._activeClipName
        : storedClipName && clipNames.has(storedClipName)
          ? storedClipName
          : selectedClipName && clipNames.has(selectedClipName)
            ? selectedClipName
            : (resource.clips[0]?.name ?? '');

    this._activeClipName = preferredClipName;
    this.persistActiveClipName(preferredClipName);
    // Nothing is selected yet on the first sync of a document, and there the frame
    // index the tab stored is the right answer — that is what `contextState`
    // records a session for. Forcing frame 0 unconditionally made a restored
    // `animation:` tab always reopen on the first frame even though the index had
    // been persisted all along. Swapping the tab to *another* asset still resets:
    // the stored index describes the document that just went away.
    this.syncFrameStateToActiveClip(!preserveClip && this._selectedFrameIndex >= 0);
    this.notify();

    await this.syncPreviewTexture();

    this.syncActiveInspectorController();
  }

  private syncFrameStateToActiveClip(preferFirstFrame = false): void {
    const activeClip = this.activeClip;
    const frameCount = activeClip?.frames.length ?? 0;
    const storedFrameIndex = this.getStoredSelectedFrameIndex();
    this._frameDraft = null;

    if (frameCount === 0) {
      this._selectedFrameIndex = -1;
      this._selectedFrameIndices = [];
      this._previewFrameIndex = -1;
      this.previewElapsedSeconds = 0;
      this.selectionAnchorFrameIndex = -1;
      this.persistSelectedFrameIndex(-1);
      return;
    }

    const fallbackIndex = preferFirstFrame
      ? 0
      : this._selectedFrameIndex >= 0
        ? Math.min(this._selectedFrameIndex, frameCount - 1)
        : storedFrameIndex >= 0
          ? Math.min(storedFrameIndex, frameCount - 1)
          : 0;

    // This runs on EVERY appState.tabs/project/animations notification, and
    // `persistSelectedFrameIndex` below writes `tab.contextState` — so selecting a
    // frame re-enters here on the next valtio flush. Collapsing to `[fallbackIndex]`
    // unconditionally is what made ctrl/shift multi-select useless: the strip lit up
    // and then went back to one card a tick later, so "delete selected frames" only
    // ever deleted one. Keep an established multi-selection when this re-entry is
    // spurious — same primary frame, all indices still in range.
    const isSpuriousResync =
      !preferFirstFrame &&
      this._selectedFrameIndices.length > 1 &&
      fallbackIndex === this._selectedFrameIndex &&
      this._selectedFrameIndices.every(frameIndex => frameIndex < frameCount);

    this._selectedFrameIndex = fallbackIndex;
    this._selectedFrameIndices = isSpuriousResync ? this._selectedFrameIndices : [fallbackIndex];
    this._previewFrameIndex = this._isPreviewPlaying
      ? Math.min(
          this._previewFrameIndex >= 0 ? this._previewFrameIndex : fallbackIndex,
          frameCount - 1
        )
      : fallbackIndex;
    this.previewElapsedSeconds = 0;
    this.selectionAnchorFrameIndex = fallbackIndex;
    this.persistSelectedFrameIndex(fallbackIndex);
  }

  private getResolvedFrameTexturePath(frame: AnimationFrame | null): string {
    return getAnimationFrameTexturePath(this._resource, frame);
  }

  private async syncPreviewTexture(): Promise<void> {
    const previewFrame = this.getPreviewFrame();
    const texturePath = this.getResolvedFrameTexturePath(previewFrame);
    this.previewTexturePath = texturePath;
    if (!texturePath) {
      this.resetCurrentTexturePreview();
      return;
    }

    const token = ++this.loadToken;
    const cachedTextureUrl = this.texturePreviewCache.get(texturePath) ?? '';
    const cachedDimensions = this.textureDimensionsCache.get(texturePath) ?? {
      width: 0,
      height: 0,
    };

    if (cachedTextureUrl) {
      this.texturePreviewUrl = cachedTextureUrl;
      this.textureDimensions = cachedDimensions;
      return;
    }

    this.resetCurrentTexturePreview();
    await this.ensureTexturePreviewLoaded(texturePath, token);
  }

  private async ensureTexturePreviewLoaded(
    texturePath: string,
    token = this.loadToken
  ): Promise<void> {
    if (!texturePath) {
      return;
    }

    const inFlight = this.texturePreviewLoads.get(texturePath);
    if (inFlight) {
      await inFlight;
      if (texturePath === this.previewTexturePath && token === this.loadToken) {
        this.texturePreviewUrl = this.texturePreviewCache.get(texturePath) ?? '';
        this.textureDimensions = this.textureDimensionsCache.get(texturePath) ?? {
          width: 0,
          height: 0,
        };
      }
      return;
    }

    const loadPromise = (async () => {
      try {
        const blob = await this.deps.projectStorage.readBlob(texturePath);
        const textureUrl = URL.createObjectURL(blob);
        const dimensions = await readTextureDimensions(textureUrl);
        this.texturePreviewCache.set(texturePath, textureUrl);
        this.textureDimensionsCache.set(texturePath, dimensions);

        if (texturePath === this.previewTexturePath && token === this.loadToken) {
          this.texturePreviewUrl = textureUrl;
          this.textureDimensions = dimensions;
        }

        this.notify();
      } catch {
        if (texturePath === this.previewTexturePath && token === this.loadToken) {
          this.resetCurrentTexturePreview();
        }
      } finally {
        this.texturePreviewLoads.delete(texturePath);
      }
    })();

    this.texturePreviewLoads.set(texturePath, loadPromise);
    await loadPromise;
  }

  private resetCurrentTexturePreview(): void {
    this.texturePreviewUrl = '';
    this.textureDimensions = { width: 0, height: 0 };
  }

  private clearTexturePreviewCache(): void {
    for (const textureUrl of this.texturePreviewCache.values()) {
      if (textureUrl.startsWith('blob:')) {
        URL.revokeObjectURL(textureUrl);
      }
    }

    this.texturePreviewCache.clear();
    this.textureDimensionsCache.clear();
    this.texturePreviewLoads.clear();
    this.alphaMaskCache.clear();
    this.previewTexturePath = '';
    this.resetCurrentTexturePreview();
  }

  private getStoredActiveClipName(): string {
    if (!this.tabId) {
      return '';
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    const storedClipName = tab?.contextState?.activeClipName;
    return typeof storedClipName === 'string' ? storedClipName : '';
  }

  private getStoredSelectedFrameIndex(): number {
    if (!this.tabId) {
      return -1;
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    const storedFrameIndex = tab?.contextState?.selectedFrameIndex;
    return typeof storedFrameIndex === 'number' && Number.isInteger(storedFrameIndex)
      ? storedFrameIndex
      : -1;
  }

  private persistActiveClipName(clipName: string): void {
    if (!this.tabId) {
      return;
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    if (!tab) {
      return;
    }

    const currentClipName = tab.contextState?.activeClipName;
    if (currentClipName === clipName) {
      return;
    }

    tab.contextState = {
      ...(tab.contextState ?? {}),
      activeClipName: clipName,
    };
  }

  private persistSelectedFrameIndex(selectedFrameIndex: number): void {
    if (!this.tabId) {
      return;
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    if (!tab) {
      return;
    }

    if (tab.contextState?.selectedFrameIndex === selectedFrameIndex) {
      return;
    }

    tab.contextState = {
      ...(tab.contextState ?? {}),
      selectedFrameIndex,
    };
  }

  private syncActiveInspectorController(): void {
    const isActiveAnimationTab =
      Boolean(this._assetPath) && Boolean(this.tabId) && appState.tabs.activeTabId === this.tabId;

    if (isActiveAnimationTab) {
      this.deps.animationEditorService.setActiveController(this);
      return;
    }

    if (this.deps.animationEditorService.getActiveController() === this) {
      this.deps.animationEditorService.setActiveController(null);
    }
  }

  /**
   * Fan out a state change. Mirrors the Lit `updated()` gate the panel used before
   * the extraction: the Inspector only hears about changes it can observe, and the
   * preview texture is re-resolved only when the frame it shows can have changed.
   */
  private notify(): void {
    const assetPathChanged = this._assetPath !== this.lastNotifiedAssetPath;
    const resourceChanged = this._resource !== this.lastNotifiedResource;
    const activeClipNameChanged = this._activeClipName !== this.lastNotifiedActiveClipName;
    const selectedFrameChanged = this._selectedFrameIndex !== this.lastNotifiedSelectedFrameIndex;
    const previewFrameChanged = this._previewFrameIndex !== this.lastNotifiedPreviewFrameIndex;

    this.lastNotifiedAssetPath = this._assetPath;
    this.lastNotifiedResource = this._resource;
    this.lastNotifiedActiveClipName = this._activeClipName;
    this.lastNotifiedSelectedFrameIndex = this._selectedFrameIndex;
    this.lastNotifiedPreviewFrameIndex = this._previewFrameIndex;

    if (assetPathChanged || resourceChanged || activeClipNameChanged || selectedFrameChanged) {
      for (const listener of [...this.inspectorListeners]) {
        listener();
      }
    }

    if (resourceChanged || activeClipNameChanged || selectedFrameChanged || previewFrameChanged) {
      void this.syncPreviewTexture();
    }

    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function cloneFrame(frame: AnimationFrame): AnimationFrame {
  return {
    ...frame,
    offset: { ...frame.offset },
    repeat: { ...frame.repeat },
    anchor: { ...frame.anchor },
    boundingBox: { ...frame.boundingBox },
    collisionPolygon: frame.collisionPolygon.map(point => ({ ...point })),
    points: (frame.points ?? []).map(point => ({ ...point })),
  };
}

function readTextureDimensions(textureUrl: string): Promise<TextureDimensions> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width || 0,
        height: image.naturalHeight || image.height || 0,
      });
    };
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = textureUrl;
  });
}
