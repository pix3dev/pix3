import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { GenerationRecord } from '@/services/image-gen/GenerationHistoryService';
import { GENERATION_DRAG_MIME } from '@/ui/shared/asset-drag-drop';
import {
  ImageEditTargetService,
  type GeneratedImagePayload,
  type ImageEditTarget,
  type ImageEditTargetSnapshot,
} from '@/services/image-gen/ImageEditTargetService';

import { GeneratePanel } from './generate-panel';

/**
 * The dockable Generate panel (C6b). It is general-purpose: it generates with or
 * without an editor bound, and it reaches whatever editor *is* bound only through
 * {@link ImageEditTargetService} — never a component reference (§9.8).
 *
 * The service under test is the real one; everything that reaches IndexedDB, the
 * network or the File System Access API is stubbed.
 */
const PNG_MIME = 'image/png';
/** One transparent pixel, base64 — what the fake provider "generates". */
const PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function createModel(exactSize = false) {
  return {
    id: 'fake-model',
    label: 'Fake Model',
    capabilities: {
      aspectRatios: exactSize ? [] : ['Auto', '1:1'],
      imageSizes: exactSize ? [] : ['1K'],
      qualities: [],
      supportsReferenceImages: true,
      maxReferenceImages: 6,
      supportsTransparency: exactSize,
      supportsExactSize: exactSize,
    },
  };
}

function createPreferences() {
  return {
    selectedProviderId: 'fake',
    modelByProvider: { fake: 'fake-model' },
    defaultAspectRatio: 'Auto' as const,
    defaultImageSize: '1K',
    defaultQuality: '',
    transparentBackground: false,
    defaultExactWidth: 128,
    defaultExactHeight: 128,
    defaultSaveMaxSize: 0,
    bgRemovalEngine: 'u2net' as const,
    bgRemovalQuality: 'balanced' as const,
    bgFillHoles: true,
  };
}

interface PanelStubs {
  generate: ReturnType<typeof vi.fn>;
  historyAdd: ReturnType<typeof vi.fn>;
  historyList: ReturnType<typeof vi.fn>;
  historyGet: ReturnType<typeof vi.fn>;
  writeBinaryFile: ReturnType<typeof vi.fn>;
  focusOrOpenSpriteEditor: ReturnType<typeof vi.fn>;
  targets: ImageEditTargetService;
  sfx: SfxStubs;
}

/** The SFX generator, stubbed: no LLM, no audio context, no IndexedDB. */
interface SfxStubs {
  isAvailable: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  rerender: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
  stopPlayback: ReturnType<typeof vi.fn>;
}

const COIN_SOUNDLINE =
  'sound "coin pickup" 200ms pickup\n  body: tone sine 880Hz | gain 0.8 decay 150ms\n';

/** What a happy `SfxGenService.generate` hands back. */
const soundResult = (over: Record<string, unknown> = {}) => ({
  outcome: 'accepted',
  accepted: true,
  soundline: COIN_SOUNDLINE,
  grammarVersion: 'soundline/v0',
  issues: [],
  llmProviderId: 'stub',
  llmModelId: 'stub-model',
  wav: new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
  durationMs: 250,
  peak: 0.8,
  clipped: false,
  suggestedName: 'coin_pickup',
  ...over,
});

function createSfxStubs(available = true): { stubs: SfxStubs; service: Record<string, unknown> } {
  const stopPlayback = vi.fn();
  const stubs: SfxStubs = {
    isAvailable: vi.fn().mockResolvedValue(available),
    generate: vi.fn().mockResolvedValue(soundResult()),
    rerender: vi.fn().mockResolvedValue(soundResult()),
    play: vi.fn().mockReturnValue({ stop: stopPlayback }),
    stop: vi.fn(),
    save: vi.fn().mockResolvedValue({ path: 'sfx/coin_pickup.wav', bytes: 4, durationMs: 250 }),
    remember: vi.fn().mockResolvedValue(undefined),
    stopPlayback,
  };
  return { stubs, service: { ...stubs } };
}

/**
 * `vector: true` stands in for the `svg-llm` provider: it owns no API key (it borrows the agent's
 * LLM), takes exact W×H instead of an aspect ratio, and returns the SVG source next to the PNG.
 */
interface PanelOptions {
  vector?: boolean;
  /** Whether an LLM lane is reachable for the Sound lane. */
  sfxAvailable?: boolean;
  /** Records `history.list(limit, 'sound')` answers with. */
  soundRecords?: GenerationRecord[];
}

