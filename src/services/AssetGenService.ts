import { inject, injectable } from '@/fw/di';
import { AiImageSettingsService } from '@/services/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import {
  ImageGenError,
  type AspectRatio,
  type Background,
  type ReferenceImage,
} from '@/services/image-gen/ImageGenTypes';
import {
  BackgroundRemovalService,
  type BgRemovalEngine,
  type BgRemovalQuality,
} from '@/services/BackgroundRemovalService';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import { GenerationHistoryService } from '@/services/GenerationHistoryService';
import { appState } from '@/state';
import {
  base64ToBlob,
  blobToBase64,
  blobToDataUrl,
  compressImageBlob,
  cropImageBlob,
  ensureImageExtension,
  flipImageBlob,
  imageAlphaStats,
  normalizeAssetPath,
  readBlobSize,
  resizeImageBlob,
  rotateImageBlob,
  trimImageBlob,
  type AlphaStats,
  type CropRectPixels,
  type FlipAxis,
  type ImageEncoding,
  type QuarterTurns,
} from '@/services/image-gen/image-ops';

/** Where an in-memory image handle came from (informational). */
export type AssetImageSource =
  | 'generated'
  | 'file'
  | 'history'
  | 'resized'
  | 'cropped'
  | 'trimmed'
  | 'rotated'
  | 'flipped'
  | 'bg-removed'
  | 'compressed'
  | 'import';

/** A retained working image, referenced by id across programmatic ops. Blob stays in memory only. */
interface AssetImage {
  id: string;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  source: AssetImageSource;
  prompt?: string;
  createdAt: number;
}

/** JSON-safe view of an {@link AssetImage} (never carries the raw blob). */
export interface AssetImageMeta {
  id: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  source: AssetImageSource;
  prompt?: string;
  createdAt: number;
}

export interface AssetGenReference {
  /** Project resource path (`res://…` or project-relative). Mutually exclusive with `data`. */
  path?: string;
  /** Raw base64 (no `data:` prefix). Requires `mimeType`. */
  data?: string;
  mimeType?: string;
}

export interface AssetGenGenerateOptions {
  prompt: string;
  /** Reference images: project paths (strings) or `{data,mimeType}` / `{path}` descriptors. */
  references?: ReadonlyArray<string | AssetGenReference>;
  aspectRatio?: AspectRatio;
  imageSize?: string;
  quality?: string;
  /** Request a transparent background from providers that support alpha (e.g. OpenAI GPT Image). */
  transparent?: boolean;
  background?: Background;
  /** Override the configured provider/model for this one call. */
  providerId?: string;
  modelId?: string;
}

export interface AssetGenResizeOptions {
  /** Longest-edge cap in px (preserves aspect, downscale-only unless `allowUpscale`). */
  maxSize?: number;
  width?: number;
  height?: number;
  allowUpscale?: boolean;
  /** Re-encode to this format (default: keep the source format). */
  format?: ImageEncoding;
  quality?: number;
}

export interface AssetGenCompressOptions extends AssetGenResizeOptions {
  /** Defaults to `image/webp` at quality 0.85 when omitted. */
  format?: ImageEncoding;
}

export interface AssetGenBgOptions {
  engine?: BgRemovalEngine;
  quality?: BgRemovalQuality;
  fillHoles?: boolean;
}

export interface AssetGenTrimOptions {
  /** Transparent padding (px) kept around the opaque content. Default 2. */
  padding?: number;
  /** Alpha (0..255) at/below which a pixel counts as empty. Default 0. */
  alphaThreshold?: number;
  /** Center the trimmed content on a square canvas (for icon grids). */
  square?: boolean;
}

/**
 * Game-ready post-processing preset for a generated/opened image:
 * - `sprite` — remove background, trim to the opaque bounding box, downscale.
 * - `icon` — as `sprite`, then center on a square canvas so icon grids align.
 * - `texture` — downscale only, keep the background (tiles, photos, backgrounds).
 * - `none` — no processing (raw save).
 */
export type AssetPostProcessPreset = 'sprite' | 'icon' | 'texture' | 'none';

/**
 * Sane longest-edge caps (px) applied by {@link AssetGenService.postProcess} when neither an
 * explicit `maxSize` nor the user's `defaultSaveMaxSize` preference is set. Without these an unset
 * default (0) means "keep original", which saves multi-hundred-KB, ~1400px game assets — not
 * game-ready. The agent generates for games, so it caps by intent instead.
 */
