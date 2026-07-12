import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { SceneManager, NodeBase } from '@pix3/runtime';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { AgentToolRegistry, AGENT_TOOL_IMAGES_KEY } from '@/services/agent/AgentToolRegistry';
import { AgentChatHistoryStore } from './AgentChatHistoryStore';
import {
  LlmError,
  isRecord,
  type LlmContentBlock,
  type LlmErrorKind,
  type LlmImageBlock,
  type LlmMessage,
  type LlmToolResultBlock,
  type LlmToolUseBlock,
  type LlmUsage,
} from '@/services/llm/LlmTypes';

export type AgentChatStatus = 'idle' | 'running' | 'error';

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
}

/** Cap serialized tool results so one verbose tool cannot blow up the context window. */
const MAX_TOOL_RESULT_CHARS = 24_000;
/** Cap the scene-outline part of the system prompt. */
const MAX_OUTLINE_LINES = 120;
const OUTLINE_DEPTH = 2;

const IDLE_STATE: AgentChatState = {
  status: 'idle',
  messages: [],
  errorMessage: null,
  errorKind: null,
  notice: null,
  activeTool: null,
  totalUsage: {},
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

  @inject(AgentToolRegistry)
  private readonly toolRegistry!: AgentToolRegistry;

  @inject(AgentChatHistoryStore)
  private readonly historyStore!: AgentChatHistoryStore;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  private state: AgentChatState = IDLE_STATE;
  private readonly listeners = new Set<(state: AgentChatState) => void>();
  private abortController: AbortController | null = null;
  /** Project id whose conversation is currently loaded (histories are per project). */
  private loadedProjectId: string | null = null;

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
   * Load the current project's persisted conversation (no-op when already loaded). Safe to call
   * from the panel on connect; a running turn is never interrupted by a load.
   */
  async ensureLoaded(): Promise<void> {
    const projectId = appState.project.id ?? '';
    if (this.loadedProjectId === projectId || this.isRunning()) {
      return;
    }
    this.loadedProjectId = projectId;
    try {
      const record = await this.historyStore.get(projectId);
      this.setState({ ...IDLE_STATE, messages: record?.messages ?? [] });
    } catch {
      this.setState({ ...IDLE_STATE });
    }
  }

  /** Send a user message and run the agentic loop until the model stops calling tools. */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.isRunning()) {
      return;
    }

    await this.ensureLoaded();

    this.abortController = new AbortController();
    this.appendMessage({ role: 'user', content: [{ type: 'text', text: trimmed }] });
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

  /** Drop the conversation (memory + persisted copy) and start fresh. */
  async newConversation(): Promise<void> {
    this.stop();
    this.setState({ ...IDLE_STATE });
    const projectId = appState.project.id ?? '';
    this.loadedProjectId = projectId;
    try {
      await this.historyStore.delete(projectId);
    } catch {
      // Persistence is best-effort.
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
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
    const tools = this.toolRegistry.specs();

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const result = await provider.chat(
        {
          messages: this.state.messages,
          tools,
          system: this.buildSystemPrompt(),
          signal,
        },
        { apiKey, modelId, baseUrl }
      );

      this.accumulateUsage(result.usage);
      this.appendMessage({ role: 'assistant', content: result.content });

      const calls = result.content.filter(
        (block): block is LlmToolUseBlock => block.type === 'tool-use'
      );
      if (calls.length === 0) {
        return;
      }

      const results: LlmToolResultBlock[] = [];
      const images: LlmImageBlock[] = [];
      for (const call of calls) {
        if (signal.aborted) {
          throw new LlmError('aborted', 'The request was cancelled.');
        }
        this.setState({ activeTool: call.name });
        const executed = await this.executeToolCall(call);
        results.push(executed.result);
        images.push(...executed.images);
      }
      this.setState({ activeTool: null });
      // Tool-emitted images ride in the same user turn, after the results — all three providers
      // accept mixed tool-result + image content there.
      this.appendMessage({ role: 'user', content: [...results, ...images] });
    }

    this.setState({
      notice: `Stopped after ${maxIterations} tool iterations (the cap is configurable in the agent settings). Send a follow-up message to continue.`,
    });
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

  /** Rebuilt per request — the scene outline and active scene change as the agent works. */
  private buildSystemPrompt(): string {
    const lines: string[] = [
      'You are Pix3 Agent, an AI assistant embedded in the Pix3 editor (a browser-based editor for HTML5 games mixing 2D and 3D).',
      '',
      'Rules:',
      '- Use the provided tools to inspect and change the project; never guess scene or file contents you can read.',
      '- Scene changes go through set_property / run_command — they are undoable, so prefer them over rewriting scene files.',
      '- After editing scripts with fs_write, run compile_scripts to check they build.',
      '- Verify behaviour when it matters: play_start / play_status, then read_errors and read_logs.',
      '- File paths are relative to the project root.',
      '- Be concise. Reply in the language the user writes in.',
      '',
      'Project context:',
    ];

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

    return lines.join('\n');
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

  // ── State / persistence plumbing ───────────────────────────────────────────

  private appendMessage(message: LlmMessage): void {
    this.setState({ messages: [...this.state.messages, message] });
  }

  private accumulateUsage(usage: LlmUsage | undefined): void {
    if (!usage) {
      return;
    }
    const total = this.state.totalUsage;
    this.setState({
      totalUsage: {
        inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0),
        outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    });
  }

  private persist(): void {
    const projectId = this.loadedProjectId ?? '';
    this.historyStore.put(projectId, this.state.messages).catch(() => {
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

/** Type-only re-export so UI code can render content blocks without importing llm internals. */
export type { LlmContentBlock, LlmMessage };
