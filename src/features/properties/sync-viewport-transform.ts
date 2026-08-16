import type { NodeBase } from '@pix3/runtime';
import type { ServiceContainer } from '@/fw/di';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

/**
 * Push a node's transform into the editor viewport, when there is one.
 *
 * The transform operations all need this after mutating a node, and after each of their undo and
 * redo closures — nine call sites across three files, each of which had grown the same block:
 *
 * ```ts
 * try {
 *   const vr = container.getService<ViewportRendererService>(…);
 *   vr.updateNodeTransform(node);
 * } catch {}
 * ```
 *
 * The intent was to tolerate a container without a viewport (headless, unit tests). What it
 * actually did was discard *every* failure, including one thrown inside `updateNodeTransform` —
 * and in an undo closure that leaves the viewport showing a transform the document no longer has,
 * with nothing logged to explain it.
 *
 * So the optional part is asked about directly, and a real failure is reported rather than
 * swallowed. It is still not rethrown: an operation that mutated the document correctly must not be
 * reported as failed because a repaint did not happen.
 */
export function syncViewportTransform(container: ServiceContainer, node: NodeBase): void {
  const token = container.getOrCreateToken(ViewportRendererService);
  if (!container.hasService(token)) {
    return;
  }

  try {
    container.getService<ViewportRendererService>(token).updateNodeTransform(node);
  } catch (error) {
    console.error('[transform] Failed to sync the viewport after a transform', error);
  }
}
