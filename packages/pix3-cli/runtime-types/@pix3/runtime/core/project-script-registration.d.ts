import type { ComponentTypeInfo, ScriptRegistry } from './ScriptRegistry';
/** Project-relative folders whose `.ts`/`.js` files may declare script components. */
export declare const PROJECT_SCRIPT_DIRECTORIES: readonly ["scripts", "src/scripts"];
/** The textual gate: a script file is an entry only when this matches its source. */
export declare const PROJECT_SCRIPT_ENTRY_PATTERN: RegExp;
/** Namespace of project script component ids (`user:Player`). */
export declare const USER_SCRIPT_ID_PREFIX = "user:";
/** Component id a project script export registers under. */
export declare const userScriptComponentId: (exportName: string) => string;
/** True for a project-relative path inside one of {@link PROJECT_SCRIPT_DIRECTORIES}. */
export declare const isProjectScriptPath: (path: string) => boolean;
/** True when `path` + its `source` make a script entry the editor would compile and register. */
export declare const isProjectScriptEntry: (path: string, source: string) => boolean;
export type ScriptComponentClass = ComponentTypeInfo['componentClass'];
/**
 * True for an export the editor registers as a component: a function with a static
 * `getPropertySchema` whose prototype chain reaches `Script` (or `Script` itself, as the editor's
 * prototype walk accepts it).
 */
export declare const isScriptComponentClass: (value: unknown, base?: abstract new (...args: never[]) => unknown) => value is ScriptComponentClass;
/**
 * Register every script-class export of one compiled script module (the namespace of one entry
 * file) as `user:<export name>`, the way the editor does. Returns the ids registered, in export
 * order. Existing registrations with the same id are overwritten (the registry warns).
 */
export declare const registerProjectScriptExports: (registry: ScriptRegistry, moduleExports: Readonly<Record<string, unknown>>, sourceLabel: string) => string[];
