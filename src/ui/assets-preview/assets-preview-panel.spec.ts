import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetPreviewItem, AssetsPreviewSnapshot } from '@/services/AssetsPreviewService';
import type { AssetFileActivationService, AssetsPreviewService, IconService } from '@/services';

vi.mock('@/services', () => ({
  AssetFileActivationService: class AssetFileActivationService {},
  AssetsPreviewService: class AssetsPreviewService {},
  IconService: class IconService {},
}));

const { AssetsPreviewPanel } = await import('./assets-preview-panel');
type AssetsPreviewPanelElement = HTMLElementTagNameMap['pix3-assets-preview-panel'];

const createSnapshot = (items: AssetPreviewItem[]): AssetsPreviewSnapshot => ({
  selectedFolderPath: '.',
  displayPath: 'res://',
  isLoading: false,
  errorMessage: null,
  selectedItemPath: null,
  selectedItem: null,
  items,
});

describe('AssetsPreviewPanel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders inline file size for files', async () => {
    const panel = document.createElement('pix3-assets-preview-panel') as AssetsPreviewPanelElement;
    stubPanelServices(
      panel,
      createSnapshot([
        createItem({
          name: 'sprite.png',
          path: 'assets/sprite.png',
          kind: 'file',
          sizeBytes: 1536,
        }),
      ])
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const meta = panel.querySelector('.meta');
    expect(meta?.textContent?.trim()).toBe('1.5 KB');
  });

  it('does not render inline file size for directories', async () => {
    const panel = document.createElement('pix3-assets-preview-panel') as AssetsPreviewPanelElement;
    stubPanelServices(
      panel,
      createSnapshot([
        createItem({
          name: 'textures',
          path: 'assets/textures',
          kind: 'directory',
          sizeBytes: null,
        }),
      ])
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.querySelector('.meta')).toBeNull();
  });

  it('renders a spinner while a model thumbnail is generating', async () => {
    const panel = document.createElement('pix3-assets-preview-panel') as AssetsPreviewPanelElement;
    stubPanelServices(
      panel,
      createSnapshot([
        createItem({
          name: 'crate.glb',
          path: 'assets/crate.glb',
          kind: 'file',
          previewType: 'model',
          thumbnailStatus: 'loading',
        }),
      ])
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.querySelector('.thumb-spinner')).not.toBeNull();
  });

  it('marks file tiles as explicitly draggable, including icon-only assets', async () => {
    const panel = document.createElement('pix3-assets-preview-panel') as AssetsPreviewPanelElement;
    stubPanelServices(
      panel,
      createSnapshot([
        createItem({
          name: 'sprite.png',
          path: 'assets/sprite.png',
          kind: 'file',
          previewType: 'image',
          thumbnailUrl: 'blob://sprite',
        }),
        createItem({
          name: 'logic.ts',
          path: 'assets/logic.ts',
          kind: 'file',
          previewType: 'icon',
        }),
        createItem({
          name: 'textures',
          path: 'assets/textures',
          kind: 'directory',
        }),
      ])
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const items = panel.querySelectorAll<HTMLButtonElement>('.assets-preview-item');
    expect(items[0]?.getAttribute('draggable')).toBe('true');
    expect(items[1]?.getAttribute('draggable')).toBe('true');
    expect(items[2]?.getAttribute('draggable')).toBe('false');
  });

  it('requests a model thumbnail when selecting a 3D asset', async () => {
    const panel = document.createElement('pix3-assets-preview-panel') as AssetsPreviewPanelElement;
    const services = stubPanelServices(
      panel,
      createSnapshot([
        createItem({
          name: 'crate.glb',
          path: 'assets/crate.glb',
          kind: 'file',
          previewType: 'model',
          thumbnailStatus: 'loading',
        }),
      ])
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const button = panel.querySelector('.assets-preview-item');
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(services.assetsPreviewService.selectItem).toHaveBeenCalledWith('assets/crate.glb');
    expect(services.assetsPreviewService.requestThumbnail).toHaveBeenCalledWith('assets/crate.glb');
  });

  it('supports ctrl-multiselect and drags all selected files', async () => {
    const panel = document.createElement('pix3-assets-preview-panel') as AssetsPreviewPanelElement;
    stubPanelServices(
      panel,
      createSnapshot([
        createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
        createItem({ name: 'b.png', path: 'assets/b.png', kind: 'file', previewType: 'image' }),
      ])
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const buttons = panel.querySelectorAll('.assets-preview-item');
    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await panel.updateComplete;

    const dataTransfer = {
      effectAllowed: '',
      setData: vi.fn(),
    };
    (
      panel as unknown as {
        onItemDragStart: (event: DragEvent, item: AssetPreviewItem) => void;
      }
    ).onItemDragStart(
      {
        dataTransfer: dataTransfer as unknown as DataTransfer,
      } as DragEvent,
      createItem({ name: 'b.png', path: 'assets/b.png', kind: 'file', previewType: 'image' })
    );

    expect(panel.querySelectorAll('.assets-preview-item.is-selected')).toHaveLength(2);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/x-pix3-asset-resource-list',
      JSON.stringify(['res://assets/a.png', 'res://assets/b.png'])
    );
  });

  it('renders text snippets for text preview assets', async () => {
    const panel = document.createElement('pix3-assets-preview-panel') as AssetsPreviewPanelElement;
    stubPanelServices(
      panel,
      createSnapshot([
        createItem({
          name: 'config.yaml',
          path: 'assets/config.yaml',
          kind: 'file',
          previewType: 'text',
          previewText: 'name: demo\nmode: editor',
        }),
      ])
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const textThumb = panel.querySelector('.text-thumb');
    expect(textThumb?.textContent).toContain('name: demo');
    expect(textThumb?.textContent).toContain('mode: editor');
  });

  it('formats bytes, KB, and MB consistently', () => {
    const panel = new AssetsPreviewPanel();
    const formatFileSize = (
      panel as unknown as {
        formatFileSize: (sizeBytes: number) => string;
      }
    ).formatFileSize.bind(panel);

    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});

function stubPanelServices(panel: AssetsPreviewPanelElement, snapshot: AssetsPreviewSnapshot) {
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

  Object.defineProperty(panel, 'assetsPreviewService', {
    value: assetsPreviewService,
    configurable: true,
  });
  Object.defineProperty(panel, 'assetFileActivationService', {
    value: assetFileActivationService,
    configurable: true,
  });
  Object.defineProperty(panel, 'iconService', {
    value: iconService,
    configurable: true,
  });

  return {
    assetsPreviewService,
  };
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
