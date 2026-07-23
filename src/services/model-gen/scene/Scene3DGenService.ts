import { inject, injectable } from '@/fw/di';
import { SceneManager, type SceneGraph } from '@pix3/runtime';
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
import { Model3DGenSettingsService } from '@/services/model-gen/Model3DGenSettingsService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { extractJsonObject } from '@/services/model-gen/model-gen-json';
import { coerceReviewResult, type ReviewResult } from '@/services/model-gen/model-gen-review';
import { buildImageStrip, type StripImage } from '@/services/model-gen/ComparisonSheet';
import { SceneInventoryService } from '@/services/model-gen/scene/SceneInventoryService';
import { ScenePreviewRenderer } from '@/services/model-gen/scene/ScenePreviewRenderer';
import { normalizeResPath, validateSceneYaml } from '@/services/model-gen/scene/scene-validate';
import { validateLevelSpec, type LevelSpec } from '@/services/model-gen/scene/LevelSpec';
import { expandScatterDirectives } from '@/services/model-gen/scene/scene-scatter';
import {
  buildLevelSpecPrompt,
  buildScenePassPrompt,
  buildSceneReviewPrompt,
  getSceneEditPassPlan,
  getScenePassPlan,
  type ScenePassPlanEntry,
} from '@/services/model-gen/scene/prompts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  InventorySummary,
  SceneGenInput,
  SceneGenState,
} from '@/services/model-gen/scene/scene-gen-types';
import type {
  LlmUsageAggregate,
  ModelGenLogEntry,
  ModelGenMode,
  PassId,
  PassRecord,
  ReferenceImageInput,
  ReviewDecision,
} from '@/services/model-gen/model-gen-types';

/** A manual review verdict from the UI, mapped onto a {@link ReviewDecision}. */
type ManualDecision = 'accept' | 'retry' | 'stop';

/** A validated pass result: the accepted YAML plus the throwaway graph it parsed to (for rendering). */
interface BuiltScene {
  yaml: string;
  graph: SceneGraph;
}

/**
 * The run-specific inputs the pass loop needs, threaded explicitly rather than re-read from settings.
 * `autonomous` forces the manual-review gate off (a headless caller has no UI to resolve it).
 */
interface ScenePassLoopContext {
  referenceImages: ReferenceImageInput[];
  mode: ModelGenMode;
  autonomous: boolean;
  /** The loaded YAML of the scene being edited, seeding the first pass; null for a fresh generation. */
  baseYaml: string | null;
  /** True when editing an existing scene (uses the lighter edit pass plan + edit-framed prompts). */
  isEdit: boolean;
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

const EMPTY_USAGE: LlmUsageAggregate = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  calls: 0,
};

const INITIAL_STATE: SceneGenState = {
  status: 'idle',
  stageLabel: '',
  log: [],
  levelSpec: null,
  sceneYaml: null,
  passes: [],
  currentPassId: null,
  pendingReview: null,
  inventory: null,
  sceneRevision: 0,
  usage: { ...EMPTY_USAGE },
  error: null,
  canGenerate: true,
  savedPath: null,
};

/**
 * Headless orchestrator for the Scene lane: intake → inventory scan → level spec (codegen +
 * deterministic validate) → a locked-pass build loop that reuses the Phase-3 review machinery. Each
 * pass regenerates the WHOLE `.pix3scene` YAML toward one concern (layout → placement → dressing →
 * lighting → polish for `quality`; layout → placement&dressing → polish for `fast`), runs it through
 * the parse + type/ref validate gate (validation errors loop straight back to codegen, no vision),
 * renders it from multiple viewpoints offscreen, composites the views (+ any reference images) into a
 * strip, and has a vision model score it. The loop then accepts, refines (capped per pass), or stops.
 * When the offscreen renderer cannot initialize (no WebGL) the loop degrades to build+validate only.
 * With `pauseForReview` on, each review awaits a manual {@link decideReview}; a running {@link cancel}
 * unwinds that gate.
 *
 * State is exposed via an immutable {@link SceneGenState} + {@link subscribe}, mirroring
 * {@link import('../Model3DGenService').Model3DGenService}. The latest VALID YAML is handed out by
 * {@link getSceneYaml}; each new valid document bumps `sceneRevision` so the panel re-previews.
 */
