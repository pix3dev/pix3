import { describe, expect, it } from 'vitest';

import type { FileDescriptor } from '@/services/project/FileSystemAPIService';
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
    // A loose root file keeps the category from lifting its lone folder chain.
    const tree = build([
      file('assets/sprites/ui/button.png'),
      file('assets/sprites/ui/panel.png'),
      file('cover.png'),
    ]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.folderLabel).toBeUndefined();
    expect(names(images?.children)).toEqual(['assets/sprites/ui', 'cover.png']);
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
      file('top.png'),
    ]);
    const images = tree.find(node => node.categoryId === 'images');
    const assets = images?.children?.find(node => node.name === 'assets');
    // `assets` holds a file, so it is not merged with `ui/icons` below it.
    expect(assets?.name).toBe('assets');
    expect(names(assets?.children)).toEqual(['ui/icons', 'grass.png']);
  });

  it('prunes folders that contain no files of the category', () => {
    const tree = build([file('assets/audio/theme.ogg'), file('assets/tex/grass.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    // The audio-only branch is pruned, so `assets` collapses straight to `assets/tex`.
    expect(images?.folderLabel).toBe('assets/tex');
    expect(names(images?.children)).toEqual(['grass.png']);
    const audio = tree.find(node => node.categoryId === 'audio');
    expect(audio?.folderLabel).toBe('assets/audio');
    expect(names(audio?.children)).toEqual(['theme.ogg']);
  });

  it('lifts a lone top-level folder into its category and labels it with its path', () => {
    const tree = build([file('images/64x64.png'), file('images/ai.jpg')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.folderLabel).toBe('images');
    expect(images?.folderPath).toBe('images');
    expect(names(images?.children)).toEqual(['64x64.png', 'ai.jpg']);
    expect(images?.children?.every(child => child.nodeType === 'file')).toBe(true);
    expect(images?.fileCount).toBe(2);
  });

  it('uses the compacted chain path as the lifted folder label', () => {
    const tree = build([file('assets/textures/ui/button.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.folderLabel).toBe('assets/textures/ui');
    expect(images?.folderPath).toBe('assets/textures/ui');
    expect(names(images?.children)).toEqual(['button.png']);
  });

  it('leaves folderPath undefined when the category spans multiple folders', () => {
    const tree = build([file('a/one.png'), file('b/two.png'), file('loose.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.folderLabel).toBeUndefined();
    expect(images?.folderPath).toBeUndefined();
  });

  it('keeps nested subfolders visible after lifting the lone root folder', () => {
    const tree = build([file('images/logo.png'), file('images/icons/close.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.folderLabel).toBe('images');
    expect(names(images?.children)).toEqual(['icons', 'logo.png']);
  });

  it('does not lift when the category has multiple top-level folders', () => {
    const tree = build([file('a/one.png'), file('b/two.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.folderLabel).toBeUndefined();
    expect(names(images?.children)).toEqual(['a', 'b']);
  });

  it('does not lift when loose files sit at the category root', () => {
    const tree = build([file('loose.png'), file('folder/inner.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(images?.folderLabel).toBeUndefined();
    expect(names(images?.children)).toEqual(['folder', 'loose.png']);
  });

  it('sorts directories before files within a level', () => {
    const tree = build([file('zebra.png'), file('alpha/nested.png')]);
    const images = tree.find(node => node.categoryId === 'images');
    expect(names(images?.children)).toEqual(['alpha', 'zebra.png']);
  });

  it('sums directory sizes from contained files', () => {
    // A loose root file keeps `tex` as a real dir node rather than lifting it.
    const tree = build([file('tex/a.png', 100), file('tex/deep/b.png', 50), file('cover.png', 7)]);
    const images = tree.find(node => node.categoryId === 'images');
    const tex = images?.children?.find(node => node.name === 'tex');
    expect(tex?.sizeBytes).toBe(150);
  });

  it('expands the same real folder independently per category', () => {
    // Loose root files keep both categories from lifting their `shared` folder.
    const files = [file('shared/a.png'), file('shared/b.mp3'), file('root.png'), file('root.mp3')];
    const tree = build(files, [
      groupedCategoryExpansionKey('images'),
      groupedDirectoryExpansionKey('images', 'shared'),
    ]);

    const images = tree.find(node => node.categoryId === 'images');
    const audio = tree.find(node => node.categoryId === 'audio');
    const imagesShared = images?.children?.find(node => node.name === 'shared');
    const audioShared = audio?.children?.find(node => node.name === 'shared');
    expect(images?.expanded).toBe(true);
    expect(imagesShared?.expanded).toBe(true);
    expect(audio?.expanded).toBe(false);
    expect(audioShared?.expanded).toBe(false);
  });

  it('expands all categories when defaultCategoryExpanded is set', () => {
    const tree = build([file('a.png'), file('b.mp3')], [], true);
    expect(tree.every(node => node.expanded)).toBe(true);
  });

  it('omits file leaves but keeps compaction labels and fileCount when includeFiles is false', () => {
    const options = { expandedKeys: new Set<string>(), defaultCategoryExpanded: true };
    const withFiles = buildGroupedTree([file('assets/textures/ui/button.png', 42)], options);
    const withoutFiles = buildGroupedTree([file('assets/textures/ui/button.png', 42)], {
      ...options,
      includeFiles: false,
    });

    const withImages = withFiles.find(node => node.categoryId === 'images');
    const withoutImages = withoutFiles.find(node => node.categoryId === 'images');

    // Compaction label / folderPath / fileCount are identical with or without files.
    expect(withImages?.folderLabel).toBe('assets/textures/ui');
    expect(withoutImages?.folderLabel).toBe('assets/textures/ui');
    expect(withImages?.folderPath).toBe('assets/textures/ui');
    expect(withoutImages?.folderPath).toBe('assets/textures/ui');
    expect(withImages?.fileCount).toBe(1);
    expect(withoutImages?.fileCount).toBe(1);

    // The file leaf renders by default but is omitted when includeFiles is false.
    expect(names(withImages?.children)).toEqual(['button.png']);
    expect(names(withoutImages?.children)).toEqual([]);
  });

  it('keeps dir sizeBytes and subfolders when includeFiles is false', () => {
    const tree = buildGroupedTree(
      [file('tex/a.png', 100), file('tex/deep/b.png', 50), file('cover.png', 7)],
      { expandedKeys: new Set<string>(), defaultCategoryExpanded: true, includeFiles: false }
    );
    const images = tree.find(node => node.categoryId === 'images');
    // The loose root file (omitted from output) still blocks lifting, so `tex`
    // stays a real dir node.
    expect(images?.folderLabel).toBeUndefined();
    expect(names(images?.children)).toEqual(['tex']);
    const tex = images?.children?.find(node => node.name === 'tex');
    // Directory size still sums nested files even though file leaves are hidden.
    expect(tex?.sizeBytes).toBe(150);
    expect(names(tex?.children)).toEqual(['deep']);
    expect(tex?.children?.every(child => child.nodeType !== 'file')).toBe(true);
  });
});

describe('collectGroupedExpandedKeys', () => {
  it('collects category and directory keys of expanded rows', () => {
    const tree = build(
      [file('shared/a.png'), file('shared/b.mp3'), file('root.png'), file('root.mp3')],
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
