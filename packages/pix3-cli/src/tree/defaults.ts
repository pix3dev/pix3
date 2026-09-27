import * as runtime from '@pix3/runtime';
import {
  getSceneNodeDiskFormat,
  resolveSceneNodeType,
  type PropertyDefinition,
  type PropertySchema,
  type SceneDiskKeyRule,
} from '@pix3/runtime';
import { installCanvasOnlyDocument } from '@pix3/runtime/node';

/**
 * `pix3 tree --props`: what a node of each type looks like when nothing is authored, so the tree
 * can print only the properties a scene actually changes.
 *
 * Bundled with the runtime (`smoke/bundle.ts`, entry `tree-defaults`). A node's schema carries
 * almost no `defaultValue`s, so the defaults are read the one way that is exact: construct a bare
 * instance of the class (`new Class({ id })`, the canvas-only document shim for caption-measuring
 * controls) and read every schema property through its own `getValue`. No scene is loaded and no
 * project code runs — the promise of level 1 still holds.
 *
 * The disk format (`scene-disk-format.ts`) maps file keys to schema names: `transform.position` →
 * `position`, `layout.enabled` → `layoutEnabled`, and so on. The result carries that map so the CLI
 * side can compare a file's `properties:` block key by key.
 */

export interface NodeTypeDefaults {
  /** Canonical type (`DirectionalLightNode` for an authored `DirectionalLight`), null if unknown. */
  readonly canonical: string | null;
  /** File key path (`width`, `transform.position`, `layout.enabled`) → default value, plain JSON. */
  readonly defaults: Readonly<Record<string, unknown>>;
}

type SchemaClass = { getPropertySchema(): PropertySchema };
type NodeClass = new (props: { id: string; name?: string }) => object;

const runtimeExports = runtime as unknown as Record<string, unknown>;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Vectors/eulers → arrays, colours → hex, everything JSON-shaped as is. */
export const toPlain = (value: unknown): unknown => {
  if (typeof value === 'number') return round(value);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.isColor === true && typeof record.getHexString === 'function') {
    return `#${(record.getHexString as () => string).call(value)}`;
  }
  if (typeof record.x === 'number' && typeof record.y === 'number') {
    const axes = ['x', 'y', 'z', 'w'].filter(axis => typeof record[axis] === 'number');
    return axes.map(axis => round(record[axis] as number));
  }
  if (Array.isArray(value)) return value.map(toPlain);
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
};

const nestedKeyPaths = (
  rules: Readonly<Record<string, SceneDiskKeyRule>>
): Array<{ path: string; schemaName: string }> => {
  const out: Array<{ path: string; schemaName: string }> = [];
  for (const [key, rule] of Object.entries(rules)) {
    for (const [nestedKey, nested] of Object.entries(rule.nested ?? {})) {
      if (nested.schemaName)
        out.push({ path: `${key}.${nestedKey}`, schemaName: nested.schemaName });
    }
  }
  return out;
};

const cache = new Map<string, NodeTypeDefaults>();

const silently = <T>(task: () => T): T => {
  const original = {
    warn: console.warn,
    log: console.log,
    info: console.info,
    debug: console.debug,
  };
  console.warn = console.log = console.info = console.debug = () => {};
  try {
    return task();
  } finally {
    Object.assign(console, original);
  }
};

export const defaultsForType = (type: string): NodeTypeDefaults => {
  const cached = cache.get(type);
  if (cached) return cached;
  const canonical = resolveSceneNodeType(type);
  const format = canonical ? getSceneNodeDiskFormat(canonical) : null;
  const exported = format ? runtimeExports[format.classExport] : undefined;
  let result: NodeTypeDefaults = { canonical, defaults: {} };
  if (format && typeof exported === 'function') {
    const schemaClass = exported as unknown as Partial<SchemaClass>;
    const schema: readonly PropertyDefinition[] =
      typeof schemaClass.getPropertySchema === 'function'
        ? schemaClass.getPropertySchema().properties
        : [];
    const uninstall = installCanvasOnlyDocument();
    try {
      const instance = silently(() => new (exported as NodeClass)({ id: '__pix3_tree_default__' }));
      const bySchemaName = new Map<string, unknown>();
      for (const property of schema) {
        try {
          bySchemaName.set(property.name, toPlain(property.getValue(instance)));
        } catch {
          // A getter that needs a loaded scene has no default to show.
        }
      }
      const defaults: Record<string, unknown> = {};
      for (const [name, value] of bySchemaName) defaults[name] = value;
      for (const { path, schemaName } of nestedKeyPaths(format.extras)) {
        if (bySchemaName.has(schemaName)) defaults[path] = bySchemaName.get(schemaName);
      }
      result = { canonical, defaults };
    } catch {
      result = { canonical, defaults: {} };
    } finally {
      uninstall();
    }
  }
  cache.set(type, result);
  return result;
};

/** Defaults for every type in `types` (the CLI calls this once per `pix3 tree --props`). */
export const defaultsForTypes = (types: readonly string[]): Record<string, NodeTypeDefaults> => {
  const out: Record<string, NodeTypeDefaults> = {};
  for (const type of types) out[type] = defaultsForType(type);
  return out;
};
