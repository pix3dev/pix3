import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Texture } from 'three';

import { AssetLoader, type AssetLoaderResult, type LoadTextureOptions } from '../core/AssetLoader';
import { ResourceManager } from '../core/ResourceManager';
import type { SpineAsset, SpineAssetRequest } from '../core/spine/SpineAsset';

/**
 * `res://` from a project folder on disk, for hydrating scenes in plain Node.
 *
 * The base `ResourceManager` resolves `res://x` to `/x` and `fetch()`es it, which Node refuses for a
 * relative URL; overriding the two protected fetchers is all a disk project needs — prefabs
 * (`instance:`) and `.pix3anim` resources go through `readText`, textures through `readBlob`.
 */
export interface DiskResourceManagerOptions {
  /** Rewrites text files as they are read (e.g. a scaffolder's `{{PROJECT_NAME}}` placeholder). */
  readonly transformText?: (text: string, absolutePath: string) => string;
}

export class DiskResourceManager extends ResourceManager {
  readonly projectDir: string;
  private readonly transformText?: (text: string, absolutePath: string) => string;

  constructor(projectDir: string, options: DiskResourceManagerOptions = {}) {
    super('/');
    this.projectDir = resolve(projectDir);
    this.transformText = options.transformText;
  }

  /**
   * Absolute path of a `res://` (or project-relative) resource, or `null` when it would resolve
   * outside the project folder — a `res://../../x` is never read.
   */
  pathOf(resource: string): string | null {
    const url = this.normalize(resource).replace(/^\/+/, '');
    return this.containedPath(url);
  }

  /**
   * Whether the resource is a project file at all: `res://…` or a scheme-less path. `http(s):`,
   * `data:`, `blob:` and the editor's own `templ://` (its bundled templates) are not, and are
   * never checked.
   */
  isProjectResource(resource: string): boolean {
    const scheme = this.getScheme(resource);
    return scheme === '' || scheme === 'res';
  }

  /** Whether the resource names an existing file inside the project. */
  exists(resource: string): boolean {
    const path = this.pathOf(resource);
    if (!path || !existsSync(path)) return false;
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  protected override async fetchText(url: string): Promise<string> {
    const path = this.requirePath(url);
    const text = readFileSync(path, 'utf8');
    return this.transformText ? this.transformText(text, path) : text;
  }

  protected override async fetchBlob(url: string): Promise<Blob> {
    return new Blob([new Uint8Array(readFileSync(this.requirePath(url)))]);
  }

  private containedPath(projectRelative: string): string | null {
    const decoded = decodeURIComponent(projectRelative.replace(/^\/+/, ''));
    const path = resolve(join(this.projectDir, decoded));
    const rel = relative(this.projectDir, path);
    return rel.startsWith('..') || isAbsolute(rel) ? null : path;
  }

  private requirePath(url: string): string {
    const resource = `res://${url.replace(/^\/+/, '')}`;
    const path = this.containedPath(url);
    if (!path) {
      throw new MissingResourceError(resource, 'resolves outside the project folder');
    }
    if (!existsSync(path)) {
      throw new MissingResourceError(resource);
    }
    return path;
  }
}

/** A referenced file that does not exist. Carries the resource exactly as the scene wrote it. */
export class MissingResourceError extends Error {
  readonly resource: string;

  constructor(resource: string, reason = 'file not found') {
    super(`Missing resource ${resource} (${reason})`);
    this.name = 'MissingResourceError';
    this.resource = resource;
  }
}

/**
 * The file exists, but Node does not decode this kind of asset (a glTF, a Spine atlas page). Not a
 * scene problem — a harness collecting loader warnings should drop warnings carrying this error.
 */
export class ResourceNotDecodedError extends Error {
  readonly resource: string;

  constructor(resource: string) {
    super(`Resource ${resource} exists but is not decoded outside the browser`);
    this.name = 'ResourceNotDecodedError';
    this.resource = resource;
  }
}

/**
 * An `AssetLoader` that checks existence instead of decoding. Textures resolve to an empty
 * `Texture` (three's `TextureLoader` needs `document.createElementNS('img')`); models and Spine
 * assets reject with {@link ResourceNotDecodedError} when present, so the loader's own catch keeps
 * the node, and with {@link MissingResourceError} when absent. {@link missing} is the exact list of
 * referenced files that were not there, in first-seen order.
 */
export class NodeAssetLoader extends AssetLoader {
  private readonly missingSet = new Set<string>();
  private readonly disk: DiskResourceManager;

  constructor(disk: DiskResourceManager) {
    super(disk);
    this.disk = disk;
  }

  get missing(): string[] {
    return [...this.missingSet];
  }

  override async loadTexture(
    resourcePath: string,
    _options?: LoadTextureOptions
  ): Promise<Texture> {
    this.require(resourcePath);
    return new Texture();
  }

  override async loadAsset(resourcePath: string): Promise<AssetLoaderResult> {
    this.require(resourcePath);
    throw new ResourceNotDecodedError(resourcePath);
  }

  override async loadSpineAsset(request: SpineAssetRequest): Promise<SpineAsset> {
    this.require(request.skeletonPath);
    this.require(request.atlasPath);
    if (request.texturePath) this.require(request.texturePath);
    throw new ResourceNotDecodedError(request.skeletonPath);
  }

  private require(resourcePath: string): void {
    if (!this.disk.isProjectResource(resourcePath)) return;
    if (!this.disk.exists(resourcePath)) {
      this.missingSet.add(resourcePath);
      throw new MissingResourceError(resourcePath);
    }
  }
}
