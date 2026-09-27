import type { ProjectFiles } from '../validate/project.ts';

/**
 * The `user:` component ids a project declares, read from the text of its scripts — for the
 * `pix3 tree` overview, which must not load the runtime. The entry rule restates
 * `@pix3/runtime` `core/project-script-registration.ts` (`.ts`/`.js` under `scripts/` or
 * `src/scripts/` whose text matches `extends Script`); ids are the exported class names. An
 * overview line, not a check: `pix3 validate` is the authority on what registers.
 */

const SCRIPT_DIRECTORY = /^(src\/)?scripts\//;
const ENTRY_PATTERN = /extends\s+Script\b/;
const EXPORTED_CLASS = /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;

export const scanUserScriptIds = (project: ProjectFiles): string[] => {
  const ids = new Set<string>();
  for (const file of project.files) {
    if (!SCRIPT_DIRECTORY.test(file) || file.endsWith('.d.ts') || file.includes('.spec.')) continue;
    if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;
    let source: string;
    try {
      source = project.readText(file);
    } catch {
      continue;
    }
    if (!ENTRY_PATTERN.test(source)) continue;
    for (const match of source.matchAll(EXPORTED_CLASS)) ids.add(`user:${match[1]}`);
  }
  return [...ids].sort();
};
