import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { buildProjectMap } from '@/services/flow/flow-project-map';
import { SceneManager, NodeBase } from '@pix3/runtime';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { resolveSoul } from '@/services/agent/AgentSouls';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { AgentToolRegistry, AGENT_TOOL_IMAGES_KEY } from '@/services/agent/AgentToolRegistry';
import { AgentAdvisorService } from '@/services/agent/AgentAdvisorService';
import { AgentSkillsService } from '@/services/agent/AgentSkillsService';
import { BRIDGE_TOKEN_SECRET_ID } from '@/services/llm/BridgeProviders';
import {
  AgentChatHistoryStore,
  type AgentConversationMeta,
  type AgentConversationRecord,
} from './AgentChatHistoryStore';
import {
  LlmError,
  isRecord,
  type ChatParams,
  type LlmContentBlock,
  type LlmErrorKind,
  type LlmImageBlock,
  type LlmMessage,
  type LlmModel,
  type LlmProvider,
  type LlmRequestContext,
  type LlmResult,
  type LlmTextBlock,
  type LlmToolResultBlock,
  type LlmToolUseBlock,
  type LlmUsage,
  type ReasoningEffort,
} from '@/services/llm/LlmTypes';

export type AgentChatStatus = 'idle' | 'running' | 'error';

/** A text file attached to a user message (its content is inlined into the prompt as a fenced block). */
export interface AgentTextAttachment {
  readonly name: string;
  readonly content: string;
}

/** Attachments carried alongside a user message (vision images + text files). */
export interface AgentAttachments {
  readonly images?: readonly LlmImageBlock[];
  readonly texts?: readonly AgentTextAttachment[];
}

/**
 * Who answered one assistant turn. Recorded per turn rather than read from the current settings,
 * because the selection can change mid-conversation (a bridge comes up, the user switches models)
 * and a reply must keep saying which model actually produced it.
 */
export interface AgentTurnOrigin {
  readonly providerId: string;
  /** Human label of the provider as it was registered (e.g. "Claude Code (MAX)"). */
  readonly providerLabel: string;
  readonly modelId: string;
  /** True when the request went through the local Pix3AgentBridge instead of straight from the tab. */
  readonly viaBridge: boolean;
}

/**
 * Timing / token accounting for a single provider round-trip. The timings are debug-only; the
 * {@link AgentTurnOrigin} rides along because it is shown in the chat at all times.
 */
export interface AgentTurnMetric {
  /** Which provider/model produced this turn (absent on turns recorded before this was tracked). */
  readonly origin?: AgentTurnOrigin;
  /** Wall-clock time for the provider request (ms). */
  readonly elapsedMs: number;
  /** Full (cache-inclusive) prompt size the model read this turn. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Prompt tokens the provider actually served from cache (reported after the fact). */
  readonly cacheReadTokens?: number;
  /** Prompt tokens written to cache this turn (Anthropic only). */
  readonly cacheCreationTokens?: number;
  /**
   * Estimated tokens of this request whose leading bytes were unchanged from the previous request —
   * i.e. the theoretically cacheable prefix, computed locally *before* sending. A prediction, so it
   * exists even for providers that don't report cache usage; ~chars/4, so approximate.
   */
  readonly predictedCacheTokens?: number;
}

/**
 * A question the agent ended its turn on (the `ask_user` tool). The turn stops as soon as the call
 * executes — a fork the user must resolve is a legitimate end of turn, not a failure — and the UI
 * renders the options as clickable chips.
 */
export interface AgentPendingQuestion {
  readonly question: string;
  readonly options: readonly string[];
  /** When true the composer stays usable for a typed answer instead of only the chips. */
  readonly allowFreeform: boolean;
}

export interface AgentChatState {
  readonly status: AgentChatStatus;
  /** Wire-format conversation history (the single source of truth; the UI derives its view). */
  readonly messages: readonly LlmMessage[];
  /** Error of the last failed turn (provider/config errors — tool failures stay in the history). */
  readonly errorMessage: string | null;
  readonly errorKind: LlmErrorKind | null;
  /** Non-error banner (e.g. the tool-iteration cap was hit). */
  readonly notice: string | null;
  /** Name of the tool currently executing (running turns only). */
  readonly activeTool: string | null;
  /** Token usage accumulated across this conversation (when providers report it). */
  readonly totalUsage: LlmUsage;
  /**
   * Per-assistant-turn timing/token metrics, keyed by the assistant message's index in
   * {@link messages}. Populated on every turn; the UI only surfaces it in debug mode.
   */
  readonly turnMetrics: Readonly<Record<number, AgentTurnMetric>>;
  /** All conversations of the current project (newest first) — powers the history list. */
  readonly conversations: readonly AgentConversationMeta[];
  /** Id of the conversation currently shown, or null for a fresh unsaved one. */
  readonly activeConversationId: string | null;
  /** Question the agent stopped on (`ask_user`), or null. Cleared by the next {@link send}. */
  readonly pendingQuestion: AgentPendingQuestion | null;
  /**
   * Indices in {@link messages} where a context compaction replaced the history: the UI draws a
   * "context compacted" divider before those messages, so the user sees why the thread jumps.
   */
  readonly compactedAtIndices: readonly number[];
}

/** Project-root files scanned (in order) for user-authored agent instructions. */
const AGENTS_FILES = ['AGENTS.md', 'agents.md', '.agents.md'] as const;
/** Cap the AGENTS.md slice of the system prompt so a huge file can't dominate the context. */
const MAX_AGENTS_MD_CHARS = 16_000;
/**
 * The recipe map is authored to sit in the cached prefix (target < 4 KB); the cap is a guard
 * against a hand-edited recipe.md, not an expected path.
 */
const MAX_RECIPE_MD_CHARS = 8_000;
/**
 * Iteration floor for a Flow turn (the Studio default is 40, and users lower it). Below this a
 * turn cannot both build and prove an increment.
 */
const FLOW_MIN_TOOL_ITERATIONS = 60;
/** How many times a Flow turn is pushed to prove a gameplay change before it may close unproven. */
const FLOW_VERIFY_ATTEMPTS = 3;
/** Recipe contract written into every Flow project by the prototype expander. */
const RECIPE_MD_PATH = 'design/recipe.md';

/** Cap serialized tool results so one verbose tool cannot blow up the context window. */
const MAX_TOOL_RESULT_CHARS = 24_000;
/** Cap the scene-outline part of the system prompt. */
const MAX_OUTLINE_LINES = 120;
const OUTLINE_DEPTH = 2;

/**
 * Directories holding user script files (mirrors PreviewHostService / AgentToolRegistry). The
 * system prompt lists what lives here so the agent knows the project's game logic exists — the
 * scene outline only names nodes, never the `.ts` files, so without this an overview turn reports
 * "no game scripts" even when they are on disk.
 */
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
const EXCLUDED_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;
/** Grab each exported `class X extends Script` so we can surface its attachable `user:X` id. */
const SCRIPT_CLASS_PATTERN =
  /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)\s+extends\s+Script\b/g;
/** Cap the inventory so a project with hundreds of scripts can't dominate the prompt. */
const MAX_SCRIPT_INVENTORY = 60;

/** One project script file plus the Script subclasses it exports (for the `user:<Class>` ids). */
interface ScriptInventoryEntry {
  readonly path: string;
  readonly classes: readonly string[];
}

/** Component edits that change how the game behaves — gate the verify nudge on them. */
const GAME_MUTATION_COMPONENT_TOOLS = new Set([
  'add_component',
  'set_component_property',
  'remove_component',
]);

/**
 * True when a tool call changed game *behaviour*: a script/scene write or a component edit. A
 * design/progress `.md` write or an asset op does not count, so the verify-gate stays quiet for
 * documentation and content turns.
 */
const isGameLogicMutation = (toolName: string, input: unknown): boolean => {
  if (GAME_MUTATION_COMPONENT_TOOLS.has(toolName)) return true;
  // `str_replace` counts as much as `fs_write`: the skills tell the agent to prefer it for edits, so
  // a gate that only watched fs_write was blind to the documented edit path — a whole increment
  // could be authored with str_replace and close the turn with no game proof demanded.
  if (toolName === 'fs_write' || toolName === 'str_replace') {
    const path = (input as { path?: unknown } | null | undefined)?.path;
    return typeof path === 'string' && /\.(ts|pix3scene)$/i.test(path);
  }
  return false;
};

/** How many times one property may be retuned in a turn before it counts as thrash. */
const KNOB_TWEAK_LIMIT = 4;

/**
 * Prompt size at which a Flow increment starts in a fresh conversation instead of continuing.
 * Below it the thread is cheap and continuity is worth more; above it every hop pays for history.
 */
const FLOW_FRESH_CONVERSATION_TOKENS = 60_000;
/** How much of the previous increment's summary is carried into that fresh conversation. */
const FLOW_HANDOFF_SUMMARY_CHARS = 1_500;

/**
 * Identity of the property a call is tuning — `tool:target:property`, with the VALUE left out.
 *
 * Only the two property setters qualify. Re-setting one property four times in a single turn is
 * thrash in a way that re-editing one file four times is not: an edit builds on the last one, a
 * retune replaces it, so the fourth attempt is evidence the value was never the problem.
 */
