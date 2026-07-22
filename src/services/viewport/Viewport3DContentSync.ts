import * as THREE from 'three';
import type { NodeBase, SceneGraph } from '@pix3/runtime';
import { GeometryMesh, Particles3D, Sprite3D } from '@pix3/runtime';
import { configureSpriteTexture } from './Viewport2DProxyRegistry';

/**
 * Dependencies the 3D content sync borrows from {@link ViewportRendererService}.
 * Scoped to exactly what this collaborator needs; the facade owns the scene
 * graph, the resource manager, and the render request path, and passes them in
 * via closures so this object never reaches back into the facade directly.
 */
export interface Viewport3DContentSyncDeps {
  getActiveSceneGraph(): SceneGraph | null;
  readBlob(path: string): Promise<Blob>;
  requestRender(): void;
}

/**
 * Owns the editor-viewport texture/billboard sync for the 3D node types
 * (Sprite3D, Particles3D, GeometryMesh). Extracted from ViewportRendererService
 * (decomposition step 8/13). Not `@injectable()` — it is an owned collaborator
 * constructed by the facade with borrowed dependencies.
 */
export class Viewport3DContentSync {
  private sprite3DTexturePaths = new Map<string, string | null>();
  private particles3DTexturePaths = new Map<string, string | null>();
  private geometryMeshMapPaths = new Map<string, string | null>();

  constructor(private readonly deps: Viewport3DContentSyncDeps) {}

  /** Clear the cached texture/map paths for all 3D nodes (scene teardown / dispose). */
  clearTexturePaths(): void {
    this.sprite3DTexturePaths.clear();
    this.particles3DTexturePaths.clear();
    this.geometryMeshMapPaths.clear();
  }

  syncSprite3DBillboarding(camera: THREE.Camera): void {
    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const cameraQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node instanceof Sprite3D) {
          node.applyBillboard(cameraQuaternion);
        } else if (node instanceof Particles3D) {
          // Camera position drives trail ribbons; world-space compensation latches here too.
          node.syncRenderState(cameraQuaternion, cameraPosition);
        }
        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
  }

  syncSprite3DTexture(node: Sprite3D): void {
    const currentTexturePath = node.texturePath ?? null;
    const previousTexturePath = this.sprite3DTexturePaths.get(node.nodeId) ?? null;
    if (currentTexturePath === previousTexturePath) {
      return;
    }

    this.sprite3DTexturePaths.set(node.nodeId, currentTexturePath);
    if (!currentTexturePath) {
      node.clearTexture();
      return;
    }

    const textureLoader = new THREE.TextureLoader();
    void (async () => {
      try {
        const blob = await this.deps.readBlob(currentTexturePath);
        const blobUrl = URL.createObjectURL(blob);
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              configureSpriteTexture(texture);
              node.setTexture(texture);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
        return;
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(currentTexturePath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          const texture = textureLoader.load(currentTexturePath, undefined, undefined, () => {
            console.warn('[ViewportRenderer] Failed to load Sprite3D texture', currentTexturePath);
          });
          configureSpriteTexture(texture);
          node.setTexture(texture);
          return;
        }
      }

      console.warn(
        '[ViewportRenderer] Skipping Sprite3D texture load for scheme',
        currentTexturePath
      );
    })();
  }

  syncParticles3DTexture(node: Particles3D): void {
    const currentTexturePath = node.texturePath ?? null;
    const previousTexturePath = this.particles3DTexturePaths.get(node.nodeId) ?? null;
    if (currentTexturePath === previousTexturePath) {
      return;
    }

    this.particles3DTexturePaths.set(node.nodeId, currentTexturePath);
    if (!currentTexturePath) {
      node.clearTexture();
      return;
    }

    const textureLoader = new THREE.TextureLoader();
    void (async () => {
      try {
        const blob = await this.deps.readBlob(currentTexturePath);
        const blobUrl = URL.createObjectURL(blob);
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              configureSpriteTexture(texture);
              node.setTexture(texture);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
        return;
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(currentTexturePath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          const texture = textureLoader.load(currentTexturePath, undefined, undefined, () => {
            console.warn(
              '[ViewportRenderer] Failed to load Particles3D texture',
              currentTexturePath
            );
          });
          configureSpriteTexture(texture);
          node.setTexture(texture);
          return;
        }
      }

      console.warn(
        '[ViewportRenderer] Skipping Particles3D texture load for scheme',
        currentTexturePath
      );
    })();
  }

  /**
   * Load & assign a GeometryMesh's albedo map in the editor viewport when its
   * res:// path changes (the runtime node only tracks the path; the loader does
   * this at scene-load / play time). 3D textures keep mipmaps, so — unlike the
   * 2D sprite path — we do NOT run it through configureSpriteTexture; setMap
   * forces the colour space and leaves mipmapping on.
   */
  syncGeometryMeshMap(node: GeometryMesh): void {
    const currentMapPath = node.mapSrc || null;
    const previousMapPath = this.geometryMeshMapPaths.get(node.nodeId) ?? null;
    if (currentMapPath === previousMapPath) {
      return;
    }

    this.geometryMeshMapPaths.set(node.nodeId, currentMapPath);
    if (!currentMapPath) {
      node.setMap(null);
      this.deps.requestRender();
      return;
    }

    const textureLoader = new THREE.TextureLoader();
    void (async () => {
      try {
        const blob = await this.deps.readBlob(currentMapPath);
        const blobUrl = URL.createObjectURL(blob);
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              node.setMap(texture);
              this.deps.requestRender();
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
        return;
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(currentMapPath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          const texture = textureLoader.load(currentMapPath, undefined, undefined, () => {
            console.warn('[ViewportRenderer] Failed to load GeometryMesh map', currentMapPath);
          });
          node.setMap(texture);
          this.deps.requestRender();
          return;
        }
      }

      console.warn('[ViewportRenderer] Skipping GeometryMesh map load for scheme', currentMapPath);
    })();
  }
}
