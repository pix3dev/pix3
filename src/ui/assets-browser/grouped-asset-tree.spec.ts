import { describe, expect, it } from 'vitest';

import type { FileDescriptor } from '@/services/FileSystemAPIService';
import { groupedCategoryExpansionKey, groupedDirectoryExpansionKey } from '@/core/asset-categories';
import {
  buildGroupedTree,
  categoryIdFromPath,
  categoryPathFor,
  collectGroupedExpandedKeys,
  isCategoryPath,
  type AssetTreeNode,
} from './grouped-asset-tree';

const file = (path: string, size = 0): FileDescriptor => ({
  name: path.split('/').pop() ?? path,
  kind: 'file',
  path,
  size,
});

const build = (files: FileDescriptor[], expandedKeys: string[] = [], defaultExpanded = false) =>
  buildGroupedTree(files, {
    expandedKeys: new Set(expandedKeys),
    defaultCategoryExpanded: defaultExpanded,
  });

const names = (nodes: AssetTreeNode[] | null | undefined): string[] =>
  (nodes ?? []).map(node => node.name);

describe('buildGroupedTree', () => {
  it('hides empty categories and keeps the fixed display order', () => {
    const tree = build([file('theme.mp3'), file('main.pix3scene'), file('hero.png')]);
    expect(names(tree)).toEqual(['Scenes', 'Images', 'Audio']);
    expect(tree.every(node => node.nodeType === 'category')).toBe(true);
  });

  it('counts all category files recursively and skips size meta', () => {
    const tree = build([file('a.png', 10), file('deep/nested/b.png', 20), file('c.pix3scene')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.fileCount).toBe(2);
    expect(images?.sizeBytes).toBeNull();
    expect(images?.path).toBe(categoryPathFor('images'));
  });

  it('compacts single-child folder chains into one node with the deepest real path', () => {
    const tree = build([file('assets/sprites/ui/button.png'), file('assets/sprites/ui/panel.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(names(images?.children)).toEqual(['assets/sprites/ui']);
    const chain = images?.children?.[0];
    expect(chain?.path).toBe('assets/sprites/ui');
    expect(chain?.nodeType).toBe('dir');
    expect(names(chain?.children)).toEqual(['button.png', 'panel.png']);
  });

  it('breaks compaction at folders with files or multiple subfolders', () => {
    const tree = build([
      file('assets/grass.png'),
      file('assets/ui/icons/close.png'),
      file('assets/ui/icons/open.png'),
    ]);
    const images = tree.find(node => node.categoryId === 'images');
    const assets = images?.children?.[0];
    // `assets` holds a file, so it is not merged with `ui/icons` below it.
    expect(assets?.name).toBe('assets');
    expect(names(assets?.children)).toEqual(['ui/icons', 'grass.png']);
  });

  it('prunes folders that contain no files of the category', () => {
    const tree = build([file('assets/audio/theme.ogg'), file('assets/tex/grass.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(names(images?.children)).toEqual(['assets/tex']);
    const audio = tree.find(node => node.categoryId === 'audio');
    expect(names(audio?.children)).toEqual(['assets/audio']);
  });

  it('sorts directories before files within a level', () => {
    const tree = build([file('zebra.png'), file('alpha/nested.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(names(images?.children)).toEqual(['alpha', 'zebra.png']);
  });

  it('sums directory sizes from contained files', () => {
    const tree = build([file('tex/a.png', 100), file('tex/deep/b.png', 50)]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.children?.[0]?.sizeBytes).toBe(150);
  });

  it('expands the same real folder independently per category', () => {
    const files = [file('shared/a.png'), file('shared/b.mp3')];
    const tree = build(files, [
      groupedCategoryExpansionKey('images'),
      groupedDirectoryExpansionKey('images', 'shared'),
    ]);

    const images = tree.find(node => node.categoryId === 'images');
    const audio = tree.find(node => node.categoryId === 'audio');
    expect(images?.expanded).toBe(true);
    expect(images?.children?.[0]?.expanded).toBe(true);
    expect(audio?.expanded).toBe(false);
    expect(audio?.children?.[0]?.expanded).toBe(false);
  });

  it('expands all categories when defaultCategoryExpanded is set', () => {
    const tree = build([file('a.png'), file('b.mp3')], [], true);
    expect(tree.every(node => node.expanded)).toBe(true);
  });
});

describe('collectGroupedExpandedKeys', () => {
  it('collects category and directory keys of expanded rows', () => {
    const tree = build(
      [file('shared/a.png'), file('shared/b.mp3')],
      [groupedCategoryExpansionKey('images'), groupedDirectoryExpansionKey('images', 'shared')]
    );

    const keys = new Set<string>();
    collectGroupedExpandedKeys(tree, keys);
    expect(keys).toEqual(
      new Set([
        groupedCategoryExpansionKey('images'),
        groupedDirectoryExpansionKey('images', 'shared'),
      ])
    );
  });
});

describe('category path helpers', () => {
  it('detects and parses virtual category paths', () => {
    expect(isCategoryPath(categoryPathFor('scenes'))).toBe(true);
    expect(isCategoryPath('scenes/main.pix3scene')).toBe(false);
    expect(isCategoryPath(null)).toBe(false);
    expect(categoryIdFromPath(categoryPathFor('audio'))).toBe('audio');
    expect(categoryIdFromPath('category:not-a-category')).toBeNull();
    expect(categoryIdFromPath('scenes/main.pix3scene')).toBeNull();
  });
});
