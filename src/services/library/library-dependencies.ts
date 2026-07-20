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

/**
 * `user:<ClassName>` component types referenced in serialized scene text, distinct and
 * order-preserving. These are class-name references (not `res://` paths), so the caller must
 * resolve each name to its project script file to bundle it — see the publish flow.
 */
const USER_COMPONENT_TOKEN = /\buser:([A-Za-z_$][A-Za-z0-9_$]*)/g;

export function collectUserComponentTypes(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(USER_COMPONENT_TOKEN)) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * Relative import/export specifiers (`./x`, `../x`) in TypeScript/JavaScript source, distinct and
 * order-preserving. Bare package specifiers (`three`, `@pix3/runtime`) and alias imports (`@/…`)
 * are ignored — only project-relative siblings are bundled. Covers `import … from '…'`,
 * `export … from '…'`, side-effect `import '…'`, and dynamic `import('…')`.
 */
const RELATIVE_SPECIFIER_TOKENS: readonly RegExp[] = [
  // import ... from '...'  |  export ... from '...'
  /(?:import|export)\b[^'"`;]*?\bfrom\s*['"`](\.[^'"`]*)['"`]/g,
  // bare side-effect import '...'
  /\bimport\s*['"`](\.[^'"`]*)['"`]/g,
  // dynamic import('...')
  /\bimport\s*\(\s*['"`](\.[^'"`]*)['"`]\s*\)/g,
];

export function collectRelativeImports(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of RELATIVE_SPECIFIER_TOKENS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        found.add(specifier);
      }
    }
  }
  return [...found];
}

/**
 * Ordered candidate project paths a relative `specifier` (imported from `fromFile`) may resolve
 * to. The caller probes them in order against storage and uses the first that exists. Handles
 * extensionless imports (the common TS case) and directory index files.
 */
export function resolveImportCandidates(fromFile: string, specifier: string): string[] {
  const fromDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1);
  const segments = [...fromDir];
  for (const part of specifier.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const base = segments.join('/');
  const hasExtension = /\.[A-Za-z0-9]+$/.test(specifier);
  const candidates = hasExtension
    ? [base]
    : [`${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`];
  return [...new Set(candidates)];
}