const tuningKnobSignature = (toolName: string, input: unknown): string | null => {
  if (toolName !== 'set_component_property' && toolName !== 'set_property') return null;
  const args = (input ?? {}) as {
    nodeId?: unknown;
    componentId?: unknown;
    propertyName?: unknown;
    propertyPath?: unknown;
  };
  const target = [args.nodeId, args.componentId].filter(part => typeof part === 'string').join('/');
  const property = typeof args.propertyName === 'string' ? args.propertyName : args.propertyPath;
  if (!target || typeof property !== 'string') return null;
  return `${toolName}:${target}:${property}`;
};

/** Tools that answer by LOOKING. Expensive on this lane, and blind to everything state-shaped. */
const VISUAL_TOOLS = new Set(['viewport_screenshot', 'analyze_image']);

/**
 * Refusal handed back instead of running a visual tool while the turn owes a gameplay proof.
 *
 * The `flow-increment` skill has told the agent to verify by state since the feature shipped, and a
 * measured increment still spent ~65 s of its ~460 s on one screenshot plus four vision calls to
 * "check" a scoring change. A rule the harness does not enforce is a rule that holds only when the
 * model feels like it — so the harness enforces it, and says what to do instead.
 */
const hasVisualReason = (input: unknown): boolean => {
  const reason = (input as { visualReason?: unknown } | null | undefined)?.visualReason;
  return typeof reason === 'string' && reason.trim().length > 0;
};

const visualToolRefusal = (toolName: string): string =>
  JSON.stringify({
    ok: false,
    error: `${toolName} is unavailable right now: you changed game logic and have not proven it in the running game yet. A picture cannot show that a score went up, a timer ticked or a hitbox fired — drive the game with game_input and read the delta with game_observe. If the thing you need to check really is visual (art, layout, colour, overlap), call it again with visualReason explaining that.`,
  });

/**
 * Tools that change project or engine state, so an earlier identical result stops being evidence of
 * a loop. Used to reset the loop-breaker's memory — without it, an agent that edited a script,
 * recompiled and re-ran `play_start {scene, reload:true}` (exactly what that tool documents) got
 * scolded for a "repeat" and escalated to the stuck directive on its third legitimate restart.
 * Deliberately excludes the play and observation tools: their own repeats are what the breaker
 * exists to catch.
 */
const STATE_CHANGING_TOOLS = new Set([
  'set_property',
  'create_node',
  'convert_node_type',
  'move_node',
  'add_component',
  'set_component_property',
  'remove_component',
  'run_command',
  'fs_write',
  'str_replace',
  'fs_delete',
  'compile_scripts',
  'generate_asset',
  'process_asset',
  'generate_model_3d',
  'generate_scene_3d',
]);

/**
 * Hard ceiling on ONE provider round-trip. A request that never resolves (no response, no error —
 * seen with gateway providers whose upstream stalls) used to block the turn forever, with Stop as
 * the user's only recourse. Racing the call against this deadline turns the hang into a normal
 * transient failure that {@link AgentChatService.chatWithRetry}'s single retry can recover from.
 */
export const LLM_REQUEST_TIMEOUT_MS = 180_000;

/**
 * Context watermarks as a fraction of the model's context window, measured from the last turn's
 * (cache-inclusive) `inputTokens`. Measured but unacted-on until now: the history grew without
 * bound until the provider refused. 60% nudges, 75% compacts, 90% is the emergency valve.
 */
export const CONTEXT_NUDGE_RATIO = 0.6;
export const CONTEXT_COMPACT_RATIO = 0.75;
export const CONTEXT_EMERGENCY_RATIO = 0.9;
/** Below this, compaction is pointless — the history IS the task, and squashing it loses more. */
const MIN_MESSAGES_TO_COMPACT = 8;
/** Emergency trim keeps this many trailing messages intact (the work the model is mid-way through). */
const EMERGENCY_KEEP_MESSAGES = 6;
/** Replacement body for a tool result the emergency trim dropped. */
const TRIMMED_MARKER = '[trimmed]';
/** Design docs carried across a compaction (the agent's real memory lives on disk, not in history). */
const HANDOFF_DOCS = ['design/brief.md', 'design/progress.md', 'design/decisions.md'] as const;
/** Per-doc cap so a long brief can't refill the context we just freed. */
const MAX_HANDOFF_DOC_CHARS = 4_000;
/**
 * At most two "you are stuck" directives per turn. The escalation costs an iteration and repeating
 * it would itself become the loop it is trying to break.
 */
const MAX_STUCK_ESCALATIONS = 2;
/** Consecutive all-error iterations that count as stuck. */
const STUCK_ERROR_ITERATIONS = 3;
/** Forced whole-file rewrites that count as stuck (the guard in fs_write reports each one). */
const STUCK_FORCED_OVERWRITES = 2;

/** HTTP statuses worth ONE automatic retry — transient server/gateway hiccups, not client errors. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Message fragments that mark a transient upstream/gateway failure even without a clean status. */
const TRANSIENT_ERROR_PATTERN =
  /upstream|timeout|timed out|temporar|overload|unavailable|reset|try again/i;

/**
 * Whether a failed provider round-trip is worth ONE automatic retry: an empty completion (free
 * models blip → LlmError 'empty') or a transient HTTP gateway failure (5xx / 408 / 429, or an
 * opaque "upstream request failed"). Client errors (400/401/404), aborts, missing keys, and
 * CORS/network misconfig are NEVER retried — a retry there just repeats a certain failure.
 */
const isTransientLlmError = (error: unknown): error is LlmError => {
  if (!(error instanceof LlmError)) return false;
  if (error.kind === 'empty') return true;
  if (error.kind === 'http') {
    return (
      (typeof error.status === 'number' && RETRYABLE_HTTP_STATUSES.has(error.status)) ||
      TRANSIENT_ERROR_PATTERN.test(error.message)
    );
  }
  return false;
};

const IDLE_STATE: AgentChatState = {
  status: 'idle',
  messages: [],
  errorMessage: null,
  errorKind: null,
  notice: null,
  activeTool: null,
  totalUsage: {},
  turnMetrics: {},
  conversations: [],
  activeConversationId: null,
  pendingQuestion: null,
  compactedAtIndices: [],
};

/**
 * The in-editor agent's conversation engine: one active conversation per project, driven by an
 * agentic loop — send the history + tool specs to the selected LLM provider, execute the tool calls
 * it returns through {@link AgentToolRegistry}, feed the results back, repeat until the model stops
 * calling tools or the iteration cap is hit.
 *
 * Scene mutations happen inside tool handlers via the command gateway (undo/redo lands there);
 * this service never touches the scene itself. History persists to IndexedDB per project id.
 * Tool-result blocks always carry `toolName` — Gemini matches results by function name, and the
 * id-based fallback should stay exactly that, a fallback.
 */
@injectable()
export class AgentChatService {
  @inject(AgentSettingsService)
  private readonly settings!: AgentSettingsService;

  @inject(LlmModelCatalogService)
  private readonly modelCatalog!: LlmModelCatalogService;

  @inject(AgentToolRegistry)
  private readonly toolRegistry!: AgentToolRegistry;

  @inject(AgentSkillsService)
  private readonly skills!: AgentSkillsService;

  @inject(AgentAdvisorService)
  private readonly advisorService!: AgentAdvisorService;

  @inject(AgentChatHistoryStore)
  private readonly historyStore!: AgentChatHistoryStore;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private state: AgentChatState = IDLE_STATE;
  private readonly listeners = new Set<(state: AgentChatState) => void>();
  private abortController: AbortController | null = null;
  /** Project id whose conversations are currently loaded (histories are per project). */
  private loadedProjectId: string | null = null;
  /** Cache-inclusive prompt size of the most recent request — what a fat conversation costs. */
  private lastRequestInputTokens = 0;
  /** createdAt of the active conversation (0 = not yet persisted). */
  private activeCreatedAt = 0;
  /** Composer prefill channel — carries "Fix with Agent" prompts to the panel. */
  private readonly composeListeners = new Set<(text: string) => void>();
  /** Prefill queued before the panel mounted; delivered on the next subscribe. */
  private pendingCompose: string | null = null;
  /**
   * Serialized (tools + system + messages) of the last request sent, in wire order — used to
   * estimate how much of the next request's leading prefix is unchanged (the predicted cacheable
   * span). Reset whenever the active conversation changes, since a cross-conversation diff is
   * meaningless.
   */
  private previousRequestSignature: string | null = null;