function createPanel(
  records: GenerationRecord[] = [],
  options: PanelOptions = {}
): {
  panel: GeneratePanel;
  stubs: PanelStubs;
} {
  const panel = new GeneratePanel();
  const vector = options.vector === true;
  const model = createModel(vector);
  const preferences = createPreferences();
  const generate = vi.fn().mockResolvedValue({
    images: [
      {
        data: PIXEL_B64,
        mimeType: PNG_MIME,
        ...(vector ? { svgSource: '<svg viewBox="0 0 128 128"><rect /></svg>' } : {}),
      },
    ],
  });
  const provider = {
    id: 'fake',
    label: 'Fake',
    models: [model],
    getModel: (id: string) => (id === model.id ? model : undefined),
    apiKeySecretId: 'fake-key',
    apiKeyHelpUrl: undefined,
    generate,
    ...(vector ? { requiresApiKey: false, isAvailable: async () => true } : {}),
  };
  const historyAdd = vi.fn().mockResolvedValue(undefined);
  // The store is shared between images and sounds; the panel asks for one kind at a time.
  const historyList = vi
    .fn()
    .mockImplementation(async (_limit?: number, kind?: string) =>
      kind === 'sound' ? (options.soundRecords ?? []) : records
    );
  const sfx = createSfxStubs(options.sfxAvailable !== false);
  // The stored copy the panel re-reads before pasting into a frame, keyed the
  // same way IndexedDB keys it.
  const historyGet = vi
    .fn()
    .mockImplementation(async (id: string) => records.find(record => record.id === id));
  const writeBinaryFile = vi.fn().mockResolvedValue(undefined);
  const focusOrOpenSpriteEditor = vi.fn().mockResolvedValue(undefined);
  const targets = new ImageEditTargetService();

  const stubs: Record<string, unknown> = {
    providers: {
      get: (id: string) => (id === 'fake' ? provider : undefined),
      list: () => [provider],
    },
    aiSettings: {
      getPreferences: () => ({ ...preferences }),
      getSelectedProvider: () => provider,
      getSelectedModelId: () => model.id,
      hasApiKey: vi.fn().mockResolvedValue(true),
      getApiKey: vi.fn().mockResolvedValue('sk-test'),
      subscribe: (listener: () => void) => {
        listener();
        return () => undefined;
      },
      updatePreferences: vi.fn(),
    },
    history: {
      subscribe: vi.fn().mockReturnValue(() => undefined),
      list: historyList,
      get: historyGet,
      add: historyAdd,
      delete: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    imageEditTargets: targets,
    storage: { readBlob: vi.fn(), writeBinaryFile, createDirectory: vi.fn() },
    editorSettings: { showSettings: vi.fn() },
    editorTabs: { focusOrOpenSpriteEditor },
    assetLibrary: { isUserScopeSupported: () => false },
    sfxGen: sfx.service,
  };

  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(panel, key, { value, configurable: true });
  }

  return {
    panel,
    stubs: {
      generate,
      historyAdd,
      historyList,
      historyGet,
      writeBinaryFile,
      focusOrOpenSpriteEditor,
      targets,
      sfx: sfx.stubs,
    },
  };
}

/** One stored generation, as `GenerationHistoryService.list()` would hand it back. */
function createHistoryRecord(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id: 'rec-1',
    providerId: 'fake',
    modelId: 'fake-model',
    prompt: 'A brass gear',
    aspectRatio: 'Auto',
    imageSize: '1K',
    mimeType: PNG_MIME,
    blob: new Blob([new Uint8Array([1])], { type: PNG_MIME }),
    width: 64,
    height: 64,
    createdAt: 0,
    ...overrides,
  };
}

/** A minimal stand-in for the Sprite Editor shell's target implementation. */
function createTarget(overrides: Partial<ImageEditTargetSnapshot> = {}) {
  const applied: GeneratedImagePayload[] = [];
  const listeners = new Set<() => void>();
  let snapshot: ImageEditTargetSnapshot = {
    targetId: 'sprite-editor:res://sprites/ex0059.png',
    label: 'ex0059.png',
    resourcePath: 'res://sprites/ex0059.png',
    boundFrameTexturePath: null,
    acceptsFrameWriteBack: false,
    ...overrides,
  };
  const target: ImageEditTarget = {
    getImageEditSnapshot: () => snapshot,
    subscribeImageEditTarget: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyGeneratedImage: image => {
      applied.push(image);
    },
  };
  return {
    target,
    applied,
    update(next: Partial<ImageEditTargetSnapshot>): void {
      snapshot = { ...snapshot, ...next };
      listeners.forEach(listener => listener());
    },
  };
}

