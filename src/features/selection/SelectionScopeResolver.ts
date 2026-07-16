/**
 * Pure resolution logic for Figma-style 2D selection in the viewport.
 *
 * The viewport hit-test returns the raw *leaf* node whose visual is under the
 * pointer (see `ViewportRenderService.raycast2D`). This module turns that leaf
 * into the node a click/hover should actually target, given the current
 * isolation scope (`focusNodeId`) and modifiers, exactly like Figma:
 *
 * - Single click selects the outermost container under the cursor that is a
 *   direct child of the current scope (scope `null` = scene root → top-level
 *   node). Clicking outside the current scope pops the scope out to the deepest
 *   ancestor that contains the clicked node.
 * - Ctrl/Cmd ("deep") selects the raw leaf, bypassing scoping, without changing
 *   the scope.
 * - Double click drills the scope into the container that a single click would
 *   have selected and selects the child under the cursor.
 * - Escape / empty click pops the scope out one level (Escape selects the
 *   former container; empty click clears and returns to root).
 *
 * It is intentionally free of three.js / DOM / Valtio dependencies so it can be
 * unit-tested directly (the viewport `*.spec.ts` is excluded from the suite).
 */

/** Minimal structural view of a scene node the resolver needs. `NodeBase` from
 * `@pix3/runtime` satisfies this shape, so callers pass nodes as-is. */
export interface ScopeNode {
  readonly nodeId: string;
  readonly parentNode: ScopeNode | null;
  // `unknown` (not `boolean`) so `NodeBase.properties: Record<string, unknown>`
  // is structurally assignable without a cast; read via `Boolean(...)`.
  readonly properties: { readonly locked?: unknown };
}

/** Looks a node up by id in the active scene graph; returns `null` for unknown
 * or stale ids (this is how a stale `focusNodeId`, e.g. after a scene switch or
 * node deletion, is transparently treated as the scene root). */
export type ScopeNodeLookup = (nodeId: string) => ScopeNode | null;

export interface ScopeResolution {
  /** Node to select, or `null` to clear the selection. */
  candidateId: string | null;
  /** Isolation scope to apply (`null` = scene root). */
  nextFocusId: string | null;
}

const isLocked = (node: ScopeNode): boolean => Boolean(node.properties.locked);

/** Chain from `leaf` up to its root-level ancestor, i.e. `[leaf, parent, …]`. */
const ancestorChain = (leaf: ScopeNode): ScopeNode[] => {
  const chain: ScopeNode[] = [];
  let current: ScopeNode | null = leaf;
  while (current) {
    chain.push(current);
    current = current.parentNode;
  }
  return chain;
};

/** Validate a raw focus id against the current graph; unknown ids collapse to
 * the scene root (`null`). */
const resolveFocusNode = (
  getNode: ScopeNodeLookup,
  focusNodeId: string | null
): ScopeNode | null => (focusNodeId ? getNode(focusNodeId) : null);

/**
 * The node a single click selects within a given scope: the ancestor of `leaf`
 * that is a direct child of the scope. Handles the Figma pop-out rule when the
 * leaf lives outside the current scope, and never returns a locked node (it
 * descends toward the unlocked leaf instead).
 */
