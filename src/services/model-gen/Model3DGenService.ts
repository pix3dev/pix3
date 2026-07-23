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
import { base64ToBlob } from '@/services/image-gen/image-ops';
import { Model3DGenSettingsService } from '@/services/model-gen/Model3DGenSettingsService';
import { Model3DGenHistoryService } from '@/services/model-gen/Model3DGenHistoryService';
import {
  buildAssessPrompt,
  buildPassFactoryPrompt,
  buildReviewPrompt,
  buildSpecPrompt,
  getPassPlan,
  type PassPlanEntry,
} from '@/services/model-gen/prompts';
import { extractJsonObject } from '@/services/model-gen/model-gen-json';
import { coerceReviewResult, type ReviewResult } from '@/services/model-gen/model-gen-review';
import { ModelPreviewRenderer } from '@/services/model-gen/ModelPreviewRenderer';
import { buildComparisonSheet } from '@/services/model-gen/ComparisonSheet';
import { validateSculptSpec, type Assessment, type SculptSpec } from '@/services/model-gen/SculptSpec';
import type {
  ComplexityHint,
  ModelGenInput,
  ModelGenLogEntry,
  ModelGenMode,
  ModelGenState,
  PassId,
  PassRecord,
  ReferenceImageInput,
  ReviewDecision,
} from '@/services/model-gen/model-gen-types';

/** Signature of the pure factory the codegen model must produce. */
type FactoryFn = (three: typeof THREE) => unknown;

/** A manual review verdict from the UI, mapped onto a {@link ReviewDecision}. */
type ManualDecision = 'accept' | 'retry' | 'stop';

/** A compiled pass result: the instantiated Group plus the accepted source that produced it. */
interface BuiltPass {
  group: THREE.Group;
  code: string;
}

/**
 * The run-specific inputs the pass loop needs, threaded explicitly rather than re-read from settings.
 * `reference: null` disables the render/review gate (a spec-only regenerate); `autonomous` forces the
 * manual-review gate off (a headless caller has no UI to resolve it).
 */
interface PassLoopContext {
  reference: ReferenceImageInput | null;
  mode: ModelGenMode;
  autonomous: boolean;
}

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
  passes: [],
  currentPassId: null,
  pendingReview: null,
};

const COMPLEXITIES: readonly ComplexityHint[] = ['simple', 'moderate', 'complex'];
const CATEGORIES: readonly Assessment['category'][] = ['object', 'character', 'unknown'];

