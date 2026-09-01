import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { guessMimeType } from '@/core/remote-preview/protocol';
import { ensureAssetTypeFolder } from '@/core/asset-categories';
import {
  ENGINE_PATH_PREFIX,
  loadEngineSources,
  readEngineSource,
  searchEngineSources,
} from '@/core/engine-source';
import {
  clearScriptDiagnosticErrors,
  componentToDTO,
  errors as capturedErrors,
  installErrorCapture,
  nodeToDTO,
  type NodeDTO,
  type NodeSummary,
} from '@/core/agent-introspection';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { FlowStageService } from '@/services/flow/FlowStageService';
import { FLOW_PROGRESS_PATH } from '@/services/flow/FlowPlanService';
import {
  FlowReferencesService,
  REFERENCES_DIR,
  type FlowReferenceRole,
} from '@/services/flow/FlowReferencesService';
import { DECISIONS_PATH, appendDecision } from '@/services/flow/decision-log';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { StudioViewportMountService } from '@/services/editor/StudioViewportMountService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import {
  ScriptCompilerService,
  type CompilationError,
} from '@/services/scripting/ScriptCompilerService';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { LoggingService } from '@/services/core/LoggingService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { AssetGenService, type AssetPostProcessPreset } from '@/services/image-gen/AssetGenService';
import {
  MAX_SFX_ITERATIONS,
  SFX_DIRECTORY,
  SfxGenService,
  describeSfxOutcome,
} from '@/services/sfx-gen/SfxGenService';
import { blobToBase64, type AlphaStats } from '@/services/image-gen/image-ops';
import { Model3DGenService } from '@/services/model-gen/Model3DGenService';
import { Model3DExportService } from '@/services/model-gen/Model3DExportService';
import type {
  ComplexityHint,
  ModelGenMode,
  ReferenceImageInput,
} from '@/services/model-gen/model-gen-types';
import { Scene3DGenService } from '@/services/model-gen/scene/Scene3DGenService';
import { AgentVisionService } from '@/services/agent/AgentVisionService';
import {
  GameInputService,
  type GameInputStep,
  type GameInputExpectation,
} from '@/services/agent/GameInputService';
import { GameTestService, type GameRunSpec } from '@/services/agent/GameTestService';
import { COMPARISON_OPS, GAME_ASSERTION_KINDS } from '@/services/agent/game-assertions';
import {
  InMemoryTraceStore,
  TRACE_DIRECTORY,
  TRACE_FORMAT_VERSION,
  validateTrace,
  type TraceEvent,
  type TraceTolerance,
} from '@/services/agent/game-traces';
import { InMemoryRoutineStore, ROUTINE_DIRECTORY } from '@/services/agent/game-routines';
import { InMemoryBotStore } from '@/services/agent/game-bots';
import { GameBotHost } from '@/services/agent/GameBotHost';
import {
  ProjectBotStore,
  ProjectReportStore,
  ProjectRoutineStore,
  ProjectTraceStore,
} from '@/services/agent/ProjectTraceStore';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import type { CanvasScreenshot } from '@/core/canvas-screenshot';
import { AgentAdvisorService } from '@/services/agent/AgentAdvisorService';
import { AgentSkillsService } from '@/services/agent/AgentSkillsService';
import { ProjectDiagnosticsService } from '@/services/scripting/ProjectDiagnosticsService';
import type { LlmImageBlock } from '@/services/llm/LlmTypes';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { SaveSceneCommand } from '@/features/scene/SaveSceneCommand';
import { ReloadSceneCommand } from '@/features/scene/ReloadSceneCommand';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { StartSceneGameCommand } from '@/features/scripts/StartSceneGameCommand';
import { resolveGameplayScenePath } from '@/features/scripts/play-workspace';
import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import {
  SceneManager,
  NodeBase,
  Node3D,
  collectRenderabilityIssues,
  ScriptRegistry,
  getNodePropertySchema,
  resolveRuntimeTimeConfig,
  MAX_TICKS_PER_FRAME,
  type ResolvedRuntimeTimeConfig,
  type RuntimeTimeConfig,
  type RuntimeTimeMode,
  type SceneRunner,
} from '@pix3/runtime';
import { renderabilityNote } from '@/services/agent/renderability-note';
import { Frustum, Matrix4, Mesh, Vector2, Vector3, type Object3D } from 'three';
import {
  buildCreateNodeCommand,
  CREATABLE_NODE_TYPES,
  type CreateNodeOptions,
} from '@/services/agent/create-node-registry';
import { ConvertNodeTypeCommand } from '@/features/scene/ConvertNodeTypeCommand';
import { ReparentNodeCommand } from '@/features/scene/ReparentNodeCommand';

/** JSON Schema for a tool's input. */
export type JsonSchema = Record<string, unknown>;

/** An image a tool wants shown to the model (base64 WITHOUT the `data:` prefix). */
export interface AgentToolImage {
  readonly mimeType: string;
  readonly data: string;
}

/**
 * Reserved key in a tool handler's return value: images listed here are lifted out of the JSON
 * tool-result by the chat loop and attached to the conversation as real image blocks (all three
 * providers are multimodal), so the model *sees* screenshots/previews instead of reading base64.
 */
export const AGENT_TOOL_IMAGES_KEY = '__images';

/**
 * What the screenshot tools say once even an on-demand Studio mount could not produce a viewport.
 * Reached when there is no project, no scene to front, or no editor shell at all — never merely
 * because the session lives in Vibe, which now mounts the viewport hidden on request.
 */
const EDITOR_VIEWPORT_UNAVAILABLE =
  'The viewport is not initialized yet (open a project with a scene first).';

/** A tool the agent may call. `handler` returns JSON-safe data (never a live object). */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** The LLM-facing subset of a tool definition (no handler). */
export interface AgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/**
 * The tools the agent gets at the Flow **idea stage** (design §3.10): text, files, images and
 * questions. Not one scene, script, play-mode or gameplay tool.
 *
 * Two reasons, and the second is the important one. It halves the tools block of every request at a
 * stage where the project is an empty canvas — and it removes a whole class of turn where the agent
 * "gets a head start" on a scene that the genre recipe is about to overwrite. The set is constant
 * within the stage, so the cached prompt prefix stays stable; it changes exactly once, at the
 * transition, where `newConversation()` resets the cache anyway.
 */
export const IDEA_STAGE_TOOLS: ReadonlySet<string> = new Set([
  'read_skill',
  'ask_advisor',
  'ask_user',
  'record_decision',
  'fs_list',
  'fs_read',
  'fs_write',
  'str_replace',
  'fs_delete',
  'generate_asset',
  'analyze_image',
  'process_asset',
]);

// Script collection mirrors PreviewHostService.collectScriptFiles.
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
const EXCLUDED_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;
const SCRIPT_ENTRY_PATTERN = /extends\s+Script\b/;

// `run_command` allow-list (plan §5): only command namespaces that mutate the scene / editor state
// without opening a dialog or picker. Everything else (project.open, editor.open-settings, …) is
// refused with an explanation in the tool result.
const RUN_COMMAND_ALLOWED_PREFIXES = [
  'scene.',
  'properties.',
  'selection.',
  'alignment.',
  'history.',
  'viewport.',
  'game.',
] as const;

/**
 * One `game_run` predicate, as the model sees it.
 *
 * Deliberately one flat object with a `kind` discriminator rather than a `oneOf`
 * of one shape per kind: tool-schema support for `oneOf` is uneven across providers, and
 * the per-kind requirements are enforced by `parseAssertion`, which answers a bad
 * payload with a sentence naming the missing field. The enums are imported from
 * `game-assertions` so the schema cannot drift from the parser.
 */
const GAME_ASSERTION_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'A predicate checked every frame. `kind` decides which other fields apply: gameState needs path+op+value, gameStateChanged needs path (+ optional signed `by`), nodeGone needs name, nodeMoved needs name (+ optional axis/min/max), nodeAppeared needs query, nodeProperty needs name+path+op+value, axis needs name+op+value, newErrors takes an optional min, frames needs n, command needs name (+ optional args), signal needs name (+ optional node).',
  properties: {
    kind: { type: 'string', enum: [...GAME_ASSERTION_KINDS] },
    path: {
      type: 'string',
      description:
        "gameState / gameStateChanged: dot path into the game's GameDebugProvider snapshot, e.g. 'score' or 'player.hp'. nodeProperty: dot path into the live node's own properties instead, e.g. 'position.x', 'text', 'enabled', 'opacity'.",
    },
    op: {
      type: 'string',
      enum: [...COMPARISON_OPS],
      description:
        'gameState / nodeProperty / axis: how the read value is compared against `value`. Ordering ops (gt/gte/lt/lte) compare numbers only; "contains" has no meaning for an axis.',
    },
    value: {
      description:
        'gameState / nodeProperty: the value to compare against (any JSON value). axis: a finite number — prefer a threshold to equality, since a stick lands on 0.6187…, not on 0.6.',
    },
    query: {
      type: 'string',
      description:
        "nodeAppeared: a live node name/nodeId OR a node type ('Enemy2D'). Both readings are tried — a name that was absent at frame 0 and is present now, or more live nodes of that type than at frame 0. The type reading is the only one that can see a POOLED spawn, since a recycled node keeps its name.",
    },
    axis: {
      type: 'string',
      enum: ['x', 'y', 'z'],
      description:
        'nodeMoved: measure the SIGNED delta on this world axis instead of the plain distance travelled, which is what makes a direction assertable — {axis:\'x\', max:0} is "moved left". (For the `axis` predicate the axis NAME goes in `name`, not here.)',
    },
    by: {
      type: 'number',
      description:
        'gameStateChanged: the SIGNED delta from frame 0 that must be reached — 1 means "grew by at least 1", -2 means "dropped by at least 2". Omit for "changed at all".',
    },
    name: {
      type: 'string',
      description:
        "The thing being named, per kind: nodeGone / nodeMoved / nodeProperty — a live node name or nodeId; axis — the input axis as the game knows it ('Horizontal', 'Move_X'); command — the intent as registered ('settings.toggle-music'); signal — the signal a node emits ('toggled', 'pressed', 'died').",
    },
    min: {
      type: 'number',
      description:
        'newErrors: how many new runtime errors are needed (an integer >= 1, default 1). nodeMoved: the lower bound on the measurement — the distance travelled, or the signed delta when `axis` is set. A half-unit floor on |delta| always applies, so a direction bound can never be satisfied by standing still.',
    },
    max: {
      type: 'number',
      description:
        'nodeMoved: the upper bound on the same measurement — the half that expresses a direction, e.g. {axis:\'x\', max:0} for "moved left". Negative without an `axis` is refused, because a distance is never negative.',
    },
    n: {
      type: 'integer',
      description:
        'frames: the frame number to reach (>= 1 — frames(0) is true at the baseline by construction).',
    },
    args: {
      type: 'object',
      description:
        'command: fields the dispatched payload must contain, e.g. {slot: 2}. SUBSET match — only the keys you name are compared (each as a whole subtree) and extra keys in the payload are ignored, so you never have to reproduce a payload byte for byte. Omit to match any dispatch of that name.',
      additionalProperties: true,
    },
    node: {
      type: 'string',
      description:
        'signal: live node name or nodeId to listen on. Prefer it — omitting it listens scene-wide, which re-sweeps the live scene every frame for newly spawned emitters (that is the form that catches an enemy that did not exist at frame 0).',
    },
  },
  required: ['kind'],
  additionalProperties: false,
};

/** Fields of `game_time` that form the time contract (as opposed to the `step` action). */
const TIME_CONFIG_KEYS = [
  'mode',
  'fixedDeltaSec',
  'ticksPerFrame',
  'renderEveryNTicks',
  'muteAudio',
] as const;

/** One line describing a resolved time contract, for error messages. */
function describeTimeMode(config: Readonly<ResolvedRuntimeTimeConfig>): string {
  const parts = [`mode '${config.mode}'`];
  if (config.mode !== 'realtime') {
    parts.push(`fixedDeltaSec ${config.fixedDeltaSec}`);
    if (config.ticksPerFrame !== 1) parts.push(`ticksPerFrame ${config.ticksPerFrame}`);
  }
  return parts.join(', ');
}

// File extensions treated as text for `fs_read`. Binary files return metadata instead of content.
const TEXT_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'pix3scene',
  'pix3anim',
  'yaml',
  'yml',
  'md',
  'txt',
  'css',
  'html',
  'htm',
  'svg',
  'xml',
  'glsl',
  'vert',
  'frag',
  'csv',
  'ini',
  'cfg',
  'toml',
]);

const MAX_LOG_ENTRIES = 200;

/**
 * Size above which overwriting an EXISTING file with fs_write is refused without an explicit
 * `overwrite:true` + reason. Roughly a screenful of attention: below it a rewrite is cheap and
 * harmless, above it a rewrite has measurably lost edits made earlier in the same session.
 */
const FS_WRITE_GUARD_CHARS = 2_000;

/**
 * A file this small is returned WHOLE even when the agent asked for a line range. Measured in a
 * dogfooding run: the agent paged through a 15.4 KB `main.pix3scene` **six times** because each
 * str_replace shifted its anchors, spending 16 of 40 iterations on reading. The whole file fits in
 * one tool result (`MAX_TOOL_RESULT_CHARS` = 24 000, and JSON escaping of newlines/quotes inflates
 * text by well under 50 %), so serving it in full is strictly cheaper than the paging loop.
 */
/**
 * Filenames under `design/` that mean "the build plan" to a model but nothing to the editor.
 * A write to one of these earns a pointer at {@link FLOW_PROGRESS_PATH} — see `strayPlanNote`.
 */
const PLAN_SHAPED_STEMS: ReadonlySet<string> = new Set([
  'plan',
  'plans',
  'roadmap',
  'tasks',
  'todo',
  'todos',
  'backlog',
  'milestones',
  'checklist',
]);

const FS_READ_FULL_CHARS = 16_000;

/** Lines of the updated file returned on each side of a successful str_replace. */
const STR_REPLACE_CONTEXT_LINES = 8;

/** Hard cap on the post-edit context, so an edit inside very long lines cannot flood the result. */
const STR_REPLACE_CONTEXT_CHARS = 2_000;

/**
 * Property types whose value is a genuine string — never JSON-parse an agent-supplied string for
 * these (a color "#ff0000", an enum "idle", or a node reference must stay a string). Every OTHER
 * type — numbers, booleans, vectors, objects — may arrive stringified from some providers (see
 * coercePropertyValue) and is parsed back.
 */
const STRINGLIKE_PROPERTY_TYPES = new Set(['string', 'color', 'enum', 'select', 'node']);

/**
 * Registry of tools the in-editor AI agent can call. Each tool is a
 * `{ name, description, inputSchema (JSON Schema), handler }` and every handler returns JSON-safe
 * data. Scene reads reuse `agent-introspection`; mutations flow through the command gateway
 * (`CommandDispatcher`) so they land in undo/redo; file writes go through `ProjectStorageService`,
 * whose write/delete methods already bump `appState.project.fileRefreshSignal` (surfacing agent
 * edits to open code tabs and the asset browser) — so tools never poke `appState` directly.
 *
 * Tools that produce pixels (`viewport_screenshot`, `generate_asset`) return their images under
 * {@link AGENT_TOOL_IMAGES_KEY}; the chat loop turns those into real image blocks for the model.
 */
const TEMPORARY_EDIT_ARG_DESCRIPTION =
  'Mark this a DEBUG value that must not outlive the turn (e.g. cranking gravity to see a collision). The previous value is journalled and put back automatically when the turn ends — including when the turn is force-stopped at the iteration cap — so you never have to spend your last iterations undoing it. Use revert_temporary_edits to put everything back sooner.';

/**
 * Detach a schema value from the live scene before parking it in the journal: three.js vectors and
 * colors are mutable references, so keeping one would "remember" whatever the debug write did to it.
 */
function snapshotPropertyValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const vector = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
  if (typeof vector.x === 'number' && typeof vector.y === 'number') {
    return {
      x: vector.x,
      y: vector.y,
      ...(typeof vector.z === 'number' ? { z: vector.z } : {}),
      ...(typeof vector.w === 'number' ? { w: vector.w } : {}),
    };
  }
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Shallow structural equality, enough to tell "already back at the original value" from "still debug". */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key =>
    Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

/**
 * One property the agent deliberately changed **for the duration of a turn only** — a debug value
 * it intends to put back. See {@link AgentToolRegistry.revertTemporaryEdits}.
 */
interface TemporaryEdit {
  /** `node` = a node property, `component` = one property of an attached component. */
  readonly kind: 'node' | 'component';
  readonly nodeId: string;
  readonly componentId?: string;
  readonly propertyPath: string;
  /** The value that was in place BEFORE the first temporary write to this target. */
  readonly previousValue: unknown;
  /** Human-readable target, e.g. `player-controller.gravity`. */
  readonly label: string;
}

