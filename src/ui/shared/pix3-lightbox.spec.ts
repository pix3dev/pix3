import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { IconService } from '@/services/editor/IconService';
import { LightboxService, type LightboxItem } from '@/services/editor/LightboxService';

interface LightboxElement extends HTMLElement {
  updateComplete: Promise<unknown>;
}

const container = (): ServiceContainer => ServiceContainer.getInstance();

const lightbox = (): LightboxService =>
  container().getService<LightboxService>(container().getOrCreateToken(LightboxService));

const image = (title: string, url: string): LightboxItem => ({ kind: 'image', title, url });

/**
 * Tear the DOM down host by host. `document.body.innerHTML = ''` does not run happy-dom's
 * disconnected callbacks, so a wiped-but-still-subscribed overlay from a previous test would keep
 * reacting to the service — including grabbing focus.
 */
const clearDom = (): void => {
  for (const host of Array.from(document.querySelectorAll('pix3-lightbox'))) {
    host.remove();
  }
  document.body.innerHTML = '';
};

/** Mount a host explicitly rather than relying on the auto-mounted one {@link clearDom} removes. */
const mount = async (): Promise<LightboxElement> => {
  const element = document.createElement('pix3-lightbox') as LightboxElement;
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
};

const settle = async (element: LightboxElement): Promise<void> => {
  await element.updateComplete;
  await element.updateComplete;
};

beforeAll(async () => {
  await import('./pix3-lightbox');
});

beforeEach(() => {
  const c = container();
  c.addService(c.getOrCreateToken(LightboxService), LightboxService, 'singleton');
  c.addService(c.getOrCreateToken(IconService), IconService, 'singleton');
  clearDom();
  // The container keeps the same singleton across re-registration, so close whatever a previous
  // test left open.
  lightbox().close();
});

afterEach(() => {
  clearDom();
  vi.restoreAllMocks();
});

