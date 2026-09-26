import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CoreComponentInfo, CoreComponentProperty } from './kit-format.ts';

/**
 * The `core:` component reference of the kit, read from the runtime's own registry — the config
 * keys an external agent otherwise has no readable source for (the in-editor agent calls
 * `list_component_types`; draft kit open question 10). Defaults are read from a fresh instance
 * through each property's `getValue`, the same way the inspector shows them.
 *
 * Structural types only (no `@pix3/runtime` import): this file is compiled with the CLI, which
 * must not type-check the runtime's sources.
 */

interface SchemaProperty {
  readonly name: string;
  readonly type: string;
  readonly ui?: {
    readonly label?: string;
    readonly description?: string;
    readonly min?: number;
    readonly max?: number;
    readonly options?: readonly string[] | Readonly<Record<string, unknown>>;
    readonly hidden?: boolean;
  };
  getValue(target: unknown): unknown;
}

interface ComponentClass {
  new (id: string, type: string): unknown;
  getPropertySchema(): { readonly properties: readonly SchemaProperty[] };
}

interface RegistryLike {
  getAllComponentTypes(): readonly {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;
    readonly componentClass: ComponentClass;
  }[];
}

export interface RuntimeLike {
  readonly ScriptRegistry: new () => RegistryLike;
  registerBuiltInScripts(registry: RegistryLike): void;
}

const formatDefault = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object' && ('isVector3' in value || 'isVector2' in value)) {
    const v = value as { x?: unknown; y?: unknown; z?: unknown };
    return JSON.stringify('isVector3' in value ? [v.x, v.y, v.z] : [v.x, v.y]);
  }
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return undefined;
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  } catch {
    return undefined;
  }
};

const notesOf = (property: SchemaProperty): string => {
  const parts: string[] = [];
  const options = property.ui?.options;
  if (Array.isArray(options)) parts.push(options.join(' | '));
  else if (options && typeof options === 'object') parts.push(Object.keys(options).join(' | '));
  const { min, max } = property.ui ?? {};
  if (min !== undefined && max !== undefined) parts.push(`${min}..${max}`);
  else if (min !== undefined) parts.push(`≥ ${min}`);
  else if (max !== undefined) parts.push(`≤ ${max}`);
  if (property.ui?.description) parts.push(property.ui.description);
  return parts.join('; ');
};

export const extractCoreComponents = (runtime: RuntimeLike): CoreComponentInfo[] => {
  const registry = new runtime.ScriptRegistry();
  const log = console.log;
  console.log = () => {}; // registerBuiltInScripts announces itself
  try {
    runtime.registerBuiltInScripts(registry);
  } finally {
    console.log = log;
  }
  return registry
    .getAllComponentTypes()
    .filter(info => info.id.startsWith('core:'))
    .map(info => {
      let instance: unknown = null;
      try {
        instance = new info.componentClass(`kit-${info.id}`, info.id);
      } catch {
        instance = null;
      }
      const properties: CoreComponentProperty[] = info.componentClass
        .getPropertySchema()
        .properties.filter(property => !property.ui?.hidden)
        .map(property => {
          let value: unknown;
          if (instance !== null) {
            try {
              value = property.getValue(instance);
            } catch {
              value = undefined;
            }
          }
          const notes = notesOf(property);
          return {
            name: property.name,
            type: property.type,
            ...(formatDefault(value) !== undefined ? { default: formatDefault(value) } : {}),
            ...(notes ? { notes } : {}),
          };
        });
      return {
        id: info.id,
        displayName: info.displayName,
        description: info.description,
        properties,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

/** Build the validator bundle (runtime from source) into a temp folder and read the registry. */
export const loadCoreComponentsFromSource = async (): Promise<CoreComponentInfo[]> => {
  const outdir = mkdtempSync(join(tmpdir(), 'pix3-kit-runtime-'));
  try {
    const { buildValidateBundle } = await import('../validate/bundle.ts');
    await buildValidateBundle(outdir);
    const runtime = (await import(pathToFileURL(join(outdir, 'runtime.js')).href)) as RuntimeLike;
    return extractCoreComponents(runtime);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
};