@injectable()
export class AgentToolRegistry {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ScriptCompilerService)
  private readonly compiler!: ScriptCompilerService;

  @inject(CommandRegistry)
  private readonly commands!: CommandRegistry;

  @inject(CommandDispatcher)
  private readonly dispatcher!: CommandDispatcher;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  /**
   * Builds the edit-mode viewport on demand. Vibe never constructs the docking editor, so in a
   * session that has not visited Studio there is no viewport to photograph — the screenshot tools
   * ask for one before reporting a failure.
   */
  @inject(StudioViewportMountService)
  private readonly studioViewportMount!: StudioViewportMountService;

  @inject(AssetGenService)
  private readonly assetGen!: AssetGenService;

  @inject(SfxGenService)
  private readonly sfxGen!: SfxGenService;

  @inject(Model3DGenService)
  private readonly model3dGen!: Model3DGenService;

  @inject(Model3DExportService)
  private readonly model3dExport!: Model3DExportService;

  @inject(Scene3DGenService)
  private readonly sceneGen!: Scene3DGenService;

  @inject(AgentVisionService)
  private readonly vision!: AgentVisionService;

  @inject(GameInputService)
  private readonly gameInput!: GameInputService;

  @inject(GameTestService)
  private readonly gameTest!: GameTestService;

  /**
   * Held only to point the policy declarations at the open project — the runs
   * themselves reach the host through {@link gameTest}, which is the single owner of
   * a bot session's lifetime.
   */
  @inject(GameBotHost)
  private readonly botHost!: GameBotHost;

  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  @inject(AgentAdvisorService)
  private readonly advisor!: AgentAdvisorService;

  @inject(AgentSkillsService)
  private readonly skills!: AgentSkillsService;

  @inject(ProjectDiagnosticsService)
  private readonly diagnostics!: ProjectDiagnosticsService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(EditorTabService)
  private readonly editorTabs!: EditorTabService;

  @inject(ProjectScriptLoaderService)
  private readonly projectScriptLoader!: ProjectScriptLoaderService;

  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

  @inject(FlowStageService)
  private readonly flowStage!: FlowStageService;

  @inject(FlowReferencesService)
  private readonly flowReferences!: FlowReferencesService;

  private tools: AgentToolDefinition[] | null = null;

  constructor() {
    // Cheap ring-buffer error capture, installed in production too so `read_errors` has data.
    installErrorCapture();
  }

  /** All registered tools (definitions with handlers). */
  list(): AgentToolDefinition[] {
    return this.ensureTools();
  }

  /**
   * LLM-facing tool specs (name/description/inputSchema — no handler).
   *
   * `allow` narrows the list by name, for callers that run the agent in a mode where only part of
   * the surface makes sense (see {@link IDEA_STAGE_TOOLS}). It filters the SPECS only: `execute`
   * still knows every tool, because the gate belongs where the request is built, not where a name
   * is resolved.
   */
  specs(allow?: ReadonlySet<string>): AgentToolSpec[] {
    return this.ensureTools()
      .filter(tool => !allow || allow.has(tool.name))
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
  }

  /** Execute a tool by name. Throws for an unknown tool; handlers own their own error semantics. */
  async execute(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.ensureTools().find(t => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args);
  }

  // -- tool table ------------------------------------------------------------

  private ensureTools(): AgentToolDefinition[] {
    if (!this.tools) {
      this.tools = this.buildTools();
    }
    return this.tools;
  }

  private buildTools(): AgentToolDefinition[] {
    return [
      {
        name: 'read_skill',
        description:
          'Read a bundled skill: a short step-by-step guide for a class of task (see the skill index in the system prompt). Call this BEFORE starting a matching task — e.g. read "game-prototype" before building from a GDD, "asset-generation" before making art, "verify-and-fix" before/while debugging a run. Optionally pass a section heading to read just that part.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              enum: this.skills.list().map(skill => skill.id),
              description: 'The skill id to read.',
            },
            section: {
              type: 'string',
              description: 'Optional: a "## Section" heading to read just that part of the skill.',
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
        handler: args => this.readSkill(args),
      },
      {
        name: 'ask_advisor',
        description:
          'Consult a stronger "advisor" model when you are genuinely stuck or facing a non-obvious decision: an error that survived ~2 fix attempts, an architecture/approach choice, or a review of your plan before a large change. NOT for routine operations or anything another tool answers directly. The advisor sees ONLY what you pass here (no scene, no files, no conversation) — put the goal, the exact error text, and the relevant code/snippets into `context`, or you will get generic advice. Costly: at most a couple of calls per task.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'One specific question (one decision or one problem per call).',
            },
            context: {
              type: 'string',
              description:
                'Everything needed to answer: relevant code, exact error messages, what you already tried, constraints/goal. The advisor cannot look anything up itself.',
            },
          },
          required: ['question', 'context'],
          additionalProperties: false,
        },
        handler: args => this.askAdvisor(args),
      },
      {
        name: 'ask_user',
        description:
          'Ask the USER to settle a fork, and END YOUR TURN. The question is shown with its options as clickable chips; the answer arrives as the next user message. Ask ONLY about a fork that changes the STRUCTURE of the scene or the scripts — "win by score or by timer?", "enemies in waves or continuous?", "one level or a level list?" — where guessing wrong means rebuilding. Cosmetics and parameters (colors, sizes, speeds, counts, names, wording) you choose YOURSELF and state in one line ("made it 3 waves — say if that is wrong"). Asking about those turns the session into a questionnaire, which is worse than a wrong guess you can change in a second. One question per call, at most one per turn, and only after you have something playable to show.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: "The question, in the user's language. One sentence.",
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description:
                '2-4 short answers shown as chips. Each must describe a concrete outcome, not "yes"/"no".',
            },
            allowFreeform: {
              type: 'boolean',
              description: 'Whether a typed answer also makes sense (default true).',
            },
          },
          required: ['question'],
          additionalProperties: false,
        },
        handler: args => this.askUser(args),
      },
      {
        name: 'record_decision',
        description:
          'Record a settled fork in `design/decisions.md` — one line, append-only. Call it the moment a STRUCTURAL question is answered by something other than an ask_user chip: the user settled it in prose, or you and the user converged on it while talking. Answers to your own ask_user questions are recorded automatically, so do NOT re-record those — call this on one only to ADD the reason you learned. Same bar as ask_user: a fork where guessing wrong means rebuilding ("win by score or timer?", "one level or a list?"). Never colors, sizes, counts or wording — the log is read at the start of every compacted conversation and handed to the planner, so every line has to earn its tokens. Recording the same question twice REPLACES the earlier line instead of stacking a contradiction.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: "The fork, in the user's language. One sentence.",
            },
            choice: { type: 'string', description: 'What was settled on. A few words.' },
            reason: { type: 'string', description: 'Why, in one line. Optional but valuable.' },
            alternatives: {
              type: 'array',
              items: { type: 'string' },
              description: 'The options that lost, if they were named.',
            },
          },
          required: ['question', 'choice'],
          additionalProperties: false,
        },
        handler: args =>
          this.recordDecision({
            question: asString(args.question),
            choice: asString(args.choice),
            reason: typeof args.reason === 'string' ? args.reason : '',
            alternatives: Array.isArray(args.alternatives)
              ? args.alternatives.filter((item): item is string => typeof item === 'string')
              : [],
          }),
      },
      {
        name: 'scene_tree',
        description:
          "Return the EDITOR's active scene as a node tree, expanded up to maxDepth levels. This is the authored graph, not the running game: if the game has navigated to another scene the result carries `staleWhilePlaying` naming the live roots — read what is actually on screen with game_observe.",
        inputSchema: {
          type: 'object',
          properties: {
            maxDepth: { type: 'integer', description: 'Tree depth to expand (default 3).' },
          },
          additionalProperties: false,
        },
        handler: async args => {
          await this.ensureActiveScene();
          return this.sceneTree(asInt(args.maxDepth, 3));
        },
      },
      {
        name: 'node_inspect',
        description:
          "Full detail of one node: transform, properties, and script components. These are the AUTHORED values from the editor's scene — while the game is playing the running node may hold different ones (a script moved it, retextured it, rewrote its label), and the result then carries `authoredWhilePlaying` saying so. Verify a running game with game_observe, never with this.",
        inputSchema: {
          type: 'object',
          properties: { nodeId: { type: 'string' } },
          required: ['nodeId'],
          additionalProperties: false,
        },
        handler: async args => {
          await this.ensureActiveScene();
          return this.nodeInspect(asString(args.nodeId));
        },
      },
      {
        name: 'find_nodes',
        description: 'Case-insensitive search across node name and type.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        handler: async args => {
          await this.ensureActiveScene();
          return this.findNodes(asString(args.text));
        },
      },
      {
        name: 'get_selection',
        description: 'Current selection: node ids, primary node id, hovered node id.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.getSelection(),
      },
      {
        name: 'set_property',
        description:
          'Set a property on a node (undoable). While playing, hot-reloads onto the running scene. Pass `temporary: true` for a debug value you intend to put back.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            propertyPath: { type: 'string' },
            value: {},
            temporary: { type: 'boolean', description: TEMPORARY_EDIT_ARG_DESCRIPTION },
          },
          required: ['nodeId', 'propertyPath'],
          additionalProperties: false,
        },
        handler: async args => {
          await this.ensureActiveScene();
          return this.setProperty(
            asString(args.nodeId),
            asString(args.propertyPath),
            args.value,
            args.temporary === true
          );
        },
      },
      {
        name: 'create_node',
        description:
          'Create a new node in the active scene (undoable). Use it to build scenes and — importantly — to turn placeholder art into real graphics, e.g. add a Sprite2D that shows a generated texture. `nodeType` is case-insensitive; creatable types: ' +
          CREATABLE_NODE_TYPES.join(', ') +
          ". Pass `texturePath` (res://…) for sprites (it also auto-sizes them), an optional `parentId` (defaults to a sensible root) and `position` {x,y}, and a `properties` object for anything else (color/width/height/label/opacity/…) applied via set_property after creation. Returns the new nodeId, plus a `warning` + `duplicateNameNodeIds` when the chosen `name` already exists in the scene (name-based addressing in game_input/game_observe then becomes ambiguous — rename or delete). To REPLACE an existing placeholder such as a ColorRect2D with a sprite, prefer convert_node_type — it keeps the node's transform, components and children.",
        inputSchema: {
          type: 'object',
          properties: {
            nodeType: { type: 'string', description: 'e.g. "Sprite2D" (case-insensitive).' },
            name: { type: 'string' },
            parentId: {
              type: 'string',
              description: 'Parent node id; omit for a sensible default root.',
            },
            position: {
              type: 'object',
              description: "2D position {x,y} in the parent's space.",
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
            position3: {
              type: 'object',
              description:
                'World position {x,y,z} for 3D types (lights, meshes). Use this instead of `position` for anything 3D.',
              properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            },
            texturePath: {
              type: 'string',
              description:
                'res:// image path for Sprite2D / TiledSprite2D / Sprite3D (also auto-sizes the sprite).',
            },
            width: { type: 'number' },
            height: { type: 'number' },
            text: { type: 'string', description: 'Initial text for Label2D.' },
            src: { type: 'string', description: 'res://….glb path for MeshInstance3D.' },
            properties: {
              type: 'object',
              description:
                'Extra schema properties applied after creation via set_property, e.g. {"color":"#ff0000","opacity":0.5}.',
              additionalProperties: true,
            },
          },
          required: ['nodeType'],
          additionalProperties: false,
        },
        handler: args => this.createNode(args),
      },
      {
        name: 'convert_node_type',
        description:
          'Replace an existing node with a new node of a different type IN PLACE, keeping its id, name, transform, size, attached components AND children (undoable). This is the right way to "skin" a placeholder: e.g. convert a scaffolding ColorRect2D into a Sprite2D showing a generated texture without losing the script component on it. Pass the new visual bits via `properties` (e.g. {"texturePath":"res://…"} for a sprite). Common target types: ' +
          CREATABLE_NODE_TYPES.join(', ') +
          ' (most serializable node types work). Returns the (unchanged) nodeId and its new type.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'Id of the node to replace.' },
            toType: {
              type: 'string',
              description: 'Target node type, e.g. "Sprite2D" (case-sensitive type name).',
            },
            properties: {
              type: 'object',
              description:
                'Property overrides for the new node, applied on top of the migrated ones — e.g. {"texturePath":"res://…"} for a Sprite2D.',
              additionalProperties: true,
            },
          },
          required: ['nodeId', 'toType'],
          additionalProperties: false,
        },
        handler: args => this.convertNodeType(args),
      },
      {
        name: 'move_node',
        description:
          'Move a node to a new parent AND/OR change its order among its siblings (undoable). This is the correct, gateway-safe way to fix draw order — NEVER hand-edit the .pix3scene to reorder nodes. For 2D nodes, paint order follows sibling order: a LATER sibling draws ON TOP (Godot-like). So to put an effects layer above enemies, move it AFTER them (placement:"front" or afterSiblingId). To reparent, pass parentId (or toRoot:true for the top level); omit both to reorder within the current parent. Choose ONE ordering input: placement ("front"=on top/last, "back"=behind/first), beforeSiblingId, afterSiblingId, or an explicit 0-based index (0=behind, last=on top); omit all to append (on top). Returns the resulting siblingOrder so you can verify without another call. For layering ACROSS branches of the tree (or when the tree must not change), prefer set_property "zIndex" on the 2D node — higher draws on top, inherited by its subtree, tree order breaks ties.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'Node to move/reorder.' },
            parentId: {
              type: 'string',
              description:
                'New parent node id. Omit to keep the current parent (pure reorder). Ignored when toRoot is true.',
            },
            toRoot: {
              type: 'boolean',
              description: 'Move the node to the scene root (top level) instead of a parent node.',
            },
            index: {
              type: 'integer',
              description:
                "0-based position among the target parent's children after the move. 0 = first (drawn behind, for 2D); the last index = on top. Omit to append (on top).",
            },
            beforeSiblingId: {
              type: 'string',
              description: 'Place immediately before this sibling (drawn just behind it, for 2D).',
            },
            afterSiblingId: {
              type: 'string',
              description:
                'Place immediately after this sibling (drawn just on top of it, for 2D).',
            },
            placement: {
              type: 'string',
              enum: ['front', 'back'],
              description:
                'Shortcut: "front" = on top (last child), "back" = behind (first child).',
            },
          },
          required: ['nodeId'],
          additionalProperties: false,
        },
        handler: args => this.moveNode(args),
      },
      {
        name: 'list_component_types',
        description:
          'List every script/behaviour component type that can be attached to a node: built-ins ("core:*", e.g. core:Rotate) and this project\'s user scripts ("user:*"). Each entry includes its configurable properties (name + type). Call this before add_component so you use a real type id and valid config keys.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.listComponentTypes(),
      },
      {
        name: 'add_component',
        description:
          'Attach a script/behaviour component to a node (undoable). Use a componentType from list_component_types. `config` sets initial property values (must match that type\'s property names). Returns the created componentId — pass it to set_component_property / remove_component. For a user script, write & compile_scripts the file first, then attach with its "user:<ExportName>" type.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            componentType: {
              type: 'string',
              description:
                'A type id from list_component_types (e.g. "core:Rotate" or "user:Foo").',
            },
            config: {
              type: 'object',
              description: 'Optional initial property values keyed by property name.',
              additionalProperties: true,
            },
            enabled: { type: 'boolean', description: 'Initial enabled state (default true).' },
          },
          required: ['nodeId', 'componentType'],
          additionalProperties: false,
        },
        handler: async args => {
          await this.ensureActiveScene();
          return this.addComponent(args);
        },
      },
      {
        name: 'set_component_property',
        description:
          'Set one property on a component already attached to a node (undoable). Identify the component by the componentId from node_inspect or add_component. Pass `temporary: true` for a debug value you intend to put back.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            componentId: { type: 'string' },
            propertyName: { type: 'string' },
            value: {},
            temporary: { type: 'boolean', description: TEMPORARY_EDIT_ARG_DESCRIPTION },
          },
          required: ['nodeId', 'componentId', 'propertyName'],
          additionalProperties: false,
        },
        handler: async args => {
          await this.ensureActiveScene();
          return this.setComponentProperty(
            asString(args.nodeId),
            asString(args.componentId),
            asString(args.propertyName),
            args.value,
            args.temporary === true
          );
        },
      },
      {
        name: 'revert_temporary_edits',
        description:
          'Put back every value written with `temporary: true` this turn and save. Call it as soon as a debug experiment is over. You do not have to: the same revert runs automatically when the turn ends, so a turn cut off at the iteration cap still ships clean values.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
          const pending = this.listTemporaryEdits();
          if (pending.length === 0) {
            return { ok: true, reverted: [], note: 'No temporary edits are outstanding.' };
          }
          return { ok: true, ...(await this.revertTemporaryEdits()) };
        },
      },
      {
        name: 'remove_component',
        description:
          'Detach a component from a node (undoable). Identify it by the componentId from node_inspect.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            componentId: { type: 'string' },
          },
          required: ['nodeId', 'componentId'],
          additionalProperties: false,
        },
        handler: async args => {
          await this.ensureActiveScene();
          return this.removeComponent(asString(args.nodeId), asString(args.componentId));
        },
      },
      {
        name: 'list_commands',
        description:
          'List registered editor commands (id, title, menuPath) and whether the agent may run each.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.listCommands(),
      },
      {
        name: 'run_command',
        description:
          'Run a registered command by id (use list_commands for the catalog; do not invent ids — there is no "scene.reload", edited scene files auto-reload). Only scene/properties/selection/alignment/history/viewport/game.* commands are permitted (no dialogs/pickers).',
        inputSchema: {
          type: 'object',
          properties: { commandId: { type: 'string' } },
          required: ['commandId'],
          additionalProperties: false,
        },
        handler: args => this.runCommand(asString(args.commandId)),
      },
      {
        name: 'fs_list',
        description: 'List a project directory (relative to the project root).',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path (default ".").' } },
          additionalProperties: false,
        },
        handler: args => this.fsList(args.path === undefined ? '.' : asString(args.path)),
      },
      {
        name: 'fs_read',
        description: `Read a project file. Text files return their content plus \`totalLines\`; binary files return metadata (size, mimeType) only. For LARGE files (e.g. a big .pix3scene) read a RANGE with \`offset\` (1-based start line) and \`limit\` (line count) — the result then also reports \`startLine\`, \`endLine\` and \`hasMore\`. Reading an exact range is the reliable way to copy text verbatim for a str_replace edit on a big file (a full read may be truncated in transit). A file under ${FS_READ_FULL_CHARS} characters is ALWAYS returned whole and says so in \`note\`, even if you asked for a range — you then have the complete file, so do not page through it.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            offset: {
              type: 'integer',
              description: '1-based line to start reading from. Omit to read from the beginning.',
            },
            limit: {
              type: 'integer',
              description:
                'Maximum number of lines to return from `offset`. Omit to read to the end.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        handler: args =>
          this.fsRead(
            asString(args.path),
            args.offset === undefined ? undefined : asInt(args.offset, 1),
            args.limit === undefined ? undefined : asInt(args.limit, 0)
          ),
      },
      {
        name: 'engine_search',
        description: `Search the ENGINE's own source (\`${ENGINE_PATH_PREFIX}src/**\`) — the shipped \`@pix3/runtime\` that your scripts import. Read-only ground truth: this is what the code actually does, so prefer it over guessing a property name from documentation, and use it whenever a compile error names a type you did not write (\`does not exist in type 'ShakeOptions'\` → search \`interface ShakeOptions\` and read the fields). It cannot be edited — it is the engine inside this editor build, not a project file. Returns matches as \`{path, line, text}\` (feed \`line\` straight to engine_read's \`offset\`), plus \`matchCount\`/\`truncated\` so a flood of hits reads as "narrow the query" rather than "that is all of them". Some capabilities are wired by the EDITOR and live outside this tree (rigid-body physics is the one that bites): for those the result carries \`notes\` telling you where the thing actually is — read them, and never read a thin result on such a query as "the engine cannot do this".`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Literal substring, or a regex with regex:true.',
            },
            regex: { type: 'boolean' },
            pathFilter: {
              type: 'string',
              description: 'Only search paths containing this text, e.g. `nodes/2D` or `JuiceApi`.',
            },
            maxMatches: { type: 'integer', description: 'Default 40, max 200.' },
            contextLines: {
              type: 'integer',
              description: 'Lines of context around each hit (max 4). Cheaper than a full read.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        handler: async args =>
          searchEngineSources(await loadEngineSources(), {
            query: asString(args.query),
            regex: args.regex === true,
            pathFilter: args.pathFilter === undefined ? undefined : asString(args.pathFilter),
            maxMatches: args.maxMatches === undefined ? undefined : asInt(args.maxMatches, 40),
            contextLines: args.contextLines === undefined ? undefined : asInt(args.contextLines, 0),
          }),
      },
      {
        name: 'engine_read',
        description: `Read a slice of one ENGINE source file (read-only; see engine_search). Paths are package-relative — \`${ENGINE_PATH_PREFIX}src/core/JuiceApi.ts\` — and the shorter forms (\`src/core/JuiceApi.ts\`, or just \`JuiceApi.ts\` when unambiguous) resolve too; a path that does not resolve comes back with \`suggestions\` instead of a dead end. Use \`offset\` (1-based line) + \`limit\` to read around a search hit rather than pulling whole files: the engine has files thousands of lines long, and the interface you need is usually 20 of them.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            offset: { type: 'integer', description: '1-based line to start from (default 1).' },
            limit: { type: 'integer', description: 'Lines to return (default 200, max 800).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        handler: async args =>
          readEngineSource(
            await loadEngineSources(),
            asString(args.path),
            args.offset === undefined ? 1 : asInt(args.offset, 1),
            args.limit === undefined ? undefined : asInt(args.limit, 200)
          ),
      },
      {
        name: 'fs_write',
        description: `Write (create or overwrite) a project text file. Missing parent directories ARE created, and the ones it had to create come back in \`createdDirectories\` — read that list: it is where a typo in a path segment shows up, since a mistyped folder is created just as happily as the one you meant (fs_delete it and write again under the right path). Use it to CREATE files; to change an existing one, use str_replace. Overwriting an existing file larger than ${FS_WRITE_GUARD_CHARS} characters is REFUSED unless you pass overwrite:true plus a reason — a full rewrite silently drops edits you made earlier in the session (measured: a model rewrote the same large file three times with identical content, believing it had changed a constant). Writing the ACTIVE scene file replaces the scene wholesale (the editor auto-reloads it): components previously attached via add_component are lost unless your YAML includes them — verify with node_inspect afterwards.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            overwrite: {
              type: 'boolean',
              description:
                'Allow replacing an existing large file wholesale. Only for a genuine full rewrite — for a targeted change use str_replace instead.',
            },
            reason: {
              type: 'string',
              description: 'Why a wholesale rewrite is needed (required with overwrite:true).',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        handler: args =>
          this.fsWrite(asString(args.path), asString(args.content), {
            overwrite: args.overwrite === true,
            reason: typeof args.reason === 'string' ? args.reason.trim() : '',
          }),
      },
      {
        name: 'str_replace',
        description:
          'Make a TARGETED edit to an existing project text file: replace an exact `old_string` with `new_string`, leaving everything else byte-for-byte. PREFER THIS over fs_write for changing existing code — a full rewrite can silently drop or revert other parts of the file (a real session regressed a working fix that way). `old_string` must match the file EXACTLY (indentation and whitespace included) and be UNIQUE — include a few surrounding lines to pin it down. It makes NO change and returns an error if `old_string` is not found or matches more than once; read the error, widen the context, and retry. Pass replace_all:true to replace every occurrence. Use fs_write only to CREATE a file or rewrite it wholesale. Editing the active .pix3scene reloads it (same as fs_write). On success the result carries `context` — the surrounding lines of the file AS IT NOW IS (verbatim, with `startLine`/`endLine`) — plus the new `totalLines`. Anchor your NEXT edit on that text instead of re-reading the file: line numbers shift after every edit, the returned context does not.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: {
              type: 'string',
              description: 'Exact text to find, verbatim (including indentation/newlines).',
            },
            new_string: {
              type: 'string',
              description: 'Text to replace it with (may be empty to delete).',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace every occurrence. Default false = require exactly one match.',
            },
          },
          required: ['path', 'old_string', 'new_string'],
          additionalProperties: false,
        },
        handler: args =>
          this.strReplace(
            asString(args.path),
            asString(args.old_string),
            asString(args.new_string),
            args.replace_all === true
          ),
      },
      {
        name: 'fs_delete',
        description: 'Delete a project file or directory.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        handler: args => this.fsDelete(asString(args.path)),
      },
      {
        name: 'compile_scripts',
        description:
          'Build and register the project user scripts, THEN type-check them — one call, the whole answer. `ok: false` means either the bundle failed (see `error`/`file`/`line`) or the bundle registered but TypeScript found problems (`errorCount` > 0 with `diagnostics`: { file, line, column, message, category, code }). Do NOT follow this with check_scripts: the type diagnostics are already in this result.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.compileScripts(),
      },
      {
        name: 'check_scripts',
        description:
          'Type-check ALL project scripts WITHOUT rebuilding, returning { file, line, column, message, category, code } problems. compile_scripts already runs this check and reports the same diagnostics, so after an edit just compile — reach for this only to re-check untouched code (e.g. why a script misbehaves when you changed nothing).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.checkScripts(),
      },
      {
        name: 'play_start',
        description:
          'Enter play mode (start the game). Idempotent: if the game is ALREADY running it returns ok with `alreadyRunning: true` — you do not need to play_stop first, and you should not. Without `scene` plays the active scene (auto-opens the project scene if none). Pass `scene` (res:// or project-relative .pix3scene path) to play that exact scene, restarting whatever is running; `reload: true` additionally re-reads it from disk first — use after compiling scripts when the scene was opened before the compile (stale graph drops user:* components). To pick up a fresh script build in the scene that is already playing, use play_restart.',
        inputSchema: {
          type: 'object',
          properties: {
            scene: {
              type: 'string',
              description: 'Scene to play (.pix3scene, res:// or project-relative). Optional.',
            },
            reload: {
              type: 'boolean',
              description: 'Re-read the scene from disk before playing (only with `scene`).',
            },
          },
          additionalProperties: false,
        },
        handler: args =>
          this.playStart(
            typeof args.scene === 'string' ? args.scene : undefined,
            args.reload === true
          ),
      },
      {
        name: 'play_stop',
        description: 'Exit play mode (stop the game).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.playCommand('game.stop'),
      },
      {
        name: 'play_restart',
        description: 'Restart play mode.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.playCommand('game.restart'),
      },
      {
        name: 'play_status',
        description:
          "Whether the scene is playing, plus WHAT THE LAST FRAME DREW — the black-screen triage call. While a runtime is attached it also returns `render` (drawCalls / triangles / geometries / textures, read straight off the renderer, so they answer the same in Studio and in Vibe) and `visible3D` {camera, meshCount, inFrustum, onScreen}: the active Camera3D, how many 3D meshes the running scene has, how many are inside that camera's frustum, and how many actually land on screen. Zero on either counter means the 3D pass is drawing NOTHING and `hint` names the likely cause — a handful of draw calls for a scene full of meshes says the same thing. Trust `onScreen` over `inFrustum`: one big flat mesh (a ground plane) keeps clipping the frustum from a camera pointed the other way. Call this before screenshotting a 3D scene that renders only its background colour.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.playStatus(),
      },
      {
        name: 'game_input',
        description:
          "Send REAL input to the RUNNING game and verify the REACTION in one call (requires play mode — play_start first). Steps: {type:'key',code:'ArrowUp',ms:800} holds a key (KeyboardEvent.code: 'KeyW','ArrowLeft','Space'); {type:'keys',codes:['KeyW','KeyA'],ms:500} holds a chord; {type:'tap',target:'PlayButton'} presses a node (Button2D etc.) by name or nodeId — or tap at coordinates {type:'tap',x:960,y:540} (same space as node position properties); {type:'hover',target:'PlayButton',ms:900} moves the pointer OVER a node without pressing (buttons:0) and holds — the only way to trigger hover states (Button2D hover skin, hover-scale scripts). Hover PERSISTS after the call (the pointer stays where you left it); to verify the return-to-rest, hover away: {type:'hover',x:<empty area>,y:...}. Observed nodes also report their rendered `text` (Label2D/Button2D — check a score/HUD value by reading it, not by screenshotting), `scale`/`opacity`, endpoint `scaleDelta`/`scaled`/`opacityDelta`, and window peaks `activity.maxScaleDelta`/`activity.opacityRange` — a PunchScale/PopIn/fade that returns to rest inside the window is still provable, with zero screenshots. {type:'invoke',target:'MuteButton',interaction:'click'} drives a control BY NAME through its own input funnel — the semantic channel: no coordinates, no projection, no aiming, and it accepts `args` for interactions that take them ({type:'invoke',target:'Volume',interaction:'setValue',args:{value:0.5}}). Get the names from game_controls. When it cannot be delivered the step FAILS with the reason (not interactive / no such interaction / the control is enabled:false / an ancestor scroll container has the pointer). The rule between the two channels, plainly: invoke exercises everything AFTER \"the point is inside the control\" — enabled, the scroll gate, the skin state machine, the signal order, the game logic — but NOT whether a finger can actually hit it, since the pointer is synthesized from the control's own transform. So make the FIRST contact with a control a physical {type:'tap'}, then invoke for the rest. {type:'drag',x,y,to:{x,y},ms}; {type:'wait',ms}. Every step that has a duration also accepts `frames` instead of `ms`, and `frames` wins when both are given — a hold is really counted in game ticks, so `frames:8` is 8 polls of the key regardless of frame rate. READ `verdict` FIRST: it fuses every signal into one line — `moved:false` does NOT mean the game is dead. Pass observe:['Player','Cannonballs'] to watch nodes over the whole window (not just endpoints). Each observed node reports transform motion (`moved`, `alignForward`/`alignRight`: +1 forward along the nose, ~0 = SIDEWAYS, −1 backward) AND `activity` — what it did DURING the window: `spawned`/`removed` children, `visibleChildPeak` (pools recycle ammo by toggling visibility — the count of children in flight, NOT position), `maxChildDistance` (projectiles fly while the spawner stays at 0,0). A spawner/shooter/pool/HUD reacts WITHOUT moving. When a GameDebugProvider is registered, `game.changed` carries the game's own state diff (ammo/score/wave). To assert: expect:{'PlayerCar':'forward'} for movers → observed.PlayerCar.directionOk; expect:{'Cannonballs':'activity'} for spawners/shooters/pools/HUD → passes when anything reacted. Values: forward | backward | sideways | moving | still | activity. Tapping a node that is off screen is REFUSED with the reason (its own `visible: false`, or `hiddenByAncestor` — an invisible parent hides the whole subtree), instead of dispatching into empty space and looking like dead game logic. If the input navigated the game to ANOTHER SCENE, the result says so via `sceneChanged` {fromRoots,toRoots} and the verdict leads with SCENE CHANGED — the watched nodes died with the old scene, so re-observe against the new one instead of reading their deltas as a dead reaction.",
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Input steps, executed in order. Total duration is capped at 15s.',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['tap', 'key', 'keys', 'drag', 'wait', 'hover', 'invoke'],
                  },
                  target: {
                    type: 'string',
                    description: 'Node name or nodeId to tap/hover/drag from, or to invoke on.',
                  },
                  interaction: {
                    type: 'string',
                    description:
                      "invoke only: the interaction to perform, as named by game_controls ('click', 'toggle', 'setValue', 'scrollBy', 'setStick', 'activate', …).",
                  },
                  args: {
                    type: 'object',
                    description:
                      'invoke only: arguments for the interaction, keyed by the argument names game_controls lists (e.g. {value: 0.5}). Omitting one the interaction has no default for is refused with its name.',
                    additionalProperties: true,
                  },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  to: {
                    type: 'object',
                    description: 'Drag destination: coordinates or a target node.',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                      target: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                  code: { type: 'string', description: "KeyboardEvent.code, e.g. 'KeyW'." },
                  codes: { type: 'array', items: { type: 'string' } },
                  ms: {
                    type: 'number',
                    description:
                      'Hold/drag/wait/hover duration in ms. On an invoke step it is dwell AFTER the call (default 0) — the invocation itself is instantaneous, so add ms/frames when you want a latched press or hover to be observed before the next step.',
                  },
                  frames: {
                    type: 'number',
                    description:
                      'Duration in GAME FRAMES instead of milliseconds. WINS over ms/holdMs when both are given; omit it and ms behaves exactly as before. Prefer it for anything the game measures per tick — a hold of 8 frames is 8 polls of the key whatever the frame rate or time mode, while "130ms" is 8 polls only if the game happens to run at 60fps.',
                  },
                  holdMs: {
                    type: 'number',
                    description: 'Tap press duration (default 700 — UI buttons need a real press).',
                  },
                },
                required: ['type'],
                additionalProperties: false,
              },
            },
            observe: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Node names/ids to watch over the window: transform (moved, alignForward/alignRight), children (childCount/visibleChildCount), and `activity` (spawned/removed, visibleChildPeak, maxChildDistance, stateChanges, maxScaleDelta/opacityRange — scale/fade effects, even ones that return to rest). Watch the container of a spawner/pool (e.g. "Cannonballs"), not just the player. Max 8 tracked.',
            },
            expect: {
              type: 'object',
              description:
                "Per-node assertion, e.g. {'PlayerCar':'forward'} or {'Cannonballs':'activity'}. Each named node is auto-observed and gets a directionOk verdict. Use 'activity' for spawners/shooters/pools/HUD that react without moving. Values: forward | backward | sideways | moving | still | activity.",
              additionalProperties: {
                type: 'string',
                enum: ['forward', 'backward', 'sideways', 'moving', 'still', 'activity'],
              },
            },
            settleMs: {
              type: 'number',
              description: 'Extra wait before the "after" snapshot (default 300).',
            },
          },
          required: ['steps'],
          additionalProperties: false,
        },
        handler: args =>
          this.gameInput.run(Array.isArray(args.steps) ? (args.steps as GameInputStep[]) : [], {
            observe: Array.isArray(args.observe) ? (args.observe as string[]) : undefined,
            settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
            expect:
              args.expect && typeof args.expect === 'object'
                ? (args.expect as Record<string, GameInputExpectation>)
                : undefined,
          }),
      },
      {
        name: 'game_controls',
        description:
          "List everything in the RUNNING game that can be driven BY NAME instead of by coordinate (requires play mode). One call replaces \"read the scene tree, guess which nodes are buttons, guess where they are\": for every interactive node it returns nodeId, name, type, `enabled`, `visible`, a `reach` status and the `interactions` it offers with their arguments (name, type, required, default, allowed values). Two sources are merged — the engine's own controls (Button2D and every UIControl2D: hover/press/release/click; Checkbox2D: toggle/setChecked; Slider2D: setValue/dragTo; ScrollContainer2D: scrollBy/scrollTo/fling; Joystick2D: setStick/releaseStick; InventorySlot2D: activate) and any node whose SCRIPT COMPONENT declares interactions, which is how a clickable game object that is not a UI control becomes addressable (`fromComponent` names the declaring component; you still invoke it by NODE name). The names here are exactly what game_input's {type:'invoke',target,interaction,args} step takes. READ `reach` BEFORE blaming the game when nothing happens: 'hidden' (its own visible is false) and 'hidden-by-ancestor' (an invisible parent hides the whole subtree) mean it draws nothing and no tap can land; 'off-screen' means it projects outside the canvas; 'in-frame-unproven' means it is in frame but no real pointer has landed on it yet this session; 'reachable' means one has; 'unknown' means it could not be projected at all. THE RULE BETWEEN THE TWO CHANNELS, in plain words: a semantic `invoke` exercises everything that happens AFTER \"the point is inside the control\" — `enabled`, the ancestor-scroll gate, the skin state machine, the order of the lifecycle signals, the game logic listening on them — but it does NOT check that a finger could ever hit the control, because it synthesizes the pointer from the control's own transform. So touch a control PHYSICALLY the first time ({type:'tap',target:'…'} — that is what flips its reach to 'reachable') and use invoke for every call after that. What this tool CANNOT tell you: whether a control is COVERED by another one. The engine has no global picking pass — every control polls the pointer independently — so overlap is detected by nobody and a tap where two controls overlap fires both; a status claiming otherwise would be a lie. Reach proof is PERSISTED to design/tests/reachability.json and survives a page reload, but it BURNS when the control's context changes — it moved, got hidden (itself or by an ancestor), scrolled out, or left the frame; the listing then says which of those happened. A window resize or a DPR change does NOT burn it. `journalNote` explains any problem with the journal file itself (missing is silent; corrupt starts a fresh one and says so).",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.gameInput.listControls(),
      },
      {
        name: 'game_observe',
        description:
          "Live state of nodes in the RUNNING game WITHOUT sending input (requires play mode): transform, scale/opacity, the rendered `text` of label-like nodes (Label2D/Button2D — read the SCORE or HUD value straight off the node instead of screenshotting it), children (childCount/visibleChildCount), and the game's own `game.snapshot` when a GameDebugProvider is registered. Pass nodes:['Player','Enemy'] (names or ids); omit to sample the scene roots. With a window — sampleMs (e.g. 1000-2000), or `frames` for a budget denominated in game ticks, which wins when both are given — it records that window and reports per-node `activity` (motion, spawn/despawn, visible-child bursts, state changes) + `moved`/`alignForward`/`alignRight`, plus a fused `verdict` — e.g. confirm an AI car drives on its own, or measure a self-acting spawner's baseline BEFORE you attribute activity to your input. A `null` snapshot comes with a `hint` (play mode still warming up → retry, vs wrong name/id → check scene_tree). `visible` is the node's OWN flag and is NOT proof it is on screen: when an ancestor is hidden the snapshot carries `hiddenByAncestor` and the `hint` says NOT ON SCREEN — an invisible parent hides the whole subtree, so such a node draws nothing and cannot be tapped no matter what its own properties say. A UI control (Button2D/Checkbox2D/Slider2D/…) also reports `control: { enabled, hovering, pressed }` — READ IT FIRST when a button does nothing: `enabled: false` means the press can never register (the recipe may keep a result-overlay button disabled until its own game-over path enables it), and `hovering` tells you whether the pointer reached the control's bounds at all.",
        inputSchema: {
          type: 'object',
          properties: {
            nodes: { type: 'array', items: { type: 'string' } },
            sampleMs: {
              type: 'number',
              description: 'Optional: wait this long and sample again to detect motion (max 5000).',
            },
            frames: {
              type: 'number',
              description:
                'Observation window in GAME FRAMES instead of milliseconds. WINS over sampleMs when both are given; omit it and sampleMs behaves exactly as before. Use it when what you are measuring is per-tick (a spawn every 90 frames, a projectile that crosses the screen in 40) — a frame budget stays the same window whether the game runs at 60fps or is being stepped.',
            },
          },
          additionalProperties: false,
        },
        // `frames` is forwarded positionally after `sampleMs`; the cast is what lets this
        // registration land before GameInputService.observe grows the parameter (the extra
        // argument is inert until it does). The spec pins the call shape so a divergence
        // shows up as a failing test rather than a silently dropped budget.
        handler: args => {
          const observe = this.gameInput.observe.bind(this.gameInput) as (
            queries: string[],
            sampleMs?: number,
            frames?: number
          ) => ReturnType<GameInputService['observe']>;
          return observe(
            Array.isArray(args.nodes) ? (args.nodes as string[]) : [],
            typeof args.sampleMs === 'number' ? args.sampleMs : 0,
            typeof args.frames === 'number' ? args.frames : undefined
          );
        },
      },
      {
        name: 'game_time',
        description:
          "Control HOW the RUNNING game's clock advances (requires play mode). Three modes: 'realtime' — one tick per animation frame off the wall clock, the way a player experiences it; the default, and the only mode in which game_input's holds work. 'fixed' — `ticksPerFrame` ticks of exactly `fixedDeltaSec` per animation frame: deterministic and up to 240× wall clock, so half a minute of gameplay can be watched in a couple of seconds. 'manual' — NO animation frame is ever scheduled and the game advances only when you pass `step`; this is frame-by-frame debugging, and the only mode that keeps full speed in a background tab. Pass `step: N` (manual only) to run N ticks. Pass `paused: true|false` to hold the game on the current frame or let it run again — a paused game advances for nobody, `step` included, and this is how you RELEASE the pause game_run leaves on its outcome frame. READ `ticksExecuted` FIRST: it is how many ticks ACTUALLY ran, and a 0 there means the game is paused or stopped — not that the game did nothing. `time` in the reply is the RESOLVED contract rather than what you asked for (`ticksPerFrame` is clamped to 1.." +
          MAX_TICKS_PER_FRAME +
          ", `renderEveryNTicks` defaults to `ticksPerFrame` in 'fixed'), so read it back instead of assuming; `notes` names anything that got clamped. The config REPLACES the previous one whole — an omitted field returns to its default rather than keeping the current value — so `mode` is required whenever you change anything. `muteAudio` (default true) silences the master bus outside 'realtime', where audio timing is meaningless anyway. What this tool does NOT do: it sends no input and asserts nothing. To judge what the game DOES over a frame budget use game_run (it drives its own manual loop and restores the mode itself, so you do not need game_time for it); to send input use game_input, in 'realtime'. Anything other than 'realtime' leaves the game unplayable by a human until you set it back — 'manual' in particular looks exactly like a hang.",
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['realtime', 'fixed', 'manual'],
              description:
                'Required whenever you change the contract (the config is replaced whole, never merged). Omit the whole config to only read the current one back, or to only `step`.',
            },
            fixedDeltaSec: {
              type: 'number',
              description:
                "Tick length in 'fixed'/'manual' (default 1/60). Must be > 0 — a zero or negative step is not a slower game, it is a frozen or time-reversed one, and is refused.",
            },
            ticksPerFrame: {
              type: 'number',
              description: `Ticks per animation frame in 'fixed' — the speed-up. Clamped to 1..${MAX_TICKS_PER_FRAME}.`,
            },
            renderEveryNTicks: {
              type: 'number',
              description:
                "Paint once every N ticks. Defaults to `ticksPerFrame` in 'fixed' (one paint per batch, which is the point of a speed-up) and to 1 elsewhere.",
            },
            muteAudio: {
              type: 'boolean',
              description: "Silence the master bus outside 'realtime'. Default true.",
            },
            step: {
              type: 'integer',
              description:
                "Run this many ticks synchronously. Only in 'manual' — send {mode:'manual', step:N} to switch and step in one call.",
            },
            paused: {
              type: 'boolean',
              description:
                'Hold the game paused (true) or let it run again (false). A paused game ignores `step` and every clock mode — nothing advances at all. This is how you RELEASE the pause game_run leaves on its outcome frame: {paused: false}. Independent of `mode`, and it survives the editor losing focus.',
            },
          },
          additionalProperties: false,
        },
        handler: args => this.gameTime(args),
      },
      {
        name: 'game_run',
        description:
          "Run the RUNNING game forward frame by frame until a condition holds, and report WHICH one and on WHICH FRAME (requires play mode). This is how you judge gameplay over time: game_run owns the clock (it steps the game itself in manual time mode), so every predicate is checked on EVERY frame — an event is caught in the frame it happens instead of in a sample that straddles it — and the run stops the moment something decides, so a win in the second second does not cost fifteen. READ `verdict` FIRST: one line carrying PASS / FAIL / TIMEOUT / PRECONDITION ALREADY MET, which predicate decided, the frame, and the evidence; `outcome` {kind, channel, index, frame, gameTimeMs} is the same thing as data. `until` (REQUIRED) is what you are waiting for — OR over the list, the first to hold ends the run as a PASS. `fail` ends it as a FAIL. Both are also evaluated at frame 0: a predicate that is ALREADY TRUE before the run ends it with PRECONDITION ALREADY MET and proves nothing — assert the change (gameStateChanged) rather than a value that was already there. If a `fail` and an `until` land on the same frame, `fail` wins, because a PASS that coincides with a crash is exactly the false green this tool exists to prevent. Predicates: {kind:'gameStateChanged', path:'score', by:1} — a scalar in the game's own GameDebugProvider snapshot moved by at least that SIGNED delta from frame 0; the workhorse. {kind:'gameState', path:'lives', op:'lte', value:0} — absolute comparison. {kind:'nodeGone', name:'Player'} — a live node left the scene. {kind:'nodeMoved', name:'Player', axis:'x', max:0} — the node is displaced from where it stood at FRAME 0 (not from the previous frame, so a jitter never satisfies it); with `axis` the delta is signed, which is how you assert a DIRECTION, and a half-unit floor on the movement means standing still can never pass. {kind:'nodeAppeared', query:'Enemy2D'} — a spawn, read two ways at once: a name that was absent at frame 0 and is present now, or MORE LIVE NODES OF THAT TYPE than at frame 0 — and the type reading is the only one a POOLED spawn can satisfy, since a recycled enemy keeps its name. {kind:'nodeProperty', name:'ScoreLabel', path:'text', op:'contains', value:'10'} — a dot path into the live node's OWN properties (position.x, text, enabled, opacity): the readable evidence left when a game registers no debug provider, and the only honest way to assert engine state a game would never export. {kind:'axis', name:'Horizontal', op:'lt', value:-0.4} — the INPUT axis itself, read before any game logic touches it; assert it next to nodeMoved and 'the stick does not move the hero' splits into its two halves (the gesture never reached the control vs. the game never reads the axis) instead of shrugging. {kind:'newErrors'} — a script threw. {kind:'frames', n:300} — a plain budget; use it as the only `until` when you just want to run a while and then look at the report. {kind:'command', name:'shop.buy', args:{slot:2}} — that intent was dispatched through scene.commands during the run AND its handler ran; `args` is a subset match, and a dispatch that was refused, threw, or hit no registered handler is reported with which of those it was. {kind:'signal', name:'toggled', node:'MusicCheckbox'} — that node emitted the signal during the run; drop `node` to listen scene-wide, including on nodes spawned mid-run. The last two are how you prove a control is WIRED, and which one applies depends on the control: a button's handler dispatches an intent, so one tap plus `command` proves that wire once and every later scenario can dispatch instead of tapping. A stateful control (checkbox, inventory slot) is the other direction — the command flips the control and the effect hangs off its `toggled` signal — so `command` there proves nothing or proves a cycle; assert `signal`, which also cannot be satisfied by a tap that bounced off a disabled control. Both are windowed to the run, and input has to be sent with game_input BEFORE the call (see below), so that tap lands outside the window: `command` says exactly that ('it WAS dispatched N× before the run started') instead of reading as silence, while `signal` had no listener open yet and never heard it. `watch` adds node names whose appearance/disappearance shows up in `timeline`. Budgets: `maxFrames` (default 600 ≈ 10 s of game, cap 3600) and `maxWallMs` (default 20000) — a TIMEOUT reports, per unmet `until`, how close it got. AFTERWARDS: the game is left PAUSED on the outcome frame (`pauseOnOutcome`, default true) so you can inspect it with game_observe, and it STAYS paused — through focus changes and further observation — until you release it with game_time {paused: false}, send input (game_input resumes it, since input needs a running game), or play_restart. `time.leftPaused` in the report is read back from the runner, so it states what actually held rather than what was asked for. The time mode is ALWAYS restored, including on error paths. What game_run CANNOT do: it does not send input. A spec carrying `input` is refused, because in manual time no tick passes between a keydown and its keyup, so the game would never poll the key and every input-driven assertion would fail for a reason that has nothing to do with the game — send the input with game_input (which runs in realtime), THEN call game_run with only `until`/`fail` to judge what follows. That refusal is about THIS tool only: game_trace {mode:'record'} runs the same loop with the same predicates AND drives input, because its `feed` is denominated in FRAMES and delivered in the gap between two ticks rather than paced by a wall-clock timer. So when the thing you are judging needs input during the run, record a trace instead of splitting it into game_input + game_run — and you get a file you can replay after your next change. It also cannot see what the game does not expose: `gameState`/`gameStateChanged` need a registered GameDebugProvider and `command` needs the scene to expose a command registry; without either, the report says which is missing rather than reporting a plain false — fall back to nodeProperty (a HUD label's text, a button's enabled flag), nodeMoved, nodeAppeared, nodeGone, newErrors, frames or signal, none of which need the game to expose anything. TWO MODES SIT ON TOP OF THE SAME LOOP. `monkey` presses things AT RANDOM from a seeded stream and judges the game by invariants instead of by understanding it: it cannot tell you the game is fun or even winnable, but it finds a crash and a state the game cannot leave, which is the zero test worth running before any hand-written scenario. `monkey.seed` is REQUIRED — a finding that cannot be re-run is an anecdote, and the harness refuses to invent a seed nobody wrote down. It presses only what the scene actually offers (the controls game_controls lists, the intents the scene registers, the `Key_*`/`Action_*` names you pass in `monkey.actions`), so a run is never a tap into empty space that looks like it tested something. AN EMPTY INVENTORY IS NOT A PASS: if nothing was ever pressable, the outcome is `monkey-empty` and the verdict reads NOTHING TESTED even when an `until` fired, because 'the budget elapsed and no invariant broke' is exactly what a clean monkey run looks like. `monkey.log` says what it pressed and on which frame, and `monkey.lastActions` repeats the final presses — with the seed, that is the reproduction. `control` is the NEGATIVE CONTROL, and it exists because ANY pointer press raises `Action_Primary` in the runtime: a game reading that as 'shoot' shoots when you tap ANYWHERE, so 'I tapped the FIRE button and the gun fired' is passed by a completely dead button. The evidence is the pair — the same gesture, away from the control, must produce NOTHING. Pass {tap:{nx,ny}} (fractions of the canvas box) and after a PASSing run the game is put back to its starting state — the game's own reset(seed) when it exposes one, otherwise a scene restart, and `control.isolation.method` NAMES which, because a restart keeps whatever a script held in module state — and the gesture runs again with the same frame budget. THE VERDICT IS THREE-VALUED and `inconclusive` DOES NOT MEAN PASSED: it means the control could not be run meaningfully (nothing to isolate with, a precondition that did not come back, something the main run consumed for good, a shorter budget than the effect needed) and the binding remains unproven — `control.note` says which. A PASSing run whose assertions name an on-screen control and that carries no `control` block is marked WEAK on the verdict line for exactly that reason. ONE MORE SHAPE, and it replaces everything above when you have it: `routine` runs a STORED SCENARIO — `game_run {routine:'buy-item', args:{slot:2}}` — from design/tests/routines/<name>.json, which holds the steps AND the expectations somebody already got right. The routines that apply to the active scene are listed in your context; running one is one tool call instead of a `game_input` script plus a spec re-typed from memory, and it is the cheapest correct way to reach a known game state. Its steps are the game_input vocabulary (tap/key/keys/drag/hover/wait/invoke) plus {type:'command', name} for a registered intent, its `expect` is the SAME predicate objects as `until` but ANDed and judged once after the last step (so `frames`/`until` budgets do not apply), and the report reads `verdict` first: ROUTINE PASS / ROUTINE FAIL / ROUTINE MACRO (a routine with no `expect` asserts NOTHING — it is a macro, and the verdict says so instead of reading as a pass). Before anything executes, the routine's `uses` are checked against the running scene: a node that was renamed or removed answers ROUTINE STALE with the node's name and runs nothing, so you fix a name instead of debugging a scenario that failed halfway through. `routine` is mutually exclusive with `until`. EVERY run also writes its FULL protocol to design/tests/reports/<NNNN-subject-verdict-fNNN>.json and returns it as `artifact` {path, bytes, contains}: the undeduped timeline this reply caps at 20 entries, every observed node/property/axis delta (this reply carries none), the complete monkey log, and the outcome-frame state slice with the full baseline→outcome diff. It survives compaction, so when this reply is not enough read the FILE with fs_read {offset, limit} in slices rather than whole — it is pretty-printed for exactly that. The directory keeps the newest 20 reports and `artifact.pruned` names the ones this write deleted; with no project open `artifact.written` is false and its `reason` says the protocol was lost.",
        inputSchema: {
          type: 'object',
          properties: {
            until: {
              type: 'array',
              description:
                'Predicates whose arrival ends the run successfully (OR). At least one is required; use {kind:"frames", n:300} if you only want to run for a while.',
              items: GAME_ASSERTION_SCHEMA,
            },
            fail: {
              type: 'array',
              description:
                'Predicates whose arrival ends the run as a failure (OR). Wins over `until` on the same frame.',
              items: GAME_ASSERTION_SCHEMA,
            },
            watch: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Extra node names/ids whose appearance/disappearance is reported in the timeline. Max 8 tracked (names used by the predicates are added automatically).',
            },
            maxFrames: {
              type: 'integer',
              description: 'Frame budget (default 600, cap 3600). A run that hits it is a TIMEOUT.',
            },
            maxWallMs: {
              type: 'integer',
              description:
                'Wall-clock guard in ms (default 20000, cap 60000). The loop is CPU-bound, so this is the real runaway stop.',
            },
            fixedDeltaSec: {
              type: 'number',
              description: 'Tick length during the run (default 1/60). Must be > 0.',
            },
            pauseOnOutcome: {
              type: 'boolean',
              description:
                'Leave the game paused on the outcome frame so it can be inspected. Default true.',
            },
            monkey: {
              type: 'object',
              description:
                'Turn the run into a MONKEY run: random input from a seeded stream, judged by invariants instead of by an understanding of the game. It finds the two failures that need no understanding — a crash, and a state the game cannot leave. `seed` is REQUIRED (a finding nobody can re-run is an anecdote). What it presses comes only from what the scene actually offers: the interactive controls game_controls lists, the intents the scene registers, and the input actions you name in `actions` — never invented coordinates. AN EMPTY INVENTORY IS NOT A PASS: if nothing was ever pressable the outcome is `monkey-empty` and the verdict reads NOTHING TESTED, whatever `until` did. Read `monkey.log` (what it pressed, per frame) and `monkey.lastActions` (the presses right before it ended) — that is the reproduction, together with the seed.',
              properties: {
                seed: {
                  type: 'integer',
                  description:
                    'REQUIRED, non-negative. The whole decision stream comes from it, so the same seed against the same game replays the same presses — pick any number and put it in the bug report.',
                },
                actions: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    "Input action names the monkey may press on top of what the game declares: 'Key_ArrowLeft', 'Key_Space', 'Action_Primary'. A Key_* name is delivered as a REAL key event (the player's path); any other name is set on the input service directly, which exercises the game logic but proves nothing about a binding.",
                },
                everyFrames: {
                  type: 'integer',
                  description:
                    'Frames between two decisions (default 12, a quarter-second at 1/60).',
                },
                holdFrames: {
                  type: 'integer',
                  description:
                    'Frames an input action is held for (default 8) — long enough that a per-tick poll cannot miss it.',
                },
                maxActions: {
                  type: 'integer',
                  description: 'Hard cap on presses in one run (default 200).',
                },
                invariants: {
                  type: 'object',
                  description:
                    'What ends the run as a failure. Defaults: a new runtime error (the crash detector), a non-finite transform, and a watched node further than 10000 units from the origin (a blow-up, not a playfield edge); plus a score that never drops, when the game exposes one. Turn one off WITH A REASON rather than learning to ignore the report: {scorePath: false} for a counter that legitimately falls, {boundsRadius: false} for a game that teleports far. {stallFrames: 120} adds the stuck detector — nothing changed for that many frames while the monkey kept pressing — and is off by default because a menu is legitimately still.',
                  properties: {
                    newErrors: { type: 'boolean' },
                    finiteTransforms: { type: 'boolean' },
                    boundsRadius: {
                      description: 'Number of units, or false to disable.',
                    },
                    scorePath: {
                      description:
                        "Snapshot path of a score that must never drop, or false to disable. Defaults to 'score' when the provider has one.",
                    },
                    stallFrames: { type: 'integer' },
                  },
                  additionalProperties: false,
                },
              },
              required: ['seed'],
              additionalProperties: false,
            },
            control: {
              type: 'object',
              description:
                "The NEGATIVE CONTROL for a claim about an on-screen control (§5.4.4): the same gesture, aimed AWAY from it. Needed because ANY pointer press raises `Action_Primary` in the runtime, so a game that reads it as 'shoot' shoots when you tap anywhere — 'I tapped FIRE and it fired' passes with a completely dead button. Only the pair is evidence. After a PASSing main run the game is put back to its starting state (the game's own reset(seed) when it has one, otherwise a scene restart — the report NAMES which, they are not equivalent) and the gesture is run again with the same budget. THE RESULT IS THREE-VALUED and `inconclusive` IS NOT 'passed': it means the control could not be run meaningfully (no isolation, a precondition that did not come back, something the main run consumed, a shorter budget) and the binding is still unproven. Read `control.verdict` + `control.note`. Without this block a PASSing run whose assertions name an on-screen control is marked WEAK on the verdict line, for exactly this reason.",
              properties: {
                tap: {
                  type: 'object',
                  description:
                    'REQUIRED. Where the negative gesture lands: nx/ny in 0..1 OF THE CANVAS BOX (not client pixels, not world coordinates). Pick a point no control occupies — game_controls lists what is on screen; a "negative" gesture that quietly lands on another button reports the effect as unbound when it is not.',
                  properties: {
                    nx: { type: 'number' },
                    ny: { type: 'number' },
                  },
                  required: ['nx', 'ny'],
                  additionalProperties: false,
                },
                holdFrames: {
                  type: 'integer',
                  description:
                    'Frames the pointer stays down (default 40) — a real press, since a one-frame blip would not have operated a control either. The effect is still looked for over the whole frame budget, so an asynchronous reaction is not missed.',
                },
                seed: {
                  type: 'integer',
                  description:
                    "Seed handed to the game's reset(), so the control run replays the same randomness as the main run.",
                },
              },
              required: ['tap'],
              additionalProperties: false,
            },
            bot: {
              type: 'object',
              description:
                "Turn the run into a BOT run: a stored POLICY plays the game while the loop watches. This is the layer for gameplay whose decisions arrive faster than a tool call — surviving a runner, dodging, chasing, playing a level to its end. The policy is a file, design/tests/bots/<name>.ts, exporting {name, tick(bot)}; it is ticked once per logic tick and it ends the run itself with bot.done(pass, reason). Its API is ~10 methods: sensors nodes(query) / nearest(type, from) / raycast(from, dir) / gameState(), actuators press(action, frames?) / release(action) / tap(target) / axis(name, value) / moveTo(point), and the protocol log(event) / done(pass, reason). THE TIMING CONTRACT, which decides whether a policy works at all: tick() runs AFTER the game's own tick and every actuator lands on the NEXT tick — observe frame N, act for frame N+1, the same one-frame lag a human has. `channel` picks the actuator rung and DEFAULTS to 'physical-input', which drives synthesized pointer and key events, i.e. the whole player path; 'direct-action' sets axes and interactions directly, which exercises game LOGIC and proves NOTHING about a binding — a run on it CANNOT close an input check, and both the report and the verdict line say so. Read `verdict` first (BOT PASS / BOT FAIL / BOT ERROR / BOT NOTHING DRIVEN, with the reason, the frame and the channel), then `bot` {channel, frames, sent, refused, done, log}. Three report rules worth knowing before you read one: a refused actuator is never silent and never fatal — it becomes a log line naming what could not be reached, so a misspelled node reads as a refusal rather than as a game that ignores input; A BOT THAT DROVE NOTHING IS NOT A PASS (outcome `bot-idle`, same rule as monkey-empty), including when the policy claimed one; and a policy that THREW ends the run as `bot-error`, never as a game failure, with the fault named against the policy file — and it is deliberately NOT counted in `newErrors`, so a `fail: [{kind:'newErrors'}]` crash net cannot read your typo as a game crash. `until`/`fail` stay in force as the budget and the crash net — `until` defaults to the frame budget when you omit it, so pass `maxFrames` rather than writing the budget twice. Mutually exclusive with `monkey` (one is a written policy, the other is random input; a run driven by both could attribute a finding to neither). The FULL policy log — every line, not the head+tail this reply keeps — is in the run's artifact file.",
              properties: {
                name: {
                  type: 'string',
                  description:
                    'REQUIRED. The policy to run: the bare file name of a design/tests/bots/<name>.ts in this project. A name that does not exist is answered with the list of the ones that do.',
                },
                channel: {
                  type: 'string',
                  enum: ['physical-input', 'direct-action'],
                  description:
                    "Which actuator rung the policy drives on. 'physical-input' (default) synthesizes real pointer/key events — the only setting under which the run proves an input binding, and the one where axis(name, value) deflects the live on-screen joystick that writes the axis (refusing, by name, when no control does). 'direct-action' writes axes and calls interactions directly: use it to test game logic when the binding is already proven, and never to close an input check.",
                },
              },
              required: ['name'],
              additionalProperties: false,
            },
            routine: {
              type: 'string',
              description:
                'Run a STORED ROUTINE instead of a predicate spec: the name of a design/tests/routines/<name>.json in this project. One tool call replays a whole scenario (open the shop, buy, close) with its own assertions, so a repeated scenario costs one call instead of fifteen re-typed input steps. The routines available in the active scene are listed in your context under "Routines"; this is the ONLY argument they need, plus `args`. Mutually exclusive with `until` — a routine carries its own steps and expectations.',
            },
            args: {
              type: 'object',
              description:
                "Arguments for the routine's declared params, e.g. {slot: 2}. Every declared param is required and type-checked, and an undeclared one is refused rather than ignored (a typo'd parameter name would otherwise look like a routine that ran with defaults).",
            },
          },
          additionalProperties: false,
        },
        // Thin pass-through: `parseSpec` owns the payload's shape, and `args` is forwarded
        // untouched so a spec that carries `input` reaches the service's explanation instead
        // of being silently dropped here.
        handler: async args => {
          // Re-checked on every call, before either branch: a project can be opened
          // or closed between two runs, and the branch that writes the protocol is
          // the run itself, not this handler.
          this.ensureProtocolStore();
          if (args.routine !== undefined) {
            return this.gameRoutine(args);
          }
          // Same re-check for the policy library, and only when one is asked for: a
          // plain predicate run must not pay a store swap it never reads.
          if (args.bot !== undefined) {
            this.ensureBotStore();
          }
          const parsed = GameTestService.parseSpec(args);
          if ('error' in parsed) return { ok: false, error: parsed.error };
          return this.gameTest.run(parsed.spec);
        },
      },
      {
        name: 'game_trace',
        description:
          "Record the RUNNING game's input as a replayable trace, replay a stored one, or list what is stored (requires play mode). `mode` picks which. WHAT THIS IS FOR: record a trace BEFORE you change something, replay it AFTER, and see whether the outcome moved — a regression check between two increments of your own work. WHAT IT IS NOT: a determinism proof. REPLAY IS DIAGNOSTIC. The replay compares the OUTCOME (which predicate fired, on which frame) and the metrics, never frame-for-frame identity, and there are two comparison modes it tells you apart out loud. A recording during which the game never touched Math.random / Date.now / performance.now / a timer is CLEAN and is compared STRICTLY (equality). A recording that did touch them is stamped `nondeterministic` in the file, and then ONLY thresholds are checked (default: the outcome frame within 25% or 6 frames, numeric game-state scalars within 25% or 1) — `replay.strict` is false and `replay.verdict` says in words that an identical run was never promised, so a green replay of a marked trace can never be read as proof the run repeated. NEW RUNTIME ERRORS ARE NEVER FORGIVEN in either mode: more errors than the recording had is a divergence whatever the determinism looked like. Read `replay.verdict` first (REPLAY MATCH / REPLAY DIVERGED, with the mode in brackets), then `replay.diffs` (per-metric recorded→replayed, `within` says whether it passed, `soft:true` means reported but not counted), then `replay.notes` — that is where environment drift lands (a different tick length, a different scene, a resized canvas, a different runtime version, a game-state field that vanished from the debug provider). MODE record: `name` is required and becomes design/tests/<name>.trace.json in the project; the ordinary game_run spec (`until` required, plus `fail`/`watch`/`maxFrames`/…) drives and ends the run exactly as game_run does. `feed` is the input to record and replay: frame-denominated events, {frame, kind:'key', phase:'down'|'up', code:'ArrowLeft'} or {frame, kind:'pointer', phase:'down'|'move'|'up', nx, ny}. FRAMES, NOT MILLISECONDS — an event stamped frame N is delivered in the gap right before frame N runs, so 'hold left for 8 frames' means exactly that. This is the input path game_run does NOT have (it still refuses `input`, because a wall-clock hold delivers keydown and keyup with zero ticks in between in manual time); use it here instead. Pointer coordinates are nx/ny in 0..1 OF THE CANVAS BOX, not client pixels, so a moved or resized viewport does not send the replay somewhere else. `seed` records the RNG seed you started the game with, when you know it; without one (and without a `seed` scalar in the game's GameDebugProvider snapshot) the trace says so, since a replay then cannot start from the same random stream even in principle. Without `feed` the recording captures whatever else drives the game meanwhile. The reply carries `tracePath`, the stored `trace` (its `env` envelope, `events`, `outcome`, `metrics`, and `determinism` evidence) and the ordinary run report. MODE replay: `name` is the trace (bare name or full path). It replays the recorded events frame by frame and compares; the recorded tick length and frame count are reused unless you pass your own `until`/`fixedDeltaSec`, and `tolerance` overrides the thresholds. MODE list: the traces stored in this project. STORAGE: with a project open the traces are real files under design/tests/ and survive a reload; with no project open they live in memory for this editor session only.",
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['record', 'replay', 'list'],
              description:
                "Required. 'record' captures a run, 'replay' re-runs a stored trace and compares, 'list' enumerates them.",
            },
            name: {
              type: 'string',
              description:
                'Trace name (record: required, becomes design/tests/<name>.trace.json; replay: required, bare name or full path). Ignored by list.',
            },
            feed: {
              type: 'array',
              description:
                'record only. Frame-denominated input to drive and record. Each event is delivered in the gap immediately before its `frame` runs — this is the input delivery game_run cannot do. Omit to record whatever else is driving the game.',
              items: {
                type: 'object',
                properties: {
                  frame: {
                    type: 'integer',
                    description:
                      'The frame this event is delivered before. >= 1 (frame 1 is the first stepped frame).',
                  },
                  kind: { type: 'string', enum: ['key', 'pointer'] },
                  phase: {
                    type: 'string',
                    enum: ['down', 'move', 'up'],
                    description: "'down'/'up' for keys; 'down'/'move'/'up' for pointers.",
                  },
                  code: {
                    type: 'string',
                    description:
                      "kind:'key' — a KeyboardEvent.code such as 'ArrowLeft', 'Space', 'KeyW'.",
                  },
                  nx: {
                    type: 'number',
                    description:
                      "kind:'pointer' — X in 0..1 of the canvas box (NOT client pixels).",
                  },
                  ny: {
                    type: 'number',
                    description: "kind:'pointer' — Y in 0..1 of the canvas box.",
                  },
                  pointerId: {
                    type: 'integer',
                    description: 'Optional pointer id for multi-touch.',
                  },
                },
                required: ['frame', 'kind', 'phase'],
                additionalProperties: false,
              },
            },
            seed: {
              type: 'number',
              description:
                'record only. The RNG seed the game was started with, if you know it. Recorded in the envelope so a replay can say whether it started from the same random stream.',
            },
            until: {
              type: 'array',
              description:
                'Predicates that end the run successfully (OR). Required for record; optional for replay, where the recorded frame count is the default budget.',
              items: GAME_ASSERTION_SCHEMA,
            },
            fail: {
              type: 'array',
              description:
                'Predicates that end the run as a failure (OR). Wins over `until` on the same frame.',
              items: GAME_ASSERTION_SCHEMA,
            },
            watch: {
              type: 'array',
              items: { type: 'string' },
              description: 'Extra node names/ids reported in the timeline. Max 8 tracked.',
            },
            maxFrames: {
              type: 'integer',
              description: 'Frame budget (default 600, cap 3600). A run that hits it is a TIMEOUT.',
            },
            maxWallMs: { type: 'integer', description: 'Wall-clock guard in ms (default 20000).' },
            fixedDeltaSec: {
              type: 'number',
              description:
                "Tick length (default 1/60). On replay it defaults to the trace's own tick length — changing it makes frame counts incomparable and the verdict says so.",
            },
            pauseOnOutcome: {
              type: 'boolean',
              description:
                'Leave the game paused on the outcome frame so it can be inspected. Default true.',
            },
            tolerance: {
              type: 'object',
              description:
                'replay only. Overrides the comparison thresholds. Ignored where the comparison is strict (a clean trace with no environment drift is compared by equality).',
              properties: {
                framePct: {
                  type: 'number',
                  description: 'Relative slack on the outcome frame. Default 0.25.',
                },
                frameAbs: {
                  type: 'number',
                  description: 'Absolute slack on the outcome frame, in frames. Default 6.',
                },
                valuePct: {
                  type: 'number',
                  description: 'Relative slack on a numeric game-state scalar. Default 0.25.',
                },
                valueAbs: {
                  type: 'number',
                  description: 'Absolute slack on a numeric game-state scalar. Default 1.',
                },
              },
              additionalProperties: false,
            },
          },
          required: ['mode'],
          additionalProperties: false,
        },
        handler: args => this.gameTrace(args),
      },
      {
        name: 'read_logs',
        description: 'Recent editor log entries. Optionally only those after a timestamp (ms).',
        inputSchema: {
          type: 'object',
          properties: { since: { type: 'number', description: 'Epoch ms; return newer entries.' } },
          additionalProperties: false,
        },
        handler: args => this.readLogs(typeof args.since === 'number' ? args.since : undefined),
      },
      {
        name: 'read_errors',
        description: 'Recent captured runtime errors (console.error / window errors / rejections).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.readErrors(),
      },
      {
        name: 'viewport_screenshot',
        description:
          'Capture what is on screen as an image the model can see. While play mode is active this captures the RUNNING GAME canvas; otherwise the edit-mode editor viewport. Use it to visually check layout, colors, and placement. The user\'s editor camera may be zoomed/scrolled anywhere — pass `frame:"all"` to fit the whole scene, `frame:"selection"` to fit the current selection, or `nodeId` to zoom onto one node (add `isolate:true` to hide other content that overlaps/covers it). Framing is temporary and captures the EDITOR viewport (never the game) without moving the user\'s camera. The result reports `view` and, when framed, `framed`.',
        inputSchema: {
          type: 'object',
          properties: {
            maxSize: {
              type: 'integer',
              description: 'Longest-edge cap in px (default 1024).',
            },
            source: {
              type: 'string',
              enum: ['auto', 'game', 'editor'],
              description:
                'What to capture when NOT framing: "auto" (default) = the running game when play mode is active, else the editor viewport; "game" = the running game only (errors when not playing); "editor" = the edit-mode viewport even while playing. Any framing param forces the editor viewport.',
            },
            frame: {
              type: 'string',
              enum: ['current', 'all', 'selection', 'node'],
              description:
                'Aim the editor camera before capturing: "current" (default) = capture as-is; "all" = fit all scene content; "selection" = fit the selected node(s); "node" = fit the node given by nodeId. The user\'s camera is restored afterwards.',
            },
            nodeId: {
              type: 'string',
              description: 'Node to frame (from find_nodes / scene tree). Implies frame:"node".',
            },
            isolate: {
              type: 'boolean',
              description:
                'With a framed node/selection: hide every OTHER node so the target and its children are captured unobstructed on a clean background. Default false (surrounding context stays visible).',
            },
            padding: {
              type: 'number',
              description:
                'Margin around framed content as a fraction of its size, 0–1 (default ~0.15). Smaller = tighter crop.',
            },
            visualReason: {
              type: 'string',
              description:
                'Why LOOKING is required rather than reading state (art, layout, colour, overlap). Required while a gameplay change of yours is still unproven — there, verify with game_input/game_observe instead; a picture cannot show whether the score went up.',
            },
          },
          additionalProperties: false,
        },
        handler: args => this.viewportScreenshot(args),
      },
      {
        name: 'analyze_image',
        description:
          'Ask a vision-capable helper model to look at an image and answer a question — use this when YOUR model cannot see images (no vision). source is a project image path (res:// or relative), "viewport" (a fresh screenshot: the RUNNING GAME while play mode is active, else the editor viewport; "game"/"editor" force one), or a generated-image handle id. Ideal for extracting style tokens from a design reference before generating art, or QC-ing a generated sprite / the scene layout / the running game.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description:
                'A project image path, "viewport" (game when playing, else editor), "game", "editor", or a generation handle id.',
            },
            question: {
              type: 'string',
              description:
                'What to ask about the image. For verification, ask a yes/no checklist ("(1) exactly ONE subject, not a whole scene? (2) centered, not cut off?") — an open "describe it" answer reads as success even when the content is wrong. Defaults to a general description.',
            },
            visualReason: {
              type: 'string',
              description:
                'Why LOOKING is required rather than reading state (art, layout, colour, overlap). Required while a gameplay change of yours is still unproven — there, verify with game_input/game_observe instead; a picture cannot show whether the score went up.',
            },
          },
          required: ['source'],
          additionalProperties: false,
        },
        handler: args => this.analyzeImage(args),
      },
      {
        name: 'generate_asset',
        description:
          "Generate an image with the project's AI image provider (uses the user's saved image key), post-process it to be game-ready (background removal, trim to content, downscale), and save it into the project. For schematic, placeholder or UI graphics (icons, buttons, bars, arrows, flat props, blockout art) prefer providerId 'svg-llm': it draws with the agent's own LLM as SVG and bakes it locally, so you get the EXACT width×height you ask for, real transparency with no background-removal pass, and it costs a text completion instead of a metered image. Use a raster model (the default) for painterly, textured or photographic art. For sprites/icons set transparent:true and describe a SINGLE centered subject on a plain background, carrying the art style as prompt keywords (see the references warning before passing screenshots). Returns the saved path, original vs saved size, and a small preview you can see.",
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            providerId: {
              type: 'string',
              description:
                "Override the configured image provider for this call. 'svg-llm' = vector art via the agent's LLM (exact size, real alpha, fast and cheap — best for placeholder/UI/schematic graphics). Omit to use the user's configured provider.",
            },
            width: {
              type: 'integer',
              description:
                "Exact output width in px. Honoured only by providers that can deliver it (providerId 'svg-llm'); raster models ignore it and answer with their own aspect-ratio grid.",
            },
            height: {
              type: 'integer',
              description: 'Exact output height in px (see width). Defaults to width when omitted.',
            },
            name: {
              type: 'string',
              description:
                'Target file name or relative path (e.g. "sprites/car.png"). Projects use a flat layout — one folder per asset type at the project root (`sprites/`, `models/`, `audio/`, …), never nested under `assets/`. A bare name is placed in the matching type folder automatically — at the IDEA stage it goes to `references/` instead, since that is the folder the references column lists; the extension is added when missing.',
            },
            transparent: {
              type: 'boolean',
              description:
                'Request a transparent background from the image provider (recommended for sprites/icons).',
            },
            postProcess: {
              type: 'string',
              enum: ['sprite', 'icon', 'texture', 'none'],
              description:
                'Post-processing preset before saving. sprite = remove background + trim to content + downscale. icon = sprite + pad to a centered square (aligns icon grids). texture = downscale only, keep the background (tiles, photos, backgrounds). none = save the raw generation untouched. Default: transparent→sprite, otherwise→texture.',
            },
            maxSize: {
              type: 'integer',
              description:
                'Longest-edge downscale applied on save (px); omit to use the project default.',
            },
            references: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Project image paths used as style references. WARNING: the generator copies composition, not just style — a full gameplay screenshot as reference for a single-object sprite tends to reproduce the whole scene. For single-object sprites/icons prefer style keywords in the prompt and omit this; pass references when you want a scene-like result (backgrounds, mockups).',
            },
            rotate: {
              type: 'integer',
              enum: [90, 180, 270],
              description:
                'Rotate the result clockwise by this many degrees AFTER post-processing. Use to fix a top-down sprite that came out sideways (e.g. a car whose nose points left/down instead of up) without regenerating.',
            },
            flip: {
              type: 'string',
              enum: ['horizontal', 'vertical'],
              description: 'Mirror the result horizontally or vertically (applied after rotate).',
            },
            role: {
              type: 'string',
              enum: ['style', 'content', 'layout', 'style-candidate'],
              description:
                'What the picture is FOR, recorded in the references index (only for files landing under `references/`). Pass \'style-candidate\' for every image of a moodboard turn: the column then offers the user a one-click "make it the style", which measures the palette and writes design/style.md without spending a turn. Omit for ordinary generation — the role is guessed from the name.',
            },
          },
          required: ['prompt', 'name'],
          additionalProperties: false,
        },
        handler: args => this.generateAsset(args),
      },
      {
        name: 'generate_sfx',
        description:
          "Generate a named, game-specific PROTOTYPE sound effect and save it as a WAV under `res://sfx/`. Your own LLM writes a procedural `soundline` recipe, a validator checks it against the physics of its category, and it is rendered locally — one text completion, no metered audio API, no key of its own. THE LADDER, in order: (1) for instant feedback sounds that need no file at all, call `scene.audio.sfx(preset)` from a script — the nine built-in presets are 'tap', 'score', 'bounce', 'explosion', 'powerup', 'win', 'lose', 'laser', 'tick'; zero cost, plays on the first frame; (2) when a sound needs its OWN character (a specific weapon, a specific pickup, a UI voice for this game), use this tool — the WAV it saves is a placeholder meant to be REPLACED by a sound designer's file later, keeping the same path; (3) final audio comes from outside and just overwrites the file. NEVER use this for music, ambience beds or any voice — procedural synthesis cannot do them, and the pipeline will decline (you get `ok: true` with `outcome: \"refused\"` and an explanation; that is a normal answer, not a failure to retry). Returns the saved path, duration, peak, validator warnings, and the `soundline` recipe — keep that recipe: passing it back with `feedback` edits the sound deterministically (\"duller, 100 ms shorter\") instead of re-rolling a different one.",
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'What the sound is, in a few words — "crisp coin pickup", "small grenade blast", "soft menu hover tick". Say the material and the action; the category contract does the rest. In edit mode this is the change being asked for.',
            },
            name: {
              type: 'string',
              description: `File name for the WAV (e.g. "coin_pickup"). A bare name lands in \`${SFX_DIRECTORY}/\`; the .wav extension is added when missing. Omit to use the name the recipe gives itself.`,
            },
            soundline: {
              type: 'string',
              description:
                'The recipe returned by a previous call, to EDIT rather than redesign. Pass it together with `feedback`: the model changes only what was asked for, so the sound stays recognisably the same one.',
            },
            feedback: {
              type: 'string',
              description:
                'The change to make to `soundline` ("less metallic", "100 ms shorter"). Used instead of `prompt` when both are present.',
            },
            maxIterations: {
              type: 'integer',
              description: `Trips through the model, including the first (default 4, max ${MAX_SFX_ITERATIONS}). Raise it only when a sound keeps failing validation.`,
            },
            save: {
              type: 'boolean',
              description:
                'Write the WAV into the project. Default true. Pass false to audition a recipe and iterate on it without leaving files behind.',
            },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
        handler: args => this.generateSfx(args),
      },
      {
        name: 'process_asset',
        description:
          'Post-process an EXISTING project image: background removal, trim to content, downscale, re-encode, and optional rotate/flip. Use it to fix an image that has an unwanted background, is too large, is not cropped tight, or is mis-oriented (e.g. a previously generated sprite or a user import). Presets match generate_asset: sprite / icon / texture / none. Pass rotate (90/180/270) and/or flip (horizontal/vertical) to re-orient without regenerating. Writes back to `path` unless `name` is given. Returns the saved path and a preview.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Project image to read (res:// or project-relative).',
            },
            preset: {
              type: 'string',
              enum: ['sprite', 'icon', 'texture', 'none'],
              description:
                'Processing preset (see generate_asset). Defaults to sprite (remove background + trim + downscale).',
            },
            name: {
              type: 'string',
              description: 'Optional output path; defaults to overwriting `path`.',
            },
            maxSize: {
              type: 'integer',
              description: 'Longest-edge cap in px; omit to use the project default.',
            },
            rotate: {
              type: 'integer',
              enum: [90, 180, 270],
              description:
                'Rotate clockwise by this many degrees after the preset runs — fixes a sideways sprite (e.g. a top-down car whose nose points the wrong way) without regenerating.',
            },
            flip: {
              type: 'string',
              enum: ['horizontal', 'vertical'],
              description: 'Mirror horizontally or vertically (applied after rotate).',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        handler: args => this.processAsset(args),
      },
      {
        name: 'generate_model_3d',
        description:
          'Reconstruct a 3D model PROCEDURALLY BY CODE from a reference image (Model Lab) — this is NOT neural image-to-mesh: a codegen model writes a procedural Three.js factory. It runs an autonomous loop (assess the image → design a sculpt spec → build the model in locked passes → render each pass and have a vision model score it against the reference), saves a self-contained `.glb` into the project (plus `.sculpt.json` / `.factory.ts` siblings so it can be regenerated), and returns the saved path, per-pass fidelity scores, and a preview image when available. For HARD-SURFACE objects only (props, vehicles, furniture, buildings) — organic characters are not supported. Slow and token-heavy (many LLM calls): use it deliberately, not for quick iteration.',
        inputSchema: {
          type: 'object',
          properties: {
            reference: {
              type: 'string',
              description:
                'Project asset path to the reference image (res:// or project-relative). Required.',
            },
            name: {
              type: 'string',
              description:
                'Target GLB path/name, e.g. "models/crate.glb"; the .glb extension is added when missing. Required.',
            },
            prompt: {
              type: 'string',
              description: 'Optional extra intent to steer the reconstruction.',
            },
            complexity: {
              type: 'string',
              enum: ['simple', 'moderate', 'complex'],
              description: 'How involved the subject is (default "moderate").',
            },
            mode: {
              type: 'string',
              enum: ['fast', 'quality'],
              description: 'fast = fewer passes; quality = the full pass pipeline.',
            },
          },
          required: ['reference', 'name'],
          additionalProperties: false,
        },
        handler: args => this.generateModel3d(args),
      },
      {
        name: 'generate_scene_3d',
        description:
          "Generate a whole `.pix3scene` LEVEL from a text brief using the project's EXISTING assets as the palette (Model Lab Scene lane) — this writes a declarative scene YAML validated by the runtime scene loader; it is NOT a live edit of the open scene. It runs an autonomous loop (scan the project inventory → plan a LevelSpec → build the YAML in locked passes → render each pass and have a vision model score it against the brief), saves a `.pix3scene` into the project, and returns the saved path, the level's zones, per-pass fidelity scores, any palette gaps (assets the brief wanted but the inventory lacks — a handoff to generate_model_3d / generate_asset), and a preview image when available. Optionally EDITS an existing scene when `baseScene` is given. Slow and token-heavy (many LLM calls): use it deliberately, not for quick iteration.",
        inputSchema: {
          type: 'object',
          properties: {
            brief: {
              type: 'string',
              description: 'What level to build, in plain language. Required.',
            },
            name: {
              type: 'string',
              description:
                'Target `.pix3scene` path/name, e.g. "scenes/arena.pix3scene"; the extension is added when missing. Required.',
            },
            references: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Project asset paths (res:// or project-relative) to concept/mood images that guide the look. Optional; best-effort (a path that fails to load is skipped).',
            },
            baseScene: {
              type: 'string',
              description:
                'A res:// or project-relative path to an existing `.pix3scene` to EDIT instead of authoring a fresh one. Optional.',
            },
            mode: {
              type: 'string',
              enum: ['fast', 'quality'],
              description: 'fast = fewer passes; quality = the full pass pipeline.',
            },
          },
          required: ['brief', 'name'],
          additionalProperties: false,
        },
        handler: args => this.generateScene3d(args),
      },
    ];
  }

  // -- skills ----------------------------------------------------------------

  private readSkill(args: Record<string, unknown>): Record<string, unknown> {
    const id = asString(args.id);
    const section = typeof args.section === 'string' ? args.section : undefined;
    const content = this.skills.read(id, section);
    if (content === null) {
      const available = this.skills
        .list()
        .map(skill => skill.id)
        .join(', ');
      // A section miss must show what actually exists — otherwise models retry the same
      // invented heading verbatim, forever (observed in eval runs).
      const sections = section ? this.skills.sections(id) : [];
      return {
        ok: false,
        error: section
          ? sections.length > 0
            ? `No section matching "${section}" in skill "${id}". Do NOT retry this name. Existing sections: ${sections.map(s => `"${s}"`).join(', ')} — pick one of these, or omit section to read the whole skill.`
            : `Unknown skill "${id}". Available skills: ${available}.`
          : `Unknown skill "${id}". Available: ${available}.`,
      };
    }
    return { ok: true, id, section: section ?? null, content };
  }

  // -- advisor -----------------------------------------------------------------

  private async askAdvisor(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const question = asString(args.question);
    const context = typeof args.context === 'string' ? args.context : '';
    // Ground the advisor with the one thing the caller always forgets to mention: where it is.
    const activeSceneId = appState.scenes.activeSceneId;
    const activePath = activeSceneId
      ? (appState.scenes.descriptors[activeSceneId]?.filePath ?? null)
      : null;
    const header = `Pix3 project "${appState.project.projectName ?? 'Untitled'}"${
      activePath ? `, active scene: ${activePath}` : ''
    }`;
    try {
      const answer = await this.advisor.consult(question, `${header}\n\n${context}`);
      const info = await this.advisor.describeAdvisor();
      return {
        ok: true,
        answer,
        advisor: info ? `${info.providerLabel} · ${info.modelLabel ?? info.modelId}` : null,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -- ask the user ------------------------------------------------------------

  /**
   * Echo the question back as a structured result. The tool itself does nothing else — the real
   * behaviour lives in {@link AgentChatService}, which ends the turn on this call and surfaces the
   * question (with its options as chips) to the chat panel. Keeping the handler inert means an
   * `ask_user` call in a non-chat context (a spec, a replayed history) is harmless.
   */
  private askUser(args: Record<string, unknown>): Record<string, unknown> {
    const question = asString(args.question).trim();
    if (!question) {
      return { ok: false, error: 'ask_user needs a `question`.' };
    }
    const options = Array.isArray(args.options)
      ? args.options
          .filter((option): option is string => typeof option === 'string')
          .map(option => option.trim())
          .filter(option => option.length > 0)
      : [];
    const allowFreeform = args.allowFreeform !== false;
    return {
      ok: true,
      asked: true,
      question,
      options,
      allowFreeform,
      note: 'The question was shown to the user and your turn ends here. Their answer arrives as the next user message — do not call more tools.',
    };
  }

  /**
   * Append one settled fork to `design/decisions.md`.
   *
   * Deterministic on purpose — a tool rather than "write the line yourself". Models append to a
   * markdown log with `str_replace` by rewriting its tail, which loses earlier entries, and the
   * one-line format stops being stable the moment two turns each invent their own. Both failures
   * are silent: the file still looks like a decision log, and the planner reads the damage.
   *
   * {@link AgentChatService} calls this same handler for every `ask_user` answer, so code and model
   * write through one path and cannot disagree about the format.
   */
  async recordDecision(entry: {
    question: string;
    choice: string;
    reason?: string;
    alternatives?: readonly string[];
  }): Promise<
    | { ok: true; path: string; line: string; replaced: boolean; note?: string }
    | { ok: false; error: string }
  > {
    const question = entry.question.trim();
    const choice = entry.choice.trim();
    if (!question || !choice) {
      return { ok: false, error: 'record_decision needs both a `question` and a `choice`.' };
    }
    let source = '';
    try {
      source = await this.storage.readTextFile(DECISIONS_PATH);
    } catch {
      // No log yet (a project that predates the idea stage) — appendDecision seeds the heading.
      await this.ensureParentDirectories(DECISIONS_PATH);
    }
    const { text, line, replaced } = appendDecision(source, {
      question,
      choice,
      reason: entry.reason?.trim() ?? '',
      rejected: entry.alternatives ?? [],
    });
    await this.storage.writeTextFile(DECISIONS_PATH, text);
    return {
      ok: true,
      path: DECISIONS_PATH,
      line,
      replaced,
      ...(replaced
        ? {
            note: 'This fork was already recorded, so the earlier line was replaced rather than duplicated.',
          }
        : {}),
    };
  }

  // -- introspection ---------------------------------------------------------

  /**
   * Scene-dependent tools auto-open the project scene when none is active. The editor can end up
   * scene-less mid-session (e.g. a failed reload of an externally rewritten scene file closes the
   * tab), and the agent has no tool to open scenes — models then flail with fs_write rewrites and
   * forbidden commands (observed in eval runs). Which scene to reach for is not this class's
   * decision to make twice: `resolveGameplayScenePath` is the same order the play commands use
   * (gameplay scene → any known scene → the shipped `scenes/main.pix3scene` path), and it
   * deliberately leaves the configured entry scene out — on a recipe project that value is the
   * MENU, and recovering onto the menu silently redirects every subsequent agent edit into it.
   */
  private async ensureActiveScene(): Promise<void> {
    if (this.sceneManager.getActiveSceneGraph()) {
      return;
    }
    const raw = resolveGameplayScenePath(appState);
    const path = raw.startsWith('res://') ? raw : `res://${raw.replace(/^res:\/\//i, '')}`;
    await this.editorTabs.focusOrOpenScene(path);
    // The scene loads asynchronously behind the tab activation; give it a few seconds.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (this.sceneManager.getActiveSceneGraph()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(
      `No scene is open and auto-opening "${path}" did not load one. The scene file is probably invalid — fs_read it and check the YAML.`
    );
  }

  private sceneTree(
    maxDepth: number
  ): (NodeDTO & { sceneVersion: string; staleWhilePlaying?: string }) | null {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) return null;
    const roots = graph.rootNodes.filter((n): n is NodeBase => n instanceof NodeBase);
    const tree: NodeDTO = {
      nodeId: '<scene-root>',
      type: 'SceneRoot',
      name: graph.description ?? 'Scene',
      visible: true,
      transform: { position: null, rotation: null, scale: null },
      groups: [],
      componentCount: 0,
      properties: null,
      children: roots.map(root => nodeToDTO(root, maxDepth - 1)),
    };
    return {
      ...tree,
      sceneVersion: graph.version,
      ...this.playingElsewhereNote(roots),
      // Authoring surface: performance advice belongs here, where it can be acted on.
      ...renderabilityNote(roots, { includeAdvice: true }),
    };
  }

  /**
   * This tool reads the EDITOR's authored graph. Once the game navigates (`scene.changeScene`, a
   * menu button), the running scene is a different one — and a tree that quietly describes the
   * scene you are NOT looking at is worse than no tree: paired with a mis-read game_input verdict
   * it led to the conclusion that a working scene transition had done nothing.
   */
  private playingElsewhereNote(
    authoredRoots: readonly NodeBase[]
  ): { staleWhilePlaying?: string } | Record<string, never> {
    if (!appState.ui.isPlaying) return {};
    const liveRoots = this.playSession.getActiveRuntime()?.runner.getLiveRootNodes() ?? [];
    if (liveRoots.length === 0) return {};
    const authoredIds = new Set(authoredRoots.map(root => root.nodeId));
    if (liveRoots.some(root => authoredIds.has(root.nodeId))) return {};
    return {
      staleWhilePlaying: `The RUNNING game is in a different scene (live roots: ${liveRoots
        .map(root => root.name || root.nodeId)
        .join(
          ', '
        )}). This tree is the editor's open scene — the game navigated away from it. Use game_observe for what is actually on screen.`,
    };
  }

  private nodeInspect(
    nodeId: string
  ): (NodeDTO & { components?: unknown[]; authoredWhilePlaying?: string }) | null {
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) return null;
    const dto: NodeDTO & { components?: unknown[]; authoredWhilePlaying?: string } = nodeToDTO(
      node,
      0
    );
    // Unlike scene_tree's `staleWhilePlaying`, this fires even when the running game is in the SAME
    // scene, because that is the case that misleads: the authored label of a result overlay reads
    // "YOU WIN" for the whole run while the live node says whatever the rules script last wrote.
    // Measured: a verification pass "confirmed" a win text it had never actually observed.
    if (appState.ui.isPlaying) {
      dto.authoredWhilePlaying =
        'The game is PLAYING and these are the AUTHORED values — the live node may differ (scripts mutate labels, transforms, textures at runtime). Read the running state with game_observe.';
    }
    // Enrich each component with the explicit ids the mutation tools need (componentId + type),
    // which the generic ComponentDTO only exposes ambiguously as `scriptId`.
    dto.components = node.components.map((c, i) => ({
      ...componentToDTO(c, i),
      componentId: c.id,
      componentType: c.type,
      enabled: c.enabled,
    }));
    return dto;
  }

  private findNodes(text: string): NodeSummary[] {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) return [];
    const needle = text.toLowerCase();
    const matches: NodeSummary[] = [];
    for (const node of graph.nodeMap.values()) {
      if (node.name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle)) {
        matches.push({ nodeId: node.nodeId, type: node.type, name: node.name });
      }
    }
    return matches;
  }

  private getSelection(): {
    nodeIds: string[];
    primaryNodeId: string | null;
    hoveredNodeId: string | null;
  } {
    return {
      nodeIds: [...appState.selection.nodeIds],
      primaryNodeId: appState.selection.primaryNodeId,
      hoveredNodeId: appState.selection.hoveredNodeId,
    };
  }

  // -- mutation --------------------------------------------------------------

  private async setProperty(
    nodeId: string,
    propertyPath: string,
    value: unknown,
    temporary = false
  ): Promise<{ ok: boolean; error?: string; temporaryNote?: string }> {
    // Guard the value SHAPE before dispatch. The schema setters assume an exact shape (a vector2
    // wants {x,y}); a wrong shape like the array [x,y] slips straight through as a silent no-op,
    // which misleads models into concluding "the engine ignores this property" (observed in eval:
    // waypoints set with [x,y] stayed at 0,0 and the model then hardcoded them in script).
    const coerced = this.coercePropertyValue(nodeId, propertyPath, value);
    if ('error' in coerced) {
      return { ok: false, error: coerced.error };
    }
    // Journal BEFORE the write — after it the original value is gone.
    if (temporary) {
      this.recordTemporaryNodeEdit(nodeId, propertyPath);
    }
    const ok = await this.dispatcher.execute(
      new UpdateObjectPropertyCommand({ nodeId, propertyPath, value: coerced.value })
    );
    if (ok) {
      await this.saveActiveSceneBestEffort();
      return temporary
        ? {
            ok,
            temporaryNote:
              'Journalled as temporary — it is put back automatically when this turn ends, even if the turn is force-stopped.',
          }
        : { ok };
    }
    // A bare `{ok:false}` teaches the model nothing, so it guesses — measured: it retried the same
    // call, then went looking for a scene file to hand-edit. Say which of the two things went
    // wrong (no such node, or the schema has no such property) and list what the node does have.
    return { ok: false, error: this.explainSetPropertyFailure(nodeId, propertyPath) };
  }

  /**
   * Property names a node actually exposes: its live `properties` bag plus the transform fields
   * every node has. Used only to make a failed set_property self-explanatory.
   */
  private describeNodeProperties(node: NodeBase): string[] {
    const own =
      node.properties && typeof node.properties === 'object' ? Object.keys(node.properties) : [];
    return [...new Set([...own, 'position', 'rotation', 'scale', 'visible', 'name'])];
  }

  /** Why an UpdateObjectPropertyCommand refused: unknown node, or a property the schema lacks. */
  private explainSetPropertyFailure(nodeId: string, propertyPath: string): string {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) {
      return 'No active scene — open or play a scene first.';
    }
    const node = graph.nodeMap.get(nodeId);
    if (!node) {
      return `No node "${nodeId}" in the active scene. Use scene_tree or find_nodes to get a real nodeId (ids are case-sensitive).`;
    }
    const root = propertyPath.split('.')[0];
    const available = this.describeNodeProperties(node);
    if (available.length > 0 && !available.includes(root)) {
      return `"${node.name}" (${node.type}) has no property "${propertyPath}". Its schema exposes: ${available.join(', ')}. If the value is driven every frame by a script/component, configure the component with set_component_property instead.`;
    }
    return `The editor refused to set "${propertyPath}" on "${node.name}" (${node.type}). Check the value shape with node_inspect — a vector wants {"x":…,"y":…}, a rotation a number in radians — or configure the owning component with set_component_property.`;
  }

  private async createNode(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (appState.project.status !== 'ready') {
      return { ok: false, error: 'No project is open — cannot create a node.' };
    }
    await this.ensureActiveScene();
    if (!this.sceneManager.getActiveSceneGraph()) {
      return { ok: false, error: 'No active scene — open a scene first.' };
    }
    const nodeType = asString(args.nodeType);
    const options: CreateNodeOptions = {
      name: typeof args.name === 'string' ? args.name : undefined,
      parentNodeId: typeof args.parentId === 'string' ? args.parentId : undefined,
      position: parseVector2(args.position),
      position3: parseVector3(args.position3),
      width: typeof args.width === 'number' ? args.width : undefined,
      height: typeof args.height === 'number' ? args.height : undefined,
      texturePath: typeof args.texturePath === 'string' ? args.texturePath : undefined,
      text: typeof args.text === 'string' ? args.text : undefined,
      src: typeof args.src === 'string' ? args.src : undefined,
    };
    const command = buildCreateNodeCommand(nodeType, options);
    if (!command) {
      return {
        ok: false,
        error: `Cannot create node type "${nodeType}". Creatable types: ${CREATABLE_NODE_TYPES.join(', ')}.`,
      };
    }
    const didMutate = await this.dispatcher.execute(command);
    if (!didMutate) {
      return {
        ok: false,
        error: `Creating a ${nodeType} did not mutate the scene (blocked by preconditions?).`,
      };
    }
    // The create operation selects the new node — that's how its id surfaces to callers (see
    // getCreatedNodeIdFromSelection in scene-command-utils).
    const nodeId = appState.selection.primaryNodeId ?? '';

    // Apply any extra schema properties the create params didn't cover (color, opacity, label, …).
    const propertyErrors: Record<string, string> = {};
    const props = args.properties;
    if (nodeId && props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [path, value] of Object.entries(props as Record<string, unknown>)) {
        const result = await this.setProperty(nodeId, path, value);
        if (!result.ok) {
          propertyErrors[path] = result.error ?? 'property could not be set';
        }
      }
    }
    await this.saveActiveSceneBestEffort();

    const graph = this.sceneManager.getActiveSceneGraph();
    const node = graph?.nodeMap.get(nodeId);
    // Names are how the agent addresses nodes at runtime (game_input/game_observe resolve by name),
    // so a fresh duplicate makes every later reference ambiguous. Observed in a dogfooding run: the
    // agent created a second `cell-0`, changed its mind, and left the orphan wired to nothing.
    // Warn instead of refusing — duplicate names are legal, and the create already happened.
    const createdName = node?.name ?? '';
    const duplicateNodeIds = createdName
      ? [...(graph?.nodeMap.values() ?? [])]
          .filter(
            other =>
              other instanceof NodeBase && other.name === createdName && other.nodeId !== nodeId
          )
          .map(other => (other as NodeBase).nodeId)
      : [];
    return {
      ok: true,
      nodeId,
      nodeType: node?.type ?? nodeType,
      name: node?.name,
      ...(Object.keys(propertyErrors).length > 0 ? { propertyErrors } : {}),
      ...(duplicateNodeIds.length > 0
        ? {
            duplicateNameNodeIds: duplicateNodeIds,
            warning: `The scene already had ${duplicateNodeIds.length} other node(s) named "${createdName}". Addressing by name is now ambiguous — rename this one with set_property, or delete it if you created it by mistake.`,
          }
        : {}),
    };
  }

  private async convertNodeType(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (appState.project.status !== 'ready') {
      return { ok: false, error: 'No project is open — cannot convert a node.' };
    }
    await this.ensureActiveScene();
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) {
      return { ok: false, error: 'No active scene — open a scene first.' };
    }
    const nodeId = asString(args.nodeId);
    const toType = asString(args.toType);
    const source = graph.nodeMap.get(nodeId);
    if (!(source instanceof NodeBase)) {
      return { ok: false, error: `Node "${nodeId}" not found in the active scene.` };
    }
    if (source.type === toType) {
      return { ok: false, error: `Node "${nodeId}" is already a ${toType}.` };
    }
    const props = args.properties;
    const properties =
      props && typeof props === 'object' && !Array.isArray(props)
        ? (props as Record<string, unknown>)
        : undefined;

    const didMutate = await this.dispatcher.execute(
      new ConvertNodeTypeCommand({ nodeId, toType, properties })
    );
    if (!didMutate) {
      return {
        ok: false,
        error: `Could not convert "${nodeId}" to "${toType}" — the target type may be unknown or the node is a prefab instance. Common target types: ${CREATABLE_NODE_TYPES.join(', ')}.`,
      };
    }
    await this.saveActiveSceneBestEffort();

    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    return { ok: true, nodeId, nodeType: node?.type ?? toType, name: node?.name };
  }

  /**
   * Move a node to a new parent and/or change its sibling order (z-order for 2D), via the
   * ReparentNodeCommand gateway so it is undoable. The insertion index is computed against the
   * target parent's children EXCLUDING the moved node — matching ReparentNodeOperation, which
   * detaches the node before splicing it back in (so index 0 = first/behind, siblings.length =
   * last/on-top for 2D paint order).
   */
  private async moveNode(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (appState.project.status !== 'ready') {
      return { ok: false, error: 'No project is open — cannot move a node.' };
    }
    await this.ensureActiveScene();
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) {
      return { ok: false, error: 'No active scene — open a scene first.' };
    }
    const nodeId = asString(args.nodeId);
    const node = graph.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) {
      return { ok: false, error: `Node "${nodeId}" not found in the active scene.` };
    }

    const currentParentId = node.parentNode instanceof NodeBase ? node.parentNode.nodeId : null;

    // Resolve the target parent: toRoot wins, then an explicit parentId, else keep the current one.
    let targetParentId: string | null;
    if (args.toRoot === true) {
      targetParentId = null;
    } else if (typeof args.parentId === 'string' && args.parentId.length > 0) {
      targetParentId = args.parentId;
      const parent = graph.nodeMap.get(targetParentId);
      if (!(parent instanceof NodeBase)) {
        return { ok: false, error: `Parent "${targetParentId}" not found in the active scene.` };
      }
    } else {
      targetParentId = currentParentId;
    }

    // Siblings of the target parent, EXCLUDING the node itself (the index space the operation uses).
    const targetChildrenRaw =
      targetParentId === null
        ? graph.rootNodes
        : (graph.nodeMap.get(targetParentId) as NodeBase).children;
    const siblings = targetChildrenRaw.filter(
      (child): child is NodeBase => child instanceof NodeBase && child.nodeId !== nodeId
    );

    // Resolve the insertion position. 0 = behind/first, siblings.length = on-top/last (2D order).
    const placement = typeof args.placement === 'string' ? args.placement : undefined;
    const beforeId = typeof args.beforeSiblingId === 'string' ? args.beforeSiblingId : undefined;
    const afterId = typeof args.afterSiblingId === 'string' ? args.afterSiblingId : undefined;
    let index: number;
    if (beforeId !== undefined) {
      const at = siblings.findIndex(s => s.nodeId === beforeId);
      if (at === -1) {
        return {
          ok: false,
          error: `beforeSiblingId "${beforeId}" is not a child of the target parent.`,
        };
      }
      index = at;
    } else if (afterId !== undefined) {
      const at = siblings.findIndex(s => s.nodeId === afterId);
      if (at === -1) {
        return {
          ok: false,
          error: `afterSiblingId "${afterId}" is not a child of the target parent.`,
        };
      }
      index = at + 1;
    } else if (placement === 'back') {
      index = 0;
    } else if (placement === 'front') {
      index = siblings.length;
    } else if (args.index !== undefined) {
      index = Math.max(0, Math.min(asInt(args.index, siblings.length), siblings.length));
    } else {
      index = siblings.length; // default: append = on top for 2D
    }

    const didMutate = await this.dispatcher.execute(
      new ReparentNodeCommand({ nodeId, newParentId: targetParentId, newIndex: index })
    );
    if (!didMutate) {
      return {
        ok: false,
        error:
          'The move did not apply — the target is invalid (e.g. moving a node into its own descendant, or a parent that cannot accept this node type).',
      };
    }
    await this.saveActiveSceneBestEffort();

    // Report the resulting order so the caller can verify z-order without another round-trip.
    const freshGraph = this.sceneManager.getActiveSceneGraph();
    const finalChildren =
      (targetParentId === null
        ? freshGraph?.rootNodes
        : (freshGraph?.nodeMap.get(targetParentId) as NodeBase | undefined)?.children) ?? [];
    const siblingOrder = finalChildren
      .filter((c): c is NodeBase => c instanceof NodeBase)
      .map(c => ({ nodeId: c.nodeId, name: c.name }));
    return {
      ok: true,
      nodeId,
      parentId: targetParentId,
      index: siblingOrder.findIndex(o => o.nodeId === nodeId),
      siblingOrder,
    };
  }

  /**
   * Coerce/validate an agent-supplied property value against the node's schema. Only vector types
   * are touched (the observed silent-no-op class): an array of the right arity is coerced to the
   * {x,y[,z[,w]]} object the setter expects, an already-valid object passes through, and any other
   * shape returns an error naming the expected form instead of a mystery no-op. Every other
   * property type passes through unchanged so this cannot regress existing edits.
   */
  private coercePropertyValue(
    nodeId: string,
    propertyPath: string,
    value: unknown
  ): { value: unknown } | { error: string } {
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) {
      return { value }; // node resolution is the operation's job; don't second-guess it here
    }
    let propDef;
    try {
      propDef = getNodePropertySchema(node).properties.find(p => p.name === propertyPath);
    } catch {
      return { value };
    }
    if (!propDef) {
      return { value };
    }

    // Some OpenAI-compatible providers (observed with OpenCode Zen free models) serialize a
    // structured or scalar tool argument as a JSON *string* — e.g. value: "{\"x\":-300,\"y\":-259.8}",
    // "[-300,-259.8]", "90" or "true" — because the tool's `value` schema is untyped. Parse it back
    // for every property type EXCEPT the genuinely string-valued ones (a color "#ff0000" or an enum
    // "idle" must stay a string). A non-JSON string is left untouched. Without this a stringified
    // vector slips through as a silent shape mismatch and the model abandons set_property to
    // hand-edit the scene file (a real session then tripped over the degrees-vs-radians rotation
    // format that way).
    let current = value;
    if (typeof current === 'string' && !STRINGLIKE_PROPERTY_TYPES.has(propDef.type)) {
      try {
        current = JSON.parse(current);
      } catch {
        // Not JSON — keep the raw string for the downstream setter / the error below.
      }
    }

    const arity =
      propDef.type === 'vector2'
        ? 2
        : propDef.type === 'vector3'
          ? 3
          : propDef.type === 'vector4'
            ? 4
            : 0;
    if (arity === 0) {
      return { value: current };
    }
    const keys = ['x', 'y', 'z', 'w'].slice(0, arity);
    const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current) &&
      keys.every(k => isFiniteNumber((current as Record<string, unknown>)[k]))
    ) {
      return { value: current };
    }
    if (Array.isArray(current) && current.length === arity && current.every(isFiniteNumber)) {
      const obj: Record<string, number> = {};
      keys.forEach((k, i) => (obj[k] = current[i] as number));
      return { value: obj };
    }
    return {
      error: `Property "${propertyPath}" on this node is a ${propDef.type}; its value must be an object { ${keys.join(', ')} } (an array [${keys.join(', ')}] is also accepted). Received ${JSON.stringify(value)}.`,
    };
  }

  /**
   * Persist the active scene after an agent mutation. Agent edits must be durable: components and
   * properties changed via tools live only in the loaded scene until a save, so any scene reload
   * (an external fs_write of the file, a page reload) silently discards them — models then
   * re-attach the same components turn after turn without understanding why. Best-effort: a failed
   * save must never fail the mutation that succeeded.
   */
  /**
   * Debug values the agent asked to hold only for this turn, oldest first. A turn that is cut off
   * mid-task (the tool-iteration cap, an abort, a provider error) used to leave them on the scene:
   * measured in the Flow eval, one capped turn shipped a game with `touch-rules.rules` and
   * `player-controller.gravity` still at their debug values — the agent said so honestly and simply
   * had no iterations left to undo them. So the undo cannot live in the model's remaining budget:
   * {@link revertTemporaryEdits} is called by the chat service when the turn ends, whatever ended it.
   */
  private readonly temporaryEdits: TemporaryEdit[] = [];

  /** Targets currently held at a temporary value, for the wrap-up notice. */
  listTemporaryEdits(): string[] {
    return this.temporaryEdits.map(edit => edit.label);
  }

  /**
   * Put every temporary edit back, newest first, and save. Best-effort per entry: one target that
   * can no longer be written (its node was deleted meanwhile) must not strand the rest. Entries
   * that fail stay in the journal so the next turn's end tries again.
   */
  async revertTemporaryEdits(): Promise<{ reverted: string[]; failed: string[] }> {
    const reverted: string[] = [];
    const failed: string[] = [];
    const pending = this.temporaryEdits.splice(0, this.temporaryEdits.length).reverse();
    for (const edit of pending) {
      try {
        const ok =
          edit.kind === 'node'
            ? await this.dispatcher.execute(
                new UpdateObjectPropertyCommand({
                  nodeId: edit.nodeId,
                  propertyPath: edit.propertyPath,
                  value: edit.previousValue,
                })
              )
            : await this.dispatcher.execute(
                new UpdateComponentPropertyCommand({
                  nodeId: edit.nodeId,
                  componentId: edit.componentId ?? '',
                  propertyName: edit.propertyPath,
                  value: edit.previousValue,
                })
              );
        if (ok) {
          reverted.push(edit.label);
          continue;
        }
        // A refused write is not automatically a failure: the command also reports `false` when the
        // value is already what we are writing (the agent put it back itself) and when the target no
        // longer exists (the node was deleted this turn). Neither needs a retry.
        const current = this.readCurrentValue(edit);
        if (current === undefined || valuesEqual(current, edit.previousValue)) {
          continue;
        }
        failed.push(edit.label);
        this.temporaryEdits.push(edit);
      } catch (error) {
        console.warn('[AgentToolRegistry] Reverting a temporary edit failed:', error);
        failed.push(edit.label);
        this.temporaryEdits.push(edit);
      }
    }
    if (reverted.length > 0) {
      await this.saveActiveSceneBestEffort();
    }
    return { reverted, failed };
  }

  /** Snapshot a node property before a temporary write. First value wins — it is the pre-turn one. */
  private recordTemporaryNodeEdit(nodeId: string, propertyPath: string): void {
    if (
      this.temporaryEdits.some(
        e => e.kind === 'node' && e.nodeId === nodeId && e.propertyPath === propertyPath
      )
    ) {
      return;
    }
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) {
      return;
    }
    let propDef;
    try {
      propDef = getNodePropertySchema(node).properties.find(p => p.name === propertyPath);
    } catch {
      return;
    }
    if (!propDef) {
      return;
    }
    this.temporaryEdits.push({
      kind: 'node',
      nodeId,
      propertyPath,
      previousValue: snapshotPropertyValue(propDef.getValue(node)),
      label: `${node.name || nodeId}.${propertyPath}`,
    });
  }

  /** Snapshot a component property before a temporary write. First value wins. */
  private recordTemporaryComponentEdit(
    nodeId: string,
    componentId: string,
    propertyName: string
  ): void {
    if (
      this.temporaryEdits.some(
        e =>
          e.kind === 'component' &&
          e.nodeId === nodeId &&
          e.componentId === componentId &&
          e.propertyPath === propertyName
      )
    ) {
      return;
    }
    const component = this.findComponent(nodeId, componentId);
    if (!component) {
      return;
    }
    let propDef;
    try {
      propDef = this.scriptRegistry
        .getComponentPropertySchema(component.type)
        ?.properties.find(p => p.name === propertyName);
    } catch {
      return;
    }
    if (!propDef) {
      return;
    }
    this.temporaryEdits.push({
      kind: 'component',
      nodeId,
      componentId,
      propertyPath: propertyName,
      previousValue: snapshotPropertyValue(propDef.getValue(component)),
      label: `${componentId}.${propertyName}`,
    });
  }

  private findComponent(nodeId: string, componentId: string) {
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) {
      return null;
    }
    return node.components.find(component => component.id === componentId) ?? null;
  }

  /** Current value of an edit's target, or `undefined` when the target is gone. */
  private readCurrentValue(edit: TemporaryEdit): unknown {
    try {
      if (edit.kind === 'component') {
        const component = edit.componentId
          ? this.findComponent(edit.nodeId, edit.componentId)
          : null;
        if (!component) return undefined;
        const propDef = this.scriptRegistry
          .getComponentPropertySchema(component.type)
          ?.properties.find(p => p.name === edit.propertyPath);
        return propDef ? snapshotPropertyValue(propDef.getValue(component)) : undefined;
      }
      const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(edit.nodeId);
      if (!(node instanceof NodeBase)) return undefined;
      const propDef = getNodePropertySchema(node).properties.find(
        p => p.name === edit.propertyPath
      );
      return propDef ? snapshotPropertyValue(propDef.getValue(node)) : undefined;
    } catch {
      return undefined;
    }
  }

  private async saveActiveSceneBestEffort(): Promise<void> {
    try {
      await this.dispatcher.execute(new SaveSceneCommand());
    } catch (error) {
      console.warn('[AgentToolRegistry] Scene save after agent mutation failed:', error);
    }
  }

  private listComponentTypes(): Array<{
    id: string;
    displayName: string;
    category: string;
    description: string;
    properties: Array<{ name: string; type: string; label?: string }>;
  }> {
    return this.scriptRegistry.getAllComponentTypes().map(info => {
      let properties: Array<{ name: string; type: string; label?: string }> = [];
      try {
        const schema = this.scriptRegistry.getComponentPropertySchema(info.id);
        properties = (schema?.properties ?? []).map(prop => ({
          name: prop.name,
          type: String(prop.type),
          ...(prop.ui?.label ? { label: prop.ui.label } : {}),
        }));
      } catch {
        // Schema resolution is best-effort — a type with a broken schema still lists.
      }
      return {
        id: info.id,
        displayName: info.displayName,
        category: info.category,
        description: info.description,
        properties,
      };
    });
  }

  private async addComponent(
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; componentId?: string; error?: string; note?: string }> {
    const nodeId = asString(args.nodeId);
    const componentType = asString(args.componentType);
    if (!this.scriptRegistry.getComponentType(componentType)) {
      const available = this.scriptRegistry
        .getAllComponentTypes()
        .map(type => type.id)
        .join(', ');
      return {
        ok: false,
        error: `Unknown component type "${componentType}". Call list_component_types first. Available: ${available || '(none registered)'}`,
      };
    }
    // A scene that opened before its project scripts compiled parks its `user:*` components
    // instead of dropping them (see component-hydration). Attach anything that can attach now, so
    // the model does not add a second copy of a component the scene already declares — that was
    // the observed tax: the components looked gone, and every run re-attached them by hand.
    const attachedPending = this.sceneManager.resolvePendingComponents();
    if (attachedPending > 0) {
      const existing = this.sceneManager
        .getActiveSceneGraph()
        ?.nodeMap.get(nodeId)
        ?.components.find(component => component.type === componentType);
      if (existing) {
        return {
          ok: true,
          componentId: existing.id,
          note: `"${componentType}" was already authored on this node — it was waiting for its script type to compile and is now attached. Nothing was added.`,
        };
      }
    }
    const config =
      args.config && typeof args.config === 'object' && !Array.isArray(args.config)
        ? (args.config as Record<string, unknown>)
        : undefined;
    const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
    // Generate the id here (rather than letting the operation default it) so it can be returned.
    const componentId = `${nodeId}-${componentType}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const ok = await this.dispatcher.execute(
      new AddComponentCommand({ nodeId, componentType, componentId, config, enabled })
    );
    if (ok) {
      await this.saveActiveSceneBestEffort();
    }
    return ok
      ? { ok: true, componentId }
      : {
          ok: false,
          error:
            'Failed to attach the component (node not found, the type failed to instantiate, or the node is a prefab instance — components are locked there).',
        };
  }

  private async setComponentProperty(
    nodeId: string,
    componentId: string,
    propertyName: string,
    value: unknown,
    temporary = false
  ): Promise<{ ok: boolean; error?: string; temporaryNote?: string }> {
    // Journal BEFORE the write — after it the original value is gone.
    if (temporary) {
      this.recordTemporaryComponentEdit(nodeId, componentId, propertyName);
    }
    const ok = await this.dispatcher.execute(
      new UpdateComponentPropertyCommand({ nodeId, componentId, propertyName, value })
    );
    if (ok) {
      await this.saveActiveSceneBestEffort();
    }
    return ok
      ? {
          ok: true,
          ...(temporary
            ? {
                temporaryNote:
                  'Journalled as temporary — it is put back automatically when this turn ends, even if the turn is force-stopped.',
              }
            : {}),
        }
      : {
          ok: false,
          error:
            'Property was not updated — the component/property was not found, the value is invalid or unchanged, or the node is a prefab instance. Re-check node_inspect and list_component_types.',
        };
  }

  private async removeComponent(
    nodeId: string,
    componentId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const ok = await this.dispatcher.execute(new RemoveComponentCommand({ nodeId, componentId }));
    if (ok) {
      await this.saveActiveSceneBestEffort();
    }
    return ok
      ? { ok: true }
      : {
          ok: false,
          error:
            'Failed to remove the component (node/component not found, or the node is a prefab instance).',
        };
  }

  private listCommands(): Array<{
    id: string;
    title: string;
    menuPath: string | null;
    allowed: boolean;
  }> {
    return this.commands.getAllCommands().map(command => ({
      id: command.metadata.id,
      title: command.metadata.title,
      menuPath: command.metadata.menuPath ?? null,
      allowed: isCommandAllowed(command.metadata.id),
    }));
  }

  private async runCommand(commandId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.commands.getCommand(commandId)) {
      return { ok: false, error: `Unknown command: ${commandId}` };
    }
    if (!isCommandAllowed(commandId)) {
      return {
        ok: false,
        error: `Command "${commandId}" is not permitted from the agent (only scene/properties/selection/alignment/history/viewport/game.* commands, and no dialogs/pickers).`,
      };
    }
    const ok = await this.dispatcher.executeById(commandId);
    return { ok };
  }

  // -- filesystem ------------------------------------------------------------

  private async fsList(
    path: string
  ): Promise<Array<{ name: string; kind: string; path: string; size: number | null }>> {
    const safe = this.safePath(path, true);
    const entries = await this.storage.listDirectory(safe);
    return entries.map(entry => ({
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      size: entry.size ?? null,
    }));
  }

  private async fsRead(
    path: string,
    offset?: number,
    limit?: number
  ): Promise<
    | { path: string; content: string; totalLines: number; note?: string }
    | {
        path: string;
        content: string;
        totalLines: number;
        startLine: number;
        endLine: number;
        hasMore: boolean;
      }
    | { path: string; binary: true; mimeType: string; size: number }
  > {
    const safe = this.safePath(path);
    if (isTextPath(safe)) {
      const content = await this.storage.readTextFile(safe);
      // Splitting on '\n' and re-joining keeps any '\r' with its line, so a returned range is a
      // byte-exact substring of the file — safe to copy verbatim into a str_replace old_string.
      const lines = content.split('\n');
      const totalLines = lines.length;
      if (offset === undefined && limit === undefined) {
        return { path: safe, content, totalLines };
      }
      // A range was requested, but the file is small enough to hand over whole — do that instead of
      // letting the agent page a moving target. See FS_READ_FULL_CHARS.
      if (content.length <= FS_READ_FULL_CHARS) {
        return {
          path: safe,
          content,
          totalLines,
          note: `Range ignored: the whole file is only ${content.length} characters, so all ${totalLines} lines are here. You have the complete file — no follow-up range reads needed.`,
        };
      }
      const startLine = Math.min(Math.max(1, offset ?? 1), totalLines);
      const startIdx = startLine - 1;
      const count = limit !== undefined && limit > 0 ? limit : totalLines - startIdx;
      const slice = lines.slice(startIdx, startIdx + count);
      const endLine = startIdx + slice.length;
      return {
        path: safe,
        content: slice.join('\n'),
        totalLines,
        startLine,
        endLine,
        hasMore: endLine < totalLines,
      };
    }
    const blob = await this.storage.readBlob(safe);
    return {
      path: safe,
      binary: true,
      mimeType: blob.type || guessMimeType(safe),
      size: blob.size,
    };
  }

  /**
   * Write a file, with a guard against blind wholesale rewrites of existing content. Measured in a
   * real eval run: the model rewrote a large file three times with byte-identical content, thinking
   * it had changed a constant, and in another run a rewrite reverted a fix from earlier in the same
   * session. Creating a NEW file is never blocked; only replacing an existing file bigger than
   * {@link FS_WRITE_GUARD_CHARS} needs `overwrite:true` + a `reason`. A forced overwrite reports
   * `forcedOverwrite: true` so the chat loop can count it as a "stuck" signal.
   */
  private async fsWrite(
    path: string,
    content: string,
    options: { overwrite: boolean; reason: string } = { overwrite: false, reason: '' }
  ): Promise<
    | {
        ok: true;
        path: string;
        reloadedScene?: string;
        forcedOverwrite?: true;
        reason?: string;
        createdDirectories?: string[];
        note?: string;
      }
    | { ok: false; error: string; path: string; existingChars: number }
  > {
    const safe = this.safePath(path);
    let existing: string | null = null;
    try {
      existing = await this.storage.readTextFile(safe);
    } catch {
      // No such file (or binary) — a create, which is never guarded.
    }
    const isLargeRewrite = existing !== null && existing.length > FS_WRITE_GUARD_CHARS;
    if (isLargeRewrite && !options.overwrite) {
      return {
        ok: false,
        path: safe,
        existingChars: existing?.length ?? 0,
        error: `Refused: ${safe} already exists and is ${existing?.length ?? 0} characters. Rewriting it wholesale loses edits already in the file. Use str_replace for a targeted edit (fs_read the exact lines first, then replace them). If you genuinely mean to replace the whole file, call fs_write again with overwrite:true and a reason explaining why.`,
      };
    }
    if (isLargeRewrite && !options.reason) {
      return {
        ok: false,
        path: safe,
        existingChars: existing?.length ?? 0,
        error: `Refused: overwrite:true on ${safe} also needs a \`reason\` describing why the whole file must be replaced instead of edited with str_replace.`,
      };
    }
    const createdDirectories = existing === null ? await this.ensureParentDirectories(safe) : [];
    // ProjectStorageService.writeTextFile bumps appState.project.fileRefreshSignal internally, so
    // open code tabs / the asset browser pick the change up — no direct appState mutation here.
    await this.storage.writeTextFile(safe, content);
    const reloadedScene = await this.reloadSceneIfOpen(safe);
    const notes: string[] = [];
    if (createdDirectories.length) {
      notes.push(
        `Created ${createdDirectories.length === 1 ? 'a new directory' : 'new directories'} on the way to this file: ${createdDirectories.join(', ')}. Nothing else in the project uses ${createdDirectories.length === 1 ? 'it' : 'them'} yet, so if a segment there is a typo, fs_delete it and write again under the right path.`
      );
    }
    const strayPlanNote = await this.strayPlanNote(safe);
    if (strayPlanNote) {
      notes.push(strayPlanNote);
    }
    return {
      ok: true,
      path: safe,
      ...(reloadedScene ? { reloadedScene } : {}),
      ...(isLargeRewrite ? { forcedOverwrite: true as const, reason: options.reason } : {}),
      ...(createdDirectories.length ? { createdDirectories } : {}),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  /**
   * A nudge for a plan written to the wrong filename, or null when there is nothing to say.
   *
   * The Plan tab reads exactly {@link FLOW_PROGRESS_PATH}; a session that wrote its build
   * plan to `design/plan.md` left that tab empty for the whole run and never learned why,
   * because a write to an unclaimed path is a perfectly successful write. So: say it, and
   * only when it can matter — the file is plan-shaped, it is not `progress.md` itself, and
   * no `progress.md` exists yet (once one does, a second planning document is the agent's
   * own business and none of ours).
   */
  private async strayPlanNote(path: string): Promise<string | null> {
    if (path === FLOW_PROGRESS_PATH || !path.startsWith('design/')) {
      return null;
    }
    const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    if (!PLAN_SHAPED_STEMS.has(stem.toLowerCase())) {
      return null;
    }
    try {
      await this.storage.readTextFile(FLOW_PROGRESS_PATH);
      return null;
    } catch {
      // No progress.md — the Plan tab has nothing to show, and this file is why.
    }
    return `Written, and kept. One thing though: the editor's Plan tab reads ${FLOW_PROGRESS_PATH} and only that path, and the project has no ${FLOW_PROGRESS_PATH} — so this plan is invisible to the user. Write the checklist there too (or instead) if you want it shown.`;
  }

  /**
   * Create the parent directories a write needs, and REPORT the ones it created.
   *
   * `writeTextFile` resolves the parent directory rather than creating it, so a
   * project that never grew a `design/tests/routines/` answered every attempt to
   * store the first routine with "Unable to resolve directory" — and there is no
   * make-a-directory tool for an agent to reach for. Creating parents silently is
   * the obvious fix and the wrong one: a typo in a path segment would then produce a
   * plausible-looking directory nobody asked for, and the write would succeed, so
   * nothing would ever say the file is not where the author meant it to be.
   *
   * So: create them, and hand the list back. The names appear in the tool result and
   * a mistyped segment is visible in the answer rather than buried in the tree.
   *
   * The probe walks UPWARDS from the parent and stops at the first level that is
   * there, so the ordinary write into an existing folder costs exactly one probe and
   * only a genuinely new tree costs one per level. The creation is a single
   * `createDirectory` on the full parent path — it walks the segments itself and is
   * idempotent, so a race with another writer cannot fail here. Existence is probed
   * with `listDirectory` because that is the only question `ProjectStorageService`
   * answers for all three backends (local FS, OPFS, cloud); a probe that throws for
   * any other reason is treated as "missing", and if that was wrong the real failure
   * surfaces from the write, where it names the file the caller actually asked for.
   */
  private async ensureParentDirectories(filePath: string): Promise<string[]> {
    const segments = filePath.split('/').slice(0, -1);
    if (segments.length === 0) return [];
    const missing: string[] = [];
    for (let depth = segments.length; depth > 0; depth -= 1) {
      const prefix = segments.slice(0, depth).join('/');
      try {
        await this.storage.listDirectory(prefix);
        break;
      } catch {
        // Not there (or not readable) — it and everything under it has to be created.
        missing.unshift(prefix);
      }
    }
    if (missing.length === 0) return [];
    await this.storage.createDirectory(segments.join('/'));
    return missing;
  }

  /**
   * Targeted edit: swap an exact, unique `oldString` for `newString`. Refuses (no write) when the
   * anchor is absent or ambiguous, so a mismatched edit fails loudly instead of corrupting the
   * file — the reason blind full-file rewrites reverted a good fix in the wild. Splicing avoids
   * String.replace's `$`-pattern interpretation in the replacement text.
   */
  private async strReplace(
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean
  ): Promise<
    | {
        ok: true;
        path: string;
        replacements: number;
        totalLines: number;
        context?: { startLine: number; endLine: number; text: string };
        reloadedScene?: string;
        note?: string;
      }
    | { ok: false; error: string }
  > {
    const safe = this.safePath(path);
    if (!isTextPath(safe)) {
      return { ok: false, error: `str_replace edits text files only; "${safe}" is binary.` };
    }
    if (oldString.length === 0) {
      return {
        ok: false,
        error:
          'old_string must not be empty. Use fs_write to create a file; to insert text, anchor old_string on nearby existing lines.',
      };
    }
    if (oldString === newString) {
      return { ok: false, error: 'old_string and new_string are identical — nothing to change.' };
    }
    let content: string;
    try {
      content = await this.storage.readTextFile(safe);
    } catch {
      return { ok: false, error: `File not found: ${safe}. Use fs_write to create it.` };
    }
    let count = countOccurrences(content, oldString);
    // The anchor is only re-punctuated when it MISSED, so an exact match stays byte-for-byte and the
    // ordinary LF path is untouched. See `toFileLineEndings` for why the miss happens at all.
    let adaptedLineEndings = false;
    if (count === 0) {
      const adapted = toFileLineEndings(oldString, content);
      if (adapted !== oldString) {
        const adaptedCount = countOccurrences(content, adapted);
        if (adaptedCount > 0) {
          oldString = adapted;
          newString = toFileLineEndings(newString, content);
          count = adaptedCount;
          adaptedLineEndings = true;
        }
      }
    }
    if (count === 0) {
      return {
        ok: false,
        error: `old_string was not found in ${safe}. It must match exactly, including whitespace and indentation. fs_read the file and copy the target text verbatim.`,
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string matches ${count} places in ${safe}. Include surrounding lines to make it unique, or pass replace_all:true to change all ${count}.`,
      };
    }
    // The FIRST match sits at the same offset in both strings (everything before it is untouched),
    // so its post-edit span is [at, at + newString.length) in `updated` for both modes.
    const at = content.indexOf(oldString);
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.slice(0, at) + newString + content.slice(at + oldString.length);
    await this.storage.writeTextFile(safe, updated);
    const reloadedScene = await this.reloadSceneIfOpen(safe);
    const context = sliceEditContext(updated, at, at + newString.length);
    return {
      ok: true,
      path: safe,
      replacements: replaceAll ? count : 1,
      totalLines: updated.split('\n').length,
      ...(context ? { context } : {}),
      ...(reloadedScene ? { reloadedScene } : {}),
      ...(adaptedLineEndings
        ? {
            note: `This file uses CRLF line endings and your anchor used LF (or the reverse) — the anchor was matched, and the replacement written, with the file's own endings. Nothing to change on your side; the returned context is verbatim as always.`,
          }
        : {}),
    };
  }

  /**
   * Deterministically reload an OPEN scene the agent just overwrote. The file watcher cannot be
   * relied on here: browser-OPFS scene descriptors carry no usable fileHandle and a blurred
   * automation window pauses polling — observed in eval: the agent rewrote the active scene,
   * the editor silently kept the stale graph, and every follow-up edit targeted dead nodes.
   */
  private async reloadSceneIfOpen(safePath: string): Promise<string | null> {
    if (!safePath.toLowerCase().endsWith('.pix3scene')) {
      return null;
    }
    const entry = Object.entries(appState.scenes.descriptors).find(([, descriptor]) => {
      const descriptorPath = (descriptor?.filePath ?? '')
        .replace(/^res:\/\//i, '')
        .replace(/^\/+/, '');
      return descriptorPath === safePath;
    });
    if (!entry) {
      return null;
    }
    const [sceneId, descriptor] = entry;
    try {
      const ok = await this.dispatcher.execute(
        new ReloadSceneCommand({ sceneId, filePath: descriptor.filePath })
      );
      return ok ? sceneId : null;
    } catch (error) {
      console.warn('[AgentToolRegistry] Scene reload after fs_write failed:', error);
      return null;
    }
  }

  private async fsDelete(path: string): Promise<{ ok: true; path: string }> {
    const safe = this.safePath(path);
    // deleteEntry likewise bumps fileRefreshSignal internally.
    await this.storage.deleteEntry(safe);
    // Prune the sidecar with the file. Observed live: the agent deleted two generated references
    // and their index entries outlived them, leaving the index describing files nobody has. The
    // panel lists the FOLDER so it degraded silently — but an index that lies is a bad index.
    if (safe.startsWith(`${REFERENCES_DIR}/`)) {
      try {
        await this.flowReferences.removeEntry(safe.slice(REFERENCES_DIR.length + 1));
      } catch {
        // The delete already happened and is what was asked for; a stale sidecar entry is not
        // worth failing the tool over.
      }
    }
    return { ok: true, path: safe };
  }

  /** Reject `..` traversal (mirrors PreviewHostService.handleFileRequest). Allows "." for dir list. */
  private safePath(input: string, allowRoot = false): string {
    const normalized = String(input ?? '')
      .replace(/^res:\/\//i, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!normalized || normalized === '.') {
      if (allowRoot) return '.';
      throw new Error(`Invalid path: ${input}`);
    }
    if (normalized.split('/').includes('..')) {
      throw new Error(`Invalid path (".." is not allowed): ${input}`);
    }
    return normalized;
  }

  // -- compile ---------------------------------------------------------------

  private async compileScripts(): Promise<Record<string, unknown>> {
    const files = await this.collectScriptFiles();
    if (files.size === 0) {
      return {
        ok: true,
        fileCount: 0,
        message: 'No script files found under scripts/ or src/scripts/.',
      };
    }
    const entryFiles = Array.from(files.entries())
      .filter(([, content]) => SCRIPT_ENTRY_PATTERN.test(content))
      .map(([path]) => path);
    if (entryFiles.length === 0) {
      return { ok: true, fileCount: files.size, message: 'No Script subclasses found to compile.' };
    }

    try {
      const result = await this.compiler.bundle(files, entryFiles, async filePath => {
        try {
          return await this.storage.readTextFile(filePath);
        } catch {
          return null;
        }
      });
      // A successful bundle alone does NOT update the live ScriptRegistry — without this
      // rebuild the game keeps running the previously registered classes and the model's
      // "fixed" scripts change nothing (it then reports "the old code is still executing").
      // force: the agent's automation window is typically unfocused, which would defer the build.
      await this.projectScriptLoader.syncAndBuild({ force: true });
      await this.projectScriptLoader.ensureReady();
      // esbuild only transpiles, so a green bundle says nothing about types: measured, an agent
      // wrote a script calling a method that does not exist, read `ok: true`, and only found out
      // three iterations later via a separate check_scripts (plus two loop-breaker hits on the
      // repeats). Folding the type-check in makes one call the whole answer.
      const typeCheck = await this.runTypeCheck();
      return {
        ok: typeCheck.errorCount === 0,
        bundled: true,
        registered: true,
        fileCount: files.size,
        bytes: result.code.length,
        warnings: result.warnings,
        ...typeCheck.report,
        ...(typeCheck.errorCount > 0
          ? {
              message: `The bundle built and registered, but ${typeCheck.errorCount} type error(s) remain — fix them in the listed files. No need to call check_scripts, this result already is it.`,
            }
          : {}),
      };
    } catch (error) {
      const compileError = error as CompilationError;
      return {
        ok: false,
        error: typeof compileError?.message === 'string' ? compileError.message : String(error),
        file: compileError?.file,
        line: compileError?.line,
        column: compileError?.column,
      };
    }
  }

  private async checkScripts(): Promise<Record<string, unknown>> {
    const typeCheck = await this.runTypeCheck();
    if (typeCheck.error !== undefined) {
      return { ok: false, error: typeCheck.error };
    }
    return { ok: true, ...typeCheck.report };
  }

  /**
   * Full project type-check, shared by `check_scripts` and the tail of `compile_scripts`. A
   * type-checker that cannot load is reported as `typeCheck: 'unavailable'` rather than as a
   * failure — it must not turn a good bundle into a red result.
   */
  private async runTypeCheck(): Promise<{
    errorCount: number;
    report: Record<string, unknown>;
    error?: string;
  }> {
    try {
      const summary = await this.diagnostics.checkProject();
      if (summary.errorCount === 0) {
        // A clean check means every script diagnostic in the ring buffer is history. Leaving them
        // there made read_errors keep reporting a type error that had already been fixed — measured:
        // an agent spent iterations re-investigating a line that was by then a comment.
        clearScriptDiagnosticErrors();
      }
      return {
        errorCount: summary.errorCount,
        report: {
          filesChecked: summary.filesChecked,
          errorCount: summary.errorCount,
          warningCount: summary.warningCount,
          diagnostics: summary.diagnostics,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        errorCount: 0,
        report: { typeCheck: 'unavailable', typeCheckError: message },
        error: message,
      };
    }
  }

  private async collectScriptFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const directory of SCRIPT_DIRECTORIES) {
      for (const path of await this.collectScriptPaths(directory)) {
        try {
          files.set(path, await this.storage.readTextFile(path));
        } catch {
          // Files disappearing mid-scan are fine.
        }
      }
    }
    return files;
  }

  private async collectScriptPaths(directory: string): Promise<string[]> {
    let entries: ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string }>;
    try {
      entries = await this.storage.listDirectory(directory);
    } catch {
      return [];
    }
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        result.push(...(await this.collectScriptPaths(entry.path)));
        continue;
      }
      const lower = entry.path.toLowerCase();
      if (!lower.endsWith('.ts') && !lower.endsWith('.js')) continue;
      if (EXCLUDED_SCRIPT_SUFFIXES.some(suffix => lower.endsWith(suffix))) continue;
      result.push(entry.path);
    }
    return result;
  }

  // -- screenshot / asset generation -----------------------------------------

  /**
   * Capture pixels for the model: the running game when play mode is active
   * ('auto'), or explicitly the game / editor viewport. The game path renders a
   * frame on the live runtime canvas via {@link GamePlaySessionService}; the
   * editor path uses the edit-mode viewport (proxy visuals, gizmos and all).
   */
  private async captureView(
    source: AgentCaptureSource,
    maxSize: number
  ): Promise<
    { shot: CanvasScreenshot; view: 'game' | 'editor'; note?: string } | { error: string }
  > {
    if (source !== 'editor' && appState.ui.isPlaying) {
      const shot = this.playSession.captureScreenshot({ maxSize });
      if (shot) {
        return { shot, view: 'game' };
      }
      if (source === 'game') {
        return {
          error:
            'Play mode is starting but the game canvas is not attached yet; retry in a moment.',
        };
      }
    } else if (source === 'game') {
      return {
        error:
          'The game is not running — call play_start first (or use source "editor" for the edit-mode viewport).',
      };
    }
    const shot = await this.captureEditorViewport(maxSize);
    if (!shot) {
      return { error: EDITOR_VIEWPORT_UNAVAILABLE };
    }
    return {
      shot,
      view: 'editor',
      // Either way the model has to know this frame is NOT the running game (the editor lights
      // and draws it differently) -- but only the 'auto' fallback landed here because the game
      // canvas was unavailable. Telling that to an agent that explicitly asked for the editor
      // reports a failure that did not happen, and sends it chasing a canvas that is fine.
      ...(appState.ui.isPlaying
        ? {
            note:
              source === 'editor'
                ? 'The game is playing; this is the EDIT-MODE viewport, not the running game.'
                : 'The game canvas was not ready; this is the EDIT-MODE viewport instead.',
          }
        : {}),
    };
  }

  /**
   * Capture the edit-mode viewport, building it first if this session never opened Studio.
   *
   * A Vibe-only session has no viewport at all — the shell skips Golden Layout entirely — so the
   * first capture legitimately returns null there. Mounting it (hidden, without moving the user out
   * of Vibe) and asking once more is the difference between the agent being able to look at the
   * scene it is editing and being blind in one of the two workspaces. When the mount cannot happen
   * the retry is skipped and the caller still gets the honest "not initialized".
   */
  private async captureEditorViewport(maxSize: number): Promise<CanvasScreenshot | null> {
    const shot = this.viewportRenderer.captureScreenshot({ maxSize });
    if (shot) {
      return shot;
    }
    if (!(await this.studioViewportMount.ensureStudioViewportMounted())) {
      return null;
    }
    return this.viewportRenderer.captureScreenshot({ maxSize });
  }

  /**
   * Warn when an editor screenshot is lit by lights the running game does not have.
   *
   * The editor adds fallback lights to any scene that declares none, so a 3D scene with no light of
   * its own photographs beautifully and runs black. A picture that cannot be told apart from a
   * working one is worse than no picture, so it ships with its own disclaimer.
   */
  private editorLightingNote(): { editorFallbackLighting?: true; lightingWarning?: string } {
    if (!this.viewportRenderer.isUsingEditorFallbackLighting()) {
      return {};
    }
    const roots = (this.sceneManager.getActiveSceneGraph()?.rootNodes ?? []).filter(
      (node): node is NodeBase => node instanceof NodeBase
    );
    if (!collectRenderabilityIssues(roots).some(issue => issue.code === 'lit-material-no-light')) {
      return {};
    }
    return {
      editorFallbackLighting: true,
      lightingWarning:
        'This image is lit by EDITOR-ONLY fallback lights. The scene declares no light of its own, so the RUNNING game draws these meshes black. Add a light, and verify with play_start + game_observe (sceneIssues) rather than with this picture.',
    };
  }

  private async viewportScreenshot(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const maxSize = asInt(args.maxSize, 1024);
    const source = asCaptureSource(args.source);
    const nodeId = typeof args.nodeId === 'string' && args.nodeId ? args.nodeId : undefined;
    const isolate = args.isolate === true;
    const padding = typeof args.padding === 'number' ? args.padding : undefined;
    // A bare nodeId means "frame this node".
    let frame = typeof args.frame === 'string' ? args.frame : 'current';
    if (nodeId && frame === 'current') {
      frame = 'node';
    }

    if (frame !== 'current') {
      return await this.framedViewportScreenshot(frame as 'all' | 'selection' | 'node', {
        maxSize,
        source,
        nodeId,
        isolate,
        padding,
      });
    }

    // Unframed: capture as-is (game while playing unless source forces editor).
    const capture = await this.captureView(source, maxSize);
    if ('error' in capture) {
      return { ok: false, error: capture.error };
    }
    const { shot, view } = capture;
    return {
      ok: true,
      view,
      ...(view === 'editor' ? this.editorLightingNote() : {}),
      width: shot.width,
      height: shot.height,
      mimeType: shot.mimeType,
      note:
        capture.note ??
        (view === 'game'
          ? 'The screenshot of the RUNNING GAME is attached as an image.'
          : 'The screenshot of the edit-mode editor viewport is attached as an image.'),
      [AGENT_TOOL_IMAGES_KEY]: [
        { mimeType: shot.mimeType, data: shot.dataBase64 },
      ] satisfies AgentToolImage[],
    };
  }

  /**
   * Editor-viewport screenshot with the camera transiently aimed at scene
   * content / a selection / a node, optionally isolating the target. Always the
   * editor (never the game) and always restores the user's camera.
   */
  private async framedViewportScreenshot(
    frame: 'all' | 'selection' | 'node',
    opts: {
      maxSize: number;
      source: AgentCaptureSource;
      nodeId?: string;
      isolate: boolean;
      padding?: number;
    }
  ): Promise<Record<string, unknown>> {
    if (frame === 'node' && !opts.nodeId) {
      return { ok: false, error: 'frame:"node" requires nodeId.' };
    }
    if (opts.isolate && frame === 'all') {
      return {
        ok: false,
        error: 'isolate needs a target — use frame:"node" (with nodeId) or frame:"selection".',
      };
    }
    if (opts.source === 'game') {
      return {
        ok: false,
        error: 'Framing captures the editor viewport — drop source or use source:"editor".',
      };
    }

    // padding fraction (0–1) → bounds inflation multiplier, clamped to a sane range.
    const paddingMultiplier =
      opts.padding !== undefined ? Math.min(3, Math.max(1, 1 + 2 * opts.padding)) : undefined;

    const framedOptions = {
      maxSize: opts.maxSize,
      frame,
      nodeId: opts.nodeId,
      isolate: opts.isolate,
      paddingMultiplier,
    };
    let result = this.viewportRenderer.captureFramedScreenshot(framedOptions);
    // Same Vibe gap as the unframed path: no Studio in this session means no viewport to frame.
    if (result === null && (await this.studioViewportMount.ensureStudioViewportMounted())) {
      result = this.viewportRenderer.captureFramedScreenshot(framedOptions);
    }
    if (result === null) {
      return { ok: false, error: EDITOR_VIEWPORT_UNAVAILABLE };
    }
    if ('error' in result) {
      return { ok: false, error: result.error };
    }

    const framedNode = opts.nodeId
      ? this.sceneManager.getActiveSceneGraph()?.nodeMap.get(opts.nodeId)
      : undefined;
    const target = frame === 'node' ? `node "${framedNode?.name ?? opts.nodeId}"` : `the ${frame}`;
    return {
      ok: true,
      view: 'editor',
      ...this.editorLightingNote(),
      framed: frame,
      ...(opts.nodeId ? { framedNodeId: opts.nodeId, framedNodeName: framedNode?.name } : {}),
      width: result.width,
      height: result.height,
      mimeType: result.mimeType,
      note: `Editor viewport framed on ${target}${
        opts.isolate ? ' with other nodes hidden' : ''
      }. The user's camera was restored.`,
      [AGENT_TOOL_IMAGES_KEY]: [
        { mimeType: result.mimeType, data: result.dataBase64 },
      ] satisfies AgentToolImage[],
    };
  }

  private async analyzeImage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = asString(args.source);
    const question = typeof args.question === 'string' ? args.question : '';
    let image: LlmImageBlock;
    try {
      image = await this.resolveImageForAnalysis(source);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const answer = await this.vision.analyze(image, question);
      const helper = await this.vision.describeHelper();
      return {
        ok: true,
        answer,
        model: helper ? `${helper.providerLabel} · ${helper.modelLabel ?? helper.modelId}` : null,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Turn an `analyze_image` source (viewport / game / handle / project path) into an inline image block. */
  private async resolveImageForAnalysis(source: string): Promise<LlmImageBlock> {
    if (source === 'viewport' || source === 'game' || source === 'editor') {
      const capture = await this.captureView(source === 'viewport' ? 'auto' : source, 1024);
      if ('error' in capture) {
        throw new Error(capture.error);
      }
      return { type: 'image', mimeType: capture.shot.mimeType, data: capture.shot.dataBase64 };
    }
    // A live generation handle from generate_asset?
    if (this.assetGen.get(source)) {
      return dataUrlToImageBlock(await this.assetGen.preview(source, 1024));
    }
    // Otherwise a project image path — open, downscale for token economy, then release the handle.
    const path = this.safePath(source);
    const opened = await this.assetGen.open(path);
    try {
      return dataUrlToImageBlock(await this.assetGen.preview(opened.id, 1024));
    } finally {
      this.assetGen.discard(opened.id);
    }
  }

  private async generateAsset(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const providerId =
      typeof args.providerId === 'string' && args.providerId.trim()
        ? args.providerId.trim()
        : undefined;
    // Status for the provider that will actually run: for a provider with no key of its own
    // (svg-llm) `keyConfigured` reports whether an LLM lane is reachable, not whether a key exists.
    const status = await this.assetGen.status(providerId);
    if (!status.keyConfigured) {
      return {
        ok: false,
        error: providerId
          ? `The "${providerId}" image provider is not ready. For "svg-llm", the user must configure an LLM in Settings → AI Agent; for the others, an image API key in Settings → AI Providers.`
          : 'No image-generation API key is configured. Ask the user to set one (Sprite Editor panel or Settings → AI Providers).',
      };
    }

    const prompt = asString(args.prompt);
    const name = this.resolveGeneratedAssetPath(asString(args.name));
    const references = Array.isArray(args.references)
      ? args.references.filter((r): r is string => typeof r === 'string')
      : undefined;
    const transparent = args.transparent === true;
    const maxSize = typeof args.maxSize === 'number' ? Math.floor(args.maxSize) : undefined;
    const preset = resolvePreset(args.postProcess, transparent ? 'sprite' : 'texture');

    // Exact size is a request, not a promise: providers that cannot honour it ignore both fields.
    const width = typeof args.width === 'number' ? Math.floor(args.width) : undefined;
    const height = typeof args.height === 'number' ? Math.floor(args.height) : width;

    const generated = await this.assetGen.generate({
      prompt,
      references,
      transparent,
      providerId,
      width,
      height,
    });
    // The generation plus every intermediate handle the pipeline creates must be freed.
    const handleIds = new Set<string>([generated.id]);
    try {
      const processed = await this.assetGen.postProcess(generated.id, preset, { maxSize });
      handleIds.add(processed.id);
      // Optional orientation fix (rotate/flip) applied AFTER post-processing — top-down sprites
      // often come out sideways and the model can't otherwise re-orient without regenerating.
      const oriented = await this.applyOrientation(processed.id, args, id => handleIds.add(id));
      const saved = await this.assetGen.save(oriented, name, {});
      await this.recordGeneratedReference(saved.path, prompt, asReferenceRole(args.role));
      const transparency = await this.assetGen.alphaStats(oriented);
      // Preview the ORIENTED handle (what was actually saved), not the raw generation.
      return {
        ok: true,
        saved,
        preset,
        original: { width: generated.width, height: generated.height },
        // Vector output is already a clean cutout at the exact size asked for, so the post-process
        // pass skipped background removal — say so, or "no bg-removal ran" reads as a failure.
        ...(generated.svgSource ? { vector: true } : {}),
        transparency,
        // The idea-stage folder is decided here, so the result has to SAY so: a model that asked
        // for another folder and is told nothing reads its own request as authoritative and
        // "corrects" the file back out of the list (observed twice live).
        note: this.flowStage.isIdeaStage()
          ? `Saved to "${saved.path}". At the idea stage every artefact lives in ` +
            `\`${REFERENCES_DIR}/\` — that is the folder the user's Files column lists, so the ` +
            `folder is not yours to choose. Do NOT copy or move it elsewhere; point at this path. ` +
            transparencyNote(preset, transparency)
          : transparencyNote(preset, transparency),
        ...(await this.previewImages(oriented)),
      };
    } finally {
      for (const id of handleIds) {
        this.assetGen.discard(id);
      }
    }
  }

  /**
   * Where a generated image lands when the model gave a bare file name.
   *
   * At the **idea stage** that is `references/`, not the asset-type folder: the only thing generated
   * there is a reference (a moodboard, a mockup), and the references column lists exactly one
   * folder. This is decided in code rather than asked for in the skill because "the artefact exists
   * but is not in the list" is precisely the kind of quiet breakage a prompt does not fix — the
   * model would be right about the file and wrong about the folder, with nothing to notice it.
   *
   * At the idea stage an explicit folder does NOT win, and that is deliberate: observed live, the
   * model asked for `design/reference_screenshot.png`, so the picture it had just drawn never
   * appeared in the references column — the one place the user looks for it. There is no scene and
   * no sprite at this stage for anything else to consume, so every generated file belongs in
   * `references/`; only the file NAME is taken from what was asked for. The saved path comes back in
   * the tool result, so the model still knows where to point at it.
   */
  private resolveGeneratedAssetPath(name: string): string {
    const path = this.safePath(name);
    if (this.flowStage.isIdeaStage()) {
      return `${REFERENCES_DIR}/${path.split('/').pop() || path}`;
    }
    // Bare file names land in the category folder at the project root (`car.png` →
    // `sprites/car.png`) so generated art never litters the project root.
    return ensureAssetTypeFolder(path);
  }

  /**
   * Note a generated file in `references/index.json` — deterministically, not by asking the model to
   * remember. The card in the references column reads `origin` to offer "regenerate" and `caption`
   * to say what the picture was for; both are facts this call already has.
   *
   * Only files that actually landed under `references/` are recorded: the index describes that one
   * folder, and a `sprites/` entry in it would be metadata about a file nothing reads it for.
   */
  private async recordGeneratedReference(
    savedPath: string,
    prompt: string,
    role?: FlowReferenceRole
  ): Promise<void> {
    if (!savedPath.startsWith(`${REFERENCES_DIR}/`)) {
      return;
    }
    const fileName = savedPath.slice(REFERENCES_DIR.length + 1);
    // Nested paths are keyed by their file name, like every other entry (the index sits in the
    // folder it describes).
    const key = fileName.split('/').pop() ?? fileName;
    try {
      await this.flowReferences.upsert(key, {
        origin: 'agent',
        caption: prompt,
        prompt,
        // Omitted rather than written as undefined: without a role the index keeps whatever
        // `guessAttachmentRole` decided from the name, which is the right default.
        ...(role ? { role } : {}),
      });
    } catch (error) {
      // A missing index entry degrades to "name + origin user" on the card; failing the whole
      // generation over its sidecar would throw away the image that was just paid for.
      this.logger.warn('[AgentToolRegistry] Could not index generated reference', {
        savedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Generate one prototype SFX and (by default) save it as `res://sfx/<name>.wav`.
   *
   * Two outcomes are deliberately NOT errors, because both are the pipeline working and both are
   * things the model has to explain rather than retry:
   *
   * - `refused` — the txt2sfx contract tells the writer to decline a human voice, a believable animal
   *   or a real-world recording. A thrown error there reads as "try again", and the model would.
   * - `distance` / a validator warning on an accepted recipe — the sound exists and is saved; the
   *   caveat is information about *this* sound, not a reason to spend another completion.
   */
  private async generateSfx(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await this.sfxGen.isAvailable())) {
      return {
        ok: false,
        error:
          'No LLM is configured for the agent, so no recipe can be written. Ask the user to pick a ' +
          'provider and model in Settings → AI Agent (or start the Pix3AgentBridge).',
      };
    }
    const soundline =
      typeof args.soundline === 'string' && args.soundline.trim() ? args.soundline : undefined;
    const feedback =
      typeof args.feedback === 'string' && args.feedback.trim() ? args.feedback.trim() : undefined;
    // In edit mode the change request is the prompt; `prompt` stays required so a caller that passes
    // only `soundline` still says what to do with it.
    const prompt = soundline && feedback ? feedback : asString(args.prompt);
    const save = args.save !== false;

    try {
      const result = await this.sfxGen.generate({
        prompt,
        ...(soundline ? { soundline } : {}),
        ...(typeof args.maxIterations === 'number'
          ? { maxIterations: Math.floor(args.maxIterations) }
          : {}),
      });

      const warnings = result.issues
        .filter(issue => issue.severity === 'warn')
        .map(issue => `${issue.layer ? `${issue.layer}: ` : ''}${issue.rule} — ${issue.hint}`);
      const errors = result.issues
        .filter(issue => issue.severity === 'error')
        .map(issue => `${issue.layer ? `${issue.layer}: ` : ''}${issue.rule} — ${issue.hint}`);

      const base: Record<string, unknown> = {
        ok: true,
        outcome: result.outcome,
        accepted: result.accepted,
        note: describeSfxOutcome(result),
        // The recipe is the master. Handing it back is what makes the next tweak a deterministic edit
        // instead of a re-roll that changes everything the user already liked.
        soundline: result.soundline || undefined,
        grammarVersion: result.grammarVersion,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };

      if (!result.wav) {
        return base;
      }
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : '';
      const saved = save ? await this.sfxGen.save(result, name) : null;
      return {
        ...base,
        ...(saved
          ? {
              saved: { path: saved.path, bytes: saved.bytes },
              // A scene/script reference is what the caller does next; spell it out.
              resourcePath: `res://${saved.path}`,
            }
          : { saved: null, note: `${String(base.note)} Not saved (save: false).` }),
        durationMs: result.durationMs,
        peak: result.peak,
        clipped: result.clipped,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async processAsset(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (appState.project.status !== 'ready') {
      return { ok: false, error: 'No project is open — cannot process an asset.' };
    }
    const path = this.safePath(asString(args.path));
    const preset = resolvePreset(args.preset, 'sprite');
    const maxSize = typeof args.maxSize === 'number' ? Math.floor(args.maxSize) : undefined;
    const outName =
      typeof args.name === 'string' && args.name.trim() ? this.safePath(args.name) : path;

    // At the idea stage a reference may not be processed OUT of `references/`. Observed live, twice:
    // the model generated a moodboard (which lands in `references/`), then "corrected" the location
    // with process_asset into `design/` and `fs_delete`d the original — so the artefact it had just
    // made vanished from the Files column, which is the only place the user looks for it. Refusing
    // is deterministic; the same instruction in a skill was read once and then outvoted by the
    // model's own earlier turn.
    if (
      this.flowStage.isIdeaStage() &&
      path.startsWith(`${REFERENCES_DIR}/`) &&
      !outName.startsWith(`${REFERENCES_DIR}/`)
    ) {
      return {
        ok: false,
        error:
          `At the idea stage every artefact lives in \`${REFERENCES_DIR}/\` — that is the folder ` +
          `the Files column lists, so moving "${path}" to "${outName}" would hide it from the ` +
          `user. Process it in place, or pass a name under \`${REFERENCES_DIR}/\`.`,
      };
    }

    const opened = await this.assetGen.open(path);
    const handleIds = new Set<string>([opened.id]);
    try {
      const processed = await this.assetGen.postProcess(opened.id, preset, { maxSize });
      handleIds.add(processed.id);
      const oriented = await this.applyOrientation(processed.id, args, id => handleIds.add(id));
      const saved = await this.assetGen.save(oriented, outName, {});
      const transparency = await this.assetGen.alphaStats(oriented);
      return {
        ok: true,
        saved,
        preset,
        transparency,
        note: `Processed "${path}" → "${saved.path}" with the "${preset}" preset. ${transparencyNote(preset, transparency)}`,
        ...(await this.previewImages(oriented)),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      for (const id of handleIds) {
        this.assetGen.discard(id);
      }
    }
  }

  // -- model lab (procedural 3D) ---------------------------------------------

  /**
   * Reconstruct a 3D model procedurally from a reference image via the Model Lab pipeline, save the
   * resulting GLB (+ spec/factory siblings) into the project, and return a JSON-safe summary. The
   * pipeline never throws — errors/cancellation surface through {@link Model3DGenService.getState};
   * everything else is wrapped so no exception escapes the handler.
   */
  private async generateModel3d(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      if (appState.project.status !== 'ready') {
        return { ok: false, error: 'No project is open — cannot generate a model.' };
      }
      const reference = asString(args.reference);
      const name = asString(args.name);
      const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
      const complexity: ComplexityHint =
        args.complexity === 'simple' ||
        args.complexity === 'moderate' ||
        args.complexity === 'complex'
          ? args.complexity
          : 'moderate';
      const mode: ModelGenMode | undefined =
        args.mode === 'fast' || args.mode === 'quality' ? args.mode : undefined;

      // Resolve the reference image into base64 (without the data: prefix) for the pipeline.
      let base64: string;
      let mimeType: string;
      try {
        const blob = await this.storage.readBlob(this.safePath(reference));
        base64 = await blobToBase64(blob);
        mimeType = blob.type || 'image/png';
      } catch (error) {
        return {
          ok: false,
          error: `Could not read reference image: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      await this.model3dGen.generate(
        { referenceImage: { mimeType, base64 }, prompt, complexity, mode },
        { autonomous: true }
      );

      const state = this.model3dGen.getState();
      if (state.status === 'error') {
        return { ok: false, error: state.error ?? 'generation failed' };
      }
      if (state.status === 'cancelled') {
        return { ok: false, error: 'cancelled' };
      }
      const group = this.model3dGen.getModel();
      if (!group) {
        return { ok: false, error: 'no model produced' };
      }

      const saved = await this.model3dExport.saveModel(group, name, {
        spec: state.spec,
        factoryCode: state.factoryCode,
      });

      // The last passed pass's score is the headline fidelity (null when review was disabled).
      const finalScore =
        [...state.passes].reverse().find(pass => pass.status === 'passed')?.score ?? null;
      // A previously-composited comparison sheet is a cheap, WebGL-free preview — attach it when one
      // exists (reviews may have been disabled, in which case there is none).
      const sheet =
        [...state.passes].reverse().find(pass => pass.sheetDataUrl)?.sheetDataUrl ?? null;
      let images: Record<string, unknown> = {};
      if (sheet) {
        const block = dataUrlToImageBlock(sheet);
        images = {
          [AGENT_TOOL_IMAGES_KEY]: [
            { mimeType: block.mimeType, data: block.data },
          ] satisfies AgentToolImage[],
        };
      }

      return {
        ok: true,
        saved: {
          path: saved.path,
          bytes: saved.bytes,
          sculptPath: saved.sculptPath,
          factoryPath: saved.factoryPath,
        },
        objectClass: state.assessment?.objectClass ?? state.spec?.objectClass ?? null,
        passes: state.passes.map(pass => ({ label: pass.label, score: pass.score })),
        finalScore,
        usage: state.usage,
        note: `Reconstructed "${saved.path}" procedurally from the reference image${
          saved.sculptPath ? ' (with .sculpt.json / .factory.ts siblings)' : ''
        }.`,
        ...images,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async generateScene3d(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      if (appState.project.status !== 'ready') {
        return { ok: false, error: 'No project is open — cannot generate a scene.' };
      }
      const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
      if (!brief) {
        return { ok: false, error: 'A non-empty brief is required.' };
      }
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        return { ok: false, error: 'A non-empty target scene name is required.' };
      }
      const mode: ModelGenMode | undefined =
        args.mode === 'fast' || args.mode === 'quality' ? args.mode : undefined;
      const baseScene =
        typeof args.baseScene === 'string' && args.baseScene.trim() ? args.baseScene : undefined;

      // Resolve reference images best-effort: skip any that fail to load rather than hard-failing.
      const referenceImages: ReferenceImageInput[] = [];
      if (Array.isArray(args.references)) {
        for (const entry of args.references) {
          if (typeof entry !== 'string' || !entry.trim()) {
            continue;
          }
          try {
            const blob = await this.storage.readBlob(this.safePath(entry));
            referenceImages.push({
              mimeType: blob.type || 'image/png',
              base64: await blobToBase64(blob),
            });
          } catch {
            // Best-effort: a single reference that cannot be read is dropped silently.
          }
        }
      }

      await this.sceneGen.generate(
        { brief, referenceImages, mode, baseScenePath: baseScene },
        { autonomous: true }
      );

      const state = this.sceneGen.getState();
      if (state.status === 'error') {
        return { ok: false, error: state.error ?? 'generation failed' };
      }
      if (state.status === 'cancelled') {
        return { ok: false, error: 'cancelled' };
      }
      if (!this.sceneGen.getSceneYaml()) {
        return { ok: false, error: 'no scene produced' };
      }

      const saved = await this.sceneGen.saveScene(name);

      // The last passed pass's score is the headline fidelity (null when review was disabled).
      const finalScore =
        [...state.passes].reverse().find(pass => pass.status === 'passed')?.score ?? null;
      // The last pass with a comparison sheet is a cheap, WebGL-free preview — attach it when one
      // exists (reviews may have been disabled, in which case there is none).
      const sheet =
        [...state.passes].reverse().find(pass => pass.sheetDataUrl)?.sheetDataUrl ?? null;
      let images: Record<string, unknown> = {};
      if (sheet) {
        const block = dataUrlToImageBlock(sheet);
        images = {
          [AGENT_TOOL_IMAGES_KEY]: [
            { mimeType: block.mimeType, data: block.data },
          ] satisfies AgentToolImage[],
        };
      }

      return {
        ok: true,
        saved: { path: saved.path },
        zones: state.levelSpec?.zones?.map(zone => zone.name) ?? [],
        passes: state.passes.map(pass => ({ label: pass.label, score: pass.score })),
        finalScore,
        paletteGaps: state.levelSpec?.paletteGaps ?? [],
        usage: state.usage,
        note: `Generated the level "${saved.path}" from the brief.`,
        ...images,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Apply optional `rotate` (90/180/270, clockwise) then `flip` ('horizontal'/'vertical') to an
   * image handle, returning the id of the final handle (the input id when neither is requested).
   * Each intermediate handle is registered via `track` so the caller frees it. Invalid values are
   * ignored rather than erroring — orientation is a best-effort refinement.
   */
  private async applyOrientation(
    handleId: string,
    args: Record<string, unknown>,
    track: (id: string) => void
  ): Promise<string> {
    let currentId = handleId;
    const rotate = asInt(args.rotate, 0);
    if (rotate === 90 || rotate === 180 || rotate === 270) {
      const rotated = await this.assetGen.rotate(currentId, (rotate / 90) as 1 | 2 | 3);
      track(rotated.id);
      currentId = rotated.id;
    }
    const flip = typeof args.flip === 'string' ? args.flip : '';
    if (flip === 'horizontal' || flip === 'vertical') {
      const flipped = await this.assetGen.flip(currentId, flip);
      track(flipped.id);
      currentId = flipped.id;
    }
    return currentId;
  }

  /** Build the `__images` payload from a 256px preview of a handle, for visual QC by the model. */
  private async previewImages(handleId: string): Promise<Record<string, unknown>> {
    const previewDataUrl = await this.assetGen.preview(handleId, 256);
    const comma = previewDataUrl.indexOf(',');
    const previewMime = previewDataUrl.slice(5, previewDataUrl.indexOf(';'));
    return {
      [AGENT_TOOL_IMAGES_KEY]: [
        { mimeType: previewMime, data: previewDataUrl.slice(comma + 1) },
      ] satisfies AgentToolImage[],
    };
  }

  // -- play mode / logs / errors --------------------------------------------

  private async playCommand(commandId: string): Promise<{ ok: boolean }> {
    // Starting/restarting needs an active scene; auto-open it (stop must keep working regardless).
    if (commandId !== 'game.stop') {
      await this.ensureActiveScene();
    }
    return { ok: await this.dispatcher.executeById(commandId) };
  }

  /**
   * play_start: no `scene` → legacy behavior (active scene via game.start);
   * with `scene` → play exactly that scene (game.start-scene), optionally
   * re-reading it from disk first so a graph opened before a script compile
   * (which silently drops user:* components) doesn't get cloned stale.
   */
  private async playStart(
    scene: string | undefined,
    reload: boolean
  ): Promise<{
    ok: boolean;
    scene?: string;
    reloaded?: boolean;
    alreadyRunning?: boolean;
    error?: string;
  }> {
    if (!scene) {
      // "Start" while the game is already running is not a failure — it is the normal state in
      // the Flow workspace, whose stage plays continuously. The old `ok:false` sent agents into a
      // stop→start dance that burned ~9 tool iterations of a single turn before any real work.
      if (appState.ui.isPlaying) {
        return { ok: true, alreadyRunning: true };
      }
      return this.playCommand('game.start');
    }
    let safe: string;
    try {
      safe = this.safePath(scene);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!safe.toLowerCase().endsWith('.pix3scene')) {
      return { ok: false, error: `Not a scene path: "${scene}" (expected a .pix3scene file)` };
    }
    let reloaded = false;
    if (reload) {
      reloaded = (await this.reloadSceneIfOpen(safe)) !== null;
    }
    // A named scene while something is already playing means "play THIS one now": stop first so
    // the start command's precondition passes, instead of reporting a failure the caller must
    // decode. Restarting the already-running scene is also what `reload` is asking for.
    if (appState.ui.isPlaying) {
      await this.dispatcher.executeById('game.stop');
    }
    const ok = await this.dispatcher.execute(new StartSceneGameCommand({ scenePath: safe }));
    return { ok, scene: safe, reloaded };
  }

  /**
   * `play_status` — is it playing, AND what did the last frame actually draw.
   *
   * The two extra blocks exist because of a session that spent ~20 steps on a black
   * 3D layer: a script had called `lookAt` on a `Camera3D` (a `Node3D` that merely
   * *holds* the three.js camera, so the object branch aimed its +Z at the target and
   * the real camera 180° away), and nothing an agent could call said "this frame drew
   * four objects out of thirty". `render` is that reading, and `visible3D` turns it
   * into a cause: a scene with meshes and zero of them in the frustum is an aiming
   * bug, not a missing-content one.
   *
   * Both blocks are read on demand from the live runtime, never from the Profiler panel's
   * sampling: that subscription is dropped in Vibe (nothing there can display it), and an
   * agent's picture of the running game must not change with the workspace the user
   * happens to be looking at.
   *
   * The runner comes from {@link GamePlaySessionService.getActiveRuntime} for the
   * reason spelled out on {@link gameTime}: it is the runtime the game is actually
   * being played in, tab host or popout.
   */
  private playStatus(): {
    isPlaying: boolean;
    playModeStatus: string;
    render?: {
      drawCalls: number;
      triangles: number;
      geometries: number;
      textures: number;
    };
    visible3D?: Visible3DSummary;
  } {
    const status = { isPlaying: appState.ui.isPlaying, playModeStatus: appState.ui.playModeStatus };
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return status;
    }
    // Straight off the renderer, not through ProfilerSessionService: the profiler holds its
    // per-frame subscription only while a panel can display it, so in Vibe every one of its
    // readings is null — and "what did the last frame draw" must answer the same in both
    // workspaces. The runner calls `beginStatsFrame()` before each render, so these counters
    // describe the last completed frame whenever they are read.
    const stats = runtime.renderer.getStatsSnapshot();
    return {
      ...status,
      render: {
        drawCalls: stats.calls,
        triangles: stats.triangles,
        geometries: stats.geometries,
        textures: stats.textures,
      },
      visible3D: summarizeVisible3D(runtime.runner),
    };
  }

  /**
   * `game_time` — read or replace the live runner's frame-driver contract, and
   * optionally step it.
   *
   * Three things here are load-bearing rather than incidental:
   *
   * 1. **The runner comes from {@link GamePlaySessionService.getActiveRuntime},**
   *    the same path `GameInputService` takes, so this tool sees exactly the
   *    runtime the game is being played in (tab host or popout) and reports "not
   *    attached yet" instead of acting on a stale one.
   * 2. **The config is validated before it is applied.**
   *    `resolveRuntimeTimeConfig` is pure and throws (`TypeError` on an unknown
   *    mode, `RangeError` on a non-positive `fixedDeltaSec`), so calling it first
   *    turns a thrown validator into a sentence the agent can act on and
   *    guarantees the runner is never left half-changed by a rejected call. The
   *    same applies to the `step`/mode pairing, which is checked before the write.
   * 3. **The reply echoes `getTimeMode()`, not the request** — resolved and
   *    clamped values — because "you asked for ×1000 and got ×240" is the kind of
   *    thing an agent otherwise discovers as an unexplained timing mystery.
   */
  private gameTime(args: Record<string, unknown>): {
    ok: boolean;
    error?: string;
    time?: Readonly<ResolvedRuntimeTimeConfig>;
    ticksExecuted?: number;
    paused?: boolean;
    running?: boolean;
    notes?: string[];
  } {
    if (!appState.ui.isPlaying) {
      return {
        ok: false,
        error:
          'The game is not running — game_time drives the LIVE runtime clock. Call play_start first.',
      };
    }
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return {
        ok: false,
        error: 'Play mode is starting but the runtime is not attached yet; retry in a moment.',
      };
    }
    const { runner } = runtime;
    const current = runner.getTimeMode();
    const notes: string[] = [];

    const wantsConfig = TIME_CONFIG_KEYS.some(key => args[key] !== undefined);
    if (wantsConfig && args.mode === undefined) {
      return {
        ok: false,
        error: `game_time replaces the whole time contract rather than merging into it, so \`mode\` is required whenever you change anything — an omitted field falls back to its default, not to the current value. Re-send with the mode included, e.g. {mode: 'fixed', ticksPerFrame: 4}. The clock is unchanged (${describeTimeMode(current)}).`,
        time: current,
      };
    }

    const step = args.step;
    if (step !== undefined && (typeof step !== 'number' || !Number.isInteger(step) || step < 1)) {
      return {
        ok: false,
        error: '`step` must be an integer >= 1 — the number of ticks to run.',
        time: current,
      };
    }

    // Validate (pure, throws) before writing anything to the runner.
    let resolved: ResolvedRuntimeTimeConfig | null = null;
    if (wantsConfig) {
      const requested: RuntimeTimeConfig = {
        mode: args.mode as RuntimeTimeMode,
        ...(typeof args.fixedDeltaSec === 'number' ? { fixedDeltaSec: args.fixedDeltaSec } : {}),
        ...(typeof args.ticksPerFrame === 'number' ? { ticksPerFrame: args.ticksPerFrame } : {}),
        ...(typeof args.renderEveryNTicks === 'number'
          ? { renderEveryNTicks: args.renderEveryNTicks }
          : {}),
        ...(typeof args.muteAudio === 'boolean' ? { muteAudio: args.muteAudio } : {}),
      };
      try {
        resolved = resolveRuntimeTimeConfig(requested);
      } catch (err) {
        return {
          ok: false,
          error: `game_time could not apply that time contract: ${
            err instanceof Error ? err.message : String(err)
          } The clock was left unchanged (${describeTimeMode(current)}).`,
          time: current,
        };
      }
      if (
        typeof args.ticksPerFrame === 'number' &&
        Math.round(args.ticksPerFrame) !== resolved.ticksPerFrame
      ) {
        notes.push(
          `ticksPerFrame ${args.ticksPerFrame} was clamped to ${resolved.ticksPerFrame} (allowed 1..${MAX_TICKS_PER_FRAME}).`
        );
      }
      if (
        typeof args.renderEveryNTicks === 'number' &&
        Math.round(args.renderEveryNTicks) !== resolved.renderEveryNTicks
      ) {
        notes.push(
          `renderEveryNTicks ${args.renderEveryNTicks} was clamped to ${resolved.renderEveryNTicks} (minimum 1).`
        );
      }
    }

    // `stepFrames` is a no-op outside 'manual' (the rAF loop is already producing
    // ticks). Refusing here, before the config write, keeps a rejected call from
    // leaving the clock in a mode the caller did not get to use.
    const effectiveMode: RuntimeTimeMode = resolved?.mode ?? current.mode;
    if (step !== undefined && effectiveMode !== 'manual') {
      const where =
        resolved === null
          ? `the game is currently in '${effectiveMode}'`
          : `this call asks for '${effectiveMode}'`;
      return {
        ok: false,
        error: `\`step\` only advances the game in 'manual' mode (${where}) — in the other modes the animation-frame loop is already producing ticks and a manual batch on top of it would double-step. Send {mode: 'manual', step: N} to step, then {mode: 'realtime'} to hand the game back.`,
        time: current,
      };
    }

    if (resolved) {
      runner.setTimeMode(resolved);
    }

    // Pause/resume goes through the host, not the runner: the editor re-applies
    // its own pause decision on every focus event, so a pause set behind its back
    // lasts until the next one. Applied before `step` so {paused: false, step: N}
    // reads as one intent.
    if (typeof args.paused === 'boolean') {
      this.playSession.setPauseRequested(args.paused);
      notes.push(
        args.paused
          ? 'The game is now paused and stays paused until you resume it (game_time {paused: false}), send input, or restart.'
          : 'The game was resumed.'
      );
    }

    let ticksExecuted: number | undefined;
    if (typeof step === 'number') {
      ticksExecuted = runner.stepFrames(step);
      if (ticksExecuted < step) {
        if (runner.paused) {
          notes.push(
            `Only ${ticksExecuted}/${step} ticks ran: the game is PAUSED, and a paused runner ignores stepFrames. Resume it first with game_time {paused: false} — game_run leaves the game paused on its outcome frame on purpose, and the pause is held until something asks for the opposite.`
          );
        } else if (!runner.running) {
          notes.push(`Only ${ticksExecuted}/${step} ticks ran: no scene is running.`);
        } else {
          notes.push(
            `Only ${ticksExecuted}/${step} ticks ran — the batch ended early, which is what happens when a tick throws. Check read_errors.`
          );
        }
      }
    }

    return {
      ok: true,
      time: runner.getTimeMode(),
      ...(ticksExecuted !== undefined ? { ticksExecuted } : {}),
      paused: runner.paused,
      running: runner.running,
      ...(notes.length ? { notes } : {}),
    };
  }

  /**
   * `game_trace` — one tool, three modes over one subject (a stored trace).
   *
   * Three separate tools would have made the agent choose a name before it knows
   * which half of the round trip it is in; the modes share the run spec, the
   * name, and the storage, so they share a tool.
   *
   * The handler stays a pass-through: `GameTestService.parseSpec` owns the run
   * spec's shape (the same parse `game_run` uses, so a spec that means one thing
   * there cannot mean another here) and `validateTrace` owns the feed's, which is
   * why the feed goes through it rather than through a second, drifting copy of
   * the same rules.
   */
  private async gameTrace(args: Record<string, unknown>): Promise<unknown> {
    const mode = args.mode;
    if (mode !== 'record' && mode !== 'replay' && mode !== 'list') {
      return {
        ok: false,
        error: "game_trace needs `mode`: 'record', 'replay' or 'list'.",
      };
    }
    this.ensureTraceStore();

    if (mode === 'list') {
      try {
        const traces = await this.gameTest.getTraceStore().list();
        return {
          ok: true,
          traces,
          ...(traces.length
            ? {}
            : {
                note: `No traces stored yet. Record one with game_trace {mode:'record', name:'…', until:[…]} — it lands in ${TRACE_DIRECTORY}/.`,
              }),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) {
      return {
        ok: false,
        error: `game_trace ${mode} needs \`name\` — the trace to ${mode === 'record' ? 'write' : 'replay'} (a bare name like "snake-eats", or the full ${TRACE_DIRECTORY}/<name>.trace.json path).`,
      };
    }

    if (mode === 'record') {
      const parsed = GameTestService.parseSpec(args);
      if ('error' in parsed) return { ok: false, error: parsed.error };
      const feed = parseTraceFeedArg(args.feed);
      if ('error' in feed) return { ok: false, error: feed.error };
      return this.gameTest.recordTrace(parsed.spec, {
        name,
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        ...(feed.events ? { feed: feed.events } : {}),
      });
    }

    // replay — the run spec is optional here: without `until` the trace's own
    // frame count is the budget and its assertions are not re-imposed, which is
    // what makes "replay it and tell me if the outcome moved" a one-argument call.
    const hasSpec = args.until !== undefined;
    let spec: GameRunSpec | undefined;
    if (hasSpec) {
      const parsed = GameTestService.parseSpec(args);
      if ('error' in parsed) return { ok: false, error: parsed.error };
      spec = parsed.spec;
    }
    const tolerance = parseToleranceArg(args.tolerance);
    if ('error' in tolerance) return { ok: false, error: tolerance.error };
    return this.gameTest.replayTrace(
      name,
      spec,
      tolerance.tolerance ? { tolerance: tolerance.tolerance } : undefined
    );
  }

  /**
   * `game_run {routine}` — execute a stored routine (§5.7).
   *
   * It refuses a call that also carries a predicate spec rather than quietly
   * preferring one: `until` and `routine` are two different experiments (a routine
   * brings its own steps *and* its own expectations), and silently dropping half of
   * what was asked for is how a session ends up believing it asserted something it
   * did not.
   */
  private async gameRoutine(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args.routine === 'string' ? args.routine.trim() : '';
    if (!name) {
      return {
        ok: false,
        error: `game_run \`routine\` must be the name of a stored routine, e.g. {routine: 'buy-item'} for ${ROUTINE_DIRECTORY}/buy-item.json.`,
      };
    }
    const conflicting = ['until', 'fail', 'watch', 'monkey', 'control', 'input'].filter(
      key => args[key] !== undefined
    );
    if (conflicting.length > 0) {
      return {
        ok: false,
        error: `game_run cannot combine \`routine\` with ${conflicting.map(key => `\`${key}\``).join(', ')}: a routine carries its own steps and its own \`expect\` list. Run the routine on its own, then judge whatever else you need with a second call.`,
      };
    }
    const routineArgs =
      typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : {};
    this.ensureRoutineStore();
    return this.gameTest.runRoutine(name, routineArgs);
  }

  /**
   * Point the trace store at the open project's files, or leave it in memory.
   *
   * Done here rather than in `GameTestService` because the file backend needs
   * `ProjectStorageService`, and the service deliberately does not depend on it —
   * the store is a seam it accepts, not a service it resolves. Re-checked on
   * every trace call because a project can be opened or closed between two of
   * them.
   *
   * It only ever replaces a store it recognises as one of its own two, so a
   * backend somebody else installed through `setTraceStore` (a spec's fake, a
   * future cloud store) survives untouched.
   */
  private ensureTraceStore(): void {
    const current = this.gameTest.getTraceStore();
    const projectOpen = appState.project.status === 'ready';
    if (projectOpen) {
      if (current instanceof InMemoryTraceStore) {
        this.gameTest.setTraceStore(new ProjectTraceStore(this.storage));
      }
      return;
    }
    // No project: a file store would write nowhere. Fall back rather than fail —
    // a record → replay round trip inside this session still works, and the tool
    // description says the traces do not survive a reload.
    if (current instanceof ProjectTraceStore) {
      this.gameTest.setTraceStore(new InMemoryTraceStore());
    }
  }

  /**
   * The same swap for the routine library. Separate from {@link ensureTraceStore}
   * only because the two stores are independent seams; the rule is identical, down
   * to never replacing a backend somebody else installed.
   */
  private ensureRoutineStore(): void {
    const current = this.gameTest.getRoutineStore();
    if (appState.project.status === 'ready') {
      if (current instanceof InMemoryRoutineStore) {
        this.gameTest.setRoutineStore(new ProjectRoutineStore(this.storage));
      }
      return;
    }
    if (current instanceof ProjectRoutineStore) {
      this.gameTest.setRoutineStore(new InMemoryRoutineStore());
    }
  }

  /**
   * The same swap for the bot policies, plus the one thing they need that the other
   * two do not: somewhere to write the authoring declarations.
   *
   * A policy is TypeScript that a human and a model both read in an editor, so the
   * host drops `design/tests/bots/pix3-test-bot.d.ts` next to it on the first
   * successful compile — and it can only do that while a project is open, which is
   * why the writer is cleared alongside the store rather than kept pointing at a
   * project that closed.
   */
  private ensureBotStore(): void {
    const current = this.gameTest.getBotStore();
    if (appState.project.status === 'ready') {
      if (current instanceof InMemoryBotStore) {
        this.gameTest.setBotStore(new ProjectBotStore(this.storage));
      }
      this.botHost.setDeclarationWriter(this.storage);
      return;
    }
    if (current instanceof ProjectBotStore) {
      this.gameTest.setBotStore(new InMemoryBotStore());
    }
    this.botHost.setDeclarationWriter(null);
  }

  /**
   * The same swap for the run-protocol reports, with one difference that matters:
   * the fallback is `null`, not an in-memory store. A protocol the agent is told to
   * `fs_read` and cannot read is worse than an admitted absence, so with no project
   * open the run reports that the full protocol was lost instead of pointing at a
   * file nobody can open.
   */
  private ensureProtocolStore(): void {
    const current = this.gameTest.getProtocolStore();
    if (appState.project.status === 'ready') {
      if (current === null) {
        this.gameTest.setProtocolStore(new ProjectReportStore(this.storage));
      }
      return;
    }
    if (current instanceof ProjectReportStore) {
      this.gameTest.setProtocolStore(null);
    }
  }

  private readLogs(
    since?: number
  ): Array<{ level: string; message: string; timestamp: number; source?: string }> {
    let logs = this.logger.getLogs();
    if (typeof since === 'number') {
      logs = logs.filter(entry => entry.timestamp > since);
    }
    return logs.slice(-MAX_LOG_ENTRIES).map(entry => ({
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
      ...(entry.source ? { source: entry.source } : {}),
    }));
  }

  private readErrors(): ReturnType<typeof capturedErrors> {
    return capturedErrors();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Validate a `game_trace` feed.
 *
 * The per-event rules (a frame >= 1, the key/pointer shapes, unknown fields
 * dropped) already exist in `validateTrace`, so the feed is wrapped in the
 * minimal trace shape that validator accepts and handed to it. A second
 * hand-written copy of those rules here would be one refactor away from
 * disagreeing with the file format about what a valid event is — and the failure
 * would look like the game ignoring input.
 */
function parseTraceFeedArg(raw: unknown): { events?: TraceEvent[] } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) {
    return {
      error:
        "`feed` must be an array of frame-denominated events, e.g. [{frame:1, kind:'key', phase:'down', code:'ArrowLeft'}, {frame:9, kind:'key', phase:'up', code:'ArrowLeft'}].",
    };
  }
  if (raw.length === 0) return {};
  const parsed = validateTrace({
    formatVersion: TRACE_FORMAT_VERSION,
    events: raw,
    // Not part of a feed; stubs only so the shared validator reaches the event
    // checks, which are the reason this goes through it at all.
    env: {},
    outcome: {},
  });
  if ('error' in parsed) {
    return { error: `game_trace \`feed\`: ${parsed.error.replace(/^events\[/, 'item [')}` };
  }
  return { events: parsed.trace.events };
}

/** Validate the optional `tolerance` override of a replay. */
function parseToleranceArg(
  raw: unknown
): { tolerance?: Partial<TraceTolerance> } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      error: '`tolerance` must be an object: {framePct?, frameAbs?, valuePct?, valueAbs?}.',
    };
  }
  const record = raw as Record<string, unknown>;
  const tolerance: Partial<TraceTolerance> = {};
  for (const key of ['framePct', 'frameAbs', 'valuePct', 'valueAbs'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { error: `\`tolerance.${key}\` must be a number >= 0.` };
    }
    tolerance[key] = value;
  }
  return Object.keys(tolerance).length ? { tolerance } : {};
}

/** `play_status.visible3D` — "does the active camera see anything", answered with numbers. */
interface Visible3DSummary {
  /** Name of the `Camera3D` the 3D pass renders through, or null when the scene has none. */
  camera: string | null;
  /** three.js meshes living under `Node3D` nodes of the running clone. */
  meshCount: number;
  /** How many of those pass a frustum test against the active camera, right now. */
  inFrustum: number;
  /**
   * How many of those have their CENTRE inside the projected image.
   *
   * The frustum test alone is too forgiving to answer "is the screen black": it uses each
   * mesh's bounding SPHERE, so one big flat object — a ground plane is the usual one —
   * keeps clipping a corner of the frustum from a camera that is pointed the other way.
   * Measured on the scene this was built for: a camera turned 180° off the content still
   * scored `inFrustum: 1` (the ground) while the renderer drew 4 calls of pure HUD. Centres
   * are the cruder test and the honest one here — `onScreen: 0` across a whole scene is
   * what a black frame actually looks like.
   */
  onScreen: number;
  /** Present only when there IS 3D content and effectively none of it is in view. */
  hint?: string;
}

/**
 * Count the running clone's 3D meshes and how many the active camera can currently see.
 *
 * Written against the live graph rather than the authored scene on purpose: the whole
 * point is to catch a camera a *script* turned. Matrices are forced up to date first —
 * a paused or background-tab runner may not have painted since the last mutation, and a
 * stale `matrixWorld` would answer about the frame before the bug.
 */
function summarizeVisible3D(runner: SceneRunner): Visible3DSummary {
  const roots = runner.getLiveRootNodes();
  for (const root of roots) {
    root.updateMatrixWorld(true);
  }
  const meshes = collect3DMeshes(roots);
  const cameraNode = runner.getActiveCamera3D();
  if (!cameraNode) {
    return {
      camera: null,
      meshCount: meshes.length,
      inFrustum: 0,
      onScreen: 0,
      ...(meshes.length > 0
        ? {
            hint: 'The scene has 3D meshes but no ACTIVE Camera3D, so the 3D pass draws nothing — add a Camera3D (or make one current) and re-check.',
          }
        : {}),
    };
  }
  // The inner camera, not the node: the node is a plain Node3D holding it, and the
  // frustum is defined by the camera's own projection and world matrices.
  const camera = cameraNode.camera;
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  );
  // `intersectsObject` computes a missing geometry bounding sphere itself and applies
  // the mesh's world matrix to it — the world-space test we want, without a copy here.
  const inFrustum = meshes.reduce(
    (count, mesh) => count + (frustum.intersectsObject(mesh) ? 1 : 0),
    0
  );
  const viewProjection = new Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  const centre = new Vector3();
  const onScreen = meshes.reduce((count, mesh) => {
    mesh.getWorldPosition(centre).applyMatrix4(viewProjection);
    const inside =
      Math.abs(centre.x) <= 1 && Math.abs(centre.y) <= 1 && centre.z >= -1 && centre.z <= 1;
    return count + (inside ? 1 : 0);
  }, 0);
  return {
    camera: cameraNode.name || cameraNode.nodeId,
    meshCount: meshes.length,
    inFrustum,
    onScreen,
    // Either counter reaching zero means the frame has no 3D in it; see `onScreen` for why
    // the frustum count alone would have missed the case this was built for.
    ...(meshes.length > 0 && (inFrustum === 0 || onScreen === 0)
      ? {
          hint: `${meshes.length} 3D meshes exist and NONE of them land on screen through ${cameraNode.name || 'the camera'} (inFrustum ${inFrustum}, onScreen ${onScreen}) — in order of likelihood: the camera is aimed away from the content (read \`forward\` on it via game_observe and compare it with where the meshes are; when a script aims the camera at runtime, \`forward\` and the authored rotation from node_inspect disagree and that disagreement IS the bug), the content is behind \`near\` or beyond \`far\`, or it sits off to one side.`,
        }
      : {}),
  };
}

/**
 * Every three.js `Mesh` whose nearest node ancestor is a `Node3D`.
 *
 * The 2D layer is meshes too (quads for sprites and labels), so counting `Mesh`
 * instances alone would report a 2D-only HUD as "3D content that the camera cannot
 * see" — the exact wrong diagnosis for a black 3D pass with a working HUD.
 */
function collect3DMeshes(roots: readonly NodeBase[]): Mesh[] {
  const meshes: Mesh[] = [];
  const visit = (object: Object3D, under3D: boolean): void => {
    const inside = object instanceof NodeBase ? object instanceof Node3D : under3D;
    if (inside && object instanceof Mesh) {
      meshes.push(object);
    }
    for (const child of object.children) {
      visit(child, inside);
    }
  };
  for (const root of roots) {
    visit(root, false);
  }
  return meshes;
}

const isCommandAllowed = (commandId: string): boolean =>
  RUN_COMMAND_ALLOWED_PREFIXES.some(prefix => commandId.startsWith(prefix));

const isTextPath = (path: string): boolean => {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return TEXT_EXTENSIONS.has(ext);
};

/** Count non-overlapping occurrences of `needle` in `haystack` (matches split/join semantics). */
const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

/**
 * Re-punctuate `text` with the line endings `content` actually uses.
 *
 * A model writes `\n`. A file checked out on Windows (and every `.pix3scene` written by an editor
 * running there) holds `\r\n`, so a multi-line anchor never matches and `str_replace` refuses the
 * edit — measured live: the agent gave up on targeted edits and rewrote a whole `main.pix3scene`
 * instead, which is exactly the blind full-file rewrite `str_replace` exists to prevent.
 *
 * The conversion runs both ways (an anchor copied out of a CRLF file into an LF file has the same
 * problem mirrored) and is decided by the file, never by the anchor: whatever the file uses is what
 * the replacement is written with, so a targeted edit can never leave a line ending behind that
 * differs from the rest of the file.
 */
const toFileLineEndings = (text: string, content: string): string => {
  if (!text.includes('\n')) {
    return text;
  }
  const crlf = countOccurrences(content, '\r\n');
  // A file with no newline at all (a one-line scene, a fresh script) has no convention to honour —
  // leave the text as the caller wrote it rather than guessing.
  const lf = countOccurrences(content, '\n');
  if (lf === 0) {
    return text;
  }
  const normalized = text.replace(/\r\n/g, '\n');
  return crlf > lf - crlf ? normalized.replace(/\n/g, '\r\n') : normalized;
};

/**
 * Verbatim slice of `text` around the byte range [from, to), widened to whole lines plus
 * {@link STR_REPLACE_CONTEXT_LINES} on each side. Returned after a successful str_replace so the
 * agent can anchor its NEXT edit on lines it just received instead of re-reading the file — the
 * measured cost of the alternative was six full re-reads of one 15.4 KB scene in a single turn.
 *
 * Context lines are dropped from the outside in until the slice fits {@link
 * STR_REPLACE_CONTEXT_CHARS}; the text stays byte-exact (never elided mid-line), so it is always
 * safe to copy into the next `old_string`. Returns null when even the edited lines alone exceed the
 * cap — better no context than context the agent cannot trust as verbatim.
 */
const sliceEditContext = (
  text: string,
  from: number,
  to: number
): { startLine: number; endLine: number; text: string } | null => {
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1; // + '\n'
  }
  const lineOf = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const coreFirst = lineOf(from);
  const coreLast = lineOf(Math.max(from, to - 1));
  for (let pad = STR_REPLACE_CONTEXT_LINES; pad >= 0; pad -= 1) {
    const first = Math.max(0, coreFirst - pad);
    const last = Math.min(lines.length - 1, coreLast + pad);
    const slice = lines.slice(first, last + 1).join('\n');
    if (slice.length <= STR_REPLACE_CONTEXT_CHARS || pad === 0) {
      return pad === 0 && slice.length > STR_REPLACE_CONTEXT_CHARS
        ? null
        : { startLine: first + 1, endLine: last + 1, text: slice };
    }
  }
  return null;
};

/**
 * The `role` a generation declares, or undefined for "let the index guess from the name".
 *
 * Validated against the roles the references index understands rather than trusted: an unknown
 * string would be written into `index.json` and come back as a role chip nothing can render.
 */
const asReferenceRole = (value: unknown): FlowReferenceRole | undefined => {
  const roles: readonly FlowReferenceRole[] = ['style', 'content', 'layout', 'style-candidate'];
  return typeof value === 'string' && roles.includes(value as FlowReferenceRole)
    ? (value as FlowReferenceRole)
    : undefined;
};

const asString = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error(`Expected a string argument, got ${typeof value}.`);
  }
  return value;
};

