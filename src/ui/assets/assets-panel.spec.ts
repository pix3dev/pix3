import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Keep the heavy service and child-component modules out of the jsdom run: the panel
// only needs the injected classes to exist for the @inject decorators, and lightweight
// stub custom elements so the template renders and the `ref` callbacks resolve.
vi.mock('@/services', () => ({
  AssetFileActivationService: class AssetFileActivationService {},
  AssetsPreviewService: class AssetsPreviewService {},
  IconService: class IconService {},
  CommandDispatcher: class CommandDispatcher {},
  IconSize: { SMALL: 14, MEDIUM: 16, LARGE: 18, XLARGE: 24 },
}));
vi.mock('@/services/assets/AssetImportDialogService', () => ({
  AssetImportDialogService: class AssetImportDialogService {},
}));
vi.mock('@/services/editor/DialogService', () => ({ DialogService: class DialogService {} }));
vi.mock('@/services/project/ProjectService', () => ({ ProjectService: class ProjectService {} }));
vi.mock('@/services/scripting/ProjectScriptLoaderService', () => ({
  ProjectScriptLoaderService: class ProjectScriptLoaderService {},
}));
vi.mock('@/features/project/AddAutoloadCommand', () => ({
  AddAutoloadCommand: class AddAutoloadCommand {},
}));

// Replace the real child/shared components with no-op modules; we register minimal
// stub elements below so the panel can query them and drive their public API.
vi.mock('../shared/pix3-panel', () => ({}));
vi.mock('../shared/pix3-toolbar', () => ({}));
vi.mock('../shared/pix3-toolbar-button', () => ({}));
vi.mock('../shared/pix3-dropdown-button', () => ({}));
vi.mock('./asset-tree', () => ({}));
vi.mock('./assets-content', () => ({}));

class StubAssetTree extends HTMLElement {
  clearSelection = vi.fn();
  selectPath = vi.fn(async () => true);
  setViewMode = vi.fn(async () => undefined);
  createFolder = vi.fn(async () => undefined);
  deleteSelected = vi.fn(async () => undefined);
  renameSelected = vi.fn(async () => undefined);
  handleRootDrop = vi.fn(async () => undefined);
  revealAndOpen = vi.fn(async () => true);
  getTargetDirectory = vi.fn(() => '.');
}

class StubAssetsContent extends HTMLElement {
  getSelectedPaths = vi.fn<() => string[]>(() => []);
}

class StubPassthrough extends HTMLElement {}

beforeAll(() => {
  customElements.define('pix3-asset-tree', StubAssetTree);
  customElements.define('pix3-assets-content', StubAssetsContent);
  customElements.define('pix3-panel', class extends StubPassthrough {});
  customElements.define('pix3-toolbar', class extends StubPassthrough {});
  customElements.define('pix3-toolbar-button', class extends StubPassthrough {});
  customElements.define('pix3-dropdown-button', class extends StubPassthrough {});
});

await import('./assets-panel');
type AssetsPanelElement = HTMLElementTagNameMap['pix3-assets-panel'];

interface Stubs {
  assetsPreviewService: {
    subscribe: ReturnType<typeof vi.fn>;
    syncFromAssetSelection: ReturnType<typeof vi.fn>;
    clearSelectedItem: ReturnType<typeof vi.fn>;
  };
  projectService: {
    loadAssetBrowserState: ReturnType<typeof vi.fn>;
    saveAssetBrowserState: ReturnType<typeof vi.fn>;
    deleteEntry: ReturnType<typeof vi.fn>;
    moveItem: ReturnType<typeof vi.fn>;
  };
  dialogService: { showConfirmation: ReturnType<typeof vi.fn> };
}

function stubServices(panel: AssetsPanelElement, selectedFolderPath: string | null = '.'): Stubs {
  const assetsPreviewService = {
    subscribe: vi.fn((listener: (value: unknown) => void) => {
      listener({ selectedFolderPath });
      return () => undefined;
    }),
    syncFromAssetSelection: vi.fn(async () => undefined),
    clearSelectedItem: vi.fn(),
  };

  const projectService = {
    loadAssetBrowserState: vi.fn(() => null),
    saveAssetBrowserState: vi.fn(),
    deleteEntry: vi.fn(async () => undefined),
    moveItem: vi.fn(async () => undefined),
  };

  const dialogService = { showConfirmation: vi.fn(async () => true) };

  const iconService = { getIcon: vi.fn(() => 'icon') };

  const noop = {};
  for (const [key, value] of Object.entries({
    assetsPreviewService,
    projectService,
    dialogService,
    iconService,
    assetFileActivation: noop,
    assetImportDialogService: noop,
    commandDispatcher: noop,
    scriptLoader: noop,
  })) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  return { assetsPreviewService, projectService, dialogService } satisfies Stubs;
}

function tree(panel: AssetsPanelElement): StubAssetTree {
  return panel.querySelector('pix3-asset-tree') as unknown as StubAssetTree;
}

describe('AssetsPanel (Phase 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('root-row click clears the tree selection and syncs the project root', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    const stubs = stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    panel
      .querySelector<HTMLElement>('.tree-root-row')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(tree(panel).clearSelection).toHaveBeenCalledTimes(1);
    expect(stubs.assetsPreviewService.syncFromAssetSelection).toHaveBeenCalledWith(
      '.',
      'directory'
    );
  });

  it('routes assets-preview:reveal-path window events to the tree', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    window.dispatchEvent(
      new CustomEvent('assets-preview:reveal-path', { detail: { path: 'textures/ui' } })
    );
    await Promise.resolve();

    expect(tree(panel).selectPath).toHaveBeenCalledWith('textures/ui');
  });

  it('group-by-type toggle calls setViewMode on the tree', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    panel
      .querySelector<HTMLButtonElement>('.root-action-btn[aria-label="Group by type"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(tree(panel).setViewMode).toHaveBeenCalledWith('by-type');
  });

  it('content-delete-request with 2 paths shows one confirmation and deletes each', async () => {
    const panel = document.createElement('pix3-assets-panel') as AssetsPanelElement;
    const stubs = stubServices(panel);
    document.body.appendChild(panel);
    await panel.updateComplete;

    panel.querySelector('pix3-assets-content')?.dispatchEvent(
      new CustomEvent('content-delete-request', {
        detail: { paths: ['assets/a.png', 'assets/b.png'] },
        bubbles: true,
        composed: true,
      })
    );
    // Allow the async confirmation + deletion chain to settle.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(stubs.dialogService.showConfirmation).toHaveBeenCalledTimes(1);
    expect(stubs.projectService.deleteEntry).toHaveBeenCalledTimes(2);
    expect(stubs.projectService.deleteEntry).toHaveBeenNthCalledWith(1, 'assets/a.png');
    expect(stubs.projectService.deleteEntry).toHaveBeenNthCalledWith(2, 'assets/b.png');
    expect(stubs.assetsPreviewService.clearSelectedItem).toHaveBeenCalledTimes(1);
  });
});
