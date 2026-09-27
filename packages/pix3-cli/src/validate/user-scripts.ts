import { isProjectScriptEntry, USER_SCRIPT_ID_PREFIX } from '@pix3/runtime';

import type { ProjectFiles } from './project.ts';

/**
 * Level 1's view of the project's `user:*` components: which ids exist, found by reading the
 * scripts, never by running them.
 *
 * It mirrors `ProjectScriptLoaderService` (the shared rule is `core/project-script-registration.ts`
 * in the runtime): entry files are `.ts`/`.js` under `scripts/` or `src/scripts/` whose text matches
 * `extends Script`, and every exported Script class registers as `user:<export name>`. From text we
 * can see the export names but not whether each is a Script class — an entry file's exported
 * helper function would be listed too. That errs towards "exists", which is the right side for a
 * check that must never produce a false error; level 2 compiles the files and knows for sure.
 */
export interface UserScriptIndex {
  /** `user:Name` → entry file that exports it. */
  readonly ids: ReadonlyMap<string, string>;
  /** Entry files. */
  readonly entries: readonly string[];
  /** Entry files with an `export * from …` — they may register ids this scan cannot see. */
  readonly opaqueEntries: readonly string[];
}

/** Drop comments so a commented-out `export class` does not count; strings are left alone. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const EXPORT_CLASS = /\bexport\s+(default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)?/g;
const EXPORT_CONST_CLASS = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*class\b/g;
const EXPORT_LIST = /\bexport\s+(type\s+)?\{([^}]*)\}/g;
const EXPORT_STAR = /\bexport\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\b/;

/** Export names that the editor would consider for registration, as far as text can tell. */
export const scanExportNames = (source: string): { names: string[]; hasStar: boolean } => {
  const text = stripComments(source);
  const names: string[] = [];
  for (const match of text.matchAll(EXPORT_CLASS)) {
    names.push(match[1] ? 'default' : (match[2] ?? 'default'));
  }
  for (const match of text.matchAll(EXPORT_CONST_CLASS)) {
    names.push(match[1]);
  }
  for (const match of text.matchAll(EXPORT_LIST)) {
    if (match[1]) continue; // `export type { … }`
    for (const raw of match[2].split(',')) {
      const specifier = raw.trim();
      if (!specifier || specifier.startsWith('type ')) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(specifier);
      names.push(alias ? alias[1] : specifier.split(/\s+/)[0]);
    }
  }
  return { names, hasStar: EXPORT_STAR.test(text) };
};

export const scanUserScripts = (project: ProjectFiles): UserScriptIndex => {
  const ids = new Map<string, string>();
  const entries: string[] = [];
  const opaqueEntries: string[] = [];
  for (const file of project.files) {
    if (!(file.endsWith('.ts') || file.endsWith('.js')) || file.endsWith('.d.ts')) continue;
    let source: string;
    try {
      source = project.readText(file);
    } catch {
      continue;
    }
    if (!isProjectScriptEntry(file, source)) continue;
    entries.push(file);
    const { names, hasStar } = scanExportNames(source);
    if (hasStar) opaqueEntries.push(file);
    for (const name of names) {
      const id = `${USER_SCRIPT_ID_PREFIX}${name}`;
      if (!ids.has(id)) ids.set(id, file);
    }
  }
  return { ids, entries, opaqueEntries };
};