const PRESET_DEFAULT_MAX_SIZE: Record<AssetPostProcessPreset, number> = {
  sprite: 512,
  icon: 256,
  texture: 1024,
  none: 0,
};

export interface AssetPostProcessOptions {
  /** Longest-edge cap in px; defaults to the AI-image preference `defaultSaveMaxSize`. */
  maxSize?: number;
  bgEngine?: BgRemovalEngine;
  bgQuality?: BgRemovalQuality;
}

export interface AssetGenSaveOptions {
  /** Apply a longest-edge downscale before writing (px); 0/omitted = keep current size. */
  maxSize?: number;
  /** Re-encode to this format before writing (default: keep the handle's format). */
  format?: ImageEncoding;
  quality?: number;
}

export interface AssetGenSaveResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}

export interface AssetGenStatus {
  providerId: string;
  providerLabel: string | null;
  modelId: string;
  modelLabel: string | null;
  keyConfigured: boolean;
  projectReady: boolean;
  handles: number;
  defaultSaveMaxSize: number;
  capabilities: {
    aspectRatios: readonly AspectRatio[];
    imageSizes: readonly string[];
    qualities: readonly string[];
    maxReferenceImages: number;
    supportsReferenceImages: boolean;
    supportsTransparency: boolean;
  } | null;
}

/**
 * Headless, DOM-free façade over the AI image pipeline — generation, local transforms (resize,
 * crop, compress, background removal) and saving into the project. It's the engine the interactive
 * {@link AssetGeneratorPanel} conceptually mirrors, and the surface the dev debug bridge exposes as
 * `window.__PIX3_DEBUG__.assets` so agents can drive image work programmatically **using the user's
 * saved (encrypted) API key** — no panel DOM, no headless-key handling.
 *
 * Working images are kept in an in-memory handle registry keyed by id; every method returns
 * JSON-safe {@link AssetImageMeta} (never a blob), so results round-trip cleanly through
 * `evaluate_script`. Blobs live only for the editor session and are freed via {@link discard} /
 * {@link clear} (or when the page reloads).
 */
@injectable()
export class AssetGenService {
  @inject(ImageGenProviderRegistry)
  private readonly providers!: ImageGenProviderRegistry;

  @inject(AiImageSettingsService)
  private readonly aiSettings!: AiImageSettingsService;

  @inject(BackgroundRemovalService)
  private readonly bgRemoval!: BackgroundRemovalService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(GenerationHistoryService)
  private readonly historyService!: GenerationHistoryService;

  private readonly images = new Map<string, AssetImage>();

  // -- status ----------------------------------------------------------------

  async status(providerId?: string): Promise<AssetGenStatus> {
    const resolvedProviderId = providerId ?? this.aiSettings.getSelectedProvider()?.id ?? '';
    const provider = this.providers.get(resolvedProviderId);
    const modelId = this.aiSettings.getSelectedModelId(resolvedProviderId) ?? '';
    const model = provider?.getModel(modelId);
    const caps = model?.capabilities;
    let keyConfigured = false;
    if (resolvedProviderId) {
      try {
        keyConfigured = await this.aiSettings.hasApiKey(resolvedProviderId);
      } catch {
        keyConfigured = false;
      }
    }
    return {
      providerId: resolvedProviderId,
      providerLabel: provider?.label ?? null,
      modelId,
      modelLabel: model?.label ?? null,
      keyConfigured,
      projectReady: appState.project.status === 'ready',
      handles: this.images.size,
      defaultSaveMaxSize: this.aiSettings.getPreferences().defaultSaveMaxSize,
      capabilities: caps
        ? {
            aspectRatios: caps.aspectRatios,
            imageSizes: caps.imageSizes,
            qualities: caps.qualities ?? [],
            maxReferenceImages: caps.maxReferenceImages,
            supportsReferenceImages: caps.supportsReferenceImages,
            supportsTransparency: caps.supportsTransparency,
          }
        : null,
    };
  }

  // -- generation ------------------------------------------------------------

  async generate(options: AssetGenGenerateOptions): Promise<AssetImageMeta> {
    const prompt = options.prompt?.trim();
    if (!prompt) {
      throw new ImageGenError('unknown', 'A prompt is required.');
    }

    const providerId = options.providerId ?? this.aiSettings.getSelectedProvider()?.id ?? '';
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ImageGenError('unknown', `Unknown image provider: ${providerId || '(none)'}.`);
    }
    const modelId = options.modelId ?? this.aiSettings.getSelectedModelId(providerId) ?? '';
    const model = provider.getModel(modelId);
    if (!model) {
      throw new ImageGenError('unknown', `Unknown model "${modelId}" for provider ${providerId}.`);
    }

