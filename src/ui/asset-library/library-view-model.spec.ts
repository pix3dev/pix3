import { describe, expect, it } from 'vitest';

import { LIBRARY_SOURCES, type LibrarySourceConfig } from '@/services/library/library-sources';
import type { LibraryItem, LibraryItemManifest } from '@/services/library/library-types';
import {
  formatDownloads,
  hasStatusChip,
  matchesCategorySelection,
  publisherLabel,
  statusIcon,
  statusLabel,
  storeStatus,
} from './library-view-model';

function source(id: string): LibrarySourceConfig {
  const found = LIBRARY_SOURCES.find(entry => entry.id === id);
  if (!found) {
    throw new Error(`Unknown test source ${id}`);
  }
  return found;
}

function manifest(overrides: Partial<LibraryItemManifest> = {}): LibraryItemManifest {
  return {
    id: 'item-1',
    slug: 'item-1',
    name: 'Item 1',
    type: 'image',
    tags: [],
    files: [],
    source: 'imported',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function item(overrides: Partial<LibraryItemManifest> = {}): LibraryItem {
  return { scope: 'store', manifest: manifest(overrides) };
}

describe('storeStatus', () => {
  it('treats a manifest without a status as published (pre-store bundles)', () => {
    expect(storeStatus(manifest())).toBe('published');
    expect(hasStatusChip(storeStatus(manifest()))).toBe(false);
  });

  it('maps each lifecycle state to a label and a vector icon name', () => {
    expect(statusLabel('draft')).toBe('Draft');
    expect(statusLabel('unlisted')).toBe('Unlisted');
    expect(statusLabel('published')).toBe('Published');
    // Icon names must be Feather ids, never glyphs.
    expect(statusIcon('draft')).toBe('edit-3');
    expect(statusIcon('unlisted')).toBe('eye-off');
    expect(statusIcon('published')).toBe('check-circle');
  });

  it('only chips the states that need attention', () => {
    expect(hasStatusChip('draft')).toBe(true);
    expect(hasStatusChip('unlisted')).toBe(true);
    expect(hasStatusChip('published')).toBe(false);
  });
});

describe('formatDownloads', () => {
  it('renders small counts verbatim and a missing count as zero', () => {
    expect(formatDownloads(undefined)).toBe('0');
    expect(formatDownloads(0)).toBe('0');
    expect(formatDownloads(942)).toBe('942');
  });

  it('compacts thousands and millions', () => {
    expect(formatDownloads(1000)).toBe('1k');
    expect(formatDownloads(1234)).toBe('1.2k');
    expect(formatDownloads(1_500_000)).toBe('1.5M');
  });
});

describe('publisherLabel', () => {
  it('prefers the server-supplied publisher name', () => {
    expect(
      publisherLabel(item({ publisherName: 'Pix3 Labs', authorId: 'u-1' }), source('store'))
    ).toBe('Pix3 Labs');
  });

  it('falls back to the legacy authorId, then to the synthesized team name', () => {
    expect(publisherLabel(item({ authorId: 'u-1' }), source('store'))).toBe('u-1');
    expect(publisherLabel(item(), source('store'))).toBe('Pix3 Team');
    expect(publisherLabel(item(), source('kenney'))).toBe('Kenney.nl');
  });
});

describe('matchesCategorySelection', () => {
  it('lets everything through the aggregate', () => {
    expect(matchesCategorySelection(manifest({ categoryPath: 'ui' }), 'all')).toBe(true);
    expect(matchesCategorySelection(manifest(), 'all')).toBe(true);
  });

  it('includes store subcategories under their parent rail row', () => {
    expect(matchesCategorySelection(manifest({ categoryPath: 'ui/buttons' }), 'ui')).toBe(true);
    expect(matchesCategorySelection(manifest({ categoryPath: 'ui-kit' }), 'ui')).toBe(false);
  });

  it('narrows to one exact path once a subcategory chip is active', () => {
    expect(
      matchesCategorySelection(manifest({ categoryPath: 'ui/buttons' }), 'ui', 'ui/buttons')
    ).toBe(true);
    expect(matchesCategorySelection(manifest({ categoryPath: 'ui' }), 'ui', 'ui/buttons')).toBe(
      false
    );
  });

  it('keeps matching user/team items on the flat category field', () => {
    expect(matchesCategorySelection(manifest({ category: 'brand' }), 'brand')).toBe(true);
    expect(matchesCategorySelection(manifest({ category: 'brand' }), 'ui')).toBe(false);
  });
});
