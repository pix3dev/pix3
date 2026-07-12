/**
 * Pure dependency scanning for "Publish to Library".
 *
 * A prefab/scene bundle must carry every file it references. `SaveAsPrefabOperation`
 * serializes a subtree verbatim (absolute `res://` paths, no dependency collection), so
 * publish walks the serialized text itself: it extracts `res://` references (textures,
 * audio, nested `instance:` prefabs), and the caller recurses into nested `.pix3scene`
 * files. The extraction is text-based, mirroring `ProjectService`'s regex remap.
 */

import { getAssetPathExtension } from '@/core/asset-categories';

const RES_TOKEN = /res:\/\/[^\s"'`)\]}]+/g;
/** Trailing characters that commonly abut a path token in YAML/JSON but are not part of it. */
const TRAILING_JUNK = /[),.;:\]}]+$/;

/**
 * Extract distinct `res://` references from serialized scene/script text, order-preserving.
 * Returns full `res://…` URIs (trailing punctuation stripped).
 */
export function collectResourceReferences(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(RES_TOKEN)) {
    const cleaned = match[0].replace(TRAILING_JUNK, '');
    if (cleaned.length > 'res://'.length) {
      found.add(cleaned);
    }
  }
  return [...found];
}

/** Strip the `res://` scheme, yielding a project-relative path. */
export function stripResScheme(reference: string): string {
  return reference.startsWith('res://') ? reference.slice('res://'.length) : reference;
}

/** Whether a `res://` reference points at a scene/prefab file we should recurse into. */
export function isSceneReference(reference: string): boolean {
  const ext = getAssetPathExtension(stripResScheme(reference));
  return ext === 'pix3scene' || ext === 'pix3prefab';
}

/** Whether a `res://` reference points at a script we should copy into the bundle. */
export function isScriptReference(reference: string): boolean {
  const ext = getAssetPathExtension(stripResScheme(reference));
  return ext === 'ts' || ext === 'js' || ext === 'mjs';
}
