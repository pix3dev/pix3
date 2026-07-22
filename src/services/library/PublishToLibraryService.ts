/**
 * Packs a scene node/subtree into a personal-library bundle ("Publish to Library").
 *
 * `SaveAsPrefabOperation` serializes a subtree verbatim (absolute `res://` paths, no
 * dependency collection), so this service does the collection itself: it serializes the
 * subtree, then walks the text for `res://` references, copies each referenced file into the
 * bundle at its project-relative path, and recurses into nested `.pix3scene`/prefab files.
 * References are left as absolute `res://<project-path>`; on insert `LibraryInsertService`
 * prefixes them with the bundle's target dir, keeping the graph internally consistent.
 *
 * **Script packing (two buckets).** `user:<ClassName>` script components serialize as class-name
 * references, not `res://` paths, so the scan also resolves those names to their project script
 * files (under `scripts/`/`src/scripts/`), bundles them plus their transitive relative imports,
 * and scans the script source for its own `res://` references (e.g. audio played from code).
 * Because a `.ts` file's paths cannot be safely rewritten on insert (unlike scene YAML), scripts
 * and everything reachable from them are tracked as the **original-path bucket** in
 * {@link LibraryItemManifest.originalPathFiles}: on insert they restore to their original project
 * locations verbatim, while the rest stays namespaced under `assets/library/<slug>/`.
 */

import { inject, injectable } from '@/fw/di';
import { SceneManager, NodeBase } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { SceneThumbnailGenerator } from '@/services/scene/SceneThumbnailGenerator';
import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
  LibraryItemSource,
  LibraryItemType,
} from '@/services/library/library-types';
import { normalizeBundlePath } from '@/services/library/library-path-remap';
import { inferItemTypeFromPath } from '@/services/library/library-types';
import {
  collectRelativeImports,
  collectResourceReferences,
  collectUserComponentTypes,
  isScriptReference,
  isSceneReference,
  resolveImportCandidates,
  stripResScheme,
} from '@/services/library/library-dependencies';

/** Project directories scanned for `user:*` script classes (mirrors ProjectScriptLoaderService). */
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
const EXCLUDED_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;
/** `export [default] [abstract] class X extends Script` — the registrable `user:X` marker. */
const SCRIPT_CLASS_PATTERN =
  /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)\s+extends\s+Script\b/g;

/**
 * Working state threaded through the recursive dependency walk. `files` accumulates every bundled
 * blob (keyed by project-relative path); `originalPaths` marks the subset that must restore to
 * original project locations (scripts + anything reachable from script source); `visited` guards
 * `res://` cycles; `scriptIndex` maps `ClassName` → script file path, built lazily once.
 */
