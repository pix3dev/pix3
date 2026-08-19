import {
  buildGraph,
  encodeWav,
  parse,
  renderSound,
  serialize,
  validate,
  type OfflineContextFactory,
} from '@txt2sfx/core';
import {
  assetFileName,
  generateSound,
  type AgentEvent,
  type GenerateResult,
  type Outcome,
} from '@txt2sfx/agent';
import type { SoundAST, ValidationIssue } from '@txt2sfx/shared';

import { inject, injectable } from '@/fw/di';
import { LlmLaneResolver } from '@/services/llm/LlmLaneResolver';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { writeProjectBinaryFile } from '@/services/project/project-file-writes';
import { GenerationHistoryService } from '@/services/image-gen/GenerationHistoryService';
import { normalizeAssetPath } from '@/services/image-gen/image-ops';
import { appState } from '@/state';
import { createSoundlineLlmProvider } from '@/services/sfx-gen/SoundlineLlmAdapter';
import { sfxRecipeBank } from '@/services/sfx-gen/sfx-recipe-bank';

/**
 * Grammar the stored `soundlineSource` is written in.
 *
 * Stamped into history so an old record whose grammar has since moved on can be recognised as
 * un-editable rather than fed to a parser that will reject it in a confusing way. Baked WAVs are
 * unaffected by a grammar change — they are ordinary audio files — so only the *edit* path degrades.
 * (txt2sfx exports no version constant of its own; this is ours, and it moves when the DSL does.)
 */
export const SOUNDLINE_GRAMMAR_VERSION = 'soundline/v0';

/** Where saved prototype SFX live. A plain project folder — no new machinery, no new extension. */
export const SFX_DIRECTORY = 'sfx';

/** Trips through the model, including the first. Matches the loop's own default. */
const DEFAULT_MAX_ITERATIONS = 4;

/** Hard cap, so an agent asking for `maxIterations: 50` cannot spend a user's budget on one sound. */
export const MAX_SFX_ITERATIONS = 6;

/** WAV bit depth. 16-bit is the format every tool and every browser decoder reads. */
const WAV_BIT_DEPTH = 16;

/**
 * Audio-context factories.
 *
 * A seam rather than a direct `new OfflineAudioContext(...)`, because neither constructor exists under
 * happy-dom: a spec installs fakes (or nothing) and never makes a sound. In a real tab the platform's
 * own constructors are the default, so there is no bootstrap line to forget — {@link
 * SfxGenService.setAudioFactories} exists to *override* them, not to enable the feature.
 */
export interface SfxAudioFactories {
  /** How to obtain an offline context for rendering. In a browser: `o => new OfflineAudioContext(o)`. */
  readonly offline?: OfflineContextFactory;
  /** The shared live context for audition, created lazily and resumed on a gesture. */
  readonly live?: () => BaseAudioContext;
}

/** Sample rate every render and every audition runs at — txt2sfx's own `GLOBAL_LIMITS.sampleRate`. */
const SAMPLE_RATE = 44100;

/** The platform's constructors, or null where the environment has none (happy-dom, a worker). */
const platformOfflineFactory = (): OfflineContextFactory | null =>
  typeof OfflineAudioContext === 'undefined' ? null : options => new OfflineAudioContext(options);

const platformLiveFactory = (): (() => BaseAudioContext) | null =>
  typeof AudioContext === 'undefined' ? null : () => new AudioContext({ sampleRate: SAMPLE_RATE });

/** What to generate, and how hard to try. */
export interface SfxGenerateOptions {
  /** What the sound should be. In edit mode, the change being asked for. */
  readonly prompt: string;
  /**
   * The current recipe to modify rather than a brief to design from scratch. Present turns this into
   * an edit: "duller, and 100 ms shorter" becomes a diff on known text instead of a re-roll that also
   * changes the six things the user liked.
   */
  readonly soundline?: string;
  /** `AGENT_DEFAULT_MODEL_ID` / undefined for the agent's lane, or a composite `"<provider>/<model>"`. */
  readonly modelId?: string;
  readonly maxIterations?: number;
  /** Progress from the loop, one event per stage. See {@link describeSfxEvent}. */
  readonly onEvent?: (event: AgentEvent) => void;
  readonly signal?: AbortSignal;
}

