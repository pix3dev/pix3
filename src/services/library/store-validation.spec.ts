import { describe, expect, it } from 'vitest';

import type { LibraryItemManifest } from '@/services/library/library-types';
import { STORE_LICENSE_WHITELIST, validateStorePublish } from '@/services/library/store-validation';

/** A manifest that satisfies every publish requirement; specs knock out one field at a time. */
function publishable(overrides: Partial<LibraryItemManifest> = {}): LibraryItemManifest {
  return {
    id: 'item-1',
    slug: 'fancy-button',
    name: 'Fancy Button',
    type: 'prefab',
    tags: ['ui'],
    categoryPath: 'ui/buttons',
    description: 'A button.',
    license: 'CC0-1.0',
    preview: 'preview.webp',
    entry: 'prefab.pix3scene',
    files: ['prefab.pix3scene', 'preview.webp'],
    source: 'packed',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function fields(manifest: Partial<LibraryItemManifest>): string[] {
  return validateStorePublish(manifest).map(issue => issue.field);
}

describe('validateStorePublish', () => {
  it('accepts a complete manifest', () => {
    expect(validateStorePublish(publishable())).toEqual([]);
  });

  it.each([
    ['name', { name: '   ' }],
    ['categoryPath', { categoryPath: undefined }],
    ['description', { description: '' }],
    ['preview', { preview: undefined }],
  ] as const)('requires %s', (field, override) => {
    expect(fields(publishable(override))).toEqual([field]);
  });

  it('requires at least one tag', () => {
    expect(fields(publishable({ tags: [] }))).toEqual(['tags']);
  });

  it('rejects a license outside the whitelist', () => {
    const issues = validateStorePublish(publishable({ license: 'GPL-3.0' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe('license');
    expect(issues[0]!.message).toContain(STORE_LICENSE_WHITELIST[0]);
  });

  it.each(STORE_LICENSE_WHITELIST)('accepts the whitelisted license %s', license => {
    expect(validateStorePublish(publishable({ license }))).toEqual([]);
  });

  it('reports every missing field at once', () => {
    const issues = fields({ id: 'x', slug: 'x', files: [] } as Partial<LibraryItemManifest>);
    expect(issues.sort()).toEqual(
      ['categoryPath', 'description', 'license', 'name', 'preview', 'tags'].sort()
    );
  });

  it('rejects a non-object manifest', () => {
    expect(validateStorePublish(null)).toEqual([
      { field: 'manifest', message: 'Manifest must be an object' },
    ]);
  });
});
