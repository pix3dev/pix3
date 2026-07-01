import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './pix3-confirm-dialog';

describe('ConfirmDialog', () => {
  beforeAll(async () => {
    await import('./pix3-confirm-dialog');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('requires an exact confirmation string before dispatching confirm', async () => {
    const dialog = document.createElement('pix3-confirm-dialog') as ConfirmDialog;
    dialog.dialogId = 'dialog-1';
    dialog.title = 'Delete Cloud Project';
    dialog.message = 'Dangerous action.';
    dialog.confirmLabel = 'Delete Project';
    dialog.requiredInputLabel = 'Enter project name to confirm';
    dialog.requiredInputValue = 'Demo Project';
    dialog.requiredInputPlaceholder = 'Demo Project';
    document.body.appendChild(dialog);
    await dialog.updateComplete;

    const confirmHandler = vi.fn();
    dialog.addEventListener('dialog-confirmed', confirmHandler);

    const confirmButton = dialog.querySelector('.btn-confirm') as HTMLButtonElement;
    const input = dialog.querySelector('.dialog-confirmation__input') as HTMLInputElement;

    expect(confirmButton.disabled).toBe(true);

    input.value = 'Wrong';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await dialog.updateComplete;

    expect(confirmButton.disabled).toBe(true);
    confirmButton.click();
    expect(confirmHandler).not.toHaveBeenCalled();

    input.value = 'Demo Project';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await dialog.updateComplete;

    expect(confirmButton.disabled).toBe(false);
    confirmButton.click();

    expect(confirmHandler).toHaveBeenCalledTimes(1);
    expect(confirmHandler.mock.calls[0]?.[0]).toMatchObject({
      detail: { dialogId: 'dialog-1' },
    });
  });

  it('renders expandable details with a scrollable body when provided', async () => {
    const dialog = document.createElement('pix3-confirm-dialog') as ConfirmDialog;
    dialog.dialogId = 'dialog-2';
    dialog.title = 'Playable HTML Exported';
    dialog.message = 'Bundle size report summary.';
    dialog.expandableSection = {
      title: 'Embedded assets by source size',
      items: [
        'asset-a.png: 10 KiB raw -> 13 KiB base64',
        'asset-b.png: 8 KiB raw -> 10 KiB base64',
      ],
      maxHeightPx: 180,
    };
    document.body.appendChild(dialog);
    await dialog.updateComplete;

    const details = dialog.querySelector('.dialog-expandable') as HTMLDetailsElement | null;
    const items = Array.from(dialog.querySelectorAll('.dialog-expandable__item')).map(node =>
      node.textContent?.trim()
    );
    const body = dialog.querySelector('.dialog-expandable__body') as HTMLDivElement | null;

    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('Embedded assets by source size');
    expect(items).toEqual([
      'asset-a.png: 10 KiB raw -> 13 KiB base64',
      'asset-b.png: 8 KiB raw -> 10 KiB base64',
    ]);
    expect(details?.getAttribute('style')).toContain('--dialog-expandable-max-height: 180px;');
    expect(body?.className).toContain('dialog-expandable__body');
  });
});
