import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { LibraryInsertService } from '@/services/library/LibraryInsertService';
import { LibrarySelectionService } from '@/services/library/LibrarySelectionService';
import { DialogService } from '@/services/editor/DialogService';
import { LIBRARY_SOURCES, type LibrarySourceConfig } from '@/services/library/library-sources';
import type { LibraryItem, LibraryItemManifest } from '@/services/library/library-types';

type TestInspectorElement = HTMLElement & {
  updateComplete: Promise<unknown>;
  selection: { item: LibraryItem; source: LibrarySourceConfig } | null;
};

const STORE_SOURCE = LIBRARY_SOURCES.find(entry => entry.id === 'store')!;

/**
 * The inspector re-reads `getItems()` on every update and re-renders when the array identity
 * changes, so the stub must hand back a stable reference or the component loops forever.
 */
const EMPTY_ITEMS: LibraryItem[] = [];

class AssetLibraryServiceStub {
  getItems = vi.fn(async () => EMPTY_ITEMS);
  getPreviewUrl = vi.fn(async () => null);
  getStoreCategories = vi.fn(async () => [
    { id: 'ui', parentId: null, label: 'UI', sortOrder: 0, itemCount: 0 },
    { id: 'ui/buttons', parentId: 'ui', label: 'Buttons', sortOrder: 0, itemCount: 0 },
  ]);
  patchStoreItemMeta = vi.fn(async (id: string) => storeItem({ id }));
  deleteStoreItem = vi.fn(async () => undefined);
}

class LibraryInsertServiceStub {
  insert = vi.fn(async () => undefined);
  copyBundleIntoProject = vi.fn(async () => undefined);
  addAsScene = vi.fn(async () => undefined);
}

class LibrarySelectionServiceStub {
  setSelection = vi.fn();
  clear = vi.fn();
  getSelection = vi.fn(() => null);
  subscribe = vi.fn(() => () => {});
}

class DialogServiceStub {
  showConfirmation = vi.fn(async () => true);
}

function storeItem(overrides: Partial<LibraryItemManifest> = {}): LibraryItem {
  return {
    scope: 'store',
    manifest: {
      id: 'store-item',
      slug: 'store-item',
      name: 'Neon Buttons',
      type: 'prefab',
      tags: [],
      files: ['preview.png'],
      source: 'packed',
      createdAt: 1,
      updatedAt: 2,
      status: 'draft',
      ...overrides,
    } satisfies LibraryItemManifest,
  };
}

/** A manifest that satisfies every publish-gate requirement. */
function completeStoreItem(): LibraryItem {
  return storeItem({
    categoryPath: 'ui/buttons',
    description: 'A neon button kit.',
    license: 'CC0-1.0',
    preview: 'preview.png',
    tags: ['ui'],
  });
}

function services() {
  const container = ServiceContainer.getInstance();
  return {
    library: container.getService<AssetLibraryServiceStub>(
      container.getOrCreateToken(AssetLibraryService)
    ),
    selection: container.getService<LibrarySelectionServiceStub>(
      container.getOrCreateToken(LibrarySelectionService)
    ),
    dialog: container.getService<DialogServiceStub>(container.getOrCreateToken(DialogService)),
  };
}

beforeAll(async () => {
  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(AssetLibraryService),
    AssetLibraryServiceStub,
    'singleton'
  );
  container.addService(
    container.getOrCreateToken(LibraryInsertService),
    LibraryInsertServiceStub,
    'singleton'
  );
  container.addService(
    container.getOrCreateToken(LibrarySelectionService),
    LibrarySelectionServiceStub,
    'singleton'
  );
  container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
  await import('./library-inspector');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.clearAllMocks();
});

function signInAdmin(isAdmin: boolean): void {
  appState.auth.user = {
    id: 'u-1',
    email: 'admin@example.com',
    username: 'admin',
    is_admin: isAdmin,
  };
  appState.auth.isAuthenticated = true;
}

async function mountInspector(item: LibraryItem): Promise<TestInspectorElement> {
  const inspector = document.createElement('pix3-library-inspector') as TestInspectorElement;
  inspector.selection = { item, source: STORE_SOURCE };
  document.body.appendChild(inspector);
  await inspector.updateComplete;
  await vi.waitFor(() => {
    expect(inspector.querySelector('.lib-insp')).not.toBeNull();
  });
  await inspector.updateComplete;
  return inspector;
}

