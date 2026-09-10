import { NodeBase } from '@pix3/runtime';

/**
 * Opacity multiplier for branches an active Peek solo pushed into the background.
 *
 * Lives here rather than on `PeekService` because the 2D proxy registry needs it and importing the
 * service would close an import cycle (PeekService → ViewportRenderService → Viewport2DProxyRegistry).
 */
export const PEEK_DIM_OPACITY = 0.25;

/**
 * Branch roots an active Peek solo has faded back.
 *
 * Editor-side, deliberately: unlike `NodeBase.hiddenByEditor` — which the runtime's own `visible`
 * accessor reads and a play clone has to honour — the solo fade is only ever applied by the editor
 * viewport's proxy pass and its hit-tests. Keeping it out of `@pix3/runtime` leaves no engine field
 * that nothing in the engine reads, and a `WeakSet` cannot outlive the nodes it names.
 *
 * Stamped on branch ROOTS only; {@link isPeekDimmedInTree} does the inheritance, because a material
 * property has no three.js cascade to lean on the way `visible` does.
 */
const dimmedBranches = new WeakSet<NodeBase>();

/** Mark (or unmark) one branch root as faded by a solo. */
export const setPeekDimmed = (node: NodeBase, dimmed: boolean): void => {
  if (dimmed) {
    dimmedBranches.add(node);
  } else {
    dimmedBranches.delete(node);
  }
};

/** Whether this exact node is a faded branch root (not counting its ancestors). */
export const isPeekDimmed = (node: NodeBase): boolean => dimmedBranches.has(node);

/** Whether an active solo fades this node — its own flag, or any ancestor's. */
export const isPeekDimmedInTree = (node: NodeBase): boolean => {
  let current: import('three').Object3D | null = node;
  while (current) {
    if (current instanceof NodeBase && dimmedBranches.has(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/**
 * Whether the pointer should fall straight through this node in the editor viewport.
 *
 * Two independent reasons, deliberately fused into one predicate so every hit-test path applies
 * both — a picking path that checks only one of them is how a faded branch keeps stealing clicks
 * from the thing the author soloed:
 *
 * - **`locked`** — the authored "do not select me" flag. Click-through, not invisible.
 * - **Peek solo fade** — the branch is still drawn, just pushed back. AutoCAD's `LAYISO` default is
 *   exactly this pairing ("lock and fade"), and it is why solo never produces the "everything
 *   vanished" state that hiding does.
 *
 * Peek-*hidden* branches need no entry here: `hiddenByEditor` makes `visible` false, and every
 * picking path already refuses an invisible node.
 */
export const isPointerBlocked = (node: NodeBase): boolean =>
  Boolean(node.properties.locked) || isPeekDimmedInTree(node);