/** A generated sound, held in memory until it is saved (or discarded with the panel). */
export interface SfxResult {
  readonly outcome: Outcome;
  readonly accepted: boolean;
  /** The recipe — the master this WAV was baked from, and the input to the next edit. */
  readonly soundline: string;
  readonly grammarVersion: string;
  /** Everything the validator said, warnings included. */
  readonly issues: readonly ValidationIssue[];
  /** Which LLM answered, for provenance in history and in the panel. */
  readonly llmProviderId: string;
  readonly llmModelId: string;
  /** The baked audio. Absent when the model refused, or when nothing rendered. */
  readonly wav?: Blob;
  readonly durationMs?: number;
  readonly peak?: number;
  readonly clipped?: boolean;
  /** Suggested file stem, derived from the name the recipe gave itself. */
  readonly suggestedName?: string;
  /** The model's own sentence, when `outcome` is `refused`. */
  readonly message?: string;
}

export interface SfxSaveResult {
  readonly path: string;
  readonly bytes: number;
  readonly durationMs: number;
}

/** A sound that is currently audible. */
export interface SfxPlayback {
  /** Release the graph. Idempotent. */
  stop(): void;
}

/** Raised when there is no LLM lane, or the request could not be turned into audio. */
export class SfxGenError extends Error {
  constructor(
    readonly kind: 'no-lane' | 'no-project' | 'no-audio' | 'parse' | 'render' | 'unknown',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'SfxGenError';
  }
}

/**
 * The user turn for an edit: the current recipe leads, the change request follows.
 *
 * Split out so the wording is testable, and phrased to keep the model from redesigning: the whole
 * value of storing the soundline is that "make it duller" is a deterministic edit of known text. The
 * tilde-slot reminder is repeated because the optimizer is what fits the numbers afterwards, and a
 * model that writes bare constants here silently removes the search space.
 */
export const buildSfxEditPrompt = (soundline: string, feedback: string): string =>
  [
    'Here is the current soundline recipe:',
    '```',
    soundline.trim(),
    '```',
    '',
    `Change requested: ${feedback.trim()}`,
    '',
    'Edit the recipe above rather than designing a new sound: keep every layer, primitive and ' +
      'effect the request does not touch, so the sound stays recognisably the same one. Keep the ' +
      '`~value[min..max]` slots on the numbers you are unsure of.',
  ].join('\n');

/** True when the request carries a recipe to modify rather than a brief to design from. */
export const isSfxEditRequest = (options: Pick<SfxGenerateOptions, 'soundline'>): boolean =>
  Boolean(options.soundline && options.soundline.trim());

/**
 * One line of progress, phrased for someone watching the loop work.
 *
 * The stages *are* the argument of the pipeline — the validator caught a category violation, the
 * render caught clipping, the optimizer moved the numbers, and the model was asked again only with
 * something it could act on — so the panel shows them rather than a spinner. Rendered as ONE updating
 * line: a fit emits an event per generation, and forty-four appended lines bury the shape of the run.
 */
export const describeSfxEvent = (event: AgentEvent): string => {
  const d3 = (value: number): string => value.toFixed(3);
  switch (event.type) {
    case 'retrieval':
      return event.count === 0
        ? `Looked for examples like “${event.query}” — none`
        : `${event.count} example recipe(s) for “${event.query}”${event.fallback ? ' (nothing matched — generic examples)' : ''}`;
    case 'request':
      return `Asking the model (attempt ${event.iteration})`;
    case 'reply':
      return `Reply received (${event.text.length} chars)`;
    case 'validated': {
      const errors = event.issues.filter(issue => issue.severity === 'error').length;
      const warnings = event.issues.length - errors;
      return event.issues.length === 0
        ? 'Parses and validates — clean'
        : `Parses — ${errors} error(s), ${warnings} warning(s)`;
    }
    case 'rendered':
      return `Rendered, peak ${d3(event.peak)}`;
    case 'generation':
      return `Fitting numbers — generation ${event.generation}, distance ${d3(event.distance)}`;
    case 'optimized':
      return `Fitted: ${d3(event.initialDistance)} → ${d3(event.distance)} (${event.stopped})`;
    case 'feedback':
      return `Sent back: ${event.message.split('\n')[0] ?? ''}`;
    case 'done':
      return event.accepted ? 'Done' : `Stopped: ${event.outcome}`;
  }
};

/**
 * A one-sentence verdict for an outcome the caller has to explain to somebody.
 *
 * `refused` is the interesting one: the txt2sfx contract tells the model to decline a human voice, a
 * believable animal or a real-world recording, and that refusal is the pipeline working. It is a
 * result, not an error.
 */
