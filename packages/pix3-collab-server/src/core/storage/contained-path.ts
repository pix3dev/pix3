import path from 'path';

/**
 * The one containment rule for every client-supplied path this server writes to or serves from.
 *
 * Three call sites grew three copies of it — project file storage, library bundles, and the CRDT
 * persistence path — and the third copy was never written, which is how a scene's `filePath` became
 * an arbitrary-write primitive. One implementation, one place to get it right.
 *
 * `path.resolve` is what does the work: it collapses `..`, and an argument that is already absolute
 * (`/etc/passwd`, or `C:\Windows` on Windows) simply replaces the root instead of being appended to
 * it. Either way the result then has to sit *under* the root, which the prefix test checks — with
 * `path.sep` appended so `…/data/projects-evil` cannot pass as being inside `…/data/projects`.
 *
 * The root must already be absolute; every caller gets it from `path.resolve` on a configured
 * directory.
 */
export interface ContainedPathOptions {
  /**
   * Whether resolving to the root directory itself is acceptable.
   *
   * `false` (the default) for callers that treat the result as a *file* — `writeFileSync` or
   * `sendFile` on a directory is an EISDIR 500 where a 400 is the honest answer. `true` for callers
   * that legitimately address the directory, such as creating it.
   */
  readonly allowRoot?: boolean;
}

/**
 * The absolute path `relativePath` denotes inside `rootDir`, or `null` when it escapes.
 *
 * Callers must treat `null` as a refusal — never as "fall back to the root".
 */
export function resolveContainedPath(
  rootDir: string,
  relativePath: string,
  options: ContainedPathOptions = {}
): string | null {
  // `path.resolve` throws on a non-string, and these values come off the wire.
  if (typeof relativePath !== 'string') {
    return null;
  }

  const resolved = path.resolve(rootDir, relativePath);

  if (resolved === rootDir) {
    return options.allowRoot === true ? resolved : null;
  }

  return resolved.startsWith(rootDir + path.sep) ? resolved : null;
}
