import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AssetPreviewItem,
  AssetsPreviewSnapshot,
  AssetsPreviewService,
} from '@/services/assets/AssetsPreviewService';
import type { AssetFileActivationService } from '@/services/assets/AssetFileActivationService';
import type { IconService } from '@/services/editor/IconService';
import type { ProjectService } from '@/services/project/ProjectService';

vi.mock('@/services/assets/AssetFileActivationService', () => ({
  AssetFileActivationService: class AssetFileActivationService {},
}));
vi.mock('@/services/assets/AssetsPreviewService', () => ({
  AssetsPreviewService: class AssetsPreviewService {},
}));
vi.mock('@/services/editor/IconService', () => ({
  IconService: class IconService {},
  IconSize: { SMALL: 14, MEDIUM: 16, LARGE: 18, XLARGE: 24 },
}));
vi.mock('@/services/project/ProjectService', () => ({
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

  it('previews audio from the grid card and reflects the playhead', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(panel, createSnapshot({ items: [audioItem()] }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    const toggle = panel.querySelector<HTMLElement>('.audio-play-btn');
    expect(toggle).not.toBeNull();
    expect(panel.querySelector('.audio-progress')).toBeNull();

    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.updateComplete;

    expect(panel.querySelector('.audio-play-btn.is-playing')).not.toBeNull();
    // Duration comes from the analyzed metadata, so the clock is live immediately.
    expect(panel.querySelector('.meta')?.textContent).toContain('0:00 / 0:12');

    const audio = getPreviewElement(panel);
    audio.currentTime = 3;
    audio.dispatchEvent(new Event('timeupdate'));
    await panel.updateComplete;

    expect(panel.querySelector('.meta')?.textContent).toContain('0:03 / 0:12');
    expect(panel.querySelector<HTMLElement>('.audio-progress')?.style.cssText).toContain('0.25');

    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.updateComplete;

    expect(panel.querySelector('.audio-play-btn.is-playing')).toBeNull();
    expect(panel.querySelector('.audio-progress')).toBeNull();
  });

  it('stops the preview when playback ends', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(panel, createSnapshot({ items: [audioItem()] }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    panel
      .querySelector<HTMLElement>('.audio-play-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.updateComplete;

    getPreviewElement(panel).dispatchEvent(new Event('ended'));
    await panel.updateComplete;

    expect(panel.querySelector('.audio-play-btn.is-playing')).toBeNull();
  });

  it('offers an inline audio toggle and duration column in list view', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(panel, createSnapshot({ items: [audioItem()] }), {
      thumbnailSize: 104,
      contentView: 'list',
    });

    document.body.appendChild(panel);
    await panel.updateComplete;

    const row = panel.querySelector('.assets-list-row');
    expect(row?.querySelector('.audio-play-btn.is-inline')).not.toBeNull();
    expect(row?.querySelector('.row-dim')?.textContent).toContain('0:12');

    row
      ?.querySelector<HTMLElement>('.audio-play-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.updateComplete;

    expect(panel.querySelector('.assets-list-row.is-playing')).not.toBeNull();
    expect(panel.querySelector('.row-audio-progress')).not.toBeNull();
    expect(panel.querySelector('.row-dim')?.textContent).toContain('0:00 / 0:12');
  });

  it('toggles the preview of the selected audio asset with Space', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        items: [
          audioItem(),
          createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
        ],
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const card = panel.querySelector<HTMLButtonElement>('.assets-preview-item');
    card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.updateComplete;

    const keyDown = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    card!.dispatchEvent(keyDown);
    await panel.updateComplete;

    // The default must be suppressed: the cards are buttons and Space would re-activate them.
    expect(keyDown.defaultPrevented).toBe(true);
    expect(panel.querySelector('.audio-play-btn.is-playing')).not.toBeNull();

    card!.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    );
    await panel.updateComplete;

    expect(panel.querySelector('.audio-play-btn.is-playing')).toBeNull();
  });

  it('ignores Space when the selected asset is not previewable audio', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        items: [
          createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
        ],
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const card = panel.querySelector<HTMLButtonElement>('.assets-preview-item');
    card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await panel.updateComplete;

    const keyDown = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    card!.dispatchEvent(keyDown);

    expect(keyDown.defaultPrevented).toBe(false);
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

  it('keeps a shift-range selection when the preview service echoes the click', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        items: [
          createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
          createItem({ name: 'b.png', path: 'assets/b.png', kind: 'file', previewType: 'image' }),
          createItem({ name: 'c.png', path: 'assets/c.png', kind: 'file', previewType: 'image' }),
        ],
      }),
      { thumbnailSize: 104, contentView: 'grid' },
      true
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const buttons = panel.querySelectorAll('.assets-preview-item');
    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await panel.updateComplete;

    expect(panel.getSelectedPaths().sort()).toEqual([
      'assets/a.png',
      'assets/b.png',
      'assets/c.png',
    ]);
    expect(panel.querySelectorAll('.assets-preview-item.is-selected')).toHaveLength(3);
  });

  it('re-stretches a shift-range from the original anchor, not the last shift-click', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        items: ['a', 'b', 'c', 'd'].map(name =>
          createItem({
            name: `${name}.png`,
            path: `assets/${name}.png`,
            kind: 'file',
            previewType: 'image',
          })
        ),
      }),
      { thumbnailSize: 104, contentView: 'grid' },
      true
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const buttons = panel.querySelectorAll('.assets-preview-item');
    // Anchor on "d", stretch up to "b"…
    buttons[3]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await panel.updateComplete;
    expect(panel.getSelectedPaths().sort()).toEqual([
      'assets/b.png',
      'assets/c.png',
      'assets/d.png',
    ]);

    // …then shrink it to "c": the anchor is still "d", so this is c..d, not b..c.
    buttons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await panel.updateComplete;
    expect(panel.getSelectedPaths().sort()).toEqual(['assets/c.png', 'assets/d.png']);

    // A plain click moves the anchor.
    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await panel.updateComplete;
    expect(panel.getSelectedPaths().sort()).toEqual(['assets/a.png', 'assets/b.png']);
  });

  it('still mirrors an externally-driven selection from the service', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    const items = [
      createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
      createItem({ name: 'b.png', path: 'assets/b.png', kind: 'file', previewType: 'image' }),
    ];
    stubServices(
      panel,
      createSnapshot({ items }),
      { thumbnailSize: 104, contentView: 'grid' },
      true
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const buttons = panel.querySelectorAll('.assets-preview-item');
    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await panel.updateComplete;
    expect(panel.getSelectedPaths()).toHaveLength(2);

    // A reveal from elsewhere (Scene Tree / Inspector) collapses to the revealed item.
    notifyListeners(panel, createSnapshot({ items, selectedItemPath: 'assets/a.png' }));
    await panel.updateComplete;

    expect(panel.getSelectedPaths()).toEqual(['assets/a.png']);
  });

  it('drops a dragged multi-selection on a folder card as a move request', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        selectedFolderPath: 'assets',
        items: [
          createItem({ name: 'textures', path: 'assets/textures', kind: 'directory' }),
          createItem({ name: 'a.png', path: 'assets/a.png', kind: 'file', previewType: 'image' }),
          createItem({ name: 'b.png', path: 'assets/b.png', kind: 'file', previewType: 'image' }),
        ],
      }),
      { thumbnailSize: 104, contentView: 'grid' },
      true
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const cards = panel.querySelectorAll<HTMLElement>('.assets-preview-item');
    const [folderCard, cardA, cardB] = [cards[0], cards[1], cards[2]];
    cardA?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cardB?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await panel.updateComplete;

    const dataTransfer = new FakeDataTransfer();
    cardA?.dispatchEvent(dragEvent('dragstart', dataTransfer));
    // `copy` alone makes the browser reject the move drop targets outright.
    expect(dataTransfer.effectAllowed).toBe('copyMove');

    const dragOver = dragEvent('dragover', dataTransfer);
    folderCard?.dispatchEvent(dragOver);
    await panel.updateComplete;

    expect(dragOver.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('move');
    expect(panel.querySelector('.assets-preview-item.is-drop-target')).toBe(folderCard);

    const requests: Array<{ paths: string[]; targetPath: string; targetLabel: string }> = [];
    panel.addEventListener('content-move-request', event => {
      requests.push(
        (event as CustomEvent<{ paths: string[]; targetPath: string; targetLabel: string }>).detail
      );
    });

    folderCard?.dispatchEvent(dragEvent('drop', dataTransfer));
    await panel.updateComplete;

    expect(requests).toEqual([
      {
        paths: ['assets/a.png', 'assets/b.png'],
        targetPath: 'assets/textures',
        targetLabel: 'textures',
      },
    ]);
    expect(panel.querySelector('.assets-preview-item.is-drop-target')).toBeNull();
  });

  it('ignores drops on a file card (only folders accept moves)', async () => {
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

    const cards = panel.querySelectorAll<HTMLElement>('.assets-preview-item');
    const dataTransfer = new FakeDataTransfer();
    cards[0]?.dispatchEvent(dragEvent('dragstart', dataTransfer));

    const requests: unknown[] = [];
    panel.addEventListener('content-move-request', event => requests.push(event));

    const dragOver = dragEvent('dragover', dataTransfer);
    cards[1]?.dispatchEvent(dragOver);
    cards[1]?.dispatchEvent(dragEvent('drop', dataTransfer));
    await panel.updateComplete;

    expect(dragOver.defaultPrevented).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('accepts a move drop on a parent breadcrumb', async () => {
    const panel = document.createElement('pix3-assets-content') as AssetsContentElement;
    stubServices(
      panel,
      createSnapshot({
        selectedFolderPath: 'assets/textures',
        items: [
          createItem({
            name: 'a.png',
            path: 'assets/textures/a.png',
            kind: 'file',
            previewType: 'image',
          }),
        ],
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const dataTransfer = new FakeDataTransfer();
    panel
      .querySelector<HTMLElement>('.assets-preview-item')
      ?.dispatchEvent(dragEvent('dragstart', dataTransfer));

    const requests: Array<{ paths: string[]; targetPath: string; targetLabel: string }> = [];
    panel.addEventListener('content-move-request', event => {
      requests.push(
        (event as CustomEvent<{ paths: string[]; targetPath: string; targetLabel: string }>).detail
      );
    });

    // Crumbs: [project root, "assets", "textures" (current, disabled)].
    const crumbs = panel.querySelectorAll<HTMLElement>('.crumb');
    crumbs[1]?.dispatchEvent(dragEvent('dragover', dataTransfer));
    crumbs[1]?.dispatchEvent(dragEvent('drop', dataTransfer));

    expect(requests).toEqual([
      { paths: ['assets/textures/a.png'], targetPath: 'assets', targetLabel: 'assets' },
    ]);
  });
});

/** Minimal DataTransfer stand-in: happy-dom has no drag data store. */
class FakeDataTransfer {
  effectAllowed = 'none';
  dropEffect = 'none';
  items = [] as unknown as DataTransferItemList;
  private readonly store = new Map<string, string>();

  get types(): readonly string[] {
    return Array.from(this.store.keys());
  }

  setData(type: string, value: string): void {
    this.store.set(type, value);
  }

  getData(type: string): string {
    return this.store.get(type) ?? '';
  }

  setDragImage(): void {
    // The real implementation snapshots the element; nothing to do here.
  }
}

function dragEvent(type: string, dataTransfer: FakeDataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event;
}

/** Pushes a snapshot through the stubbed service subscription. */
function notifyListeners(panel: AssetsContentElement, snapshot: AssetsPreviewSnapshot): void {
  const service = (panel as unknown as { assetsPreviewService: { selectItem: unknown } })
    .assetsPreviewService as unknown as {
    __listeners?: Array<(value: AssetsPreviewSnapshot) => void>;
  };
  const listeners = service.__listeners;
  if (!listeners) {
    throw new Error('Stub service did not expose its listeners.');
  }
  listeners.forEach(listener => listener(snapshot));
}

function stubServices(
  panel: AssetsContentElement,
  snapshot: AssetsPreviewSnapshot,
  // Default to explicit grid prefs so tests are deterministic despite the shared,
  // mutation-carrying real appState between cases.
  persisted: { thumbnailSize?: number; contentView?: 'grid' | 'list' } | null = {
    thumbnailSize: 104,
    contentView: 'grid',
  },
  // When true, `selectItem` re-notifies subscribers like the real service does — the
  // echo that must not collapse a locally-built multi-selection.
  echoSelection = false
) {
  const listeners: Array<(value: AssetsPreviewSnapshot) => void> = [];
  const assetsPreviewService: Pick<
    AssetsPreviewService,
    'subscribe' | 'selectItem' | 'requestThumbnail'
  > = {
    subscribe(listener: (value: AssetsPreviewSnapshot) => void) {
      listeners.push(listener);
      listener(snapshot);
      return () => undefined;
    },
    selectItem: vi.fn((path: string) => {
      if (!echoSelection) {
        return;
      }
      const echoed: AssetsPreviewSnapshot = {
        ...snapshot,
        selectedItemPath: path,
        selectedItem: snapshot.items.find(item => item.path === path) ?? null,
      };
      listeners.forEach(listener => listener(echoed));
    }),
    requestThumbnail: vi.fn(),
  };
  // Exposed so a test can push an externally-driven snapshot (see `notifyListeners`).
  Object.defineProperty(assetsPreviewService, '__listeners', { value: listeners });

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

function audioItem(): AssetPreviewItem {
  return createItem({
    name: 'shot.wav',
    path: 'audio/shot.wav',
    kind: 'file',
    extension: 'wav',
    previewType: 'audio',
    previewUrl: 'blob:shot',
    thumbnailUrl: 'data:image/svg+xml,waveform',
    thumbnailStatus: 'ready',
    iconName: 'music',
    sizeBytes: 24576,
    durationSeconds: 12,
    channelCount: 1,
    sampleRate: 44100,
  });
}

/** The panel's shared, lazily-created preview element (created on first play). */
function getPreviewElement(panel: AssetsContentElement): HTMLAudioElement {
  const element = (panel as unknown as { audioPreviewEl: HTMLAudioElement | null }).audioPreviewEl;
  if (!element) {
    throw new Error('Audio preview element was not created.');
  }
  return element;
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
