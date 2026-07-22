import { injectable, inject } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { AddModelCommand } from '@/features/scene/AddModelCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { SceneManager } from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { isCodeDocumentExtension } from '@/services/scripting/CodeDocumentService';

export interface AssetActivation {
  name: string;
  path: string;
  kind: FileSystemHandleKind;
  resourcePath: string | null;
  extension: string; // lowercase without dot
}

/**
 * AssetFileActivationService handles opening asset files from the project tree.
 * It dispatches appropriate commands based on file type (e.g., LoadSceneCommand for .pix3scene files).
 */
export class AssetFileActivationService {
  // Raster image formats the Sprite Editor can open/edit. (Previously listed 'webm'/'aif' — a
  // video and an audio extension — which were bugs; the real intent is the web image set.)
  static readonly SUPPORTED_IMAGE_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'svg',
    'tif',
    'tiff',
    'avif',
  ]);
  private static readonly UI_LAYER_NAME = 'UI Layer';

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  /**
   * Handle activation of an asset file from the project tree.
   * @param payload File activation details including extension and resource path
   */
  async handleActivation(payload: AssetActivation): Promise<void> {
    const { extension, resourcePath, name } = payload;
    if (!resourcePath) return;

    if (AssetFileActivationService.SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      await this.handleImageAsset(payload);
      return;
    }

    if (extension === 'pix3scene') {
      await this.editorTabService.focusOrOpenScene(resourcePath);
      return;
    }

    if (extension === 'pix3anim') {
      await this.editorTabService.focusOrOpenAnimation(resourcePath);
      return;
    }

    if (extension === 'glb' || extension === 'gltf') {
      const command = new AddModelCommand({ modelPath: resourcePath, modelName: name });
      await this.commandDispatcher.execute(command);
      return;
    }

    // Text-editable files (scripts, JSON, markdown, config, plain text, …) open
    // in the built-in Monaco editor. CodeDocumentService owns the supported set.
    if (isCodeDocumentExtension(extension)) {
      await this.editorTabService.focusOrOpenCode(resourcePath);
      return;
    }

    // TODO: other asset types (images -> Sprite2D, audio, prefabs, etc.)
    console.info('[AssetFileActivationService] No handler for asset type', payload);
  }

  /**
   * Double-clicking an image asset opens it in the Sprite Editor (edit/generate), matching how
   * scenes, animations and code files open on activation. Creating a Sprite2D node from an image is
   * an explicit action instead — drag the asset into the viewport/tree, or the asset context menu's
   * "Add to Scene as Sprite2D" (see {@link createSpriteFromImage}).
   */
  private async handleImageAsset(payload: AssetActivation): Promise<void> {
    await this.editorTabService.focusOrOpenSpriteEditor(payload.resourcePath ?? undefined);
  }

  /**
   * Create a Sprite2D node in the active scene from an image asset. This is the explicit
   * (context-menu / drag) path — it is deliberately no longer the double-click default.
   */
  async createSpriteFromImage(payload: AssetActivation): Promise<void> {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      console.warn(
        '[AssetFileActivationService] Cannot create sprite without an active scene',
        payload
      );
      return;
    }

    const uiLayer = this.findUiLayer(sceneGraph);
    if (!uiLayer) {
      console.info(
        '[AssetFileActivationService] UI layer missing, sprite will be added to root',
        payload
      );
    }

    const command = new CreateSprite2DCommand({
      spriteName: this.deriveSpriteName(payload.name),
      texturePath: payload.resourcePath,
      parentNodeId: uiLayer?.nodeId ?? null,
    });

    await this.commandDispatcher.execute(command);
  }

  private findUiLayer(sceneGraph: SceneGraph) {
    return sceneGraph.rootNodes.find(
      node => node.type === 'Group2D' && node.name === AssetFileActivationService.UI_LAYER_NAME
    );
  }

  private deriveSpriteName(fileName: string): string {
    const stripped = fileName.replace(/\.[^./]+$/, '').trim();
    return stripped || 'Sprite2D';
  }
}

injectable()(AssetFileActivationService);
