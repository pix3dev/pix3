/**
 * Copies a library bundle into the current project (a snapshot, not a live link) and drives
 * its insertion into the scene through the existing mutation gateway.
 *
 * Copy step (not undoable — same as any asset import). A bundle has two file buckets:
 *  - **namespaced** — the prefab/scene entry and its scene-referenced assets: written under
 *    `res://assets/library/<slug>/…`, with `res://` references remapped to that prefix.
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
import { CommandDispatcher } from './CommandDispatcher';
import { ProjectStorageService } from './ProjectStorageService';
import { AssetLibraryService } from './AssetLibraryService';
import { ProjectScriptLoaderService } from './ProjectScriptLoaderService';
import { EditorTabService } from './EditorTabService';
import { CreatePrefabInstanceCommand } from '@/features/scene/CreatePrefabInstanceCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { Vector2 } from 'three';
import type { LibraryBundle, LibraryItemManifest, LibraryItemType } from './library/library-types';
import {
  bundleFileToProjectPath,
  insertTargetDir,
  isTextReferenceFile,
  normalizeBundlePath,
  remapBundleReferences,
} from './library/library-path-remap';

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
    if (!alreadyPresent) {
      await this.writeNamespacedFiles(bundle, targetDir, namespacedFiles);
    }

    // Original-path restore always runs — it is idempotent (skip-if-identical) and covers the
    // case where the namespaced folder was copied earlier but the scripts are absent here.
    const warnings = await this.restoreOriginalFiles(bundle, originalFiles);

    const resourcePaths = [
      ...namespacedFiles.map(file => `res://${bundleFileToProjectPath(file, targetDir)}`),
      ...originalFiles.map(file => `res://${file}`),
    ];
    const entryResourcePath = entryFile
      ? entryNamespaced
        ? `res://${bundleFileToProjectPath(entryFile, targetDir)}`
        : `res://${entryFile}`
      : undefined;

    return {
      manifest,
      type: manifest.type,
      targetDir,
      entryResourcePath,
      resourcePaths,
      reused: alreadyPresent,
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
   * Write the namespaced bucket under `targetDir`. Only references to *other namespaced files*
   * are remapped — references to original-path files (scripts, code-loaded audio) are left alone
   * so they resolve at the verbatim locations `restoreOriginalFiles` writes them to.
   */
  private async writeNamespacedFiles(
    bundle: LibraryBundle,
    targetDir: string,
    namespacedFiles: readonly string[]
  ): Promise<void> {
    const namespacedSet = new Set(namespacedFiles);
    for (const [rawPath, blob] of bundle.files) {
      const relativePath = normalizeBundlePath(rawPath);
      if (!namespacedSet.has(relativePath)) {
        continue;
      }
      const projectPath = bundleFileToProjectPath(relativePath, targetDir);
      await this.ensureParentDirectory(projectPath);
      if (isTextReferenceFile(relativePath)) {
        const text = await blob.text();
        const remapped = remapBundleReferences(text, namespacedFiles, targetDir);
        await this.storage.writeTextFile(projectPath, remapped);
      } else {
        await this.storage.writeBinaryFile(projectPath, await blob.arrayBuffer());
      }
    }
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