async function mount(panel: GeneratePanel): Promise<void> {
  document.body.appendChild(panel);
  await panel.updateComplete;
}

/**
 * Type a prompt, hit Generate, and wait for the run to finish. The end marker is
 * `history.add` — the last step of the happy path — because the button label is
 * back to "Generate" both before the first render of the in-flight state and
 * after it, so it cannot be waited on.
 */
async function generate(panel: GeneratePanel, prompt: string, stubs: PanelStubs): Promise<void> {
  const textarea = panel.querySelector<HTMLTextAreaElement>('.gp-prompt');
  if (!textarea) {
    throw new Error('prompt textarea not rendered');
  }
  textarea.value = prompt;
  textarea.dispatchEvent(new Event('input'));
  await panel.updateComplete;
  panel.querySelector<HTMLButtonElement>('.gp-generate-button')?.click();
  await vi.waitFor(() => {
    expect(stubs.historyAdd).toHaveBeenCalled();
  });
  await panel.updateComplete;
}

/**
 * happy-dom never fires `load`/`error` for an `<img>` pointed at a blob URL, and
 * the panel measures every generated image that way before it delivers it — left
 * alone, the whole generation chain simply parks. Shim the decode, not the panel.
 */
function stubImageDecoding(): void {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 64;
    naturalHeight = 64;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

describe('GeneratePanel', () => {
  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';
    stubImageDecoding();
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the prompt bar and generates with no editor bound, offering to save', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);

    expect(panel.querySelector('.gp-prompt')).not.toBeNull();
    // No target: the head says so rather than pretending there is a canvas.
    expect(panel.querySelector('.gp-target')?.textContent).toContain('No image editor open');

    await generate(panel, 'A brass gear', stubs);

    expect(stubs.generate).toHaveBeenCalledTimes(1);
    expect(stubs.historyAdd).toHaveBeenCalledTimes(1);

    // The original Asset Generator ending survives: name + save into the project.
    const nameInput = panel.querySelector<HTMLInputElement>('.gp-result-name');
    expect(nameInput).not.toBeNull();
    expect(nameInput?.value).toBe('sprites/generated/a-brass-gear.png');

    panel.querySelectorAll<HTMLButtonElement>('.gp-result-actions button')[0]?.click();
    await vi.waitFor(() => {
      expect(stubs.writeBinaryFile).toHaveBeenCalledTimes(1);
    });
    expect(stubs.writeBinaryFile.mock.calls[0][0]).toBe('sprites/generated/a-brass-gear.png');
  });

  it('routes a generated image to a registered editor instead of the result block', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);

    const { target, applied } = createTarget();
    stubs.targets.setActiveTarget(target);
    await panel.updateComplete;
    expect(panel.querySelector('.gp-target')?.textContent).toContain('ex0059.png');

    await generate(panel, 'A brass gear', stubs);

    expect(applied).toHaveLength(1);
    expect(applied[0].mimeType).toBe(PNG_MIME);
    expect(applied[0].prompt).toBe('A brass gear');
    // Delivered — so no standalone save block is offered.
    expect(panel.querySelector('.gp-result')).toBeNull();
  });

  it('keeps the result here when the bound frame cannot take a write-back', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);

    const { target, applied } = createTarget({
      label: 'walk.pix3anim',
      boundFrameTexturePath: 'res://sprites/walk/idle_0001.png',
      acceptsFrameWriteBack: false,
    });
    stubs.targets.setActiveTarget(target);
    await panel.updateComplete;

    await generate(panel, 'A brass gear', stubs);

    expect(applied).toHaveLength(0);
    expect(panel.querySelector('.gp-result')).not.toBeNull();
  });

  it('delivers into the bound frame once the target accepts write-back (C7)', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);

    const { target, applied } = createTarget({
      label: 'walk.pix3anim',
      boundFrameTexturePath: 'res://sprites/walk/idle_0001.png',
      acceptsFrameWriteBack: true,
    });
    stubs.targets.setActiveTarget(target);
    await panel.updateComplete;
    expect(panel.querySelector('.gp-target')?.textContent).toContain('into the selected frame');

    await generate(panel, 'A brass gear', stubs);

    expect(applied).toHaveLength(1);
    expect(applied[0].prompt).toBe('A brass gear');
    // Delivered into the frame — nothing is left here to save by hand.
    expect(panel.querySelector('.gp-result')).toBeNull();
  });

  it('follows the bound editor when its snapshot changes', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);

    const binding = createTarget();
    stubs.targets.setActiveTarget(binding.target);
    await panel.updateComplete;
    expect(panel.querySelector('.gp-target')?.textContent).toContain('ex0059.png');

    binding.update({ label: 'ex0060.png' });
    await panel.updateComplete;
    expect(panel.querySelector('.gp-target')?.textContent).toContain('ex0060.png');

    // Deregistration falls back to the standalone wording.
    stubs.targets.clearActiveTarget(binding.target);
    await panel.updateComplete;
    expect(panel.querySelector('.gp-target')?.textContent).toContain('No image editor open');
  });

  it('applies a history entry to the bound canvas and keeps the drag payload intact', async () => {
    const record: GenerationRecord = {
      id: 'rec-1',
      providerId: 'fake',
      modelId: 'fake-model',
      prompt: 'A brass gear',
      aspectRatio: 'Auto',
      imageSize: '1K',
      mimeType: PNG_MIME,
      blob: new Blob([new Uint8Array([1])], { type: PNG_MIME }),
      width: 64,
      height: 64,
      createdAt: 0,
    } as GenerationRecord;
    const { panel, stubs } = createPanel([record]);
    await mount(panel);

    await vi.waitFor(() => {
      expect(panel.querySelector('.gp-history-thumb')).not.toBeNull();
    });

    const dataTransfer = new DataTransfer();
    const dragEvent = new DragEvent('dragstart', { bubbles: true });
    Object.defineProperty(dragEvent, 'dataTransfer', { value: dataTransfer });
    panel.querySelector<HTMLButtonElement>('.gp-history-thumb')?.dispatchEvent(dragEvent);
    expect(JSON.parse(dataTransfer.getData(GENERATION_DRAG_MIME))).toEqual({
      id: 'rec-1',
      suggestedName: 'a-brass-gear.png',
    });

    const { target, applied } = createTarget();
    stubs.targets.setActiveTarget(target);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>('.gp-history-thumb')?.click();
    await panel.updateComplete;
    expect(applied).toHaveLength(1);
    expect(applied[0].blob).toBe(record.blob);
  });

  it('only enables "Apply to current frame" while a writable frame is bound (P5b)', async () => {
    const { panel, stubs } = createPanel([createHistoryRecord()]);
    await mount(panel);
    await vi.waitFor(() => {
      expect(panel.querySelector('.gp-history-apply')).not.toBeNull();
    });
    const applyButton = () => panel.querySelector<HTMLButtonElement>('.gp-history-apply');

    // No editor bound at all.
    expect(applyButton()?.disabled).toBe(true);

    // A plain image canvas: applicable, but there is no frame behind it, so the
    // frame paste stays off (the thumbnail itself already covers that case).
    const plain = createTarget();
    stubs.targets.setActiveTarget(plain.target);
    await panel.updateComplete;
    expect(applyButton()?.disabled).toBe(true);
    stubs.targets.clearActiveTarget(plain.target);

    // A frame-bound canvas that cannot take a write-back right now (§9.5).
    const blocked = createTarget({
      label: 'walk.pix3anim',
      boundFrameTexturePath: 'res://sprites/walk/idle_0001.png',
      acceptsFrameWriteBack: false,
    });
    stubs.targets.setActiveTarget(blocked.target);
    await panel.updateComplete;
    expect(applyButton()?.disabled).toBe(true);

    blocked.update({ acceptsFrameWriteBack: true });
    await panel.updateComplete;
    expect(applyButton()?.disabled).toBe(false);
    expect(applyButton()?.getAttribute('title')).toBe('Apply to current frame');
  });

  it('pastes the stored generation into the bound frame when applied (P5b)', async () => {
    const record = createHistoryRecord();
    const { panel, stubs } = createPanel([record]);
    await mount(panel);
    await vi.waitFor(() => {
      expect(panel.querySelector('.gp-history-apply')).not.toBeNull();
    });

    const { target, applied } = createTarget({
      label: 'walk.pix3anim',
      boundFrameTexturePath: 'res://sprites/walk/idle_0001.png',
      acceptsFrameWriteBack: true,
    });
    stubs.targets.setActiveTarget(target);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>('.gp-history-apply')?.click();

    await vi.waitFor(() => {
      expect(applied).toHaveLength(1);
    });
    expect(stubs.historyGet).toHaveBeenCalledWith('rec-1');
    expect(applied[0].blob).toBe(record.blob);
    expect(applied[0].mimeType).toBe(PNG_MIME);
    expect(applied[0].prompt).toBe('A brass gear');
    // The size travels with it: that is what lets the Sprite Editor decide
    // between an immediate write-back and place mode (§9.11.0).
    expect(applied[0].width).toBe(64);
    expect(applied[0].height).toBe(64);
    // A paste is not a "continue from here": the prompt bar is untouched.
    expect(panel.querySelector<HTMLTextAreaElement>('.gp-prompt')?.value).toBe('');
  });

  it('re-mints history thumbnails after a Golden Layout re-dock', async () => {
    const record = {
      id: 'rec-1',
      providerId: 'fake',
      modelId: 'fake-model',
      prompt: 'A brass gear',
      aspectRatio: 'Auto',
      imageSize: '1K',
      mimeType: PNG_MIME,
      blob: new Blob([new Uint8Array([1])], { type: PNG_MIME }),
      createdAt: 0,
    } as GenerationRecord;
    const { panel } = createPanel([record]);
    await mount(panel);

    await vi.waitFor(() => {
      expect(panel.querySelector<HTMLImageElement>('.gp-history-thumb img')?.src).toBeTruthy();
    });
    const before = panel.querySelector<HTMLImageElement>('.gp-history-thumb img')?.src;

    // Golden Layout destroys and recreates a panel on dock/undock; disconnect
    // revoked every object URL it owned.
    panel.remove();
    const urls = (panel as unknown as { historyUrls: Map<string, string> }).historyUrls;
    expect(urls.size).toBe(0);

    await mount(panel);
    // The thumbnail comes back pointing at a freshly minted URL, not the revoked one.
    await vi.waitFor(() => {
      expect(urls.size).toBe(1);
      expect(panel.querySelector<HTMLImageElement>('.gp-history-thumb img')?.src).toBe(
        urls.get('rec-1')
      );
    });
    expect(before).toBeTruthy();
    expect(urls.get('rec-1')).not.toBe(before);
  });
});

