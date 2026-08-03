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

function createModel() {
  return {
    id: 'fake-model',
    label: 'Fake Model',
    capabilities: {
      aspectRatios: ['Auto', '1:1'],
      imageSizes: ['1K'],
      qualities: [],
      supportsReferenceImages: true,
      maxReferenceImages: 6,
      supportsTransparency: false,
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
    defaultSaveMaxSize: 0,
    bgRemovalEngine: 'imgly' as const,
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
}

function createPanel(records: GenerationRecord[] = []): {
  panel: GeneratePanel;
  stubs: PanelStubs;
} {
  const panel = new GeneratePanel();
  const model = createModel();
  const preferences = createPreferences();
  const generate = vi.fn().mockResolvedValue({
    images: [{ data: PIXEL_B64, mimeType: PNG_MIME }],
  });
  const provider = {
    id: 'fake',
    label: 'Fake',
    models: [model],
    getModel: (id: string) => (id === model.id ? model : undefined),
    apiKeySecretId: 'fake-key',
    apiKeyHelpUrl: undefined,
    generate,
  };
  const historyAdd = vi.fn().mockResolvedValue(undefined);
  const historyList = vi.fn().mockResolvedValue(records);
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
