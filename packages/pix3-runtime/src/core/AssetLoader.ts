import { ResourceManager } from './ResourceManager';
import { MeshInstance } from '../nodes/3D/MeshInstance';
import { NodeBase } from '../nodes/NodeBase';
import {
  AnimationClip as ThreeAnimationClip,
  BufferGeometry,
  Material,
  Mesh,
  Texture,
  TextureLoader,
} from 'three';
import { AudioService } from './AudioService';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  normalizeAnimationResource,
  type AnimationResource,
} from './AnimationResource';

export interface AssetLoaderResult {
  node: NodeBase;
}

export interface InstancingModelAsset {
  geometry: BufferGeometry;
  material: Material | Material[];
  scene: GLTF['scene'];
}

export interface LoadedAudioMetadata {
  readonly resourcePath: string;
  readonly sizeBytes: number;
}

/**
 * AssetLoader is responsible for loading asset files from various URLs
 * and converting them to concrete NodeBase instances in the scene tree.
 *
 * Supported formats:
 * - .glb / .gltf → MeshInstance
 * - .png / .jpg / .jpeg / .webp → used by Sprite2D
 * - .mp3 / .ogg / .wav → AudioBuffer
 */
export class AssetLoader {
  private readonly resources: ResourceManager;
  private readonly audioService?: AudioService;
  private textureLoader: TextureLoader;
  private readonly textureCache = new Map<string, Texture>();
  private readonly textureLoadInFlight = new Map<string, Promise<Texture>>();
  private readonly animationResourceCache = new Map<string, AnimationResource>();
  private readonly animationResourceLoadInFlight = new Map<string, Promise<AnimationResource>>();
  private readonly audioLoadInFlight = new Map<string, Promise<AudioBuffer>>();
  private readonly audioMetadataCache = new Map<string, LoadedAudioMetadata>();

  constructor(resources: ResourceManager, audioService?: AudioService) {
    this.resources = resources;
    this.audioService = audioService;
    this.textureLoader = new TextureLoader();
  }

  getResourceManager(): ResourceManager {
    return this.resources;
  }

  getAudioMetadata(resourcePath: string): LoadedAudioMetadata | null {
    const metadata = this.audioMetadataCache.get(resourcePath);
    return metadata ? { ...metadata } : null;
  }

  /**
   * Load an asset file and return a NodeBase instance.
   * @param resourcePath Path to the asset file
   * @param nodeId Optional node ID; generates UUID if not provided
   * @param nodeName Optional node name; defaults to asset filename
   * @returns Loaded asset as a NodeBase instance
   */
  async loadAsset(
    resourcePath: string,
    nodeId?: string,
    nodeName?: string
  ): Promise<AssetLoaderResult> {
    const extension = this.getExtension(resourcePath);

    switch (extension) {
      case 'glb':
      case 'gltf':
        return this.loadGltfAsMeshInstance(resourcePath, nodeId, nodeName);

      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'webp':
        // For images, we usually want the texture, but if loadAsset is called,
        // we could potentially return a Sprite2D. However, let's just implement loadTexture for now.
        throw new Error(
          `[AssetLoader] Generic image node creation not yet implemented. Use loadTexture. Path: ${resourcePath}`
        );

      case 'mp3':
      case 'ogg':
      case 'wav':
        await this.loadAudio(resourcePath);
        throw new Error(
          `[AssetLoader] Audio assets are not node assets. Use loadAudio() instead. Path: ${resourcePath}`
        );

      case 'pix3anim':
        await this.loadAnimationResource(resourcePath);
        throw new Error(
          `[AssetLoader] Animation assets are metadata assets. Use loadAnimationResource() instead. Path: ${resourcePath}`
        );

      default:
        throw new Error(`[AssetLoader] Unsupported asset type: ${extension}`);
    }
  }

