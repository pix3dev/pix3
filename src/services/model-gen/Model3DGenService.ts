import * as THREE from 'three';
import { inject, injectable } from '@/fw/di';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { AgentVisionService, type VisionHelper } from '@/services/agent/AgentVisionService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import {
  LlmError,
  isAbortError,
  type LlmContentBlock,
  type LlmImageBlock,
  type LlmMessage,
  type LlmModel,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type ReasoningEffort,
} from '@/services/llm/LlmTypes';
import { ScriptCompilerService } from '@/services/scripting/ScriptCompilerService';
import { Model3DGenSettingsService } from '@/services/model-gen/Model3DGenSettingsService';
import {
  buildAssessPrompt,
  buildFactoryPrompt,
  buildSpecPrompt,
} from '@/services/model-gen/prompts';
import { extractJsonObject } from '@/services/model-gen/model-gen-json';
import { validateSculptSpec, type Assessment, type SculptSpec } from '@/services/model-gen/SculptSpec';
import type {
  ComplexityHint,
  ModelGenInput,
  ModelGenLogEntry,
  ModelGenState,
} from '@/services/model-gen/model-gen-types';

/** Max codegen→compile attempts before the build stage gives up. */
const MAX_BUILD_ATTEMPTS = 3;

/** Signature of the pure factory the codegen model must produce. */
type FactoryFn = (three: typeof THREE) => unknown;

/** A resolved codegen caller: provider + model + credentials + per-model knobs. */
interface ResolvedCodegen {
  provider: LlmProvider;
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string | undefined;
  maxTokens: number | undefined;
  reasoningEffort: ReasoningEffort | undefined;
}

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  calls: 0,
} as const;

const INITIAL_STATE: ModelGenState = {
  status: 'idle',
  stageLabel: '',
  log: [],
  assessment: null,
  spec: null,
  factoryCode: null,
  modelRevision: 0,
  usage: { ...EMPTY_USAGE },
  error: null,
  canGenerate: true,
};

const COMPLEXITIES: readonly ComplexityHint[] = ['simple', 'moderate', 'complex'];
const CATEGORIES: readonly Assessment['category'][] = ['object', 'character', 'unknown'];

/**
 * Headless orchestrator for the Model Lab single-shot pipeline (Phase 2): intake → assess (vision) →
 * spec (codegen + deterministic validate) → factory codegen → compile (esbuild) → instantiate a
 * `THREE.Group`. Compile/runtime/guard errors loop straight back to codegen (no vision), capped at
 * {@link MAX_BUILD_ATTEMPTS}. The pass-gated vision review loop is Phase 3 and NOT implemented here.
 *
 * State is exposed via an immutable {@link ModelGenState} + {@link subscribe}, mirroring
 * {@link import('@/services/agent/AgentChatService').AgentChatService}. The compiled Group is handed
 * out by {@link getModel}; each successful build creates a NEW Group and bumps `modelRevision`. This
 * service never disposes a Group it has handed out — the panel owns disposal of what it holds.
 */
@injectable()
export class Model3DGenService {
  @inject(LlmProviderRegistry)
  private readonly registry!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(AgentVisionService)
  private readonly vision!: AgentVisionService;

  @inject(ScriptCompilerService)
  private readonly compiler!: ScriptCompilerService;

  @inject(Model3DGenSettingsService)
  private readonly settings!: Model3DGenSettingsService;

  private state: ModelGenState = INITIAL_STATE;
  private readonly listeners = new Set<(state: ModelGenState) => void>();
  private abortController: AbortController | null = null;
  private currentModel: THREE.Group | undefined;
  private logSeq = 0;

  getState(): ModelGenState {
    return this.state;
  }

