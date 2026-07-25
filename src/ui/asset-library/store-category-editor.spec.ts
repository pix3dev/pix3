import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { DialogService } from '@/services/editor/DialogService';
import { buildCategoryId, categoryDepth, slugifyCategorySegment } from './store-category-editor';

vi.mock('@/services/cloud/ApiClient', () => ({
  getStoreCategories: vi.fn(async () => ({
    categories: [
      { id: 'ui', parentId: null, label: 'UI', sortOrder: 0, itemCount: 1 },
      { id: 'ui/buttons', parentId: 'ui', label: 'Buttons', sortOrder: 0, itemCount: 2 },
    ],
  })),
  createStoreCategory: vi.fn(async () => ({ category: null })),
  updateStoreCategory: vi.fn(async () => ({ ok: true })),
  deleteStoreCategory: vi.fn(async () => ({ ok: true })),
}));

const ApiClient = await import('@/services/cloud/ApiClient');

type TestEditorElement = HTMLElement & { updateComplete: Promise<unknown> };

class DialogServiceStub {
  showConfirmation = vi.fn(async () => true);
}

beforeAll(async () => {
  const container = ServiceContainer.getInstance();
  container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
  await import('./store-category-editor');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function mountEditor(): Promise<TestEditorElement> {
  const editor = document.createElement('pix3-store-category-editor') as TestEditorElement;
  document.body.appendChild(editor);
  await editor.updateComplete;
  await vi.waitFor(() => {
    expect(editor.textContent).toContain('Buttons');
  });
  await editor.updateComplete;
  return editor;
}

describe('slugifyCategorySegment', () => {
  it('lowercases and dash-joins, matching the server segment rule', () => {
    expect(slugifyCategorySegment('UI Kits')).toBe('ui-kits');
    expect(slugifyCategorySegment('  Sci-Fi   Props ')).toBe('sci-fi-props');
    expect(slugifyCategorySegment('2D Sprites')).toBe('2d-sprites');
  });

  it('never emits a leading or trailing dash (the server would 400)', () => {
    expect(slugifyCategorySegment('—Fancy—')).toBe('fancy');
    expect(slugifyCategorySegment('!!!')).toBe('category');
    expect(slugifyCategorySegment('')).toBe('category');
    expect(slugifyCategorySegment('Ünïcödé')).toBe('n-c-d');
  });
});

describe('buildCategoryId', () => {
  it('builds a top-level id from the label alone', () => {
    expect(buildCategoryId(null, 'Audio Packs')).toBe('audio-packs');
  });

  it('prefixes a subcategory with its parent id verbatim', () => {
    expect(buildCategoryId('ui', 'Buttons & Toggles')).toBe('ui/buttons-toggles');
  });

  it('reports depth so the two-level cap can be enforced before the request', () => {
    expect(categoryDepth('ui')).toBe(1);
    expect(categoryDepth('ui/buttons')).toBe(2);
  });
});

describe('StoreCategoryEditor', () => {
  it('previews the generated id and creates the category under the right parent', async () => {
    const editor = await mountEditor();

    const addButton = [...editor.querySelectorAll('button')].find(button =>
      button.textContent?.includes('Add subcategory')
    );
    expect(addButton).toBeDefined();
    addButton?.click();
    await editor.updateComplete;

    const input = editor.querySelector('.sce-input') as HTMLInputElement;
    input.value = 'Progress Bars';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await editor.updateComplete;

    // The admin sees the id they are about to create before committing to it.
    expect(editor.textContent).toContain('ui/progress-bars');

    const create = editor.querySelector(
      'button[aria-label="Create category"]'
    ) as HTMLButtonElement;
    create.click();
    await vi.waitFor(() => {
      expect(ApiClient.createStoreCategory).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ui/progress-bars', parentId: 'ui', label: 'Progress Bars' })
      );
    });
  });

  it('reports a change on close so the host rail can refresh', async () => {
    const editor = await mountEditor();
    const events: Array<{ changed: boolean }> = [];
    editor.addEventListener('store-categories-close', event => {
      events.push((event as CustomEvent<{ changed: boolean }>).detail);
    });

    (editor.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    expect(events).toEqual([{ changed: false }]);
  });

  it('spells out that items move to the parent before deleting a category', async () => {
    const editor = await mountEditor();
    const dialogService = ServiceContainer.getInstance().getService<DialogServiceStub>(
      ServiceContainer.getInstance().getOrCreateToken(DialogService)
    );

    const remove = editor.querySelector('button[aria-label="Delete Buttons"]') as HTMLButtonElement;
    remove.click();

    await vi.waitFor(() => {
      expect(dialogService.showConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('moved up to "UI"') })
      );
      expect(ApiClient.deleteStoreCategory).toHaveBeenCalledWith('ui/buttons');
    });
  });
});