/**
 * A provider that authors vectors (`svg-llm`) changes three things in this panel: exact W×H replaces
 * the aspect-ratio lottery, there is no key to nag for, and the SVG source comes back as a
 * first-class artifact that the next Generate can edit instead of re-rolling.
 */
/**
 * {@link generate} waits for `history.add`, which is already satisfied on a second run — so a test
 * that generates twice must reset the marker or it races ahead of the first delivery.
 */
async function generateAgain(
  panel: GeneratePanel,
  prompt: string,
  stubs: PanelStubs
): Promise<void> {
  stubs.historyAdd.mockClear();
  await generate(panel, prompt, stubs);
}

describe('GeneratePanel with an exact-size, keyless provider', () => {
  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';
    stubImageDecoding();
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows W×H inputs with presets instead of the aspect-ratio control', async () => {
    const { panel } = createPanel([], { vector: true });
    await mount(panel);

    const inputs = panel.querySelectorAll<HTMLInputElement>('.gp-size-input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe('128');
    expect(inputs[1].value).toBe('128');
    expect(panel.querySelectorAll('.gp-size-preset').length).toBeGreaterThan(0);

    // The aspect picker lives in the quick-settings popover and must be gone there too.
    panel.querySelector<HTMLButtonElement>('.gp-key-button')?.click();
    await panel.updateComplete;
    const popover = panel.querySelector('.gp-key-popover');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).not.toContain('Aspect');
  });

  it('hides the W×H row for a raster provider', async () => {
    const { panel } = createPanel();
    await mount(panel);
    expect(panel.querySelector('.gp-size-input')).toBeNull();
  });

  it('sends the requested exact size to the provider', async () => {
    const { panel, stubs } = createPanel([], { vector: true });
    await mount(panel);

    const [widthInput] = panel.querySelectorAll<HTMLInputElement>('.gp-size-input');
    widthInput.value = '96';
    widthInput.dispatchEvent(new Event('change'));
    await panel.updateComplete;

    await generate(panel, 'a coin', stubs);
    expect(stubs.generate).toHaveBeenCalledWith(
      expect.objectContaining({ width: 96, height: 96 }),
      expect.anything()
    );
  });

  it('keeps width and height independent once the ratio lock is released', async () => {
    const { panel } = createPanel([], { vector: true });
    await mount(panel);

    panel.querySelector<HTMLButtonElement>('.gp-size-lock')?.click();
    await panel.updateComplete;

    const [widthInput, heightInput] = panel.querySelectorAll<HTMLInputElement>('.gp-size-input');
    widthInput.value = '96';
    widthInput.dispatchEvent(new Event('change'));
    await panel.updateComplete;
    expect(heightInput.value).toBe('128');
  });

  it('never asks for an API key and still enables Generate', async () => {
    const { panel } = createPanel([], { vector: true });
    await mount(panel);

    panel.querySelector<HTMLButtonElement>('.gp-key-button')?.click();
    await panel.updateComplete;
    const popover = panel.querySelector('.gp-key-popover');
    expect(popover?.querySelector('input[type="password"]')).toBeNull();
    expect(popover?.textContent).toContain('Agent LLM ready');

    const textarea = panel.querySelector<HTMLTextAreaElement>('.gp-prompt');
    textarea!.value = 'a coin';
    textarea!.dispatchEvent(new Event('input'));
    await panel.updateComplete;
    expect(panel.querySelector<HTMLButtonElement>('.gp-generate-button')?.disabled).toBe(false);
  });

  it('badges the result as SVG, stores the source in history, and shows it on demand', async () => {
    const { panel, stubs } = createPanel([], { vector: true });
    await mount(panel);
    await generate(panel, 'a coin', stubs);

    expect(panel.querySelector('.gp-badge')?.textContent).toContain('SVG');
    expect(stubs.historyAdd).toHaveBeenCalledWith(
      expect.objectContaining({ svgSource: expect.stringContaining('<svg') })
    );

    // The source is collapsed by default — it is a power-user affordance, not the headline.
    expect(panel.querySelector('.gp-source-code')).toBeNull();
    panel.querySelector<HTMLButtonElement>('.gp-source-toggle')?.click();
    await panel.updateComplete;
    expect(panel.querySelector('.gp-source-code')?.textContent).toContain('<svg');
  });

  it('re-sends the source only when the user arms "Edit this SVG"', async () => {
    const { panel, stubs } = createPanel([], { vector: true });
    await mount(panel);
    await generate(panel, 'a coin', stubs);

    // A new prompt over an old result is a new sprite by default.
    await generateAgain(panel, 'a gem', stubs);
    expect(stubs.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ svgSource: undefined }),
      expect.anything()
    );

    const toggle = panel.querySelector<HTMLInputElement>('.gp-source .gp-toggle-field input');
    expect(toggle).not.toBeNull();
    toggle!.click();
    await panel.updateComplete;
    expect((panel as unknown as { editSource: boolean }).editSource).toBe(true);

    await generateAgain(panel, 'thicker outline', stubs);
    expect(stubs.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ svgSource: expect.stringContaining('<svg') }),
      expect.anything()
    );
  });
});