describe('pix3-lightbox', () => {
  it('mounts a single host on the body and reuses it', async () => {
    const module = await import('./pix3-lightbox');
    const first = module.ensureLightboxHost();
    const second = module.ensureLightboxHost();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(document.querySelectorAll('pix3-lightbox')).toHaveLength(1);
  });

  it('renders nothing while closed', async () => {
    const element = await mount();

    expect(element.querySelector('.lightbox')).toBeNull();
    expect(element.textContent?.trim()).toBe('');
  });

  it('shows an image with its path, counter and arrows, and steps with the arrow keys', async () => {
    const element = await mount();
    lightbox().open(
      [
        { kind: 'image', title: 'hero.png', url: 'blob:hero', path: 'references/hero.png' },
        image('villain.png', 'blob:villain'),
      ],
      0
    );
    await settle(element);

    expect(element.querySelector<HTMLElement>('.lightbox__title')?.textContent?.trim()).toBe(
      'hero.png'
    );
    expect(element.querySelector<HTMLElement>('.lightbox__path')?.textContent?.trim()).toBe(
      'references/hero.png'
    );
    expect(element.querySelector<HTMLElement>('.lightbox__counter')?.textContent?.trim()).toBe(
      '1 / 2'
    );
    expect(element.querySelectorAll('.lightbox__step')).toHaveLength(2);
    expect(element.querySelector<HTMLImageElement>('.lightbox__image')?.getAttribute('src')).toBe(
      'blob:hero'
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await settle(element);
    expect(element.querySelector<HTMLImageElement>('.lightbox__image')?.getAttribute('src')).toBe(
      'blob:villain'
    );
    expect(element.querySelector<HTMLElement>('.lightbox__counter')?.textContent?.trim()).toBe(
      '2 / 2'
    );

    // Wrapping is the service's contract — the overlay must not fight it with a clamp of its own.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await settle(element);
    expect(element.querySelector<HTMLImageElement>('.lightbox__image')?.getAttribute('src')).toBe(
      'blob:hero'
    );
  });

  it('hides the arrows and the counter for a single item', async () => {
    const element = await mount();
    lightbox().open([image('lonely.png', 'blob:lonely')]);
    await settle(element);

    expect(element.querySelectorAll('.lightbox__step')).toHaveLength(0);
    expect(element.querySelector('.lightbox__counter')).toBeNull();
  });

  it('renders markdown through the document renderer and text as a pre block', async () => {
    const element = await mount();
    lightbox().open([
      {
        kind: 'markdown',
        title: 'Ant Strategy',
        text: ['# Ant Strategy', '', '| Unit | Cost |', '| --- | ---: |', '| Worker | 5 |'].join(
          '\n'
        ),
        path: 'design/gdd.md',
      },
    ]);
    await settle(element);

    expect(element.querySelector('.lightbox__doc h1')?.textContent?.trim()).toBe('Ant Strategy');
    // Doc mode is what makes the table (and the line anchors) exist at all.
    expect(element.querySelector('.lightbox__doc table.md-table')).toBeTruthy();
    expect(element.querySelector('.lightbox__doc h1')?.getAttribute('data-md-lines')).toBe('0-0');

    lightbox().close();
    lightbox().open([{ kind: 'text', title: 'notes.txt', text: 'line one\nline two' }]);
    await settle(element);
    expect(element.querySelector('.lightbox__text')?.textContent).toBe('line one\nline two');
  });

  it('says so honestly when a file has no preview', async () => {
    const element = await mount();
    lightbox().open([
      {
        kind: 'other',
        title: 'sprites.zip',
        path: 'references/sprites.zip',
        sizeBytes: 2048,
        mimeType: 'application/zip',
      },
    ]);
    await settle(element);

    expect(element.querySelector('.lightbox__plaque-name')?.textContent?.trim()).toBe(
      'sprites.zip'
    );
    expect(element.querySelector('.lightbox__plaque-meta')?.textContent?.trim()).toBe('2.0 KB');
    expect(element.querySelector('.lightbox__plaque-note')?.textContent?.trim()).toBe(
      'Preview not available'
    );
  });

  it('carries dialog semantics and returns focus to the opener on Escape', async () => {
    const element = await mount();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    lightbox().open([image('hero.png', 'blob:hero')]);
    await settle(element);

    const dialog = element.querySelector<HTMLElement>('.lightbox__dialog');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('hero.png');
    expect(document.activeElement).toBe(dialog);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle(element);

    expect(lightbox().current).toBeNull();
    expect(element.querySelector('.lightbox')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the overlay', async () => {
    const element = await mount();
    lightbox().open([image('a.png', 'blob:a'), image('b.png', 'blob:b')]);
    await settle(element);

    const stops = Array.from(element.querySelectorAll<HTMLElement>('button'));
    expect(stops.length).toBeGreaterThan(1);
    stops[stops.length - 1].focus();

    const forward = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    window.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[0]);

    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    window.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[stops.length - 1]);
  });

  it('closes on a backdrop click but not on a click inside the dialog', async () => {
    const element = await mount();
    lightbox().open([image('hero.png', 'blob:hero')]);
    await settle(element);

    element.querySelector<HTMLElement>('.lightbox__stage')?.click();
    await settle(element);
    expect(lightbox().current).not.toBeNull();

    element.querySelector<HTMLElement>('.lightbox')?.click();
    await settle(element);
    expect(lightbox().current).toBeNull();
  });

  it('zooms with the wheel and resets the zoom when the item changes', async () => {
    const element = await mount();
    lightbox().open([image('a.png', 'blob:a'), image('b.png', 'blob:b')]);
    await settle(element);

    const stage = element.querySelector<HTMLElement>('.lightbox__stage');
    const picture = (): HTMLElement | null =>
      element.querySelector<HTMLElement>('.lightbox__image');
    expect(picture()?.style.transform).toContain('scale(1)');

    stage?.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -400, clientX: 100, clientY: 100, cancelable: true })
    );
    await settle(element);
    const zoomed = picture()?.style.transform ?? '';
    expect(zoomed).not.toContain('scale(1)');

    // Flipping to another picture must start fitted — carried-over zoom looks like a broken image.
    lightbox().step(1);
    await settle(element);
    expect(picture()?.style.transform).toContain('scale(1)');
  });
});