@injectable()
export class Scene3DGenService {
  @inject(LlmProviderRegistry)
  private readonly registry!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(AgentVisionService)
  private readonly vision!: AgentVisionService;

  @inject(Model3DGenSettingsService)
  private readonly settings!: Model3DGenSettingsService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(SceneInventoryService)
  private readonly sceneInventory!: SceneInventoryService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private state: SceneGenState = INITIAL_STATE;
  private readonly listeners = new Set<(state: SceneGenState) => void>();
  private abortController: AbortController | null = null;
  private logSeq = 0;
  /** Resolver for the promise the pass loop awaits while a manual review gate is open, else null. */
  private pendingReviewResolve: ((decision: ReviewDecision) => void) | null = null;

  getState(): SceneGenState {
    return this.state;
  }

  subscribe(listener: (state: SceneGenState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** The latest valid scene YAML, or null before the first successful pass. */
  getSceneYaml(): string | null {
    return this.state.sceneYaml;
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

  /** Clear log/spec/inventory/usage back to a fresh idle state. Leaves the last YAML intact. */
  reset(): void {
    this.cancel();
    this.resetRunState();
    this.setState({ status: 'idle', stageLabel: '', canGenerate: true });
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  /**
   * Run one scene-generation job end-to-end. Resolves on done / error / cancel (errors and
   * cancellation are reflected in {@link SceneGenState}, not thrown). A second call while a job runs
   * is ignored. With `opts.autonomous`, the manual-review gate is forced off regardless of the
   * `pauseForReview` setting — a headless caller (agent / debug bridge) has no UI to resolve it.
   */
  async generate(input: SceneGenInput, opts?: { autonomous?: boolean }): Promise<void> {
    if (this.abortController) {
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;
    this.resetRunState();
    this.setState({ canGenerate: false, error: null });

    try {
      this.setState({ status: 'intake', stageLabel: 'Reading the brief' });
      if (!input.brief || !input.brief.trim()) {
        throw new Error('A brief is required.');
      }
      this.log('info', 'Starting scene generation.');

      const baseYaml = await this.loadBaseScene(input.baseScenePath, signal);
      const isEdit = baseYaml != null;
      if (isEdit) {
        this.log('info', `Editing existing scene: ${input.baseScenePath}.`);
      }

      this.setState({ status: 'inventory', stageLabel: 'Scanning project assets' });
      const inventory = await this.sceneInventory.scan();
      this.throwIfAborted(signal);
      this.setState({ inventory });
      this.log(
        'info',
        `Inventory: ${inventory.counts.model} models, ${inventory.counts.prefab} prefabs, ${inventory.counts.texture} textures.`
      );
      const knownAssetIds = new Set(inventory.items.map(item => item.id));
      const knownAssetPaths = this.sceneInventory.knownAssetPaths(inventory);

      const levelSpec = await this.makeLevelSpec(input, inventory, knownAssetIds, signal);
      const mode: ModelGenMode = input.mode ?? this.settings.getPreferences().mode;

      await this.runPassLoop(
        levelSpec,
        inventory,
        knownAssetPaths,
        {
          referenceImages: input.referenceImages ?? [],
          mode,
          autonomous: opts?.autonomous ?? false,
          baseYaml,
          isEdit,
        },
        signal
      );

      this.setState({ status: 'done', stageLabel: 'Done', currentPassId: null });
      this.log('success', 'Scene generated successfully.');
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
   * Write the current scene YAML to the project. Normalizes the path (strips `res://`, backslashes)
   * and ensures a `.pix3scene` extension, then {@link ProjectStorageService.writeTextFile}. Records
   * the path in {@link SceneGenState.savedPath}. Throws when no scene has been generated yet.
   */
  async saveScene(path: string): Promise<{ path: string }> {
    const yaml = this.state.sceneYaml;
    if (!yaml) {
      throw new Error('No scene has been generated yet.');
    }
    const normalized = normalizeScenePath(path);
    await this.storage.writeTextFile(normalized, yaml);
    this.setState({ savedPath: normalized });
    this.log('success', `Saved scene to ${normalized}.`);
    return { path: normalized };
  }

  // -- pipeline stages -------------------------------------------------------

  /**
   * Load the base scene to edit, or null when this is a fresh generation. Normalizes the `res://` /
   * project path the same way the save path is normalized, then reads it via
   * {@link ProjectStorageService.readTextFile}. A read failure (or an empty file) is a clean error —
   * editing cannot proceed without the source document.
   */
  private async loadBaseScene(
    baseScenePath: string | undefined,
    signal: AbortSignal
  ): Promise<string | null> {
    if (!baseScenePath || !baseScenePath.trim()) {
      return null;
    }
    const path = normalizeResPath(baseScenePath);
    let yaml: string;
    try {
      yaml = await this.storage.readTextFile(path);
    } catch (error) {
      throw new Error(
        `Could not read base scene: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.throwIfAborted(signal);
    if (!yaml || !yaml.trim()) {
      throw new Error(`Could not read base scene: "${path}" is empty.`);
    }
    return yaml;
  }

  private async makeLevelSpec(
    input: SceneGenInput,
    inventory: InventorySummary,
    knownAssetIds: ReadonlySet<string>,
    signal: AbortSignal
  ): Promise<LevelSpec> {
    this.throwIfAborted(signal);
    this.setState({ status: 'speccing', stageLabel: 'Planning the level' });

    const prompt = buildLevelSpecPrompt(input.brief, inventory);
    const first = await this.chatCodegen(
      prompt.system,
      prompt.systemStableChars,
      [{ role: 'user', content: prompt.user }],
      signal
    );
    let attempt = this.parseLevelSpec(first, knownAssetIds);

    if (!attempt.ok) {
      this.log(
        'warn',
        `Level spec failed validation: ${attempt.errors.join('; ')}. Requesting a repair.`
      );
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
        'Return a corrected level spec JSON only.',
      ].join('\n');
      const second = await this.chatCodegen(
        prompt.system,
        prompt.systemStableChars,
        [{ role: 'user', content: repairUser }],
        signal
      );
      attempt = this.parseLevelSpec(second, knownAssetIds);
    }

    if (!attempt.ok || !attempt.spec) {
      throw new Error(`Level spec did not pass validation: ${attempt.errors.join('; ')}`);
    }

    this.setState({ levelSpec: attempt.spec });
    this.log('success', `Level spec ready: ${attempt.spec.zones.length} zones.`);
    return attempt.spec;
  }

  private parseLevelSpec(
    text: string,
    knownAssetIds: ReadonlySet<string>
  ): { ok: boolean; spec: LevelSpec | null; errors: string[] } {
    let parsed: unknown;
    try {
      parsed = extractJsonObject(text);
    } catch (error) {
      return {
        ok: false,
        spec: null,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    const validation = validateLevelSpec(parsed, knownAssetIds);
    return {
      ok: validation.ok,
      spec: validation.ok ? (parsed as LevelSpec) : null,
      errors: validation.errors,
    };
  }

  /**
   * The locked-pass loop. Each pass regenerates the whole YAML toward one concern, is validated,
   * rendered from multiple viewpoints, composited into a strip, scored by the vision model, then
   * accepted or refined. When the offscreen renderer cannot initialize (no WebGL), the loop runs
   * WITHOUT the render/review gate — each pass just builds + validates. On a `stop` verdict it throws
   * an honest message (the last valid YAML stays available via {@link getSceneYaml}).
   */
  private async runPassLoop(
    levelSpec: LevelSpec,
    inventory: InventorySummary,
    knownAssetPaths: ReadonlySet<string>,
    context: ScenePassLoopContext,
    signal: AbortSignal
  ): Promise<void> {
    const passPlan = context.isEdit
      ? getSceneEditPassPlan(context.mode)
      : getScenePassPlan(context.mode);
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
    const pauseForReview = context.autonomous ? false : prefs.pauseForReview;

    let renderer: ScenePreviewRenderer | null = null;
    let reviewsEnabled = true;
    try {
      renderer = new ScenePreviewRenderer();
    } catch (error) {
      reviewsEnabled = false;
      this.log(
        'warn',
        `Offscreen preview unavailable — review is disabled for this job. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Seed the FIRST pass with the base scene so an edit run evolves it rather than starting empty.
    let previousYaml: string | null = context.baseYaml;

    try {
      for (const pass of passPlan) {
        this.throwIfAborted(signal);
        this.updatePass(pass.id, { status: 'running' });
        this.setState({ currentPassId: pass.id });

        let refineCount = 0;
        let feedback: string | null = null;

        for (;;) {
          const built = await this.buildValidScene(
            levelSpec,
            inventory,
            pass,
            previousYaml,
            feedback,
            knownAssetPaths,
            context.isEdit,
            signal,
            maxIterations
          );
          previousYaml = built.yaml;
          this.setState({
            sceneYaml: built.yaml,
            sceneRevision: this.state.sceneRevision + 1,
          });
          this.updatePass(pass.id, { attempts: this.getPass(pass.id).attempts + 1 });

          if (!reviewsEnabled || !renderer) {
            this.updatePass(pass.id, { status: 'passed', score: null });
            break;
          }

          const sheetDataUrl = await this.renderAndComposite(
            renderer,
            built.graph,
            context.referenceImages,
            pass,
            signal
          );
          if (!sheetDataUrl) {
            this.updatePass(pass.id, { status: 'passed', score: null });
            break;
          }

          this.throwIfAborted(signal);
          this.setState({ status: 'reviewing', stageLabel: `Reviewing ${pass.label}` });
          const review = await this.reviewPass(levelSpec, pass, sheetDataUrl, signal);
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
          // vision verdict. Manual mode: the user's decision is authoritative.
          if (!pauseForReview && review.globalScore >= scoreThreshold) {
            this.updatePass(pass.id, { status: 'passed' });
            break;
          }
          if (decision === 'stop') {
            this.updatePass(pass.id, { status: 'failed' });
            throw new Error(
              `Stopped at ${pass.label}: ${review.rationale || 'the scene cannot reach the brief.'}`
            );
          }
          if ((decision === 'refine-code' || decision === 'refine-spec') && refineCount < maxIterations) {
            refineCount += 1;
            feedback = review.rationale || 'Improve this pass to better match the brief.';
            if (decision === 'refine-spec') {
              this.log(
                'info',
                `${pass.label}: refine-spec requested; treating as a YAML refine (MVP).`
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
    if (!this.state.sceneYaml) {
      throw new Error('The pass loop produced no scene.');
    }
  }

  /**
   * Codegen → validate for one pass, with validation errors looping straight back to codegen (no
   * vision) up to {@link maxAttempts}. `refineFeedback` seeds the first attempt (a review refine
   * note); later attempts feed the validation errors instead. Returns the accepted YAML and the
   * throwaway graph it parsed to (reused for offscreen rendering — never handed to the panel).
   */
  private async buildValidScene(
    levelSpec: LevelSpec,
    inventory: InventorySummary,
    pass: ScenePassPlanEntry,
    previousYaml: string | null,
    refineFeedback: string | null,
    knownAssetPaths: ReadonlySet<string>,
    isEdit: boolean,
    signal: AbortSignal,
    maxAttempts: number
  ): Promise<BuiltScene> {
    let validationError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.throwIfAborted(signal);
      this.setState({
        status: 'building',
        stageLabel:
          attempt === 1 ? `Building ${pass.label}` : `Fixing ${pass.label} (attempt ${attempt})`,
      });

      const feedback = validationError || refineFeedback || null;
      const prompt = buildScenePassPrompt(levelSpec, inventory, pass, previousYaml, feedback, isEdit);
      const raw = await this.chatCodegen(
        prompt.system,
        prompt.systemStableChars,
        [{ role: 'user', content: prompt.user }],
        signal
      );
      // Expand any `Scatter` authoring sugar into concrete nodes BEFORE the validation gate, so the
      // saved scene never carries a Model-Lab-only node type.
      const yaml = this.applyScatter(stripCodeFences(raw), pass);

      this.throwIfAborted(signal);
      this.setState({ status: 'validating', stageLabel: `Validating ${pass.label}` });
      const result = await validateSceneYaml(yaml, this.sceneManager, { knownAssetPaths });
      if (result.ok && result.graph) {
        this.log('success', `${pass.label} validated on attempt ${attempt}.`);
        return { yaml, graph: result.graph };
      }

      validationError = result.errors.join('; ');
      this.log('error', `${pass.label} validation attempt ${attempt} failed: ${validationError}`);
    }
    throw new Error(
      `${pass.label} scene failed validation after ${maxAttempts} attempts. Last error: ${validationError}`
    );
  }

  /**
   * Expand `Scatter` authoring sugar into concrete nodes. Parses `yaml`, runs
   * {@link expandScatterDirectives}, and re-stringifies ONLY when at least one directive expanded —
   * so a scene with no `Scatter` nodes passes through byte-for-byte (preserving fresh-generation
   * behavior). A parse failure is left for the validation gate to report (returns the input
   * unchanged). Warnings are logged; a malformed directive stays as an unknown `Scatter` node and the
   * gate then rejects it.
   */
  private applyScatter(yaml: string, pass: ScenePassPlanEntry): string {
    let doc: unknown;
    try {
      doc = parseYaml(yaml);
    } catch {
      return yaml;
    }
    const expansion = expandScatterDirectives(doc);
    for (const warning of expansion.warnings) {
      this.log('warn', `${pass.label}: ${warning}`);
    }
    if (expansion.expandedCount === 0) {
      return yaml;
    }
    this.log('info', `${pass.label}: expanded ${expansion.expandedCount} scatter directive(s).`);
    return stringifyYaml(expansion.doc);
  }

  /**
   * Render the built pass from multiple viewpoints offscreen and composite them (+ any reference
   * images) into one review strip. Returns the strip data URL, or null if rendering/compositing
   * failed at runtime (the caller then degrades to accepting the pass). Cancellation still
   * propagates. The graph's roots are a THROWAWAY parse — safe to reparent/recenter for framing.
   */
  private async renderAndComposite(
    renderer: ScenePreviewRenderer,
    graph: SceneGraph,
    referenceImages: ReferenceImageInput[],
    pass: ScenePassPlanEntry,
    signal: AbortSignal
  ): Promise<string | null> {
    this.throwIfAborted(signal);
    this.setState({ status: 'rendering', stageLabel: `Rendering ${pass.label}` });
    try {
      const views = await renderer.renderViews(graph.rootNodes);
      const referenceCells: StripImage[] = referenceImages.map((reference, index) => ({
        label: `Reference ${index + 1}`,
        dataUrl: `data:${reference.mimeType};base64,${reference.base64}`,
      }));
      const cells: StripImage[] = [
        ...views.map(view => ({ label: view.label, dataUrl: view.dataUrl })),
        ...referenceCells,
      ];
      return await buildImageStrip(cells);
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

  /** Vision review of one pass's render strip. Never throws for bad JSON — it defaults sanely. */
  private async reviewPass(
    levelSpec: LevelSpec,
    pass: ScenePassPlanEntry,
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
    const prompt = buildSceneReviewPrompt(levelSpec, pass);
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
   * Open a manual-review gate: publish {@link SceneGenState.pendingReview} and await the user's
   * {@link decideReview}. The returned promise rejects (AbortError) if the job is cancelled while the
   * gate is open, so the loop unwinds.
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
      levelSpec: null,
      sceneYaml: null,
      passes: [],
      currentPassId: null,
      pendingReview: null,
      inventory: null,
      sceneRevision: 0,
      usage: { ...EMPTY_USAGE },
      error: null,
      savedPath: null,
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

  private setState(patch: Partial<SceneGenState>): void {
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

/** Strip a ```yaml / ``` markdown fence from a response, if present. */
function stripCodeFences(text: string): string {
  const fenced = text
    .trim()
    .match(/```(?:yaml|yml|pix3scene)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** Normalize a save target: strip `res://`/backslashes/leading slashes and ensure `.pix3scene`. */
function normalizeScenePath(path: string): string {
  const cleaned = path
    .replace(/\\+/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim();
  const base = cleaned || 'scene';
  return /\.pix3scene$/i.test(base) ? base : `${base}.pix3scene`;
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
