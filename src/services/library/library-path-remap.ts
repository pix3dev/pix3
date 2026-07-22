/**
 * Pure path-remapping for library-bundle insertion.
 *
 * A bundle stores files under bundle-relative paths that mirror their original project
 * layout (e.g. `prefabs/x.pix3scene`, `assets/sprites/btn.png`). Text files inside the
 * bundle reference siblings with absolute `res://<bundle-relative-path>` URIs. On insert
 * the whole bundle is copied under `res://assets/library/<slug>/`, so every reference that
 * points at a bundle file must gain that prefix.
 *
 * The rewrite is a whole-text regex replace with a right-boundary lookahead, mirroring
 * `ProjectService.rewriteResourceReferencesInText` (which handles the move-remap case).
 */

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
  const ordered = [...new Set(bundleFiles.map(normalizeBundlePath))].sort(
    (a, b) => b.length - a.length
  );
  let result = text;
  for (const file of ordered) {
    const source = `res://${file}`;
    const target = `res://${targetDir}/${file}`;
    const pattern = new RegExp(`${escapeRegExp(source)}(?=$|[^A-Za-z0-9._\\-/])`, 'g');
    result = result.replace(pattern, target);
  }
  return result;
}

/** File extensions whose contents may carry `res://` references and need remapping. */
const TEXT_REFERENCE_EXTENSIONS = new Set([
  'pix3scene',
  'pix3prefab',
  'pix3anim',
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
