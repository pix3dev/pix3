import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, GenerateResult } from '@txt2sfx/agent';

import { appState, resetAppState } from '@/state';
import type { LlmLane } from '@/services/llm/LlmLaneResolver';

/**
 * The renderer, the validator, the optimizer and the loop are txt2sfx's own test surface (and neither
 * `OfflineAudioContext` nor `AudioContext` exists under happy-dom), so those three functions are
 * stubbed and what is asserted here is *our* orchestration: lane resolution, the edit prompt, the
 * WAV/history/save plumbing, and how an outcome is explained. `parse`, `serialize` and `validate` stay
 * real — they are pure text work, and the recipes in the spec are real recipes.
 */
const renderSound = vi.hoisted(() => vi.fn());
const encodeWav = vi.hoisted(() => vi.fn());
const generateSound = vi.hoisted(() => vi.fn());
const buildGraph = vi.hoisted(() => vi.fn());

vi.mock('@txt2sfx/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@txt2sfx/core')>()),
  renderSound,
  encodeWav,
  buildGraph,
}));

vi.mock('@txt2sfx/agent', async importOriginal => ({
  ...(await importOriginal<typeof import('@txt2sfx/agent')>()),
  generateSound,
}));

const {
  MAX_SFX_ITERATIONS,
  SOUNDLINE_GRAMMAR_VERSION,
  SfxGenError,
  SfxGenService,
  buildSfxEditPrompt,
  describeSfxEvent,
  describeSfxOutcome,
  isSfxEditRequest,
  resolveSfxPath,
  sfxFileStem,
} = await import('./SfxGenService');

const COIN = 'sound "coin pickup" 200ms pickup\n  body: tone sine 880Hz | gain 0.8 decay 150ms\n';

/** A `RenderResult`-shaped stand-in: one channel of silence with a known length. */
const fakeRender = (durationMs = 250, peak = 0.8, clipped = false) => ({
  buffer: {
    sampleRate: 44100,
    getChannelData: () => new Float32Array(8),
  } as unknown as AudioBuffer,
  ir: {},
  peak,
  clipped,
  durationMs,
});

const fakeLoopResult = (over: Partial<GenerateResult> = {}): GenerateResult => ({
  accepted: true,
  outcome: 'accepted',
  soundline: COIN,
  issues: [],
  attempts: [],
  examples: [],
  fallbackExamples: false,
  ...over,
});

interface Harness {
  service: InstanceType<typeof SfxGenService>;
  resolve: ReturnType<typeof vi.fn>;
  getApiKey: ReturnType<typeof vi.fn>;
  isAvailable: ReturnType<typeof vi.fn>;
  writeBinaryFile: ReturnType<typeof vi.fn>;
  createDirectory: ReturnType<typeof vi.fn>;
  historyAdd: ReturnType<typeof vi.fn>;
}

const fakeLane = (): LlmLane =>
  ({
    provider: { id: 'stub', label: 'Stub' },
    modelId: 'stub-model',
  }) as unknown as LlmLane;

function createService(options: { lane?: LlmLane | null; apiKey?: string } = {}): Harness {
  const service = new SfxGenService();
  const resolve = vi.fn(() => (options.lane === undefined ? fakeLane() : options.lane));
  const getApiKey = vi.fn(async () => options.apiKey ?? 'sk-test');
  const isAvailable = vi.fn(async () => true);
  const writeBinaryFile = vi.fn(async () => undefined);
  const createDirectory = vi.fn(async () => undefined);
  const historyAdd = vi.fn(async () => undefined);

  Object.defineProperty(service, 'lanes', {
    value: { resolve, getApiKey, isAvailable, listOptions: () => [] },
    configurable: true,
  });
  Object.defineProperty(service, 'storage', {
    value: { writeBinaryFile, createDirectory },
    configurable: true,
  });
  Object.defineProperty(service, 'historyService', {
    value: { add: historyAdd },
    configurable: true,
  });
  service.setAudioFactories({ offline: (() => ({})) as never });

  return { service, resolve, getApiKey, isAvailable, writeBinaryFile, createDirectory, historyAdd };
}

beforeEach(() => {
  resetAppState();
  appState.project.status = 'ready';
  renderSound.mockResolvedValue(fakeRender());
  encodeWav.mockReturnValue(new Uint8Array([82, 73, 70, 70]));
  generateSound.mockResolvedValue(fakeLoopResult());
});

