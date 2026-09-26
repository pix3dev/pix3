/**
 * Which project files are script entries, and which of their exports become `user:*` components.
 *
 * One definition for every place that has to agree on it: the editor's
 * `ProjectScriptLoaderService` (compiles `scripts/` and registers what it finds), `pix3 validate`
 * (level 1 checks that a `user:X` component *exists* without running any code; level 2 compiles and
 * registers exactly like the editor), and the node-profile golden spec. If these drift, a scene the
 * editor loads cleanly fails validation, or — worse — validation passes a component the editor
 * parks as "not registered".
 *
 * The rule, as the editor implements it:
 * - only `.ts`/`.js` files under `scripts/` or `src/scripts/` (recursively) are candidates;
 * - a candidate is an entry only if its text matches {@link PROJECT_SCRIPT_ENTRY_PATTERN} — a class
 *   extending an intermediate base from a file without `extends Script` is not an entry unless it
 *   is re-exported from one (the check is textual on purpose, and mirrors the editor exactly);
 * - every exported value that is a function with a static `getPropertySchema` and whose prototype
 *   chain reaches `Script` registers as **`user:<export name>`** — the export name, not the class's
 *   `.name` and not the file name (`export { Foo as Bar }` registers `user:Bar`).
 *
 * Pure — no DOM, no editor imports.
 */
import { Script } from './ScriptComponent';
import type { ComponentTypeInfo, ScriptRegistry } from './ScriptRegistry';

/** Project-relative folders whose `.ts`/`.js` files may declare script components. */
export const PROJECT_SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;

/** The textual gate: a script file is an entry only when this matches its source. */
export const PROJECT_SCRIPT_ENTRY_PATTERN = /extends\s+Script\b/;

/** Namespace of project script component ids (`user:Player`). */
export const USER_SCRIPT_ID_PREFIX = 'user:';

/** Component id a project script export registers under. */
export const userScriptComponentId = (exportName: string): string =>
  `${USER_SCRIPT_ID_PREFIX}${exportName}`;

const normalizeProjectPath = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^res:\/\//, '')
    .replace(/^\.?\/+/, '');

/** True for a project-relative path inside one of {@link PROJECT_SCRIPT_DIRECTORIES}. */
export const isProjectScriptPath = (path: string): boolean => {
  const normalized = normalizeProjectPath(path);
  return PROJECT_SCRIPT_DIRECTORIES.some(
    directory => normalized === directory || normalized.startsWith(`${directory}/`)
  );
};

/** True when `path` + its `source` make a script entry the editor would compile and register. */
export const isProjectScriptEntry = (path: string, source: string): boolean => {
  const normalized = normalizeProjectPath(path);
  return (
    (normalized.endsWith('.ts') || normalized.endsWith('.js')) &&
    isProjectScriptPath(normalized) &&
    PROJECT_SCRIPT_ENTRY_PATTERN.test(source)
  );
};

export type ScriptComponentClass = ComponentTypeInfo['componentClass'];

/**
 * True for an export the editor registers as a component: a function with a static
 * `getPropertySchema` whose prototype chain reaches `Script` (or `Script` itself, as the editor's
 * prototype walk accepts it).
 */
export const isScriptComponentClass = (
  value: unknown,
  base: abstract new (...args: never[]) => unknown = Script
): value is ScriptComponentClass => {
  if (typeof value !== 'function') return false;
  if (typeof (value as { getPropertySchema?: unknown }).getPropertySchema !== 'function') {
    return false;
  }
  if (value === base) return true;
  const baseProto = base.prototype as object;
  let proto = (value as { prototype?: object }).prototype;
  while (proto) {
    if (proto === baseProto) return true;
    proto = Object.getPrototypeOf(proto) as object | undefined;
  }
  return false;
};

/**
 * Register every script-class export of one compiled script module (the namespace of one entry
 * file) as `user:<export name>`, the way the editor does. Returns the ids registered, in export
 * order. Existing registrations with the same id are overwritten (the registry warns).
 */
export const registerProjectScriptExports = (
  registry: ScriptRegistry,
  moduleExports: Readonly<Record<string, unknown>>,
  sourceLabel: string
): string[] => {
  const ids: string[] = [];
  for (const [exportName, exported] of Object.entries(moduleExports)) {
    if (!isScriptComponentClass(exported)) continue;
    const id = userScriptComponentId(exportName);
    registry.registerComponent({
      id,
      displayName: exportName,
      description: `Project component from ${sourceLabel}`,
      category: 'Project',
      componentClass: exported,
      keywords: ['project', 'component', exportName.toLowerCase(), sourceLabel.toLowerCase()],
    });
    ids.push(id);
  }
  return ids;
};
