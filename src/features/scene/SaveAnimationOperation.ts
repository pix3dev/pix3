import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { getAppStateSnapshot } from '@/state';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { serializeAnimationResource } from './animation-asset-utils';

export interface SaveAnimationOperationParams {
  animationId?: string;
}

export class SaveAnimationOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'animation.save',
    title: 'Save Animation',
    description: 'Save the active animation asset to its current file',
  };

  constructor(private readonly params: SaveAnimationOperationParams = {}) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state } = context;
    const animationId = this.params.animationId ?? state.animations.activeAnimationId;
    if (!animationId) {
      throw new Error('No active animation to save');
    }

    const descriptor = state.animations.descriptors[animationId];
    if (!descriptor) {
      throw new Error(`Animation descriptor not found: ${animationId}`);
    }

    const resource = state.animations.resources[animationId];
    if (!resource) {
      throw new Error(`Animation resource not found: ${animationId}`);
    }

    const filePath = descriptor.filePath;
    if (!filePath?.startsWith('res://')) {
      throw new Error(`Animation must be saved within the project. (filePath: ${filePath})`);
    }

    const storage = context.container.getService<ProjectStorageService>(
      context.container.getOrCreateToken(ProjectStorageService)
    );
    const logger = context.container.getService<LoggingService>(
      context.container.getOrCreateToken(LoggingService)
    );

    logger.info('Saving animation asset...');

    const nextText = serializeAnimationResource(resource);
    await storage.writeTextFile(filePath, nextText);

    logger.info(`✓ Animation asset saved: ${descriptor.name || filePath}`);

    const beforeSnapshot = context.snapshot;

    descriptor.isDirty = false;
    descriptor.lastSavedAt = Date.now();
    descriptor.version = resource.version;

    try {
      descriptor.lastModifiedTime = await storage.getLastModified(filePath);
    } catch {
      // ignore best-effort metadata refresh failures
    }

    const lastSlashIndex = filePath.lastIndexOf('/');
    const directoryPath = lastSlashIndex > 0 ? filePath.substring(0, lastSlashIndex) : '.';
    state.project.lastModifiedDirectoryPath = directoryPath;
    state.project.fileRefreshSignal = (state.project.fileRefreshSignal || 0) + 1;

    const afterSnapshot = getAppStateSnapshot();

    return {
      didMutate: true,
      commit: {
        label: `Save animation: ${filePath}`,
        beforeSnapshot,
        afterSnapshot,
        undo: () => {
          const beforeDescriptor = beforeSnapshot.animations.descriptors[animationId];
          const liveDescriptor = state.animations.descriptors[animationId];
          if (beforeDescriptor && liveDescriptor) {
            liveDescriptor.isDirty = beforeDescriptor.isDirty;
            liveDescriptor.lastSavedAt = beforeDescriptor.lastSavedAt;
            liveDescriptor.lastModifiedTime = beforeDescriptor.lastModifiedTime;
            liveDescriptor.version = beforeDescriptor.version;
          }
        },
        redo: () => {
          const afterDescriptor = afterSnapshot.animations.descriptors[animationId];
          const liveDescriptor = state.animations.descriptors[animationId];
          if (afterDescriptor && liveDescriptor) {
            liveDescriptor.isDirty = afterDescriptor.isDirty;
            liveDescriptor.lastSavedAt = afterDescriptor.lastSavedAt;
            liveDescriptor.lastModifiedTime = afterDescriptor.lastModifiedTime;
            liveDescriptor.version = afterDescriptor.version;
          }
        },
      },
    };
  }
}
