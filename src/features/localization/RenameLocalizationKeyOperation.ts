import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager, getNodePropertySchema } from '@pix3/runtime';
import {
  LocalizationEditorService,
  type LocaleTableSection,
} from '@/services/localization/LocalizationEditorService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

export interface RenameLocalizationKeyParams {
  oldKey: string;
  newKey: string;
  /** Table section the key lives in (default `'strings'`; `'sprites'` = localized texture paths). */
  section?: LocaleTableSection;
}

/** Node properties that can hold a localization key, per table section. */
const KEY_PROPERTIES: Record<LocaleTableSection, readonly string[]> = {
  strings: ['labelKey'],
  sprites: [
    'textureKey',
    'textureNormalKey',
    'textureHoverKey',
    'texturePressedKey',
    'textureDisabledKey',
  ],
};

/** A node property that referenced the renamed key (recorded for undo/redo). */
interface KeyReference {
  sceneId: string;
  nodeId: string;
  property: string;
}

/**
 * Rename a translation key across every locale table AND rewrite `labelKey` /
 * `textureKey`-family references in all open scenes (via the property schema, so
 * label/proxy refresh rides the setValue closures). Undo renames back and
 * restores the recorded references; scenes whose nodes were rewritten are marked
 * dirty. Closed scene files are NOT rewritten — reopen and rename again, or
 * rebind manually (the never-throw chain means a stale key just echoes itself).
 */
export class RenameLocalizationKeyOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'localization.rename-key',
    title: 'Rename Translation Key',
    description: 'Rename a key across locale tables and open scenes',
    tags: ['localization', 'editor'],
  };

  constructor(private readonly params: RenameLocalizationKeyParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const service = tryGetService(context, LocalizationEditorService);
    if (!service) return { didMutate: false };

    const { oldKey, newKey } = this.params;
    const section = this.params.section ?? 'strings';

    const moved = await service.renameKey(oldKey, newKey, section);
    if (moved === null) return { didMutate: false };

    const references = this.rewriteReferences(context, section, oldKey, newKey);
    this.refresh(context);

    return {
      didMutate: true,
      commit: {
        label: `Rename Key "${oldKey}" → "${newKey}"`,
        undo: async () => {
          await service.renameKey(newKey, oldKey, section);
          this.applyToReferences(context, references, oldKey);
          this.refresh(context);
        },
        redo: async () => {
          await service.renameKey(oldKey, newKey, section);
          this.applyToReferences(context, references, newKey);
          this.refresh(context);
        },
      },
    };
  }

  /** Scan every open scene graph for properties equal to `oldKey`; set them to `newKey`. */
  private rewriteReferences(
    context: OperationContext,
    section: LocaleTableSection,
    oldKey: string,
    newKey: string
  ): KeyReference[] {
    const sceneManager = tryGetService(context, SceneManager);
    if (!sceneManager) return [];
    const candidates = KEY_PROPERTIES[section];
    const references: KeyReference[] = [];

    for (const sceneId of Object.keys(context.state.scenes.descriptors)) {
      const graph = sceneManager.getSceneGraph(sceneId);
      if (!graph) continue;
      let sceneTouched = false;

      for (const node of graph.nodeMap.values()) {
        const schema = getNodePropertySchema(node);
        for (const prop of schema.properties) {
          if (!candidates.includes(prop.name)) continue;
          if (prop.getValue(node) !== oldKey) continue;
          prop.setValue?.(node, newKey);
          references.push({ sceneId, nodeId: node.nodeId, property: prop.name });
          sceneTouched = true;
        }
      }

      if (sceneTouched) {
        const descriptor = context.state.scenes.descriptors[sceneId];
        if (descriptor) descriptor.isDirty = true;
      }
    }
    return references;
  }

  /** Re-apply a key value to previously recorded references (undo/redo path). */
  private applyToReferences(
    context: OperationContext,
    references: readonly KeyReference[],
    key: string
  ): void {
    const sceneManager = tryGetService(context, SceneManager);
    if (!sceneManager) return;
    for (const ref of references) {
      const node = sceneManager.getSceneGraph(ref.sceneId)?.nodeMap.get(ref.nodeId);
      if (!node) continue; // scene closed since — table rename still applies
      const prop = getNodePropertySchema(node).properties.find(p => p.name === ref.property);
      prop?.setValue?.(node, key);
      const descriptor = context.state.scenes.descriptors[ref.sceneId];
      if (descriptor) descriptor.isDirty = true;
    }
  }

  private refresh(context: OperationContext): void {
    tryGetService(context, ViewportRendererService)?.refreshLocalizedLabels();
  }
}

function tryGetService<T>(context: OperationContext, token: new (...args: never[]) => T): T | null {
  try {
    return context.container.getService<T>(context.container.getOrCreateToken(token));
  } catch {
    return null;
  }
}
