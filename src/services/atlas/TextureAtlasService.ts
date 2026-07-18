import { CanvasTexture } from 'three';
import { parse as parseYaml } from 'yaml';
import { injectable, inject } from '@/fw/di';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import { AtlasCacheStore } from '@/services/atlas/AtlasCacheStore';
import { packMaxRects, type PackItem } from '@/services/atlas/MaxRectsPacker';
import { sha256Hex } from '@/core/remote-preview/protocol';
import {
  ATLAS_SHEET_SCHEME,
  configure2DTexture,
  createAtlasResolver,
  getProjectTextureFiltering,
  type AtlasManifest,
  type AssetLoader,
} from '@pix3/runtime';

/** Bump to invalidate every cached atlas when the packing algorithm changes. */
const PACKER_VERSION = 1;
const DEFAULT_MAX_SHEET_SIZE = 2048;
const DEFAULT_PADDING = 2;
/** A frame wider/taller than this, or covering >25% of a sheet, stays standalone. */
const MAX_FRAME_SIZE = 1024;

const IMAGE_REF_PATTERN = /res:\/\/[^\s"'`)\]]+\.(?:png|jpe?g|webp)/gi;
const ANIM_REF_PATTERN = /res:\/\/[^\s"'`)\]]+\.pix3anim/gi;
const SCENE_EXTENSIONS = ['.pix3scene', '.pix3prefab'] as const;
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;

/** Node types whose textures are safe to atlas (full-[0,1] UV sprites). */
const ATLAS_ELIGIBLE_TYPES = new Set(['Sprite2D', 'Button2D', 'AnimatedSprite2D', 'Bar2D']);

export interface AtlasPrepResult {
  status: 'off' | 'empty' | 'hit' | 'miss' | 'error';
  sheets?: number;
  frames?: number;
  excluded?: number;
}

export interface ExportedAtlas {
  manifest: AtlasManifest;
  /** PNG blobs index-aligned with `manifest.sheets` (file names in the manifest). */
  sheets: Blob[];
}

interface ClassifiedInputs {
  /** res:// image paths safe to atlas, sorted, minus anything an ineligible node touches. */
  include: string[];
  /** res:// paths deliberately excluded (touched by tiled/3D/other nodes). */
  excluded: string[];
  /** Project-relative path → byte size (from a single directory sweep). */
  sizeMap: Map<string, number | null>;
}

interface DecodedFrame {
  resourcePath: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

interface PackOutput {
  manifest: AtlasManifest;
  canvases: OffscreenCanvas[];
}

/**
 * Editor-side pre-launch texture atlas packer (Phase 2). Scans the project's
 * scenes/prefabs/scripts, classifies which textures are atlas-eligible, packs
 * them into a few sheets with a content-addressed IndexedDB cache, and installs
 * a resolver on the play-mode {@link AssetLoader} so every consumer transparently
 * receives a view onto a shared sheet. The runtime never packs — this keeps
 * `@pix3/runtime` editor-agnostic and publishable.
 */
@injectable()
export class TextureAtlasService {
  @inject(ProjectStorageService)
  private readonly fs!: ProjectStorageService;

  @inject(AtlasCacheStore)
  private readonly cache!: AtlasCacheStore;

  /**
   * Prepare and install the atlas on `assetLoader` before `startScene`. Idempotent
   * per texture-set (content-hash cached). Any failure falls back to un-atlased
   * loading (resolver cleared) so play mode always starts.
   */
  async prepareForPlay(assetLoader: AssetLoader): Promise<AtlasPrepResult> {
    try {
      const inputs = await this.scanAndClassify();
      if (inputs.include.length === 0) {
        assetLoader.setAtlasResolver(null);
        return { status: 'empty' };
      }

      const filtering = getProjectTextureFiltering();
      const hash = await this.hashFast(inputs, filtering);

      const cached = await this.cache.get(hash);
      if (cached) {
        await this.installFromBlobs(assetLoader, cached.manifest, cached.sheets, hash);
        console.info(
          `[Atlas] cache=hit — ${cached.manifest.sheets.length} sheets, ${Object.keys(cached.manifest.frames).length} frames`
        );
        return this.resultFor('hit', cached.manifest);
      }

      const started = performance.now();
      const packed = await this.pack(inputs.include, inputs.excluded, hash, filtering);
      if (packed.manifest.sheets.length === 0) {
        assetLoader.setAtlasResolver(null);
        return { status: 'empty' };
      }

      const blobs = await Promise.all(
        packed.canvases.map(canvas => canvas.convertToBlob({ type: 'image/png' }))
      );
      await this.cache.set(hash, { manifest: packed.manifest, sheets: blobs });
      this.installFromCanvases(assetLoader, packed.manifest, packed.canvases, hash);
      console.info(
        `[Atlas] packed ${Object.keys(packed.manifest.frames).length} textures → ${packed.manifest.sheets.length} sheets in ${Math.round(performance.now() - started)}ms (cache=miss)`
      );
      return this.resultFor('miss', packed.manifest);
    } catch (error) {
      console.warn('[Atlas] preparation failed; falling back to un-atlased loading', error);
      assetLoader.setAtlasResolver(null);
      return { status: 'error' };
    }
  }

  /**
   * Pack the project for export (strict byte hash, no cache). Returns the manifest
   * plus PNG blobs for {@link ProjectBuildService} to emit under `assets/.atlas/`.
   * Returns null when nothing is eligible.
   */
  async packForExport(): Promise<ExportedAtlas | null> {
    const inputs = await this.scanAndClassify();
    if (inputs.include.length === 0) {
      return null;
    }
    const filtering = getProjectTextureFiltering();
    const hash = await this.hashStrict(inputs.include, filtering);
    const packed = await this.pack(inputs.include, inputs.excluded, hash, filtering);
    if (packed.manifest.sheets.length === 0) {
      return null;
    }
    const sheets = await Promise.all(
      packed.canvases.map(canvas => canvas.convertToBlob({ type: 'image/png' }))
    );
    return { manifest: packed.manifest, sheets };
  }

  private resultFor(status: 'hit' | 'miss', manifest: AtlasManifest): AtlasPrepResult {
    return {
      status,
      sheets: manifest.sheets.length,
      frames: Object.keys(manifest.frames).length,
      excluded: manifest.excluded.length,
    };
  }

  // --- Scanning & classification -------------------------------------------

  private async scanAndClassify(): Promise<ClassifiedInputs> {
    const sizeMap = await this.collectAllFiles();
    const eligible = new Set<string>();
    const ineligible = new Set<string>();
    const animPaths = new Set<string>();

    for (const [path] of sizeMap) {
      if (SCENE_EXTENSIONS.some(ext => path.endsWith(ext))) {
        try {
          const parsed = parseYaml(await this.fs.readTextFile(path)) as { root?: unknown };
          this.classifyNodes(parsed?.root, eligible, ineligible, animPaths);
        } catch {
          // Skip unparseable scenes/prefabs.
        }
      }
    }

    // Animation resources: their frame textures belong to AnimatedSprite2D → eligible.
    for (const animPath of animPaths) {
      try {
        const text = await this.fs.readTextFile(stripRes(animPath));
        for (const ref of matchAll(text, IMAGE_REF_PATTERN)) {
          eligible.add(ref);
        }
      } catch {
        // Missing animation resource — its sprite falls back to un-atlased.
      }
    }

    // Project scripts: res:// image refs are treated as sprite textures → eligible.
    for (const [path] of sizeMap) {
      if (!path.endsWith('.ts') || path.endsWith('.spec.ts') || path.endsWith('.d.ts')) {
        continue;
      }
      if (!SCRIPT_DIRECTORIES.some(dir => path === dir || path.startsWith(`${dir}/`))) {
        continue;
      }
      try {
        const text = await this.fs.readTextFile(path);
        for (const ref of matchAll(text, IMAGE_REF_PATTERN)) {
          eligible.add(ref);
        }
      } catch {
        // Ignore unreadable scripts.
      }
    }

    const include: string[] = [];
    const excluded: string[] = [];
    for (const path of [...eligible].sort((a, b) => a.localeCompare(b))) {
      if (ineligible.has(path)) {
        excluded.push(path);
      } else {
        include.push(path);
      }
    }
    return { include, excluded, sizeMap };
  }

  private classifyNodes(
    nodes: unknown,
    eligible: Set<string>,
    ineligible: Set<string>,
    animPaths: Set<string>
  ): void {
    if (!Array.isArray(nodes)) {
      return;
    }
    for (const node of nodes) {
      if (!node || typeof node !== 'object') {
        continue;
      }
      const record = node as {
        type?: unknown;
        properties?: unknown;
        children?: unknown;
      };
      const type = typeof record.type === 'string' ? record.type : '';
      const propsText = record.properties ? JSON.stringify(record.properties) : '';
      const bucket = ATLAS_ELIGIBLE_TYPES.has(type) ? eligible : ineligible;
      for (const ref of matchAll(propsText, IMAGE_REF_PATTERN)) {
        bucket.add(ref);
      }
      for (const anim of matchAll(propsText, ANIM_REF_PATTERN)) {
        animPaths.add(anim);
      }
      this.classifyNodes(record.children, eligible, ineligible, animPaths);
    }
  }

  private async collectAllFiles(
    directory = '.',
    out = new Map<string, number | null>()
  ): Promise<Map<string, number | null>> {
    let entries: ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string; size?: number | null }>;
    try {
      entries = await this.fs.listDirectory(directory);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.kind === 'file') {
        out.set(entry.path, entry.size ?? null);
      } else if (entry.kind === 'directory') {
        await this.collectAllFiles(entry.path, out);
      }
    }
    return out;
  }

  // --- Hashing --------------------------------------------------------------

  private async hashFast(inputs: ClassifiedInputs, filtering: string): Promise<string> {
    const files = inputs.include.map(path => `${path}|${inputs.sizeMap.get(stripRes(path)) ?? '?'}`);
    return this.hashPayload(files, filtering);
  }

  private async hashStrict(include: string[], filtering: string): Promise<string> {
    const files: string[] = [];
    for (const path of include) {
      try {
        const buffer = await (await this.fs.readBlob(stripRes(path))).arrayBuffer();
        files.push(`${path}|${await sha256Hex(buffer)}`);
      } catch {
        files.push(`${path}|missing`);
      }
    }
    return this.hashPayload(files, filtering);
  }

  private async hashPayload(files: string[], filtering: string): Promise<string> {
    const payload = JSON.stringify({
      v: PACKER_VERSION,
      maxSheetSize: DEFAULT_MAX_SHEET_SIZE,
      padding: DEFAULT_PADDING,
      filtering,
      files,
    });
    return sha256Hex(new TextEncoder().encode(payload));
  }

  // --- Packing & compositing ------------------------------------------------

  private async pack(
    include: string[],
    preExcluded: string[],
    hash: string,
    filtering: string
  ): Promise<PackOutput> {
    const decoded: DecodedFrame[] = [];
    const excluded = [...preExcluded];

    for (const resourcePath of include) {
      try {
        const blob = await this.fs.readBlob(stripRes(resourcePath));
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        const tooLarge =
          width > MAX_FRAME_SIZE ||
          height > MAX_FRAME_SIZE ||
          width * height > 0.25 * DEFAULT_MAX_SHEET_SIZE * DEFAULT_MAX_SHEET_SIZE;
        if (tooLarge) {
          bitmap.close?.();
          excluded.push(resourcePath);
          continue;
        }
        decoded.push({ resourcePath, bitmap, width, height });
      } catch {
        excluded.push(resourcePath);
      }
    }

    const items: PackItem[] = decoded.map(frame => ({
      id: frame.resourcePath,
      width: frame.width,
      height: frame.height,
    }));
    const { sheets, overflow } = packMaxRects(items, {
      maxSheetSize: DEFAULT_MAX_SHEET_SIZE,
      padding: DEFAULT_PADDING,
    });
    excluded.push(...overflow);

    const byId = new Map(decoded.map(frame => [frame.resourcePath, frame]));
    const canvases: OffscreenCanvas[] = [];
    const manifestSheets: AtlasManifest['sheets'] = [];
    const frames: AtlasManifest['frames'] = {};

    sheets.forEach((sheet, index) => {
      const sheetId = `sheet-${index}`;
      const canvas = new OffscreenCanvas(sheet.width, sheet.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      for (const placement of sheet.placements) {
        const frame = byId.get(placement.id);
        if (!frame) {
          continue;
        }
        ctx.drawImage(frame.bitmap, placement.x, placement.y);
        extrudeEdges(ctx, frame.bitmap, placement.x, placement.y, sheet.width, sheet.height);
        frames[placement.id] = {
          sheet: sheetId,
          x: placement.x,
          y: placement.y,
          w: frame.width,
          h: frame.height,
        };
      }
      canvases.push(canvas);
      manifestSheets.push({
        id: sheetId,
        file: `${sheetId}.png`,
        width: sheet.width,
        height: sheet.height,
      });
    });

    for (const frame of decoded) {
      frame.bitmap.close?.();
    }

    const manifest: AtlasManifest = {
      formatVersion: 1,
      packerVersion: PACKER_VERSION,
      contentHash: hash,
      textureFiltering: filtering === 'nearest' ? 'nearest' : 'linear',
      sheets: manifestSheets,
      frames,
      excluded: excluded.sort((a, b) => a.localeCompare(b)),
    };
    return { manifest, canvases };
  }

  // --- Installation ---------------------------------------------------------

  private installFromCanvases(
    assetLoader: AssetLoader,
    manifest: AtlasManifest,
    canvases: OffscreenCanvas[],
    hash: string
  ): void {
    manifest.sheets.forEach((sheet, index) => {
      const canvas = canvases[index];
      if (!canvas) {
        return;
      }
      const texture = new CanvasTexture(canvas);
      configure2DTexture(texture);
      assetLoader.seedTexture(sheetKey(hash, sheet.id), texture);
    });
    this.installResolver(assetLoader, manifest, hash);
  }

  private async installFromBlobs(
    assetLoader: AssetLoader,
    manifest: AtlasManifest,
    blobs: Blob[],
    hash: string
  ): Promise<void> {
    for (let index = 0; index < manifest.sheets.length; index++) {
      const blob = blobs[index];
      if (!blob) {
        continue;
      }
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const texture = new CanvasTexture(canvas);
      configure2DTexture(texture);
      assetLoader.seedTexture(sheetKey(hash, manifest.sheets[index].id), texture);
    }
    this.installResolver(assetLoader, manifest, hash);
  }

  private installResolver(assetLoader: AssetLoader, manifest: AtlasManifest, hash: string): void {
    assetLoader.setAtlasResolver(createAtlasResolver(manifest, id => sheetKey(hash, id)));
  }

  dispose(): void {
    // No long-lived resources; the cache store manages its own IDB handle.
  }
}

function sheetKey(hash: string, sheetId: string): string {
  return `${ATLAS_SHEET_SCHEME}${hash}/${sheetId}`;
}

function stripRes(path: string): string {
  return path.startsWith('res://') ? path.slice(6) : path;
}

function matchAll(text: string, pattern: RegExp): string[] {
  if (!text) {
    return [];
  }
  return text.match(pattern) ?? [];
}

/**
 * Duplicate a frame's 1px border outward into the surrounding padding gap so
 * linear filtering at a frame edge samples the frame's own color, not a neighbor
 * (or transparent). The UV rect uses the exact frame bounds, so these extruded
 * pixels sit outside the sampled region. Strips that fall off the sheet are
 * skipped.
 */
function extrudeEdges(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  x: number,
  y: number,
  sheetW: number,
  sheetH: number
): void {
  const w = bitmap.width;
  const h = bitmap.height;
  // Left / right columns
  if (x > 0) {
    ctx.drawImage(bitmap, 0, 0, 1, h, x - 1, y, 1, h);
  }
  if (x + w < sheetW) {
    ctx.drawImage(bitmap, w - 1, 0, 1, h, x + w, y, 1, h);
  }
  // Top / bottom rows
  if (y > 0) {
    ctx.drawImage(bitmap, 0, 0, w, 1, x, y - 1, w, 1);
  }
  if (y + h < sheetH) {
    ctx.drawImage(bitmap, 0, h - 1, w, 1, x, y + h, w, 1);
  }
  // Corners
  if (x > 0 && y > 0) {
    ctx.drawImage(bitmap, 0, 0, 1, 1, x - 1, y - 1, 1, 1);
  }
  if (x + w < sheetW && y > 0) {
    ctx.drawImage(bitmap, w - 1, 0, 1, 1, x + w, y - 1, 1, 1);
  }
  if (x > 0 && y + h < sheetH) {
    ctx.drawImage(bitmap, 0, h - 1, 1, 1, x - 1, y + h, 1, 1);
  }
  if (x + w < sheetW && y + h < sheetH) {
    ctx.drawImage(bitmap, w - 1, h - 1, 1, 1, x + w, y + h, 1, 1);
  }
}
