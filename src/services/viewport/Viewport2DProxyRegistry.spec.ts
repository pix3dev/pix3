import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AnimatedSprite2D, AssetLoader, type ResourceManager } from '@pix3/runtime';
import { Viewport2DProxyRegistry } from '@/services/viewport/Viewport2DProxyRegistry';

const RESOURCE_PATH = 'res://sprites/walk/walk.pix3anim';
const FRAME_1 = 'res://sprites/walk/walk_0001.png';
const FRAME_2 = 'res://sprites/walk/walk_0002.png';
const SHEET = 'res://sprites/walk/walk-sheet.png';

/**
 * A decoded texture standing in for a loaded PNG. Seeded straight into the
 * AssetLoader cache so `loadTexture` never touches the (absent) project
 * filesystem — an unseeded `res://` load leaves a detached rejection behind that
 * fails the whole Vitest run.
 */
function seedTexture(assetLoader: AssetLoader, path: string, size: number): THREE.Texture {
  const texture = new THREE.Texture();
  texture.image = { width: size, height: size };
  texture.name = path;
  assetLoader.seedTexture(path, texture);
  return texture;
}

function sequenceResource(): string {
  return JSON.stringify({
    version: '1.0.0',
    texturePath: '',
    clips: [
      {
        name: 'walk',
        fps: 12,
        loop: true,
        frames: [
          { texturePath: FRAME_1, sourceSize: { width: 32, height: 32 } },
          { texturePath: FRAME_2, sourceSize: { width: 32, height: 32 } },
        ],
      },
    ],
  });
}

function sheetResource(): string {
  return JSON.stringify({
    version: '1.0.0',
    texturePath: SHEET,
    clips: [
      {
        name: 'walk',
        fps: 12,
        loop: true,
        frames: [
          { offset: { x: 0, y: 0 }, repeat: { x: 0.5, y: 1 } },
          { offset: { x: 0.5, y: 0 }, repeat: { x: 0.5, y: 1 } },
        ],
      },
    ],
  });
}

function createRegistry(resourceText: string) {
  const assetLoader = new AssetLoader({
    readBlob: async () => new Blob(),
    readText: async () => '',
    normalize: (path: string) => path,
  } as unknown as ResourceManager);
  const requestRender = vi.fn();
  const registry = new Viewport2DProxyRegistry({
    readBlob: async () => new Blob(),
    readText: async () => resourceText,
    getAssetLoader: () => assetLoader,
    requestRender,
    installProxyEffects: () => {},
    disposeObject3D: () => {},
    getOrthographicCamera: () => undefined,
  });

  return { registry, assetLoader, requestRender };
}

/** Let the resource read + the frame texture load settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function materialOf(visualRoot: THREE.Group): THREE.MeshBasicMaterial {
  const mesh = visualRoot.userData.spriteMesh as THREE.Mesh;
  return mesh.material as THREE.MeshBasicMaterial;
}

describe('Viewport2DProxyRegistry — AnimatedSprite2D frame textures (§9.10)', () => {
  it('draws the selected frame of a clip whose frames are separate files', async () => {
    const { registry, assetLoader, requestRender } = createRegistry(sequenceResource());
    seedTexture(assetLoader, FRAME_1, 32);
    seedTexture(assetLoader, FRAME_2, 32);

    const node = new AnimatedSprite2D({
      id: 'animated-sequence',
      animationResourcePath: RESOURCE_PATH,
      currentClip: 'walk',
    });
    const visualRoot = registry.createAnimatedSprite2DVisual(node);
    registry.animatedSprite2DVisuals.set(node.nodeId, visualRoot);
    await settle();

    expect(visualRoot.userData.animationTexturePath).toBe(FRAME_1);
    const material = materialOf(visualRoot);
    expect(material.map?.name).toBe(FRAME_1);
    // A sequence frame is the whole file — no sheet sub-rect.
    expect(material.map?.repeat.toArray()).toEqual([1, 1]);
    expect(requestRender).toHaveBeenCalled();
  });

  it('swaps the texture when the frame index changes', async () => {
    const { registry, assetLoader } = createRegistry(sequenceResource());
    seedTexture(assetLoader, FRAME_1, 32);
    seedTexture(assetLoader, FRAME_2, 32);

    const node = new AnimatedSprite2D({
      id: 'animated-frame-swap',
      animationResourcePath: RESOURCE_PATH,
      currentClip: 'walk',
    });
    const visualRoot = registry.createAnimatedSprite2DVisual(node);
    registry.animatedSprite2DVisuals.set(node.nodeId, visualRoot);
    await settle();
    expect(visualRoot.userData.animationTexturePath).toBe(FRAME_1);

    node.currentFrame = 1;
    registry.syncAnimatedSprite2DVisual(node, visualRoot);
    await settle();

    expect(visualRoot.userData.animationTexturePath).toBe(FRAME_2);
    expect(materialOf(visualRoot).map?.name).toBe(FRAME_2);
  });

  it('still uses the resource-level spritesheet when frames carry no file', async () => {
    const { registry, assetLoader } = createRegistry(sheetResource());
    seedTexture(assetLoader, SHEET, 64);

    const node = new AnimatedSprite2D({
      id: 'animated-sheet',
      animationResourcePath: RESOURCE_PATH,
      currentClip: 'walk',
      currentFrame: 1,
    });
    const visualRoot = registry.createAnimatedSprite2DVisual(node);
    registry.animatedSprite2DVisuals.set(node.nodeId, visualRoot);
    await settle();

    expect(visualRoot.userData.animationTexturePath).toBe(SHEET);
    const map = materialOf(visualRoot).map;
    expect(map?.name).toBe(SHEET);
    // The sheet frame's UV window still reaches the texture.
    expect(map?.offset.toArray()).toEqual([0.5, 0]);
    expect(map?.repeat.toArray()).toEqual([0.5, 1]);
  });

  it('reloads a per-frame texture whose pixels were rewritten on disk', async () => {
    const { registry, assetLoader, requestRender } = createRegistry(sequenceResource());
    seedTexture(assetLoader, FRAME_1, 32);
    seedTexture(assetLoader, FRAME_2, 32);

    const node = new AnimatedSprite2D({
      id: 'animated-invalidate',
      animationResourcePath: RESOURCE_PATH,
      currentClip: 'walk',
    });
    const visualRoot = registry.createAnimatedSprite2DVisual(node);
    registry.animatedSprite2DVisuals.set(node.nodeId, visualRoot);
    await settle();

    // The write-back fan-out: evict the shared decode, then tell the viewport.
    assetLoader.evictTexture(FRAME_1);
    const rewritten = seedTexture(assetLoader, FRAME_1, 48);
    rewritten.name = `${FRAME_1}#v2`;

    expect(registry.invalidateTexture(FRAME_1)).toEqual([node.nodeId]);
    expect(visualRoot.userData.animationTexturePath).toBeNull();

    requestRender.mockClear();
    registry.syncAnimatedSprite2DVisual(node, visualRoot);
    await settle();

    expect(visualRoot.userData.animationTexturePath).toBe(FRAME_1);
    expect(materialOf(visualRoot).map?.name).toBe(`${FRAME_1}#v2`);
    expect(requestRender).toHaveBeenCalled();
  });
});