/** Which surface a screenshot tool captures. */
type AgentCaptureSource = 'auto' | 'game' | 'editor';

// Lenient on junk values (providers do send them for enum params): fall back to 'auto'.
const asCaptureSource = (value: unknown): AgentCaptureSource =>
  value === 'game' || value === 'editor' ? value : 'auto';

const asInt = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  // Gemini returns enum-constrained numeric params as strings (its schema enum is string-only), so
  // a `rotate: "90"` must still parse back to 90 rather than falling through to the default.
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

/** Same as {@link parseVector2} for 3D types — `{x,y,z}` or `[x,y,z]`. */
const parseVector3 = (value: unknown): Vector3 | undefined => {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.slice(0, 3).every(entry => typeof entry === 'number')
  ) {
    return new Vector3(value[0] as number, value[1] as number, value[2] as number);
  }
  if (value && typeof value === 'object') {
    const v = value as { x?: unknown; y?: unknown; z?: unknown };
    if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
      return new Vector3(v.x, v.y, v.z);
    }
  }
  return undefined;
};

/** Parse an agent-supplied 2D position ({x,y} object or [x,y] array) into a Vector2, or undefined. */
const parseVector2 = (value: unknown): Vector2 | undefined => {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    return new Vector2(value[0], value[1]);
  }
  if (value && typeof value === 'object') {
    const v = value as { x?: unknown; y?: unknown };
    if (typeof v.x === 'number' && typeof v.y === 'number') {
      return new Vector2(v.x, v.y);
    }
  }
  return undefined;
};

