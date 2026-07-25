/**
 * Publish gate for curated Asset Store items — the editor-side copy.
 *
 * This is a deliberate duplicate of
 * `packages/pix3-collab-server/src/core/library/store-validation.ts`: the editor and the collab
 * server are separate TypeScript projects with no shared workspace package, and standing one up
 * for ~40 lines of rules is not worth it yet (plan §11.6). The server copy is authoritative — it
 * runs on every upload/PATCH regardless of what the UI thinks; this copy only exists so the panel
 * can list the missing fields before the round-trip. Keep the two in sync; at a third duplicate,
 * extract `@pix3/library-shared`.
 */

import type { LibraryItemManifest } from '@/services/library/library-types';

/** Licenses a public item may carry. The license text itself ships as a file in the bundle. */
export const STORE_LICENSE_WHITELIST = ['OFL-1.1', 'CC0-1.0', 'MIT', 'CC-BY-4.0'] as const;

export type StoreLicense = (typeof STORE_LICENSE_WHITELIST)[number];

export interface StoreValidationIssue {
  field: string;
  message: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Returns every unmet requirement; an empty array means the manifest may go `published`. */
export function validateStorePublish(
  manifest: Partial<LibraryItemManifest> | null | undefined
): StoreValidationIssue[] {
  const issues: StoreValidationIssue[] = [];

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return [{ field: 'manifest', message: 'Manifest must be an object' }];
  }

  if (!nonEmptyString(manifest.name)) {
    issues.push({ field: 'name', message: 'Name is required' });
  }
  if (!nonEmptyString(manifest.categoryPath)) {
    issues.push({ field: 'categoryPath', message: 'A store category is required' });
  }
  if (!nonEmptyString(manifest.description)) {
    issues.push({ field: 'description', message: 'Description is required' });
  }
  if (
    !nonEmptyString(manifest.license) ||
    !(STORE_LICENSE_WHITELIST as readonly string[]).includes(manifest.license)
  ) {
    issues.push({
      field: 'license',
      message: `License must be one of: ${STORE_LICENSE_WHITELIST.join(', ')}`,
    });
  }
  if (!nonEmptyString(manifest.preview)) {
    issues.push({ field: 'preview', message: 'A preview image is required' });
  }
  if (!Array.isArray(manifest.tags) || manifest.tags.length === 0) {
    issues.push({ field: 'tags', message: 'At least one tag is required' });
  }

  return issues;
}
