/**
 * Read-only library provider for the built-in starter pack shipped with the editor.
 *
 * Reads `public/library/index.json` (a manifest of bundled items) and fetches each item's
 * files from the editor static tree. No IndexedDB/OPFS — everything is served over HTTP,
 * so the pack is available even without a project open (and, later, proxied by the collab
 * server for headless agents).
 */

import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
  LibraryProvider,
} from './library-types';
import { normalizeBundlePath } from './library-path-remap';

/** One entry in `public/library/index.json`. `dir` is the item folder under `library/`. */
export interface BuiltinLibraryIndexEntry {
  readonly dir: string;
  readonly manifest: LibraryItemManifest;
}

export interface BuiltinLibraryIndex {
  readonly items: readonly BuiltinLibraryIndexEntry[];
}

export class BuiltinLibraryProvider implements LibraryProvider {
  readonly scope = 'builtin' as const;

  private indexPromise: Promise<BuiltinLibraryIndex | null> | null = null;

  isSupported(): boolean {
    return typeof fetch !== 'undefined';
  }

  async list(): Promise<LibraryItem[]> {
    const index = await this.loadIndex();
    if (!index) {
      return [];
    }
    return index.items.map(entry => ({ scope: this.scope, manifest: entry.manifest }));
  }

  async getBundle(id: string): Promise<LibraryBundle | null> {
    const index = await this.loadIndex();
    const entry = index?.items.find(candidate => candidate.manifest.id === id);
    if (!entry) {
      return null;
    }
    const files = new Map<string, Blob>();
    for (const relativePath of entry.manifest.files) {
      const normalized = normalizeBundlePath(relativePath);
      const url = this.publicUrl(`${entry.dir}/${normalized}`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch builtin library file ${url}: ${response.status}`);
      }
      files.set(normalized, await response.blob());
    }
    return { manifest: entry.manifest, files };
  }

  async getPreviewUrl(id: string): Promise<string | null> {
    const index = await this.loadIndex();
    const entry = index?.items.find(candidate => candidate.manifest.id === id);
    if (!entry?.manifest.preview) {
      return null;
    }
    return this.publicUrl(`${entry.dir}/${normalizeBundlePath(entry.manifest.preview)}`);
  }

  private loadIndex(): Promise<BuiltinLibraryIndex | null> {
    if (!this.indexPromise) {
      this.indexPromise = this.fetchIndex().catch(() => null);
    }
    return this.indexPromise;
  }

  private async fetchIndex(): Promise<BuiltinLibraryIndex | null> {
    const response = await fetch(this.publicUrl('index.json'));
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as BuiltinLibraryIndex;
    if (!data || !Array.isArray(data.items)) {
      return null;
    }
    return data;
  }

  private publicUrl(relativePath: string): string {
    const envBase = import.meta.env.BASE_URL ?? '/';
    const base = envBase.replace(/\/*$/, '/');
    const trimmed = relativePath.replace(/^\/+/, '');
    return `${base}library/${trimmed}`;
  }
}
