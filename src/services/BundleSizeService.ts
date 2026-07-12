import { injectable, inject } from '@/fw/di';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import type { FileDescriptor } from '@/services/FileSystemAPIService';

export type BundleSizeCategory =
  | 'images'
  | 'audio'
  | 'models'
  | 'scenes'
  | 'scripts'
  | 'data'
  | 'fonts'
  | 'other';

export interface BundleSizeBucket {
  bytes: number;
  count: number;
}

export interface BundleSizeReport {
  totalBytes: number;
  fileCount: number;
  byCategory: Record<BundleSizeCategory, BundleSizeBucket>;
}

/** Directories that never ship with a built game and are skipped during the walk. */
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.yalc',
  '.vscode',
  '.idea',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
]);

const CATEGORY_BY_EXTENSION: Record<string, BundleSizeCategory> = {
  png: 'images',
  jpg: 'images',
  jpeg: 'images',
  webp: 'images',
  gif: 'images',
  bmp: 'images',
  svg: 'images',
  ktx2: 'images',
  basis: 'images',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  glb: 'models',
  gltf: 'models',
  bin: 'models',
  fbx: 'models',
  obj: 'models',
  pix3scene: 'scenes',
  ts: 'scripts',
  js: 'scripts',
  mjs: 'scripts',
  json: 'data',
  yaml: 'data',
  yml: 'data',
  pix3anim: 'data',
  txt: 'data',
  csv: 'data',
  ttf: 'fonts',
  otf: 'fonts',
  woff: 'fonts',
  woff2: 'fonts',
};

const createEmptyBuckets = (): Record<BundleSizeCategory, BundleSizeBucket> => ({
  images: { bytes: 0, count: 0 },
  audio: { bytes: 0, count: 0 },
  models: { bytes: 0, count: 0 },
  scenes: { bytes: 0, count: 0 },
  scripts: { bytes: 0, count: 0 },
  data: { bytes: 0, count: 0 },
  fonts: { bytes: 0, count: 0 },
  other: { bytes: 0, count: 0 },
});

const categorize = (name: string): BundleSizeCategory => {
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return 'other';
  }
  return CATEGORY_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'other';
};

/**
 * Estimates the on-disk footprint of the current project's shippable content by
 * walking the project tree and summing file sizes (grouped by asset category).
 * Build-only and tooling directories are skipped. This is the in-editor "bundle
 * size" surfaced in the status bar — recomputed on demand.
 */
@injectable()
export class BundleSizeService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  async computeProjectSize(): Promise<BundleSizeReport> {
    const report: BundleSizeReport = {
      totalBytes: 0,
      fileCount: 0,
      byCategory: createEmptyBuckets(),
    };

    await this.walk('.', report);
    return report;
  }

  private async walk(path: string, report: BundleSizeReport): Promise<void> {
    let entries: FileDescriptor[];
    try {
      entries = await this.storage.listDirectory(path);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.kind === 'directory') {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        await this.walk(entry.path, report);
        continue;
      }

      if (entry.name.endsWith('.map')) {
        continue;
      }

      const bytes = typeof entry.size === 'number' ? entry.size : 0;
      const category = categorize(entry.name);
      report.totalBytes += bytes;
      report.fileCount += 1;
      report.byCategory[category].bytes += bytes;
      report.byCategory[category].count += 1;
    }
  }
}

/** Format a byte count as a short human-readable string (e.g. "12.4 MB"). */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