  getState(): AgentChatState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  subscribe(listener: (state: AgentChatState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Load the current project's conversation list (no-op when already loaded) and open the most
   * recent conversation. Safe to call from the panel on connect; a running turn is never
   * interrupted by a load.
   */
  async ensureLoaded(): Promise<void> {
    const projectId = appState.project.id ?? '';
    if (this.loadedProjectId === projectId || this.isRunning()) {
      return;
    }
    this.loadedProjectId = projectId;
    this.previousRequestSignature = null;
    try {
      const conversations = await this.historyStore.list(projectId);
      // The guard above is not enough: reading history is async, and in Flow the panel mounts for a
      // freshly created project at the same moment the bootstrap sends that project's FIRST turn.
      // Applying a load that started before the turn wipes it mid-run — the user watched the agent
      // work for three steps and then saw an empty chat, with nothing in history (a turn is only
      // persisted once it completes). Whoever moved the conversation on while we were reading wins.
      if (this.isRunning() || this.state.messages.length > 0) {
        return;
      }
      if (conversations.length > 0) {
        const latest = conversations[0]; // list() returns newest first
        const record = await this.historyStore.get(latest.id);
        if (this.isRunning() || this.state.messages.length > 0) {
          return;
        }
        this.setState({
          ...IDLE_STATE,
          conversations,
          activeConversationId: latest.id,
          messages: record?.messages ?? [],
          turnMetrics: record?.turnMetrics ?? {},
        });
        this.activeCreatedAt = record?.createdAt ?? Date.now();
      } else {
        this.setState({ ...IDLE_STATE, conversations });
        this.activeCreatedAt = 0;
      }
    } catch {
      if (this.isRunning() || this.state.messages.length > 0) {
        return;
      }
      this.setState({ ...IDLE_STATE });
    }
  }

  /**
   * Send a user message and run the agentic loop until the model stops calling tools. Optional
   * attachments (pasted/dropped images and text files) ride in the same user turn — images become
   * real image blocks (multimodal models only) and text files are inlined into the prompt.
   */
  async send(text: string, attachments?: AgentAttachments): Promise<void> {
    const trimmed = text.trim();
    const images = attachments?.images ?? [];
    const texts = attachments?.texts ?? [];
    if ((!trimmed && images.length === 0 && texts.length === 0) || this.isRunning()) {
      return;
    }

    await this.ensureLoaded();

    const handoff = await this.flowIncrementHandoff();

    // The user is answering (or ignoring) the agent's question — either way the fork is resolved.
    if (this.state.pendingQuestion) {
      this.setState({ pendingQuestion: null });
    }

    if (handoff) {
      await this.newConversation();
    }

    // A fresh (unsaved) conversation gets its id/created-at on the first message.
    if (!this.state.activeConversationId) {
      this.setState({ activeConversationId: newConversationId() });
      this.activeCreatedAt = Date.now();
    }

    this.appendMessage({
      role: 'user',
      content: buildUserContent(handoff ? `${trimmed}\n\n${handoff}` : trimmed, images, texts),
    });
    await this.runToSettled();
  }

  /**
   * In Flow, start each new increment in a FRESH conversation once the current one has grown fat —
   * and carry the handoff (last summary + the project map) into it.
   *
   * Measured across three increments of one prototype: the conversation ran 44K → 144K input tokens
   * because only the bootstrap's first turn got a clean start, and per-hop latency tracks context
   * (~0.11 s per 1K tokens), so the third increment paid ~8 s a hop for history it never used. A new
   * conversation costs one ~5–10 s cold start on the bridge lane and repays it within two hops
   * (design §5.4, and the same reasoning the bootstrap already applies to increment one).
   *
   * Returns the text to append to the user's message, or null to continue the current conversation:
   * a small conversation stays (a short clarifying exchange must not lose its thread), and so does
   * an answer to the agent's own `ask_user` question.
   */
  private async flowIncrementHandoff(): Promise<string | null> {
    if (
      appState.ui.workspaceMode !== 'flow' ||
      this.state.pendingQuestion ||
      this.state.messages.length === 0 ||
      this.lastRequestInputTokens < FLOW_FRESH_CONVERSATION_TOKENS
    ) {
      return null;
    }

    const summary = this.lastAssistantText().slice(0, FLOW_HANDOFF_SUMMARY_CHARS);
    const map = await buildProjectMap(this.storage).catch(() => '');
    const lines = [
      '---',
      '',
      'Context from the previous increment (this is a fresh conversation — `design/progress.md`,',
      '`design/brief.md` and `design/recipe.md` hold the rest):',
      '',
      summary || '(no summary was recorded)',
    ];
    if (map) {
      lines.push('', map);
    }
    return lines.join('\n');
  }

  /** Text of the most recent assistant message, flattened. */
  private lastAssistantText(): string {
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const message = this.state.messages[i];
      if (message.role !== 'assistant' || typeof message.content === 'string') continue;
      const text = message.content
        .filter((block): block is LlmTextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
    return '';
  }

  /**
   * Re-run the agentic loop on the CURRENT history WITHOUT appending a new user message. Powers the
   * chat's "Try again" (after a failed turn) and "Continue" (after the tool-iteration cap or a
   * manual stop) affordances — both just resume the model on whatever the history already ends with
   * (an unanswered user prompt, or the previous turn's tool results). No-op while running or with an
   * empty history.
   */
  async resume(): Promise<void> {
    if (this.isRunning() || this.state.messages.length === 0) {
      return;
    }
    await this.ensureLoaded();
    await this.runToSettled();
  }

  /**
   * Drive {@link runLoop} to a terminal state and fold the outcome into `status` (idle / error)
   * plus any banner. Shared by {@link send} and {@link resume}; persists the (partial) history
   * either way.
   */
  private async runToSettled(): Promise<void> {
    this.abortController = new AbortController();
    // Any open question is settled by the fact that we are running again (answered, or resumed
    // past it) — a stale chip row would otherwise reappear when this turn finishes.
    this.setState({
      status: 'running',
      errorMessage: null,
      errorKind: null,
      notice: null,
      pendingQuestion: null,
    });
    try {
      await this.runLoop(this.abortController.signal);
      this.setState({ status: 'idle', activeTool: null });
    } catch (error) {
      if (error instanceof LlmError && error.kind === 'aborted') {
        this.setState({ status: 'idle', activeTool: null, notice: 'Stopped.' });
      } else {
        const kind = error instanceof LlmError ? error.kind : 'unknown';
        const message = error instanceof Error ? error.message : String(error);
        this.setState({
          status: 'error',
          activeTool: null,
          errorMessage: message,
          errorKind: kind,
        });
      }
    } finally {
      this.abortController = null;
      this.persist();
    }
  }

  /** Abort the running turn (the partial history is kept). */
  stop(): void {
    this.abortController?.abort();
  }

  /**
   * Start a fresh conversation. Any prior conversation stays in history (it was persisted per turn);
   * this only clears the in-memory view and drops the active id so the next message opens a new one.
   */
  async newConversation(): Promise<void> {
    this.stop();
    await this.ensureLoaded();
    this.setState({
      ...IDLE_STATE,
      conversations: this.state.conversations,
      activeConversationId: null,
    });
    this.activeCreatedAt = 0;
    this.previousRequestSignature = null;
  }

  /** Open a stored conversation by id (no-op while a turn is running). */
  async switchConversation(id: string): Promise<void> {
    if (this.isRunning() || id === this.state.activeConversationId) {
      return;
    }
    await this.ensureLoaded();
    this.previousRequestSignature = null;
    try {
      const record = await this.historyStore.get(id);
      if (!record) {
        return;
      }
      this.setState({
        ...IDLE_STATE,
        conversations: this.state.conversations,
        activeConversationId: record.id,
        messages: record.messages ?? [],
        turnMetrics: record.turnMetrics ?? {},
      });
      this.activeCreatedAt = record.createdAt ?? Date.now();
    } catch {
      // Best-effort — leave the current view untouched on failure.
    }
  }

  /** Delete a stored conversation. If it is the active one, reset to a fresh conversation. */
  async deleteConversation(id: string): Promise<void> {
    try {
      await this.historyStore.delete(id);
    } catch {
      // Best-effort.
    }
    if (id === this.state.activeConversationId) {
      this.setState({ ...IDLE_STATE, activeConversationId: null });
      this.activeCreatedAt = 0;
    }
    await this.refreshConversations();
  }

  /**
   * Compose channel: start a fresh conversation and hand a prefilled prompt to the panel (used by
   * the "Fix with Agent" affordances). The panel drops the text into the composer and focuses it so
   * the user can review/edit before sending. If the panel is not mounted yet (it is being revealed),
   * the prompt is queued and delivered when it subscribes.
   */
  async composeFix(text: string): Promise<void> {
    await this.newConversation();
    if (this.composeListeners.size > 0) {
      for (const listener of this.composeListeners) {
        listener(text);
      }
    } else {
      this.pendingCompose = text;
    }
  }

  /** Subscribe to composer-prefill requests. Immediately flushes any queued prompt. */
  subscribeCompose(listener: (text: string) => void): () => void {
    this.composeListeners.add(listener);
    if (this.pendingCompose !== null) {
      const text = this.pendingCompose;
      this.pendingCompose = null;
      listener(text);
    }
    return () => {
      this.composeListeners.delete(listener);
    };
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.composeListeners.clear();
  }

  private async refreshConversations(): Promise<void> {
    const projectId = this.loadedProjectId ?? appState.project.id ?? '';
    try {
      const conversations = await this.historyStore.list(projectId);
      this.setState({ conversations });
    } catch {
      // Best-effort — the history list is a convenience, not the source of truth.
    }
  }

  // ── Agentic loop ────────────────────────────────────────────────────────────

  private async runLoop(signal: AbortSignal): Promise<void> {
    const provider = this.settings.getSelectedProvider();
    if (!provider) {
      throw new LlmError('unknown', 'No LLM provider available.');
    }
    const modelId = this.settings.getSelectedModelId(provider.id) ?? '';
    const apiKey = (await this.settings.getApiKey(provider.id)) ?? '';
    const baseUrl = this.settings.getBaseUrl(provider.id);
    // Stamped onto every assistant turn below so the chat can say who answered. Bridge-backed
    // providers are exactly the ones authenticating with the shared pairing token.
    const origin: AgentTurnOrigin = {
      providerId: provider.id,
      providerLabel: provider.label,
      modelId,
      viaBridge: provider.apiKeySecretId === BRIDGE_TOKEN_SECRET_ID,
    };
    // Flow raises the floor on the iteration cap: a turn there has to reach a PROVEN playable
    // increment (build → compile → play → game_input → report), and a cap tuned for one-off Studio
    // edits force-stops it right after play_start — measured in the eval, where every capped turn
    // ended with the errors never read.
    const preferences = this.settings.getPreferences();
    const maxIterations = Math.max(
      1,
      appState.ui.workspaceMode === 'flow'
        ? Math.max(preferences.maxToolIterations, FLOW_MIN_TOOL_ITERATIONS)
        : preferences.maxToolIterations
    );
    // Model capabilities come from the (possibly live-fetched) catalog: strip tools for models
    // that can't call them, and pass the model's output budget instead of provider flat defaults.
    const model = this.modelCatalog.getModel(provider.id, modelId);
    const tools =
      model?.capabilities.supportsTools === false ? undefined : this.toolRegistry.specs();
    // Reasoning-depth level, only when the (possibly live-fetched) model advertises the chosen one —
    // so the provider can emit it verbatim and a stale/unsupported pick is quietly ignored.
    const reasoningPref =
      this.settings.getReasoningEffort(provider.id, modelId) ?? this.defaultReasoningEffort();
    const reasoningEffort =
      reasoningPref && model?.capabilities.reasoningEfforts?.includes(reasoningPref)
        ? reasoningPref
        : undefined;
    // AGENTS.md is authored per project; read it once per user turn so mid-session edits land.
    const agentsMd = await this.loadAgentsMd();
    // The recipe map (Flow projects only) rides in the cached prefix next to AGENTS.md: it is the
    // agent's map of stable node ids, tunables and extension points, and it is what keeps a turn
    // extending the skeleton instead of rebuilding it.
    const recipeMd = await this.loadRecipeMd();
    // Script inventory shares AGENTS.md's cadence: once per turn, so the agent always knows the
    // project's game-logic files exist (the scene outline names only nodes, never the .ts files).
    const scriptInventory = await this.loadScriptInventory();
    // The ask_advisor rule is only worth prompt space when an advisor is actually usable.
    const advisorAvailable = await this.isAdvisorAvailable();
    // Text-only models can't consume image blocks. We KEEP images in history (so the chat UI shows
    // screenshots/generation previews to the user, and vision models see them) and strip them only
    // from the outbound request, swapping each for a placeholder that points at analyze_image.
    const modelSupportsImages = model?.capabilities.supportsImages !== false;

    // Loop-breaker bookkeeping: last result per identical (tool, args) signature. Cheap models
    // repeat an exact failing call verbatim when the error gives them nothing new (observed with
    // read_skill on an invented section name) — detect the repeat and say so explicitly.
    const lastResultBySignature = new Map<string, string>();
    // How many times each signature came back byte-identical. One repeat gets a text nudge (below);
    // the SECOND repeat is the escalation trigger — measured: the model never consults the advisor
    // on its own, so "consult when stuck" is dead prompt text without an external push.
    const repeatCountBySignature = new Map<string, number>();
    // How many times each single property ("knob") was set this turn, whatever the value.
    const knobTweaks = new Map<string, number>();
    // Consecutive iterations whose tool results were ALL errors — the other shape of "stuck".
    let consecutiveErrorIterations = 0;
    // Forced whole-file rewrites (fs_write overwrite:true past the size guard) — measured in eval
    // S4 as the signature of a model that has lost the thread of what it already changed.
    let forcedOverwrites = 0;
    let escalations = 0;
    // Fire the "you ended with no reply" nudge at most once, so an empty↔nudge exchange can't loop.
    let emptyAnswerNudged = false;
    // Context-fill nudge fires once per turn; compaction/emergency trim have their own thresholds.
    let contextNudged = false;
    const contextWindow = model?.capabilities.contextWindow;
    // Verify-gate: cheap models edit a script and declare victory on `compile_scripts ok` without
    // ever running the game (a real session flipped a car's steering blind 4× and regressed). Track
    // whether game logic changed this turn with no game_input/game_observe proof since; nudge once.
    let unverifiedGameMutation = false;
    // In Studio this is a NUDGE (one push, then the user is right there to judge the result). Flow
    // has no such judge — the turn's whole promise is "playable and proven" — so there it becomes a
    // GATE: the turn is not allowed to close unproven until the attempts run out, and then it must
    // report the failure honestly rather than claim success.
    const verifyAttemptLimit = appState.ui.workspaceMode === 'flow' ? FLOW_VERIFY_ATTEMPTS : 1;
    let gameVerifyNudges = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const system = this.buildSystemPrompt(agentsMd, advisorAvailable, scriptInventory, recipeMd);
      const outboundMessages = modelSupportsImages
        ? this.state.messages
        : stripImagesForModel(this.state.messages);

      // Predict the cacheable span: how much of this request's leading bytes are unchanged from the
      // previous one (tools are always identical, then the stable system head, then any unchanged
      // history). Provider-agnostic and computed before sending, so it exists even when the provider
      // reports no cache usage. Wire order (tools → system → messages) mirrors the real prefix.
      const requestSignature = serializeForCacheDiff(tools, system.text, outboundMessages);
      const predictedCacheTokens =
        this.previousRequestSignature !== null
          ? Math.round(
              commonPrefixLength(this.previousRequestSignature, requestSignature) / CHARS_PER_TOKEN
            )
          : 0;
      this.previousRequestSignature = requestSignature;

      this.debugLog('request', {
        provider: provider.id,
        modelId,
        iteration,
        reasoningEffort,
        system: system.text,
        systemStableChars: system.stableChars,
        predictedCacheTokens,
        tools: tools?.map(tool => tool.name),
        messages: outboundMessages,
      });

      const startedAt = performance.now();
      const result = await this.chatWithRetry(
        provider,
        {
          messages: outboundMessages,
          tools,
          system: system.text,
          cache: { systemStableChars: system.stableChars, conversation: true },
          maxTokens: model?.capabilities.maxOutputTokens,
          reasoningEffort,
          signal,
        },
        { apiKey, modelId, baseUrl },
        signal
      );
      const elapsedMs = performance.now() - startedAt;

      this.debugLog('response', {
        elapsedMs: Math.round(elapsedMs),
        stopReason: result.stopReason,
        usage: result.usage,
        content: result.content,
        raw: result.raw,
      });

      this.accumulateUsage(result.usage);
      const assistantIndex = this.state.messages.length;
      this.appendMessage({ role: 'assistant', content: result.content });
      this.lastRequestInputTokens = result.usage?.inputTokens ?? this.lastRequestInputTokens;
      this.recordTurnMetric(assistantIndex, {
        origin,
        elapsedMs,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        cacheReadTokens: result.usage?.cacheReadTokens,
        cacheCreationTokens: result.usage?.cacheCreationTokens,
        predictedCacheTokens,
      });

      const calls = result.content.filter(
        (block): block is LlmToolUseBlock => block.type === 'tool-use'
      );
      if (calls.length === 0) {
        // A generation cut off by the output-token limit is not a finished turn — the model
        // usually stopped mid-plan, right before a tool call it never got to emit (eval S1
        // ended this way: "Теперь RaceManager:" and silence). Nudge it to continue; the nudge
        // consumes an iteration slot, so it cannot loop past the cap.
        if (result.stopReason === 'max_tokens' && iteration < maxIterations - 1) {
          this.appendMessage({
            role: 'user',
            content: [
              {
                type: 'text',
                text: '[Pix3] Your reply was cut off by the output-token limit before any tool call. Continue from where you stopped. If you were about to write a large file, split it into smaller pieces.',
              },
            ],
          });
          continue;
        }
        // A turn that ends with neither a tool call nor any text is a dropped thread, not an
        // answer (observed: a fix turn that finished silently — no summary, nothing for the
        // user). Ask once for a wrap-up; the flag prevents an empty↔nudge loop.
        const hasText = result.content.some(
          block => block.type === 'text' && block.text.trim().length > 0
        );
        if (!hasText && !emptyAnswerNudged && iteration < maxIterations - 1) {
          emptyAnswerNudged = true;
          this.appendMessage({
            role: 'user',
            content: [
              {
                type: 'text',
                text: '[Pix3] You ended your turn with an empty reply. Summarize for the user what you changed, whether the game runs now, and the single most useful next step.',
              },
            ],
          });
          continue;
        }
        // Verify-gate: don't let a game-logic change close the turn unproven. `compile_scripts ok`
        // is not proof, and `moved:true` is not proof of the RIGHT motion.
        if (
          unverifiedGameMutation &&
          gameVerifyNudges < verifyAttemptLimit &&
          iteration < maxIterations - 1
        ) {
          gameVerifyNudges += 1;
          const isLastAttempt = gameVerifyNudges >= verifyAttemptLimit;
          this.appendMessage({
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  "[Pix3] You changed game logic (a script or scene) this turn but never ran the game to prove it. Before finishing: play_start, then game_input/game_observe on the affected node(s). Check the DIRECTION of motion (expect:{Node:'forward'} → directionOk, or alignForward/delta), not just that it compiles or that `moved` is true — a car driving sideways still reports moved:true." +
                  (isLastAttempt
                    ? ' This is the last reminder: if you genuinely cannot prove it, end your reply with what you tried, what you observed, and what you think is wrong — never with "Done!".'
                    : ` Attempt ${gameVerifyNudges} of ${verifyAttemptLimit}.`),
              },
            ],
          });
          continue;
        }
        return;
      }

      const results: LlmToolResultBlock[] = [];
      const images: LlmImageBlock[] = [];
      const repeatedCalls: string[] = [];
      // First "you are stuck" signal seen this iteration (repeat / errors / forced rewrites).
      let stuckReason: string | null = null;
      let askedQuestion: AgentPendingQuestion | null = null;
      let allToolsErrored = true;
      for (const call of calls) {
        if (signal.aborted) {
          throw new LlmError('aborted', 'The request was cancelled.');
        }
        // Flow only: Studio has a user watching who may well WANT a screenshot mid-turn.
        if (
          appState.ui.workspaceMode === 'flow' &&
          unverifiedGameMutation &&
          VISUAL_TOOLS.has(call.name) &&
          !hasVisualReason(call.input)
        ) {
          results.push({
            type: 'tool-result',
            toolUseId: call.id,
            content: visualToolRefusal(call.name),
            isError: true,
          });
          continue;
        }
        this.setState({ activeTool: call.name });
        const executed = await this.executeToolCall(call);
        results.push(executed.result);
        images.push(...executed.images);
        const signature = `${call.name}:${JSON.stringify(call.input ?? {})}`;
        const resultText =
          typeof executed.result.content === 'string'
            ? executed.result.content
            : JSON.stringify(executed.result.content);
        if (lastResultBySignature.get(signature) === resultText) {
          repeatedCalls.push(call.name);
          const repeats = (repeatCountBySignature.get(signature) ?? 0) + 1;
          repeatCountBySignature.set(signature, repeats);
          if (repeats >= 2 && !stuckReason) {
            stuckReason = `you have now made the same ${call.name} call ${repeats + 1} times and gotten the identical result`;
          }
        }
        lastResultBySignature.set(signature, resultText);
        // Tuning the SAME knob over and over is thrash even when no two calls are identical — the
        // measured case retuned one component property eight times with a different value each
        // time, so the byte-equality check above never fired and the turn burned its whole
        // iteration budget. The knob's identity, not its value, is what repeats.
        const knob = tuningKnobSignature(call.name, call.input);
        if (knob) {
          const tweaks = (knobTweaks.get(knob) ?? 0) + 1;
          knobTweaks.set(knob, tweaks);
          if (tweaks >= KNOB_TWEAK_LIMIT && !stuckReason) {
            stuckReason = `you have now set ${knob.split(':').slice(1).join('.')} ${tweaks} times in this turn — the value is not what is wrong`;
          }
        }
        // A successful state change makes every OTHER remembered result stale: re-running the same
        // observation now CAN return something different, so the nudge's own claim ("repeating it
        // will not change anything") would be false. This call's own signature is kept, so a
        // mutating tool that truly repeats itself verbatim is still caught.
        if (STATE_CHANGING_TOOLS.has(call.name) && executed.result.isError !== true) {
          const ownRepeats = repeatCountBySignature.get(signature);
          lastResultBySignature.clear();
          repeatCountBySignature.clear();
          lastResultBySignature.set(signature, resultText);
          if (ownRepeats !== undefined) {
            repeatCountBySignature.set(signature, ownRepeats);
          }
        }
        if (executed.result.isError !== true) {
          allToolsErrored = false;
        }
        // The fs_write guard reports a forced wholesale rewrite so the loop can count it — a full
        // rewrite of an existing file is a stuck signal, not a normal edit (see AgentToolRegistry).
        if (/"forcedOverwrite"\s*:\s*true/.test(resultText)) {
          forcedOverwrites += 1;
        }
        // A game-logic change is a script/scene write or a component edit; a design/progress .md
        // write or an asset op is not. A successful game_input/game_observe clears the debt.
        if (isGameLogicMutation(call.name, call.input)) {
          unverifiedGameMutation = true;
        } else if (
          (call.name === 'game_input' || call.name === 'game_observe') &&
          /"ok"\s*:\s*true/.test(resultText)
        ) {
          unverifiedGameMutation = false;
        } else if (call.name === 'ask_user') {
          askedQuestion = parseAskUser(call.input);
          // A turn that honestly ends in a question is NOT an unverified turn — otherwise the
          // verify-gate would drag an agent that hit a real fork into pointless verification.
          unverifiedGameMutation = false;
        }
      }
      this.setState({ activeTool: null });
      // Tool-emitted images ride in the same user turn, after the results — all providers accept
      // mixed tool-result + image content there. They are always kept in history (so the UI shows
      // them and vision models see them); the outbound request strips them for text-only models.
      const resultContent: LlmContentBlock[] = [...results, ...images];
      // A question is a legitimate end of turn (§5.4): append the result so the history stays
      // well-formed (every tool_use paired), surface the question, and stop — sending another
      // request here would just have the model answer its own question.
      if (askedQuestion) {
        this.appendMessage({ role: 'user', content: resultContent });
        this.setState({ pendingQuestion: askedQuestion });
        return;
      }
      if (repeatedCalls.length > 0) {
        resultContent.push({
          type: 'text',
          text: `[Pix3] You repeated an identical ${[...new Set(repeatedCalls)].join(', ')} call and got the identical result. Repeating it again will not change anything — re-read the result above and take a different action (different arguments, different tool, or proceed with what you already know).`,
        });
      }
      // Near the iteration cap, tell the model to land the work instead of silently cutting it
      // off mid-task (eval S3 hit the cap right after play_start every turn — errors never read,
      // no final answer). Two iterations is enough for one verification round plus a summary.
      const remaining = maxIterations - 1 - iteration;
      if (remaining > 0 && remaining <= 2) {
        resultContent.push({
          type: 'text',
          text: `[Pix3] Only ${remaining} tool iteration${remaining === 1 ? '' : 's'} left before this turn is force-stopped. Wrap up now: if the game is running, call read_errors; if you keep design/progress.md, fs_write the updated checklist so the next turn can resume; then reply with a short summary of what is done and what remains. Do not start new rewrites.`,
        });
      }

      // Loop-breaker escalation. The plain repeat nudge above is advisory; these are directives,
      // because a model that is genuinely stuck keeps re-reading the same advice.
      if (allToolsErrored) {
        consecutiveErrorIterations += 1;
      } else {
        consecutiveErrorIterations = 0;
      }
      if (!stuckReason && consecutiveErrorIterations >= STUCK_ERROR_ITERATIONS) {
        stuckReason = `every tool call in the last ${consecutiveErrorIterations} iterations failed`;
      }
      if (!stuckReason && forcedOverwrites >= STUCK_FORCED_OVERWRITES) {
        stuckReason = `you have force-overwritten ${forcedOverwrites} existing files wholesale instead of making targeted edits`;
      }
      if (stuckReason && escalations < MAX_STUCK_ESCALATIONS) {
        escalations += 1;
        resultContent.push({
          type: 'text',
          text: advisorAvailable
            ? `[Pix3] You are stuck: ${stuckReason}. Call ask_advisor NOW — before any other tool — and pass, in \`context\`: the goal, the EXACT error text you got, and the relevant code you have already read. Then act on the answer. Do not repeat the failing call.`
            : `[Pix3] You are stuck: ${stuckReason}. Change approach: read something you have not read yet, or try a different tool/argument shape. If you cannot make progress, stop and report honestly what you tried and what blocks you — do not keep retrying.`,
        });
      }

      // Context management (§5.6). Fill ratio comes from the turn we just received; models that
      // report no window opt out of all of this silently.
      const fillRatio =
        contextWindow && result.usage?.inputTokens ? result.usage.inputTokens / contextWindow : 0;
      if (fillRatio >= CONTEXT_NUDGE_RATIO && fillRatio < CONTEXT_COMPACT_RATIO && !contextNudged) {
        contextNudged = true;
        resultContent.push({
          type: 'text',
          text: `[Pix3] Context is filling (${Math.round(fillRatio * 100)}% of the window). Update design/progress.md with what is done and proven, and close out the current increment — do not start a new one.`,
        });
      }
      this.appendMessage({ role: 'user', content: resultContent });

      if (fillRatio >= CONTEXT_EMERGENCY_RATIO) {
        // Old tool results are the bulkiest and least useful part of the history in hindsight.
        this.trimOldToolResults();
      }
      if (fillRatio >= CONTEXT_COMPACT_RATIO) {
        await this.compactConversation(
          provider,
          { apiKey, modelId, baseUrl },
          model?.capabilities.maxOutputTokens,
          signal
        );
      }
    }

    // The cap was hit. Never leave the user with a silent stop: one final round-trip with tools
    // DISABLED, so the model has no choice but to answer in words. Measured: a capped turn ended
    // with 60 tool calls and not one sentence for the user, even though the work was mostly done.
    await this.forceClosingSummary(provider, { apiKey, modelId, baseUrl }, model, origin, signal);

    this.setState({
      notice: `Stopped after ${maxIterations} tool iterations (the cap is configurable in the agent settings). Send a follow-up message to continue.`,
    });
  }

