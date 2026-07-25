import path from 'path';
import { config } from '../../config.js';

/**
 * On-disk layout for library bundles, shared by the private sync router and the public
 * store router so both enforce the exact same containment rules.
 */

export function getItemDir(itemId: string): string {
  // itemId is a client UUID; encode it so it can never escape the storage root.
  return path.resolve(config.LIBRARY_STORAGE_DIR, encodeURIComponent(itemId));
}

export function resolveSafePath(itemDir: string, relativePath: string): string | null {
  const resolved = path.resolve(itemDir, relativePath);
  if (!resolved.startsWith(itemDir + path.sep) && resolved !== itemDir) {
    return null;
  }
  return resolved;
}
