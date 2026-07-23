import { inject, injectable } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { SculptSpec } from '@/services/model-gen/SculptSpec';
import { appState } from '@/state';
import type { Object3D } from 'three';

/** Optional sibling artifacts written next to the GLB, so a saved model can be regenerated later. */
export interface ModelArtifacts {
  /** The sculpt spec that produced the model — written to `<base>.sculpt.json` when provided. */
  spec?: SculptSpec | null;
  /** The procedural factory source — written to `<base>.factory.ts` when provided. */
  factoryCode?: string | null;
}

export interface Model3DSaveResult {
  /** Project-relative path the `.glb` was written to. */
  path: string;
  /** Byte size of the written binary. */
  bytes: number;
  /** Path the `.sculpt.json` was written to, or null when no spec artifact was provided. */
  sculptPath: string | null;
  /** Path the `.factory.ts` was written to, or null when no factory artifact was provided. */
  factoryPath: string | null;
}

/**
 * Exports an in-memory Three.js object as a binary glTF (`.glb`) and writes it into the project.
 *
 * This is the terminal step of the Model Lab pipeline: whatever a generated procedural factory
 * (or, for now, a hardcoded test model) produces as a `THREE.Group` is baked to a self-contained
 * GLB — standard/physical materials and canvas textures embed cleanly, and `object.userData` maps
 * to glTF `extras` — then saved through {@link ProjectStorageService} so it can be loaded by a
 * `MeshInstance` node exactly like any imported model.
 *
 * `GLTFExporter` is lazy-imported (from `three/examples/jsm`) so its code stays out of the main
 * bundle until Model Lab is actually opened.
 */
@injectable()
export class Model3DExportService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  /** Serialize an object tree to a binary glTF (`.glb`) ArrayBuffer. */
  async exportGlb(object: Object3D): Promise<ArrayBuffer> {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(object, {
      binary: true,
      // Keep userData → extras so runtime hierarchy hints (pivots/sockets) survive the round-trip.
      includeCustomExtensions: true,
    });
    if (!(result instanceof ArrayBuffer)) {
      // With `binary: true` the exporter always resolves to an ArrayBuffer; guard defensively so a
      // three.js version change can't silently write a JSON glTF into a `.glb`.
      throw new Error('GLTFExporter did not return binary output.');
    }
    return result;
  }

  /**
   * Export `object` to GLB and write it into the project at `path` (a project-relative path or
   * `res://…`). Parent directories are created as needed. Returns the normalized path + byte size
   * (and null artifact paths — see {@link saveModel} to write the spec/factory siblings too).
   */
  async saveGlb(object: Object3D, path: string): Promise<Model3DSaveResult> {
    return this.saveModel(object, path);
  }

  /**
   * Export `object` to GLB and write it into the project at `path`, optionally saving the sculpt
   * spec (`<base>.sculpt.json`) and procedural factory (`<base>.factory.ts`) as sibling files so the
   * model can be regenerated later. `<base>` is `path` with its trailing `.glb` stripped. Returns
   * the normalized GLB path + byte size and the artifact paths actually written (null when absent).
   */
  async saveModel(
    object: Object3D,
    path: string,
    artifacts?: ModelArtifacts
  ): Promise<Model3DSaveResult> {
    if (appState.project.status !== 'ready') {
      throw new Error('No project is open — cannot save.');
    }
    const relativePath = ensureGlbExtension(normalizeModelPath(path));
    if (!relativePath) {
      throw new Error('A file name is required.');
    }
    const buffer = await this.exportGlb(object);
    await this.ensureParentDirectory(relativePath);
    await this.storage.writeBinaryFile(relativePath, buffer);

    const base = deriveArtifactBasePath(relativePath);
    let sculptPath: string | null = null;
    let factoryPath: string | null = null;
    if (artifacts?.spec) {
      sculptPath = `${base}.sculpt.json`;
      await this.storage.writeTextFile(sculptPath, JSON.stringify(artifacts.spec, null, 2));
    }
    if (artifacts?.factoryCode) {
      factoryPath = `${base}.factory.ts`;
      await this.storage.writeTextFile(factoryPath, artifacts.factoryCode);
    }
    return { path: relativePath, bytes: buffer.byteLength, sculptPath, factoryPath };
  }

  private async ensureParentDirectory(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    segments.pop();
    let accumulated = '';
    for (const segment of segments) {
      if (!segment) {
        continue;
      }
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      try {
        await this.storage.createDirectory(accumulated);
      } catch {
        // directory likely already exists
      }
    }
  }
}

/** Strip a `res://` scheme, normalize slashes, and drop leading/trailing separators. */
export function normalizeModelPath(path: string): string {
  return path
    .trim()
    .replace(/^res:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** Ensure the path ends in `.glb` (case-insensitive), appending it when absent. */
export function ensureGlbExtension(path: string): string {
  if (!path) {
    return path;
  }
  return /\.glb$/i.test(path) ? path : `${path}.glb`;
}

/** Strip a trailing `.glb` (case-insensitive) to get the shared base for sibling artifact paths. */
export function deriveArtifactBasePath(glbPath: string): string {
  return glbPath.replace(/\.glb$/i, '');
}