    const apiKey = await this.aiSettings.getApiKey(providerId);
    if (!apiKey) {
      throw new ImageGenError(
        'missing-key',
        `No API key configured for "${providerId}". Set one in Editor Settings → AI (the human must enter it once).`
      );
    }

    const caps = model.capabilities;
    const references = caps.supportsReferenceImages
      ? await this.buildReferences(options.references ?? [], caps.maxReferenceImages)
      : [];

    const background: Background | undefined =
      options.background ??
      (caps.supportsTransparency && options.transparent ? 'transparent' : undefined);

    const result = await provider.generate(
      {
        prompt,
        references,
        aspectRatio:
          options.aspectRatio && caps.aspectRatios.includes(options.aspectRatio)
            ? options.aspectRatio
            : undefined,
        imageSize:
          options.imageSize && caps.imageSizes.includes(options.imageSize)
            ? options.imageSize
            : undefined,
        quality:
          options.quality && caps.qualities?.includes(options.quality)
            ? options.quality
            : undefined,
        background,
      },
      { apiKey, modelId }
    );

    const image = result.images[0];
    if (!image) {
      throw new ImageGenError('empty', 'The provider returned no image.');
    }

    const blob = base64ToBlob(image.data, image.mimeType);
    const stored = await this.store(blob, image.mimeType, 'generated', prompt);

    // Mirror the panel: cache generations in history so they survive a reload / show in the panel.
    try {
      await this.historyService.add({
        providerId,
        modelId,
        prompt,
        aspectRatio: options.aspectRatio,
        imageSize: options.imageSize,
        mimeType: image.mimeType,
        blob,
        width: stored.width,
        height: stored.height,
      });
    } catch {
      // history is a convenience cache; never fail a generation because it couldn't persist
    }

