/**
 * Dev-only debugging bridge for AI agents (and humans) driving a *running*
 * editor through Chrome DevTools (e.g. the `chrome-devtools` MCP).
 *
 * It is NOT a feature of the editor and never ships to production: `main.ts`
 * only imports it behind `import.meta.env.DEV`, so the whole module (and its
 * imports) is dead-code-eliminated from the prod PWA bundle.
 *
 * The contract: an external tool calls `evaluate_script` against the live page
 * and pokes `window.__PIX3_DEBUG__`. Every method returns plain,
 * JSON-serialisable data — Three.js `Object3D`s and Valtio proxies are
 * circular and huge, so we hand back curated DTOs instead of live objects.
 *
 * The serialisation/introspection primitives (DTOs, `safeSerialize`, error ring
 * buffer) live in the production-safe `agent-introspection` module and are
 * shared with the in-editor AI agent's tool layer — this bridge just wires them
 * to `window`.
 *
 * Mutations go through the normal mutation gateway (`CommandDispatcher`), so
 * they stay consistent and land in undo/redo — never poke `appState` or nodes
 * directly from here.
 */
import { ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { resolveCommandDispatcher } from '@/services/core/CommandDispatcher';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { StartSceneGameCommand } from '@/features/scripts/StartSceneGameCommand';
import { AssetGenService } from '@/services/image-gen/AssetGenService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { blobToBase64 } from '@/services/image-gen/image-ops';
import { Model3DGenService } from '@/services/model-gen/Model3DGenService';
import { Model3DGenHistoryService } from '@/services/model-gen/Model3DGenHistoryService';
import { Scene3DGenService } from '@/services/model-gen/scene/Scene3DGenService';
import type { SceneGenState } from '@/services/model-gen/scene/scene-gen-types';
import type {
  ComplexityHint,
  ModelGenMode,
  ModelGenState,
  ReferenceImageInput,
} from '@/services/model-gen/model-gen-types';
import type { SculptSpec } from '@/services/model-gen/SculptSpec';
import { AgentToolRegistry } from '@/services/agent/AgentToolRegistry';
import { AgentChatService, type AgentChatState } from '@/services/agent/AgentChatService';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { AgentVisionService, type VisionHelperInfo } from '@/services/agent/AgentVisionService';
import { AgentAdvisorService, type AdvisorInfo } from '@/services/agent/AgentAdvisorService';
import { toBlocks, type LlmMessage } from '@/services/llm/LlmTypes';
import type {
  AssetGenBgOptions,
  AssetGenCompressOptions,
  AssetGenGenerateOptions,
  AssetGenResizeOptions,
  AssetGenSaveOptions,
  AssetGenSaveResult,
  AssetGenStatus,
  AssetImageMeta,
} from '@/services/image-gen/AssetGenService';
import type { CropRectPixels } from '@/services/image-gen/image-ops';
import {
  clearErrors,
  errors,
  flattenLive,
  installErrorCapture,
  liveObjectToDTO,
  nodeToDTO,
  componentToDTO,
  safeSerialize,
  type CapturedError,
  type ComponentDTO,
  type Json,
  type LiveObjectDTO,
  type NodeDTO,
  type NodeSummary,
  type Object3DLike,
} from '@/core/agent-introspection';
import {
  runEvalSpec,
  EVAL_CHECK_KINDS,
  type EvalHarness,
  type EvalReport,
  type EvalSpec,
} from '@/core/agent-eval';
import {
  SceneManager,
  NodeBase,
  getGameDebug,
  getRuntimeSceneRoot,
  getPhysicsDebugSource,
  isPhysicsDebugEnabled,
} from '@pix3/runtime';

// ---------------------------------------------------------------------------
// Service access helpers
// ---------------------------------------------------------------------------

type Ctor<T = unknown> = new (...args: never[]) => T;

function service<T>(ctor: Ctor<T>): T {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
}

function activeGraph() {
  return service<SceneManager>(SceneManager).getActiveSceneGraph();
}

/**
 * The topmost live Object3D ancestor of the scene (the THREE.Scene root). Climb
 * from a NodeBase root so objects added straight to the scene root (e.g. game
 * droppable sprites) are reachable, not just the authored NodeBase tree.
 */
function liveSceneRoot(): Object3DLike | null {
  // During play the game runs on an isolated CLONE in SceneRunner's own scene —
  // spawned objects (droppables, falling clusters) live there, NOT in the
  // authored graph. Prefer the live runtime root when a scene is running.
  const runtimeRoot = getRuntimeSceneRoot() as Object3DLike | null;
  if (runtimeRoot) return runtimeRoot;

  // Fallback (edit mode / no runtime): climb from the authored NodeBase graph.
  const graph = activeGraph();
  if (!graph) return null;
  type Linked = Object3DLike & { parent?: Linked | null };
  const first = graph.rootNodes[0] as unknown as Linked | undefined;
  if (!first) return null;
  let node: Linked = first;
  let guard = 0;
  while (node.parent && guard++ < 64) {
    node = node.parent;
  }
  return node;
}

/** Case-insensitive scene search across node name + type (shared by `find` and the eval harness). */
function findNodeSummaries(text: string): NodeSummary[] {
  const graph = activeGraph();
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

// ---------------------------------------------------------------------------
// Model Lab (procedural 3D) helpers
// ---------------------------------------------------------------------------

/** Options accepted by the `model3d` lane for supplying a reference image + run knobs. */
interface Model3dRunOptions {
  referencePath?: string;
  referenceBase64?: string;
  mimeType?: string;
  prompt?: string;
  complexity?: string;
  mode?: string;
}

/** A JSON-safe row of Model Lab history (Blobs in the record are intentionally dropped). */
interface ModelGenHistoryRow {
  id: string;
  createdAt: number;
  objectClass: string;
  prompt: string | null;
  complexity: ComplexityHint;
  mode: ModelGenMode;
  finalScore: number | null;
  savedPath: string | null;
  passes: Array<{ id: string; label: string; score: number | null }>;
}

const MODEL_COMPLEXITIES: readonly string[] = ['simple', 'moderate', 'complex'];

const asComplexity = (value: string | undefined): ComplexityHint | undefined =>
  value && MODEL_COMPLEXITIES.includes(value) ? (value as ComplexityHint) : undefined;

const asMode = (value: string | undefined): ModelGenMode | undefined =>
  value === 'fast' || value === 'quality' ? value : undefined;

/**
 * Resolve a reference image for the Model Lab pipeline: read a project asset when `referencePath` is
 * given, else use an inline `referenceBase64` (+ `mimeType`), else null (spec-only / no-review run).
 */
async function resolveModelReference(opts: Model3dRunOptions): Promise<ReferenceImageInput | null> {
  if (opts.referencePath) {
    const path = opts.referencePath.replace(/^res:\/\//i, '').replace(/^\/+/, '');
    const blob = await service<ProjectStorageService>(ProjectStorageService).readBlob(path);
    return { mimeType: blob.type || 'image/png', base64: await blobToBase64(blob) };
  }
  if (opts.referenceBase64) {
    return { mimeType: opts.mimeType || 'image/png', base64: opts.referenceBase64 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model Lab (Scene lane) helpers
// ---------------------------------------------------------------------------

/** Options accepted by the `scene3d` lane for a run. */
interface Scene3dRunOptions {
  brief: string;
  referencePaths?: string[];
  baseScenePath?: string;
  mode?: string;
}

/**
 * Resolve a list of project asset paths into reference images for the Scene lane, best-effort: a path
 * that cannot be read is skipped rather than failing the whole run (mirrors the agent tool).
 */
async function resolveSceneReferences(paths: string[] | undefined): Promise<ReferenceImageInput[]> {
  if (!paths || paths.length === 0) {
    return [];
  }
  const storage = service<ProjectStorageService>(ProjectStorageService);
  const out: ReferenceImageInput[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) {
      continue;
    }
    const path = raw.replace(/^res:\/\//i, '').replace(/^\/+/, '');
    try {
      const blob = await storage.readBlob(path);
      out.push({ mimeType: blob.type || 'image/png', base64: await blobToBase64(blob) });
    } catch {
      // Best-effort: skip an unreadable reference.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent-eval surface types
// ---------------------------------------------------------------------------

/** JSON-safe snapshot of the in-editor agent chat after a turn. */
export interface AgentStateSummary {
  status: string;
  errorKind: string | null;
  errorMessage: string | null;
  notice: string | null;
  activeTool: string | null;
  messageCount: number;
  totalUsage: { inputTokens?: number; outputTokens?: number };
  /** Text of the most recent assistant message (null if none). */
  lastAssistant: string | null;
}

/** One conversation turn, flattened for eval inspection. */
export interface AgentTranscriptEntry {
  role: string;
  texts: string[];
  toolCalls: Array<{ name: string; input: unknown }>;
  toolResults: Array<{ name: string | null; isError: boolean; preview: string }>;
}

const agentTextOf = (message: LlmMessage): string =>
  toBlocks(message.content)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

const summarizeAgentState = (state: AgentChatState): AgentStateSummary => {
  const lastAssistant = [...state.messages].reverse().find(m => m.role === 'assistant');
  return {
    status: state.status,
    errorKind: state.errorKind,
    errorMessage: state.errorMessage,
    notice: state.notice,
    activeTool: state.activeTool,
    messageCount: state.messages.length,
    totalUsage: state.totalUsage,
    lastAssistant: lastAssistant ? agentTextOf(lastAssistant) : null,
  };
};

const agentTranscript = (
  messages: readonly LlmMessage[],
  limit?: number
): AgentTranscriptEntry[] => {
  const sliced = limit && limit > 0 ? messages.slice(-limit) : messages;
  return sliced.map(message => {
    const entry: AgentTranscriptEntry = {
      role: message.role,
      texts: [],
      toolCalls: [],
      toolResults: [],
    };
    for (const block of toBlocks(message.content)) {
      if (block.type === 'text') {
        entry.texts.push(block.text);
      } else if (block.type === 'tool-use') {
        entry.toolCalls.push({ name: block.name, input: block.input });
      } else if (block.type === 'tool-result') {
        entry.toolResults.push({
          name: block.toolName ?? null,
          isError: !!block.isError,
          preview: block.content.slice(0, 300),
        });
      }
    }
    return entry;
  });
};

/** Live-service implementation of the eval-scorecard harness (see `agent-eval.ts`). */
function createEvalHarness(): EvalHarness {
  return {
    executeTool(name, args) {
      return service<AgentToolRegistry>(AgentToolRegistry).execute(name, args ?? {});
    },
    toolCalls() {
      const calls: Array<{ name: string; input: unknown }> = [];
      for (const message of service<AgentChatService>(AgentChatService).getState().messages) {
        if (message.role !== 'assistant') continue;
        for (const block of toBlocks(message.content)) {
          if (block.type === 'tool-use') {
            calls.push({ name: block.name, input: block.input });
          }
        }
      }
      return calls;
    },
    agentSummary() {
      const state = service<AgentChatService>(AgentChatService).getState();
      return {
        status: state.status,
        notice: state.notice,
        messageCount: state.messages.length,
        inputTokens: state.totalUsage.inputTokens,
        outputTokens: state.totalUsage.outputTokens,
      };
    },
    findNodes(query) {
      return findNodeSummaries(query);
    },
    nodeDetail(nodeId) {
      const node = activeGraph()?.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) return null;
      return {
        properties: nodeToDTO(node, 0).properties,
        components: node.components.map((c, i) => {
          const dto = componentToDTO(c, i);
          return { className: dto.className, scriptId: dto.scriptId };
        }),
      };
    },
    errors() {
      return errors().map(e => ({ source: e.source, message: e.message }));
    },
    clearErrors() {
      clearErrors();
    },
    isPlaying() {
      return appState.ui.isPlaying;
    },
    async imageStats(path) {
      const assets = service<AssetGenService>(AssetGenService);
      try {
        const meta = await assets.open(path);
        try {
          const stats = await assets.alphaStats(meta.id);
          return {
            width: meta.width,
            height: meta.height,
            bytes: meta.bytes,
            hasAlpha: stats.hasAlpha,
            transparentFraction: stats.transparentFraction,
          };
        } finally {
          assets.discard(meta.id);
        }
      } catch {
        return null;
      }
    },
    wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },
  };
}

// ---------------------------------------------------------------------------
// The bridge API
// ---------------------------------------------------------------------------

export interface Pix3DebugBridge {
  readonly version: number;
  /** Quick description of the available API (handy for an agent to read first). */
  help(): Record<string, string>;

  // --- read ---
  /** Active scene as a DTO tree, expanded up to `maxDepth` levels. */
  scene(maxDepth?: number): (NodeDTO & { sceneVersion: string }) | null;
  /** Full detail of one node (transform, properties, components). */
  node(nodeId: string): NodeDTO | null;
  /** Case-insensitive search across node name + type. */
  find(text: string): NodeSummary[];
  /** Current selection (node IDs only — resolve detail with `node(id)`). */
  selection(): { nodeIds: string[]; primaryNodeId: string | null; hoveredNodeId: string | null };

  /**
   * Live Three.js object tree under the scene roots — the *actual* render
   * hierarchy during play, including raw sprites/meshes/instanced-meshes that
   * games spawn outside the NodeBase graph (which `scene()` cannot see).
   */
  liveScene(maxDepth?: number): { roots: LiveObjectDTO[] } | null;
  /**
   * Search the live object tree by name/type substring, or the token
   * `'droppable'` to list every object tagged with a `droppableItemRef`.
   */
  liveFind(query: string, limit?: number): LiveObjectDTO[];

  /**
   * Summary of the live physics-debug source (collider wireframe geometry the
   * running game exposes). Counts only — the raw Float32Array buffers stay live
   * for per-frame rendering and are not serialised here. Null if no source.
   */
  physicsDebug(): {
    available: boolean;
    /** Whether the collider wireframe overlay is currently toggled on. */
    enabled: boolean;
    bodies: number | null;
    vertexCount: number;
    segments: number;
  } | null;

  // --- play mode (through commands → keeps appState.ui in sync + undoable) ---
  readonly play: {
    status(): { isPlaying: boolean; playModeStatus: string };
    /**
     * Start play mode. Without an argument plays the active scene
     * (`game.start`); with a scene path (`res://` or project-relative
     * `.pix3scene`) plays exactly that scene (`game.start-scene`).
     */
    start(scenePath?: string): Promise<boolean>;
    stop(): Promise<boolean>;
    restart(): Promise<boolean>;
  };

  // --- mutate (through the gateway) ---
  /**
   * Edit a node property via UpdateObjectPropertyCommand (lands in undo). While
   * a scene is playing, the edit also hot-reloads onto the running clone by
   * `nodeId` within one frame — handy for live-tuning without a restart.
   */
  setProperty(args: { nodeId: string; propertyPath: string; value: unknown }): Promise<boolean>;
  /** Run any registered command by id (e.g. 'history.undo'). */
  command(commandId: string): Promise<boolean>;

  // --- components / errors ---
  components(nodeId: string): ComponentDTO[];
  errors(): CapturedError[];
  clearErrors(): void;

  /**
   * Headless AI asset pipeline (through {@link AssetGenService}) — generate, transform, and save
   * images programmatically using the user's saved (encrypted) API key. Every method returns
   * JSON-safe metadata (an image `id` + dimensions/bytes), never a blob, so results round-trip
   * through `evaluate_script`. Reuse an `id` across calls; fetch a `data:` URL for visual QC with
   * `preview(id)`.
   */
  readonly assets: {
    /** Provider/model/key/project status + selected model capabilities. */
    status(providerId?: string): Promise<AssetGenStatus>;
    /** Generate an image from a prompt (+ optional reference res:// paths). Returns a new handle. */
    generate(options: AssetGenGenerateOptions): Promise<AssetImageMeta>;
    /** Downscale/resize a handle (longest-edge `maxSize`, or explicit `width`/`height`). */
    resize(id: string, options: AssetGenResizeOptions): Promise<AssetImageMeta>;
    /** Crop a pixel rectangle `{x,y,width,height}` out of a handle. */
    crop(
      id: string,
      rect: CropRectPixels,
      format?: 'image/png' | 'image/jpeg' | 'image/webp'
    ): Promise<AssetImageMeta>;
    /** Re-encode a handle to a smaller format (default WebP q0.85), optionally downscaling too. */
    compress(id: string, options?: AssetGenCompressOptions): Promise<AssetImageMeta>;
    /** Remove the background of a handle (local Web Worker; transparent PNG out). */
    removeBackground(id: string, options?: AssetGenBgOptions): Promise<AssetImageMeta>;
    /** Rotate a handle clockwise (1 = 90°, 2 = 180°, 3 = 270°). Returns a new handle. */
    rotate(id: string, quarterTurns: 1 | 2 | 3): Promise<AssetImageMeta>;
    /** Mirror a handle horizontally or vertically. Returns a new handle. */
    flip(id: string, axis: 'horizontal' | 'vertical'): Promise<AssetImageMeta>;
    /** Load an existing project asset into a handle for editing. */
    open(pathOrRef: string): Promise<AssetImageMeta>;
    /** Metadata for one handle, or null. */
    get(id: string): AssetImageMeta | null;
    /** All live handles this session (newest first). */
    list(): AssetImageMeta[];
    /** `data:` URL preview of a handle, downscaled to `maxSize` (px, longest edge) for QC. */
    preview(id: string, maxSize?: number): Promise<string>;
    /** Save a handle into the project (creates dirs; optional resize/re-encode). */
    save(id: string, name: string, options?: AssetGenSaveOptions): Promise<AssetGenSaveResult>;
    /** Recent generations from the IndexedDB cache (metadata only). */
    history(limit?: number): Promise<
      Array<{
        id: string;
        prompt: string;
        providerId: string;
        modelId: string;
        mimeType: string;
        width?: number;
        height?: number;
        createdAt: number;
      }>
    >;
    /** Pull a cached generation into a working handle. */
    openHistory(recordId: string): Promise<AssetImageMeta>;
    /** Drop a handle (frees its blob). */
    discard(id: string): boolean;
    /** Drop all handles. */
    clear(): void;
  };

  /**
   * Model Lab (procedural 3D) pipeline — reconstruct a hard-surface model FROM CODE against a
   * reference image, browse/reopen past jobs. Every method returns JSON-safe data: the run methods
   * return the final {@link ModelGenState} (no Blobs / no THREE objects), and {@link model3d.history}
   * strips the record Blobs. This drives the same {@link Model3DGenService} the Model Lab panel uses.
   */
  readonly model3d: {
    /** Current pipeline state (status, spec, passes, usage, error). */
    state(): ModelGenState;
    /** Run a full generation (autonomous) from a reference image; resolves to the final state. */
    generate(opts: Model3dRunOptions): Promise<ModelGenState>;
    /** Regenerate from a saved sculpt spec (autonomous); resolves to the final state. */
    generateFromSpec(spec: SculptSpec, opts?: Model3dRunOptions): Promise<ModelGenState>;
    /** Rebuild a saved procedural factory (no LLM); resolves to the final state. */
    rebuild(factoryCode: string): Promise<ModelGenState>;
    /** Abort a running job. */
    cancel(): void;
    /** Resolve a pending manual-review gate. */
    decideReview(decision: 'accept' | 'retry' | 'stop'): void;
    /** Recent jobs, newest first, JSON-safe (Blobs dropped). */
    history(limit?: number): Promise<ModelGenHistoryRow[]>;
    /** Reopen a past job by rebuilding its factory; resolves to the final state, or {ok:false}. */
    openHistory(id: string): Promise<ModelGenState | { ok: false }>;
    /** Clear all persisted jobs. */
    clearHistory(): Promise<void>;
  };

  /**
   * Model Lab (Scene lane) pipeline — generate (or edit) a whole `.pix3scene` LEVEL from a brief,
   * using the project's existing assets as the palette. Every method returns JSON-safe data: the run
   * method returns the final {@link SceneGenState} (no THREE objects / no Blobs). This drives the same
   * {@link Scene3DGenService} the Model Lab Scene panel uses.
   */
  readonly scene3d: {
    /** Current pipeline state (status, levelSpec, sceneYaml, passes, inventory, usage, error). */
    state(): SceneGenState;
    /**
     * Run a full generation (autonomous) from a brief, resolving to the final state. `referencePaths`
     * are project asset paths (best-effort); `baseScenePath` edits an existing scene instead.
     */
    generate(opts: Scene3dRunOptions): Promise<SceneGenState>;
    /** The latest valid scene YAML, or null before the first successful pass. */
    yaml(): string | null;
    /** Save the current scene YAML into the project; resolves to the normalized path. */
    save(path: string): Promise<{ path: string }>;
    /** Abort a running job. */
    cancel(): void;
    /** Resolve a pending manual-review gate. */
    decideReview(decision: 'accept' | 'retry' | 'stop'): void;
  };

  // --- in-editor agent tool layer (same tools the Agent chat calls) ---
  readonly agentTools: {
    /** Names of all registered agent tools. */
    list(): string[];
    /** Execute one agent tool by name (exactly what the Agent chat's loop runs). */
    execute(name: string, args?: Record<string, unknown>): Promise<unknown>;
  };

  /**
   * Drive the in-editor Agent chat programmatically — this is the eval harness: send a message,
   * wait for the whole agentic loop to finish, and read back what the model did. Uses the real
   * chat service (selected provider/model + saved key), so it exercises exactly what a user gets.
   */
  readonly agent: {
    /** Snapshot of the current chat state (status, last assistant text, usage). */
    getState(): AgentStateSummary;
    /** Send a message and resolve when the turn (all tool iterations) completes. */
    send(text: string): Promise<AgentStateSummary>;
    /** Abort the running turn (keeps partial history). */
    stop(): void;
    /** Start a fresh conversation (old ones stay in history). */
    newConversation(): Promise<void>;
    /** Flattened transcript (texts + tool calls/results) — pass a limit for the last N turns. */
    transcript(limit?: number): AgentTranscriptEntry[];
    /** Set the main coding provider/model. */
    setProvider(providerId: string, modelId?: string): void;
    /** Set the vision-helper provider/model used by analyze_image (empty modelId = auto). */
    setVisionHelper(providerId: string, modelId?: string): void;
    /** Describe the currently-resolved vision helper (or null when none is available). */
    visionHelper(): Promise<VisionHelperInfo | null>;
    /** Set the advisor provider/model used by ask_advisor (empty providerId = feature off). */
    setAdvisor(providerId: string, modelId?: string): void;
    /** Describe the currently-configured advisor (or null when off / no key). */
    advisor(): Promise<AdvisorInfo | null>;
  };

  /**
   * Deterministic eval scorecard — the automated judge of the agent-harness tuning loop.
   * After `agent.send(...)` finishes, run a JSON spec of typed checks (tool-trace patterns,
   * scene structure, compile status, error-free play, `game_input` movement, asset alpha/size)
   * and get a reproducible pass/fail report. Specs for S1–S3 live in
   * `.plans/agent-eval-scenarios.md`. Checks run in order; play-mode checks change state.
   */
  readonly eval: {
    run(spec: EvalSpec): Promise<EvalReport>;
    /** All supported check kinds (spec authoring aid). */
    checkKinds(): string[];
  };

  // --- game-specific surface (present only if the running game registered one) ---
  readonly game: {
    /** True if the running game registered a GameDebugProvider. */
    available(): boolean;
    /** Provider metadata, or null if no game registered. */
    info(): {
      name: string;
      version: number | null;
      has: { snapshot: boolean; inspect: boolean; action: boolean };
    } | null;
    /** Game's high-level overview, or null. */
    snapshot(): Json | null;
    /** Run a named game query, e.g. inspect('droppables'). Null if unsupported. */
    inspect(query: string, args?: unknown): Json | null;
    /** Run a named game action, e.g. action('wakeAll'). Null if unsupported. */
    action(name: string, args?: unknown): Json | null;
  };
}

function createBridge(): Pix3DebugBridge {
  return {
    // v6: added the `model3d` lane (Model Lab procedural 3D generation + history).
    // v7: added the `scene3d` lane (Model Lab Scene lane — brief → `.pix3scene` level generation/edit).
    version: 7,

    help() {
      return {
        'scene(maxDepth=3)': 'Active scene as a DTO tree.',
        'node(id)': 'One node in full detail (transform, properties, components).',
        'find(text)': 'Search nodes by name/type substring.',
        'selection()': 'Selected node IDs.',
        'liveScene(maxDepth=4)':
          'Live Three.js object tree (play-mode runtime instances, incl. raw sprites/meshes).',
        'liveFind(query,limit=50)':
          "Search live objects by name/type, or 'droppable' for tagged items.",
        'physicsDebug()':
          'Summary of collider wireframe buffers exposed by the running game (counts only).',
        'play.status() / play.start(scenePath?) / play.stop() / play.restart()':
          'Play-mode control; start() takes an optional .pix3scene path to play that exact scene.',
        'setProperty({nodeId,propertyPath,value})':
          'Edit a property (undoable); hot-reloads onto the running scene while playing.',
        'command(id)': "Run a command by id, e.g. 'edit.undo'.",
        'components(id)': 'Script components attached to a node.',
        'errors() / clearErrors()': 'Captured console/runtime errors (ring buffer).',
        'agentTools.list() / agentTools.execute(name, args)':
          "The in-editor Agent's tool layer (fs_*, scene_*, play_*, viewport_screenshot, generate_asset, …).",
        'agent.send(text)':
          'Drive the Agent chat end-to-end (awaits the whole loop). Returns a state summary.',
        'agent.getState() / agent.transcript(limit)':
          'Chat status/last-reply summary, or a flattened transcript (texts + tool calls/results).',
        'agent.setProvider(id,model) / agent.setVisionHelper(id,model) / agent.visionHelper()':
          'Configure the coding model / vision helper for eval runs.',
        'agent.setAdvisor(id,model) / agent.advisor()':
          "Configure the stronger advisor model behind ask_advisor ('' = off).",
        'agent.newConversation() / agent.stop()': 'Reset the conversation / abort a running turn.',
        'eval.run({name,checks:[...]})':
          'Deterministic scorecard for eval runs: tool-trace, scene, compile, play, game_input and asset checks → a reproducible pass/fail report (specs: .plans/agent-eval-scenarios.md).',
        'eval.checkKinds()': 'List the supported check kinds.',
        'game.available() / game.info()': 'Whether the running game exposed a debug provider.',
        'game.snapshot() / game.inspect(q) / game.action(n)':
          'Game-specific debug surface (per-game).',
        'assets.status()': 'AI asset pipeline: provider/model/key/project status + capabilities.',
        'assets.generate({prompt,references,aspectRatio,imageSize,transparent})':
          "Generate an image with the user's saved key. Returns a handle {id,width,height,bytes}.",
        'assets.resize(id,{maxSize}) / crop(id,{x,y,width,height}) / compress(id,{format,quality})':
          'Transform a handle; each returns a NEW handle id.',
        'assets.rotate(id,1|2|3) / flip(id,"horizontal"|"vertical")':
          'Rotate clockwise (1=90°,2=180°,3=270°) or mirror a handle; each returns a NEW handle id.',
        'assets.removeBackground(id) / open(path) / openHistory(recordId)':
          'Cut out background / load a project asset / pull a cached generation into a handle.',
        'assets.preview(id,maxSize=256)': 'data: URL preview of a handle for visual QC.',
        'assets.save(id,name,{maxSize,format,quality})':
          'Write a handle into the project (creates dirs, optional downscale).',
        'assets.list() / get(id) / history(limit) / discard(id) / clear()': 'Handle + cache mgmt.',
        'model3d.state()': 'Model Lab pipeline state (status, spec, passes, usage, error).',
        'model3d.generate({referencePath|referenceBase64,mimeType,prompt,complexity,mode})':
          'Reconstruct a hard-surface 3D model procedurally from a reference image (autonomous). Resolves to the final state.',
        'model3d.generateFromSpec(spec,opts?) / rebuild(factoryCode)':
          'Regenerate from a saved sculpt spec, or rebuild a saved procedural factory (no LLM).',
        'model3d.cancel() / decideReview("accept"|"retry"|"stop")':
          'Abort a running job / resolve a pending manual-review gate.',
        'model3d.history(limit) / openHistory(id) / clearHistory()':
          'Browse past jobs (JSON-safe rows), reopen one by rebuilding its factory, or clear the cache.',
        'scene3d.state()':
          'Model Lab Scene lane state (status, levelSpec, sceneYaml, passes, inventory, usage, error).',
        'scene3d.generate({brief,referencePaths?,baseScenePath?,mode?})':
          "Generate (or, with baseScenePath, edit) a whole `.pix3scene` LEVEL from a brief using the project's assets as the palette (autonomous). Resolves to the final state.",
        'scene3d.yaml() / save(path)':
          'The latest valid scene YAML / write it into the project (resolves to the normalized path).',
        'scene3d.cancel() / decideReview("accept"|"retry"|"stop")':
          'Abort a running job / resolve a pending manual-review gate.',
      };
    },

    scene(maxDepth = 3) {
      const graph = activeGraph();
      if (!graph) return null;
      const roots = graph.rootNodes.filter((n): n is NodeBase => n instanceof NodeBase);
      // Wrap roots under a synthetic node so the return is a single tree.
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
      return { ...tree, sceneVersion: graph.version };
    },

    node(nodeId) {
      const node = activeGraph()?.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) return null;
      const dto = nodeToDTO(node, 0);
      dto.components = node.components.map((c, i) => componentToDTO(c, i));
      return dto;
    },

    find(text) {
      return findNodeSummaries(text);
    },

    selection() {
      return {
        nodeIds: [...appState.selection.nodeIds],
        primaryNodeId: appState.selection.primaryNodeId,
        hoveredNodeId: appState.selection.hoveredNodeId,
      };
    },

    liveScene(maxDepth = 4) {
      const root = liveSceneRoot();
      if (!root) return null;
      return { roots: [liveObjectToDTO(root, maxDepth)] };
    },

    liveFind(query, limit = 50) {
      const root = liveSceneRoot();
      if (!root) return [];
      const needle = query.toLowerCase();
      const wantDroppable = needle === 'droppable' || needle === 'droppables';
      const out: LiveObjectDTO[] = [];
      const budget = { n: limit };
      const predicate = (dto: LiveObjectDTO, raw: Object3DLike): boolean => {
        if (wantDroppable) {
          return !!(raw.userData && 'droppableItemRef' in raw.userData);
        }
        return (
          dto.threeType.toLowerCase().includes(needle) || dto.name.toLowerCase().includes(needle)
        );
      };
      flattenLive(root, predicate, out, budget);
      return out;
    },

    physicsDebug() {
      const source = getPhysicsDebugSource();
      if (!source) return null;
      const buffers = source() as { vertices?: ArrayLike<number>; bodies?: number } | null;
      const vertexCount = buffers?.vertices?.length ?? 0;
      return {
        available: !!buffers,
        enabled: isPhysicsDebugEnabled(),
        bodies: typeof buffers?.bodies === 'number' ? buffers.bodies : null,
        vertexCount,
        // 3 floats per point, 2 points per line segment.
        segments: Math.floor(vertexCount / 6),
      };
    },

    play: {
      status() {
        return {
          isPlaying: appState.ui.isPlaying,
          playModeStatus: appState.ui.playModeStatus,
        };
      },
      start(scenePath?: string) {
        if (scenePath) {
          return resolveCommandDispatcher().execute(new StartSceneGameCommand({ scenePath }));
        }
        return resolveCommandDispatcher().executeById('game.start');
      },
      stop() {
        return resolveCommandDispatcher().executeById('game.stop');
      },
      restart() {
        return resolveCommandDispatcher().executeById('game.restart');
      },
    },

    setProperty({ nodeId, propertyPath, value }) {
      return resolveCommandDispatcher().execute(
        new UpdateObjectPropertyCommand({ nodeId, propertyPath, value })
      );
    },

    command(commandId) {
      return resolveCommandDispatcher().executeById(commandId);
    },

    components(nodeId) {
      const node = activeGraph()?.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) return [];
      return node.components.map((c, i) => componentToDTO(c, i));
    },

    errors() {
      return errors();
    },

    clearErrors() {
      clearErrors();
    },

    assets: {
      status(providerId) {
        return service<AssetGenService>(AssetGenService).status(providerId);
      },
      generate(options) {
        return service<AssetGenService>(AssetGenService).generate(options);
      },
      resize(id, options) {
        return service<AssetGenService>(AssetGenService).resize(id, options);
      },
      crop(id, rect, format) {
        return service<AssetGenService>(AssetGenService).crop(id, rect, format);
      },
      compress(id, options) {
        return service<AssetGenService>(AssetGenService).compress(id, options);
      },
      removeBackground(id, options) {
        return service<AssetGenService>(AssetGenService).removeBackground(id, options);
      },
      rotate(id, quarterTurns) {
        return service<AssetGenService>(AssetGenService).rotate(id, quarterTurns);
      },
      flip(id, axis) {
        return service<AssetGenService>(AssetGenService).flip(id, axis);
      },
      open(pathOrRef) {
        return service<AssetGenService>(AssetGenService).open(pathOrRef);
      },
      get(id) {
        return service<AssetGenService>(AssetGenService).get(id);
      },
      list() {
        return service<AssetGenService>(AssetGenService).list();
      },
      preview(id, maxSize) {
        return service<AssetGenService>(AssetGenService).preview(id, maxSize);
      },
      save(id, name, options) {
        return service<AssetGenService>(AssetGenService).save(id, name, options);
      },
      history(limit) {
        return service<AssetGenService>(AssetGenService).history(limit);
      },
      openHistory(recordId) {
        return service<AssetGenService>(AssetGenService).openHistory(recordId);
      },
      discard(id) {
        return service<AssetGenService>(AssetGenService).discard(id);
      },
      clear() {
        service<AssetGenService>(AssetGenService).clear();
      },
    },

    model3d: {
      state() {
        return service<Model3DGenService>(Model3DGenService).getState();
      },
      async generate(opts) {
        const gen = service<Model3DGenService>(Model3DGenService);
        const referenceImage = await resolveModelReference(opts);
        await gen.generate(
          {
            referenceImage,
            prompt: opts.prompt,
            complexity: asComplexity(opts.complexity),
            mode: asMode(opts.mode),
          },
          { autonomous: true }
        );
        return gen.getState();
      },
      async generateFromSpec(spec, opts) {
        const gen = service<Model3DGenService>(Model3DGenService);
        const referenceImage = await resolveModelReference(opts ?? {});
        await gen.generateFromSpec(spec, {
          referenceImage,
          prompt: opts?.prompt,
          complexity: asComplexity(opts?.complexity),
          mode: asMode(opts?.mode),
          autonomous: true,
        });
        return gen.getState();
      },
      async rebuild(factoryCode) {
        const gen = service<Model3DGenService>(Model3DGenService);
        await gen.rebuildFromCode(factoryCode);
        return gen.getState();
      },
      cancel() {
        service<Model3DGenService>(Model3DGenService).cancel();
      },
      decideReview(decision) {
        service<Model3DGenService>(Model3DGenService).decideReview(decision);
      },
      async history(limit) {
        const records = await service<Model3DGenHistoryService>(Model3DGenHistoryService).list(
          limit
        );
        return records.map(record => ({
          id: record.id,
          createdAt: record.createdAt,
          objectClass: record.objectClass,
          prompt: record.prompt ?? null,
          complexity: record.complexity,
          mode: record.mode,
          finalScore: record.finalScore,
          savedPath: record.savedPath ?? null,
          passes: record.passes.map(pass => ({
            id: pass.id,
            label: pass.label,
            score: pass.score,
          })),
        }));
      },
      async openHistory(id) {
        const gen = service<Model3DGenService>(Model3DGenService);
        const record = await service<Model3DGenHistoryService>(Model3DGenHistoryService).get(id);
        if (!record) {
          return { ok: false as const };
        }
        await gen.rebuildFromCode(record.factoryCode);
        return gen.getState();
      },
      clearHistory() {
        return service<Model3DGenHistoryService>(Model3DGenHistoryService).clear();
      },
    },

    scene3d: {
      state() {
        return service<Scene3DGenService>(Scene3DGenService).getState();
      },
      async generate(opts) {
        const gen = service<Scene3DGenService>(Scene3DGenService);
        const referenceImages = await resolveSceneReferences(opts.referencePaths);
        await gen.generate(
          {
            brief: opts.brief,
            referenceImages,
            mode: asMode(opts.mode),
            baseScenePath: opts.baseScenePath,
          },
          { autonomous: true }
        );
        return gen.getState();
      },
      yaml() {
        return service<Scene3DGenService>(Scene3DGenService).getSceneYaml();
      },
      save(path) {
        return service<Scene3DGenService>(Scene3DGenService).saveScene(path);
      },
      cancel() {
        service<Scene3DGenService>(Scene3DGenService).cancel();
      },
      decideReview(decision) {
        service<Scene3DGenService>(Scene3DGenService).decideReview(decision);
      },
    },

    agentTools: {
      list() {
        return service<AgentToolRegistry>(AgentToolRegistry)
          .specs()
          .map(spec => spec.name);
      },
      execute(name, args) {
        return service<AgentToolRegistry>(AgentToolRegistry).execute(name, args ?? {});
      },
    },

    agent: {
      getState() {
        return summarizeAgentState(service<AgentChatService>(AgentChatService).getState());
      },
      async send(text) {
        const chat = service<AgentChatService>(AgentChatService);
        // send() awaits the whole agentic loop and sets status idle/error before returning
        // (provider/tool errors are captured into state, not thrown).
        await chat.send(text);
        return summarizeAgentState(chat.getState());
      },
      stop() {
        service<AgentChatService>(AgentChatService).stop();
      },
      newConversation() {
        return service<AgentChatService>(AgentChatService).newConversation();
      },
      transcript(limit) {
        return agentTranscript(
          service<AgentChatService>(AgentChatService).getState().messages,
          limit
        );
      },
      setProvider(providerId, modelId) {
        service<AgentSettingsService>(AgentSettingsService).updatePreferences({
          selectedProviderId: providerId,
          ...(modelId ? { modelByProvider: { [providerId]: modelId } } : {}),
        });
      },
      setVisionHelper(providerId, modelId) {
        service<AgentSettingsService>(AgentSettingsService).updatePreferences({
          visionProviderId: providerId,
          visionModelId: modelId ?? '',
        });
      },
      visionHelper() {
        return service<AgentVisionService>(AgentVisionService).describeHelper();
      },
      setAdvisor(providerId, modelId) {
        service<AgentSettingsService>(AgentSettingsService).updatePreferences({
          advisorProviderId: providerId,
          advisorModelId: modelId ?? '',
        });
      },
      advisor() {
        return service<AgentAdvisorService>(AgentAdvisorService).describeAdvisor();
      },
    },

    eval: {
      run(spec) {
        return runEvalSpec(createEvalHarness(), spec);
      },
      checkKinds() {
        return [...EVAL_CHECK_KINDS];
      },
    },

    game: {
      available() {
        return getGameDebug() !== null;
      },
      info() {
        const provider = getGameDebug();
        if (!provider) return null;
        return {
          name: provider.name,
          version: provider.version ?? null,
          has: {
            snapshot: !!provider.snapshot,
            inspect: !!provider.inspect,
            action: !!provider.action,
          },
        };
      },
      snapshot() {
        const provider = getGameDebug();
        return provider?.snapshot ? safeSerialize(provider.snapshot(), 5) : null;
      },
      inspect(query, args) {
        const provider = getGameDebug();
        return provider?.inspect ? safeSerialize(provider.inspect(query, args), 5) : null;
      },
      action(name, args) {
        const provider = getGameDebug();
        return provider?.action ? safeSerialize(provider.action(name, args), 3) : null;
      },
    },
  };
}

interface WindowWithDebug extends Window {
  __PIX3_DEBUG__?: Pix3DebugBridge;
}

/** Install the bridge on `window.__PIX3_DEBUG__`. Idempotent. */
export function installDebugBridge(): void {
  const target = window as unknown as WindowWithDebug;
  if (target.__PIX3_DEBUG__) return;
  installErrorCapture();
  target.__PIX3_DEBUG__ = createBridge();
  console.info('[Pix3] Debug bridge ready: window.__PIX3_DEBUG__.help()');
}
