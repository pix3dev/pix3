/**
 * Property Schema Framework
 *
 * Defines metadata for node properties to enable dynamic inspector UI generation.
 * Similar to Godot's property system - each node class exposes its editable properties
 * with type information, validation rules, and UI hints.
 */

/** Supported property types for editor UI generation */
export type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'vector2'
  | 'vector3'
  | 'vector4'
  | 'euler'
  | 'color'
  | 'enum'
  | 'select'
  | 'object'
  | 'node';

/** UI hints for better editor presentation */
export interface PropertyUIHints {
  /** Display label for the property */
  label?: string;

  /** Longer description shown as tooltip */
  description?: string;

  /** Group/category for organizing properties (e.g., 'Transform', 'Rendering') */
  group?: string;

  /** Minimum value for numbers */
  min?: number;

  /** Maximum value for numbers */
  max?: number;

  /** Step increment for number sliders */
  step?: number;

  /** Unit label (e.g., '°' for degrees, 'px' for pixels) */
  unit?: string;

  /** For enum/select - array of allowed values */
  options?: string[] | Record<string, unknown>;

  /** Number of decimal places to display */
  precision?: number;

  /** Show as slider instead of input field */
  slider?: boolean;

  /** Color format: 'hex', 'rgb', 'rgba' */
  colorFormat?: 'hex' | 'rgb' | 'rgba';

  /** Show expanded by default in inspector */
  expanded?: boolean;

  /** Hide from inspector */
  hidden?: boolean;

  /** Property is read-only */
  readOnly?: boolean | ((target: unknown) => boolean);

  /** For 'node' type - array of allowed node types (e.g. ['MeshInstance', 'Node3D']) */
  nodeTypes?: string[];

  /** Optional specialized editor kind for custom inspector widgets */
  editor?:
    | 'texture-resource'
    | 'audio-resource'
    | 'model-resource'
    | 'animation-resource'
    | 'sprite-size'
    | 'localization-key';

  /** Optional resource subtype for object-like values */
  resourceType?: 'texture' | 'model';
}

/** Validation rule for a property */
export interface PropertyValidation {
  /** Validate the value before update */
  validate: (value: unknown) => boolean | string; // true/false or error message

  /** Transform value if validation passes */
  transform?: (value: unknown) => unknown;
}

/** Definition for a single property that can be edited in the inspector */
export interface PropertyDefinition {
  /** Property name/key */
  name: string;

  /** TypeScript type name (for documentation) */
  type: PropertyType;

  /** UI hints and display settings */
  ui?: PropertyUIHints;

  /** Optional validation and transformation */
  validation?: PropertyValidation;

  /** Default value if not set */
  defaultValue?: unknown;

  /** Get the current value from the node */
  getValue: (node: unknown) => unknown;

  /** Set the value on the node */
  setValue: (node: unknown, value: unknown) => void;
}

/** Complete schema for a node class */
export interface PropertySchema {
  /** Node type name */
  nodeType: string;

  /** Base class name (if extending another) */
  extends?: string;

  /** All editable properties */
  properties: PropertyDefinition[];

  /** Group definitions for organizing properties */
  groups?: Record<
    string,
    {
      label: string;
      description?: string;
      expanded?: boolean;
    }
  >;
}

/**
 * Helper to create a property definition with sensible defaults.
 */
export function defineProperty(
  name: string,
  type: PropertyType,
  config: Partial<Omit<PropertyDefinition, 'name' | 'type'>> & {
    getValue: (node: unknown) => unknown;
    setValue: (node: unknown, value: unknown) => void;
  }
): PropertyDefinition {
  return {
    name,
    type,
    ...config,
  };
}

/**
 * Helper to create a group definition.
 */
export function defineGroup(
  name: string,
  label: string,
  options?: { description?: string; expanded?: boolean }
) {
  return {
    [name]: {
      label,
      ...options,
    },
  };
}

/**
 * Merge schemas when extending property definitions.
 */
export function mergeSchemas(base: PropertySchema, extended: PropertySchema): PropertySchema {
  return {
    nodeType: extended.nodeType,
    extends: extended.extends || base.nodeType,
    properties: [...base.properties, ...extended.properties],
    groups: {
      ...base.groups,
      ...extended.groups,
    },
  };
}

/** Vector2 value helper */
export interface Vector2Value {
  x: number;
  y: number;
}

/** Vector3 value helper */
export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}

/** Euler rotation value helper (in radians) */
export interface EulerValue {
  x: number; // pitch
  y: number; // yaw
  z: number; // roll
  order: string;
}
