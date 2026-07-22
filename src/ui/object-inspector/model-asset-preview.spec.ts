import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Group, PerspectiveCamera, Vector3 } from 'three';

const mockProjectStorageService = {
  readBlob: vi.fn(),
};

const mockCreateCenteredPreviewRoot = vi.fn(() => new Group());
const mockDisposeObject3DResources = vi.fn();
const mockFramePerspectiveCameraToObject = vi.fn(() => ({ focusTargetY: 0, distance: 1 }));
const mockLoadGltfFromBlob = vi.fn();

vi.mock('@/services/project/ProjectStorageService', () => ({
  ProjectStorageService: class ProjectStorageService {},
  resolveProjectStorageService: () => mockProjectStorageService,
}));

vi.mock('@/services/assets/GltfBlobLoader', () => ({
  createCenteredPreviewRoot: mockCreateCenteredPreviewRoot,
  disposeObject3DResources: mockDisposeObject3DResources,
  framePerspectiveCameraToObject: mockFramePerspectiveCameraToObject,
  loadGltfFromBlob: mockLoadGltfFromBlob,
}));

const { ModelAssetPreview } = await import('./model-asset-preview');

describe('ModelAssetPreview', () => {
  beforeEach(() => {
    mockProjectStorageService.readBlob.mockReset();
    mockCreateCenteredPreviewRoot.mockClear();
    mockDisposeObject3DResources.mockClear();
    mockFramePerspectiveCameraToObject.mockClear();
    mockLoadGltfFromBlob.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('loads GLTF previews through project storage for project resources', async () => {
    const rootBlob = new Blob(['root'], { type: 'model/gltf+json' });
    const nestedBlob = new Blob(['nested'], { type: 'application/octet-stream' });

    mockProjectStorageService.readBlob.mockImplementation(async (path: string) => {
      if (path === 'res://assets/models/crate.gltf') {
        return rootBlob;
      }

      if (path === 'res://assets/models/crate.bin') {
        return nestedBlob;
      }

      throw new Error(`Unexpected blob path: ${path}`);
    });

    mockLoadGltfFromBlob.mockImplementation(
      async (options: {
        blob: Blob;
        sourcePath?: string;
        readBlob?: (path: string) => Promise<Blob>;
      }) => {
        expect(options.blob).toBe(rootBlob);
        expect(options.sourcePath).toBe('res://assets/models/crate.gltf');
        await options.readBlob?.('res://assets/models/crate.bin');
        return {
          gltf: { scene: new Group() },
          cleanup: vi.fn(),
        };
      }
    );

    const preview = new ModelAssetPreview() as unknown as {
      renderer: object;
      camera: PerspectiveCamera;
      previewRoot: Group;
      controls: { target: Vector3; update: ReturnType<typeof vi.fn> };
      resourcePath: string;
      loadModel: () => Promise<void>;
      previewState: string;
    };

    preview.renderer = {};
    preview.camera = new PerspectiveCamera(35, 1, 0.01, 1000);
    preview.previewRoot = new Group();
    preview.controls = { target: new Vector3(), update: vi.fn() };
    preview.resourcePath = 'res://assets/models/crate.gltf';

    await preview.loadModel();

    expect(mockProjectStorageService.readBlob).toHaveBeenNthCalledWith(
      1,
      'res://assets/models/crate.gltf'
    );
    expect(mockProjectStorageService.readBlob).toHaveBeenNthCalledWith(
      2,
      'res://assets/models/crate.bin'
    );
    expect(preview.previewState).toBe('ready');
  });
});
