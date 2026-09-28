/**
 * Copies a library bundle into the current project (a snapshot, not a live link) and drives
 * its insertion into the scene through the existing mutation gateway.
 *
 * Copy step (not undoable — same as any asset import). A bundle has two file buckets:
 *  - **namespaced** — the prefab/scene entry and its scene-referenced assets: written under
 *    `res://assets/library/<slug>/…`, with `res://` references remapped to that prefix — except
 *    files whose content the project already holds (sha256, any path), which are reused in place.
 *  - **original-path** (`manifest.originalPathFiles`) — `user:` scripts + assets referenced from
 *    script code: restored **verbatim** to their original project paths (a `.ts` file's baked-in
 *    paths can't be remapped, and scripts only register under `scripts/`). References to these
 *    files are left unremapped so they resolve at the restored location. Conflicts never
 *    overwrite: an identical existing file is skipped silently, a differing one is kept and
 *    reported in `warnings`.
 *
 * Scene step (undoable): dispatches `CreatePrefabInstanceCommand` (prefab/scene) or
 * `CreateSprite2DCommand` (image) — their operations already provide "undo removes the node"
 * while leaving the copied files in place, exactly as the plan requires. When the bundle carries
 * scripts, a script rebuild is forced *before* the scene command so `user:*` components resolve.
 * Non-scene item types (font/audio/shader/script/material) are copied only; the user assigns them.
 */

import { inject, injectable } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CreatePrefabInstanceCommand } from '@/features/scene/CreatePrefabInstanceCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { Vector2 } from 'three';
import type {
  LibraryBundle,
  LibraryItemManifest,
  LibraryItemType,
} from '@/services/library/library-types';
import {
  bundleFileToProjectPath,
  insertTargetDir,
  isTextReferenceFile,
  normalizeBundlePath,
  referencedBundleFiles,
  remapBundleReferencesTo,
} from '@/services/library/library-path-remap';

/**
 * Concurrent file writes during a copy: enough to hide per-request latency on a remote `pix3 serve`
 * workspace (one HTTP round trip per file), few enough not to flood it.
 */
const WRITE_CONCURRENCY = 6;

interface PendingWrite {
  readonly path: string;
  readonly data: string | ArrayBuffer;
}

