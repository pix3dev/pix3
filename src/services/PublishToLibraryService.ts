/**
 * Packs a scene node/subtree into a personal-library bundle ("Publish to Library").
 *
 * `SaveAsPrefabOperation` serializes a subtree verbatim (absolute `res://` paths, no
 * dependency collection), so this service does the collection itself: it serializes the
 * subtree, then walks the text for `res://` references, copies each referenced file into the
 * bundle at its project-relative path, and recurses into nested `.pix3scene`/prefab files.
 * References are left as absolute `res://<project-path>`; on insert `LibraryInsertService`
 * prefixes them with the bundle's target dir, keeping the graph internally consistent.
 */

import { inject, injectable } from '@/fw/di';
import { SceneManager, NodeBase } from '@pix3/runtime';
import { ProjectStorageService } from './ProjectStorageService';
import { AssetLibraryService } from './AssetLibraryService';
import { SceneThumbnailGenerator } from './SceneThumbnailGenerator';
import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
  LibraryItemSource,
  LibraryItemType,
} from './library/library-types';
import { normalizeBundlePath } from './library/library-path-remap';
import { inferItemTypeFromPath } from './library/library-types';
import {
  collectResourceReferences,
  isScriptReference,
  isSceneReference,
  stripResScheme,
} from './library/library-dependencies';

export interface PublishNodeParams {
  readonly nodeId: string;
  /** Display name; defaults to the node's own name. */
  readonly name?: string;
  readonly tags?: readonly string[];
  readonly description?: string;
  /** Item type; defaults to `prefab`. */
  readonly type?: LibraryItemType;
  /** Optional library category id to file the item under. */
  readonly category?: string;
}

/** Bundle-relative filename the packed subtree scene is stored under. */
const ENTRY_FILE = 'prefab.pix3scene';

/** Bundle-relative filename for the rendered thumbnail (library chrome, not copied on insert). */
const PREVIEW_FILE = 'preview.webp';

@injectable()
export class PublishToLibraryService {
  @inject(SceneManager) private readonly sceneManager!: SceneManager;
  @inject(ProjectStorageService) private readonly storage!: ProjectStorageService;
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;
  @inject(SceneThumbnailGenerator) private readonly thumbnails!: SceneThumbnailGenerator;

  /** Build a bundle from a node without persisting it (used by tests and the publish flow). */
  async buildBundle(params: PublishNodeParams): Promise<LibraryBundle | null> {
    const sceneGraph = this.sceneManager.getActiveSceneGraph?.() ?? null;
    const sourceNode = sceneGraph?.nodeMap.get(params.nodeId);
    if (!sceneGraph || !(sourceNode instanceof NodeBase)) {
      return null;
    }

    const subtreeMap = new Map<string, NodeBase>();
    this.collectSubtree(sourceNode, subtreeMap);
    const entryText = this.sceneManager.serializeScene({
      version: sceneGraph.version ?? '1.0.0',
      rootNodes: [sourceNode],
      nodeMap: subtreeMap,
      metadata: {},
    });

    const files = new Map<string, Blob>();
    files.set(ENTRY_FILE, new Blob([entryText], { type: 'text/yaml' }));
    await this.collectDependencies(entryText, files, new Set<string>());
    const preview = await this.renderScenePreview(entryText, ENTRY_FILE, files);

    const name = params.name ?? sourceNode.name ?? 'Prefab';
    const slug = await this.library.suggestSlug(name);
    const manifest: LibraryItemManifest = {
      id: this.newId(),
      slug,
      name,
      type: params.type ?? 'prefab',
      tags: [...(params.tags ?? [])],
      category: params.category,
      description: params.description,
      preview,
      entry: ENTRY_FILE,
      files: [...files.keys()],
      source: 'packed',
      createdAt: 0,
      updatedAt: 0,
    };
    return { manifest, files };
  }

  /** Build the bundle and persist it into the personal library. */
  async publishNode(params: PublishNodeParams): Promise<LibraryItem | null> {
    const bundle = await this.buildBundle(params);
    if (!bundle) {
      return null;
    }
    return this.library.putUserItem(bundle);
  }

