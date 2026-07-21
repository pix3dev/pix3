import { analyzeAudioBlob } from '@/services/audio-preview-utils';
import type { InspectorPanel } from './inspector-panel';

interface TextureResourceValue {
  type: 'texture';
  url: string;
}

interface AudioPreviewState {
  readonly previewUrl: string;
  readonly waveformUrl: string;
  readonly durationSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRate: number | null;
  readonly size: number;
}

interface TextAssetPreviewState {
  readonly content: string;
  readonly lineCount: number | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

const ASSET_RESOURCE_MIME = 'application/x-pix3-asset-resource';
const ASSET_PATH_MIME = 'application/x-pix3-asset-path';
const IMAGE_EXTENSIONS = new Set([
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
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg']);
const MODEL_EXTENSIONS = new Set(['glb', 'gltf']);
const ANIMATION_EXTENSIONS = new Set(['pix3anim']);

/**
 * Owns the inspector's resource-preview caches (texture / audio / text asset)
 * and the drag-drop resource resolution helpers. The panel keeps the
 * command-dispatching drop handlers and delegates the pure resolution/preview
 * work here.
 */
export class InspectorResourcePreview {
  private readonly texturePreviewUrls = new Map<string, string>();
  private readonly texturePreviewMetadata = new Map<
    string,
    { width: number; height: number; size: number }
  >();
  private readonly texturePreviewLoads = new Set<string>();
  private readonly audioPreviewUrls = new Map<string, string>();
  private readonly audioPreviewMetadata = new Map<
    string,
    {
      waveformUrl: string;
      durationSeconds: number | null;
      channelCount: number | null;
      sampleRate: number | null;
      size: number;
    }
  >();
  private readonly audioPreviewLoads = new Set<string>();
  private readonly textAssetPreviewContent = new Map<
    string,
    { content: string; lineCount: number; isTruncated: boolean }
  >();
  private readonly textAssetPreviewLoads = new Set<string>();
  private readonly textAssetPreviewErrors = new Map<string, string>();

  constructor(private readonly host: InspectorPanel) {}

  dispose(): void {
    for (const previewUrl of this.texturePreviewUrls.values()) {
      URL.revokeObjectURL(previewUrl);
    }
    this.texturePreviewUrls.clear();
    this.texturePreviewMetadata.clear();
    this.texturePreviewLoads.clear();
    for (const previewUrl of this.audioPreviewUrls.values()) {
      URL.revokeObjectURL(previewUrl);
    }
    this.audioPreviewUrls.clear();
    this.audioPreviewMetadata.clear();
    this.audioPreviewLoads.clear();
    this.textAssetPreviewContent.clear();
    this.textAssetPreviewLoads.clear();
    this.textAssetPreviewErrors.clear();
  }

  toTextureResourceValue(rawValue: unknown): TextureResourceValue {
    if (typeof rawValue === 'object' && rawValue !== null) {
      const value = rawValue as { type?: unknown; url?: unknown };
      if (value.type === 'texture' && typeof value.url === 'string') {
        return { type: 'texture', url: value.url };
      }
      if (typeof value.url === 'string') {
        return { type: 'texture', url: value.url };
      }
    }

    if (typeof rawValue === 'string') {
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        return this.toTextureResourceValue(parsed);
      } catch {
        return { type: 'texture', url: rawValue };
      }
    }

    return { type: 'texture', url: '' };
  }

  getTexturePreviewUrl(textureUrl: string): string {
    const resourceUrl = textureUrl.trim();
    if (!resourceUrl || !this.isImageResource(resourceUrl)) {
      return '';
    }

    if (resourceUrl.startsWith('http://') || resourceUrl.startsWith('https://')) {
      return resourceUrl;
    }

    const cached = this.texturePreviewUrls.get(resourceUrl);
    if (cached) {
      return cached;
    }

    if (resourceUrl.startsWith('res://') && !this.texturePreviewLoads.has(resourceUrl)) {
      this.texturePreviewLoads.add(resourceUrl);
      void (async () => {
        try {
          const blob = await this.host.fileSystemAPI.readBlob(resourceUrl);
          const objectUrl = URL.createObjectURL(blob);

          // Get image dimensions
          const dimensions = await new Promise<{ width: number; height: number }>(resolve => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve({ width: 0, height: 0 });
            img.src = objectUrl;
          });

          this.texturePreviewUrls.set(resourceUrl, objectUrl);
          this.texturePreviewMetadata.set(resourceUrl, {
            ...dimensions,
            size: blob.size,
          });
          this.host.requestUpdate();
        } catch {
          // Keep empty preview when read fails.
        } finally {
          this.texturePreviewLoads.delete(resourceUrl);
        }
      })();
    }

    return '';
  }

  isImageResource(path: string): boolean {
    return this.hasSupportedExtension(path, IMAGE_EXTENSIONS);
  }

  getTextureMetadata(
    textureUrl: string
  ): { width: number; height: number; size: number } | undefined {
    return this.texturePreviewMetadata.get(textureUrl.trim());
  }

  getTextAssetPreview(assetPath: string, fallbackText: string | null): TextAssetPreviewState {
    const normalizedPath = assetPath.trim();
    if (!normalizedPath) {
      return {
        content: '',
        lineCount: null,
        isLoading: false,
        error: null,
      };
    }

    const cached = this.textAssetPreviewContent.get(normalizedPath);
    if (!cached && !this.textAssetPreviewLoads.has(normalizedPath)) {
      this.textAssetPreviewLoads.add(normalizedPath);
      void (async () => {
        try {
          const rawText = await this.host.projectStorage.readTextFile(normalizedPath);
          const normalizedText = rawText.replace(/\r\n/g, '\n');
          const lineCount = normalizedText.length === 0 ? 0 : normalizedText.split('\n').length;
          const maxLength = 24000;
          const isTruncated = normalizedText.length > maxLength;
          const content = isTruncated
            ? `${normalizedText.slice(0, maxLength)}\n\n... Preview truncated`
            : normalizedText;

          this.textAssetPreviewContent.set(normalizedPath, {
            content: content || 'Empty file',
            lineCount,
            isTruncated,
          });
          this.textAssetPreviewErrors.delete(normalizedPath);
        } catch (error) {
          this.textAssetPreviewErrors.set(
            normalizedPath,
            error instanceof Error ? error.message : 'Failed to load file content.'
          );
        } finally {
          this.textAssetPreviewLoads.delete(normalizedPath);
          this.host.requestUpdate();
        }
      })();
    }

    return {
      content: cached?.content ?? fallbackText ?? '',
      lineCount: cached?.lineCount ?? null,
      isLoading: this.textAssetPreviewLoads.has(normalizedPath),
      error: this.textAssetPreviewErrors.get(normalizedPath) ?? null,
    };
  }

  getAudioPreview(resourceUrl: string): AudioPreviewState {
    const normalizedUrl = resourceUrl.trim();
    if (!normalizedUrl || !this.isAudioResource(normalizedUrl)) {
      return {
        previewUrl: '',
        waveformUrl: '',
        durationSeconds: null,
        channelCount: null,
        sampleRate: null,
        size: 0,
      };
    }

    const previewUrl =
      normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://')
        ? normalizedUrl
        : (this.audioPreviewUrls.get(normalizedUrl) ?? '');
    const metadata = this.audioPreviewMetadata.get(normalizedUrl);

    if (normalizedUrl.startsWith('res://') && !this.audioPreviewLoads.has(normalizedUrl)) {
      const hasLoadedPreview = previewUrl.length > 0 || metadata !== undefined;
      if (!hasLoadedPreview) {
        this.audioPreviewLoads.add(normalizedUrl);
        void (async () => {
          try {
            const blob = await this.host.fileSystemAPI.readBlob(normalizedUrl);
            const objectUrl = URL.createObjectURL(blob);
            const analysis = await analyzeAudioBlob(blob);

            this.audioPreviewUrls.set(normalizedUrl, objectUrl);
            this.audioPreviewMetadata.set(normalizedUrl, {
              waveformUrl: analysis.waveformUrl ?? '',
              durationSeconds: analysis.durationSeconds,
              channelCount: analysis.channelCount,
              sampleRate: analysis.sampleRate,
              size: blob.size,
            });
            this.host.requestUpdate();
          } catch {
            // Keep empty preview when read fails.
          } finally {
            this.audioPreviewLoads.delete(normalizedUrl);
          }
        })();
      }
    }

    return {
      previewUrl,
      waveformUrl: metadata?.waveformUrl ?? '',
      durationSeconds: metadata?.durationSeconds ?? null,
      channelCount: metadata?.channelCount ?? null,
      sampleRate: metadata?.sampleRate ?? null,
      size: metadata?.size ?? 0,
    };
  }

  isAudioResource(path: string): boolean {
    return this.hasSupportedExtension(path, AUDIO_EXTENSIONS);
  }

  isModelResource(path: string): boolean {
    return this.hasSupportedExtension(path, MODEL_EXTENSIONS);
  }

  isAnimationResource(path: string): boolean {
    return this.hasSupportedExtension(path, ANIMATION_EXTENSIONS);
  }

  hasSupportedExtension(path: string, extensions: ReadonlySet<string>): boolean {
    const cleaned = path.split('?')[0].split('#')[0];
    const extension = cleaned.includes('.') ? (cleaned.split('.').pop()?.toLowerCase() ?? '') : '';
    return extensions.has(extension);
  }

  normalizeDroppedResource(
    rawValue: string,
    isSupportedResource: (path: string) => boolean
  ): string | null {
    const value = rawValue.trim();
    if (!value) {
      return null;
    }

    if (value.startsWith('res://') || value.startsWith('http://') || value.startsWith('https://')) {
      return isSupportedResource(value) ? value : null;
    }

    if (value.includes('://')) {
      return null;
    }

    const normalized = value.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\\+/g, '/');
    const resourcePath = `res://${normalized}`;
    return isSupportedResource(resourcePath) ? resourcePath : null;
  }

  getDroppedResource(
    event: DragEvent,
    isSupportedResource: (path: string) => boolean
  ): string | null {
    const transfer = event.dataTransfer;
    if (!transfer) {
      return null;
    }

    const fromResource = transfer.getData(ASSET_RESOURCE_MIME);
    const normalizedResource = this.normalizeDroppedResource(fromResource, isSupportedResource);
    if (normalizedResource) {
      return normalizedResource;
    }

    const fromPath = transfer.getData(ASSET_PATH_MIME);
    const normalizedPath = this.normalizeDroppedResource(fromPath, isSupportedResource);
    if (normalizedPath) {
      return normalizedPath;
    }

    const fromUriList = transfer.getData('text/uri-list');
    const normalizedUriList = this.normalizeDroppedResource(fromUriList, isSupportedResource);
    if (normalizedUriList) {
      return normalizedUriList;
    }

    const plain = transfer.getData('text/plain');
    return this.normalizeDroppedResource(plain, isSupportedResource);
  }

  getDroppedTextureResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isImageResource(path));
  }

  getDroppedAudioResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isAudioResource(path));
  }

  getDroppedModelResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isModelResource(path));
  }

  getDroppedAnimationResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isAnimationResource(path));
  }
}