afterEach(() => {
  resetAppState();
  vi.clearAllMocks();
});

describe('isSfxEditRequest / buildSfxEditPrompt', () => {
  it('treats a blank soundline as no soundline at all', () => {
    expect(isSfxEditRequest({})).toBe(false);
    expect(isSfxEditRequest({ soundline: '  \n' })).toBe(false);
    expect(isSfxEditRequest({ soundline: COIN })).toBe(true);
  });

  it('quotes the current recipe, states the change, and forbids a redesign', () => {
    const text = buildSfxEditPrompt(COIN, 'duller and 100 ms shorter');
    expect(text).toContain('current soundline recipe');
    expect(text).toContain('sound "coin pickup"');
    expect(text).toContain('Change requested: duller and 100 ms shorter');
    expect(text).toMatch(/keep every layer, primitive and effect the request does not touch/i);
    // The optimizer needs the search space to survive the edit.
    expect(text).toContain('~value[min..max]');
  });
});

describe('sfxFileStem', () => {
  it('drops the redundant sfx_ prefix — the folder already says it', () => {
    expect(sfxFileStem('Coin Pickup')).toBe('coin_pickup');
  });

  it('keeps the prefix when dropping it would leave a leading digit', () => {
    // An asset name gets pasted into code as an identifier; `3_round_burst` is not one.
    expect(sfxFileStem('3 Round Burst')).toBe('sfx_3_round_burst');
  });

  it('folds diacritics and answers empty when nothing ASCII survives', () => {
    expect(sfxFileStem('Café Door')).toBe('cafe_door');
    expect(sfxFileStem('шаги')).toBe('');
  });
});

describe('resolveSfxPath', () => {
  it('puts a bare name in the sfx folder and adds the extension', () => {
    expect(resolveSfxPath('pop')).toBe('sfx/pop.wav');
    expect(resolveSfxPath('pop.wav')).toBe('sfx/pop.wav');
  });

  it('respects an explicit path and strips a res:// prefix', () => {
    expect(resolveSfxPath('res://audio/ui/pop.wav')).toBe('audio/ui/pop.wav');
    expect(resolveSfxPath('audio/ui/pop')).toBe('audio/ui/pop.wav');
  });

  it('answers empty for an empty name so the caller can refuse', () => {
    expect(resolveSfxPath('   ')).toBe('');
  });
});

describe('describeSfxEvent', () => {
  it('says when retrieval matched nothing, because a fallback slate looks like a hit', () => {
    const event: AgentEvent = { type: 'retrieval', query: 'coin', count: 3, fallback: true };
    expect(describeSfxEvent(event)).toMatch(/nothing matched/);
    expect(
      describeSfxEvent({ type: 'retrieval', query: 'coin', count: 3, fallback: false })
    ).not.toMatch(/nothing matched/);
  });

  it('reports the honest distance during a fit, not the penalised fitness', () => {
    const line = describeSfxEvent({
      type: 'generation',
      iteration: 1,
      generation: 12,
      bestFitness: 0.9,
      distance: 0.412,
      source: COIN,
      diversity: 0.3,
    });
    expect(line).toContain('generation 12');
    expect(line).toContain('0.412');
    expect(line).not.toContain('0.9');
  });

  it('has a line for every stage', () => {
    const events: AgentEvent[] = [
      { type: 'request', iteration: 1 },
      { type: 'reply', iteration: 1, text: 'x' },
      { type: 'validated', iteration: 1, soundline: COIN, issues: [] },
      { type: 'rendered', iteration: 1, peak: 0.5 },
      { type: 'optimized', iteration: 1, distance: 0.1, initialDistance: 0.4, stopped: 'target' },
      { type: 'feedback', iteration: 1, message: 'line one\nline two' },
      { type: 'done', outcome: 'accepted', accepted: true },
    ];
    for (const event of events) {
      expect(describeSfxEvent(event)).not.toBe('');
    }
  });
});