  /**
   * Pack a project asset file (dragged from the Asset Browser) into a personal-library item.
   *
   * A prefab/scene file is not a lone file: it references sprites, nested prefabs and scripts.
   * So when the dropped file is a `.pix3scene`/prefab, we collect those dependencies into the
   * bundle (mirroring the project layout) and render a thumbnail — "that's the whole point of a
   * prefab". Everything else (image/font/audio/…) packs as a degenerate one-file bundle; images
   * preview as themselves.
   */
  async publishAssetPath(
    resourcePath: string,
    opts?: { category?: string; tags?: readonly string[] }
  ): Promise<LibraryItem | null> {
    const relativePath = normalizeBundlePath(stripResScheme(resourcePath));
    if (!relativePath) {
      return null;
    }

    let blob: Blob;
    try {
      blob = await this.storage.readBlob(relativePath);
    } catch {
      return null;
    }

    const fileName = relativePath.split('/').pop() ?? relativePath;
    const type = inferItemTypeFromPath(relativePath);
    const name = this.deriveName(fileName);
    const slug = await this.library.suggestSlug(name);

    const files = new Map<string, Blob>();
    let entry: string;
    let preview: string | undefined;
    let source: LibraryItemSource = 'imported';

    if (isSceneReference(relativePath)) {
      // Keep the entry at its project-relative path so its own `res://` references stay valid,
      // then walk them to pull every referenced asset into the bundle.
      entry = relativePath;
      files.set(relativePath, blob);
      const text = await blob.text();
      await this.collectDependencies(text, files, new Set<string>([relativePath]));
      preview = await this.renderScenePreview(text, relativePath, files);
      source = 'packed';
    } else {
      entry = fileName;
      files.set(fileName, blob);
      if (type === 'image') {
        preview = fileName;
      }
    }

    const manifest: LibraryItemManifest = {
      id: this.newId(),
      slug,
      name,
      type,
      tags: [...(opts?.tags ?? [])],
      category: opts?.category,
      preview,
      entry,
      files: [...files.keys()],
      source,
      createdAt: 0,
      updatedAt: 0,
    };
    return this.library.putUserItem({ manifest, files });
  }

  /**
   * Render a webp thumbnail from serialized scene/prefab text and add it to `files` as
   * {@link PREVIEW_FILE}. Best-effort: on any failure (no WebGL context, parse error) the item
   * simply falls back to the type-icon placeholder. `filePath` seeds relative-path resolution;
   * the bundled `res://` references are absolute so it only matters as a nominal base.
   */
  private async renderScenePreview(
    entryText: string,
    filePath: string,
    files: Map<string, Blob>
  ): Promise<string | undefined> {
    try {
      const dataUrl = await this.thumbnails.generate(
        new Blob([entryText], { type: 'text/yaml' }),
        filePath
      );
      const blob = await (await fetch(dataUrl)).blob();
      files.set(PREVIEW_FILE, blob);
      return PREVIEW_FILE;
    } catch (error) {
      console.warn('[PublishToLibraryService] Preview render failed; using placeholder.', error);
      return undefined;
    }
  }

  private deriveName(fileName: string): string {
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  }

  // -- internals -------------------------------------------------------------

  private collectSubtree(node: NodeBase, out: Map<string, NodeBase>): void {
    out.set(node.nodeId, node);
    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.collectSubtree(child, out);
      }
    }
  }

  /**
   * Copy every `res://` file referenced by `text` into `files` (keyed by project-relative
   * path), recursing into nested scene/prefab files. `visited` guards reference cycles.
   */
  private async collectDependencies(
    text: string,
    files: Map<string, Blob>,
    visited: Set<string>
  ): Promise<void> {
    for (const reference of collectResourceReferences(text)) {
      const relativePath = normalizeBundlePath(stripResScheme(reference));
      if (!relativePath || visited.has(relativePath) || files.has(relativePath)) {
        continue;
      }
      visited.add(relativePath);

      let blob: Blob;
      try {
        blob = await this.storage.readBlob(relativePath);
      } catch {
        // Missing file (e.g. a builtin/public asset not in the project) — skip it.
        continue;
      }
      files.set(relativePath, blob);

      if (isSceneReference(reference) || isScriptReference(reference)) {
        const nestedText = await blob.text();
        await this.collectDependencies(nestedText, files, visited);
      }
    }
  }

  private newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `lib-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}