  async loadAudio(resourcePath: string): Promise<AudioBuffer> {
    if (!this.audioService) {
      throw new Error('[AssetLoader] AudioService is required to decode audio assets.');
    }
    const audioService = this.audioService;

    const cached = this.resources.getAudioBuffer(resourcePath);
    if (cached) {
      return cached;
    }

    const inFlight = this.audioLoadInFlight.get(resourcePath);
    if (inFlight) {
      return inFlight;
    }

    console.log(`[AssetLoader] Loading audio: ${resourcePath}`);

    const loadPromise = (async (): Promise<AudioBuffer> => {
      try {
        let arrayBuffer: ArrayBuffer;
        let sizeBytes = 0;
        if (resourcePath.startsWith('res://')) {
          // Use readBlob directly for res:// paths, same as textures and models.
          // Fetching via normalized URL can return a dev-server HTML fallback page,
          // causing decodeAudioData to throw EncodingError.
          const blob = await this.resources.readBlob(resourcePath);
          sizeBytes = blob.size;
          arrayBuffer = await blob.arrayBuffer();
        } else {
          try {
            const url = this.resources.normalize(resourcePath);
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} while fetching ${url}`);
            }
            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('text/html')) {
              throw new Error(`Unexpected HTML response for audio at ${url}`);
            }
            arrayBuffer = await response.arrayBuffer();
            const contentLength = Number(response.headers.get('content-length'));
            sizeBytes =
              Number.isFinite(contentLength) && contentLength > 0
                ? contentLength
                : arrayBuffer.byteLength;
          } catch {
            // Fallback for embedded resources that are not directly fetchable by URL.
            const blob = await this.resources.readBlob(resourcePath);
            sizeBytes = blob.size;
            arrayBuffer = await blob.arrayBuffer();
          }
        }

        const audioBuffer = await audioService.decodeAudioData(arrayBuffer);

        console.log(`[AssetLoader] Successfully loaded audio: ${resourcePath}`);
        this.audioMetadataCache.set(resourcePath, {
          resourcePath,
          sizeBytes: Math.max(0, Math.round(sizeBytes || arrayBuffer.byteLength)),
        });
        this.resources.setAudioBuffer(resourcePath, audioBuffer);
        return audioBuffer;
      } catch (err) {
        console.error(`[AssetLoader] Failed to load audio: ${resourcePath}`, err);
        throw err;
      }
    })();

    this.audioLoadInFlight.set(resourcePath, loadPromise);
    loadPromise.finally(() => {
      this.audioLoadInFlight.delete(resourcePath);
    });

    return loadPromise;
  }

  /**
   * Load an image as a THREE.Texture.
   */
  async loadTexture(resourcePath: string): Promise<Texture> {
    const cached = this.textureCache.get(resourcePath);
    if (cached) {
      return cached;
    }

    const inFlight = this.textureLoadInFlight.get(resourcePath);
    if (inFlight) {
      return inFlight;
    }

    console.log(`[AssetLoader] Loading texture: ${resourcePath}`);

    const loadPromise = (async (): Promise<Texture> => {
      let url: string;
      let isObjectURL = false;

      if (resourcePath.startsWith('res://')) {
        try {
          const blob = await this.resources.readBlob(resourcePath);
          url = URL.createObjectURL(blob);
          isObjectURL = true;
          console.log(`[AssetLoader] Created ObjectURL for ${resourcePath}`);
        } catch (err) {
          console.error(`[AssetLoader] Failed to read blob for ${resourcePath}:`, err);
          throw err;
        }
      } else {
        url = this.resources.normalize(resourcePath);
      }

      return new Promise<Texture>((resolve, reject) => {
        this.textureLoader.load(
          url,
          texture => {
            console.log(`[AssetLoader] Successfully loaded texture: ${resourcePath}`);
            if (isObjectURL) {
              URL.revokeObjectURL(url);
            }
            this.textureCache.set(resourcePath, texture);
            resolve(texture);
          },
          undefined,
          error => {
            console.error(`[AssetLoader] Failed to load texture: ${url}`, error);
            if (isObjectURL) {
              URL.revokeObjectURL(url);
            }
            reject(error);
          }
        );
      });
    })();

    this.textureLoadInFlight.set(resourcePath, loadPromise);
    loadPromise.finally(() => {
      this.textureLoadInFlight.delete(resourcePath);
    });

    return loadPromise;
  }

  async loadAnimationResource(resourcePath: string): Promise<AnimationResource> {
    const cached = this.animationResourceCache.get(resourcePath);
    if (cached) {
      return cached;
    }

    const inFlight = this.animationResourceLoadInFlight.get(resourcePath);
    if (inFlight) {
      return inFlight;
    }

    const loadPromise = (async (): Promise<AnimationResource> => {
      const source = await this.resources.readText(resourcePath);

      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch (error) {
        throw new Error(
          `[AssetLoader] Failed to parse animation resource ${resourcePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const resource = normalizeAnimationResource(parsed);
      this.animationResourceCache.set(resourcePath, resource);
      return resource;
    })();

    this.animationResourceLoadInFlight.set(resourcePath, loadPromise);
    loadPromise.finally(() => {
      this.animationResourceLoadInFlight.delete(resourcePath);
    });

    return loadPromise;
  }

  async loadInstancingModel(resourcePath: string): Promise<InstancingModelAsset> {
    const gltf = await this.loadGltf(resourcePath);
    const mesh = this.findFirstMesh(gltf.scene);

    if (!mesh) {
      throw new Error(`[AssetLoader] No mesh found in model: ${resourcePath}`);
    }

    return {
      geometry: mesh.geometry.clone(),
      material: Array.isArray(mesh.material)
        ? mesh.material.map(material => material.clone())
        : mesh.material.clone(),
      scene: gltf.scene,
    };
  }

  /**
   * Load a GLB/GLTF file and convert it to a MeshInstance node.
   * @param resourcePath Path to the .glb/.gltf file
   * @param nodeId Optional node ID; generates UUID if not provided
   * @param nodeName Optional node name; defaults to 'mesh' if not provided
   * @returns MeshInstance node with loaded geometry and animations
   */
  private async loadGltfAsMeshInstance(
    resourcePath: string,
    nodeId?: string,
    nodeName?: string
  ): Promise<AssetLoaderResult> {
    try {
      const gltf = await this.loadGltf(resourcePath);

      const animations = gltf.animations.map((clip: ThreeAnimationClip) => clip.clone());

      const finalNodeId = nodeId || crypto.randomUUID();
      const finalNodeName = nodeName || 'mesh';

      const meshInstance = new MeshInstance({
        id: finalNodeId,
        name: finalNodeName,
        src: resourcePath,
      });

      // Add loaded geometry to the instance
      meshInstance.add(gltf.scene);
      meshInstance.animations = animations;

      return { node: meshInstance };
    } catch (error) {
      console.error(`[AssetLoader] Failed to load GLTF: ${resourcePath}`, error);
      throw new Error(
        `Failed to load asset: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async loadGltf(resourcePath: string): Promise<GLTF> {
    const blob = await this.resources.readBlob(resourcePath);
    const arrayBuffer = await blob.arrayBuffer();
    const loader = new GLTFLoader();

    return new Promise<GLTF>((resolve, reject) => {
      loader.parse(
        arrayBuffer,
        '',
        result => resolve(result as GLTF),
        error => reject(error)
      );
    });
  }

  private findFirstMesh(root: GLTF['scene']): Mesh | null {
    let foundMesh: Mesh | null = null;

    root.traverse(object => {
      if (foundMesh || !(object instanceof Mesh)) {
        return;
      }

      foundMesh = object;
    });

    return foundMesh;
  }

  /**
   * Extract file extension from resource path.
   */
  private getExtension(resourcePath: string): string {
    const match = resourcePath.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }
}