function segment(inspector: TestInspectorElement, label: string): HTMLButtonElement {
  const button = [...inspector.querySelectorAll<HTMLButtonElement>('.lib-insp__segment')].find(
    entry => entry.textContent?.includes(label)
  );
  if (!button) {
    throw new Error(`No "${label}" status segment rendered`);
  }
  return button;
}

describe('LibraryInspector store admin', () => {
  it('hides the curation section from a non-admin', async () => {
    signInAdmin(false);
    const inspector = await mountInspector(storeItem());
    expect(inspector.querySelector('.lib-insp__admin')).toBeNull();
    expect(inspector.textContent).not.toContain('Store admin');
  });

  it('shows the curation section to an admin', async () => {
    signInAdmin(true);
    const inspector = await mountInspector(storeItem());
    expect(inspector.querySelector('.lib-insp__admin')).not.toBeNull();
    expect(inspector.textContent).toContain('Store admin');
  });

  it('blocks publishing an incomplete item locally and lists the missing fields', async () => {
    signInAdmin(true);
    const { library } = services();
    const inspector = await mountInspector(storeItem());

    segment(inspector, 'Published').click();
    await inspector.updateComplete;

    // Nothing was sent — the gate ran client-side.
    expect(library.patchStoreItemMeta).not.toHaveBeenCalled();
    expect(inspector.textContent).toContain('Not ready to publish');
    expect(inspector.textContent).toContain('A store category is required');
    expect(inspector.textContent).toContain('A preview image is required');
    // The offending fields are highlighted, not just listed.
    expect(inspector.querySelectorAll('.is-invalid').length).toBeGreaterThan(0);
  });

  it('publishes an item that passes the gate', async () => {
    signInAdmin(true);
    const { library, selection } = services();
    const inspector = await mountInspector(completeStoreItem());

    segment(inspector, 'Published').click();
    await vi.waitFor(() => {
      expect(library.patchStoreItemMeta).toHaveBeenCalledWith('store-item', {
        status: 'published',
      });
    });
    // The fresh server copy replaces the selection instead of a locally-guessed manifest.
    expect(selection.setSelection).toHaveBeenCalled();
  });

  it('toggles the featured flag through the server', async () => {
    signInAdmin(true);
    const { library } = services();
    const inspector = await mountInspector(completeStoreItem());

    (inspector.querySelector('.lib-insp__toggle') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(library.patchStoreItemMeta).toHaveBeenCalledWith('store-item', { featured: true });
    });
  });

  it('renders the server-side gate checklist when the server is the one that refuses', async () => {
    signInAdmin(true);
    const { library } = services();
    const rejection = Object.assign(new Error('Item is not ready to publish'), {
      status: 400,
      issues: [{ field: 'license', message: 'License must be one of: MIT' }],
    });
    // ApiClientError is structurally matched by `instanceof` in the component, so patch the stub
    // to throw the real error type the ApiClient would raise.
    const { ApiClientError } = await import('@/services/cloud/ApiClient');
    const apiError = new ApiClientError('Item is not ready to publish', 400);
    apiError.issues = rejection.issues;
    library.patchStoreItemMeta.mockRejectedValueOnce(apiError);

    const inspector = await mountInspector(completeStoreItem());
    segment(inspector, 'Unlisted').click();

    await vi.waitFor(() => {
      expect(inspector.textContent).toContain('License must be one of: MIT');
    });
  });

  it('confirms before hard-deleting a store item', async () => {
    signInAdmin(true);
    const { library, dialog } = services();
    const inspector = await mountInspector(completeStoreItem());

    const danger = [...inspector.querySelectorAll<HTMLButtonElement>('.lib-insp__danger')].find(
      button => button.textContent?.includes('Delete from store')
    );
    danger?.click();

    await vi.waitFor(() => {
      expect(dialog.showConfirmation).toHaveBeenCalled();
      expect(library.deleteStoreItem).toHaveBeenCalledWith('store-item');
    });
  });
});