export const describeSfxOutcome = (result: SfxResult): string => {
  switch (result.outcome) {
    case 'accepted':
      return 'Generated and rendered.';
    case 'refused':
      return (
        result.message ??
        'Procedural synthesis cannot make this sound (voices, believable animals and real-world ' +
          'recordings are out of scope). Ask for a stylised version, or use a recorded file.'
      );
    case 'distance':
      return 'Valid and audible, but still short of the reference it was fitted against.';
    case 'no-soundline':
      return 'The model never answered with a recipe. Try rephrasing, or a stronger model.';
    case 'parse-error':
      return 'Every attempt produced a recipe that would not parse.';
    case 'invalid':
      return 'Every attempt broke a physical invariant of its category.';
    case 'render':
      return 'The recipe rendered to something unusable (silent, or clipping).';
  }
};

/**
 * Derive a file stem from a title.
 *
 * `assetFileName` owns the hard rules — ASCII, lower snake case, never leading with a digit, capped —
 * and always prefixes `sfx_` as its answer to the digit rule and as a grouping for an import that
 * dumps everything into one directory. We already group by directory (`res://sfx/`), so
 * `sfx/sfx_coin_pickup.wav` says it twice; the prefix is dropped unless dropping it would leave a stem
 * starting with a digit, which is the case the prefix exists for.
 */
export const sfxFileStem = (title: string): string => {
  const prefixed = assetFileName(title);
  if (!prefixed) {
    return '';
  }
  const bare = prefixed.replace(/^sfx_/, '');
  return bare && !/^[0-9]/.test(bare) ? bare : prefixed;
};

/** Turn a save name into a project-relative `sfx/<stem>.wav` path. */
export const resolveSfxPath = (name: string): string => {
  const normalized = normalizeAssetPath(name);
  if (!normalized) {
    return '';
  }
  const withExtension = /\.wav$/i.test(normalized) ? normalized : `${normalized}.wav`;
  // A bare name lands in the sfx folder; an explicit path (`audio/ui/pop.wav`) is respected.
  return withExtension.includes('/') ? withExtension : `${SFX_DIRECTORY}/${withExtension}`;
};

/**
 * Prototype sound effects: an LLM writes a `soundline` recipe, txt2sfx validates it against the
 * physics of its category, renders it through an `OfflineAudioContext` and fits the numbers the model
 * was unsure of — and we bake the result to an ordinary WAV in the project.
 *
 * **This is a placeholder pipeline, not a shipping format.** The artifact under `res://sfx/` is a
 * normal audio asset (`scene.audio.play`, `AudioPlayer` and `core:PlaySound` all work untouched), and
 * a final file from a sound designer later *replaces the file* with nothing else changing. The runtime
 * knows nothing about any of this: no `@txt2sfx/*` dependency, nothing in the playable export.
 *
 * The soundline source is kept in generation history, which is what makes "duller and shorter" a
 * deterministic source edit plus a re-render instead of a re-roll.
 */
@injectable()
export class SfxGenService {
  @inject(LlmLaneResolver)
  private readonly lanes!: LlmLaneResolver;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(GenerationHistoryService)
  private readonly historyService!: GenerationHistoryService;

  private factories: SfxAudioFactories | null = null;
  private liveContext: BaseAudioContext | null = null;
  private playing: SfxPlayback | null = null;

  /**
   * Override the audio factories. Only a spec (or a host with its own audio stack) needs this — a real
   * tab gets the platform's constructors by default. An environment with neither an override nor the
   * globals answers a clear {@link SfxGenError} rather than a `ReferenceError` deep inside a render.
   */
  setAudioFactories(factories: SfxAudioFactories): void {
    this.factories = factories;
    this.liveContext = null;
  }

  /** Whether this environment can render at all — the gate the Sound UI shows a hint for. */
  canRender(): boolean {
    return this.offlineFactory() !== null;
  }

  /** Whether an LLM lane is reachable. The panel's only gate — there is no key of our own to nag for. */
  async isAvailable(modelId?: string): Promise<boolean> {
    return this.lanes.isAvailable(modelId);
  }

  /** Models offered in the sound picker: the agent's current provider, as composite ids. */
  listModels(): Array<{ id: string; label: string; description?: string }> {
    return this.lanes.listOptions().map(({ id, label, description }) => ({
      id,
      label,
      ...(description === undefined ? {} : { description }),
    }));
  }

