import { inject } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import {
  deriveAnimationAssetStem,
  deriveAnimationDocumentId,
  normalizeAnimationAssetPath,
  parseAnimationResourceText,
} from './animation-asset-utils';

export interface LoadAnimationCommandPayload {
  filePath: string;
  animationId?: string;
}

export class LoadAnimationCommand extends CommandBase<LoadAnimationCommandPayload, void> {
  readonly metadata: CommandMetadata = {
    id: 'animation.load',
    title: 'Load Animation',
    description: 'Load an animation asset into the editor',
    keywords: ['load', 'animation', 'open'],
  };

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private payload?: LoadAnimationCommandPayload;

  constructor(payload?: LoadAnimationCommandPayload) {
    super();
    this.payload = payload;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before loading animations',
        scope: 'project',
        recoverable: true,
      };
    }

    if (!this.payload?.filePath) {
      return {
        canExecute: false,
        reason: 'File path is required to load an animation',
        scope: 'service',
      };
    }

    return { canExecute: true };
  }

  async execute(
    context: CommandContext
  ): Promise<CommandExecutionResult<LoadAnimationCommandPayload>> {
    if (!this.payload) {
      throw new Error('LoadAnimationCommand requires payload with filePath');
    }

    const { state } = context;
    const filePath = normalizeAnimationAssetPath(this.payload.filePath);
    const animationId = this.payload.animationId ?? deriveAnimationDocumentId(filePath);

    state.animations.loadState = 'loading';
    state.animations.loadError = null;

    try {
      const source = await this.storage.readTextFile(filePath);
      const resource = parseAnimationResourceText(source);
      const existingDescriptor = state.animations.descriptors[animationId] ?? null;

      let lastModifiedTime: number | null = null;
      try {
        if (filePath.startsWith('res://')) {
          lastModifiedTime = await this.storage.getLastModified(filePath);
        }
      } catch {
        // ignore best-effort metadata refresh failures
      }

      state.animations.descriptors[animationId] = {
        id: animationId,
        filePath,
        name: this.deriveAnimationName(filePath, existingDescriptor?.name),
        version: resource.version,
        isDirty: false,
        lastSavedAt: existingDescriptor?.lastSavedAt ?? null,
        lastModifiedTime,
      };
      state.animations.resources[animationId] = resource;
      state.animations.activeAnimationId = animationId;
      state.animations.loadState = 'ready';
      state.animations.lastLoadedAt = Date.now();

      return {
        didMutate: true,
        payload: {
          filePath,
          animationId,
        },
      };
    } catch (error) {
      let message = 'Failed to load animation asset.';
      if (error instanceof Error) {
        message = `${message} ${error.message}`;
      }

      state.animations.loadState = 'error';
      state.animations.loadError = message;
      throw error;
    }
  }

  private deriveAnimationName(filePath: string, existingName?: string | null): string {
    const preserved = typeof existingName === 'string' ? existingName.trim() : '';
    if (preserved) {
      return preserved;
    }

    return deriveAnimationAssetStem(filePath);
  }
}