/**
 * Sound mode. The txt2sfx loop, the renderer and the audio contexts are all behind
 * {@link SfxGenService}, which is stubbed here — what is asserted is that the panel drives it
 * correctly and, in particular, that a *refusal* (voices, believable animals, real recordings) is
 * presented as a normal explained result rather than as an error.
 */
async function switchToSound(panel: GeneratePanel, stubs: PanelStubs): Promise<void> {
  panel.querySelectorAll<HTMLButtonElement>('.gp-mode-button')[1]?.click();
  await panel.updateComplete;
  await vi.waitFor(() => {
    expect(stubs.sfx.isAvailable).toHaveBeenCalled();
  });
  await panel.updateComplete;
}

async function generateSound(
  panel: GeneratePanel,
  prompt: string,
  stubs: PanelStubs
): Promise<void> {
  const textarea = panel.querySelector<HTMLTextAreaElement>('.gp-sound-prompt');
  if (!textarea) {
    throw new Error('sound prompt textarea not rendered');
  }
  textarea.value = prompt;
  textarea.dispatchEvent(new Event('input'));
  await panel.updateComplete;
  panel.querySelector<HTMLButtonElement>('.gp-generate-button')?.click();
  await vi.waitFor(() => {
    expect(stubs.sfx.generate).toHaveBeenCalled();
  });
  await settleSound(panel);
}

