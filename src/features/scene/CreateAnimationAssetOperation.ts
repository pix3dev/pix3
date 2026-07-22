import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { getAppStateSnapshot } from '@/state';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { AnimationResource } from '@pix3/runtime';
import {
  createDefaultAnimationResource,
  getAssetParentDirectory,
  normalizeAnimationAssetPath,
  serializeAnimationResource,
} from './animation-asset-utils';

export interface CreateAnimationAssetOperationParams {
  assetPath: string;
  texturePath: string;
  initialClipName?: string;
  resource?: AnimationResource;
  overwrite?: boolean;
}

export class CreateAnimationAssetOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'assets.create-animation-asset',
    title: 'Create Animation Asset',
    description: 'Create a .pix3anim animation metadata asset',
    tags: ['asset', 'animation'],
  };

  constructor(private readonly params: CreateAnimationAssetOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const storage = context.container.getService<ProjectStorageService>(
      context.container.getOrCreateToken(ProjectStorageService)
    );

    const assetPath = normalizeAnimationAssetPath(this.params.assetPath);
    const parentDirectory = getAssetParentDirectory(assetPath);
    const previousText = await this.tryReadText(storage, assetPath);
    if (previousText !== null && !this.params.overwrite) {
      return { didMutate: false };
    }

    const resource =
      this.params.resource ??
      createDefaultAnimationResource(this.params.texturePath, this.params.initialClipName);
    const nextText = serializeAnimationResource(resource);

    if (parentDirectory !== '.') {
      await storage.createDirectory(parentDirectory);
    }
    await storage.writeTextFile(assetPath, nextText);

    const beforeSnapshot = context.snapshot;
    const afterSnapshot = getAppStateSnapshot();

    return {
      didMutate: true,
      commit: {
        label: `Create animation asset: ${assetPath}`,
        beforeSnapshot,
        afterSnapshot,
        undo: async () => {
          if (previousText === null) {
            await storage.deleteEntry(parentDirectory !== '.' ? parentDirectory : assetPath);
            return;
          }

          if (parentDirectory !== '.') {
            await storage.createDirectory(parentDirectory);
          }
          await storage.writeTextFile(assetPath, previousText);
        },
        redo: async () => {
          if (parentDirectory !== '.') {
            await storage.createDirectory(parentDirectory);
          }
          await storage.writeTextFile(assetPath, nextText);
        },
      },
    };
  }

  private async tryReadText(
    storage: ProjectStorageService,
    assetPath: string
  ): Promise<string | null> {
    try {
      return await storage.readTextFile(assetPath);
    } catch {
      return null;
    }
  }
}