/**
 * Headless orchestrator for the Model Lab pipeline: intake → assess (vision) → spec (codegen +
 * deterministic validate) → a Phase-3 locked-pass build loop. Each pass refines the factory toward
 * one concern (blockout → structure → form → material → lighting → optimization for `quality`;
 * blockout → form-material for `fast`), compiles it (esbuild), instantiates a `THREE.Group`, renders
 * it offscreen, composites a reference|render comparison sheet, and has a vision model score it. The
 * loop then accepts, refines (capped per pass), or stops. Compile/runtime/guard errors loop straight
 * back to codegen (no vision). With `pauseForReview` on, each review awaits a manual
 * {@link decideReview}; a running {@link cancel} unwinds that gate.
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

  @inject(Model3DGenHistoryService)
  private readonly history!: Model3DGenHistoryService;

  private state: ModelGenState = INITIAL_STATE;
  private readonly listeners = new Set<(state: ModelGenState) => void>();
  private abortController: AbortController | null = null;
  private currentModel: THREE.Group | undefined;
  private logSeq = 0;
  /** Resolver for the promise the pass loop awaits while a manual review gate is open, else null. */
  private pendingReviewResolve: ((decision: ReviewDecision) => void) | null = null;

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

  /** Abort a running job (no-op when idle). Also unwinds a pending manual-review gate via the signal. */
  cancel(): void {
    this.abortController?.abort();
  }

  /**
   * Resolve a pending manual-review gate (no-op when nothing is pending). `accept` → the reviewed
   * pass is kept and the loop advances; `retry` → the pass is re-generated with the review rationale;
   * `stop` → the whole job ends honestly at this pass.
   */
  decideReview(decision: ManualDecision): void {
    const resolve = this.pendingReviewResolve;
    if (!resolve) {
      return;
    }
    this.pendingReviewResolve = null;
    this.setState({ pendingReview: null });
    resolve(mapManualDecision(decision));
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
   *
   * With `opts.autonomous`, the pass loop's manual-review gate is forced off regardless of the
   * `pauseForReview` setting — a headless caller (agent / debug bridge) has no UI to resolve the gate,
   * so gating would hang forever. The panel calls `generate(input)` unchanged (uses the setting).
   */
  async generate(input: ModelGenInput, opts?: { autonomous?: boolean }): Promise<void> {
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
      const mode: ModelGenMode = input.mode ?? this.settings.getPreferences().mode;
      // The pass loop hot-swaps + bumps modelRevision on every successful pass build, so `done` does
      // NOT bump again (re-swapping the same Group would re-add one the panel just disposed).
      const group = await this.runPassLoop(
        spec,
        { reference: input.referenceImage, mode, autonomous: opts?.autonomous ?? false },
        signal
      );

      this.currentModel = group;
      this.setState({ status: 'done', stageLabel: 'Done', currentPassId: null });
      this.log('success', 'Model generated successfully.');
      await this.recordJobHistory({
        spec,
        mode,
        prompt: input.prompt,
        complexity: input.complexity,
        reference: input.referenceImage,
        finalGroup: group,
      });
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

  /**
   * Regenerate a model directly from a saved sculpt spec — skips intake/assess/makeSpec and runs the
   * SAME pass loop. When `opts.referenceImage` is provided the review loop runs against it as usual;
   * without a reference the loop runs with reviews DISABLED (each pass just builds and the last good
   * Group is kept, reusing the no-render degrade path). Same job lifecycle/guards/abort/finally as
   * {@link generate}. With `opts.autonomous`, the manual-review gate is forced off.
   */
  async generateFromSpec(
    spec: SculptSpec,
    opts?: {
      referenceImage?: ReferenceImageInput | null;
      mode?: ModelGenMode;
      prompt?: string;
      complexity?: ComplexityHint;
      autonomous?: boolean;
    }
  ): Promise<void> {
    if (this.abortController) {
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;
    this.resetRunState();
    this.setState({ canGenerate: false, error: null });

    try {
      this.setState({ status: 'speccing', stageLabel: 'Loading saved spec' });
      this.log('info', 'Regenerating from a saved spec.');
      this.setState({ spec });

      const mode: ModelGenMode = opts?.mode ?? this.settings.getPreferences().mode;
      const reference = opts?.referenceImage ?? null;
      const group = await this.runPassLoop(
        spec,
        { reference, mode, autonomous: opts?.autonomous ?? false },
        signal
      );

      this.currentModel = group;
      this.setState({ status: 'done', stageLabel: 'Done', currentPassId: null });
      this.log('success', 'Model generated successfully.');
      await this.recordJobHistory({
        spec,
        mode,
        prompt: opts?.prompt,
        complexity: opts?.complexity,
        reference,
        finalGroup: group,
      });
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

  /**
   * Rebuild a saved procedural factory into the preview — compile + instantiate via the existing
   * {@link buildFactory} path (guards → esbuild → blob import → `instanceof Group`), no LLM and no
   * network. Sets the current model, bumps `modelRevision`, records the source, and lands on `done`.
   * This powers "open a past model" from history. On failure lands on `error` with the message.
   */
  async rebuildFromCode(factoryCode: string): Promise<void> {
    if (this.abortController) {
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;
    this.setState({ canGenerate: false, error: null });

    try {
      this.setState({ status: 'compiling', stageLabel: 'Rebuilding saved model' });
      const group = await this.buildFactory(factoryCode, signal);
      this.currentModel = group;
      this.setState({
        factoryCode,
        modelRevision: this.state.modelRevision + 1,
        status: 'done',
        stageLabel: 'Done',
      });
      this.log('success', 'Model rebuilt from saved code.');
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        this.setState({ status: 'cancelled', stageLabel: 'Cancelled' });
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

  /**
   * The Phase-3 locked-pass loop. Each pass refines the factory toward one concern, is rendered
   * offscreen, composited against the reference into a comparison sheet, scored by the vision model,
   * then accepted or refined. When the offscreen renderer cannot initialize (no WebGL), the loop
   * runs WITHOUT the render/review gate — each pass just builds and the last good Group is kept.
   * Returns the final Group; on a `stop` verdict it throws with an honest message (the last good
   * Group stays available via {@link getModel}).
   */
  private async runPassLoop(
    spec: SculptSpec,
    context: PassLoopContext,
    signal: AbortSignal
  ): Promise<THREE.Group> {
    const passPlan = getPassPlan(context.mode);
    const seededPasses: PassRecord[] = passPlan.map(pass => ({
      id: pass.id,
      label: pass.label,
      status: 'pending',
      score: null,
      attempts: 0,
      sheetDataUrl: null,
      rationale: null,
    }));
    this.setState({ passes: seededPasses, currentPassId: null, pendingReview: null });

    const prefs = this.settings.getPreferences();
    const maxIterations = Math.max(1, prefs.maxIterationsPerPass);
    const scoreThreshold = prefs.scoreThreshold;
    // Autonomous runs can't resolve a manual gate — force it off regardless of the setting.
    const pauseForReview = context.autonomous ? false : prefs.pauseForReview;

    const reference = context.reference;
    let renderer: ModelPreviewRenderer | null = null;
    // Without a reference there is nothing to score against — run the build-only degrade path.
    let reviewsEnabled = reference != null;
    if (reviewsEnabled) {
      try {
        renderer = new ModelPreviewRenderer();
      } catch (error) {
        reviewsEnabled = false;
        this.log(
          'warn',
          `Offscreen preview unavailable — review is disabled for this job. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } else {
      this.log('info', 'No reference image — building without the review loop.');
    }

    let previousCode: string | null = null;
    let lastGroup: THREE.Group | undefined;

    try {
      for (const pass of passPlan) {
        this.throwIfAborted(signal);
        this.updatePass(pass.id, { status: 'running' });
        this.setState({ currentPassId: pass.id });

        let refineCount = 0;
        let feedback: string | null = null;

        for (;;) {
          const built = await this.buildPass(spec, pass, previousCode, feedback, signal, maxIterations);
          previousCode = built.code;
          lastGroup = built.group;
          this.currentModel = built.group;
          this.setState({
            factoryCode: built.code,
            modelRevision: this.state.modelRevision + 1,
          });
          this.updatePass(pass.id, { attempts: this.getPass(pass.id).attempts + 1 });

          if (!reviewsEnabled || !renderer || !reference) {
            this.updatePass(pass.id, { status: 'passed', score: null });
            break;
          }

          const sheetDataUrl = await this.renderAndComposite(
            renderer,
            built.group,
            reference,
            pass,
            signal
          );
          if (!sheetDataUrl) {
            // Rendering/compositing failed at runtime — degrade to accept rather than stall.
            this.updatePass(pass.id, { status: 'passed', score: null });
            break;
          }

          this.throwIfAborted(signal);
          this.setState({ status: 'reviewing', stageLabel: `Reviewing ${pass.label}` });
          const review = await this.reviewPass(spec, pass, sheetDataUrl, signal);
          this.updatePass(pass.id, {
            sheetDataUrl,
            score: review.globalScore,
            rationale: review.rationale,
          });
          this.log(
            'info',
            `Review ${pass.label}: score ${review.globalScore.toFixed(2)}, decision ${review.decision}.`
          );

          const decision = pauseForReview
            ? await this.gateManualReview(pass.id, review, signal)
            : review.decision;

          // Autonomous mode: an at/above-threshold score auto-accepts, overriding a conservative
          // vision verdict. Manual mode: the user's decision is authoritative — no threshold override,
          // so an explicit Stop/Retry always wins even when the score happens to be high.
          if (!pauseForReview && review.globalScore >= scoreThreshold) {
            this.updatePass(pass.id, { status: 'passed' });
            break;
          }
          if (decision === 'stop') {
            this.updatePass(pass.id, { status: 'failed' });
            throw new Error(
              `Stopped at ${pass.label}: ${review.rationale || 'fundamental mismatch with the reference.'}`
            );
          }
          if ((decision === 'refine-code' || decision === 'refine-spec') && refineCount < maxIterations) {
            refineCount += 1;
            feedback = review.rationale || 'Improve this pass to better match the reference.';
            if (decision === 'refine-spec') {
              this.log(
                'info',
                `${pass.label}: refine-spec requested; treating as a code refine (MVP).`
              );
            }
            this.updatePass(pass.id, { status: 'running' });
            continue;
          }
          // `continue`, or a refine request past the iteration cap → accept and advance.
          this.updatePass(pass.id, { status: 'passed' });
          break;
        }
      }
    } finally {
      renderer?.dispose();
    }

    this.setState({ currentPassId: null });
    if (!lastGroup) {
      throw new Error('The pass loop produced no model.');
    }
    return lastGroup;
  }

  /**
   * Codegen → compile → instantiate for one pass, with compile/runtime errors looping straight back
   * to codegen (no vision) up to {@link maxAttempts}. `feedback` seeds the first attempt (a review
   * refine note); later attempts feed the compile error instead.
   */
  private async buildPass(
    spec: SculptSpec,
    pass: PassPlanEntry,
    previousCode: string | null,
    refineFeedback: string | null,
    signal: AbortSignal,
    maxAttempts: number
  ): Promise<BuiltPass> {
    let compileError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.throwIfAborted(signal);
      this.setState({
        status: 'building',
        stageLabel:
          attempt === 1 ? `Building ${pass.label}` : `Fixing ${pass.label} (attempt ${attempt})`,
      });

      const feedback = compileError || refineFeedback || null;
      const prompt = buildPassFactoryPrompt(spec, pass, previousCode, feedback);
      const raw = await this.chatCodegen(
        prompt.system,
        prompt.systemStableChars,
        [{ role: 'user', content: prompt.user }],
        signal
      );
      const code = stripCodeFences(raw);
      this.setState({ status: 'compiling', stageLabel: `Compiling ${pass.label}` });

      try {
        this.throwIfAborted(signal);
        const group = await this.buildFactory(code, signal);
        this.log('success', `${pass.label} compiled on attempt ${attempt}.`);
        return { group, code };
      } catch (error) {
        if (this.isCancellation(error, signal)) {
          throw error;
        }
        compileError = describeBuildError(error);
        this.log('error', `${pass.label} build attempt ${attempt} failed: ${compileError}`);
      }
    }
    throw new Error(
      `${pass.label} code failed after ${maxAttempts} attempts. Last error: ${compileError}`
    );
  }

  /**
   * Render the built pass offscreen and composite it against the reference into a comparison sheet.
   * Returns the sheet data URL, or null if rendering/compositing failed at runtime (the caller then
   * degrades to accepting the pass). Cancellation still propagates.
   */
  private async renderAndComposite(
    renderer: ModelPreviewRenderer,
    group: THREE.Group,
    reference: ReferenceImageInput,
    pass: PassPlanEntry,
    signal: AbortSignal
  ): Promise<string | null> {
    this.throwIfAborted(signal);
    this.setState({ status: 'rendering', stageLabel: `Rendering ${pass.label}` });
    try {
      const renderDataUrl = renderer.renderThreeQuarter(group);
      const referenceDataUrl = referenceToDataUrl(reference);
      return await buildComparisonSheet({
        referenceDataUrl,
        renderDataUrl,
        renderLabel: `Render — ${pass.label}`,
      });
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        throw error;
      }
      this.log(
        'warn',
        `Review skipped for ${pass.label}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  /** Vision review of one pass's comparison sheet. Never throws for bad JSON — it defaults sanely. */
  private async reviewPass(
    spec: SculptSpec,
    pass: PassPlanEntry,
    sheetDataUrl: string,
    signal: AbortSignal
  ): Promise<ReviewResult> {
    const helper = await this.resolveVision();
    if (!helper) {
      return {
        globalScore: 1,
        featureScores: [],
        decision: 'continue',
        rationale: 'No vision model available for review; accepting the pass.',
      };
    }
    const prompt = buildReviewPrompt(spec, pass);
    const image: LlmImageBlock = {
      type: 'image',
      mimeType: 'image/png',
      data: stripDataUrlPrefix(sheetDataUrl),
    };
    const raw = await this.chatVision(
      helper,
      prompt.system,
      prompt.systemStableChars,
      prompt.user,
      image,
      signal
    );
    try {
      return coerceReviewResult(extractJsonObject(raw));
    } catch {
      this.log('warn', `${pass.label}: review response was not valid JSON; accepting the pass.`);
      return {
        globalScore: 0,
        featureScores: [],
        decision: 'continue',
        rationale: 'Review response was not valid JSON.',
      };
    }
  }

  /**
   * Open a manual-review gate: publish the {@link ModelGenState.pendingReview} and await the user's
   * {@link decideReview}. The returned promise rejects (AbortError) if the job is cancelled while
   * the gate is open, so the loop unwinds.
   */
  private gateManualReview(
    passId: PassId,
    review: ReviewResult,
    signal: AbortSignal
  ): Promise<ReviewDecision> {
    this.setState({
      status: 'reviewing',
      pendingReview: {
        passId,
        score: review.globalScore,
        decision: review.decision,
        rationale: review.rationale,
        sheetDataUrl: this.getPass(passId).sheetDataUrl ?? '',
      },
    });
    return new Promise<ReviewDecision>((resolve, reject) => {
      if (signal.aborted) {
        this.pendingReviewResolve = null;
        reject(new DOMException('Generation aborted.', 'AbortError'));
        return;
      }
      const onAbort = () => {
        this.pendingReviewResolve = null;
        this.setState({ pendingReview: null });
        reject(new DOMException('Generation aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingReviewResolve = (decision: ReviewDecision) => {
        signal.removeEventListener('abort', onAbort);
        resolve(decision);
      };
    });
  }

  private updatePass(id: PassId, patch: Partial<PassRecord>): void {
    const passes = this.state.passes.map(pass => (pass.id === id ? { ...pass, ...patch } : pass));
    this.setState({ passes });
  }

  private getPass(id: PassId): PassRecord {
    const found = this.state.passes.find(pass => pass.id === id);
    if (!found) {
      throw new Error(`Unknown pass "${id}".`);
    }
    return found;
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

  // -- history ---------------------------------------------------------------

  /**
   * Best-effort: persist a finished job to {@link Model3DGenHistoryService}. Renders a throwaway 3/4
   * preview for the record thumb (skipped if WebGL is unavailable) and stores the reference raw. This
   * NEVER throws out of a job — a history failure must not fail an otherwise-successful generation.
   */
  private async recordJobHistory(params: {
    spec: SculptSpec;
    mode: ModelGenMode;
    prompt: string | undefined;
    complexity: ComplexityHint | undefined;
    reference: ReferenceImageInput | null;
    finalGroup: THREE.Group;
  }): Promise<void> {
    try {
      const state = this.state;
      const passes = state.passes.map(pass => ({
        id: pass.id,
        label: pass.label,
        score: pass.score,
      }));
      // The last passed pass's score is the job's headline fidelity (null when review was disabled).
      const finalScore =
        [...state.passes].reverse().find(pass => pass.status === 'passed')?.score ?? null;
      const objectClass = state.assessment?.objectClass ?? params.spec.objectClass;
      const referenceThumb = params.reference
        ? base64ToBlob(params.reference.base64, params.reference.mimeType)
        : undefined;
      const thumb = this.renderRecordThumb(params.finalGroup);

      await this.history.add({
        objectClass,
        prompt: params.prompt,
        complexity: params.complexity ?? params.spec.complexity,
        mode: params.mode,
        spec: params.spec,
        factoryCode: state.factoryCode ?? '',
        passes,
        finalScore,
        usage: state.usage,
        referenceThumb,
        thumb,
      });
    } catch (error) {
      this.log(
        'warn',
        `Could not save this job to history: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /** Render a throwaway 3/4 preview of the final Group to a PNG Blob, or undefined when WebGL fails. */
  private renderRecordThumb(group: THREE.Group): Blob | undefined {
    let renderer: ModelPreviewRenderer | null = null;
    try {
      renderer = new ModelPreviewRenderer();
      const dataUrl = renderer.renderThreeQuarter(group);
      return base64ToBlob(stripDataUrlPrefix(dataUrl), 'image/png');
    } catch {
      return undefined;
    } finally {
      renderer?.dispose();
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
    this.pendingReviewResolve = null;
    this.setState({
      status: 'idle',
      stageLabel: '',
      log: [],
      assessment: null,
      spec: null,
      factoryCode: null,
      usage: { ...EMPTY_USAGE },
      error: null,
      passes: [],
      currentPassId: null,
      pendingReview: null,
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

/** Rebuild a `data:` URL from a prefix-free reference image input. */
function referenceToDataUrl(reference: ReferenceImageInput): string {
  return `data:${reference.mimeType};base64,${reference.base64}`;
}

/** Drop the `data:...;base64,` prefix from a data URL, leaving the bare base64 payload. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Map a UI accept/retry/stop verdict onto a {@link ReviewDecision}. */
function mapManualDecision(decision: ManualDecision): ReviewDecision {
  if (decision === 'accept') {
    return 'continue';
  }
  if (decision === 'stop') {
    return 'stop';
  }
  return 'refine-code';
}

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
