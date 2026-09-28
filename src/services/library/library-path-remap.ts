/**
 * Pure path-remapping for library-bundle insertion.
 *
 * A bundle stores files under bundle-relative paths that mirror their original project
 * layout (e.g. `prefabs/x.pix3scene`, `assets/sprites/btn.png`). Text files inside the
 * bundle reference siblings with absolute `res://<bundle-relative-path>` URIs. On insert
 * the bundle is copied under `res://assets/library/<slug>/` (files whose content the project
 * already has are reused where they are), so every reference that points at a bundle file is
 * rewritten to wherever that file landed.
 *
 * The rewrite is a whole-text regex replace with a right-boundary lookahead, mirroring
 * `ProjectService.rewriteResourceReferencesInText` (which handles the move-remap case).
 */

import { RESOURCE_GRAPH_EXTENSIONS } from '@/core/asset-categories';

/** Root folder (project-relative, no `res://`) under which inserted bundles live. */
const LIBRARY_INSERT_ROOT = 'assets/library';

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Project-relative target directory for an inserted item with the given slug. */
export function insertTargetDir(slug: string): string {
  return `${LIBRARY_INSERT_ROOT}/${slug}`;
}

/** Project path (no `res://`) for one bundle file once inserted under `targetDir`. */
export function bundleFileToProjectPath(bundleRelativePath: string, targetDir: string): string {
  return `${targetDir}/${normalizeBundlePath(bundleRelativePath)}`;
}

/** Normalize a bundle-relative path: forward slashes, no leading `./` or `/`. */
export function normalizeBundlePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * Rewrite every `res://<bundleFile>` reference in `text` to
 * `res://<targetDir>/<bundleFile>`. Longer paths are processed first so that a file whose
 * path is a prefix of another (e.g. `a/b` vs `a/b/c`) does not corrupt the longer match.
 *
 * The boundary lookahead prevents `res://a/b` from also matching inside `res://a/bc`.
 */
export function remapBundleReferences(
  text: string,
  bundleFiles: readonly string[],
  targetDir: string
): string {
  const mapping = new Map<string, string>();
  for (const file of bundleFiles.map(normalizeBundlePath)) {
    mapping.set(file, bundleFileToProjectPath(file, targetDir));
  }
  return remapBundleReferencesTo(text, mapping);
}

/**
 * Rewrite every `res://<bundleFile>` reference in `text` to `res://<mapping.get(bundleFile)>`.
 * The general form of {@link remapBundleReferences}, for inserts where files do not all land
 * under one folder (a file whose content already exists in the project is reused in place).
 * Bundle files absent from `mapping` are left untouched.
 */
export function remapBundleReferencesTo(
  text: string,
  mapping: ReadonlyMap<string, string>
): string {
  const ordered = [...mapping.keys()].sort((a, b) => b.length - a.length);
  let result = text;
  for (const file of ordered) {
    const target = `res://${mapping.get(file)}`;
    result = result.replace(referencePattern(file), target);
  }
  return result;
}

/** The subset of `bundleFiles` that `text` references as `res://<file>`. */
export function referencedBundleFiles(text: string, bundleFiles: readonly string[]): string[] {
  return bundleFiles.filter(file => referencePattern(file).test(text));
}

/** `res://<file>` with the right-boundary lookahead (so `a/b` does not match inside `a/bc`). */
function referencePattern(file: string): RegExp {
  return new RegExp(`${escapeRegExp(`res://${file}`)}(?=$|[^A-Za-z0-9._\\-/])`, 'g');
}

/**
 * File extensions whose contents may carry `res://` references and need remapping: every
 * resource-graph type (scenes, prefabs, flipbooks — the same table publish and export walk) plus
 * scripts and generic text data.
 */
const TEXT_REFERENCE_EXTENSIONS = new Set([
  ...RESOURCE_GRAPH_EXTENSIONS,
  'ts',
  'js',
  'mjs',
  'json',
  'yaml',
  'yml',
  'material',
]);

/** Whether a bundle file should be scanned/rewritten for `res://` references on insert. */
export function isTextReferenceFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return false;
  }
  return TEXT_REFERENCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
