import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { ProjectFiles, toProjectPath } from '../validate/project.ts';

/**
 * Which scenes `pix3 smoke` runs when it is not given one.
 *
 * The old default — the manifest's `defaultExportScenePath` — is the menu in every recipe: input is
 * empty, PLAY is never pressed, the game scene never loads, and a script that throws in the game's
 * `onStart` smoked green (trial 2026-09-27, D1). The rule now:
 *
 *  1. `--changed`, or by default when the project is in a git repository with uncommitted changes:
 *     the top-level scenes a changed file reaches — the scene itself, a prefab / `scenes/ui/`
 *     overlay it instances, a script whose class it attaches as `user:X`, a `res://` file it names.
 *     When any changed scene or script reaches no top-level scene (a helper module, an unused
 *     prefab), or the manifest changed, the answer is "every scene" — never a partial guess.
 *  2. Otherwise every top-level scene (not instanced by another, not under `prefabs/` or `ui/`),
 *     the editor's startup scene (`scenes/main.pix3scene` — the game, "iterate here") first, then
 *     the manifest's entry scene, then the rest by path. Each is a separate run and is reported on
 *     its own line, so the menu AND the game are both smoked.
 */

/** The editor opens this scene when a project loads (`ProjectService.STARTUP_SCENE_PATH`). */
export const STARTUP_SCENE = 'scenes/main.pix3scene';

export type SmokeSelectionMode = 'changed' | 'all';

export interface SmokeSelection {
  readonly mode: SmokeSelectionMode;
  readonly scenes: readonly string[];
  /** One line for the human: why these scenes. */
  readonly reason: string;
  /** Project files git reports as changed (mode `changed`, or `all` after a changed-file fallback). */
  readonly changed?: readonly string[];
}

const INSTANCE_LINE = /^\s*(?:-\s+)?instance:\s*["']?(?:res:\/\/)?([^"'\s#]+)/gm;
const RES_REFERENCE = /res:\/\/[^"'\s#)]+/g;
const USER_COMPONENT = /\buser:([A-Za-z_$][\w$]*)/g;
const EXPORTED_CLASS = /\bexport\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
const PREFAB_OR_UI = /(^|\/)(prefabs?|ui)\//i;

const isScript = (file: string): boolean =>
  /\.(ts|mts|js|mjs)$/.test(file) && !file.endsWith('.d.ts');
/** Files that change what a run does: a scene or a script. */
const isCode = (file: string): boolean => file.endsWith('.pix3scene') || isScript(file);

const readOr = (project: ProjectFiles, path: string): string => {
  try {
    return project.readText(path);
  } catch {
    return '';
  }
};

const instancesOf = (project: ProjectFiles, scene: string): string[] => {
  const out: string[] = [];
  for (const match of readOr(project, scene).matchAll(INSTANCE_LINE)) {
    out.push(match[1].replace(/^\/+/, ''));
  }
  return out;
};

/** Scenes no other scene instances, outside prefabs/ and ui/ folders — the ones a game starts in. */
export const topLevelScenes = (project: ProjectFiles): string[] => {
  const scenes = project.scenes();
  const instanced = new Set<string>();
  for (const scene of scenes)
    for (const target of instancesOf(project, scene)) instanced.add(target);
  return scenes.filter(scene => !instanced.has(scene) && !PREFAB_OR_UI.test(scene));
};

/** Startup scene first, then the manifest's entry scene, then the rest in path order. */
const ordered = (scenes: readonly string[], manifestDefault: string | undefined): string[] => {
  const rank = (scene: string): number =>
    scene === STARTUP_SCENE ? 0 : scene === manifestDefault ? 1 : 2;
  return [...scenes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

/**
 * Every project file a top-level scene depends on: itself, the scenes it instances (transitively),
 * the non-scene `res://` files any of them name, and the script files exporting the `user:` classes
 * they attach.
 */
const dependenciesOf = (
  project: ProjectFiles,
  scene: string,
  scriptsByClass: ReadonlyMap<string, readonly string[]>
): Set<string> => {
  const deps = new Set<string>();
  const queue = [scene];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (deps.has(current)) continue;
    deps.add(current);
    const text = readOr(project, current);
    for (const target of instancesOf(project, current)) queue.push(target);
    for (const match of text.matchAll(RES_REFERENCE)) {
      const path = toProjectPath(match[0]);
      if (!path) continue;
      // A scene named by res:// outside `instance:` is a `changeScene` target (the menu's
      // PLAY → main): a separate run that smoke never reaches, not a dependency.
      if (!path.endsWith('.pix3scene')) deps.add(path);
    }
    for (const match of text.matchAll(USER_COMPONENT)) {
      for (const file of scriptsByClass.get(match[1]) ?? []) deps.add(file);
    }
  }
  return deps;
};

const scriptClassIndex = (project: ProjectFiles): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  for (const file of project.files) {
    if (!isScript(file)) continue;
    for (const match of readOr(project, file).matchAll(EXPORTED_CLASS)) {
      const list = index.get(match[1]) ?? [];
      list.push(file);
      index.set(match[1], list);
    }
  }
  return index;
};

const git = (cwd: string, args: readonly string[]): string | null => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

/**
 * Project-relative files that differ from HEAD — staged, unstaged or untracked (git-ignored files
 * excluded) — or null when git is not installed or the project is not inside a work tree.
 */
export const gitChangedFiles = (root: string): string[] | null => {
  const top = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (status === null) return null;
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // keep the given path
  }
  const out = new Set<string>();
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // Renames and copies carry the old path as the next NUL-separated field.
    if (code.includes('R') || code.includes('C')) i += 1;
    if (code.includes('D')) continue;
    const rel = relative(realRoot, join(top, path));
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    out.add(rel.split(sep).join('/'));
  }
  return [...out].sort();
};

