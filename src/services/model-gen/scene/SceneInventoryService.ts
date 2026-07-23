import { inject, injectable } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { FileDescriptor } from '@/services/project/FileSystemAPIService';
import { categorizeAssetPath } from '@/core/asset-categories';
import { normalizeResPath } from '@/services/model-gen/scene/scene-validate';
import type { InventoryItem, InventorySummary } from '@/services/model-gen/scene/scene-gen-types';

/** Directories that never hold usable assets — never descended into. */
const SKIP_DIRECTORIES = new Set<string>(['.git', 'node_modules', '.plans', '.pix3']);

/** Guard against pathological project trees / symlink loops. */
const MAX_DEPTH = 24;

/**
 * Deterministic (zero-token) catalog pass over the project that enumerates the building blocks the
 * Scene lane can assemble into a level (the "palette" the model lane doesn't have): GLB/GLTF models,
 * `.pix3scene` prefab candidates, and textures. Dependency-light — a recursive
 * {@link ProjectStorageService.listDirectory} walk classified through
 * {@link import('@/core/asset-categories').categorizeAssetPath}. Vision captions are out of scope for
 * the MVP (a follow-up fills {@link InventoryItem.caption}).
 */
@injectable()
export class SceneInventoryService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  /** Recursively scan the project and return the usable-asset palette plus per-category counts. */
  async scan(): Promise<InventorySummary> {
    const items: InventoryItem[] = [];
    const usedIds = new Set<string>();
    await this.walk('.', 0, items, usedIds);

    const counts = { model: 0, prefab: 0, texture: 0 };
    for (const item of items) {
      counts[item.category] += 1;
    }
    // Stable ordering so repeated scans (and their prompts) are deterministic.
    items.sort((a, b) => a.path.localeCompare(b.path));
    return { items, counts };
  }

  /** The set of normalized asset paths (the {@link normalizeResPath} form) — for the validate gate. */
  knownAssetPaths(summary: InventorySummary): Set<string> {
    return new Set(summary.items.map(item => normalizeResPath(item.path)));
  }

  // -- internals -------------------------------------------------------------

  private async walk(
    directory: string,
    depth: number,
    items: InventoryItem[],
    usedIds: Set<string>
  ): Promise<void> {
    if (depth > MAX_DEPTH) {
      return;
    }

    let entries: FileDescriptor[];
    try {
      entries = await this.storage.listDirectory(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.kind === 'directory') {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await this.walk(entry.path, depth + 1, items, usedIds);
        continue;
      }

      const category = classifyItem(entry.path);
      if (!category) {
        continue;
      }
      const normalized = normalizeResPath(entry.path);
      items.push({
        id: uniqueSlug(normalized, usedIds),
        path: `res://${normalized}`,
        category,
        bytes: typeof entry.size === 'number' && entry.size >= 0 ? entry.size : 0,
      });
    }
  }
}

/** Map an asset path to a Scene-lane palette category, or null when it isn't usable fodder. */
function classifyItem(path: string): InventoryItem['category'] | null {
  switch (categorizeAssetPath(path)) {
    case 'models':
      return 'model';
    case 'images':
      return 'texture';
    // MVP: treat every `.pix3scene` (level or prefab) as a prefab candidate.
    case 'scenes':
      return 'prefab';
    default:
      return null;
  }
}

/** A filesystem-path → stable, LLM-friendly slug, disambiguated against `used` on collision. */
function uniqueSlug(normalizedPath: string, used: Set<string>): string {
  const base =
    normalizedPath
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'asset';
  let slug = base;
  let counter = 1;
  while (used.has(slug)) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  used.add(slug);
  return slug;
}
