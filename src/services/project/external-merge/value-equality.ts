/**
 * Property equality for the external merge — the "normalized parsed values" level of plan
 * `.plans/external-agent-authoring.md` §4.3 (never the byte level; that is `hash.ts`).
 *
 *   - numbers: |a - b| <= 1e-4 (`SceneSaver` writes `100`, an agent writes `100.000002`);
 *   - colours (schema type `color`): canonical lowercase `#rrggbb` (`#FFF` == `#ffffff` == 0xffffff);
 *   - vectors (`vector2/3/4`, `euler`): componentwise, `[x, y]` == `{ x, y }`;
 *   - strings / enums / booleans: as-is;
 *   - other nested structures (arrays, curves, maps): compared whole, recursively (v1 limitation —
 *     one differing point of a curve is a difference of the whole value).
 *
 * The type of a key comes from the node type's `getPropertySchema()` through a
 * {@link PropertyTypeResolver}; with no resolver, or an unknown type, the generic structural rule
 * applies (it already handles numbers and vector shapes; only colour canonicalisation needs the
 * schema). Note the stakes: equality decides only whether a conflict is REPORTED — in both branches
 * of the table the protected value stays — so an imprecise answer costs a banner, never an edit.
 */
import type { PropertyType } from '@pix3/runtime';
import { isRecord, type PropertyPath } from './scene-doc';

export const NUMBER_EPSILON = 1e-4;

/**
 * Resolve the schema type of a property key on a node type. `nodeType` is the YAML `type:`
 * (may be undefined for prefab instances); `key` is the leaf key name as it appears in YAML
 * (`position` under `properties.transform`, `color`, `width`, ...).
 */
export type PropertyTypeResolver = (
  nodeType: string | undefined,
  key: string
) => PropertyType | undefined;

const VECTOR_KEYS = ['x', 'y', 'z', 'w'] as const;
const VECTOR_TYPES: ReadonlySet<PropertyType> = new Set(['vector2', 'vector3', 'vector4', 'euler']);

export function numbersEqual(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return Math.abs(a - b) <= NUMBER_EPSILON;
}

/** Canonical `#rrggbb` (or `#rrggbbaa` with non-opaque alpha); null when not a hex colour. */
export function canonicalColor(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return `#${value.toString(16).padStart(6, '0')}`;
  }
  if (typeof value !== 'string') return null;
  let hex = value.trim().toLowerCase();
  if (hex.startsWith('#')) hex = hex.slice(1);
  else if (hex.startsWith('0x')) hex = hex.slice(2);
  else return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map(c => c + c).join('');
  }
  if (hex.length === 8 && hex.endsWith('ff')) hex = hex.slice(0, 6);
  return hex.length === 6 || hex.length === 8 ? `#${hex}` : null;
}

/** `[x, y, ...]` or `{ x, y, ... }` → component list; null when not vector-shaped. */
export function vectorComponents(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.length >= 2 && value.length <= 4 && value.every(v => typeof v === 'number')
      ? (value as number[])
      : null;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length < 2 || keys.length > 4) return null;
  if (!keys.every(k => (VECTOR_KEYS as readonly string[]).includes(k))) return null;
  const out: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    const component = value[VECTOR_KEYS[i]];
    if (typeof component !== 'number') return null;
    out.push(component);
  }
  return out;
}

function vectorsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => numbersEqual(v, b[i]));
}

export interface EqualityContext {
  nodeType: string | undefined;
  resolver?: PropertyTypeResolver;
  /** True while inside a node's `properties` map, where keys are schema property names. */
  inProperties: boolean;
}

/**
 * Normalized deep equality of two parsed values. `key` is the YAML key the values sit under
 * (used to look up the schema type); `undefined` for array elements / the path root.
 */
export function valuesEqual(a: unknown, b: unknown, ctx: EqualityContext, key?: string): boolean {
  const type =
    ctx.inProperties && key !== undefined && ctx.resolver
      ? ctx.resolver(ctx.nodeType, key)
      : undefined;

  if (type === 'color') {
    const ca = canonicalColor(a);
    const cb = canonicalColor(b);
    if (ca !== null && cb !== null) return ca === cb;
  }
  if (type !== undefined && VECTOR_TYPES.has(type)) {
    const va = vectorComponents(a);
    const vb = vectorComponents(b);
    if (va && vb) return vectorsEqual(va, vb);
  }

  if (typeof a === 'number' && typeof b === 'number') return numbersEqual(a, b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b;
  }

  // Generic vector shape: `[x, y]` written by one side, `{ x, y }` by the other.
  const va = vectorComponents(a);
  const vb = vectorComponents(b);
  if (va && vb && Array.isArray(a) !== Array.isArray(b)) return vectorsEqual(va, vb);

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => valuesEqual(item, b[i], ctx));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    const inA = ra[k] !== undefined;
    const inB = rb[k] !== undefined;
    if (inA !== inB) return false;
    if (!inA) continue;
    const childCtx: EqualityContext =
      !ctx.inProperties && key === undefined && k === 'properties'
        ? { ...ctx, inProperties: true }
        : ctx;
    if (!valuesEqual(ra[k], rb[k], childCtx, k)) return false;
  }
  return true;
}

/**
 * Compare the values found at `path` inside two nodes of type `nodeType`. Handles the context
 * (whether the path is inside `properties`) so schema lookup applies to the right keys.
 */
export function valuesEqualAtPath(
  path: PropertyPath,
  a: unknown,
  b: unknown,
  nodeType: string | undefined,
  resolver?: PropertyTypeResolver
): boolean {
  const inProperties = path.length > 0 && path[0] === 'properties';
  const key = path.length > 0 ? path[path.length - 1] : undefined;
  if (path.length === 1 && inProperties) {
    // The whole `properties` map: recurse with the schema active for its keys.
    return valuesEqual(a, b, { nodeType, resolver, inProperties: true });
  }
  return valuesEqual(a, b, { nodeType, resolver, inProperties }, key);
}
