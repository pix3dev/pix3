import { inject } from '@/fw/di';
import { AnimatedSprite2D, SceneManager, Sprite2D, type NodeBase } from '@pix3/runtime';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';

export interface OpenSpriteEditorForNodeCommandPayload {
  /** Resource the editor was opened on, or `null` when the node had nothing bound. */
  resourcePath: string | null;
}

/**
 * Open the sprite editor for a scene node — the "double-click the object" entry
 * point (viewport, scene tree, inspector). `AnimatedSprite2D` resolves to its
 * `.pix3anim`, `Sprite2D` to its texture; a node with nothing bound opens the
 * empty editor so the user can generate or import something for it.
 *
 * Opening an editor is not an undoable state change → `didMutate: false`.
 */
export class OpenSpriteEditorForNodeCommand extends CommandBase<
  OpenSpriteEditorForNodeCommandPayload,
  void
> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-sprite-editor-for-node',
    title: 'Edit Sprite',
    description: 'Open the sprite editor for the selected sprite node',
    keywords: ['sprite', 'edit', 'animation', 'texture', 'node', 'open'],
  };

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  constructor(private readonly params: { nodeId: string }) {
    super();
  }

  async execute(): Promise<CommandExecutionResult<OpenSpriteEditorForNodeCommandPayload>> {
    const node = this.findNode(this.params.nodeId);

    if (node instanceof AnimatedSprite2D) {
      const resourcePath = node.animationResourcePath?.trim() ?? '';
      if (resourcePath) {
        await this.editorTabService.focusOrOpenAnimation(resourcePath);
        return { didMutate: false, payload: { resourcePath } };
      }
      // No animation bound yet: the empty sprite editor is where the user makes
      // one (generate/import an image, then "Create animation").
      await this.editorTabService.focusOrOpenSpriteEditor();
      return { didMutate: false, payload: { resourcePath: null } };
    }

    if (node instanceof Sprite2D) {
      const texturePath = node.getEffectiveTexturePath?.() || node.texture?.url || '';
      await this.editorTabService.focusOrOpenSpriteEditor(texturePath || undefined);
      return { didMutate: false, payload: { resourcePath: texturePath || null } };
    }

    return { didMutate: false, payload: { resourcePath: null } };
  }

  private findNode(nodeId: string): NodeBase | null {
    if (!nodeId) {
      return null;
    }
    return this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId) ?? null;
  }
}

/** True when the sprite editor has something meaningful to show for this node. */
export function isSpriteEditableNode(node: NodeBase | null | undefined): boolean {
  return node instanceof Sprite2D || node instanceof AnimatedSprite2D;
}
