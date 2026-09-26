/**
 * {@link PropertyTypeResolver} backed by the runtime's static `getPropertySchema()`.
 *
 * Built from a module namespace (`import * as runtime from '@pix3/runtime'`) the same way
 * `scene-nodes-dts.ts` indexes node classes: every exported class with a static
 * `getPropertySchema()` contributes `schema.nodeType → { propertyName → type }`. A YAML `type:` is
 * canonicalised with `resolveSceneNodeType` first (aliases such as `DirectionalLight`), and the
 * exported class name is accepted as well.
 */
import { resolveSceneNodeType, type PropertySchema, type PropertyType } from '@pix3/runtime';
import type { PropertyTypeResolver } from './value-equality';

type TypeTable = Map<string, Map<string, PropertyType>>;

function readSchema(value: unknown): PropertySchema | null {
  if (typeof value !== 'function') return null;
  const getSchema = (value as { getPropertySchema?: unknown }).getPropertySchema;
  if (typeof getSchema !== 'function') return null;
  try {
    const schema = (getSchema as () => unknown).call(value);
    if (
      typeof schema === 'object' &&
      schema !== null &&
      Array.isArray((schema as PropertySchema).properties)
    ) {
      return schema as PropertySchema;
    }
  } catch {
    // A provider whose schema throws contributes nothing.
  }
  return null;
}

export function createSchemaTypeResolver(
  moduleExports: Record<string, unknown>
): PropertyTypeResolver {
  const table: TypeTable = new Map();
  for (const [exportName, value] of Object.entries(moduleExports)) {
    const schema = readSchema(value);
    if (!schema) continue;
    const types = new Map<string, PropertyType>();
    for (const property of schema.properties) {
      if (typeof property?.name === 'string') types.set(property.name, property.type);
    }
    if (typeof schema.nodeType === 'string' && !table.has(schema.nodeType)) {
      table.set(schema.nodeType, types);
    }
    if (!table.has(exportName)) table.set(exportName, types);
  }
  return (nodeType, key) => {
    if (nodeType === undefined) return undefined;
    const canonical = resolveSceneNodeType(nodeType) ?? nodeType;
    return (table.get(canonical) ?? table.get(nodeType))?.get(key);
  };
}