interface CollectContext {
  readonly files: Map<string, Blob>;
  readonly originalPaths: Set<string>;
  readonly visited: Set<string>;
  scriptIndex: Map<string, string> | null;
}

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

    const ctx = this.newCollectContext();
    ctx.files.set(ENTRY_FILE, new Blob([entryText], { type: 'text/yaml' }));
    await this.collectDependencies(entryText, ctx, false);
    const preview = await this.renderScenePreview(entryText, ENTRY_FILE, ctx.files);

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
      files: [...ctx.files.keys()],
      originalPathFiles: this.originalPathList(ctx),
      source: 'packed',
      createdAt: 0,
      updatedAt: 0,
    };
    return { manifest, files: ctx.files };
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

    const ctx = this.newCollectContext();
    let entry: string;
    let preview: string | undefined;
    let source: LibraryItemSource = 'imported';

    if (isSceneReference(relativePath)) {
      // Keep the entry at its project-relative path so its own `res://` references stay valid,
      // then walk them to pull every referenced asset into the bundle.
      entry = relativePath;
      ctx.files.set(relativePath, blob);
      ctx.visited.add(this.bucketKey(relativePath, false));
      const text = await blob.text();
      await this.collectDependencies(text, ctx, false);
      preview = await this.renderScenePreview(text, relativePath, ctx.files);
      source = 'packed';
    } else {
      entry = fileName;
      ctx.files.set(fileName, blob);
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
      files: [...ctx.files.keys()],
      originalPathFiles: this.originalPathList(ctx),
      source,
      createdAt: 0,
      updatedAt: 0,
    };
    return this.library.putUserItem({ manifest, files: ctx.files });
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

  private newCollectContext(): CollectContext {
    return {
      files: new Map<string, Blob>(),
      originalPaths: new Set<string>(),
      visited: new Set<string>(),
      scriptIndex: null,
    };
  }

  private originalPathList(ctx: CollectContext): string[] | undefined {
    return ctx.originalPaths.size > 0 ? [...ctx.originalPaths].sort() : undefined;
  }

  /** Per-bucket visited key so a namespaced file can be re-walked when promoted to original. */
  private bucketKey(path: string, original: boolean): string {
    return `${original ? 'O' : 'N'}:${path}`;
  }

  private collectSubtree(node: NodeBase, out: Map<string, NodeBase>): void {
    out.set(node.nodeId, node);
    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.collectSubtree(child, out);
      }
    }
  }

  /**
   * Walk `text` for dependencies and pull them into `ctx.files`:
   *  - `res://` references (textures, audio, nested scenes/scripts) — recursing into scene/script
   *    files, inheriting the referrer's bucket;
   *  - `user:<ClassName>` components — resolved to their project script file and forced into the
   *    original-path bucket (see class header);
   *  - relative imports (only when `fromFile` is itself a script) — the script's `.ts`/`.js`
   *    siblings, also original-path.
   *
   * `inOriginalBucket` is the bucket of `text` itself; `fromFile` is its project path (or null for
   * the synthetic entry). Anything reachable from an original-bucket file is itself original-path,
   * so its own `res://`/import paths stay valid when it is restored verbatim on insert.
   */
  private async collectDependencies(
    text: string,
    ctx: CollectContext,
    inOriginalBucket: boolean,
    fromFile: string | null = null
  ): Promise<void> {
    for (const reference of collectResourceReferences(text)) {
      const relativePath = normalizeBundlePath(stripResScheme(reference));
      if (relativePath) {
        await this.collectResourceFile(relativePath, reference, ctx, inOriginalBucket);
      }
    }

    for (const className of collectUserComponentTypes(text)) {
      await this.collectScriptClass(className, ctx);
    }

    if (fromFile && /\.(ts|js|mjs)$/.test(fromFile)) {
      for (const specifier of collectRelativeImports(text)) {
        await this.collectRelativeImport(fromFile, specifier, ctx);
      }
    }
  }

  /** Add one `res://` file to the bundle in the given bucket and recurse into scene/script text. */
  private async collectResourceFile(
    relativePath: string,
    reference: string,
    ctx: CollectContext,
    inOriginalBucket: boolean
  ): Promise<void> {
    if (inOriginalBucket) {
      ctx.originalPaths.add(relativePath);
    }
    const key = this.bucketKey(relativePath, inOriginalBucket);
    if (ctx.visited.has(key)) {
      return;
    }
    ctx.visited.add(key);

    let blob = ctx.files.get(relativePath);
    if (!blob) {
      try {
        blob = await this.storage.readBlob(relativePath);
      } catch {
        // Missing file (e.g. a builtin/public asset not in the project) — skip it.
        return;
      }
      ctx.files.set(relativePath, blob);
    }

    if (isSceneReference(reference) || isScriptReference(reference)) {
      const nestedText = await blob.text();
      await this.collectDependencies(nestedText, ctx, inOriginalBucket, relativePath);
    }
  }

  /** Resolve `user:<className>` to its project script file and pull it in (original-path). */
  private async collectScriptClass(className: string, ctx: CollectContext): Promise<void> {
    const index = await this.ensureScriptIndex(ctx);
    const scriptPath = index.get(className);
    if (!scriptPath) {
      console.warn(
        `[PublishToLibraryService] user:${className} not found under ${SCRIPT_DIRECTORIES.join(
          '/'
        )} — the bundle will not carry it.`
      );
      return;
    }
    await this.collectResourceFile(scriptPath, `res://${scriptPath}`, ctx, true);
  }

  /** Probe an import specifier's candidate paths; the first that exists is bundled (original). */
  private async collectRelativeImport(
    fromFile: string,
    specifier: string,
    ctx: CollectContext
  ): Promise<void> {
    for (const candidate of resolveImportCandidates(fromFile, specifier)) {
      const normalized = normalizeBundlePath(candidate);
      let blob = ctx.files.get(normalized);
      if (!blob) {
        try {
          blob = await this.storage.readBlob(normalized);
        } catch {
          continue; // Not this candidate — try the next extension/index form.
        }
        ctx.files.set(normalized, blob);
      }
      // Found it — treat like an original-path script reference.
      await this.collectResourceFile(normalized, `res://${normalized}`, ctx, true);
      return;
    }
  }

  /** Lazily build (once per publish) a `ClassName → script file path` index over the script dirs. */
  private async ensureScriptIndex(ctx: CollectContext): Promise<Map<string, string>> {
    if (ctx.scriptIndex) {
      return ctx.scriptIndex;
    }
    const index = new Map<string, string>();
    for (const directory of SCRIPT_DIRECTORIES) {
      let paths: string[];
      try {
        paths = await this.listSourceFilesRecursively(directory);
      } catch {
        continue; // Directory absent — normal.
      }
      for (const path of paths) {
        if (!/\.(ts|js)$/.test(path) || EXCLUDED_SCRIPT_SUFFIXES.some(s => path.endsWith(s))) {
          continue;
        }
        let text: string;
        try {
          text = await this.storage.readTextFile(path);
        } catch {
          continue;
        }
        const pattern = new RegExp(SCRIPT_CLASS_PATTERN.source, 'g');
        for (const match of text.matchAll(pattern)) {
          const className = match[1];
          if (!index.has(className)) {
            index.set(className, normalizeBundlePath(path));
          }
        }
      }
    }
    ctx.scriptIndex = index;
    return index;
  }

  private async listSourceFilesRecursively(directory: string): Promise<string[]> {
    const collected: string[] = [];
    const entries = await this.storage.listDirectory(directory);
    for (const entry of entries) {
      if (entry.kind === 'file') {
        collected.push(entry.path);
      } else if (entry.kind === 'directory') {
        collected.push(...(await this.listSourceFilesRecursively(entry.path)));
      }
    }
    return collected;
  }

  private newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `lib-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}
