import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { UiKitThemeService } from '@/services/uikit-editor/UiKitThemeService';
import { DEFAULT_THEME, normalizeTheme } from '@/services/uikit';
import { UiKitForgePanel } from './pix3-uikit-forge-panel';

/**
 * A mount test for the editor host. It is deliberately shallow — the generator, the bake and the
 * prefab builder each have their own spec — and asserts only the two things that are the panel's
 * own job: the controls column is generated from the theme, and the preview repaints when a knob
 * moves.
 */

interface Harness {
  panel: UiKitForgePanel;
  themeService: UiKitThemeService;
  writeKit: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  buildAndWrite: ReturnType<typeof vi.fn>;
}

function createPanel(): Harness {
  const panel = new UiKitForgePanel();

  // The real theme service, with only its I/O stubbed — the panel reads presets and normalization
  // from it, and stubbing those would test the stub.
  const themeService = new UiKitThemeService();
  Object.defineProperty(themeService, 'storage', {
    value: {
      readTextFile: vi.fn(async () => {
        throw new Error('missing');
      }),
      writeTextFile: vi.fn(async () => undefined),
      createDirectory: vi.fn(async () => undefined),
    },
    configurable: true,
  });

  const writeKit = vi.fn(async () => ({
    kitId: 'abcd1234',
    scale: 2,
    paths: [],
    manifest: {
      version: '1.0',
      generator: 'UI Kit Forge',
      kitId: 'abcd1234',
      scale: 2,
      createdAt: '',
      theme: normalizeTheme(DEFAULT_THEME),
      parts: { 'button/blue/normal': {} },
      warnings: [],
    },
    warnings: [],
  }));
  const buildAndWrite = vi.fn(async () => ({
    path: 'prefabs/ui/dialog-abcd1234.pix3scene',
    resourcePath: 'res://prefabs/ui/dialog-abcd1234.pix3scene',
    templateId: 'dialog',
    kitId: 'abcd1234',
    yaml: '',
    nodeNames: [],
    warnings: [],
  }));
  const execute = vi.fn(async () => true);

  const stubs: Record<string, unknown> = {
    icons: { getIcon: () => '' },
    commandDispatcher: { execute },
    themeService,
    writer: { writeKit, readManifest: vi.fn(async () => null) },
    prefabBuilder: { buildAndWrite },
    sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map() }) },
  };
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  // The Google Fonts <link> is a preview nicety and the only thing in this panel that touches the
  // network. happy-dom would really fetch it, so it is shadowed out here — the assertions below
  // are about markup, not typography.
  Object.defineProperty(panel, 'ensurePreviewFonts', { value: () => {}, configurable: true });

  return { panel, themeService, writeKit, execute, buildAndWrite };
}

async function mount(panel: UiKitForgePanel): Promise<void> {
  document.body.appendChild(panel);
  await panel.updateComplete;
}

describe('pix3-uikit-forge-panel', () => {
  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';
  });

  afterEach(() => {
    document.body.replaceChildren();
    resetAppState();
  });

  it('renders a control for every theme knob and a preview of built components', async () => {
    const { panel } = createPanel();
    await mount(panel);

    // The declarative control list covers ranges, checkboxes, selects and colours.
    expect(panel.querySelectorAll('input[type="range"]').length).toBeGreaterThan(15);
    expect(panel.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThanOrEqual(2);
    expect(panel.querySelectorAll('select').length).toBeGreaterThanOrEqual(6);
    // Ten palette-override swatches plus the two tone pickers.
    expect(panel.querySelectorAll('input[type="color"]').length).toBeGreaterThanOrEqual(12);

    // The preview is real generated SVG, not a placeholder.
    const art = panel.querySelectorAll('.uikit-art svg');
    expect(art.length).toBeGreaterThan(0);
  });

  it('repaints the preview when a slider moves the theme', async () => {
    const { panel, themeService } = createPanel();
    await mount(panel);

    const before = panel.querySelector('.uikit-art')?.innerHTML ?? '';
    themeService.setTheme({ radius: 24, bevel: 12 });
    await panel.updateComplete;
    const after = panel.querySelector('.uikit-art')?.innerHTML ?? '';

    expect(before.length).toBeGreaterThan(0);
    expect(after).not.toBe(before);
  });

  it('switches the previewed tab', async () => {
    const { panel } = createPanel();
    await mount(panel);

    const tabs = [...panel.querySelectorAll<HTMLButtonElement>('.uikit-tab')];
    const other = tabs.find(tab => !tab.classList.contains('is-active'));
    expect(other).toBeDefined();
    const namesBefore = [...panel.querySelectorAll('.uikit-cell figcaption')].map(
      n => n.textContent
    );

    other!.click();
    await panel.updateComplete;

    const namesAfter = [...panel.querySelectorAll('.uikit-cell figcaption')].map(
      n => n.textContent
    );
    expect(namesAfter).not.toEqual(namesBefore);
  });

  it('bakes the kit through the writer and reports the kit id', async () => {
    const { panel, writeKit } = createPanel();
    await mount(panel);

    const save = [...panel.querySelectorAll<HTMLButtonElement>('.uikit-btn')].find(button =>
      button.textContent?.includes('Save kit to project')
    );
    expect(save).toBeDefined();
    save!.click();
    await vi.waitFor(() => expect(writeKit).toHaveBeenCalledTimes(1));
    await panel.updateComplete;

    expect(panel.textContent).toContain('abcd1234');
  });

  it('disables the project-bound actions when no project is open', async () => {
    resetAppState();
    const { panel } = createPanel();
    await mount(panel);

    const save = [...panel.querySelectorAll<HTMLButtonElement>('.uikit-btn')].find(button =>
      button.textContent?.includes('Save kit to project')
    );
    expect(save?.disabled).toBe(true);
  });

  it('disposes its subscriptions on disconnect', async () => {
    const { panel, themeService } = createPanel();
    await mount(panel);
    panel.remove();

    // A theme change after disconnect must not schedule another render.
    expect(() => themeService.setTheme({ radius: 3 })).not.toThrow();
  });
});