/** Hex sha256 of bytes (text as UTF-8) — the form both hashed manifests use; null without WebCrypto. */
async function sha256Hex(data: string | ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return null;
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function byteLength(data: string | ArrayBuffer): number {
  return typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

/** Describes where a bundle landed in the project after the copy step. */
export interface InsertedBundle {
  readonly manifest: LibraryItemManifest;
  readonly type: LibraryItemType;
  /** Project-relative directory the namespaced files were copied into (e.g. `assets/library/foo`). */
  readonly targetDir: string;
  /** `res://` path of the entry file (prefab/scene/image), when the item has one. */
  readonly entryResourcePath?: string;
  /** `res://` paths of every copied file (namespaced at target dir, original-path verbatim). */
  readonly resourcePaths: readonly string[];
  /** True when the namespaced folder already existed and its files were reused, not rewritten. */
  readonly reused: boolean;
  /** Non-fatal notices — e.g. an original-path file kept because it differed from the bundle. */
  readonly warnings: readonly string[];
}

/** Placement hints forwarded to the underlying create command (all optional). */
export interface LibraryInsertPlacement {
  readonly viewportScreenPoint?: { x: number; y: number } | null;
  readonly parentNodeId?: string | null;
  readonly position?: Vector2 | null;
}

@injectable()
export class LibraryInsertService {
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;
  @inject(ProjectStorageService) private readonly storage!: ProjectStorageService;
  @inject(CommandDispatcher) private readonly commands!: CommandDispatcher;
  @inject(ProjectScriptLoaderService) private readonly scriptLoader!: ProjectScriptLoaderService;
  @inject(EditorTabService) private readonly editorTabs!: EditorTabService;

  /**
   * Copy a bundle into the project. Returns `null` if the item can't be found. Idempotent:
   * if the target folder already contains the entry, the copy is skipped (dedup).
   */
  async copyBundleIntoProject(itemId: string): Promise<InsertedBundle | null> {
    const bundle = await this.library.getItemBundle(itemId);
    if (!bundle) {
      return null;
    }
    // One asset-browser refresh for the whole copy, not one per file.
    return this.storage.batchMutations(() => this.copyBundle(bundle));
  }

  private async copyBundle(bundle: LibraryBundle): Promise<InsertedBundle> {
    const manifest = bundle.manifest;
    const targetDir = insertTargetDir(manifest.slug);
    const allFiles = [...bundle.files.keys()].map(normalizeBundlePath);
    const entryFile = this.resolveEntryFile(manifest, allFiles);

    // A rendered preview thumbnail is library-only chrome; don't leak it into the project. Keep
    // it only when the preview IS the asset (e.g. an image item that previews as itself).
    const previewFile = manifest.preview ? normalizeBundlePath(manifest.preview) : null;
    const skipFile = previewFile && previewFile !== entryFile ? previewFile : null;

    // Partition into the two buckets (preview excluded from both).
    const originalSet = new Set((manifest.originalPathFiles ?? []).map(normalizeBundlePath));
    const namespacedFiles: string[] = [];
    const originalFiles: string[] = [];
    for (const file of allFiles) {
      if (file === skipFile) {
        continue;
      }
      (originalSet.has(file) ? originalFiles : namespacedFiles).push(file);
    }

    // Namespaced write — dedup on the entry (idempotent re-insert reuses the folder).
    const entryNamespaced = entryFile !== undefined && !originalSet.has(entryFile);
    const alreadyPresent =
      entryFile && entryNamespaced
        ? await this.pathExists(bundleFileToProjectPath(entryFile, targetDir))
        : await this.pathExists(targetDir);
    let placement: Map<string, string>;
    let written = 0;
    if (alreadyPresent) {
      placement = new Map(
        namespacedFiles.map(file => [file, bundleFileToProjectPath(file, targetDir)] as const)
      );
    } else {
      ({ placement, written } = await this.writeNamespacedFiles(
        bundle,
        targetDir,
        namespacedFiles,
        entryFile
      ));
    }

    // Original-path restore always runs — it is idempotent (skip-if-identical) and covers the
    // case where the namespaced folder was copied earlier but the scripts are absent here.
    const warnings = await this.restoreOriginalFiles(bundle, originalFiles);

    const resourcePaths = [
      ...namespacedFiles.map(file => `res://${placement.get(file)}`),
      ...originalFiles.map(file => `res://${file}`),
    ];
    const entryResourcePath = entryFile
      ? entryNamespaced
        ? `res://${placement.get(entryFile) ?? bundleFileToProjectPath(entryFile, targetDir)}`
        : `res://${entryFile}`
      : undefined;

    return {
      manifest,
      type: manifest.type,
      targetDir,
      entryResourcePath,
      resourcePaths,
      reused: alreadyPresent || (namespacedFiles.length > 0 && written === 0),
      warnings,
    };
  }

  /**
   * Copy the bundle (if needed) and, for scene-insertable types, dispatch the create command.
   * Returns the inserted-bundle descriptor, or `null` when the item is missing.
   */
  async insert(
    itemId: string,
    placement: LibraryInsertPlacement = {}
  ): Promise<InsertedBundle | null> {
    const inserted = await this.copyBundleIntoProject(itemId);
    if (!inserted) {
      return null;
    }
    await this.dispatchInsertCommand(inserted, placement);
    return inserted;
  }

  /**
   * Copy a scene/prefab bundle into the project and open its entry as its own scene tab (rather
   * than instancing it into the current scene). This is how scene *templates* — shops, level
   * maps, settings menus, cutscene shells — land in a project. Scripts are rebuilt first so their
   * `user:*` components resolve when the opened scene parses.
   */
  async addAsScene(itemId: string): Promise<InsertedBundle | null> {
    const inserted = await this.copyBundleIntoProject(itemId);
    if (!inserted?.entryResourcePath) {
      return inserted;
    }
    if (this.hasOriginalScripts(inserted.manifest)) {
      await this.scriptLoader.syncAndBuild({ force: true });
      await this.scriptLoader.ensureReady();
    }
    await this.editorTabs.focusOrOpenScene(inserted.entryResourcePath);
    return inserted;
  }

  /**
   * Dispatch the scene-insertion command for an already-copied bundle. Split out so the
   * viewport drop handler can resolve placement (parent/world position) before inserting.
   * Returns whether a node was created.
   */
  async dispatchInsertCommand(
    inserted: InsertedBundle,
    placement: LibraryInsertPlacement = {}
  ): Promise<boolean> {
    if (!inserted.entryResourcePath) {
      return false;
    }
    // The bundle just restored `user:` scripts into `scripts/`; register them before the scene is
    // parsed, otherwise their components are dropped from the freshly-inserted nodes.
    if (this.hasOriginalScripts(inserted.manifest)) {
      await this.scriptLoader.syncAndBuild({ force: true });
      await this.scriptLoader.ensureReady();
    }
    if (inserted.type === 'prefab' || inserted.type === 'scene') {
      return this.commands.execute(
        new CreatePrefabInstanceCommand({
          prefabPath: inserted.entryResourcePath,
          nodeName: inserted.manifest.name,
          parentNodeId: placement.parentNodeId ?? undefined,
          viewportScreenPoint: placement.viewportScreenPoint ?? undefined,
        })
      );
    }
    if (inserted.type === 'image') {
      return this.commands.execute(
        new CreateSprite2DCommand({
          texturePath: inserted.entryResourcePath,
          spriteName: inserted.manifest.name,
          parentNodeId: placement.parentNodeId ?? undefined,
          position: placement.position ?? undefined,
        })
      );
    }
    return false;
  }

  // -- internals -------------------------------------------------------------

  private resolveEntryFile(
    manifest: LibraryItemManifest,
    bundleFiles: readonly string[]
  ): string | undefined {
    if (manifest.entry) {
      return normalizeBundlePath(manifest.entry);
    }
    // Fall back to the single file for degenerate one-file bundles (e.g. a lone image).
    if (bundleFiles.length === 1) {
      return bundleFiles[0];
    }
    return undefined;
  }

  private hasOriginalScripts(manifest: LibraryItemManifest): boolean {
    return (manifest.originalPathFiles ?? []).some(path => /\.(ts|js|mjs)$/.test(path));
  }

  /**
   * Place the namespaced bucket, returning where each bundle file landed (bundle path → project
   * path) and how many files were actually written.
   *
   * **Content dedup.** A file whose bytes the project already holds — at any path — is not copied;
   * references to it are pointed at the existing file. Binary files are matched as-is; a text file
   * is matched *after* its references are remapped, so a flipbook whose frames were all found in
   * place compares equal to the project's own flipbook and is reused too. Inserting an item back
   * into the project it was published from therefore writes nothing but its synthetic entry.
   * Only references to *other namespaced files* are remapped — references to original-path files
   * (scripts, code-loaded audio) are left alone so they resolve where `restoreOriginalFiles` puts
   * them.
   *
   * **Write order.** Binaries first, then text files in dependency order (a file is written only
   * after every bundle file it references), the entry last. A listing refresh that loads a
   * half-copied item would otherwise find a prefab whose frames do not exist yet — and the loader
   * logs a failure for every one of them. Files within one stage are written concurrently.
   */
  private async writeNamespacedFiles(
    bundle: LibraryBundle,
    targetDir: string,
    namespacedFiles: readonly string[],
    entryFile: string | undefined
  ): Promise<{ placement: Map<string, string>; written: number }> {
    const namespacedSet = new Set(namespacedFiles);
    const blobs = new Map<string, Blob>();
    for (const [rawPath, blob] of bundle.files) {
      const relativePath = normalizeBundlePath(rawPath);
      if (namespacedSet.has(relativePath)) {
        blobs.set(relativePath, blob);
      }
    }
    const files = [...blobs.keys()];
    const hashIndex = await this.storage.getContentHashIndex();
    const placement = new Map<string, string>();
    let written = 0;

    const place = async (
      file: string,
      data: string | ArrayBuffer
    ): Promise<PendingWrite | null> => {
      const existing = await this.findExistingContent(file, data, hashIndex);
      if (existing) {
        placement.set(file, existing);
        return null;
      }
      const projectPath = bundleFileToProjectPath(file, targetDir);
      placement.set(file, projectPath);
      return { path: projectPath, data };
    };

    // Stage 1: binaries (frames, textures, audio) — they reference nothing.
    const directories = new Set<string>();
    const binaries = await Promise.all(
      files
        .filter(file => !isTextReferenceFile(file))
        .map(async file => place(file, await blobs.get(file)!.arrayBuffer()))
    );
    written += await this.writeAll(binaries, directories);

    // Stage 2..n: text files, each once every bundle file it references is placed.
    const texts = new Map<string, string>();
    for (const file of files.filter(isTextReferenceFile)) {
      texts.set(file, await blobs.get(file)!.text());
    }
    const dependencies = new Map(
      [...texts].map(([file, text]) => [file, referencedBundleFiles(text, files)] as const)
    );
    let remaining = [...texts.keys()];
    while (remaining.length > 0) {
      let ready = remaining.filter(file =>
        dependencies.get(file)!.every(dep => placement.has(dep))
      );
      let writes: (PendingWrite | null)[];
      if (ready.length > 0) {
        writes = await Promise.all(
          ready.map(file => place(file, remapBundleReferencesTo(texts.get(file)!, placement)))
        );
      } else {
        // A reference cycle: pin the rest into the target folder so their mutual references
        // resolve, and copy them without dedup (their final text depends on their own placement).
        for (const file of remaining) {
          placement.set(file, bundleFileToProjectPath(file, targetDir));
        }
        ready = remaining;
        writes = ready.map(file => ({
          path: placement.get(file)!,
          data: remapBundleReferencesTo(texts.get(file)!, placement),
        }));
      }
      const readySet = new Set(ready);
      remaining = remaining.filter(file => !readySet.has(file));

      const entryPath = entryFile !== undefined ? placement.get(entryFile) : undefined;
      const entryWrite = writes.find(write => write !== null && write.path === entryPath) ?? null;
      written += await this.writeAll(
        writes.filter(write => write !== entryWrite),
        directories
      );
      written += await this.writeAll([entryWrite], directories);
    }
    return { placement, written };
  }

  /**
   * Project path of a file with exactly `data`'s bytes, or null. Uses the backend's hashed
   * manifest when it has one; on the local FSA backend (no manifest hashes) it checks only the
   * file's own original path — the insert-back-into-its-source-project case — by hashing it.
   */
  private async findExistingContent(
    bundlePath: string,
    data: string | ArrayBuffer,
    hashIndex: ReadonlyMap<string, readonly string[]> | null
  ): Promise<string | null> {
    const hash = await sha256Hex(data);
    if (hash === null) {
      return null;
    }
    if (hashIndex) {
      // Equal content is common (a looping flipbook repeats frames): keep the file's own path when
      // it is among the matches, so references — and the text files carrying them — stay as-is.
      const paths = hashIndex.get(hash);
      return paths ? (paths.includes(bundlePath) ? bundlePath : paths[0]) : null;
    }
    const candidate = await this.readExisting(bundlePath);
    if (!candidate || candidate.size !== byteLength(data)) {
      return null;
    }
    return (await sha256Hex(await candidate.arrayBuffer())) === hash ? bundlePath : null;
  }

  /**
   * Write files concurrently (bounded), creating each parent directory once per copy — `created`
   * carries the directories already made across calls. Returns the number of files written.
   */
  private async writeAll(
    writes: readonly (PendingWrite | null)[],
    created: Set<string>
  ): Promise<number> {
    const queue = writes.filter((write): write is PendingWrite => write !== null);
    for (const write of queue) {
      const directory = write.path.split('/').slice(0, -1).join('/');
      if (directory && !created.has(directory)) {
        created.add(directory);
        await this.storage.createDirectory(directory);
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const { path, data } = queue[next++];
        if (typeof data === 'string') {
          await this.storage.writeTextFile(path, data);
        } else {
          await this.storage.writeBinaryFile(path, data);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, queue.length) }, worker));
    return queue.length;
  }

  /**
   * Restore original-path files verbatim to their own project paths. Never overwrites: an
   * identical existing file is skipped silently; a differing one is kept and reported.
   */
  private async restoreOriginalFiles(
    bundle: LibraryBundle,
    originalFiles: readonly string[]
  ): Promise<string[]> {
    const warnings: string[] = [];
    const lookup = new Map<string, Blob>();
    for (const [rawPath, blob] of bundle.files) {
      lookup.set(normalizeBundlePath(rawPath), blob);
    }

    for (const file of originalFiles) {
      const blob = lookup.get(file);
      if (!blob) {
        continue;
      }
      const existing = await this.readExisting(file);
      if (existing) {
        if (!(await this.blobsEqual(existing, blob))) {
          warnings.push(`Kept existing ${file} — it differs from the library copy.`);
        }
        continue;
      }
      await this.ensureParentDirectory(file);
      if (isTextReferenceFile(file)) {
        await this.storage.writeTextFile(file, await blob.text());
      } else {
        await this.storage.writeBinaryFile(file, await blob.arrayBuffer());
      }
    }

    for (const warning of warnings) {
      console.warn(`[LibraryInsertService] ${warning}`);
    }
    return warnings;
  }

  private async readExisting(path: string): Promise<Blob | null> {
    try {
      return await this.storage.readBlob(path);
    } catch {
      return null;
    }
  }

  private async blobsEqual(a: Blob, b: Blob): Promise<boolean> {
    if (a.size !== b.size) {
      return false;
    }
    const [bufferA, bufferB] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
    const viewA = new Uint8Array(bufferA);
    const viewB = new Uint8Array(bufferB);
    for (let index = 0; index < viewA.length; index += 1) {
      if (viewA[index] !== viewB[index]) {
        return false;
      }
    }
    return true;
  }

  private async ensureParentDirectory(filePath: string): Promise<void> {
    const segments = filePath.split('/').filter(Boolean);
    segments.pop();
    if (segments.length === 0) {
      return;
    }
    await this.storage.createDirectory(segments.join('/'));
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      // Note: on the cloud backend `getFileHandle` always returns null, so dedup only
      // kicks in for local projects; re-copying on cloud is harmless (identical overwrite).
      const handle = await this.storage.getFileHandle(path);
      return handle != null;
    } catch {
      return false;
    }
  }
}
