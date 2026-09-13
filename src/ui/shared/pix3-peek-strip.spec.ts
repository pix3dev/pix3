import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { html, render } from 'lit';

import { ServiceContainer } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { IconService } from '@/services/editor/IconService';
import { PeekService, type PeekBranch, type PeekSnapshot } from '@/services/viewport/PeekService';

let snapshot: PeekSnapshot = { branches: [], hiddenCount: 0, soloActive: false };

class PeekServiceStub {
  getSnapshot(): PeekSnapshot {
    return snapshot;
  }

  subscribe(): () => void {
    return () => {};
  }
}

class CommandDispatcherStub {
  execute = vi.fn(async () => undefined);
}

class IconServiceStub {
  getIcon = vi.fn((name: string) => html`<svg data-icon=${name}></svg>`);
}

const branch = (overrides: Partial<PeekBranch> = {}): PeekBranch => ({
  nodeId: 'hud',
  label: 'HUD',
  type: 'Group2D',
  hidden: false,
  authoredHidden: false,
  dimmed: false,
  soloed: false,
  ...overrides,
});

type TestStrip = HTMLElement & { updateComplete: Promise<unknown>; chipsEnabled: boolean };

const mountStrip = async (chipsEnabled = true): Promise<TestStrip> => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(html`<pix3-peek-strip .chipsEnabled=${chipsEnabled}></pix3-peek-strip>`, host);
  const strip = host.querySelector('pix3-peek-strip') as TestStrip;
  await strip.updateComplete;
  return strip;
};

beforeAll(async () => {
  const container = ServiceContainer.getInstance();
  const register = (token: unknown, stub: unknown): void => {
    container.addService(
      container.getOrCreateToken(token as Parameters<typeof container.getOrCreateToken>[0]),
      stub as Parameters<typeof container.addService>[1],
      'singleton'
    );
  };
  register(PeekService, PeekServiceStub);
  register(CommandDispatcher, CommandDispatcherStub);
  register(IconService, IconServiceStub);
  await import('./pix3-peek-strip');
});

afterEach(() => {
  document.body.innerHTML = '';
  snapshot = { branches: [], hiddenCount: 0, soloActive: false };
});

describe('Peek strip — a branch hidden by the scene file', () => {
  /**
   * The chip's eye answers "is this on screen", which `hidden` alone cannot: a branch carrying
   * `visible: false` is off screen too, and an open eye over it would have the strip contradicting
   * the viewport beside it.
   */
  it('draws an authored-hidden branch as off screen', async () => {
    snapshot = {
      branches: [branch({ authoredHidden: true }), branch({ nodeId: 'world', label: 'World' })],
      hiddenCount: 0,
      soloActive: false,
    };

    const chip = (await mountStrip()).querySelector('.peek__chip') as HTMLButtonElement;

    expect(chip.querySelector('[data-icon="eye-off"]')).not.toBeNull();
    expect(chip.dataset.authoredHidden).toBe('true');
    // Peek did not do this and cannot undo it, so the chip says where the state lives instead of
    // offering a toggle whose effect nothing on screen would show.
    expect(chip.disabled).toBe(true);
    expect(chip.title).toContain('Scene Tree');
  });

  it('stays live once Peek has masked it too, because the mask IS clearable here', async () => {
    snapshot = {
      branches: [
        branch({ hidden: true, authoredHidden: true }),
        branch({ nodeId: 'world', label: 'World' }),
      ],
      hiddenCount: 1,
      soloActive: false,
    };

    const chip = (await mountStrip()).querySelector('.peek__chip') as HTMLButtonElement;

    expect(chip.disabled).toBe(false);
    expect(chip.title).toContain('hidden in your editor only');
  });
});

describe('Peek strip — the chip-less (game stage) mode', () => {
  it('offers no chips at all', async () => {
    snapshot = {
      branches: [branch(), branch({ nodeId: 'world', label: 'World' })],
      hiddenCount: 0,
      soloActive: false,
    };

    const strip = await mountStrip(false);

    expect(strip.querySelector('.peek__chip')).toBeNull();
    // Nothing hidden, so the strip is not on the game at all — no reserved row over the stage.
    expect(strip.querySelector('.peek__pill')).toBeNull();
  });

  it('keeps the exit while the mask is actually hiding something', async () => {
    snapshot = {
      branches: [branch({ hidden: true }), branch({ nodeId: 'world', label: 'World' })],
      hiddenCount: 1,
      soloActive: false,
    };

    const strip = await mountStrip(false);

    expect(strip.querySelector('.peek__chip')).toBeNull();
    const pill = strip.querySelector('.peek__pill') as HTMLButtonElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('1 hidden');
    expect(pill.textContent).toContain('Show all');
  });
});
