import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetAppState } from '@/state';
import type { FileDescriptor } from '@/services';
import { ASSET_PATH_LIST_MIME } from '@/ui/shared/asset-drag-drop';

const { AssetTree } = await import('./asset-tree');

type AssetTreeElement = HTMLElementTagNameMap['pix3-asset-tree'];

describe('AssetTree', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    resetAppState();
    vi.restoreAllMocks();
  });

  it('renders folders only, with folder sizes that still count nested files', async () => {
    const tree = document.createElement('pix3-asset-tree') as AssetTreeElement;
    stubTreeServices(tree, {
      '.': [
        { name: 'textures', path: 'textures', kind: 'directory', size: 0 },
        { name: 'hero.png', path: 'hero.png', kind: 'file', size: 1536 },
      ],
      textures: [
        { name: 'diffuse.png', path: 'textures/diffuse.png', kind: 'file', size: 1024 },
        { name: 'ui', path: 'textures/ui', kind: 'directory', size: 0 },
      ],
      'textures/ui': [
        { name: 'button.png', path: 'textures/ui/button.png', kind: 'file', size: 2048 },
      ],
    });

    document.body.appendChild(tree);
    // Only the directory renders — files are shown in the content grid, not the tree.
    await vi.waitFor(() => {
      expect(Array.from(tree.querySelectorAll('.node-row'))).toHaveLength(1);
    });

    const rows = Array.from(tree.querySelectorAll('.node-row'));
    expect(rows[0].querySelector('.node-name')?.textContent?.trim()).toBe('textures');
    // Folder size still reflects nested files (diffuse.png 1024 + button.png 2048 = 3.0 KB),
    // proving files still count toward folder size even though they aren't tree rows.
    expect(rows[0].querySelector('.node-meta')?.textContent?.trim()).toBe('3.0 KB');

    // No file (e.g. hero.png) renders as a tree row.
    const names = Array.from(tree.querySelectorAll('.node-name')).map(el =>
      el.textContent?.trim()
    );
    expect(names).not.toContain('hero.png');
  });

  it('groups assets by type with category counts in by-type view', async () => {
    const tree = document.createElement('pix3-asset-tree') as AssetTreeElement;
    stubTreeServices(
      tree,
      {
        '.': [
          { name: 'scenes', path: 'scenes', kind: 'directory', size: 0 },
          { name: 'textures', path: 'textures', kind: 'directory', size: 0 },
        ],
        scenes: [{ name: 'main.pix3scene', path: 'scenes/main.pix3scene', kind: 'file', size: 10 }],
        textures: [{ name: 'ui', path: 'textures/ui', kind: 'directory', size: 0 }],
        'textures/ui': [
          { name: 'button.png', path: 'textures/ui/button.png', kind: 'file', size: 2048 },
          { name: 'panel.png', path: 'textures/ui/panel.png', kind: 'file', size: 1024 },
        ],
      },
      {
        expandedPaths: [],
        selectedPath: null,
        viewMode: 'by-type',
        groupedExpandedKeys: [],
      }
    );

    document.body.appendChild(tree);
    await vi.waitFor(() => {
      expect(Array.from(tree.querySelectorAll('.node-row--category'))).toHaveLength(2);
    });

    // Each category owns a single top-level folder, so it is lifted into the
    // category row and its (compacted) path is shown in parentheses.
    const categoryNames = Array.from(tree.querySelectorAll('.node-row--category .node-name')).map(
      el => el.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(categoryNames).toEqual(['Scenes (scenes)', 'Images (textures/ui)']);

    const counts = Array.from(tree.querySelectorAll('.node-count')).map(el =>
      el.textContent?.trim()
    );
    expect(counts).toEqual(['1', '2']);

    // Folders-only tree: file counts still come from the trie, but file leaf rows
    // are not rendered even in the by-type view.
    const allNames = Array.from(tree.querySelectorAll('.node-name')).map(el =>
      el.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(allNames).not.toContain('main.pix3scene');
    expect(allNames).not.toContain('button.png');
    expect(allNames).not.toContain('panel.png');
  });

  it('opens the mapped folder in the preview when a single-folder category is clicked', async () => {
    const tree = document.createElement('pix3-asset-tree') as AssetTreeElement;
    const { assetsPreviewService } = stubTreeServices(
      tree,
      {
        '.': [
          { name: 'scenes', path: 'scenes', kind: 'directory', size: 0 },
          { name: 'textures', path: 'textures', kind: 'directory', size: 0 },
        ],
        scenes: [{ name: 'main.pix3scene', path: 'scenes/main.pix3scene', kind: 'file', size: 10 }],
        textures: [{ name: 'ui', path: 'textures/ui', kind: 'directory', size: 0 }],
        'textures/ui': [
          { name: 'button.png', path: 'textures/ui/button.png', kind: 'file', size: 2048 },
        ],
      },
      {
        expandedPaths: [],
        selectedPath: null,
        viewMode: 'by-type',
        groupedExpandedKeys: [],
      }
    );

    document.body.appendChild(tree);
    await vi.waitFor(() => {
      expect(Array.from(tree.querySelectorAll('.node-row--category'))).toHaveLength(2);
    });

    assetsPreviewService.syncFromAssetSelection.mockClear();

    const scenesRow = tree.querySelector('.node-row--category') as HTMLElement;
    scenesRow.click();

    // The category maps to exactly one project folder, so clicking it previews that folder.
    expect(assetsPreviewService.syncFromAssetSelection).toHaveBeenCalledWith('scenes', 'directory');
  });

  it('selectPath falls back to the parent folder for a file path', async () => {
    const tree = document.createElement('pix3-asset-tree') as AssetTreeElement;
    const { assetsPreviewService } = stubTreeServices(tree, {
      '.': [{ name: 'textures', path: 'textures', kind: 'directory', size: 0 }],
      textures: [{ name: 'ui', path: 'textures/ui', kind: 'directory', size: 0 }],
      'textures/ui': [
        { name: 'button.png', path: 'textures/ui/button.png', kind: 'file', size: 2048 },
      ],
    });

    document.body.appendChild(tree);
    await vi.waitFor(() => {
      expect(Array.from(tree.querySelectorAll('.node-row')).length).toBeGreaterThan(0);
    });

    assetsPreviewService.syncFromAssetSelection.mockClear();

    // The file is no longer a tree row; selectPath selects its deepest folder and
    // asks the content grid to highlight the file.
    const result = await tree.selectPath('textures/ui/button.png');

    expect(result).toBe(true);
    expect(tree.getSelectedPath()).toBe('textures/ui');
    expect(assetsPreviewService.syncFromAssetSelection).toHaveBeenCalledWith(
      'textures/ui/button.png',
      'file'
    );
  });

  it('moves every path from a multi-path drop with a single confirmation', async () => {
    const tree = document.createElement('pix3-asset-tree') as AssetTreeElement;
    const { projectService, dialogService } = stubTreeServices(tree, {
      '.': [{ name: 'textures', path: 'textures', kind: 'directory', size: 0 }],
      textures: [],
    });

    document.body.appendChild(tree);
    await vi.waitFor(() => {
      expect(Array.from(tree.querySelectorAll('.node-row'))).toHaveLength(1);
    });

    dialogService.showConfirmation.mockResolvedValue(true);

    const payload = new Map<string, string>([
      [ASSET_PATH_LIST_MIME, JSON.stringify(['a.png', 'b.png'])],
    ]);
    const dataTransfer = {
      getData: (type: string) => payload.get(type) ?? '',
    } as unknown as DataTransfer;

    const targetNode = {
      name: 'textures',
      path: 'textures',
      kind: 'directory' as const,
      sizeBytes: 0,
      children: [],
    };

    await (
      tree as unknown as {
        onDrop: (event: DragEvent, node: typeof targetNode) => Promise<void>;
      }
    ).onDrop(
      {
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
        dataTransfer,
      } as unknown as DragEvent,
      targetNode
    );

    expect(dialogService.showConfirmation).toHaveBeenCalledTimes(1);
    expect(projectService.moveItem).toHaveBeenCalledTimes(2);
    expect(projectService.moveItem).toHaveBeenCalledWith('a.png', 'textures/a.png');
    expect(projectService.moveItem).toHaveBeenCalledWith('b.png', 'textures/b.png');
  });

  it('formats byte values consistently', () => {
    const tree = new AssetTree();
    const formatFileSize = (
      tree as unknown as {
        formatFileSize: (sizeBytes: number) => string;
      }
    ).formatFileSize.bind(tree);

    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});

interface StubbedTreeServices {
  projectService: {
    listDirectory: ReturnType<typeof vi.fn>;
    saveAssetBrowserState: ReturnType<typeof vi.fn>;
    loadAssetBrowserState: ReturnType<typeof vi.fn>;
    moveItem: ReturnType<typeof vi.fn>;
  };
  dialogService: { showConfirmation: ReturnType<typeof vi.fn> };
  assetsPreviewService: { syncFromAssetSelection: ReturnType<typeof vi.fn> };
}

function stubTreeServices(
  tree: AssetTreeElement,
  directories: Record<string, FileDescriptor[]>,
  persistedState: {
    expandedPaths: string[];
    selectedPath: string | null;
    viewMode: 'folders' | 'by-type';
    groupedExpandedKeys: string[];
  } | null = null
): StubbedTreeServices {
  const projectService = {
    listDirectory: vi.fn(async (path = '.') => directories[path] ?? []),
    saveAssetBrowserState: vi.fn(),
    loadAssetBrowserState: vi.fn(() => persistedState),
    moveItem: vi.fn(async () => undefined),
  };

  const templateService = {
    getSceneTemplate: vi.fn(() => ''),
  };

  const dialogService = {
    showConfirmation: vi.fn(async () => false),
  };

  const iconService = {
    getIcon: vi.fn(() => 'icon'),
  };

  const assetsPreviewService = {
    syncFromAssetSelection: vi.fn(async () => undefined),
  };

  Object.defineProperty(tree, 'projectService', {
    value: projectService,
    configurable: true,
  });
  Object.defineProperty(tree, 'templateService', {
    value: templateService,
    configurable: true,
  });
  Object.defineProperty(tree, 'dialogService', {
    value: dialogService,
    configurable: true,
  });
  Object.defineProperty(tree, 'iconService', {
    value: iconService,
    configurable: true,
  });
  Object.defineProperty(tree, 'assetsPreviewService', {
    value: assetsPreviewService,
    configurable: true,
  });

  return { projectService, dialogService, assetsPreviewService };
}