const resolveScoped = (leafChain: ScopeNode[], focusNode: ScopeNode | null): ScopeResolution => {
  // Determine the effective scope that actually contains the leaf. If the
  // current scope contains it, keep it; otherwise pop out to the deepest
  // ancestor of the current scope that does (scene root as the fallback).
  let scope: ScopeNode | null = null;
  if (focusNode) {
    const focusIndex = leafChain.findIndex(node => node.nodeId === focusNode.nodeId);
    if (focusIndex !== -1) {
      scope = focusNode;
    } else {
      // Pop out: walk the scope's own ancestors until one contains the leaf.
      let ancestor: ScopeNode | null = focusNode.parentNode;
      while (ancestor) {
        if (leafChain.some(node => node.nodeId === ancestor!.nodeId)) {
          break;
        }
        ancestor = ancestor.parentNode;
      }
      scope = ancestor; // null => scene root, which contains everything.
    }
  }

  // Index in leafChain of the scope container (-1 => root scope).
  const scopeIndex = scope ? leafChain.findIndex(node => node.nodeId === scope!.nodeId) : -1;
  // Child-of-scope on the path to the leaf. Root scope selects the top-level
  // ancestor (last in the chain); otherwise the entry just below the scope.
  let candidateIndex = scopeIndex === -1 ? leafChain.length - 1 : Math.max(scopeIndex - 1, 0);

  // Locked containers are click-through: descend toward the (unlocked) leaf.
  while (candidateIndex > 0 && isLocked(leafChain[candidateIndex]!)) {
    candidateIndex -= 1;
  }

  return {
    candidateId: leafChain[candidateIndex]?.nodeId ?? null,
    nextFocusId: scope?.nodeId ?? null,
  };
};

/**
 * Resolve a single-click (or hover) target from a raw leaf hit.
 * @param deep When true (Ctrl/Cmd held), select the raw leaf and leave the
 *   scope unchanged.
 */
export const resolveViewportClick = (
  getNode: ScopeNodeLookup,
  focusNodeId: string | null,
  leafId: string | null,
  options: { deep?: boolean } = {}
): ScopeResolution => {
  const validatedFocusId = resolveFocusNode(getNode, focusNodeId)?.nodeId ?? null;

  if (!leafId) {
    return { candidateId: null, nextFocusId: validatedFocusId };
  }

  const leaf = getNode(leafId);
  if (!leaf) {
    return { candidateId: null, nextFocusId: validatedFocusId };
  }

  if (options.deep) {
    // Deep select ignores scoping and never mutates it.
    return { candidateId: leafId, nextFocusId: validatedFocusId };
  }

  return resolveScoped(ancestorChain(leaf), resolveFocusNode(getNode, focusNodeId));
};

/**
 * Resolve a double-click: drill the scope into the container a single click
 * would select and select the child of that container under the cursor. A
 * no-op (returns the plain scoped click) when there is nothing deeper to enter.
 */
export const resolveViewportDoubleClick = (
  getNode: ScopeNodeLookup,
  focusNodeId: string | null,
  leafId: string | null
): ScopeResolution => {
  const scoped = resolveViewportClick(getNode, focusNodeId, leafId);
  if (!leafId || !scoped.candidateId || scoped.candidateId === leafId) {
    // Already at the leaf (or nothing hit): can't drill deeper.
    return scoped;
  }

  const container = getNode(scoped.candidateId);
  const leaf = getNode(leafId);
  if (!container || !leaf) {
    return scoped;
  }

  // Child of the container on the path to the leaf becomes the new selection;
  // the container becomes the new scope.
  const leafChain = ancestorChain(leaf);
  const containerIndex = leafChain.findIndex(node => node.nodeId === container.nodeId);
  if (containerIndex <= 0) {
    return scoped;
  }

  let childIndex = containerIndex - 1;
  while (childIndex > 0 && isLocked(leafChain[childIndex]!)) {
    childIndex -= 1;
  }

  return {
    candidateId: leafChain[childIndex]?.nodeId ?? scoped.candidateId,
    nextFocusId: container.nodeId,
  };
};

/**
 * Resolve an Escape / pop-out: leave the current scope, selecting the former
 * scope container (Figma behaviour). At the scene root this clears the
 * selection.
 */
export const resolveViewportPopOut = (
  getNode: ScopeNodeLookup,
  focusNodeId: string | null
): ScopeResolution => {
  const focusNode = resolveFocusNode(getNode, focusNodeId);
  if (!focusNode) {
    return { candidateId: null, nextFocusId: null };
  }
  return {
    candidateId: focusNode.nodeId,
    nextFocusId: focusNode.parentNode?.nodeId ?? null,
  };
};
