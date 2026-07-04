import type { NodeBase } from '@pix3/runtime';

export interface PrefabMetadata {
  localId: string;
  effectiveLocalId: string;
  instanceRootId: string;
  sourcePath: string;
  basePropertiesByLocalId?: Record<string, Record<string, unknown>>;
}

const PREFAB_METADATA_KEY = '__pix3Prefab';

export const getPrefabMetadata = (node: NodeBase): PrefabMetadata | null => {
  const metadata = node.metadata as Record<string, unknown>;
  const candidate = metadata[PREFAB_METADATA_KEY];
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const marker = candidate as Partial<PrefabMetadata>;
  if (
    typeof marker.localId !== 'string' ||
    typeof marker.effectiveLocalId !== 'string' ||
    typeof marker.instanceRootId !== 'string' ||
    typeof marker.sourcePath !== 'string'
  ) {
    return null;
  }

  return marker as PrefabMetadata;
};

export const isPrefabNode = (node: NodeBase): boolean => getPrefabMetadata(node) !== null;

export const isPrefabInstanceRoot = (node: NodeBase): boolean => {
  const marker = getPrefabMetadata(node);
  return !!marker && marker.instanceRootId === node.nodeId;
};

export const isPrefabChildNode = (node: NodeBase): boolean => {
  const marker = getPrefabMetadata(node);
  return !!marker && marker.instanceRootId !== node.nodeId;
};

export const findPrefabInstanceRoot = (node: NodeBase): NodeBase | null => {
  const marker = getPrefabMetadata(node);
  if (!marker) {
    return null;
  }

  let current: NodeBase | null = node;
  while (current) {
    if (current.nodeId === marker.instanceRootId) {
      return current;
    }
    current = current.parentNode;
  }

  return null;
};

/**
 * Properties of an instance ROOT that describe where the instance sits in the
 * host scene rather than the prefab's authored content — Unity's "default
 * overrides". These are stored on the host scene's `instance:` definition (name
 * + the `properties:` diff), so moving/anchoring an instance is placement, not a
 * content override, and the inspector must not flag them or offer a Revert.
 *
 * Includes 2D anchored-layout keys (layoutEnabled/horizontalAlign/verticalAlign)
 * so pinning a panel to a window edge counts as placement; the anchored layout
 * itself rewrites the root's position on resize. 3D roots never expose these
 * names, so listing them is harmless there.
 */
export const INSTANCE_PLACEMENT_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  'name',
  'position',
  'rotation',
  'scale',
  'layoutEnabled',
  'horizontalAlign',
  'verticalAlign',
]);

/**
 * True when `propertyName` is a placement property on an instance ROOT (see
 * INSTANCE_PLACEMENT_PROPERTY_NAMES). Children and nested-instance roots are not
 * placement: moving them genuinely overrides the enclosing prefab's content.
 */
export const isInstancePlacementProperty = (node: NodeBase, propertyName: string): boolean => {
  return isPrefabInstanceRoot(node) && INSTANCE_PLACEMENT_PROPERTY_NAMES.has(propertyName);
};
