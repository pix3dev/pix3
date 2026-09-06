import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { BulkOperationBuilder } from '@/core/BulkOperation';
import { SceneManager, NodeBase } from '@pix3/runtime';
import { UpdateObjectPropertyOperation } from '@/features/properties/UpdateObjectPropertyOperation';
import type { PaletteId } from '@/services/uikit';
import type { KitManifest } from '@/services/uikit-editor/UiKitProjectWriter';
import {
  planCaptionPatches,
  planSkinPatches,
  SKINNABLE_NODE_TYPES,
} from '@/services/uikit-editor/skin-planner';

export interface ApplyUiKitSkinOperationParams {
  nodeIds: readonly string[];
  colorRole: PaletteId;
  manifest: KitManifest;
  /**
   * Also write the kit's caption recipe (face, weight, outline, drop, size). Default true —
   * art without typography is half a kit: the button wears the skin and keeps 16 px Arial.
   */
  typography?: boolean;
}

/** One property write, resolved before anything is touched. */
interface PlannedWrite {
  nodeId: string;
  propertyPath: string;
  value: unknown;
}

export { SKINNABLE_NODE_TYPES };

/**
 * Dress selected nodes in a baked UI kit.
 *
 * WHAT each node type wears is decided by `skin-planner.ts` — shared with the T0 expander, which
 * applies the same table to scene FILES before the nodes exist. This operation only turns that
 * plan into edits of the live graph.
 *
 * Every write goes through {@link UpdateObjectPropertyOperation} — the same path the Inspector
 * uses — and the commits are composed with {@link BulkOperationBuilder}, so one Ctrl+Z takes the
 * whole outfit back off (plan §7: the PNGs stay on disk under their hash name, so the previous
 * look is still there to return to).
 */
export class ApplyUiKitSkinOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'properties.apply-uikit-skin',
    title: 'Apply UI Kit Skin',
    description: 'Set the texture slots and nine-slice insets of UI nodes from a baked kit',
    tags: ['property', 'uikit', 'skin', '2d'],
  };

  constructor(private readonly params: ApplyUiKitSkinOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getActiveSceneGraph();
    if (!sceneGraph) return { didMutate: false };

    const writes: PlannedWrite[] = [];
    let skinned = 0;
    for (const nodeId of this.params.nodeIds) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) continue;

      const plan = planSkinPatches(node.type, this.params.manifest, this.params.colorRole);
      const captions =
        this.params.typography === false
          ? []
          : planCaptionPatches(this.params.manifest, node.type, {
              text: readString(node, 'label'),
              height: readNumber(node, 'height'),
              currentFontSize: readNumber(node, 'labelFontSize'),
            });
      if (plan.length === 0 && captions.length === 0) continue;
      for (const write of [...plan, ...captions]) {
        writes.push({ nodeId, propertyPath: write.propertyPath, value: write.value });
      }
      skinned += 1;
    }

    if (!writes.length) return { didMutate: false };

    const bulk = new BulkOperationBuilder();
    for (const write of writes) {
      const result = await new UpdateObjectPropertyOperation({
        nodeId: write.nodeId,
        propertyPath: write.propertyPath,
        value: write.value,
      }).perform(context);
      if (result.didMutate && result.commit) bulk.add(result.commit);
    }

    if (bulk.isEmpty()) return { didMutate: false };

    return {
      didMutate: true,
      commit: bulk.build(
        skinned === 1 ? 'Apply UI Kit Skin' : `Apply UI Kit Skin (${skinned} nodes)`
      ),
    };
  }
}

/** A node's string property, when it has one — the planner only needs a hint. */
function readString(node: NodeBase, key: string): string | undefined {
  const value = (node as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(node: NodeBase, key: string): number | undefined {
  const value = (node as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