    return this.toMeta(stored);
  }

  // -- transforms ------------------------------------------------------------

  async resize(id: string, options: AssetGenResizeOptions): Promise<AssetImageMeta> {
    const image = this.require(id);
    const result = await resizeImageBlob(image.blob, {
      maxSize: options.maxSize,
      width: options.width,
      height: options.height,
      allowUpscale: options.allowUpscale,
      mimeType: options.format,
      quality: options.quality,
    });
    const stored = await this.store(
      result.blob,
      result.blob.type || image.mimeType,
      'resized',
      image.prompt
    );
    return this.toMeta(stored);
  }

  async crop(id: string, rect: CropRectPixels, format?: ImageEncoding): Promise<AssetImageMeta> {
    const image = this.require(id);
    const result = await cropImageBlob(image.blob, rect, { mimeType: format });
    const stored = await this.store(
      result.blob,
      result.blob.type || 'image/png',
      'cropped',
      image.prompt
    );
    return this.toMeta(stored);
  }

  /** Rotate a handle clockwise by 90° (`1`), 180° (`2`) or 270° (`3`). Returns a NEW handle. */
  async rotate(id: string, quarterTurns: QuarterTurns): Promise<AssetImageMeta> {
    const image = this.require(id);
    const result = await rotateImageBlob(image.blob, quarterTurns);
    const stored = await this.store(
      result.blob,
      result.blob.type || image.mimeType,
      'rotated',
      image.prompt
    );
    return this.toMeta(stored);
  }

  /** Mirror a handle horizontally or vertically. Returns a NEW handle. */
  async flip(id: string, axis: FlipAxis): Promise<AssetImageMeta> {
    const image = this.require(id);
    const result = await flipImageBlob(image.blob, axis);
    const stored = await this.store(
      result.blob,
      result.blob.type || image.mimeType,
      'flipped',
      image.prompt
    );
    return this.toMeta(stored);
  }

  /** Crop to the opaque bounding box of an image (see {@link trimImageBlob}). */
  async trim(id: string, options: AssetGenTrimOptions = {}): Promise<AssetImageMeta> {
    const image = this.require(id);
    const result = await trimImageBlob(image.blob, {
      padding: options.padding,
      alphaThreshold: options.alphaThreshold,
      square: options.square,
    });
    const stored = await this.store(
      result.blob,
      result.blob.type || 'image/png',
      'trimmed',
      image.prompt
    );
    return this.toMeta(stored);
  }

  async compress(id: string, options: AssetGenCompressOptions = {}): Promise<AssetImageMeta> {
    const image = this.require(id);
    const result = await compressImageBlob(image.blob, {
      maxSize: options.maxSize,
      width: options.width,
      height: options.height,
      allowUpscale: options.allowUpscale,
      mimeType: options.format,
      quality: options.quality,
    });
    const stored = await this.store(
      result.blob,
      result.blob.type || 'image/webp',
      'compressed',
      image.prompt
    );
    return this.toMeta(stored);
  }

  async removeBackground(id: string, options: AssetGenBgOptions = {}): Promise<AssetImageMeta> {
    const image = this.require(id);
    const prefs = this.aiSettings.getPreferences();
    const output = await this.bgRemoval.removeBackground(image.blob, {
      engine: options.engine ?? prefs.bgRemovalEngine,
      quality: options.quality ?? prefs.bgRemovalQuality,
      fillHoles: options.fillHoles ?? prefs.bgFillHoles,
    });
    const stored = await this.store(output, 'image/png', 'bg-removed', image.prompt);
    return this.toMeta(stored);
  }

  /**
   * Run the game-ready pipeline for a {@link AssetPostProcessPreset} over a handle and return the
   * final handle's metadata. Intermediate handles are freed automatically. Background removal is
   * best-effort — a worker failure falls back to the un-cut image so a save is never blocked. The
   * input handle `id` is left intact for the caller to discard.
   */
  async postProcess(
    id: string,
    preset: AssetPostProcessPreset,
    options: AssetPostProcessOptions = {}
  ): Promise<AssetImageMeta> {
    if (preset === 'none') {
      return this.toMeta(this.require(id));
    }
    const intermediates: string[] = [];
    let currentId = id;
    try {
      if (preset === 'sprite' || preset === 'icon') {
        try {
          const bg = await this.removeBackground(currentId, {
            engine: options.bgEngine,
            quality: options.bgQuality,
          });
          intermediates.push(bg.id);
          currentId = bg.id;
          const trimmed = await this.trim(currentId, {
            padding: 2,
            alphaThreshold: 8,
            square: preset === 'icon',
          });
          intermediates.push(trimmed.id);
          currentId = trimmed.id;
        } catch {
          // Background removal is best-effort: a worker hiccup must not block the save. Keep the
          // un-cut image and still downscale below; the caller's preview shows the result so the
          // agent/user can retry via process_asset.
        }
      }
      // Explicit arg wins; else the user's configured default; else a sane per-preset cap so an
      // unset "keep original" preference doesn't silently save huge game assets.
      const maxSize =
        options.maxSize && options.maxSize > 0
          ? options.maxSize
          : this.aiSettings.getPreferences().defaultSaveMaxSize || PRESET_DEFAULT_MAX_SIZE[preset];
      if (maxSize && maxSize > 0) {
        const resized = await this.resize(currentId, { maxSize });
        intermediates.push(resized.id);
        currentId = resized.id;
      }
      return this.toMeta(this.require(currentId));
    } finally {
      for (const intermediateId of intermediates) {
        if (intermediateId !== currentId) {
          this.discard(intermediateId);
        }
      }
    }
  }

  // -- project I/O -----------------------------------------------------------

  /** Load an existing project asset into a working handle (for cropping/resizing/editing). */
  async open(pathOrRef: string): Promise<AssetImageMeta> {
    const blob = await this.storage.readBlob(pathOrRef);
    const stored = await this.store(blob, blob.type || 'image/png', 'file');
    return this.toMeta(stored);
  }

  /**
   * Write a handle into the project, creating parent directories. Optionally downscales / re-encodes
   * first. The extension is derived from the (possibly re-encoded) mime type when the name lacks one.
   */
  async save(
    id: string,
    name: string,
    options: AssetGenSaveOptions = {}
  ): Promise<AssetGenSaveResult> {
    if (appState.project.status !== 'ready') {
      throw new Error('No project is open — cannot save.');
    }
    const image = this.require(id);
    let blob = image.blob;
    let mimeType = image.mimeType;

    const needsTransform = (options.maxSize && options.maxSize > 0) || Boolean(options.format);
    if (needsTransform) {
      const result = await resizeImageBlob(blob, {
        maxSize: options.maxSize,
        mimeType: options.format ?? (mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'),
        quality: options.quality,
      });
      blob = result.blob;
      mimeType = result.blob.type || mimeType;
    }

    const relativePath = ensureImageExtension(normalizeAssetPath(name), mimeType);
    if (!relativePath) {
      throw new Error('A file name is required.');
    }
    await this.ensureParentDirectory(relativePath);
    await this.storage.writeBinaryFile(relativePath, await blob.arrayBuffer());

    const size = (await readBlobSize(blob)) ?? { width: image.width, height: image.height };
    return {
      path: relativePath,
      width: size.width,
      height: size.height,
      bytes: blob.size,
      mimeType,
    };
  }

  // -- history ---------------------------------------------------------------

  /** Recent generations from the IndexedDB cache (JSON-safe metadata only). */
  async history(limit = 20): Promise<
    Array<{
      id: string;
      prompt: string;
      providerId: string;
      modelId: string;
      mimeType: string;
      width?: number;
      height?: number;
      createdAt: number;
    }>
  > {
    const records = await this.historyService.list(limit);
    return records.map(record => ({
      id: record.id,
      prompt: record.prompt,
      providerId: record.providerId,
      modelId: record.modelId,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      createdAt: record.createdAt,
    }));
  }

  /** Pull a cached generation into a working handle so it can be edited/saved. */
  async openHistory(recordId: string): Promise<AssetImageMeta> {
    const record = await this.historyService.get(recordId);
    if (!record) {
      throw new Error(`No history record: ${recordId}`);
    }
    const stored = await this.store(record.blob, record.mimeType, 'history', record.prompt);
    return this.toMeta(stored);
  }

  // -- handle registry -------------------------------------------------------

  get(id: string): AssetImageMeta | null {
    const image = this.images.get(id);
    return image ? this.toMeta(image) : null;
  }

  list(): AssetImageMeta[] {
    return [...this.images.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(image => this.toMeta(image));
  }

  /**
   * Deterministic transparency stats for a handle (see {@link imageAlphaStats}). Use this instead of
   * asking a vision model whether a background is transparent — vision flattens alpha onto white.
   */
  async alphaStats(id: string): Promise<AlphaStats> {
    return imageAlphaStats(this.require(id).blob);
  }

  /** A `data:` URL preview (downscaled to `maxSize` on the longest edge) for visual QC. */
  async preview(id: string, maxSize = 256): Promise<string> {
    const image = this.require(id);
    const result = await resizeImageBlob(image.blob, {
      maxSize,
      mimeType: image.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    });
    return blobToDataUrl(result.blob);
  }

  discard(id: string): boolean {
    return this.images.delete(id);
  }

  clear(): void {
    this.images.clear();
  }

  dispose(): void {
    this.images.clear();
  }

  // -- internals -------------------------------------------------------------

  private require(id: string): AssetImage {
    const image = this.images.get(id);
    if (!image) {
      throw new Error(`No image handle: ${id}. Generate or open one first, then reuse its id.`);
    }
    return image;
  }

  private async store(
    blob: Blob,
    mimeType: string,
    source: AssetImageSource,
    prompt?: string
  ): Promise<AssetImage> {
    const size = (await readBlobSize(blob)) ?? { width: 0, height: 0 };
    const image: AssetImage = {
      id: this.newId(),
      blob,
      mimeType: mimeType || blob.type || 'image/png',
      width: size.width,
      height: size.height,
      source,
      prompt,
      createdAt: Date.now(),
    };
    this.images.set(image.id, image);
    return image;
  }

  private toMeta(image: AssetImage): AssetImageMeta {
    return {
      id: image.id,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      bytes: image.blob.size,
      source: image.source,
      prompt: image.prompt,
      createdAt: image.createdAt,
    };
  }

  private async buildReferences(
    refs: ReadonlyArray<string | AssetGenReference>,
    max: number
  ): Promise<ReferenceImage[]> {
    const limited = refs.slice(0, Math.max(0, max));
    const out: ReferenceImage[] = [];
    for (const ref of limited) {
      const descriptor: AssetGenReference = typeof ref === 'string' ? { path: ref } : ref;
      if (descriptor.data) {
        out.push({ data: descriptor.data, mimeType: descriptor.mimeType ?? 'image/png' });
        continue;
      }
      if (descriptor.path) {
        const blob = await this.storage.readBlob(descriptor.path);
        out.push({ data: await blobToBase64(blob), mimeType: blob.type || 'image/png' });
      }
    }
    return out;
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

  private newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `img-${crypto.randomUUID()}`;
    }
    return `img-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}
