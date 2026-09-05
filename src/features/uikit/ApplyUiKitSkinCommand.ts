import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { SceneManager } from '@pix3/runtime';
import type { PaletteId } from '@/services/uikit';
import { UiKitProjectWriter, type KitManifest } from '@/services/uikit-editor/UiKitProjectWriter';
import { ApplyUiKitSkinOperation } from '@/features/uikit/ApplyUiKitSkinOperation';

export interface ApplyUiKitSkinCommandParams {
  /** Defaults to the current selection. */
  nodeIds?: readonly string[];
  /** Defaults to `blue` — the kit's neutral interactive role. */
  colorRole?: PaletteId;
  /** Skip the `design/ui-kit.json` read (the panel already has the manifest in hand). */
  manifest?: KitManifest;
}

export const DEFAULT_UIKIT_COLOR_ROLE: PaletteId = 'blue';

/**
 * Dress the selected UI nodes in the project's baked UI kit.
 *
 * Registered under a `properties.` id on purpose: that is one of the prefixes the agent's
 * `run_command` accepts (`AgentToolRegistry`'s allow-list), so the agent can skin a selection
 * without a bespoke tool, and what it does — write texture and nine-slice properties through
 * `UpdateObjectPropertyOperation` — is a property edit, not a scene-structure change.
 *
 * `run_command` passes no arguments, so the zero-argument form has to mean something useful:
 * current selection, `blue`, manifest read from `design/ui-kit.json`.
 */
export class ApplyUiKitSkinCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'properties.apply-uikit-skin',
    title: 'Apply UI Kit Skin',
    description:
      'Skin the selected Button2D / Checkbox2D / Slider2D / Bar2D / panel nodes from the project UI kit',
    keywords: [
      'uikit',
      'ui kit',
      'skin',
      'texture',
      'button',
      'panel',
      'slider',
      'bar',
      'nine-slice',
    ],
  };

  private readonly params: ApplyUiKitSkinCommandParams;

  constructor(params: ApplyUiKitSkinCommandParams = {}) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Open a project before applying a UI kit skin',
        scope: 'project',
        recoverable: true,
      };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    if (!sceneManager.getActiveSceneGraph()) {
      return {
        canExecute: false,
        reason: 'An active scene is required to apply a UI kit skin',
        scope: 'scene',
      };
    }

    const nodeIds = this.params.nodeIds ?? context.state.selection.nodeIds;
    if (!nodeIds.length) {
      return {
        canExecute: false,
        reason: 'Select the nodes to skin',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const nodeIds = [...(this.params.nodeIds ?? context.state.selection.nodeIds)];
    if (!nodeIds.length) return { didMutate: false, payload: undefined };

    const writer = context.container.getService<UiKitProjectWriter>(
      context.container.getOrCreateToken(UiKitProjectWriter)
    );
    const manifest = this.params.manifest ?? (await writer.readManifest());
    if (!manifest) {
      console.warn(
        '[ApplyUiKitSkinCommand] No design/ui-kit.json in this project — bake a kit from the UI Kit tab first.'
      );
      return { didMutate: false, payload: undefined };
    }

    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operations.invokeAndPush(
      new ApplyUiKitSkinOperation({
        nodeIds,
        colorRole: this.params.colorRole ?? DEFAULT_UIKIT_COLOR_ROLE,
        manifest,
      })
    );

    return { didMutate: pushed, payload: undefined };
  }
}
