import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RuntimeTypesManifest } from './runtime-types.ts';

/**
 * The type-check layout `pix3 new` / `pix3 kit` / `pix3 check` put into a project that has no
 * `tsconfig.json` of its own (plan §5 A):
 *
 * - `.pix3/types/@pix3/runtime/**`, `.pix3/types/@types/three/**` — a copy of the CLI's shipped
 *   runtime types, plus `.pix3/types/version.json` (their manifest);
 * - `.pix3/tsconfig.check.json` — `paths` onto those types, `strict`, `noEmit`, over the project's
 *   `scripts/` and `src/scripts/` (the two folders the editor loads scripts from);
 * - a root `tsconfig.json` = `{ "extends": "./.pix3/tsconfig.check.json" }`, written by the kit
 *   only, so VS Code / Cursor see the same types.
 *
 * All of it lives under `.pix3/` (gitignored, never exported, CLI-owned: replaced wholesale when
 * the CLI version changes). A project WITH its own root `tsconfig.json` (a Vite project such as
 * DeepCore, or one the editor's "build from templates" turned into one) gets none of this: `check`
 * runs its tsconfig as is, against its own `node_modules`.
 */

export const PROJECT_TYPES_DIR = '.pix3/types';
export const CHECK_TSCONFIG = '.pix3/tsconfig.check.json';
export const ROOT_TSCONFIG = 'tsconfig.json';
export const ROOT_TSCONFIG_CONTENT = '{ "extends": "./.pix3/tsconfig.check.json" }\n';

export const CHECK_TSCONFIG_CONTENT = `// Written by @pix3/cli (pix3 kit / pix3 check); replaced when the CLI version changes.
// Type-checks the project's scripts against the @pix3/runtime declarations in ./types/.
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "typeRoots": ["./types/@types"],
    "paths": {
      "@pix3/runtime": ["./types/@pix3/runtime/index.d.ts"],
      "three": ["./types/@types/three/index.d.ts"],
      "three/*": ["./types/@types/three/*"]
    }
  },
  "include": ["../scripts/**/*.ts", "../src/scripts/**/*.ts"]
}
`;

/** True when the project root carries a `tsconfig.json` that is not the kit's one-line `extends`. */
export const hasOwnTsconfig = (projectRoot: string): boolean => {
  const path = join(projectRoot, ROOT_TSCONFIG);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').trim() !== ROOT_TSCONFIG_CONTENT.trim();
  } catch {
    return true;
  }
};

export const readProjectTypesManifest = (projectRoot: string): RuntimeTypesManifest | null => {
  try {
    return JSON.parse(
      readFileSync(join(projectRoot, PROJECT_TYPES_DIR, 'version.json'), 'utf8')
    ) as RuntimeTypesManifest;
  } catch {
    return null;
  }
};

/** The project's types are the ones of this CLI build (same version and same sources). */
export const projectTypesCurrent = (
  projectRoot: string,
  shipped: RuntimeTypesManifest
): boolean => {
  const installed = readProjectTypesManifest(projectRoot);
  return (
    installed !== null &&
    installed.cliVersion === shipped.cliVersion &&
    installed.sourceStamp === shipped.sourceStamp &&
    existsSync(join(projectRoot, CHECK_TSCONFIG)) &&
    readFileSync(join(projectRoot, CHECK_TSCONFIG), 'utf8') === CHECK_TSCONFIG_CONTENT
  );
};

/**
 * Replace `.pix3/types/` with the shipped types and (re)write `.pix3/tsconfig.check.json`. Returns
 * the project paths written (directories as `…/`).
 */
export const installProjectTypes = (
  projectRoot: string,
  source: { readonly dir: string; readonly manifest: RuntimeTypesManifest }
): string[] => {
  const target = join(projectRoot, PROJECT_TYPES_DIR);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const scope of ['@pix3', '@types']) {
    cpSync(join(source.dir, scope), join(target, scope), { recursive: true });
  }
  writeFileSync(join(target, 'version.json'), `${JSON.stringify(source.manifest, null, 2)}\n`);
  writeFileSync(join(projectRoot, CHECK_TSCONFIG), CHECK_TSCONFIG_CONTENT);
  return [`${PROJECT_TYPES_DIR}/`, CHECK_TSCONFIG];
};