describe('describeSfxOutcome', () => {
  const base = {
    accepted: false,
    soundline: '',
    grammarVersion: SOUNDLINE_GRAMMAR_VERSION,
    issues: [],
    llmProviderId: 'stub',
    llmModelId: 'stub-model',
  };

  it("prefers the model's own sentence for a refusal", () => {
    expect(
      describeSfxOutcome({
        ...base,
        outcome: 'refused',
        message: 'I cannot synthesise a human voice.',
      })
    ).toBe('I cannot synthesise a human voice.');
  });

  it('explains a refusal even when the model gave no sentence', () => {
    expect(describeSfxOutcome({ ...base, outcome: 'refused' })).toMatch(/voices/i);
  });

  it('has an explanation for every outcome', () => {
    for (const outcome of [
      'accepted',
      'distance',
      'no-soundline',
      'parse-error',
      'invalid',
      'render',
    ] as const) {
      expect(describeSfxOutcome({ ...base, outcome })).not.toBe('');
    }
  });
});

describe('SfxGenService.generate', () => {
  it('refuses with a pointer to Agent settings when no lane resolves', async () => {
    const { service } = createService({ lane: null });
    await expect(service.generate({ prompt: 'a coin' })).rejects.toMatchObject({
      name: 'SfxGenError',
      kind: 'no-lane',
    });
    expect(generateSound).not.toHaveBeenCalled();
  });

  it('refuses when the lane has no credential', async () => {
    const { service } = createService({ apiKey: '' });
    await expect(service.generate({ prompt: 'a coin' })).rejects.toBeInstanceOf(SfxGenError);
    expect(generateSound).not.toHaveBeenCalled();
  });

  it('refuses an empty prompt before touching a provider', async () => {
    const { service, resolve } = createService();
    await expect(service.generate({ prompt: '   ' })).rejects.toBeInstanceOf(SfxGenError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('runs the loop, bakes a WAV, and reports peak, duration and the grammar version', async () => {
    const { service } = createService();
    const result = await service.generate({ prompt: 'a coin pickup' });

    expect(result.accepted).toBe(true);
    expect(result.outcome).toBe('accepted');
    expect(result.wav?.type).toBe('audio/wav');
    expect(result.durationMs).toBe(250);
    expect(result.peak).toBe(0.8);
    expect(result.clipped).toBe(false);
    expect(result.grammarVersion).toBe(SOUNDLINE_GRAMMAR_VERSION);
    expect(result.llmProviderId).toBe('stub');
    expect(result.llmModelId).toBe('stub-model');
    // The recipe names itself; the save name comes from that, not from a second model call.
    expect(result.suggestedName).toBe('coin_pickup');
  });

  it('passes the request (not the recipe) as the retrieval query and caps the iteration budget', async () => {
    const { service } = createService();
    await service.generate({ prompt: 'a coin pickup', maxIterations: 99 });

    const options = generateSound.mock.calls[0][0];
    expect(options.retrievalQuery).toBe('a coin pickup');
    expect(options.maxIterations).toBe(MAX_SFX_ITERATIONS);
    expect(options.bank).toBeDefined();
    expect(options.render).toBeTypeOf('function');
  });

  it('sends the edit prompt when a soundline is supplied, keeping retrieval on the request', async () => {
    const { service } = createService();
    await service.generate({ prompt: 'duller', soundline: COIN });

    const options = generateSound.mock.calls[0][0];
    expect(options.prompt).toContain('current soundline recipe');
    expect(options.prompt).toContain('Change requested: duller');
    expect(options.retrievalQuery).toBe('duller');
  });

  it('returns a refusal as a normal result with the model’s sentence — never a throw', async () => {
    generateSound.mockResolvedValue(
      fakeLoopResult({
        accepted: false,
        outcome: 'refused',
        soundline: '',
        message: 'A human voice is out of scope for procedural synthesis.',
      })
    );
    const { service } = createService();
    const result = await service.generate({ prompt: 'a man saying hello' });

    expect(result.outcome).toBe('refused');
    expect(result.accepted).toBe(false);
    expect(result.wav).toBeUndefined();
    expect(result.message).toContain('out of scope');
    expect(renderSound).not.toHaveBeenCalled();
  });

  it('streams the loop events through to the caller', async () => {
    const seen: AgentEvent[] = [];
    generateSound.mockImplementation(async (options: { onEvent?: (e: AgentEvent) => void }) => {
      options.onEvent?.({ type: 'request', iteration: 1 });
      options.onEvent?.({ type: 'done', outcome: 'accepted', accepted: true });
      return fakeLoopResult();
    });
    const { service } = createService();
    await service.generate({ prompt: 'a coin', onEvent: event => seen.push(event) });
    expect(seen.map(event => event.type)).toEqual(['request', 'done']);
  });

  it('fails clearly in an environment with no audio at all', async () => {
    const { service } = createService();
    // happy-dom has no OfflineAudioContext, and with the override cleared there is no fallback
    // either — that must read as `no-audio`, not as a ReferenceError inside a render.
    service.setAudioFactories({});
    expect(service.canRender()).toBe(false);
    await expect(service.generate({ prompt: 'a coin' })).rejects.toMatchObject({
      kind: 'no-audio',
    });
  });
});

describe('SfxGenService.rerender', () => {
  it('re-bakes a kept recipe with no model call at all', async () => {
    const { service } = createService();
    const result = await service.rerender(COIN);
    expect(generateSound).not.toHaveBeenCalled();
    expect(result.accepted).toBe(true);
    expect(result.wav?.type).toBe('audio/wav');
    expect(result.suggestedName).toBe('coin_pickup');
  });

  it('reports a recipe that does not parse as a parse error', async () => {
    const { service } = createService();
    await expect(service.rerender('this is not a recipe')).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('SfxGenService.save', () => {
  it('writes res://sfx/<name>.wav, creating the folder first', async () => {
    const { service, writeBinaryFile, createDirectory } = createService();
    const result = await service.generate({ prompt: 'a coin pickup' });

    const saved = await service.save(result, 'coin_pickup');
    expect(saved.path).toBe('sfx/coin_pickup.wav');
    expect(saved.durationMs).toBe(250);
    expect(createDirectory).toHaveBeenCalledWith('sfx');
    expect(writeBinaryFile.mock.calls[0][0]).toBe('sfx/coin_pickup.wav');
  });

  it('falls back to the recipe’s own name when none is given', async () => {
    const { service, writeBinaryFile } = createService();
    const result = await service.generate({ prompt: 'a coin pickup' });
    await service.save(result, '');
    expect(writeBinaryFile.mock.calls[0][0]).toBe('sfx/coin_pickup.wav');
  });

  it('refuses without an open project', async () => {
    const { service } = createService();
    const result = await service.generate({ prompt: 'a coin pickup' });
    appState.project.status = 'idle';
    await expect(service.save(result, 'coin')).rejects.toMatchObject({ kind: 'no-project' });
  });

  it('refuses a result that never rendered', async () => {
    const { service } = createService();
    await expect(
      service.save(
        {
          outcome: 'refused',
          accepted: false,
          soundline: '',
          grammarVersion: SOUNDLINE_GRAMMAR_VERSION,
          issues: [],
          llmProviderId: 'stub',
          llmModelId: 'stub-model',
        },
        'nope'
      )
    ).rejects.toMatchObject({ kind: 'render' });
  });
});

describe('SfxGenService.remember', () => {
  it('stores the sound with its recipe, grammar version and duration', async () => {
    const { service, historyAdd } = createService();
    const result = await service.generate({ prompt: 'a coin pickup' });
    await service.remember(result, 'a coin pickup');

    expect(historyAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'sound',
        mimeType: 'audio/wav',
        prompt: 'a coin pickup',
        grammarVersion: SOUNDLINE_GRAMMAR_VERSION,
        durationMs: 250,
        soundlineSource: expect.stringContaining('sound "coin pickup"'),
      })
    );
  });

  it('never lets a history failure surface — the user is already listening to the sound', async () => {
    const { service, historyAdd } = createService();
    historyAdd.mockRejectedValue(new Error('IndexedDB is gone'));
    const result = await service.generate({ prompt: 'a coin pickup' });
    await expect(service.remember(result, 'a coin pickup')).resolves.toBeUndefined();
  });

  it('skips a result with no audio', async () => {
    const { service, historyAdd } = createService();
    await service.remember(
      {
        outcome: 'refused',
        accepted: false,
        soundline: '',
        grammarVersion: SOUNDLINE_GRAMMAR_VERSION,
        issues: [],
        llmProviderId: 'stub',
        llmModelId: 'stub-model',
      },
      'a voice'
    );
    expect(historyAdd).not.toHaveBeenCalled();
  });
});
