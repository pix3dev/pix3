/**
 * Copies a library bundle into the current project (a snapshot, not a live link) and drives
 * its insertion into the scene through the existing mutation gateway.
 *
 * Copy step (not undoable — same as any asset import): files are written under
 * `res://assets/library/<slug>/…`, and `res://` references inside bundled scene/script files
 * are remapped to that prefix. Re-inserting an already-present item reuses its folder (dedup).
 *
 * Scene step (undoable): dispatches `CreatePrefabInstanceCommand` (prefab/scene) or
 * `CreateSprite2DCommand` (image) — their operations already provide "undo removes the node"
 * while leaving the copied files in place, exactly as the plan requires. Non-scene item types
 * (font/audio/shader/script/material) are copied only; the user assigns them via the inspector.
 */

import { inject, injectable } from '@/fw/di';
import { CommandDispatcher } from './CommandDispatcher';
import { ProjectStorageService } from './ProjectStorageService';
import { AssetLibraryService } from './AssetLibraryService';
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
  /** Project-relative directory the bundle was copied into (e.g. `assets/library/foo`). */
  readonly targetDir: string;
  /** `res://` path of the entry file (prefab/scene/image), when the item has one. */
  readonly entryResourcePath?: string;
  /** `res://` paths of every copied file. */
  readonly resourcePaths: readonly string[];
  /** True when the folder already existed and files were reused rather than rewritten. */
  readonly reused: boolean;
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
    const bundleFiles = allFiles.filter(file => file !== skipFile);

    const alreadyPresent = entryFile
      ? await this.pathExists(bundleFileToProjectPath(entryFile, targetDir))
      : await this.pathExists(targetDir);

    if (!alreadyPresent) {
      await this.writeBundle(bundle, targetDir, bundleFiles, skipFile);
    }

    const resourcePaths = bundleFiles.map(
      file => `res://${bundleFileToProjectPath(file, targetDir)}`
    );
    const entryResourcePath = entryFile
      ? `res://${bundleFileToProjectPath(entryFile, targetDir)}`
      : undefined;

    return {
      manifest,
      type: manifest.type,
      targetDir,
      entryResourcePath,
      resourcePaths,
      reused: alreadyPresent,
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

  private async writeBundle(
    bundle: LibraryBundle,
    targetDir: string,
    bundleFiles: readonly string[],
    skipFile: string | null
  ): Promise<void> {
    for (const [rawPath, blob] of bundle.files) {
      const relativePath = normalizeBundlePath(rawPath);
      if (relativePath === skipFile) {
        continue;
      }
      const projectPath = bundleFileToProjectPath(relativePath, targetDir);
      await this.ensureParentDirectory(projectPath);
      if (isTextReferenceFile(relativePath)) {
        const text = await blob.text();
        const remapped = remapBundleReferences(text, bundleFiles, targetDir);
        await this.storage.writeTextFile(projectPath, remapped);
      } else {
        await this.storage.writeBinaryFile(projectPath, await blob.arrayBuffer());
      }
    }
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
