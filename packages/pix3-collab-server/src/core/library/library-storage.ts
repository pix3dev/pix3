import path from 'path';
import { config } from '../../config.js';
import { resolveContainedPath } from '../storage/contained-path.js';

/**
 * On-disk layout for library bundles, shared by the private sync router and the public
 * store router so both enforce the exact same containment rules.
 */

export function getItemDir(itemId: string): string {
  // itemId is a client UUID; encode it so it can never escape the storage root.
  return path.resolve(config.LIBRARY_STORAGE_DIR, encodeURIComponent(itemId));
}

/**
 * Resolve a bundle-relative path inside an item directory, or null when it escapes.
 *
 * The directory itself is rejected: `''`, `'.'` and `'a/..'` all resolve to it, and every
 * caller treats the result as a *file* (writeFileSync / sendFile), so returning it would
 * turn a malformed manifest into an EISDIR 500 instead of a clean 400. That is
 * {@link resolveContainedPath}'s default, which this now delegates to — the rule lives in
 * one place so a future fix reaches every caller.
 */
export function resolveSafePath(itemDir: string, relativePath: string): string | null {
  return resolveContainedPath(itemDir, relativePath);
}
