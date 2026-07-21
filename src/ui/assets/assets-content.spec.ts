import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AssetPreviewItem,
  AssetsPreviewSnapshot,
  AssetsPreviewService,
} from '@/services/AssetsPreviewService';
import type { AssetFileActivationService } from '@/services/AssetFileActivationService';
import type { IconService } from '@/services/IconService';
import type { ProjectService } from '@/services/ProjectService';

vi.mock('@/services/AssetFileActivationService', () => ({
  AssetFileActivationService: class AssetFileActivationService {},
}));
vi.mock('@/services/AssetsPreviewService', () => ({
  AssetsPreviewService: class AssetsPreviewService {},
}));
vi.mock('@/services/IconService', () => ({
  IconService: class IconService {},
  IconSize: { SMALL: 14, MEDIUM: 16, LARGE: 18, XLARGE: 24 },
}));
vi.mock('@/services/ProjectService', () => ({
  ProjectService: class ProjectService {},
}));

await import('./assets-content');
type AssetsContentElement = HTMLElementTagNameMap['pix3-assets-content'];

const createSnapshot = (overrides: Partial<AssetsPreviewSnapshot> = {}): AssetsPreviewSnapshot => ({
  selectedFolderPath: '.',
  displayPath: 'res://',
  isLoading: false,
  errorMessage: null,
  selectedItemPath: null,
  selectedItem: null,
  items: [],
  folderItemCount: null,
  folderSizeBytes: null,
  ...overrides,
});

describe('AssetsContent (Phase 3 header)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders breadcrumb segments and emits folder-navigate on click', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(panel, createSnapshot({ selectedFolderPath: 'assets/textures' }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    const crumbs = panel.querySelectorAll<HTMLButtonElement>('.crumb');
    // root + "assets" + "textures"
    expect(crumbs).toHaveLength(3);
    expect(crumbs[2]?.classList.contains('is-active')).toBe(true);
    expect(crumbs[2]?.disabled).toBe(true);

    const events: Array<{ path: string }> = [];
    panel.addEventListener('folder-navigate', event => {
      events.push((event as CustomEvent<{ path: string }>).detail);
    });

    crumbs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events).toEqual([{ path: 'assets' }]);
  });

  it('emits folder-navigate with "." from the root breadcrumb', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(panel, createSnapshot({ selectedFolderPath: 'assets/textures' }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    const events: Array<{ path: string }> = [];
    panel.addEventListener('folder-navigate', event => {
      events.push((event as CustomEvent<{ path: string }>).detail);
    });

    panel
      .querySelector<HTMLButtonElement>('.crumb')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events).toEqual([{ path: '.' }]);
  });

  it('renders the folder stats line from snapshot fields', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(panel, createSnapshot({ folderItemCount: 2, folderSizeBytes: 3072 }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    const stats = panel.querySelector('.assets-folder-stats');
    expect(stats?.textContent).toContain('2 items');
    expect(stats?.textContent).toContain('3.0 KB');
  });

  it('renders list-view rows when the persisted view is "list"', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        items: [
          createItem({
            name: 'sprite.png',
            path: 'assets/sprite.png',
            kind: 'file',
            previewType: 'image',
            width: 64,
            height: 32,
            sizeBytes: 1536,
          }),
        ],
      }),
      { contentView: 'list' }
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const rows = panel.querySelectorAll('.assets-list-row');
    expect(rows).toHaveLength(1);
    expect(panel.querySelector('.assets-preview-grid')).toBeNull();
    expect(rows[0]?.querySelector('.row-dim')?.textContent).toContain('64×32');
    expect(rows[0]?.querySelector('.row-size')?.textContent).toContain('1.5 KB');
  });

  it('updates the --assets-thumb-size CSS var from the slider', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(panel, createSnapshot({ items: [] }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    const slider = panel.querySelector<HTMLInputElement>('.assets-thumb-slider');
    expect(slider).not.toBeNull();
    slider!.value = '128';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    expect(panel.style.getPropertyValue('--assets-thumb-size')).toBe('128px');
  });

  it('exposes the current grid selection via getSelectedPaths()', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        items: [
          createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
          createItem({ name: 'b.png', path: 'assets/b.png', kind: 'file', previewType: 'image' }),
        ],
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const buttons = panel.querySelectorAll('.assets-preview-item');
    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await panel.updateComplete;

    expect(panel.getSelectedPaths().sort()).toEqual(['assets/a.png', 'assets/b.png']);
  });

  it('emits content-delete-request for the multi-selection', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        items: [
          createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
          createItem({ name: 'b.png', path: 'assets/b.png', kind: 'file', previewType: 'image' }),
        ],
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const buttons = panel.querySelectorAll('.assets-preview-item');
    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await panel.updateComplete;

    // Right-click a member of the selection: keeps the multi-selection.
    buttons[1]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await panel.updateComplete;

    const events: Array<{ paths: string[] }> = [];
    panel.addEventListener('content-delete-request', event => {
      events.push((event as CustomEvent<{ paths: string[] }>).detail);
    });

    document
      .querySelectorAll<HTMLButtonElement>('.assets-preview-context-menu button[role="menuitem"]')
      .forEach(button => {
        if (button.textContent?.trim() === 'Delete') {
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      });

    expect(events).toHaveLength(1);
    expect(events[0]?.paths.sort()).toEqual(['assets/a.png', 'assets/b.png']);
  });
});

