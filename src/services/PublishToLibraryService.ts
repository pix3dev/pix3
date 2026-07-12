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
import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
  LibraryItemType,
} from './library/library-types';
import { normalizeBundlePath } from './library/library-path-remap';
import {
  collectResourceReferences,
  isScriptReference,
  isSceneReference,
  stripResScheme,
} from './library/library-dependencies';

export interface PublishNodeParams {
  readonly nodeId: string;
  readonly name: string;
  readonly tags?: readonly string[];
  readonly description?: string;
  /** Item type; defaults to `prefab`. */
  readonly type?: LibraryItemType;
}

/** Bundle-relative filename the packed subtree scene is stored under. */
const ENTRY_FILE = 'prefab.pix3scene';

@injectable()
export class PublishToLibraryService {
  @inject(SceneManager) private readonly sceneManager!: SceneManager;
  @inject(ProjectStorageService) private readonly storage!: ProjectStorageService;
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;

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

    const slug = await this.library.suggestSlug(params.name);
    const manifest: LibraryItemManifest = {
      id: this.newId(),
      slug,
      name: params.name,
      type: params.type ?? 'prefab',
      tags: [...(params.tags ?? [])],
      description: params.description,
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