export interface SelectScenesOptions {
  readonly manifestDefault?: string;
  /** `--changed`: only changed scenes; fail when git is unavailable. */
  readonly changedOnly?: boolean;
  /** `--all`: every top-level scene, ignore git. */
  readonly all?: boolean;
  /** Test seam: the changed-file list (null = no git). Default: ask git. */
  readonly changedFiles?: readonly string[] | null;
}

/** The scenes to run with no scene argument, or why there are none (a message for E_SMOKE_NO_SCENE). */
export const selectSmokeScenes = (
  project: ProjectFiles,
  options: SelectScenesOptions
): SmokeSelection | { readonly error: string } => {
  const top = ordered(topLevelScenes(project), options.manifestDefault);
  if (project.scenes().length === 0) return { error: 'the project has no .pix3scene files.' };
  if (top.length === 0) {
    return {
      error:
        'every scene is a prefab, a scenes/ui overlay or instanced by another — name one: pix3 smoke <scene>.',
    };
  }
  const everything = (reason: string, changed?: readonly string[]): SmokeSelection => ({
    mode: 'all',
    scenes: top,
    reason,
    ...(changed ? { changed } : {}),
  });
  if (options.all) return everything('--all: every top-level scene');

  const changed =
    options.changedFiles !== undefined ? options.changedFiles : gitChangedFiles(project.root);
  if (changed === null) {
    if (options.changedOnly) {
      return { error: '--changed needs git and a project inside a git work tree.' };
    }
    return everything('every top-level scene (no git history to narrow it down)');
  }
  if (changed.length === 0) {
    if (options.changedOnly) return { error: '--changed: nothing changed since the last commit.' };
    return everything('every top-level scene (nothing changed since the last commit)');
  }
  if (changed.includes(PROJECT_MANIFEST_FILE)) {
    return everything(`every top-level scene (${PROJECT_MANIFEST_FILE} changed)`, changed);
  }

  const scriptsByClass = scriptClassIndex(project);
  const deps = new Map(top.map(scene => [scene, dependenciesOf(project, scene, scriptsByClass)]));
  const picked = top.filter(scene => changed.some(file => deps.get(scene)?.has(file)));
  const orphans = changed.filter(
    file => isCode(file) && !top.some(scene => deps.get(scene)?.has(file))
  );
  if (orphans.length > 0 || picked.length === 0) {
    const shown = orphans.slice(0, 3).join(', ') + (orphans.length > 3 ? ', …' : '');
    return everything(
      orphans.length > 0
        ? `every top-level scene (changed ${shown} reaches no scene directly)`
        : 'every top-level scene (no changed file is used by a scene)',
      changed
    );
  }
  return {
    mode: 'changed',
    scenes: picked,
    reason: `scenes reached by files changed since the last commit (${changed.length} changed; --all for every scene)`,
    changed,
  };
};
