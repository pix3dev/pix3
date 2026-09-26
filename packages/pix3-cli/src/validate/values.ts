import type { PropertyDefinition, SceneDiskValueKind } from '@pix3/runtime';

import { isRecord } from './yaml-doc.ts';

/** A value problem, before it is placed in a file. */
export interface ValueProblem {
  readonly code: 'E_PROPERTY_TYPE' | 'E_PROPERTY_RANGE' | 'W_PROPERTY_RANGE' | 'E_PROPERTY_ENUM';
  readonly message: string;
  readonly fix?: string;
}

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'a mapping';
  return `${typeof value} ${String(value)}`;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, CSS functional colours, or a CSS colour keyword. */
const COLOR_PATTERN =
  /^(#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([^)]*\)|[a-z]+)$/i;

/** Allowed values of an enum/select property, or `[]` when the schema lists none. */
export const enumOptions = (property: PropertyDefinition): readonly unknown[] => {
  const options = property.ui?.options;
  if (Array.isArray(options)) return options;
  // `{ Label: value }` — the inspector shows the key and stores the value.
  if (isRecord(options)) return Object.values(options);
  return [];
};

const vectorProblem = (value: unknown, axes: readonly string[]): string | null => {
  if (Array.isArray(value)) {
    // The loader reads the leading components and ignores any extra ones.
    if (value.length < axes.length) {
      return `expected ${axes.length} numbers [${axes.join(', ')}], got ${describe(value)}`;
    }
    const bad = value.slice(0, axes.length).findIndex(item => !isFiniteNumber(item));
    return bad === -1 ? null : `component ${bad} is ${describe(value[bad])}, not a number`;
  }
  if (isRecord(value)) {
    const bad = axes.find(axis => axis in value && !isFiniteNumber(value[axis]));
    if (bad) return `${bad} is ${describe(value[bad])}, not a number`;
    return axes.some(axis => axis in value) ? null : `expected {${axes.join(', ')}}`;
  }
  return `expected [${axes.join(', ')}], got ${describe(value)}`;
};

const typeProblem = (message: string, fix?: string): ValueProblem => ({
  code: 'E_PROPERTY_TYPE',
  message,
  fix,
});

const isResourceEditor = (property: PropertyDefinition): boolean =>
  property.ui?.editor?.endsWith('-resource') === true || property.ui?.resourceType !== undefined;

/**
 * Check a value against a schema property. `name` is only used in messages. Returns null when the
 * value is fine. `null` counts as "unset" for strings, colours, node references and objects — the
 * loader treats it as absent — but never for numbers and booleans, where it silently becomes the
 * default.
 */
export const checkPropertyValue = (
  property: PropertyDefinition,
  value: unknown,
  name: string = property.name
): ValueProblem | null => {
  switch (property.type) {
    case 'number': {
      if (!isFiniteNumber(value)) {
        const numeric =
          typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
        return typeProblem(
          `${name} must be a number, got ${describe(value)}.`,
          numeric ? `write ${name}: ${Number(value)} (no quotes)` : undefined
        );
      }
      // `validation.validate` is the schema's hard rule (e.g. `fov > 0`) — an error.
      const verdict = property.validation?.validate(value);
      if (verdict === false || typeof verdict === 'string') {
        return {
          code: 'E_PROPERTY_RANGE',
          message: `${name} is ${value}: ${typeof verdict === 'string' ? verdict : "rejected by the property's validation"}.`,
        };
      }
      // `ui.min` / `ui.max` bound the inspector's slider, not the value: the shipped templates
      // author label sizes above the slider's max, and they render as written. A warning.
      const min = property.ui?.min;
      const max = property.ui?.max;
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        return {
          code: 'W_PROPERTY_RANGE',
          message: `${name} is ${value}, outside the inspector's ${min ?? '-∞'}..${max ?? '∞'} range; it loads as written, but the inspector cannot produce it.`,
        };
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : typeProblem(
            `${name} must be true or false, got ${describe(value)}.`,
            value === 'true' || value === 'false'
              ? `write ${name}: ${value} (no quotes)`
              : undefined
          );
    case 'string':
      return value === null || typeof value === 'string'
        ? null
        : typeProblem(
            `${name} must be a string, got ${describe(value)}.`,
            typeof value === 'number' || typeof value === 'boolean'
              ? `quote it: ${name}: "${String(value)}"`
              : undefined
          );
    case 'color':
      if (value === null) return null;
      if (typeof value !== 'string') {
        return typeProblem(
          `${name} must be a colour string like "#ff8800", got ${describe(value)}.`,
          typeof value === 'number'
            ? `write ${name}: "#${value.toString(16).padStart(6, '0')}"`
            : undefined
        );
      }
      return COLOR_PATTERN.test(value.trim())
        ? null
        : typeProblem(`${name} is not a colour: ${JSON.stringify(value)}.`, 'use "#rrggbb"');
    case 'enum':
    case 'select': {
      const options = enumOptions(property);
      if (options.length === 0 || options.includes(value)) return null;
      const insensitive =
        typeof value === 'string'
          ? options.find(
              option => typeof option === 'string' && option.toLowerCase() === value.toLowerCase()
            )
          : undefined;
      return {
        code: 'E_PROPERTY_ENUM',
        message: `${name} is ${describe(value)}; allowed: ${options.map(o => JSON.stringify(o)).join(', ')}.`,
        fix: insensitive !== undefined ? `write ${name}: ${String(insensitive)}` : undefined,
      };
    }
    case 'vector2': {
      const problem = vectorProblem(value, ['x', 'y']);
      return problem ? typeProblem(`${name}: ${problem}.`, `write ${name}: [x, y]`) : null;
    }
    case 'vector3':
    case 'euler': {
      const problem = vectorProblem(value, ['x', 'y', 'z']);
      return problem ? typeProblem(`${name}: ${problem}.`, `write ${name}: [x, y, z]`) : null;
    }
    case 'vector4': {
      const problem = vectorProblem(value, ['x', 'y', 'z', 'w']);
      return problem ? typeProblem(`${name}: ${problem}.`, `write ${name}: [x, y, z, w]`) : null;
    }
    case 'node':
      return value === null || typeof value === 'string'
        ? null
        : typeProblem(`${name} must be a node id (string), got ${describe(value)}.`);
    case 'object':
      if (isResourceEditor(property)) return checkDiskKindValue('texture', value, name);
      return null;
    default:
      return null;
  }
};

/** Check a value against a disk-only kind (a key that feeds no schema property). */
export const checkDiskKindValue = (
  kind: SceneDiskValueKind,
  value: unknown,
  name: string,
  options?: readonly string[]
): ValueProblem | null => {
  switch (kind) {
    case 'texture':
      if (value === null || typeof value === 'string') return null;
      if (isRecord(value) && typeof value.url === 'string') return null;
      return typeProblem(
        `${name} must be a texture: { type: texture, url: res://… } or a path string, got ${describe(value)}.`
      );
    case 'resource-path':
      return value === null || typeof value === 'string'
        ? null
        : typeProblem(`${name} must be a path string (res://…), got ${describe(value)}.`);
    case 'array':
      return Array.isArray(value)
        ? null
        : typeProblem(`${name} must be a list, got ${describe(value)}.`);
    case 'record':
      return isRecord(value)
        ? null
        : typeProblem(`${name} must be a mapping, got ${describe(value)}.`);
    case 'enum':
      return options === undefined || options.includes(value as string)
        ? null
        : {
            code: 'E_PROPERTY_ENUM',
            message: `${name} is ${describe(value)}; allowed: ${options.join(', ')}.`,
          };
    default:
      return checkPropertyValue(
        { name, type: kind, getValue: () => undefined, setValue: () => {} },
        value,
        name
      );
  }
};

/** True for values the loader treats as a resource path (it resolves them against the project). */
export const isResourceProperty = isResourceEditor;
