import { NodeBase } from '../../nodes/NodeBase';
import { UIControl2D } from '../../nodes/2D/UI/UIControl2D';

/**
 * Re-render every localized label under `roots` after a locale switch or table edit. Walks the tree
 * once and repaints each `UIControl2D` whose `labelKey` is set (covers authored keys and script
 * `setTextKey`). Shared by the SceneRunner (play mode) and the editor preview so they can't drift.
 * Sprite re-resolution is layered on in a later phase.
 */
export function applyLocaleToTree(roots: readonly NodeBase[]): void {
  const visit = (node: NodeBase): void => {
    if (node instanceof UIControl2D && node.labelKey) {
      node.refreshLocalizedLabel();
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
}
