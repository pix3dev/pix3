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
 * class schema, or REPLACES a static property of the same name in place — which
 * is how a node upgrades an authored text field to a live picker once it knows
 * the valid values (SpineSkeleton2D's `animation`/`skin` become dropdowns of the
 * loaded skeleton's names). Because every schema consumer — the inspector, the animation
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
export declare function getNodePropertySchema(node: NodeBase): PropertySchema;
/**
 * Get all properties grouped by category.
 */
export declare function getPropertiesByGroup(schema: PropertySchema): Map<string, PropertyDefinition[]>;
/**
 * Get a property definition by name.
 */
export declare function getPropertyDefinition(schema: PropertySchema, name: string): PropertyDefinition | undefined;
/**
 * Get the display value for a property (formatted, converted to display units, etc.)
 */
export declare function getPropertyDisplayValue(node: NodeBase, prop: PropertyDefinition): string;
/**
 * Validate and transform a property value before setting it.
 */
export declare function validatePropertyValue(prop: PropertyDefinition, value: unknown): {
    isValid: boolean;
    error?: string;
    transformedValue?: unknown;
};
/**
 * Set a property value on a node, with validation and transformation.
 */
export declare function setNodePropertyValue(node: NodeBase, prop: PropertyDefinition, value: unknown): {
    success: boolean;
    error?: string;
};