const ASSET_PRESETS: readonly AssetPostProcessPreset[] = ['sprite', 'icon', 'texture', 'none'];

/** Coerce a tool argument to a known post-processing preset, else the supplied fallback. */
const resolvePreset = (value: unknown, fallback: AssetPostProcessPreset): AssetPostProcessPreset =>
  typeof value === 'string' && (ASSET_PRESETS as readonly string[]).includes(value)
    ? (value as AssetPostProcessPreset)
    : fallback;

/**
 * A note the model can trust for transparency — because vision models CANNOT judge it (a
 * transparent PNG is flattened onto white before they see it). The `hasAlpha` fact is measured
 * from the alpha channel, so the model must not re-check transparency via analyze_image.
 */
const transparencyNote = (preset: AssetPostProcessPreset, alpha: AlphaStats): string => {
  const base = `Saved with the "${preset}" preset. A 256px preview is attached.`;
  if (preset === 'sprite' || preset === 'icon') {
    return alpha.hasAlpha
      ? `${base} The background WAS removed — the PNG has a transparent background (${Math.round(alpha.transparentFraction * 100)}% transparent pixels, measured from the alpha channel). Do NOT use analyze_image to check transparency: vision models see transparent pixels as white and will wrongly report a white background.`
      : `${base} Warning: no transparency was detected in the result — background removal may have failed. You can retry with process_asset.`;
  }
  return base;
};

/** Split a `data:<mime>;base64,<data>` URL into an inline image block (base64 without the prefix). */
const dataUrlToImageBlock = (dataUrl: string): LlmImageBlock => {
  const comma = dataUrl.indexOf(',');
  const semi = dataUrl.indexOf(';');
  const mimeType = comma > 5 && semi > 5 && semi < comma ? dataUrl.slice(5, semi) : 'image/png';
  return { type: 'image', mimeType, data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
};
