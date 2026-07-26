import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import {
  StoreUploadService,
  type StagedBundle,
  type StoreIngestPlan,
  type UploadOutcome,
} from '@/services/library/StoreUploadService';
import type { LibraryItemManifest } from '@/services/library/library-types';

class LibraryStub {
  getStoreCategories = vi.fn(async () => [
    { id: 'ui', parentId: null, label: 'UI', sortOrder: 0, itemCount: 0 },
    { id: 'ui/buttons', parentId: 'ui', label: 'Buttons', sortOrder: 0, itemCount: 0 },
  ]);
}

class UploadsStub {
  upload = vi.fn(
    async (bundles: readonly StagedBundle[]): Promise<UploadOutcome[]> =>
      bundles.map(bundle => ({ bundleId: bundle.id, status: 'ok' as const }))
  );
}

type DialogElement = HTMLElement & {
  plan: StoreIngestPlan | null;
  updateComplete: Promise<unknown>;
};

let library: LibraryStub;
let uploads: UploadsStub;

beforeAll(async () => {
  const container = ServiceContainer.getInstance();
  container.addService(container.getOrCreateToken(AssetLibraryService), LibraryStub, 'singleton');
  container.addService(container.getOrCreateToken(StoreUploadService), UploadsStub, 'singleton');
  library = container.getService<LibraryStub>(container.getOrCreateToken(AssetLibraryService));
  uploads = container.getService<UploadsStub>(container.getOrCreateToken(StoreUploadService));
  await import('./store-upload-dialog');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function manifest(overrides: Partial<LibraryItemManifest> = {}): LibraryItemManifest {
  return {
    id: 'item-1',
    slug: 'item-1',
    name: 'Item One',
    type: 'image',
    tags: [],
    files: ['pic.png'],
    source: 'imported',
    status: 'draft',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function bundle(overrides: Partial<LibraryItemManifest> = {}, oversize = false): StagedBundle {
  const built = manifest(overrides);
  return {
    id: built.id,
    manifest: built,
    files: new Map<string, Blob>([['pic.png', new Blob(['x'])]]),
    sourceLabel: `${built.name} folder`,
    oversize,
    issues: oversize ? ['Too big.'] : [],
  };
}

async function mount(plan: StoreIngestPlan): Promise<DialogElement> {
  const dialog = document.createElement('pix3-store-upload-dialog') as DialogElement;
  dialog.plan = plan;
  document.body.appendChild(dialog);
  await dialog.updateComplete;
  await vi.waitFor(() => expect(library.getStoreCategories).toHaveBeenCalled());
  await dialog.updateComplete;
  return dialog;
}

function button(dialog: DialogElement, label: string): HTMLButtonElement {
  const found = [...dialog.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.includes(label)
  );
  if (!found) {
    throw new Error(`No button labelled "${label}"`);
  }
  return found;
}

describe('StoreUploadDialog', () => {
  it('lists every staged bundle and marks the blocked ones', async () => {
    const dialog = await mount({
      bundles: [bundle(), bundle({ id: 'item-2', name: 'Too Heavy' }, true)],
      issues: [],
    });

    const rows = dialog.querySelectorAll('.sud-item');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.classList.contains('is-blocked')).toBe(true);
    // The footer counts only what would actually be sent. (Collapse the template's whitespace —
    // prettier is free to re-wrap the markup.)
    const status = dialog.querySelector('.sud-status')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(status).toContain('1 item ready');
    expect(status).toContain('1 blocked');
  });

  it('refuses to publish an incomplete bundle and lists what is missing', async () => {
    const dialog = await mount({ bundles: [bundle()], issues: [] });

    button(dialog, 'Upload & publish').click();
    await dialog.updateComplete;

    expect(uploads.upload).not.toHaveBeenCalled();
    const issues = dialog.querySelector('.sud-issues')?.textContent ?? '';
    expect(issues).toContain('Not ready to publish');
    expect(issues).toContain('store category');
    expect(issues).toContain('License');
    // The offending fields are highlighted, not just listed.
    expect(dialog.querySelectorAll('.sud-field.is-invalid').length).toBeGreaterThan(0);
  });

  it('publishes when every requirement is met', async () => {
    const complete = bundle({
      name: 'Complete',
      categoryPath: 'ui/buttons',
      description: 'A complete item',
      license: 'CC0-1.0',
      preview: 'pic.png',
      tags: ['ui'],
    });
    const dialog = await mount({ bundles: [complete], issues: [] });

    button(dialog, 'Upload & publish').click();
    await vi.waitFor(() => expect(uploads.upload).toHaveBeenCalled());
    await dialog.updateComplete;

    expect(uploads.upload.mock.calls[0]![0][0]!.manifest.status).toBe('published');
    expect(dialog.querySelector('.sud-status')?.textContent?.replace(/\s+/g, ' ')).toContain(
      '1 of 1 uploaded'
    );
  });

  it('uploads as drafts without running the gate, then reports the count on close', async () => {
    const dialog = await mount({ bundles: [bundle()], issues: [] });

    const closed = new Promise<number>(resolve =>
      dialog.addEventListener('store-upload-close', event =>
        resolve((event as CustomEvent<{ uploaded: number }>).detail.uploaded)
      )
    );

    button(dialog, 'Upload as drafts').click();
    await vi.waitFor(() => expect(uploads.upload).toHaveBeenCalled());
    await dialog.updateComplete;

    expect(uploads.upload.mock.calls[0]![0][0]!.manifest.status).toBe('draft');
    button(dialog, 'Done').click();
    await expect(closed).resolves.toBe(1);
  });

  it('edits the selected bundle metadata in place', async () => {
    const staged = bundle();
    const dialog = await mount({ bundles: [staged], issues: [] });

    const name = dialog.querySelector<HTMLInputElement>('#sudName')!;
    name.value = 'Renamed';
    name.dispatchEvent(new Event('input'));
    await dialog.updateComplete;

    const tags = dialog.querySelector<HTMLInputElement>('#sudTags')!;
    tags.value = 'ui, buttons';
    tags.dispatchEvent(new Event('change'));
    await dialog.updateComplete;

    expect(staged.manifest.name).toBe('Renamed');
    expect(staged.manifest.tags).toEqual(['ui', 'buttons']);
  });
});
