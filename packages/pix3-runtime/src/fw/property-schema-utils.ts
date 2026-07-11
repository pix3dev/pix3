/**
 * Property Schema Utilities
 *
 * Helper functions for working with property schemas in the inspector.
 */

import type { NodeBase } from '../nodes/NodeBase';
import type { PropertySchema, PropertyDefinition } from './property-schema';

/**
 * Optional per-instance schema contribution. A node implementing this appends
 * instance-specific properties (e.g. attached shader effects) AFTER its static
 * class schema. Because every schema consumer — the inspector, the animation
 * timeline, the clip evaluator, `UpdateObjectPropertyOperation`, SceneRunner's
 * live-property sink, and prefab diffing — funnels through
 * {@link getNodePropertySchema}, these instance props become editable,
 * keyframe-animatable, undoable, and prefab-diffable with no per-call-site work.
 *
 * IMPORTANT (the one fragile spot): code that wants a node's *full* schema MUST
 * go through {@link getNodePropertySchema}, never `node.constructor.getPropertySchema()`
 * directly — the latter returns only the static class props and silently drops
 * instance contributions.
 */
export interface InstancePropertySchemaProvider {
  getInstancePropertySchema(): PropertySchema | null;
}

/**
 * Get the property schema for a node instance.
 * Dynamically resolves the correct schema based on the node's class hierarchy,
 * then merges any per-instance contribution (see {@link InstancePropertySchemaProvider}).
 */
export function getNodePropertySchema(node: NodeBase): PropertySchema {
  // Try to get schema from the node's constructor
  const constructor = node.constructor as {
    getPropertySchema?: () => PropertySchema;
  };

  const staticSchema: PropertySchema =
    typeof constructor.getPropertySchema === 'function'
      ? constructor.getPropertySchema()
      : { nodeType: 'Unknown', properties: [] };

  const instance = (
    node as Partial<InstancePropertySchemaProvider>
  ).getInstancePropertySchema?.();

  if (!instance || instance.properties.length === 0) {
    return staticSchema;
  }

  return {
    ...staticSchema,
    properties: [...staticSchema.properties, ...instance.properties],
    groups: { ...staticSchema.groups, ...instance.groups },
  };
}

/**
 * Get all properties grouped by category.
 */
export function getPropertiesByGroup(schema: PropertySchema): Map<string, PropertyDefinition[]> {
  const grouped = new Map<string, PropertyDefinition[]>();

  for (const prop of schema.properties) {
    const group = prop.ui?.group || 'General';
    if (!grouped.has(group)) {
      grouped.set(group, []);
    }
    grouped.get(group)!.push(prop);
  }

  return grouped;
}

/**
 * Get a property definition by name.
 */
export function getPropertyDefinition(
  schema: PropertySchema,
  name: string
): PropertyDefinition | undefined {
  return schema.properties.find(p => p.name === name);
}

/**
 * Get the display value for a property (formatted, converted to display units, etc.)
 */
export function getPropertyDisplayValue(node: NodeBase, prop: PropertyDefinition): string {
  const value = prop.getValue(node);

  // Handle different types
  if (prop.type === 'number') {
    const num = Number(value);
    if (isNaN(num)) return '0';

    const precision = prop.ui?.precision ?? 2;
    return parseFloat(num.toFixed(precision)).toString();
  }

  if (prop.type === 'boolean') {
    return String(value === true);
  }

  if (
    prop.type === 'vector2' ||
    prop.type === 'vector3' ||
    prop.type === 'vector4' ||
    prop.type === 'euler' ||
    prop.type === 'object'
  ) {
    // Vector and Euler values are objects - serialize as JSON
    return JSON.stringify(value);
  }

  return String(value ?? '');
}

/**
 * Validate and transform a property value before setting it.
 */
export function validatePropertyValue(
  prop: PropertyDefinition,
  value: unknown
): { isValid: boolean; error?: string; transformedValue?: unknown } {
  if (prop.validation?.validate) {
    const result = prop.validation.validate(value);
    if (result === false) {
      return { isValid: false, error: 'Invalid value' };
    }
    if (typeof result === 'string') {
      return { isValid: false, error: result };
    }
  }

  let transformedValue = value;
  if (prop.validation?.transform) {
    transformedValue = prop.validation.transform(value);
  }

  return { isValid: true, transformedValue };
}

/**
 * Set a property value on a node, with validation and transformation.
 */
export function setNodePropertyValue(
  node: NodeBase,
  prop: PropertyDefinition,
  value: unknown
): { success: boolean; error?: string } {
  const validation = validatePropertyValue(prop, value);

  if (!validation.isValid) {
    return { success: false, error: validation.error };
  }

  try {
    prop.setValue(node, validation.transformedValue);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
