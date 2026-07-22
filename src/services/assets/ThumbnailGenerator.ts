import { ServiceContainer, injectable } from '@/fw/di';
import { resolveFileSystemAPIService } from '@/services/project/FileSystemAPIService';
import {
  createCenteredPreviewRoot,
  disposeObject3DResources,
  framePerspectiveCameraToObject,
  loadGltfFromBlob,
} from '@/services/assets/GltfBlobLoader';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const THUMBNAIL_SIZE = 256;

interface ThumbnailPipeline {
  canvas: HTMLCanvasElement;
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  previewRoot: Group;
}

@injectable()
export class ThumbnailGenerator {
  private readonly fileSystemService = resolveFileSystemAPIService();
  private pipeline: ThumbnailPipeline | null = null;

  public generate(blob: Blob): Promise<string>;
  public generate(blob: Blob, filePath: string): Promise<string>;
  public async generate(blob: Blob, filePath?: string): Promise<string> {
    const pipeline = this.ensurePipeline();
    const loader = new GLTFLoader();
    const { gltf, cleanup } = await loadGltfFromBlob({
      blob,
      sourcePath: filePath,
      readBlob: path => this.fileSystemService.readBlob(path),
      loader,
    });
    const framedRoot = createCenteredPreviewRoot(gltf.scene);

    try {
      pipeline.previewRoot.add(framedRoot);
      pipeline.previewRoot.updateMatrixWorld(true);
      framePerspectiveCameraToObject(pipeline.camera, framedRoot);

      await this.yieldToBrowser();

      pipeline.renderer.clear();
      pipeline.renderer.render(pipeline.scene, pipeline.camera);

      return await this.exportCanvas(pipeline.canvas);
    } finally {
      pipeline.previewRoot.remove(framedRoot);
      cleanup();
      disposeObject3DResources(framedRoot);
      pipeline.renderer.renderLists.dispose();
    }
  }

  public dispose(): void {
    if (!this.pipeline) {
      return;
    }

    this.pipeline.previewRoot.clear();
    this.pipeline.renderer.dispose();
    this.pipeline.renderer.forceContextLoss();
    this.pipeline = null;
  }

  private ensurePipeline(): ThumbnailPipeline {
    if (this.pipeline) {
      return this.pipeline;
    }

    if (typeof document === 'undefined') {
      throw new Error('Thumbnail generation requires a browser document context.');
    }

    const canvas = document.createElement('canvas');
    const renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;

    const scene = new Scene();
    const camera = new PerspectiveCamera(35, 1, 0.01, 1000);
    const previewRoot = new Group();

    scene.add(previewRoot);
    scene.add(new AmbientLight(0xffffff, 0.55));

    const hemisphereLight = new HemisphereLight(0xf7fbff, 0x2a3138, 1.1);
    hemisphereLight.position.set(0, 1, 0);
    scene.add(hemisphereLight);

    const keyLight = new DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(4, 7, 5);
    scene.add(keyLight);

    this.pipeline = {
      canvas,
      renderer,
      scene,
      camera,
      previewRoot,
    };

    return this.pipeline;
  }

  private async exportCanvas(canvas: HTMLCanvasElement): Promise<string> {
    if (canvas.toBlob) {
      const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/webp', 0.92);
      });

      if (blob) {
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              resolve(reader.result);
              return;
            }

            reject(new Error('Failed to serialize generated thumbnail.'));
          };
          reader.onerror = () =>
            reject(reader.error ?? new Error('Failed to read thumbnail blob.'));
          reader.readAsDataURL(blob);
        });
      }
    }

    return canvas.toDataURL('image/webp', 0.92);
  }

  private async yieldToBrowser(): Promise<void> {
    await new Promise<void>(resolve => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }

      setTimeout(resolve, 0);
    });
  }
}

export function resolveThumbnailGenerator(): ThumbnailGenerator {
  const container = ServiceContainer.getInstance();
  return container.getService<ThumbnailGenerator>(container.getOrCreateToken(ThumbnailGenerator));
}