function stubServices(
  panel: AssetsContentElement,
  snapshot: AssetsPreviewSnapshot,
  // Default to explicit grid prefs so tests are deterministic despite the shared,
  // mutation-carrying real appState between cases.
  persisted: { thumbnailSize?: number; contentView?: 'grid' | 'list' } | null = {
    thumbnailSize: 104,
    contentView: 'grid',
  }
) {
  const assetsPreviewService: Pick<
    AssetsPreviewService,
    'subscribe' | 'selectItem' | 'requestThumbnail'
  > = {
    subscribe(listener: (value: AssetsPreviewSnapshot) => void) {
      listener(snapshot);
      return () => undefined;
    },
    selectItem: vi.fn(),
    requestThumbnail: vi.fn(),
  };

  const assetFileActivationService: Pick<AssetFileActivationService, 'handleActivation'> = {
    handleActivation: vi.fn(async () => undefined),
  };

  const iconService: Pick<IconService, 'getIcon'> = {
    getIcon: vi.fn(() => 'icon' as unknown as ReturnType<IconService['getIcon']>),
  };

  const projectService: Pick<ProjectService, 'loadAssetBrowserState' | 'saveAssetBrowserState'> = {
    loadAssetBrowserState: vi.fn(() =>
      persisted
        ? {
            expandedPaths: [],
            selectedPath: null,
            viewMode: 'folders' as const,
            groupedExpandedKeys: [],
            thumbnailSize: persisted.thumbnailSize,
            contentView: persisted.contentView,
          }
        : null
    ),
    saveAssetBrowserState: vi.fn(),
  };

  for (const [key, value] of Object.entries({
    assetsPreviewService,
    assetFileActivationService,
    iconService,
    projectService,
  })) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  return { assetsPreviewService, projectService };
}

function createItem(
  overrides: Partial<AssetPreviewItem> & Pick<AssetPreviewItem, 'name' | 'path' | 'kind'>
): AssetPreviewItem {
  return {
    name: overrides.name,
    path: overrides.path,
    kind: overrides.kind,
    previewType: overrides.previewType ?? 'icon',
    thumbnailUrl: overrides.thumbnailUrl ?? null,
    previewUrl: overrides.previewUrl ?? null,
    previewText: overrides.previewText ?? null,
    thumbnailStatus: overrides.thumbnailStatus ?? 'idle',
    iconName: overrides.iconName ?? 'file',
    extension: overrides.extension ?? '',
    sizeBytes: overrides.sizeBytes ?? null,
    width: overrides.width ?? null,
    height: overrides.height ?? null,
    durationSeconds: overrides.durationSeconds ?? null,
    channelCount: overrides.channelCount ?? null,
    sampleRate: overrides.sampleRate ?? null,
    lastModified: overrides.lastModified ?? null,
  };
}