  subscribe(listener: (state: ModelGenState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** The latest compiled model Group, or undefined before the first successful build. */
  getModel(): THREE.Group | undefined {
    return this.currentModel;
  }

  /** Abort a running job (no-op when idle). */
  cancel(): void {
    this.abortController?.abort();
  }

  /** Clear log/assessment/spec/usage back to a fresh idle state. Leaves the current model intact. */
  reset(): void {
    this.cancel();
    this.resetRunState();
    this.setState({ status: 'idle', stageLabel: '', canGenerate: true });
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
    this.currentModel = undefined;
  }

  /**
   * Run one generation job end-to-end. Resolves on done / error / cancel (errors and cancellation are
   * reflected in {@link ModelGenState}, not thrown). A second call while a job runs is ignored.
   */
  async generate(input: ModelGenInput): Promise<void> {
    if (this.abortController) {
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;
    this.resetRunState();
    this.setState({ canGenerate: false, error: null });

    try {
      this.setState({ status: 'intake', stageLabel: 'Preparing reference' });
      if (!input.referenceImage || !input.referenceImage.base64) {
        throw new Error('A reference image is required.');
      }
      this.log('info', 'Starting model generation.');

      const assessment = await this.assess(input, signal);
      if (assessment.category === 'character') {
        throw new Error('Organic/character models are not supported yet.');
      }

      const spec = await this.makeSpec(assessment, input, signal);
      const group = await this.runBuildLoop(spec, signal);

      this.currentModel = group;
      this.setState({
        status: 'done',
        stageLabel: 'Done',
        modelRevision: this.state.modelRevision + 1,
      });
      this.log('success', 'Model generated successfully.');
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        this.setState({ status: 'cancelled', stageLabel: 'Cancelled' });
        this.log('warn', 'Generation cancelled.');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.setState({ status: 'error', stageLabel: 'Error', error: message });
        this.log('error', message);
      }
    } finally {
      this.abortController = null;
      this.setState({ canGenerate: true });
    }
  }

  // -- pipeline stages -------------------------------------------------------

  private async assess(input: ModelGenInput, signal: AbortSignal): Promise<Assessment> {
    const helper = await this.resolveVision();
    if (!helper) {
      throw new Error('No vision-capable model is configured.');
    }
    this.throwIfAborted(signal);
    this.setState({ status: 'assessing', stageLabel: 'Analyzing reference image' });

    const prompt = buildAssessPrompt();
    const userText = input.prompt?.trim()
      ? `${prompt.user}\n\nUser intent: ${input.prompt.trim()}`
      : prompt.user;
    const image: LlmImageBlock = {
      type: 'image',
      mimeType: input.referenceImage!.mimeType,
      data: input.referenceImage!.base64,
    };
    const raw = await this.chatVision(
      helper,
      prompt.system,
      prompt.systemStableChars,
      userText,
      image,
      signal
    );
    const assessment = coerceAssessment(extractJsonObject(raw), input.complexity);
    this.setState({ assessment });
    this.log(
      'info',
      `Assessment: ${assessment.objectClass} — ${assessment.category}, ${assessment.complexity}.`
    );
    return assessment;
  }

  private async makeSpec(
    assessment: Assessment,
    input: ModelGenInput,
    signal: AbortSignal
  ): Promise<SculptSpec> {
    this.throwIfAborted(signal);
    this.setState({ status: 'speccing', stageLabel: 'Designing model spec' });

    const prompt = buildSpecPrompt(assessment, input.prompt);
    const first = await this.chatCodegen(
      prompt.system,
      prompt.systemStableChars,
      [{ role: 'user', content: prompt.user }],
      signal
    );
    let attempt = this.parseSpec(first);

    if (!attempt.ok) {
      this.log('warn', `Spec failed validation: ${attempt.errors.join('; ')}. Requesting a repair.`);
      this.throwIfAborted(signal);
      const repairUser = [
        prompt.user,
        '',
        'Your previous response failed validation with these errors:',
        attempt.errors.map(error => `- ${error}`).join('\n'),
        '',
        'Here is what you returned:',
        first,
        '',
        'Return a corrected sculpt spec JSON only.',
      ].join('\n');
      const second = await this.chatCodegen(
        prompt.system,
        prompt.systemStableChars,
        [{ role: 'user', content: repairUser }],
        signal
      );
      attempt = this.parseSpec(second);
    }

    if (!attempt.ok || !attempt.spec) {
      throw new Error(`Model spec did not pass validation: ${attempt.errors.join('; ')}`);
    }

    this.setState({ spec: attempt.spec });
    this.log(
      'success',
      `Spec ready: ${attempt.spec.components.length} components, ${attempt.spec.materials.length} materials.`
    );
    return attempt.spec;
  }

  private parseSpec(
    text: string
  ): { ok: boolean; spec: SculptSpec | null; errors: string[] } {
    let parsed: unknown;
    try {
      parsed = extractJsonObject(text);
    } catch (error) {
      return { ok: false, spec: null, errors: [error instanceof Error ? error.message : String(error)] };
    }
    const validation = validateSculptSpec(parsed);
    return {
      ok: validation.ok,
      spec: validation.ok ? (parsed as SculptSpec) : null,
      errors: validation.errors,
    };
  }

  private async runBuildLoop(spec: SculptSpec, signal: AbortSignal): Promise<THREE.Group> {
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
      this.throwIfAborted(signal);
      this.setState({
        status: 'building',
        stageLabel: attempt === 1 ? 'Generating model code' : `Fixing model code (attempt ${attempt})`,
      });

      const prompt = buildFactoryPrompt(spec, attempt > 1 ? lastError : undefined);
      const raw = await this.chatCodegen(
        prompt.system,
        prompt.systemStableChars,
        [{ role: 'user', content: prompt.user }],
        signal
      );
      const factoryCode = stripCodeFences(raw);
      this.setState({ factoryCode, status: 'compiling', stageLabel: 'Compiling model' });

      try {
        this.throwIfAborted(signal);
        const group = await this.buildFactory(factoryCode, signal);
        this.log('success', `Model compiled and instantiated on attempt ${attempt}.`);
        return group;
      } catch (error) {
        if (this.isCancellation(error, signal)) {
          throw error;
        }
        lastError = describeBuildError(error);
        this.log('error', `Build attempt ${attempt} failed: ${lastError}`);
      }
    }
    throw new Error(
      `Model code failed after ${MAX_BUILD_ATTEMPTS} attempts. Last error: ${lastError}`
    );
  }

  /**
   * Guard → compile → blob import → instantiate. Rejects imports/require and ShaderMaterial before
   * executing, bundles the single virtual `factory.ts` through esbuild (strips types, catches syntax
   * errors), imports the compiled module from a blob URL, calls `createModel(THREE)`, and verifies a
   * `THREE.Group` came back. The blob URL is always revoked.
   */
  private async buildFactory(code: string, signal: AbortSignal): Promise<THREE.Group> {
    if (/(?:^|[\n;])\s*import[\s'"({*]/.test(code) || /\brequire\s*\(/.test(code)) {
      throw new Error(
        'The factory must not import or require any module — THREE is the injected parameter.'
      );
    }
    if (/\bShaderMaterial\b/.test(code)) {
      throw new Error(
        'ShaderMaterial is not allowed (it will not survive GLB export). Use MeshStandardMaterial or MeshPhysicalMaterial.'
      );
    }

    const files = new Map<string, string>([['factory.ts', code]]);
    const result = await this.compiler.bundleVirtualProject(files, {
      entryFiles: ['factory.ts'],
      entryStrategy: 're-export',
    });
    if (!result.code) {
      throw new Error('The compiler produced no output for the factory module.');
    }

    this.throwIfAborted(signal);
    const url = URL.createObjectURL(new Blob([result.code], { type: 'text/javascript' }));
    try {
      const module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      const factory = findCreateModel(module);
      if (!factory) {
        throw new Error('The compiled module does not export a createModel(THREE) function.');
      }
      const group = factory(THREE);
      if (!(group instanceof THREE.Group)) {
        throw new Error(
          `createModel must return a THREE.Group (got ${describeValue(group)}).`
        );
      }
      return group;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // -- LLM helpers -----------------------------------------------------------

  private async chatCodegen(
    system: string,
    systemStableChars: number,
    messages: readonly LlmMessage[],
    signal: AbortSignal
  ): Promise<string> {
    const codegen = await this.resolveCodegen();
    const result = await codegen.provider.chat(
      {
        messages,
        system,
        cache: { systemStableChars },
        maxTokens: codegen.maxTokens,
        reasoningEffort: codegen.reasoningEffort,
        signal,
      },
      { apiKey: codegen.apiKey, modelId: codegen.modelId, baseUrl: codegen.baseUrl }
    );
    this.aggregateUsage(result.usage);
    this.log(
      'llm',
      `Codegen (${codegen.provider.label} / ${codegen.modelId}) responded${formatUsage(result.usage)}.`
    );
    return readText(result);
  }

  private async chatVision(
    helper: VisionHelper,
    system: string,
    systemStableChars: number,
    userText: string,
    image: LlmImageBlock,
    signal: AbortSignal
  ): Promise<string> {
    const baseUrl = this.agentSettings.getBaseUrl(helper.provider.id);
    const model = this.catalog.getModel(helper.provider.id, helper.modelId);
    const result = await helper.provider.chat(
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }, image] }],
        system,
        cache: { systemStableChars },
        maxTokens: model?.capabilities.maxOutputTokens,
        signal,
      },
      { apiKey: helper.apiKey, modelId: helper.modelId, baseUrl }
    );
    this.aggregateUsage(result.usage);
    this.log(
      'llm',
      `Vision (${helper.provider.label} / ${helper.modelId}) responded${formatUsage(result.usage)}.`
    );
    return readText(result);
  }

  private async resolveCodegen(): Promise<ResolvedCodegen> {
    const prefs = this.settings.getPreferences();
    const providerId = prefs.codegenProviderId || this.agentSettings.getSelectedProvider()?.id || '';
    if (!providerId) {
      throw new Error('No codegen model is configured.');
    }
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(`The codegen provider "${providerId}" is not available.`);
    }
    const modelId = prefs.codegenModelId || this.agentSettings.getSelectedModelId(providerId) || '';
    if (!modelId) {
      throw new Error('No codegen model is configured.');
    }
    const apiKey = (await this.agentSettings.getApiKey(providerId)) ?? '';
    if (!apiKey) {
      throw new Error(`No API key is configured for the codegen provider "${provider.label}".`);
    }
    const baseUrl = this.agentSettings.getBaseUrl(providerId);
    const model = this.catalog.getModel(providerId, modelId);
    return {
      provider,
      providerId,
      modelId,
      apiKey,
      baseUrl,
      maxTokens: model?.capabilities.maxOutputTokens,
      reasoningEffort: this.resolveReasoning(providerId, modelId, model),
    };
  }

  /** The chosen reasoning level, but only when the model actually accepts it. */
  private resolveReasoning(
    providerId: string,
    modelId: string,
    model: LlmModel | undefined
  ): ReasoningEffort | undefined {
    const chosen = this.settings.getReasoningEffort(providerId, modelId);
    if (!chosen) {
      return undefined;
    }
    const supported = model?.capabilities.reasoningEfforts;
    return supported && supported.includes(chosen) ? chosen : undefined;
  }

  /**
   * Resolve the vision helper: Model Lab's explicit slot when set and usable (provider + model +
   * key), otherwise fall back to {@link AgentVisionService.resolveHelper}.
   */
  private async resolveVision(): Promise<VisionHelper | null> {
    const prefs = this.settings.getPreferences();
    if (prefs.visionProviderId) {
      const provider = this.registry.get(prefs.visionProviderId);
      if (provider) {
        const modelId = prefs.visionModelId || this.firstVisionModelId(provider.id);
        const apiKey = (await this.agentSettings.getApiKey(provider.id)) ?? '';
        if (modelId && apiKey) {
          return { provider, modelId, apiKey };
        }
      }
    }
    return this.vision.resolveHelper();
  }

  private firstVisionModelId(providerId: string): string | undefined {
    return this.catalog.getModels(providerId).find(model => model.capabilities.supportsImages)?.id;
  }

  // -- state / logging -------------------------------------------------------

  private resetRunState(): void {
    this.setState({
      status: 'idle',
      stageLabel: '',
      log: [],
      assessment: null,
      spec: null,
      factoryCode: null,
      usage: { ...EMPTY_USAGE },
      error: null,
    });
  }

  private aggregateUsage(usage: LlmUsage | undefined): void {
    const current = this.state.usage;
    this.setState({
      usage: {
        inputTokens: current.inputTokens + (usage?.inputTokens ?? 0),
        outputTokens: current.outputTokens + (usage?.outputTokens ?? 0),
        cacheReadTokens: current.cacheReadTokens + (usage?.cacheReadTokens ?? 0),
        cacheCreationTokens: current.cacheCreationTokens + (usage?.cacheCreationTokens ?? 0),
        calls: current.calls + 1,
      },
    });
  }

  private log(level: ModelGenLogEntry['level'], text: string): void {
    const entry: ModelGenLogEntry = {
      id: `${Date.now().toString(36)}-${(this.logSeq += 1)}`,
      level,
      text,
      at: Date.now(),
    };
    this.setState({ log: [...this.state.log, entry] });
  }

  private setState(patch: Partial<ModelGenState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new DOMException('Generation aborted.', 'AbortError');
    }
  }

  private isCancellation(error: unknown, signal: AbortSignal): boolean {
    return (
      signal.aborted ||
      isAbortError(error) ||
      (error instanceof LlmError && error.kind === 'aborted')
    );
  }
}

