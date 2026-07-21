import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { SceneManager, NodeBase } from '@pix3/runtime';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import { AgentToolRegistry, AGENT_TOOL_IMAGES_KEY } from '@/services/agent/AgentToolRegistry';
import { AgentAdvisorService } from '@/services/agent/AgentAdvisorService';
import { AgentSkillsService } from '@/services/agent/AgentSkillsService';
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
  type LlmProvider,
  type LlmRequestContext,
  type LlmResult,
  type LlmTextBlock,
  type LlmToolResultBlock,
  type LlmToolUseBlock,
  type LlmUsage,
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

/** Timing / token accounting for a single provider round-trip (surfaced only in debug mode). */
export interface AgentTurnMetric {
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
}

/** Project-root files scanned (in order) for user-authored agent instructions. */
const AGENTS_FILES = ['AGENTS.md', 'agents.md', '.agents.md'] as const;
/** Cap the AGENTS.md slice of the system prompt so a huge file can't dominate the context. */
const MAX_AGENTS_MD_CHARS = 16_000;

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
  if (toolName === 'fs_write') {
    const path = (input as { path?: unknown } | null | undefined)?.path;
    return typeof path === 'string' && /\.(ts|pix3scene)$/i.test(path);
  }
  return false;
};

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
      if (conversations.length > 0) {
        const latest = conversations[0]; // list() returns newest first
        const record = await this.historyStore.get(latest.id);
        this.setState({
          ...IDLE_STATE,
          conversations,
          activeConversationId: latest.id,
          messages: record?.messages ?? [],
        });
        this.activeCreatedAt = record?.createdAt ?? Date.now();
      } else {
        this.setState({ ...IDLE_STATE, conversations });
        this.activeCreatedAt = 0;
      }
    } catch {
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

    // A fresh (unsaved) conversation gets its id/created-at on the first message.
    if (!this.state.activeConversationId) {
      this.setState({ activeConversationId: newConversationId() });
      this.activeCreatedAt = Date.now();
    }

    this.appendMessage({ role: 'user', content: buildUserContent(trimmed, images, texts) });
    await this.runToSettled();
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
    this.setState({ status: 'running', errorMessage: null, errorKind: null, notice: null });
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
    const maxIterations = Math.max(1, this.settings.getPreferences().maxToolIterations);
    // Model capabilities come from the (possibly live-fetched) catalog: strip tools for models
    // that can't call them, and pass the model's output budget instead of provider flat defaults.
    const model = this.modelCatalog.getModel(provider.id, modelId);
    const tools =
      model?.capabilities.supportsTools === false ? undefined : this.toolRegistry.specs();
    // Reasoning-depth level, only when the (possibly live-fetched) model advertises the chosen one —
    // so the provider can emit it verbatim and a stale/unsupported pick is quietly ignored.
    const reasoningPref = this.settings.getReasoningEffort(provider.id, modelId);
    const reasoningEffort =
      reasoningPref && model?.capabilities.reasoningEfforts?.includes(reasoningPref)
        ? reasoningPref
        : undefined;
    // AGENTS.md is authored per project; read it once per user turn so mid-session edits land.
    const agentsMd = await this.loadAgentsMd();
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
    // Fire the "you ended with no reply" nudge at most once, so an empty↔nudge exchange can't loop.
    let emptyAnswerNudged = false;
    // Verify-gate: cheap models edit a script and declare victory on `compile_scripts ok` without
    // ever running the game (a real session flipped a car's steering blind 4× and regressed). Track
    // whether game logic changed this turn with no game_input/game_observe proof since; nudge once.
    let unverifiedGameMutation = false;
    let gameVerifyNudged = false;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const system = this.buildSystemPrompt(agentsMd, advisorAvailable, scriptInventory);
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
      this.recordTurnMetric(assistantIndex, {
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
        // is not proof, and `moved:true` is not proof of the RIGHT motion. Ask once for a real run.
        if (unverifiedGameMutation && !gameVerifyNudged && iteration < maxIterations - 1) {
          gameVerifyNudged = true;
          this.appendMessage({
            role: 'user',
            content: [
              {
                type: 'text',
                text: "[Pix3] You changed game logic (a script or scene) this turn but never ran the game to prove it. Before finishing: play_start, then game_input/game_observe on the affected node(s). Check the DIRECTION of motion (expect:{Node:'forward'} → directionOk, or alignForward/delta), not just that it compiles or that `moved` is true — a car driving sideways still reports moved:true. If you genuinely cannot run it, say why in your summary.",
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
      for (const call of calls) {
        if (signal.aborted) {
          throw new LlmError('aborted', 'The request was cancelled.');
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
        }
        lastResultBySignature.set(signature, resultText);
        // A game-logic change is a script/scene write or a component edit; a design/progress .md
        // write or an asset op is not. A successful game_input/game_observe clears the debt.
        if (isGameLogicMutation(call.name, call.input)) {
          unverifiedGameMutation = true;
        } else if (
          (call.name === 'game_input' || call.name === 'game_observe') &&
          /"ok"\s*:\s*true/.test(resultText)
        ) {
          unverifiedGameMutation = false;
        }
      }
      this.setState({ activeTool: null });
      // Tool-emitted images ride in the same user turn, after the results — all providers accept
      // mixed tool-result + image content there. They are always kept in history (so the UI shows
      // them and vision models see them); the outbound request strips them for text-only models.
      const resultContent: LlmContentBlock[] = [...results, ...images];
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
      this.appendMessage({ role: 'user', content: resultContent });
    }

    this.setState({
      notice: `Stopped after ${maxIterations} tool iterations (the cap is configurable in the agent settings). Send a follow-up message to continue.`,
    });
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
      return await provider.chat(params, ctx);
    } catch (error) {
      if (!isTransientLlmError(error) || signal.aborted) {
        throw error;
      }
      this.debugLog('retry', { kind: error.kind, status: error.status });
      await new Promise(resolve => setTimeout(resolve, 600));
      if (signal.aborted) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      return provider.chat(params, ctx);
    }
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
      await this.loadScriptInventory()
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
    scripts: readonly ScriptInventoryEntry[] = []
  ): { text: string; stableChars: number } {
    const lines: string[] = [
      'You are Pix3 Agent, an AI assistant embedded in the Pix3 editor (a browser-based editor for HTML5 games mixing 2D and 3D).',
      '',
      'Rules:',
      '- Use the provided tools to inspect and change the project; never guess scene or file contents you can read.',
      '- Scene changes go through set_property / create_node / convert_node_type / move_node / run_command — they are undoable, so ALWAYS prefer them over hand-editing .pix3scene files. If set_property fails, fix the CALL (pass value as a real JSON object/number/array — {"x":10,"y":-20}, 90, [1,1] — never a quoted string); do NOT fall back to str_replace / fs_write on the scene file to work around it.',
      '- To reparent a node OR change draw order, use move_node — never reorder nodes by hand-editing the .pix3scene. For 2D, paint order follows sibling order (a LATER sibling draws ON TOP): to put one node above another, move_node it to placement:"front" or afterSiblingId of the node it must cover.',
      '- Rotation units differ by surface: set_property and the runtime (rotationZ) use RADIANS, but the .pix3scene `transform.rotation` field is DEGREES. If you ever do edit the scene YAML by hand, write degrees (90), not radians (1.5708).',
      '- If a node property is recomputed every frame by a script/component (e.g. a controller that drives position along a path), a one-off scene/property edit will NOT hold at runtime — configure the script instead (set_component_property on its exposed fields). If the behaviour genuinely needs a script code change, make it and say so in your reply.',
      '- To give a node behaviour, attach a component: call list_component_types, then add_component (built-in "core:*" behaviours or a project "user:*" script), then configure it with set_component_property. Never hand-edit scene files to add a component.',
      '- For custom logic, write a Script subclass with fs_write under scripts/, run compile_scripts, then attach it with add_component using its "user:<ExportName>" type.',
      '- After editing scripts with fs_write, run compile_scripts to check they build.',
      '- Verify behaviour when it matters: play_start / play_status, then read_errors and read_logs.',
      '- File paths are relative to the project root.',
      "- When a task matches a skill below and you are not already sure of this editor's exact tools/steps for it, read it with read_skill. Follow its tool/format specifics exactly, but treat its process as adaptable guidance — override it when you have a better plan for the task.",
      '- Be concise. Reply in the language the user writes in.',
    ];

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
