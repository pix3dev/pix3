import {
  Box3,
  Group,
  LinearFilter,
  MathUtils,
  PerspectiveCamera,
  Texture,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

const DEFAULT_FRAME_FILL_RATIO = 0.85;
const TEXTURE_KEYS = [
  'alphaMap',
  'anisotropyMap',
  'aoMap',
  'bumpMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'displacementMap',
  'emissiveMap',
  'gradientMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'lightMap',
  'map',
  'matcap',
  'metalnessMap',
  'normalMap',
  'roughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularColorMap',
  'specularIntensityMap',
  'thicknessMap',
  'transmissionMap',
] as const;

interface MutableGltfJson {
  buffers?: Array<{ uri?: string }>;
  images?: Array<{ uri?: string }>;
}

export interface LoadGltfFromBlobOptions {
  blob: Blob;
  sourcePath?: string;
  readBlob?: (path: string) => Promise<Blob>;
  loader?: GLTFLoader;
}

export interface LoadGltfFromBlobResult {
  gltf: GLTF;
  cleanup: () => void;
}

export async function loadGltfFromBlob(
  options: LoadGltfFromBlobOptions
): Promise<LoadGltfFromBlobResult> {
  const loader = options.loader ?? new GLTFLoader();
  const cleanupTasks: Array<() => void> = [];

  try {
    const extension = resolveExtension(options.blob, options.sourcePath);
    if (extension === 'gltf') {
      const text = await options.blob.text();
      const json = JSON.parse(text) as MutableGltfJson;
      cleanupTasks.push(
        ...(await materializeExternalUris(json, options.sourcePath, options.readBlob))
      );

      const gltf = await new Promise<GLTF>((resolve, reject) => {
        loader.parse(
          JSON.stringify(json),
          '',
          result => resolve(result as GLTF),
          error => reject(error)
        );
      });

      configurePreviewTextures(gltf.scene);

      return {
        gltf,
        cleanup: () => {
          for (const cleanup of cleanupTasks) {
            cleanup();
          }
        },
      };
    }

    const arrayBuffer = await options.blob.arrayBuffer();
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(
        arrayBuffer,
        '',
        result => resolve(result as GLTF),
        error => reject(error)
      );
    });

    configurePreviewTextures(gltf.scene);

    return {
      gltf,
      cleanup: () => undefined,
    };
  } catch (error) {
    for (const cleanup of cleanupTasks) {
      cleanup();
    }
    throw error;
  }
}

/**
 * Disable mipmaps on every texture of a freshly loaded preview model.
 *
 * On some ANGLE/D3D11 backends a mipmapped texture's higher mip levels upload
 * corrupt (black), so a face that samples a high mip — the top of a cube at a
 * grazing angle, or anything once the camera zooms out — renders black. The
 * preview/thumbnail renderers orbit and zoom freely (and run at small sizes, so
 * high mips are picked constantly), which makes the artifact obvious. Previews
 * gain nothing from mipmaps, so dropping them + a linear filter removes the black
 * at no visual cost. Mirrors the runtime's configure2DTexture() and the DeepCore
 * block-texture fix (configureBlockColorTexture).
 */
function configurePreviewTextures(root: Object3D): void {
  root.traverse(object => {
    const material = (object as Object3D & { material?: Material | Material[] }).material;
    if (!material) {
      return;
    }

    const materials = Array.isArray(material) ? material : [material];
    for (const entry of materials) {
      const materialRecord = entry as Material & Record<string, unknown>;
      for (const key of TEXTURE_KEYS) {
        const texture = materialRecord[key];
        if (texture instanceof Texture && texture.generateMipmaps) {
          texture.generateMipmaps = false;
          texture.minFilter = LinearFilter;
          texture.needsUpdate = true;
        }
      }
    }
  });
}

export function createCenteredPreviewRoot(modelRoot: Object3D): Group {
  const wrapper = new Group();
  wrapper.add(modelRoot);
  wrapper.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(wrapper);
  const center = bounds.getCenter(bounds.min.clone());
  modelRoot.position.sub(center);
  wrapper.updateMatrixWorld(true);

  return wrapper;
}