  /**
   * Run one generation: resolve the lane, run the txt2sfx loop, and bake the accepted recipe to WAV.
   *
   * Streams the loop's `AgentEvent`s to `onEvent` — the fit is the slow part and txt2sfx emits a
   * per-generation event specifically so a UI can show the search working.
   */
  async generate(options: SfxGenerateOptions): Promise<SfxResult> {
    const prompt = options.prompt.trim();
    if (!prompt) {
      throw new SfxGenError('unknown', 'A prompt is required.');
    }
    const lane = this.lanes.resolve(options.modelId);
    if (!lane) {
      throw new SfxGenError(
        'no-lane',
        'No LLM is configured for the agent. Pick a provider and model in Settings → AI Agent ' +
          '(or start the Pix3AgentBridge) — sound generation writes recipes with the agent’s model.'
      );
    }
    const apiKey = await this.lanes.getApiKey(lane);
    if (!apiKey) {
      throw new SfxGenError(
        'no-lane',
        `No API key or bridge token is configured for "${lane.provider.label}". Set one in ` +
          'Settings → AI Agent.'
      );
    }

    const editing = isSfxEditRequest(options);
    const loopPrompt = editing
      ? buildSfxEditPrompt(options.soundline ?? '', prompt)
      : `${prompt} — a short sound effect for a game.`;

    const result = await generateSound({
      prompt: loopPrompt,
      provider: createSoundlineLlmProvider({ lane, apiKey }),
      render: this.renderSignal(),
      bank: sfxRecipeBank(),
      // Retrieval must see the *request*, not the recipe an edit quotes back — a soundline document
      // is all grammar keywords and would match every example equally.
      retrievalQuery: prompt,
      maxIterations: Math.min(
        Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS),
        MAX_SFX_ITERATIONS
      ),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return this.bake(result, lane.provider.id, lane.modelId);
  }

  /**
   * Re-render a kept recipe without asking a model anything — the deterministic half of the edit loop,
   * and how a history record becomes playable again.
   */
  async rerender(soundline: string): Promise<SfxResult> {
    const ast = this.parseOrThrow(soundline);
    const issues = validate(ast);
    const rendered = await this.render(ast);
    return {
      outcome: 'accepted',
      accepted: true,
      soundline: serialize(ast),
      grammarVersion: SOUNDLINE_GRAMMAR_VERSION,
      issues,
      llmProviderId: '',
      llmModelId: '',
      wav: rendered.wav,
      durationMs: rendered.durationMs,
      peak: rendered.peak,
      clipped: rendered.clipped,
      suggestedName: sfxFileStem(ast.name),
    };
  }

  /**
   * Play a recipe through the LIVE graph, which is the actual product — not a preview of it. Stops
   * whatever was already playing: two overlapping takes of the same sound tell you nothing.
   */
  play(soundline: string): SfxPlayback {
    const factory = this.factories?.live ?? platformLiveFactory();
    if (!factory) {
      throw new SfxGenError('no-audio', 'No audio context is available for playback.');
    }
    this.stop();
    const ctx = (this.liveContext ??= factory());
    // Browsers start a context suspended until a user gesture; Play is one.
    void (ctx as AudioContext).resume?.();
    const ast = this.parseOrThrow(soundline);
    const master = ctx.createGain();
    master.connect(ctx.destination);
    // A hair of lead time: scheduling at exactly `currentTime` loses the first milliseconds of a
    // click, which is the part that makes it a click.
    const when = ctx.currentTime + 0.03;
    const ir = buildGraph(ctx, ast, { destination: master, when });

    let stopped = false;
    const release = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        master.disconnect();
      } catch {
        // already released
      }
      if (this.playing === playback) {
        this.playing = null;
      }
    };
    const timer = setTimeout(release, (when - ctx.currentTime + ir.durationSec + 0.2) * 1000);
    const playback: SfxPlayback = {
      stop: () => {
        clearTimeout(timer);
        release();
      },
    };
    this.playing = playback;
    return playback;
  }

  /** Stop whatever is auditioning. Safe to call when nothing is. */
  stop(): void {
    this.playing?.stop();
    this.playing = null;
  }

  /**
   * Write a result into the project as `res://sfx/<name>.wav`, and record it in generation history so
   * the recipe survives a reload and the sound can be edited later without a re-roll.
   */
  async save(result: SfxResult, name: string): Promise<SfxSaveResult> {
    if (appState.project.status !== 'ready') {
      throw new SfxGenError('no-project', 'No project is open — cannot save.');
    }
    if (!result.wav) {
      throw new SfxGenError('render', 'This result has no rendered audio to save.');
    }
    const path = resolveSfxPath(name || result.suggestedName || '');
    if (!path) {
      throw new SfxGenError('unknown', 'A file name is required.');
    }
    await writeProjectBinaryFile(this.storage, path, await result.wav.arrayBuffer());
    return { path, bytes: result.wav.size, durationMs: result.durationMs ?? 0 };
  }

  /**
   * Cache a result in generation history. Best-effort: history is a convenience store, and a failure
   * to persist must never fail a generation the user is already listening to.
   */
  async remember(result: SfxResult, prompt: string): Promise<void> {
    if (!result.wav) {
      return;
    }
    try {
      await this.historyService.add({
        kind: 'sound',
        providerId: result.llmProviderId,
        modelId: result.llmModelId,
        prompt,
        mimeType: 'audio/wav',
        blob: result.wav,
        soundlineSource: result.soundline,
        grammarVersion: result.grammarVersion,
        durationMs: result.durationMs,
      });
    } catch {
      // history is a cache; never fail a generation because it could not persist
    }
  }

  dispose(): void {
    this.stop();
    this.liveContext = null;
  }

  // -- internals -------------------------------------------------------------

  /**
   * Turn the loop's verdict into a result with audio attached.
   *
   * A refusal and an exhausted budget both come back as results rather than throws: the caller has to
   * explain either one to a person, and "the model declined, here is its sentence" is information a
   * thrown error destroys.
   */
  private async bake(
    result: GenerateResult,
    providerId: string,
    modelId: string
  ): Promise<SfxResult> {
    const base = {
      outcome: result.outcome,
      accepted: result.accepted,
      soundline: result.soundline,
      grammarVersion: SOUNDLINE_GRAMMAR_VERSION,
      issues: result.issues,
      llmProviderId: providerId,
      llmModelId: modelId,
      ...(result.message === undefined ? {} : { message: result.message }),
    };
    if (!result.soundline.trim()) {
      return base;
    }
    let ast: SoundAST;
    try {
      ast = parse(result.soundline);
    } catch {
      // The loop already reported this as its outcome; there is simply nothing to bake.
      return base;
    }
    const rendered = await this.render(ast);
    return {
      ...base,
      soundline: serialize(ast),
      wav: rendered.wav,
      durationMs: rendered.durationMs,
      peak: rendered.peak,
      clipped: rendered.clipped,
      suggestedName: sfxFileStem(ast.name),
    };
  }

  /** The offline factory in force: an installed override, else the platform's, else none. */
  private offlineFactory(): OfflineContextFactory | null {
    return this.factories?.offline ?? platformOfflineFactory();
  }

  /** The offline factory, or the error the caller should surface. */
  private requireOfflineFactory(): OfflineContextFactory {
    const offline = this.offlineFactory();
    if (!offline) {
      throw new SfxGenError(
        'no-audio',
        'No offline audio context is available — sound rendering needs a browser tab.'
      );
    }
    return offline;
  }

  /** Render an AST offline and encode the buffer as a WAV blob. */
  private async render(ast: SoundAST): Promise<{
    wav: Blob;
    durationMs: number;
    peak: number;
    clipped: boolean;
  }> {
    const offline = this.requireOfflineFactory();
    const result = await renderSound(ast, { context: offline });
    const bytes = encodeWav(result.buffer, { bitDepth: WAV_BIT_DEPTH });
    // Copied into a fresh buffer: the encoder's view is over memory the render owns.
    return {
      wav: new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }),
      durationMs: Math.round(result.durationMs),
      peak: result.peak,
      clipped: result.clipped,
    };
  }

  /**
   * How a candidate becomes audio for the loop and the optimizer. Samples are copied out of the
   * `AudioBuffer` — anything that outlives its context owns its samples.
   */
  private renderSignal() {
    return async (ast: SoundAST) => {
      const offline = this.requireOfflineFactory();
      const result = await renderSound(ast, { context: offline });
      return {
        samples: Float32Array.from(result.buffer.getChannelData(0)),
        sampleRate: result.buffer.sampleRate,
      };
    };
  }

  private parseOrThrow(soundline: string): SoundAST {
    try {
      return parse(soundline);
    } catch (error) {
      throw new SfxGenError(
        'parse',
        `This recipe does not parse: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}