// -- module-level pure helpers -----------------------------------------------

/** Concatenate a result's text blocks into one trimmed string. */
function readText(result: LlmResult): string {
  return result.content
    .filter((block): block is Extract<LlmContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/** Strip a ```ts / ``` markdown fence from a code response, if present. */
function stripCodeFences(text: string): string {
  const fenced = text
    .trim()
    .match(/```(?:ts|typescript|js|javascript|tsx|jsx)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** Find the exported `createModel` factory in a compiled module (direct or namespaced re-export). */
function findCreateModel(module: Record<string, unknown>): FactoryFn | null {
  if (typeof module.createModel === 'function') {
    return module.createModel as FactoryFn;
  }
  for (const value of Object.values(module)) {
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).createModel;
      if (typeof nested === 'function') {
        return nested as FactoryFn;
      }
    }
  }
  return null;
}

/** A short human-readable description of an unexpected factory return value. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return name ?? 'object';
  }
  return typeof value;
}

/** Format a build error (esbuild {@link import('@/services/scripting/ScriptCompilerService').CompilationError} or a thrown Error). */
function describeBuildError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const record = error as { message?: unknown; file?: unknown; line?: unknown };
    const message = typeof record.message === 'string' ? record.message : 'Compilation failed';
    if (typeof record.file === 'string' && typeof record.line === 'number') {
      return `${message} (${record.file}:${record.line})`;
    }
    return message;
  }
  return String(error);
}

/** A compact " (in 1234, out 567 tok)" suffix for a usage log line. */
function formatUsage(usage: LlmUsage | undefined): string {
  if (!usage) {
    return '';
  }
  const parts: string[] = [];
  if (typeof usage.inputTokens === 'number') {
    parts.push(`in ${usage.inputTokens}`);
  }
  if (typeof usage.outputTokens === 'number') {
    parts.push(`out ${usage.outputTokens}`);
  }
  return parts.length ? ` (${parts.join(', ')} tok)` : '';
}

/** Narrow an untrusted assessment payload, falling back to sane defaults. */
function coerceAssessment(raw: unknown, fallbackComplexity: ComplexityHint | undefined): Assessment {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const category = CATEGORIES.includes(record.category as Assessment['category'])
    ? (record.category as Assessment['category'])
    : 'unknown';
  const complexity = COMPLEXITIES.includes(record.complexity as ComplexityHint)
    ? (record.complexity as ComplexityHint)
    : (fallbackComplexity ?? 'moderate');
  const objectClass =
    typeof record.objectClass === 'string' && record.objectClass.trim()
      ? record.objectClass.trim()
      : 'unknown object';
  const detailInventory = Array.isArray(record.detailInventory)
    ? record.detailInventory.filter((item): item is string => typeof item === 'string')
    : [];
  const notes = typeof record.notes === 'string' ? record.notes : undefined;
  return { objectClass, category, complexity, detailInventory, notes };
}
