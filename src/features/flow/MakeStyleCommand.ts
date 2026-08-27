import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { REFERENCES_DIR } from '@/services/flow/FlowReferencesService';
import { MakeStyleOperation } from './MakeStyleOperation';

export interface MakeStyleCommandParams {
  /** Project-relative path under `references/`. */
  readonly path: string;
}

/** Images only: a palette is measured from pixels, and a `.txt` has none. */
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

/**
 * Adopt one reference image as the project's visual style (design §3.9).
 *
 * Goes through the mutation gateway rather than calling the service directly because it writes
 * three things at once — the picture's role, `design/style.md`, and a line in the decision log —
 * and a user who changes their mind after clicking the wrong candidate needs all three to come back
 * together. Same reasoning as `DeleteReferenceCommand`, minus the confirmation: adopting a style is
 * cheap to reverse, so it does not stop to ask.
 *
 * SVG is excluded along with the non-images: `extractPalette` reads pixels through a canvas, and a
 * vector reference would come back with an empty palette and a style document that says nothing.
 */
export class MakeStyleCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'flow.make-style',
    title: 'Make It the Style',
    description: 'Adopt a reference image as the project style',
    keywords: ['flow', 'reference', 'style', 'moodboard', 'palette'],
  };

  constructor(private readonly params: MakeStyleCommandParams) {
    super();
  }

  async preconditions(context: CommandContext): Promise<CommandPreconditionResult> {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'A project must be open to choose a style.',
        scope: 'project',
      };
    }
    if (!this.params.path.startsWith(`${REFERENCES_DIR}/`)) {
      return {
        canExecute: false,
        reason: `Only files under ${REFERENCES_DIR}/ can become the project style.`,
        scope: 'project',
      };
    }
    if (!IMAGE_EXTENSION.test(this.params.path)) {
      return {
        canExecute: false,
        reason: 'Only a raster image can become the style — its palette is measured from pixels.',
        scope: 'project',
      };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operations.invokeAndPush(
      new MakeStyleOperation({ path: this.params.path })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