export function framePerspectiveCameraToObject(
  camera: PerspectiveCamera,
  target: Object3D,
  fillRatio: number = DEFAULT_FRAME_FILL_RATIO
): { focusTargetY: number; distance: number } {
  const bounds = new Box3().setFromObject(target);
  const size = bounds.getSize(bounds.min.clone());
  const maxSize = Math.max(size.x, size.y, size.z, 0.25);
  const verticalFov = MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const distanceForHeight = size.y / (2 * Math.tan(verticalFov / 2) * fillRatio);
  const distanceForWidth = size.x / (2 * Math.tan(horizontalFov / 2) * fillRatio);
  const distance = Math.max(distanceForHeight, distanceForWidth, maxSize * 1.35) + size.z * 0.35;
  const focusTargetY = size.y * 0.06;

  camera.position.set(distance * 0.72, distance * 0.42 + focusTargetY, distance * 0.96);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = Math.max(distance * 12, 10);
  camera.lookAt(0, focusTargetY, 0);
  camera.updateProjectionMatrix();

  return { focusTargetY, distance };
}

export function disposeObject3DResources(root: Object3D): void {
  root.traverse(object => {
    const objectWithGeometry = object as Object3D & {
      geometry?: { dispose: () => void };
      material?: Material | Material[];
      skeleton?: { dispose?: () => void };
    };

    objectWithGeometry.geometry?.dispose();

    if (Array.isArray(objectWithGeometry.material)) {
      for (const material of objectWithGeometry.material) {
        disposeMaterial(material);
      }
    } else if (objectWithGeometry.material) {
      disposeMaterial(objectWithGeometry.material);
    }

    objectWithGeometry.skeleton?.dispose?.();
  });

  root.clear();
}

async function materializeExternalUris(
  json: MutableGltfJson,
  sourcePath: string | undefined,
  readBlob: LoadGltfFromBlobOptions['readBlob']
): Promise<Array<() => void>> {
  const cleanupTasks: Array<() => void> = [];
  const baseDirectory = sourcePath ? getParentPath(sourcePath) : null;
  const targets = [...(json.buffers ?? []), ...(json.images ?? [])];

  if (!baseDirectory || !readBlob) {
    return cleanupTasks;
  }

  for (const target of targets) {
    if (!target.uri || !shouldResolveExternalUri(target.uri)) {
      continue;
    }

    const resourcePath = joinAssetPath(baseDirectory, target.uri);
    const resourceBlob = await readBlob(resourcePath);
    const objectUrl = URL.createObjectURL(resourceBlob);
    target.uri = objectUrl;
    cleanupTasks.push(() => URL.revokeObjectURL(objectUrl));
  }

  return cleanupTasks;
}

function disposeMaterial(material: Material): void {
  const materialRecord = material as Material & Record<string, unknown>;
  const disposedTextures = new Set<Texture>();

  for (const key of TEXTURE_KEYS) {
    const texture = materialRecord[key];
    if (texture instanceof Texture && !disposedTextures.has(texture)) {
      texture.dispose();
      disposedTextures.add(texture);
    }
  }

  material.dispose();
}

function resolveExtension(blob: Blob, sourcePath?: string): string {
  const fileName = blob instanceof File ? blob.name : '';
  const source = (sourcePath ?? fileName).toLowerCase();
  const match = source.match(/\.([a-z0-9]+)$/i);
  return match ? match[1] : 'glb';
}

function shouldResolveExternalUri(uri: string): boolean {
  return !/^(data:|blob:|https?:)/i.test(uri);
}

function getParentPath(path: string): string | null {
  const { prefix, segments } = normalizeAssetPath(path);
  if (segments.length === 0) {
    return prefix ? `${prefix}.` : '.';
  }

  return `${prefix}${segments.slice(0, -1).join('/') || '.'}`;
}

function joinAssetPath(basePath: string, relativePath: string): string {
  if (/^(data:|blob:|https?:|res:\/\/)/i.test(relativePath)) {
    return relativePath;
  }

  const { prefix, segments: baseSegments } = normalizeAssetPath(basePath);
  const { segments: relativeSegments } = normalizeAssetPath(relativePath);
  const combinedSegments = [...baseSegments];

  for (const segment of relativeSegments) {
    if (segment === '..') {
      combinedSegments.pop();
      continue;
    }

    if (segment !== '.') {
      combinedSegments.push(segment);
    }
  }

  return `${prefix}${combinedSegments.join('/')}`;
}

function normalizeAssetPath(path: string): { prefix: string; segments: string[] } {
  const trimmed = path.replace(/\\+/g, '/').trim();
  const prefix = trimmed.startsWith('res://') ? 'res://' : '';
  const withoutPrefix = prefix ? trimmed.slice(prefix.length) : trimmed;
  const segments = withoutPrefix
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(segment => segment.length > 0);

  return { prefix, segments };
}