/**
 * Wait for a sound run to *settle*.
 *
 * A run finishes several awaits after `generate` resolves — result adopted, history written, list
 * reloaded — and the in-flight flag that disables the edit controls only clears after all of them. A
 * bare `updateComplete` therefore returns mid-run with a half-rendered lane, so this polls for
 * "Cancel is gone AND there is something to show", flushing Lit on every poll.
 */
async function settleSound(panel: GeneratePanel): Promise<void> {
  await vi.waitFor(async () => {
    await panel.updateComplete;
    expect(panel.querySelector('.gp-cancel-button')).toBeNull();
    expect(
      panel.querySelector('.gp-sound-result') ?? panel.querySelector('.gp-error')
    ).not.toBeNull();
  });
}

describe('GeneratePanel sound mode', () => {
  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';
    stubImageDecoding();
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts in image mode and swaps the body for the sound lane on toggle', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);

    expect(panel.querySelector('.gp-prompt')).not.toBeNull();
    expect(panel.querySelector('.gp-sound-prompt')).toBeNull();

    await switchToSound(panel, stubs);

    expect(panel.querySelector('.gp-sound-prompt')).not.toBeNull();
    // The image lane's prompt, references and history are gone, not just hidden.
    expect(panel.querySelector('.gp-prompt')).toBeNull();
    expect(panel.querySelector('.gp-references')).toBeNull();
    expect(panel.querySelector('.gp-target')?.textContent).toContain('res://sfx/');
  });

  it('never asks for an API key — it points at Agent settings when no lane is reachable', async () => {
    const { panel, stubs } = createPanel([], { sfxAvailable: false });
    await mount(panel);
    await switchToSound(panel, stubs);

    const hint = panel.querySelector('.gp-sound-hint');
    expect(hint?.textContent).toContain('Agent settings');
    expect(panel.querySelector('.gp-sound-hint input[type="password"]')).toBeNull();

    // Generate stays off until a lane exists, even with a prompt typed.
    const textarea = panel.querySelector<HTMLTextAreaElement>('.gp-sound-prompt');
    textarea!.value = 'a coin';
    textarea!.dispatchEvent(new Event('input'));
    await panel.updateComplete;
    expect(panel.querySelector<HTMLButtonElement>('.gp-generate-button')?.disabled).toBe(true);
  });

  it('generates, shows duration/peak, remembers it, and offers the derived save name', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'crisp coin pickup', stubs);

    expect(stubs.sfx.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'crisp coin pickup' })
    );
    // Not an edit: no soundline was sent.
    expect(stubs.sfx.generate.mock.calls[0][0].soundline).toBeUndefined();

    const meta = panel.querySelector('.gp-sound-meta')?.textContent ?? '';
    expect(meta).toContain('coin pickup');
    expect(meta).toContain('250 ms');
    expect(meta).toContain('0.80');

    expect(stubs.sfx.remember).toHaveBeenCalledWith(expect.anything(), 'crisp coin pickup');
    expect(panel.querySelector<HTMLInputElement>('.gp-sound-name')?.value).toBe('coin_pickup');
  });

  it('shows the progress events as ONE updating line, cleared when the result lands', async () => {
    const { panel, stubs } = createPanel();
    const lines: string[] = [];
    stubs.sfx.generate.mockImplementation(
      async (options: { onEvent?: (event: { type: string; [key: string]: unknown }) => void }) => {
        options.onEvent?.({ type: 'request', iteration: 1 });
        lines.push(panel.querySelectorAll('.gp-sound-progress').length.toString());
        options.onEvent?.({ type: 'rendered', iteration: 1, peak: 0.5 });
        return soundResult();
      }
    );
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a coin', stubs);

    // Never more than one progress element at a time, and none once there is a result.
    expect(lines.every(count => Number(count) <= 1)).toBe(true);
    expect(panel.querySelectorAll('.gp-sound-progress').length).toBe(0);
    expect(panel.querySelector('.gp-sound-result')).not.toBeNull();
  });

  it('renders validator warnings alongside an accepted sound', async () => {
    const { panel, stubs } = createPanel();
    stubs.sfx.generate.mockResolvedValue(
      soundResult({
        issues: [
          {
            severity: 'warn',
            layer: 'body',
            rule: 'pickup.decay',
            got: '150ms',
            expected: '< 120ms',
            hint: 'Shorten the decay.',
          },
        ],
      })
    );
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a coin', stubs);

    const issue = panel.querySelector('.gp-sound-issue');
    expect(issue?.className).toContain('is-warn');
    expect(issue?.textContent).toContain('Shorten the decay.');
    expect(issue?.textContent).toContain('pickup.decay');
  });

  it('presents a refusal as an explained result with no save action', async () => {
    const { panel, stubs } = createPanel();
    stubs.sfx.generate.mockResolvedValue(
      soundResult({
        accepted: false,
        outcome: 'refused',
        soundline: '',
        wav: undefined,
        durationMs: undefined,
        peak: undefined,
        message: 'A human voice is out of scope for procedural synthesis.',
        suggestedName: undefined,
      })
    );
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a man saying hello', stubs);

    const outcome = panel.querySelector('.gp-sound-outcome');
    expect(outcome?.className).toContain('is-refused');
    expect(outcome?.textContent).toContain('out of scope');
    // Not an error banner, and nothing to save or play.
    expect(panel.querySelector('.gp-error')).toBeNull();
    expect(panel.querySelector('.gp-sound-name')).toBeNull();
    expect(panel.querySelector<HTMLButtonElement>('.gp-sound-play')?.disabled).toBe(true);
  });

  it('plays the live graph and stops it again', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a coin', stubs);

    panel.querySelector<HTMLButtonElement>('.gp-sound-play')?.click();
    await panel.updateComplete;
    expect(stubs.sfx.play).toHaveBeenCalledWith(COIN_SOUNDLINE);

    panel.querySelector<HTMLButtonElement>('.gp-sound-play')?.click();
    await panel.updateComplete;
    expect(stubs.sfx.stopPlayback).toHaveBeenCalled();
  });

  it('shows the recipe source on demand, collapsed by default', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a coin', stubs);

    expect(panel.querySelector('.gp-source-code')).toBeNull();
    expect(panel.querySelector('.gp-source-toggle')?.textContent).toContain('soundline/v0');
    panel.querySelector<HTMLButtonElement>('.gp-source-toggle')?.click();
    await panel.updateComplete;
    expect(panel.querySelector('.gp-source-code')?.textContent).toContain('sound "coin pickup"');
  });

  it('saves into res://sfx/ under the typed name', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a coin', stubs);

    panel.querySelector<HTMLButtonElement>('.gp-result-actions button')?.click();
    await vi.waitFor(() => {
      expect(stubs.sfx.save).toHaveBeenCalled();
    });
    expect(stubs.sfx.save.mock.calls[0][1]).toBe('coin_pickup');
    await panel.updateComplete;
    expect(panel.querySelector('.gp-success')?.textContent).toContain('res://sfx/coin_pickup.wav');
  });

  it('sends the CURRENT recipe plus the feedback on "Apply change"', async () => {
    const { panel, stubs } = createPanel();
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a coin', stubs);

    const feedback = panel.querySelector<HTMLTextAreaElement>('.gp-sound-feedback-input');
    expect(feedback).not.toBeNull();
    feedback!.value = 'duller, 100 ms shorter';
    feedback!.dispatchEvent(new Event('input'));
    await panel.updateComplete;

    stubs.sfx.generate.mockClear();
    const apply = panel.querySelector<HTMLButtonElement>('.gp-sound-feedback .gp-action-button');
    expect(apply?.disabled).toBe(false);
    apply?.click();
    await vi.waitFor(() => {
      expect(stubs.sfx.generate).toHaveBeenCalled();
    });
    expect(stubs.sfx.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'duller, 100 ms shorter', soundline: COIN_SOUNDLINE })
    );
    await settleSound(panel);
    // The box is cleared so the next change is typed fresh, not appended to the last one.
    await vi.waitFor(async () => {
      await panel.updateComplete;
      expect(panel.querySelector<HTMLTextAreaElement>('.gp-sound-feedback-input')?.value).toBe('');
    });
  });

  it('re-renders a stored recipe when a history row is opened — no model call', async () => {
    const record = {
      id: 'snd-1',
      kind: 'sound',
      providerId: 'stub',
      modelId: 'stub-model',
      prompt: 'crisp coin pickup',
      mimeType: 'audio/wav',
      blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
      soundlineSource: COIN_SOUNDLINE,
      grammarVersion: 'soundline/v0',
      durationMs: 250,
      createdAt: 0,
    } as GenerationRecord;
    const { panel, stubs } = createPanel([], { soundRecords: [record] });
    await mount(panel);
    await switchToSound(panel, stubs);

    await vi.waitFor(() => {
      expect(panel.querySelector('.gp-sound-history-open')).not.toBeNull();
    });
    panel.querySelector<HTMLButtonElement>('.gp-sound-history-open')?.click();
    await vi.waitFor(() => {
      expect(stubs.sfx.rerender).toHaveBeenCalledWith(COIN_SOUNDLINE);
    });
    await panel.updateComplete;
    expect(stubs.sfx.generate).not.toHaveBeenCalled();
    // The prompt comes back too, so "one more tweak" continues from where it left off.
    expect(panel.querySelector<HTMLTextAreaElement>('.gp-sound-prompt')?.value).toBe(
      'crisp coin pickup'
    );
  });

  it('surfaces a thrown generation failure as an error banner', async () => {
    const { panel, stubs } = createPanel();
    stubs.sfx.generate.mockRejectedValue(new Error('No LLM is configured for the agent.'));
    await mount(panel);
    await switchToSound(panel, stubs);
    await generateSound(panel, 'a coin', stubs);

    expect(panel.querySelector('.gp-error')?.textContent).toContain('No LLM is configured');
    expect(panel.querySelector('.gp-sound-result')).toBeNull();
  });
});