  /**
   * Ask for a plain-language wrap-up with tools switched off. Best-effort: a failure here must not
   * turn a capped-but-useful turn into an error, so it swallows everything.
   */
  private async forceClosingSummary(
    provider: LlmProvider,
    ctx: LlmRequestContext,
    model: LlmModel | undefined,
    origin: AgentTurnOrigin,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }
    this.appendMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[Pix3] You have run out of tool iterations for this turn. No more tools — answer in words only: what is working in the game right now, what you changed, what you could NOT prove, and the single most useful next step. Be honest about anything unfinished; never claim something works if you did not see it run.',
        },
      ],
    });
    try {
      const system = this.buildSystemPrompt(null, false, [], null);
      const startedAt = performance.now();
      const result = await this.chatWithTimeout(
        provider,
        {
          messages: this.state.messages,
          system: system.text,
          maxTokens: model?.capabilities.maxOutputTokens,
          signal,
        },
        ctx,
        signal
      );
      const assistantIndex = this.state.messages.length;
      this.appendMessage({ role: 'assistant', content: result.content });
      // The wrap-up is a real reply, so it carries the same attribution as any other.
      this.recordTurnMetric(assistantIndex, {
        origin,
        elapsedMs: performance.now() - startedAt,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      });
    } catch {
      // A capped turn with no summary is bad; a capped turn that also throws is worse.
    }
  }

  /**
   * One provider round-trip with a single retry for a TRANSIENT failure — an empty completion
   * (free models blip) or a transient HTTP gateway error (5xx / 408 / 429, or an opaque "upstream
   * request failed"), both common on OpenCode Zen's free tier. A lone retry recovers the turn
   * instead of ending it with a cryptic error. Client errors, aborts, missing keys and CORS/network
   * misconfig propagate immediately — see {@link isTransientLlmError}.
   */
  private async chatWithRetry(
    provider: LlmProvider,
    params: ChatParams,
    ctx: LlmRequestContext,
    signal: AbortSignal
  ): Promise<LlmResult> {
    try {
      return await this.chatWithTimeout(provider, params, ctx, signal);
    } catch (error) {
      if (!isTransientLlmError(error) || signal.aborted) {
        throw error;
      }
      this.debugLog('retry', { kind: error.kind, status: error.status });
      await new Promise(resolve => setTimeout(resolve, 600));
      if (signal.aborted) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      return this.chatWithTimeout(provider, params, ctx, signal);
    }
  }

  /**
   * One provider call raced against {@link LLM_REQUEST_TIMEOUT_MS}. The attempt runs on its OWN
   * AbortController chained to the user's signal, so the timeout can cancel that attempt (freeing
   * the socket) without aborting the user's turn — the retry above then gets a clean attempt. The
   * timeout surfaces as a 408 LlmError, which {@link isTransientLlmError} already classifies as
   * retryable; one that survives the retry propagates as a normal turn error.
   */
  private chatWithTimeout(
    provider: LlmProvider,
    params: ChatParams,
    ctx: LlmRequestContext,
    signal: AbortSignal
  ): Promise<LlmResult> {
    const attempt = new AbortController();
    const forwardAbort = (): void => attempt.abort();
    if (signal.aborted) {
      attempt.abort();
    } else {
      signal.addEventListener('abort', forwardAbort);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        attempt.abort();
        reject(
          new LlmError(
            'http',
            `The model did not respond within ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)}s — the request timed out.`,
            408
          )
        );
      }, LLM_REQUEST_TIMEOUT_MS);
    });
    return Promise.race([
      provider.chat({ ...params, signal: attempt.signal }, ctx),
      deadline,
    ]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener('abort', forwardAbort);
    });
  }

  // ── Context management ──────────────────────────────────────────────────────

  /**
   * Emergency valve (≥90% of the window): replace the body of every tool-result block older than
   * the last {@link EMERGENCY_KEEP_MESSAGES} messages with `[trimmed]`. Tool results are by far the
   * bulkiest part of an agentic history and the least useful in hindsight. The stored history is
   * rewritten (not just the outbound copy) so the context actually shrinks and stays shrunk.
   */
  private trimOldToolResults(): number {
    const messages = this.state.messages;
    const cutoff = messages.length - EMERGENCY_KEEP_MESSAGES;
    if (cutoff <= 0) {
      return 0;
    }
    let trimmed = 0;
    const next = messages.map((message, index) => {
      if (index >= cutoff || typeof message.content === 'string') {
        return message;
      }
      const hasTrimmable = message.content.some(
        block => block.type === 'tool-result' && block.content !== TRIMMED_MARKER
      );
      if (!hasTrimmable) {
        return message;
      }
      trimmed += 1;
      const content: LlmContentBlock[] = message.content.map(block =>
        block.type === 'tool-result' ? { ...block, content: TRIMMED_MARKER } : block
      );
      return { role: message.role, content };
    });
    if (trimmed > 0) {
      this.setState({ messages: next });
      this.debugLog('context-trim', { messages: trimmed });
    }
    return trimmed;
  }

  /**
   * Compact (≥75% of the window): ask the model — in one extra tool-free round-trip — for a handoff
   * to its next self, then REPLACE the history with the user's original request plus that handoff
   * and the project's design docs. Measured (eval, advisor section): the same task a long polluted
   * conversation kept circling on is solved without help in a fresh conversation with a compact
   * brief. Best-effort: if the handoff request fails we keep the full history rather than lose work
   * (the emergency trim above still bounds the growth).
   */
  private async compactConversation(
    provider: LlmProvider,
    ctx: LlmRequestContext,
    maxTokens: number | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const messages = this.state.messages;
    if (messages.length < MIN_MESSAGES_TO_COMPACT) {
      return;
    }
    // The user's original request is never summarized away — it IS the task.
    const firstUser = messages.find(message => message.role === 'user');
    if (!firstUser) {
      return;
    }

    let handoff = '';
    try {
      const result = await this.chatWithTimeout(
        provider,
        {
          messages: [
            ...messages,
            {
              role: 'user',
              content: [{ type: 'text', text: COMPACT_REQUEST_PROMPT }],
            },
          ],
          system: COMPACT_SYSTEM_PROMPT,
          maxTokens,
          signal,
        },
        ctx,
        signal
      );
      handoff = result.content
        .filter((block): block is LlmTextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
    } catch (error) {
      this.debugLog('compact-failed', error);
      return;
    }
    if (!handoff) {
      return;
    }

    const docs = await this.loadHandoffDocs();
    const lines = [
      '[Pix3] The earlier conversation was compacted to free context. Handoff from your previous self:',
      handoff,
    ];
    if (docs) {
      lines.push('', 'Project design docs, as they currently are on disk:', docs);
    }
    lines.push(
      '',
      'Continue from here. The original request is the first message above — it still stands.'
    );

    const compacted: LlmMessage[] = [
      firstUser,
      { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] },
    ];
    this.setState({
      messages: compacted,
      // The boundary sits before the handoff message; turn metrics were keyed by the OLD indices,
      // so they are dropped rather than left pointing at unrelated messages.
      compactedAtIndices: [...this.state.compactedAtIndices, compacted.length - 1],
      turnMetrics: {},
    });
    // The cached prefix is gone with the history — a diff against the old request is meaningless.
    this.previousRequestSignature = null;
    this.debugLog('context-compacted', { handoffChars: handoff.length });
  }

  /** Read the project's design docs for a compaction handoff (best-effort, each capped). */
  private async loadHandoffDocs(): Promise<string> {
    const sections: string[] = [];
    for (const path of HANDOFF_DOCS) {
      try {
        const content = await this.storage.readTextFile(path);
        if (!content?.trim()) continue;
        const body =
          content.length > MAX_HANDOFF_DOC_CHARS
            ? `${content.slice(0, MAX_HANDOFF_DOC_CHARS)}\n… [truncated]`
            : content;
        sections.push(`--- ${path} ---\n${body.trim()}`);
      } catch {
        // Missing doc is the common case (not every project keeps them).
      }
    }
    return sections.join('\n\n');
  }

  /**
   * Execute one tool call; failures become `isError` results for the model, never loop aborts.
   * Images a handler returns under {@link AGENT_TOOL_IMAGES_KEY} are lifted out of the JSON and
   * handed back as real image blocks (so the model sees pixels, not base64 text).
   */
  private async executeToolCall(
    call: LlmToolUseBlock
  ): Promise<{ result: LlmToolResultBlock; images: LlmImageBlock[] }> {
    const base = { type: 'tool-result' as const, toolUseId: call.id, toolName: call.name };
    try {
      const args = isRecord(call.input) ? call.input : {};
      const value = await this.toolRegistry.execute(call.name, args);

      let payload: unknown = value ?? null;
      const images: LlmImageBlock[] = [];
      if (isRecord(payload) && Array.isArray(payload[AGENT_TOOL_IMAGES_KEY])) {
        for (const image of payload[AGENT_TOOL_IMAGES_KEY]) {
          if (
            isRecord(image) &&
            typeof image.mimeType === 'string' &&
            typeof image.data === 'string'
          ) {
            images.push({ type: 'image', mimeType: image.mimeType, data: image.data });
          }
        }
        const { [AGENT_TOOL_IMAGES_KEY]: _omitted, ...rest } = payload;
        payload = rest;
      }

      return { result: { ...base, content: truncate(JSON.stringify(payload)) }, images };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { result: { ...base, content: truncate(message), isError: true }, images: [] };
    }
  }

  // ── System prompt ───────────────────────────────────────────────────────────

  /**
   * Resolve the full system prompt exactly as it is sent to the provider (including AGENTS.md and
   * the live scene context). Used by the debug panel's "system prompt" viewer.
   */
  async previewSystemPrompt(): Promise<string> {
    return this.buildSystemPrompt(
      await this.loadAgentsMd(),
      await this.isAdvisorAvailable(),
      await this.loadScriptInventory(),
      await this.loadRecipeMd()
    ).text;
  }

  /** Whether ask_advisor can actually reach a model (configured + keyed). Never throws. */
  private async isAdvisorAvailable(): Promise<boolean> {
    try {
      return (await this.advisorService.resolveAdvisor()) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Rebuilt per request. Returns the full prompt plus `stableChars`: the length of the leading,
   * request-stable slice (rules + skills + AGENTS.md) that is safe to cache. Everything after it —
   * the "Project context" block: active scene, selection, scene outline — changes as the agent works
   * and must stay out of the cached prefix, so it is appended last and excluded from `stableChars`.
   */
  private buildSystemPrompt(
    agentsMd: string | null,
    advisorAvailable = false,
    scripts: readonly ScriptInventoryEntry[] = [],
    recipeMd: string | null = null
  ): { text: string; stableChars: number } {
    const soul = resolveSoul(this.settings.getPreferences());

    const lines: string[] = [
      `You are ${soul.name}, an AI assistant embedded in the Pix3 editor (a browser-based editor for HTML5 games mixing 2D and 3D).`,
    ];

    if (soul.prompt) {
      lines.push(
        '',
        'Personality:',
        soul.prompt,
        "Stay in character in every chat reply and match the user's language. Keep quips to a sentence or two — the persona shapes HOW you talk, never WHAT you do: tool calls, code quality, technical accuracy and warnings always come first and stay factual."
      );
    }

    lines.push(
      '',
      'Rules:',
      '- Use the provided tools to inspect and change the project; never guess scene or file contents you can read.',
      '- Scene changes go through set_property / create_node / convert_node_type / move_node / run_command — they are undoable, so ALWAYS prefer them over hand-editing .pix3scene files. If set_property fails, fix the CALL (pass value as a real JSON object/number/array — {"x":10,"y":-20}, 90, [1,1] — never a quoted string); do NOT fall back to str_replace / fs_write on the scene file to work around it.',
      '- To reparent a node OR change draw order, use move_node — never reorder nodes by hand-editing the .pix3scene. For 2D, paint order follows sibling order (a LATER sibling draws ON TOP): to put one node above another, move_node it to placement:"front" or afterSiblingId of the node it must cover. To lift a 2D node above nodes it is NOT a sibling of (or without touching the tree at all), set_property zIndex instead — higher draws on top, it is inherited by the subtree, and ties fall back to tree order.',
      '- Rotation units differ by surface: set_property and the runtime (rotationZ) use RADIANS, but the .pix3scene `transform.rotation` field is DEGREES. If you ever do edit the scene YAML by hand, write degrees (90), not radians (1.5708).',
      '- If a node property is recomputed every frame by a script/component (e.g. a controller that drives position along a path), a one-off scene/property edit will NOT hold at runtime — configure the script instead (set_component_property on its exposed fields). If the behaviour genuinely needs a script code change, make it and say so in your reply.',
      '- To give a node behaviour, attach a component: call list_component_types, then add_component (built-in "core:*" behaviours or a project "user:*" script), then configure it with set_component_property. Never hand-edit scene files to add a component.',
      '- For custom logic, write a Script subclass with fs_write under scripts/, run compile_scripts, then attach it with add_component using its "user:<ExportName>" type.',
      '- After editing scripts with fs_write, run compile_scripts: it builds, registers AND type-checks in one call, returning any type diagnostics itself. Never chase it with check_scripts.',
      '- Verify behaviour when it matters: play_start / play_status, then read_errors and read_logs.',
      '- File paths are relative to the project root.',
      "- When a task matches a skill below and you are not already sure of this editor's exact tools/steps for it, read it with read_skill. Follow its tool/format specifics exactly, but treat its process as adaptable guidance — override it when you have a better plan for the task.",
      '- Budget your exploration: read what you need in order to act, then act, then verify. Do not spend iterations surveying the project — a cheap model burned ~15 iterations on reconnaissance and hit the cap before changing anything. Prefer one targeted read over a directory sweep, and stop reading as soon as you can make the change.',
      '- Be concise. Reply in the language the user writes in.'
    );

    if (advisorAvailable) {
      lines.push(
        '- A stronger advisor model is available via ask_advisor. Consult it when an error survives ~2 fix attempts or before committing to a non-obvious design/architecture choice — pass the goal, exact error, and relevant code in `context`. Use it sparingly (a couple of calls per task at most) and weigh its advice against what you actually observe.'
      );
    }

    const skillIndex = this.skills.indexLines();
    if (skillIndex.length > 0) {
      lines.push(
        '',
        'Skills (read the relevant one with read_skill when you need the editor-specific recipe):',
        ...skillIndex
      );
    }

    if (agentsMd) {
      const trimmed =
        agentsMd.length > MAX_AGENTS_MD_CHARS
          ? `${agentsMd.slice(0, MAX_AGENTS_MD_CHARS)}\n… [AGENTS.md truncated]`
          : agentsMd;
      lines.push(
        '',
        'Project-specific instructions (from AGENTS.md at the project root) — follow these:',
        '"""',
        trimmed.trim(),
        '"""'
      );
    }

    if (recipeMd) {
      const trimmed =
        recipeMd.length > MAX_RECIPE_MD_CHARS
          ? `${recipeMd.slice(0, MAX_RECIPE_MD_CHARS)}\n… [recipe.md truncated]`
          : recipeMd;
      lines.push(
        '',
        'Recipe map (design/recipe.md) — this project was expanded from a playable recipe skeleton. These are its stable node ids, placeholders, tunables and declared extension points. EXTEND it at those points; do not rebuild what is already there:',
        '"""',
        trimmed.trim(),
        '"""'
      );
    }

    // Everything above is request-stable and forms the cached prefix; everything below is live
    // scene context that changes turn-to-turn. Record the boundary (the join of the stable lines,
    // before the '\n' that precedes "Project context:") so the provider can place its breakpoint.
    const stableChars = lines.join('\n').length;

    lines.push('', 'Project context:');

    const project = appState.project;
    lines.push(`- Project: ${project.projectName ?? 'Pix3 Project'} (backend: ${project.backend})`);

    const scenePaths = Object.values(appState.scenes.descriptors).map(d => d.filePath);
    if (scenePaths.length > 0) {
      lines.push(`- Scenes: ${scenePaths.join(', ')}`);
    }
    const activeSceneId = appState.scenes.activeSceneId;
    const activePath = activeSceneId ? appState.scenes.descriptors[activeSceneId]?.filePath : null;
    if (activePath) {
      lines.push(`- Active scene: ${activePath}`);
    }

    if (scripts.length > 0) {
      lines.push(
        `- Project scripts (${SCRIPT_DIRECTORIES.join(
          ', '
        )}) — the game logic; attach one to a node with add_component using the shown user:<Class> id:`
      );
      for (const script of scripts) {
        const ids =
          script.classes.length > 0
            ? script.classes.map(className => `user:${className}`).join(', ')
            : '(no exported Script subclass)';
        lines.push(`    - ${script.path} → ${ids}`);
      }
    }

    const selectedIds = appState.selection.nodeIds;
    if (selectedIds.length > 0) {
      const graph = this.sceneManager.getActiveSceneGraph();
      const labels = selectedIds.slice(0, 12).map(id => {
        const node = graph?.nodeMap.get(id);
        return node ? `${node.name} (${node.type}) [${id}]` : `[${id}]`;
      });
      const extra =
        selectedIds.length > labels.length ? ` (+${selectedIds.length - labels.length} more)` : '';
      lines.push(`- Selected node(s): ${labels.join(', ')}${extra}`);
    }

    const outline = this.buildSceneOutline();
    if (outline.length > 0) {
      lines.push(`- Active scene outline (node name (type) [nodeId], depth ${OUTLINE_DEPTH}):`);
      lines.push(...outline);
    }

    return { text: lines.join('\n'), stableChars };
  }

  private buildSceneOutline(): string[] {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) {
      return [];
    }
    const lines: string[] = [];
    let truncatedNodes = 0;

    const visit = (node: NodeBase, depth: number): void => {
      if (lines.length >= MAX_OUTLINE_LINES) {
        truncatedNodes += 1;
        return;
      }
      lines.push(`${'  '.repeat(depth + 1)}- ${node.name} (${node.type}) [${node.nodeId}]`);
      const children = node.children.filter((c): c is NodeBase => c instanceof NodeBase);
      if (depth + 1 >= OUTLINE_DEPTH && children.length > 0) {
        lines.push(
          `${'  '.repeat(depth + 2)}… ${children.length} child node(s) — use scene_tree/node_inspect for detail`
        );
        return;
      }
      for (const child of children) {
        visit(child, depth + 1);
      }
    };

    for (const root of graph.rootNodes) {
      if (root instanceof NodeBase) {
        visit(root, 0);
      }
    }
    if (truncatedNodes > 0) {
      lines.push(`  … (+${truncatedNodes} more nodes — use scene_tree)`);
    }
    return lines;
  }

  /**
   * Enumerate the project's user scripts (scripts/ + src/scripts/) with the Script subclasses each
   * exports, so buildSystemPrompt can list them. Best-effort: any fs error (no project, missing
   * directory) yields an empty inventory and thus no "Project scripts" bullet. Gathered once per
   * user turn (like AGENTS.md), not per tool-iteration — script files rarely change mid-turn.
   */
  private async loadScriptInventory(): Promise<ScriptInventoryEntry[]> {
    const scripts: ScriptInventoryEntry[] = [];
    for (const directory of SCRIPT_DIRECTORIES) {
      for (const path of await this.collectScriptPaths(directory)) {
        if (scripts.length >= MAX_SCRIPT_INVENTORY) {
          return scripts;
        }
        try {
          const content = await this.storage.readTextFile(path);
          // matchAll clones the regex, so the shared /g instance carries no lastIndex state.
          const classes = [...content.matchAll(SCRIPT_CLASS_PATTERN)].map(match => match[1]);
          scripts.push({ path, classes });
        } catch {
          // A file that vanished mid-scan is fine — skip it.
        }
      }
    }
    return scripts;
  }

  private async collectScriptPaths(directory: string): Promise<string[]> {
    let entries: Awaited<ReturnType<ProjectStorageService['listDirectory']>>;
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

  /**
   * Read the project's AGENTS.md (best-effort). Returns the first non-empty candidate, or null when
   * none exists / the project has no file backend. Never throws — a missing file is the common case.
   */
  private async loadAgentsMd(): Promise<string | null> {
    for (const path of AGENTS_FILES) {
      try {
        const content = await this.storage?.readTextFile(path);
        if (content && content.trim()) {
          return content;
        }
      } catch {
        // Not present / unreadable — try the next candidate.
      }
    }
    return null;
  }

  /**
   * Reasoning depth when the user has not pinned one.
   *
   * In Flow the wait *is* the product: a measured increment spent 55 round-trips at a 5.4 s median,
   * with the 15 s–69 s tails all being thinking time on steps whose shape (read this file, patch
   * that line, restart and tap) does not reward it. Studio keeps the model's own default, where a
   * user watching a single deliberate edit would rather have the deeper answer.
   */
  private defaultReasoningEffort(): ReasoningEffort | undefined {
    return appState.ui.workspaceMode === 'flow' ? 'low' : undefined;
  }

  /**
   * Read the project's recipe map (best-effort). Present only in projects expanded from a Flow
   * recipe; a missing file is the normal case everywhere else and yields null.
   */
  private async loadRecipeMd(): Promise<string | null> {
    try {
      const content = await this.storage?.readTextFile(RECIPE_MD_PATH);
      return content && content.trim() ? content : null;
    } catch {
      return null;
    }
  }

  private debugLog(label: string, data: unknown): void {
    if (!this.settings.getPreferences().debugMode) {
      return;
    }
    console.debug(`[Pix3 Agent] ${label}`, data);
  }

  // ── State / persistence plumbing ───────────────────────────────────────────

  private appendMessage(message: LlmMessage): void {
    this.setState({ messages: [...this.state.messages, message] });
  }

  private recordTurnMetric(index: number, metric: AgentTurnMetric): void {
    this.setState({ turnMetrics: { ...this.state.turnMetrics, [index]: metric } });
  }

  private accumulateUsage(usage: LlmUsage | undefined): void {
    if (!usage) {
      return;
    }
    const total = this.state.totalUsage;
    const sum = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    this.setState({
      totalUsage: {
        inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0),
        outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        cacheReadTokens: sum(total.cacheReadTokens, usage.cacheReadTokens),
      },
    });
  }

  private persist(): void {
    const messages = this.state.messages;
    if (messages.length === 0) {
      return; // Never persist an empty conversation — it would clutter the history list.
    }
    const projectId = this.loadedProjectId ?? appState.project.id ?? '';
    let id = this.state.activeConversationId;
    if (!id) {
      id = newConversationId();
      this.setState({ activeConversationId: id });
    }
    if (!this.activeCreatedAt) {
      this.activeCreatedAt = Date.now();
    }
    const record: AgentConversationRecord = {
      id,
      projectId,
      title: deriveConversationTitle(messages),
      messages: [...messages],
      turnMetrics: { ...this.state.turnMetrics },
      createdAt: this.activeCreatedAt,
      updatedAt: Date.now(),
    };
    this.historyStore
      .put(record)
      .then(() => this.refreshConversations())
      .catch(() => {
        // Persistence is best-effort; the in-memory conversation stays authoritative.
      });
  }

  private setState(patch: Partial<AgentChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

const truncate = (text: string): string =>
  text.length <= MAX_TOOL_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… [truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars — request a narrower query]`;

/** System prompt for the (tool-free) compaction round-trip. */
const COMPACT_SYSTEM_PROMPT =
  'You are summarizing your own working session so a fresh instance of yourself can continue it without re-reading the conversation. Be specific and factual; no pleasantries.';

/** The compaction request itself — asks for exactly the four things a successor needs. */
const COMPACT_REQUEST_PROMPT =
  "[Pix3] Context is nearly full, so this conversation is about to be compacted. Write a compact handoff for the next instance of yourself, in four short sections: (1) DONE — what you changed, with file/node names; (2) PROVEN — what you actually verified and how (game_input/read_errors results), and what is still unverified; (3) NEXT — the single next step and how to verify it; (4) DECISIONS — choices already made (including the user's answers) that must not be revisited. Facts only, no narrative. Do not call any tools.";

/**
 * Read an `ask_user` call's arguments defensively — the question text is user-visible UI, so a
 * malformed call must degrade to a readable prompt rather than render `undefined` as a chip.
 */
const parseAskUser = (input: unknown): AgentPendingQuestion => {
  const args = isRecord(input) ? input : {};
  const question =
    typeof args.question === 'string' && args.question.trim()
      ? args.question.trim()
      : 'The agent asked a question but did not include its text.';
  const options = Array.isArray(args.options)
    ? args.options.filter(
        (option): option is string => typeof option === 'string' && !!option.trim()
      )
    : [];
  return { question, options, allowFreeform: args.allowFreeform !== false };
};

/** Rough tokens-per-character ratio for estimating the cacheable prefix (English/JSON ≈ 4). */
const CHARS_PER_TOKEN = 4;

/**
 * Serialize a request's cache-relevant parts in wire order (tools → system → messages) into a
 * single string, so two consecutive requests can be compared by common leading bytes. Long `data`
 * fields (image base64) are replaced with a length marker — this agent carries screenshots every
 * turn, and copying megabytes of base64 into the comparison string each iteration would be wasteful;
 * a differing image still changes its length, which is enough to break the prefix.
 */
const serializeForCacheDiff = (
  tools: unknown,
  system: string,
  messages: readonly LlmMessage[]
): string =>
  JSON.stringify([tools ?? null, system, messages], (key, value) =>
    key === 'data' && typeof value === 'string' && value.length > 64
      ? `«img:${value.length}»`
      : value
  );

/** Length (in chars) of the longest common leading run of two strings. */
const commonPrefixLength = (a: string, b: string): number => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  return i;
};

const IMAGE_PLACEHOLDER =
  '[image not shown — this model cannot see images; call analyze_image with the image source ' +
  '(a project image path, "viewport", or the generated asset) to inspect it via a vision helper]';

/**
 * Return a copy of the history with every image block swapped for a text placeholder, for sending
 * to a model that can't see images. The images stay in {@link AgentChatState.messages} untouched —
 * only the outbound provider payload is sanitized — so the chat UI still shows them to the user.
 */
const stripImagesForModel = (messages: readonly LlmMessage[]): LlmMessage[] =>
  messages.map(message => {
    if (typeof message.content === 'string') {
      return message;
    }
    if (!message.content.some(block => block.type === 'image')) {
      return message;
    }
    const content: LlmContentBlock[] = message.content.map(block =>
      block.type === 'image' ? { type: 'text', text: IMAGE_PLACEHOLDER } : block
    );
    return { role: message.role, content };
  });

/** Max length of a derived conversation title. */
const MAX_TITLE_CHARS = 48;

/** Unique conversation id. Uses crypto.randomUUID when available, else a timestamped fallback. */
const newConversationId = (): string => {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return `conv-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

/** Short label for the history list, taken from the first user message's text. */
const deriveConversationTitle = (messages: readonly LlmMessage[]): string => {
  const firstUser = messages.find(message => message.role === 'user');
  if (!firstUser) {
    return 'New chat';
  }
  const raw =
    typeof firstUser.content === 'string'
      ? firstUser.content
      : firstUser.content.map(block => (block.type === 'text' ? block.text : '')).join(' ');
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return 'New chat';
  }
  return clean.length > MAX_TITLE_CHARS ? `${clean.slice(0, MAX_TITLE_CHARS)}…` : clean;
};

/**
 * Assemble a user turn from the typed text plus attachments. Text files are inlined into the text
 * block (fenced by name); images become real image blocks after the text. When nothing but the text
 * exists this yields exactly one text block, keeping the common case identical to the old behaviour.
 */
const buildUserContent = (
  text: string,
  images: readonly LlmImageBlock[],
  texts: readonly AgentTextAttachment[]
): LlmContentBlock[] => {
  let body = text;
  for (const file of texts) {
    body += `${body ? '\n\n' : ''}--- Attached file: ${file.name} ---\n${file.content}`;
  }

  const blocks: LlmContentBlock[] = [];
  if (body.trim()) {
    blocks.push({ type: 'text', text: body } satisfies LlmTextBlock);
  }
  for (const image of images) {
    blocks.push(image);
  }
  if (blocks.length === 0) {
    // Defensive: at least send an empty text block so the turn is well-formed.
    blocks.push({ type: 'text', text } satisfies LlmTextBlock);
  }
  return blocks;
};

/** Type-only re-export so UI code can render content blocks without importing llm internals. */
export type { LlmContentBlock, LlmMessage };
