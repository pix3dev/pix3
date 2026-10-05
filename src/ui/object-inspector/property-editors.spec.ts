import { afterEach, describe, expect, it } from 'vitest';

import './property-editors';

import { AnimationResourceEditor, NumberField, SliderNumberEditor } from './property-editors';

describe('Numeric property editors', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['pix3-number-field', 'pix3-slider-number-editor'] as const)(
    '%s trims decimal zeros while preserving values and display precision',
    async tag => {
      const editor = document.createElement(tag) as NumberField | SliderNumberEditor;
      editor.min = -100;
      editor.max = 100;
      editor.precision = 2;
      document.body.appendChild(editor);
      for (const [value, expected] of [
        [0, '0'],
        [30, '30'],
        [1.5, '1.5'],
        [1.234, '1.23'],
        [0.01, '0.01'],
        [-3, '-3'],
        [-0.001, '0'],
      ] as const) {
        editor.value = value;
        await editor.updateComplete;
        const input = editor.shadowRoot?.querySelector<HTMLInputElement>('.number-input');
        const display = input?.value ?? editor.shadowRoot?.querySelector('.value')?.textContent;
        expect(display).toBe(expected);
        expect(editor.value).toBe(value);
      }
    }
  );
});

describe('AnimationResourceEditor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('emits create-request when the create button is clicked for an empty animation slot', async () => {
    const editor = document.createElement(
      'pix3-animation-resource-editor'
    ) as AnimationResourceEditor;
    editor.showCreateButton = true;
    editor.resourceUrl = '';

    const onCreateRequest = new Promise<void>(resolve => {
      editor.addEventListener('create-request', () => resolve(), { once: true });
    });

    document.body.appendChild(editor);
    await editor.updateComplete;

    const button = editor.shadowRoot?.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected create button to be rendered');
    }

    button.click();

    await onCreateRequest;
  });

  it('emits open-request when the assigned animation asset is double-clicked', async () => {
    const editor = document.createElement(
      'pix3-animation-resource-editor'
    ) as AnimationResourceEditor;
    editor.resourceUrl = 'res://animations/walk.pix3anim';

    const onOpenRequest = new Promise<CustomEvent<{ url: string }>>(resolve => {
      editor.addEventListener(
        'open-request',
        event => resolve(event as CustomEvent<{ url: string }>),
        {
          once: true,
        }
      );
    });

    document.body.appendChild(editor);
    await editor.updateComplete;

    const input = editor.shadowRoot?.querySelector('input[type="text"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Expected animation resource input to be rendered');
    }

    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));

    const event = await onOpenRequest;
    expect(event.detail.url).toBe('res://animations/walk.pix3anim');
  });
});
