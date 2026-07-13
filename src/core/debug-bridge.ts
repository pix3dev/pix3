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
import { resolveCommandDispatcher } from '@/services/CommandDispatcher';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { AssetGenService } from '@/services/AssetGenService';
import { AgentToolRegistry } from '@/services/agent/AgentToolRegistry';
import { AgentChatService, type AgentChatState } from '@/services/agent/AgentChatService';
import { AgentSettingsService } from '@/services/AgentSettingsService';
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
} from '@/services/AssetGenService';
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
    start(): Promise<boolean>;
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
    version: 4,

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
        'play.status() / play.start() / play.stop() / play.restart()': 'Play-mode control.',
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
        'game.available() / game.info()': 'Whether the running game exposed a debug provider.',
        'game.snapshot() / game.inspect(q) / game.action(n)':
          'Game-specific debug surface (per-game).',
        'assets.status()': 'AI asset pipeline: provider/model/key/project status + capabilities.',
        'assets.generate({prompt,references,aspectRatio,imageSize,transparent})':
          "Generate an image with the user's saved key. Returns a handle {id,width,height,bytes}.",
        'assets.resize(id,{maxSize}) / crop(id,{x,y,width,height}) / compress(id,{format,quality})':
          'Transform a handle; each returns a NEW handle id.',
        'assets.removeBackground(id) / open(path) / openHistory(recordId)':
          'Cut out background / load a project asset / pull a cached generation into a handle.',
        'assets.preview(id,maxSize=256)': 'data: URL preview of a handle for visual QC.',
        'assets.save(id,name,{maxSize,format,quality})':
          'Write a handle into the project (creates dirs, optional downscale).',
        'assets.list() / get(id) / history(limit) / discard(id) / clear()': 'Handle + cache mgmt.',
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
      start() {
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
        return agentTranscript(service<AgentChatService>(AgentChatService).getState().messages, limit);
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
