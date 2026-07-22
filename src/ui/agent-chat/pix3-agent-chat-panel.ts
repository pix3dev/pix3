import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { createRef, ref } from 'lit/directives/ref.js';
import {
  AgentChatService,
  type AgentChatState,
  type AgentTurnMetric,
} from '@/services/agent/AgentChatService';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import {
  formatPricingHint,
  type LlmContentBlock,
  type LlmImageBlock,
  type LlmMessage,
  type LlmModel,
  type LlmProvider,
  type LlmToolResultBlock,
  type LlmToolUseBlock,
  type ReasoningEffort,
} from '@/services/llm/LlmTypes';
import { renderMarkdownLite } from './markdown-lite';
import './pix3-agent-chat-panel.ts.css';

/** Tool groups with at least this many steps start collapsed (unless running). */
const GROUP_COLLAPSE_THRESHOLD = 6;

/** Short, capitalised labels for the reasoning-level picker (keyed by {@link ReasoningEffort}). */
const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** One-line trade-off blurb shown next to each reasoning level in the picker. */
const reasoningEffortHint = (effort: ReasoningEffort): string => {
  switch (effort) {
    case 'low':
      return 'Fastest, cheapest';
    case 'medium':
      return 'Balanced';
    case 'high':
      return 'Deeper (default)';
    case 'xhigh':
      return 'For hard coding / agentic work';
    case 'max':
      return 'Maximum depth';
  }
};

/** Diff previews clamp to this many rendered lines, with an overflow note below. */
const DIFF_LINE_CAP = 24;

/** A file staged in the composer before it is sent (pasted, dropped, or picked). */
type ComposerAttachment =
  | { id: string; kind: 'image'; name: string; mimeType: string; base64: string }
  | { id: string; kind: 'text'; name: string; content: string };

/** One rendered chat entry, derived from the wire history (tool calls paired with their results). */
type DisplayItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string }
  | { kind: 'image'; role: 'user' | 'assistant'; mimeType: string; data: string }
  | { kind: 'tool'; call: LlmToolUseBlock; result: LlmToolResultBlock | null }
  | { kind: 'metrics'; metric: AgentTurnMetric };

/** Pair every tool-use block with its result and flatten the history into renderable items. */
const toDisplayItems = (
  messages: readonly LlmMessage[],
  turnMetrics: Readonly<Record<number, AgentTurnMetric>>,
  showMetrics: boolean
): DisplayItem[] => {
  const resultsById = new Map<string, LlmToolResultBlock>();
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        resultsById.set(block.toolUseId, block);
      }
    }
  }

  const items: DisplayItem[] = [];
  messages.forEach((message, index) => {
    const blocks: readonly LlmContentBlock[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content;
    for (const block of blocks) {
      if (block.type === 'text' && block.text.trim()) {
        items.push({ kind: 'text', role: message.role, text: block.text });
      } else if (block.type === 'tool-use') {
        items.push({ kind: 'tool', call: block, result: resultsById.get(block.id) ?? null });
      } else if (block.type === 'image') {
        // Screenshots / asset previews emitted by tools (they ride in user turns).
        items.push({
          kind: 'image',
          role: message.role,
          mimeType: block.mimeType,
          data: block.data,
        });
      }
      // tool-result blocks render attached to their call.
    }
    const metric = turnMetrics[index];
    if (showMetrics && message.role === 'assistant' && metric) {
      items.push({ kind: 'metrics', metric });
    }
  });
  return items;
};

/** Format a turn's timing / throughput for the debug metrics line. */
const formatMetric = (metric: AgentTurnMetric): string => {
  const parts = [`${(metric.elapsedMs / 1000).toFixed(1)}s`];
  if (metric.outputTokens && metric.elapsedMs > 0) {
    parts.push(`${Math.round(metric.outputTokens / (metric.elapsedMs / 1000))} tok/s`);
  }
  if (metric.inputTokens || metric.outputTokens) {
    parts.push(`${metric.inputTokens ?? 0}↑ ${metric.outputTokens ?? 0}↓`);
  }
  // A compact "cached" hint on the line itself when the provider served a cache read; full detail
  // (writes + the local prefix prediction) lives in the tooltip.
  if (metric.cacheReadTokens) {
    parts.push(`${formatTokenCount(metric.cacheReadTokens)} cached`);
  }
  return parts.join(' · ');
};

/**
 * Detailed tooltip for the metrics line: both cache readings. "reported" is what the provider
 * actually cached (read / written); "unchanged prefix" is the local estimate of how much of the
 * request's leading bytes matched the previous one (the theoretically cacheable span, computed
 * before sending — present even for providers that report nothing).
 */
const formatMetricTooltip = (metric: AgentTurnMetric): string => {
  const lines = [`Time: ${(metric.elapsedMs / 1000).toFixed(1)} s`];
  if (metric.inputTokens !== undefined) {
    lines.push(`Prompt (input): ${metric.inputTokens.toLocaleString()} tok`);
  }
  if (metric.outputTokens !== undefined) {
    lines.push(`Output: ${metric.outputTokens.toLocaleString()} tok`);
  }
  if (metric.cacheReadTokens || metric.cacheCreationTokens) {
    const bits: string[] = [];
    if (metric.cacheReadTokens) bits.push(`${metric.cacheReadTokens.toLocaleString()} read`);
    if (metric.cacheCreationTokens) {
      bits.push(`${metric.cacheCreationTokens.toLocaleString()} written`);
    }
    lines.push(`Cache (reported by provider): ${bits.join(', ')}`);
  } else {
    lines.push('Cache (reported by provider): none');
  }
  if (metric.predictedCacheTokens) {
    lines.push(
      `Unchanged prefix vs previous request: ~${metric.predictedCacheTokens.toLocaleString()} tok (cacheable)`
    );
  }
  return lines.join('\n');
};

/** Compact token count for the context meter: 980, 24K, 1.2M. */
const formatTokenCount = (tokens: number): string => {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}K`;
  }
  const m = tokens / 1_000_000;
  return `${Number(m.toFixed(m >= 10 ? 0 : 1))}M`;
};

/**
 * The most recent turn metric that carries an input count — i.e. the current context state (system
 * prompt + full history + tool specs, and how much of it was cached). `undefined` until a provider
 * reports usage. This tracks context *fill*, unlike {@link AgentChatState.totalUsage} which sums
 * input across every turn (double-counting history).
 */
const latestContextMetric = (
  turnMetrics: Readonly<Record<number, AgentTurnMetric>>
): AgentTurnMetric | undefined => {
  let bestIndex = -1;
  let best: AgentTurnMetric | undefined;
  for (const [key, metric] of Object.entries(turnMetrics)) {
    const index = Number(key);
    if (index > bestIndex && metric.inputTokens !== undefined) {
      bestIndex = index;
      best = metric;
    }
  }
  return best;
};

/** File extensions treated as attachable text (mirrors the agent's fs_read text set, loosely). */
const TEXT_ATTACHMENT_EXT = new Set([
  'txt',
  'md',
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'csv',
  'ini',
  'cfg',
  'toml',
  'glsl',
  'vert',
  'frag',
  'pix3scene',
  'pix3anim',
  'log',
]);

const isTextualFile = (file: File): boolean => {
  if (file.type.startsWith('text/') || file.type === 'application/json') {
    return true;
  }
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return TEXT_ATTACHMENT_EXT.has(ext);
};

/** Base64 (no `data:` prefix) of a blob, for building image content blocks. */
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(blob);
  });

/** Collect the user's typed prompts from history (excludes tool-result / image-only turns). */
const extractUserPrompts = (messages: readonly LlmMessage[]): string[] => {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content;
    if (blocks.some(block => block.type === 'tool-result')) continue;
    const text = blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
    if (text) prompts.push(text);
  }
  return prompts;
};

/** Compact "3m / 2h / 5d ago" style label for the history list. */
const formatRelativeTime = (timestamp: number): string => {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

const formatToolPayload = (value: unknown): string => {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? '';
};

/** Non-empty string field, or undefined — for pulling primary args out of a tool's input. */
const asArgString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Drop the `res://` scheme so a path reads compactly in a one-line descriptor. */
const stripRes = (path: string): string => path.replace(/^res:\/\//i, '');

/** Compact summary of a `game_input` step list, e.g. "key ArrowUp, tap PlayButton". */
const describeGameSteps = (steps: unknown): string => {
  if (!Array.isArray(steps)) return '';
  const parts = steps
    .map(raw => {
      if (!raw || typeof raw !== 'object') return '';
      const step = raw as Record<string, unknown>;
      switch (asArgString(step.type)) {
        case 'key':
          return `key ${asArgString(step.code) ?? '?'}`;
        case 'keys':
          return `keys ${Array.isArray(step.codes) ? step.codes.join('+') : '?'}`;
        case 'tap':
          return `tap ${asArgString(step.target) ?? `${step.x ?? '?'},${step.y ?? '?'}`}`;
        case 'drag':
          return 'drag';
        case 'wait':
          return `wait ${step.ms ?? '?'}ms`;
        default:
          return asArgString(step.type) ?? '';
      }
    })
    .filter(Boolean);
  return parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` +${parts.length - 3}` : '');
};

/**
 * A short, human-readable descriptor of a tool call's *primary* argument — the file being edited,
 * the node/property being changed, the command being run — so a collapsed tool row (and the running
 * indicator) says WHAT it is acting on, not just the tool name. Returns '' when there's nothing
 * useful to show (the tool takes no meaningful args). Overflow is clamped with CSS ellipsis; the
 * full value rides in the row's `title`.
 */
const describeToolCall = (call: LlmToolUseBlock): string => {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const path = asArgString(input.path);
  switch (call.name) {
    case 'fs_read':
    case 'fs_write':
    case 'fs_delete':
    case 'fs_list':
    case 'str_replace':
      return path ? stripRes(path) : '';
    case 'generate_asset':
      return asArgString(input.name) ?? '';
    case 'process_asset':
      return stripRes(asArgString(input.name) ?? path ?? '');
    case 'node_inspect':
      return asArgString(input.nodeId) ?? '';
    case 'find_nodes':
      return asArgString(input.text) ?? '';
    case 'set_property': {
      const node = asArgString(input.nodeId);
      const prop = asArgString(input.propertyPath);
      return node && prop ? `${node}.${prop}` : (prop ?? node ?? '');
    }
    case 'create_node': {
      const type = asArgString(input.nodeType);
      const name = asArgString(input.name);
      return type && name ? `${type} “${name}”` : (type ?? name ?? '');
    }
    case 'convert_node_type': {
      const node = asArgString(input.nodeId);
      const to = asArgString(input.toType);
      return node && to ? `${node} → ${to}` : (to ?? node ?? '');
    }
    case 'move_node': {
      const node = asArgString(input.nodeId) ?? '';
      const before = asArgString(input.beforeSiblingId);
      const after = asArgString(input.afterSiblingId);
      const parent = asArgString(input.parentId);
      let where = asArgString(input.placement) ?? '';
      if (!where && before) where = `before ${before}`;
      if (!where && after) where = `after ${after}`;
      if (!where && input.toRoot === true) where = 'to root';
      if (!where && parent) where = `→ ${parent}`;
      return where ? `${node} · ${where}` : node;
    }
    case 'add_component':
    case 'remove_component':
      return asArgString(input.componentType) ?? asArgString(input.componentId) ?? '';
    case 'set_component_property':
      return asArgString(input.propertyName) ?? asArgString(input.componentId) ?? '';
    case 'run_command':
      return asArgString(input.commandId) ?? '';
    case 'read_skill':
      return asArgString(input.section)
        ? `${asArgString(input.id)} · ${asArgString(input.section)}`
        : (asArgString(input.id) ?? '');
    case 'analyze_image':
      return asArgString(input.source) ?? '';
    case 'ask_advisor':
      return asArgString(input.question) ?? '';
    case 'game_input':
      return describeGameSteps(input.steps);
    case 'game_observe':
      return Array.isArray(input.nodes) ? input.nodes.map(String).join(', ') : '';
    default:
      return '';
  }
};

/** A tool-use block paired with its (possibly missing) result. */
type ToolEntry = { call: LlmToolUseBlock; result: LlmToolResultBlock | null };

/** A run of adjacent tool calls, plus the message rows around them, after grouping. */
type RenderRow =
  | {
      kind: 'text';
      role: 'user' | 'assistant';
      text: string;
      firstAssistant: boolean;
      lastAssistant: boolean;
    }
  | { kind: 'image'; role: 'user' | 'assistant'; mimeType: string; data: string }
  | { kind: 'metrics'; metric: AgentTurnMetric }
  | { kind: 'toolgroup'; id: string; tools: ToolEntry[] };

/** Derived status for a single tool row or a whole group. */
type ToolStatus = 'done' | 'error' | 'running' | 'queued';

/** Broad category of a tool, used to derive a human group label. */
type ToolCategory =
  | 'read'
  | 'edit-file'
  | 'inspect'
  | 'edit-scene'
  | 'test'
  | 'assets'
  | 'research'
  | 'other';

/** Last path segment of a (possibly `res://`, possibly back-slashed) path. */
const basename = (path: string): string => {
  const clean = stripRes(path).replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
};

/** Bucket a tool name into a coarse category for group-label derivation. */
const toolCategory = (name: string): ToolCategory => {
  if (/^(fs_read|fs_list)$/.test(name)) return 'read';
  if (/^(str_replace|fs_write|fs_delete)$/.test(name)) return 'edit-file';
  if (/^(find_nodes|node_inspect)$/.test(name)) return 'inspect';
  if (
    /^(create_node|convert_node_type|move_node|add_component|remove_component|set_property|set_component_property)$/.test(
      name
    )
  ) {
    return 'edit-scene';
  }
  if (
    /^(play_start|play_stop|game_input|game_observe|analyze_image|read_errors|check_scripts|compile_scripts|run_command)$/.test(
      name
    )
  ) {
    return 'test';
  }
  if (/^(generate_asset|process_asset)$/.test(name)) return 'assets';
  if (/^(read_skill|ask_advisor)$/.test(name)) return 'research';
  return 'other';
};

/**
 * A one-line summary of what a group of tool calls is doing, from its dominant (most frequent,
 * tie → first-seen) tool category. Editing a single known file names it.
 */
const deriveGroupLabel = (tools: readonly ToolEntry[]): string => {
  const counts = new Map<ToolCategory, number>();
  for (const t of tools) {
    const c = toolCategory(t.call.name);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: ToolCategory = 'other';
  let bestN = -1;
  for (const [c, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  switch (best) {
    case 'read':
      return 'Reading files';
    case 'edit-file': {
      const paths = tools
        .filter(t => toolCategory(t.call.name) === 'edit-file')
        .map(t => asArgString((t.call.input as Record<string, unknown> | undefined)?.path))
        .filter((p): p is string => Boolean(p))
        .map(stripRes);
      if (paths.length > 0 && new Set(paths).size === 1) return `Editing ${basename(paths[0])}`;
      return 'Editing files';
    }
    case 'inspect':
      return 'Inspecting scene';
    case 'edit-scene':
      return 'Editing scene';
    case 'test':
      return 'Testing in game';
    case 'assets':
      return 'Generating assets';
    case 'research':
      return 'Researching';
    default:
      return 'Working';
  }
};

/** Rendered unified diff for a `str_replace`, or `null` when it carries no old/new strings. */
type ToolDiff = { plus: number; minus: number; lines: string[] };

const buildDiff = (call: LlmToolUseBlock): ToolDiff | null => {
  if (call.name !== 'str_replace') return null;
  const input = (call.input ?? {}) as Record<string, unknown>;
  const oldStr = typeof input.old_string === 'string' ? input.old_string : undefined;
  const newStr = typeof input.new_string === 'string' ? input.new_string : undefined;
  if (oldStr === undefined && newStr === undefined) return null;
  const del = oldStr ? oldStr.split('\n') : [];
  const add = newStr ? newStr.split('\n') : [];
  const lines = [...del.map(l => `-${l}`), ...add.map(l => `+${l}`)];
  return { plus: add.length, minus: del.length, lines };
};

/**
 * The in-editor agent chat (opened as an editor tab, like the Sprite Editor). Renders the
 * conversation from {@link AgentChatService}, provider/model/key configuration from
 * {@link AgentSettingsService}, and a composer. All agent behaviour lives in the service — this
 * component is a thin view.
 */
@customElement('pix3-agent-chat-panel')
export class AgentChatPanel extends ComponentBase {
  @inject(AgentChatService)
  private readonly chat!: AgentChatService;

  @inject(AgentSettingsService)
  private readonly settings!: AgentSettingsService;

  @inject(LlmProviderRegistry)
  private readonly providers!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly modelCatalog!: LlmModelCatalogService;

  @inject(BridgeConnectionService)
  private readonly bridge!: BridgeConnectionService;

  @inject(EditorSettingsService)
  private readonly editorSettings!: EditorSettingsService;

  @inject(IconService)
  private readonly icons!: IconService;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private chatState: AgentChatState | null = null;
  @state() private providerId = '';
  @state() private modelId = '';
  @state() private customBaseUrl = '';
  /** Whether the current provider has a key (drives the model-picker button tint + empty-state). */
  @state() private keyConfigured = false;
  /** Draft key text while an inline per-provider key editor is open. */
  @state() private keyDraft = '';
  /** Whether the Copilot-style model picker dropdown is open. */
  @state() private modelPickerOpen = false;
  /** Chosen reasoning level for the current model, or undefined to use its default effort. */
  @state() private reasoningEffort: ReasoningEffort | undefined = undefined;
  /** Whether the reasoning-level dropdown is open. */
  @state() private reasoningPickerOpen = false;
  /** Live filter typed into the model picker's search box (matches provider/model labels + ids). */
  @state() private modelPickerQuery = '';
  /** Per-provider key presence, loaded when the picker opens (`hasApiKey` is async). */
  @state() private providerKeys: Record<string, boolean> = {};
  /** Provider whose inline key editor is expanded inside the picker, or null. */
  @state() private keyEditorProviderId: string | null = null;
  @state() private draft = '';
  /** Files staged in the composer (images + text) to send with the next message. */
  @state() private attachments: ComposerAttachment[] = [];
  @state() private attachWarning = '';
  /** True while files are dragged over the composer (drop-zone highlight). */
  @state() private dragActive = false;
  /** Whether the agent debug affordances (raw log / system prompt / metrics) are shown. */
  @state() private debugMode = false;
  /** Which debug overlay is open, if any. */
  @state() private debugView: 'none' | 'raw' | 'system' = 'none';
  @state() private systemPromptText = '';
  /** Whether the conversation-history popover is open. */
  @state() private historyOpen = false;
  /**
   * Tool-group ids the user has manually toggled *away* from their default open/closed state
   * (keyed by the group's first tool-use id). The default is: open when running or fewer than
   * {@link GROUP_COLLAPSE_THRESHOLD} steps, collapsed otherwise. See {@link isGroupOpen}.
   */
  @state() private toggledGroups = new Set<string>();

  private disposeChatSubscription?: () => void;
  private disposeSettingsSubscription?: () => void;
  private disposeComposeSubscription?: () => void;
  private disposeCatalogSubscription?: () => void;
  private disposeBridgeSubscription?: () => void;
  private readonly messagesRef = createRef<HTMLDivElement>();
  private readonly fileInputRef = createRef<HTMLInputElement>();
  private shouldStickToBottom = true;
  /** Index into the derived prompt history while cycling with ArrowUp/Down (-1 = not navigating). */
  private historyIndex = -1;
  /** Monotonic counter for unique attachment ids within this component instance. */
  private attachmentSeq = 0;

  connectedCallback(): void {
    super.connectedCallback();

    this.disposeChatSubscription = this.chat.subscribe(chatState => {
      this.chatState = chatState;
    });
    // "Fix with Agent" and other prefill requests drop a prompt into the composer for review.
    this.disposeComposeSubscription = this.chat.subscribeCompose(text => {
      this.applyComposePrefill(text);
    });
    this.disposeSettingsSubscription = this.settings.subscribe(prefs => {
      this.providerId = prefs.selectedProviderId;
      this.modelId = this.settings.getSelectedModelId(prefs.selectedProviderId) ?? '';
      this.reasoningEffort = this.settings.getReasoningEffort(this.providerId, this.modelId);
      this.customBaseUrl = prefs.customBaseUrl;
      this.debugMode = prefs.debugMode;
      if (!prefs.debugMode) {
        this.debugView = 'none';
      }
      if (this.modelPickerOpen) {
        void this.refreshProviderKeys();
      }
      void this.refreshKeyConfigured();
    });

    // Re-render when a live model catalog lands in the background (picker labels/rows update).
    this.disposeCatalogSubscription = this.modelCatalog.subscribe(() => {
      this.requestUpdate();
    });
    // Re-render when the bridge connects/disconnects so its providers appear/disappear in the picker.
    this.disposeBridgeSubscription = this.bridge.subscribe(() => {
      this.requestUpdate();
    });

    void this.chat.ensureLoaded();
  }

  disconnectedCallback(): void {
    this.disposeChatSubscription?.();
    this.disposeChatSubscription = undefined;
    this.disposeComposeSubscription?.();
    this.disposeComposeSubscription = undefined;
    this.disposeSettingsSubscription?.();
    this.disposeSettingsSubscription = undefined;
    this.disposeCatalogSubscription?.();
    this.disposeCatalogSubscription = undefined;
    this.disposeBridgeSubscription?.();
    this.disposeBridgeSubscription = undefined;
    this.closeModelPicker();
    this.closeReasoningPicker();
    super.disconnectedCallback();
  }

  protected updated(): void {
    const container = this.messagesRef.value;
    if (container && this.shouldStickToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  render() {
    const chatState = this.chatState;
    const items = chatState
      ? toDisplayItems(chatState.messages, chatState.turnMetrics, this.debugMode)
      : [];
    const rows = this.buildRenderRows(items);
    const running = chatState?.status === 'running';
    // The first tool still awaiting a result is the one in flight; later pending calls are queued.
    const firstPendingId = items.find(
      (item): item is Extract<DisplayItem, { kind: 'tool' }> =>
        item.kind === 'tool' && item.result === null
    )?.call.id;
    // Keep the bottom "thinking" indicator only when no tool is mid-flight (a running tool already
    // shows its own spinner inside its group).
    const showThinking = running && firstPendingId === undefined;

    return html`
      <div class="agent-chat">
        ${this.renderHeaderStrip(items)}
        <div class="agent-messages" ${ref(this.messagesRef)} @scroll=${this.handleMessagesScroll}>
          ${rows.length === 0
            ? this.renderEmptyState()
            : rows.map(row => this.renderRow(row, running, firstPendingId))}
          ${showThinking ? this.renderRunningIndicator() : null}
        </div>
        ${this.debugView !== 'none' ? this.renderDebugDrawer() : null} ${this.renderBanners()}
        ${this.renderComposer()}
      </div>
    `;
  }

  /**
   * Collapse runs of adjacent tool items into a single {@link RenderRow} group; text / image /
   * metrics items break a group. Preserves order and marks the first/last assistant reply so the
   * view can draw the agent avatar and hover Copy/Retry actions.
   */
  private buildRenderRows(items: readonly DisplayItem[]): RenderRow[] {
    const rows: RenderRow[] = [];
    let pending: ToolEntry[] = [];
    const flush = (): void => {
      if (pending.length > 0) {
        rows.push({ kind: 'toolgroup', id: pending[0].call.id, tools: pending });
        pending = [];
      }
    };
    for (const item of items) {
      if (item.kind === 'tool') {
        pending.push({ call: item.call, result: item.result });
        continue;
      }
      flush();
      if (item.kind === 'text') {
        rows.push({
          kind: 'text',
          role: item.role,
          text: item.text,
          firstAssistant: false,
          lastAssistant: false,
        });
      } else if (item.kind === 'image') {
        rows.push({ kind: 'image', role: item.role, mimeType: item.mimeType, data: item.data });
      } else {
        rows.push({ kind: 'metrics', metric: item.metric });
      }
    }
    flush();

    const assistantIdx = rows
      .map((row, i) => (row.kind === 'text' && row.role === 'assistant' ? i : -1))
      .filter(i => i >= 0);
    if (assistantIdx.length > 0) {
      const first = rows[assistantIdx[0]];
      if (first.kind === 'text') first.firstAssistant = true;
      const last = rows[assistantIdx[assistantIdx.length - 1]];
      if (last.kind === 'text') last.lastAssistant = true;
    }
    return rows;
  }

  /** Compact session strip: agent glyph + title + step count, with History / New chat on the right. */
  private renderHeaderStrip(items: readonly DisplayItem[]) {
    const chatState = this.chatState;
    const activeId = chatState?.activeConversationId ?? null;
    const active = chatState?.conversations.find(c => c.id === activeId);
    const title = active?.title?.trim() || 'Agent';
    const steps = items.reduce((n, item) => (item.kind === 'tool' ? n + 1 : n), 0);

    return html`
      <div class="agent-header no-select">
        <span class="agent-header-glyph">${this.icons.getIcon('sparkles', IconSize.SMALL)}</span>
        <span class="agent-header-title" title=${title}>${title}</span>
        ${steps > 0
          ? html`<span class="agent-header-steps">${steps} ${steps === 1 ? 'step' : 'steps'}</span>`
          : null}
        <span class="agent-header-spacer"></span>
        <div class="agent-history-wrap agent-history-wrap--header">
          <button
            type="button"
            class="agent-header-btn ${this.historyOpen ? 'is-active' : ''}"
            title="Past conversations"
            aria-label="Past conversations"
            aria-expanded=${String(this.historyOpen)}
            @click=${this.toggleHistory}
          >
            ${this.icons.getIcon('clock', IconSize.SMALL)}
          </button>
          ${this.historyOpen ? this.renderHistoryPopover() : null}
        </div>
        <button
          type="button"
          class="agent-header-btn"
          title="Start a new conversation (keeps the old ones in History)"
          aria-label="New chat"
          @click=${this.handleNewConversation}
        >
          ${this.icons.getIcon('plus', IconSize.SMALL)}
        </button>
      </div>
    `;
  }

  private renderRow(row: RenderRow, running: boolean, firstPendingId: string | undefined) {
    if (row.kind === 'toolgroup') {
      return this.renderToolGroup(row, running, firstPendingId);
    }
    if (row.kind === 'metrics') {
      return html`<div class="agent-metrics" title=${formatMetricTooltip(row.metric)}>
        ${formatMetric(row.metric)}
      </div>`;
    }
    if (row.kind === 'image') {
      return html`
        <div class="agent-left-row">
          <span class="agent-avatar-gutter"></span>
          <img
            class="agent-image"
            alt="Tool-captured image"
            src=${`data:${row.mimeType};base64,${row.data}`}
          />
        </div>
      `;
    }
    return this.renderTextRow(row, running);
  }

  private renderTextRow(row: Extract<RenderRow, { kind: 'text' }>, running: boolean) {
    if (row.role === 'user') {
      return html`<div class="agent-message is-user">
        <div class="agent-message-text">${row.text}</div>
      </div>`;
    }
    // Last settled assistant reply gets a hover Copy / Retry toolbar.
    const showActions = row.lastAssistant && !running;
    return html`
      <div class="agent-left-row">
        ${row.firstAssistant
          ? html`<span class="agent-avatar"
              >${this.icons.getIcon('sparkles', IconSize.SMALL)}</span
            >`
          : html`<span class="agent-avatar-gutter"></span>`}
        <div class="agent-message is-assistant">
          <div class="agent-message-md">${renderMarkdownLite(row.text)}</div>
          ${showActions
            ? html`<div class="agent-msg-actions">
                <button
                  type="button"
                  class="agent-msg-action agent-icon-btn"
                  title="Copy this reply"
                  aria-label="Copy this reply"
                  @click=${() => void this.copyToClipboard(row.text)}
                >
                  ${this.icons.getIcon('copy', IconSize.SMALL)}
                </button>
                <button
                  type="button"
                  class="agent-msg-action agent-icon-btn"
                  title="Retry — re-run the last turn"
                  aria-label="Retry"
                  @click=${() => void this.chat.resume()}
                >
                  ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
                </button>
              </div>`
            : null}
        </div>
      </div>
    `;
  }

  // ── Debug overlay (raw wire log / resolved system prompt) ────────────────────

  private renderDebugDrawer() {
    const isRaw = this.debugView === 'raw';
    const body = isRaw
      ? JSON.stringify(this.chatState?.messages ?? [], null, 2)
      : this.systemPromptText;
    return html`
      <div class="agent-debug-drawer">
        <div class="agent-debug-head">
          <strong>${isRaw ? 'Raw conversation log' : 'System prompt'}</strong>
          <span class="agent-toolbar-spacer"></span>
          <button
            type="button"
            class="agent-debug-btn"
            title="Copy to clipboard"
            @click=${() => void this.copyToClipboard(body)}
          >
            <span class="agent-btn-icon">${this.icons.getIcon('copy', IconSize.SMALL)}</span>
            Copy
          </button>
          <button
            type="button"
            class="agent-debug-btn agent-icon-btn"
            title="Close"
            aria-label="Close"
            @click=${() => {
              this.debugView = 'none';
            }}
          >
            ${this.icons.getIcon('x', IconSize.SMALL)}
          </button>
        </div>
        <pre class="agent-debug-body">${body || '(empty)'}</pre>
      </div>
    `;
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard may be unavailable (permissions / insecure context) — non-fatal.
    }
  }

  // ── Model picker (Copilot-style dropdown with per-provider key entry) ─────────

  /**
   * The compact model-picker button that sits in the input action row: shows the current model's
   * label + provider hint + a chevron, and tints accent when the current provider has no key. Opens
   * {@link renderModelPicker}.
   */
  private renderModelPickerButton() {
    const provider = this.providers.get(this.providerId);
    const model = this.modelCatalog.getModel(this.providerId, this.modelId);
    const label = model?.label ?? (this.modelId || 'Select model');
    const providerHint = provider?.label ?? '';
    return html`
      <button
        type="button"
        class="agent-model-picker ${this.keyConfigured ? '' : 'is-missing'} ${this.modelPickerOpen
          ? 'is-open'
          : ''}"
        aria-haspopup="listbox"
        aria-expanded=${String(this.modelPickerOpen)}
        title=${this.keyConfigured
          ? `${providerHint} · ${label}`
          : `No API key for ${providerHint || 'this provider'} — click to add one`}
        @click=${() => this.toggleModelPicker()}
      >
        ${this.keyConfigured
          ? null
          : html`<span class="agent-model-picker-keyicon"
              >${this.icons.getIcon('key', IconSize.SMALL)}</span
            >`}
        <span class="agent-model-picker-label">${label}</span>
        ${providerHint ? html`<span class="agent-model-picker-hint">${providerHint}</span>` : null}
        <span class="agent-model-picker-caret"
          >${this.icons.getIcon('chevron-down-caret', IconSize.SMALL)}</span
        >
      </button>
    `;
  }

  /** Reasoning levels the current model accepts (empty when it has no reasoning control). */
  private currentReasoningEfforts(): readonly ReasoningEffort[] {
    return (
      this.modelCatalog.getModel(this.providerId, this.modelId)?.capabilities.reasoningEfforts ?? []
    );
  }

  /**
   * Compact reasoning-level button, shown only for models that expose an effort control. Sits left
   * of the model picker and mirrors its styling. The label is the chosen level, or "Auto" when none
   * is set (the model's default effort).
   */
  private renderReasoningPickerButton() {
    const efforts = this.currentReasoningEfforts();
    if (efforts.length === 0) {
      return null;
    }
    const label = this.reasoningEffort ? REASONING_EFFORT_LABELS[this.reasoningEffort] : 'Auto';
    return html`
      <button
        type="button"
        class="agent-reasoning-picker ${this.reasoningPickerOpen ? 'is-open' : ''}"
        aria-haspopup="listbox"
        aria-expanded=${String(this.reasoningPickerOpen)}
        title="Reasoning effort · ${label}"
        @click=${() => this.toggleReasoningPicker()}
      >
        <span class="agent-reasoning-picker-icon"
          >${this.icons.getIcon('sparkles', IconSize.SMALL)}</span
        >
        <span class="agent-reasoning-picker-label">${label}</span>
        <span class="agent-reasoning-picker-caret"
          >${this.icons.getIcon('chevron-down-caret', IconSize.SMALL)}</span
        >
      </button>
    `;
  }

  /** The reasoning-level dropdown: an "Auto" (default) row plus one row per level the model accepts. */
  private renderReasoningPicker() {
    const efforts = this.currentReasoningEfforts();
    return html`
      <div class="agent-reasoning-popover" role="listbox">
        ${this.renderReasoningRow(undefined, 'Auto', "The model's default effort")}
        ${efforts.map(effort =>
          this.renderReasoningRow(
            effort,
            REASONING_EFFORT_LABELS[effort],
            reasoningEffortHint(effort)
          )
        )}
      </div>
    `;
  }

  private renderReasoningRow(effort: ReasoningEffort | undefined, label: string, hint: string) {
    const active = this.reasoningEffort === effort;
    return html`
      <button
        type="button"
        class="agent-reasoning-row ${active ? 'is-active' : ''}"
        role="option"
        aria-selected=${String(active)}
        title=${hint}
        @click=${() => this.selectReasoning(effort)}
      >
        <span class="agent-reasoning-row-check"
          >${active ? this.icons.getIcon('check', IconSize.SMALL) : null}</span
        >
        <span class="agent-reasoning-row-label">${label}</span>
        <span class="agent-reasoning-row-hint">${hint}</span>
      </button>
    `;
  }

  /**
   * The dropdown itself: a search box, then every provider as a group (label + a key icon-button
   * that reveals an inline key editor), and under each its models as selectable rows. Providers that
   * need a base URL also expose the base-URL input and a custom-model-id field. Anchored to the
   * composer (not the button) so it can't overflow the panel edge.
   */
  private renderModelPicker() {
    const query = this.modelPickerQuery.trim().toLowerCase();
    const providers = this.providers.list().filter(provider => !provider.hidden);
    const groups = providers
      .map(provider => {
        const providerMatches = query === '' || provider.label.toLowerCase().includes(query);
        const models = this.modelCatalog.getModels(provider.id).filter(model => {
          if (query === '' || providerMatches) return true;
          return (
            model.label.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)
          );
        });
        return { provider, models, providerMatches };
      })
      // While searching, drop providers with nothing matching (unless the provider itself matched).
      .filter(g => query === '' || g.providerMatches || g.models.length > 0);

    return html`
      <div class="agent-model-picker-popover" role="listbox">
        <div class="agent-mp-search">
          <span class="agent-mp-search-icon">${this.icons.getIcon('search', IconSize.SMALL)}</span>
          <input
            class="agent-mp-search-input"
            type="text"
            aria-label="Search models"
            placeholder="Search models"
            .value=${this.modelPickerQuery}
            @input=${(e: Event) => {
              this.modelPickerQuery = (e.target as HTMLInputElement).value;
            }}
          />
        </div>
        <div class="agent-mp-list">
          ${groups.length === 0
            ? html`<div class="agent-mp-empty">No models match “${this.modelPickerQuery}”.</div>`
            : groups.map(g => this.renderModelPickerGroup(g.provider, g.models))}
          ${!this.bridge.isAvailable() && this.modelPickerQuery.trim() === ''
            ? html`<button
                type="button"
                class="agent-mp-bridge-cta"
                @click=${this.onOpenBridgeSetup}
              >
                <span class="agent-mp-bridge-cta-icon"
                  >${this.icons.getIcon('zap', IconSize.SMALL)}</span
                >
                <span>
                  <strong>Add OpenAI, Anthropic, Zen &amp; more</strong>
                  <span class="agent-mp-bridge-cta-sub"
                    >Run Pix3AgentBridge to unlock advanced providers — click to set up</span
                  >
                </span>
              </button>`
            : null}
        </div>
      </div>
    `;
  }

  private onOpenBridgeSetup = (): void => {
    this.closeModelPicker();
    void this.editorSettings.showSettings('agent');
  };

  private renderModelPickerGroup(provider: LlmProvider, models: readonly LlmModel[]) {
    const hasKey = this.providerKeys[provider.id] ?? false;
    const editing = this.keyEditorProviderId === provider.id;
    return html`
      <div class="agent-mp-group">
        <div class="agent-mp-group-head">
          <span class="agent-mp-group-label">${provider.label}</span>
          <button
            type="button"
            class="agent-mp-key-btn ${hasKey ? 'is-set' : ''} ${editing ? 'is-open' : ''}"
            title=${hasKey
              ? `${provider.label} API key set — edit`
              : `Add ${provider.label} API key`}
            aria-label=${hasKey
              ? `Edit ${provider.label} API key`
              : `Add ${provider.label} API key`}
            @click=${() => {
              this.keyEditorProviderId = editing ? null : provider.id;
              this.keyDraft = '';
            }}
          >
            ${this.icons.getIcon('key', IconSize.SMALL)}
          </button>
        </div>
        ${editing ? this.renderProviderKeyEditor(provider, hasKey) : null}
        ${provider.requiresBaseUrl
          ? html`<input
              class="agent-mp-baseurl"
              aria-label="${provider.label} API base URL"
              .value=${this.customBaseUrl}
              @change=${this.handleBaseUrlChange}
              placeholder=${provider.defaultBaseUrl ?? 'https://…'}
            />`
          : null}
        ${models.length === 0
          ? html`<div class="agent-mp-none">No models listed.</div>`
          : models.map(model => this.renderModelPickerRow(provider, model))}
        ${provider.requiresBaseUrl
          ? html`<input
              class="agent-mp-custom"
              aria-label="Custom model id"
              placeholder="Custom model id…"
              @change=${(e: Event) => this.handleCustomModelEntry(provider.id, e)}
            />`
          : null}
      </div>
    `;
  }

  private renderModelPickerRow(provider: LlmProvider, model: LlmModel) {
    const active = provider.id === this.providerId && model.id === this.modelId;
    const hint = formatPricingHint(model.pricing);
    return html`
      <button
        type="button"
        class="agent-mp-model ${active ? 'is-active' : ''}"
        role="option"
        aria-selected=${String(active)}
        title=${model.description ?? model.label}
        @click=${() => this.selectModel(provider.id, model.id)}
      >
        <span class="agent-mp-model-check"
          >${active ? this.icons.getIcon('check', IconSize.SMALL) : null}</span
        >
        <span class="agent-mp-model-label">${model.label}</span>
        ${hint ? html`<span class="agent-mp-model-hint">${hint}</span>` : null}
      </button>
    `;
  }

  private renderProviderKeyEditor(provider: LlmProvider, hasKey: boolean) {
    return html`
      <div class="agent-mp-keyeditor">
        <input
          type="password"
          class="agent-key-input"
          aria-label="${provider.label} API key"
          .value=${this.keyDraft}
          placeholder=${hasKey ? '•••••••• (stored)' : 'paste key'}
          @input=${(e: Event) => {
            this.keyDraft = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') void this.saveKeyFor(provider.id);
          }}
        />
        <div class="agent-key-actions">
          <button
            type="button"
            class="agent-key-save"
            @click=${() => void this.saveKeyFor(provider.id)}
          >
            Save
          </button>
          ${hasKey
            ? html`<button
                type="button"
                class="agent-key-clear"
                @click=${() => void this.clearKeyFor(provider.id)}
              >
                Clear
              </button>`
            : null}
          ${provider.apiKeyHelpUrl
            ? html`<a
                class="agent-key-help"
                href=${provider.apiKeyHelpUrl}
                target="_blank"
                rel="noreferrer"
                >Get a key</a
              >`
            : null}
        </div>
      </div>
    `;
  }

  // ── Conversation ────────────────────────────────────────────────────────────

  private renderEmptyState() {
    return html`
      <div class="agent-empty">
        <h3>Pix3 Agent</h3>
        <p>
          An AI assistant with tools for this project: it inspects the scene, edits scripts and
          assets, runs commands (undoable), and verifies its work in play mode.
        </p>
        ${this.keyConfigured
          ? html`<p>Try: <em>“What is in the active scene?”</em></p>`
          : html`<p class="agent-empty-key-hint">
              Add your API key first — open the model picker below and add a key for your provider.
            </p>`}
      </div>
    `;
  }

  // ── Tool groups / rows ──────────────────────────────────────────────────────

  /** Per-entry status: error / done from the result, else running (in flight) or queued. */
  private toolStatus(
    entry: ToolEntry,
    running: boolean,
    firstPendingId: string | undefined
  ): ToolStatus {
    if (entry.result) return entry.result.isError ? 'error' : 'done';
    if (running && entry.call.id === firstPendingId) return 'running';
    return 'queued';
  }

  /** Overall group status: error ≻ running ≻ queued ≻ done. */
  private groupStatus(
    tools: readonly ToolEntry[],
    running: boolean,
    firstPendingId: string | undefined
  ): ToolStatus {
    const statuses = tools.map(t => this.toolStatus(t, running, firstPendingId));
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('running')) return 'running';
    if (statuses.includes('queued')) return 'queued';
    return 'done';
  }

  /** Whether a group is expanded, honouring any manual toggle over the default (see below). */
  private isGroupOpen(id: string, count: number, status: ToolStatus): boolean {
    const toggled = this.toggledGroups.has(id);
    if (status === 'running') return !toggled; // running groups stay open unless collapsed by hand
    const baseOpen = count < GROUP_COLLAPSE_THRESHOLD;
    return toggled ? !baseOpen : baseOpen;
  }

  private toggleGroup(id: string): void {
    const next = new Set(this.toggledGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.toggledGroups = next;
  }

  private renderStatusBadge(status: ToolStatus, variant: 'row' | 'group') {
    if (status === 'running') {
      return html`<span class="agent-badge agent-badge--${variant} is-running"
        ><span class="agent-badge-spinner"></span
      ></span>`;
    }
    if (status === 'queued') {
      return html`<span class="agent-badge agent-badge--${variant} is-queued"
        ><span class="agent-badge-dot"></span
      ></span>`;
    }
    const icon = status === 'error' ? 'x' : 'check';
    return html`<span class="agent-badge agent-badge--${variant} is-${status}"
      >${this.icons.getIcon(icon, IconSize.SMALL)}</span
    >`;
  }

  /** Arg-type glyph next to a tool name (file / node / game / assets / research / code). */
  private argIcon(name: string) {
    const category = toolCategory(name);
    const icon =
      category === 'read' || category === 'edit-file'
        ? 'file-text'
        : category === 'inspect' || category === 'edit-scene'
          ? 'box'
          : category === 'test'
            ? 'play'
            : category === 'assets'
              ? 'image'
              : category === 'research'
                ? 'book-open'
                : 'terminal';
    return this.icons.getIcon(icon, IconSize.SMALL);
  }

  private renderToolGroup(
    group: Extract<RenderRow, { kind: 'toolgroup' }>,
    running: boolean,
    firstPendingId: string | undefined
  ) {
    const { tools, id } = group;
    const status = this.groupStatus(tools, running, firstPendingId);
    const open = this.isGroupOpen(id, tools.length, status);
    const label = deriveGroupLabel(tools);
    const doneCount = tools.filter(
      t => this.toolStatus(t, running, firstPendingId) === 'done'
    ).length;
    const countText =
      status === 'running'
        ? `${doneCount}/${tools.length}`
        : `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`;

    return html`
      <div class="agent-group ${status === 'error' ? 'is-error' : ''}">
        <button
          type="button"
          class="agent-group-head no-select"
          aria-expanded=${String(open)}
          @click=${() => this.toggleGroup(id)}
        >
          <span class="agent-group-caret ${open ? 'is-open' : ''}"
            >${this.icons.getIcon('chevron-right-caret', IconSize.SMALL)}</span
          >
          ${this.renderStatusBadge(status, 'group')}
          <span class="agent-group-label">${label}</span>
          <span class="agent-group-count">${countText}</span>
          <span class="agent-group-spacer"></span>
          ${status === 'error' ? html`<span class="agent-group-flag">retried</span>` : null}
        </button>
        ${status === 'running'
          ? html`<span class="agent-group-progress"
              ><span class="agent-group-progress-bar"></span
            ></span>`
          : null}
        ${open
          ? html`<div class="agent-group-body">
              ${tools.map(t => this.renderToolRow(t, running, firstPendingId))}
            </div>`
          : null}
      </div>
    `;
  }

  private renderToolRow(entry: ToolEntry, running: boolean, firstPendingId: string | undefined) {
    const { call, result } = entry;
    const status = this.toolStatus(entry, running, firstPendingId);
    const descriptor = describeToolCall(call);
    const diff = buildDiff(call);
    const affordance = diff ? 'diff' : result ? 'output' : 'args';

    return html`
      <details class="agent-row-details ${status === 'error' ? 'is-error' : ''}">
        <summary class="agent-row is-${status}" title=${descriptor || call.name}>
          ${this.renderStatusBadge(status, 'row')}
          <span class="agent-row-argicon">${this.argIcon(call.name)}</span>
          <code class="agent-row-name">${call.name}</code>
          ${descriptor ? html`<span class="agent-row-arg">${descriptor}</span>` : null}
          <span class="agent-row-right">
            ${diff ? this.renderDiffStat(diff.plus, diff.minus) : null}
            ${status === 'running'
              ? html`<span class="agent-row-note is-running">running…</span>`
              : status === 'queued'
                ? html`<span class="agent-row-note">queued</span>`
                : null}
            <span class="agent-row-affordance"
              >${affordance}<span class="agent-row-affordance-caret"
                >${this.icons.getIcon('chevron-right-caret', IconSize.SMALL)}</span
              ></span
            >
          </span>
        </summary>
        <div class="agent-tool-detail">
          ${diff ? this.renderDiff(descriptor || basename(call.name), diff) : null}
          <div class="agent-tool-section">args</div>
          <pre>${formatToolPayload(call.input)}</pre>
          ${result
            ? html`<div class="agent-tool-section">${result.isError ? 'error' : 'result'}</div>
                <pre>${formatToolPayload(result.content)}</pre>`
            : null}
        </div>
      </details>
    `;
  }

  private renderDiffStat(plus: number, minus: number) {
    return html`<span class="agent-diffstat">
      ${plus ? html`<span class="is-add">+${plus}</span>` : null}
      ${minus ? html`<span class="is-del">−${minus}</span>` : null}
    </span>`;
  }

  private renderDiff(file: string, diff: ToolDiff) {
    const shown = diff.lines.slice(0, DIFF_LINE_CAP);
    const overflow = diff.lines.length - shown.length;
    return html`
      <div class="agent-diff">
        <div class="agent-diff-head">
          <span class="agent-diff-file-icon"
            >${this.icons.getIcon('file-text', IconSize.SMALL)}</span
          >
          <span class="agent-diff-file" title=${file}>${file}</span>
          <span class="agent-diff-head-stat">${this.renderDiffStat(diff.plus, diff.minus)}</span>
        </div>
        <div class="agent-diff-body">
          ${shown.map(line => {
            const sign = line[0];
            const kind = sign === '+' ? 'is-add' : sign === '-' ? 'is-del' : '';
            return html`<div class="agent-diff-line ${kind}">
              <span class="agent-diff-sign">${sign === ' ' ? '' : sign}</span
              ><span class="agent-diff-text">${line.slice(1)}</span>
            </div>`;
          })}
          ${overflow > 0
            ? html`<div class="agent-diff-more">
                … ${overflow} more line${overflow === 1 ? '' : 's'}
              </div>`
            : null}
        </div>
      </div>
    `;
  }

  private renderRunningIndicator() {
    const activeTool = this.chatState?.activeTool;
    // Show what the running tool is acting on (file/node/command), pulled from the pending call.
    const descriptor = activeTool ? this.activeToolDescriptor(activeTool) : '';
    return html`
      <div class="agent-running-center">
        <div class="agent-kitt" aria-hidden="true">
          <span class="agent-kitt-sweep"></span>
        </div>
        <div class="agent-running-label">
          ${activeTool
            ? html`Running <code>${activeTool}</code>${descriptor
                  ? html` <span class="agent-row-arg">${descriptor}</span>`
                  : null}…`
            : 'Thinking…'}
        </div>
      </div>
    `;
  }

  /**
   * The primary-argument descriptor of the currently-running tool. `activeTool` carries only the
   * name; the args live in the pending tool-use block (the last one without a result), so we match
   * on name there to recover "which file / node / command".
   */
  private activeToolDescriptor(activeTool: string): string {
    const messages = this.chatState?.messages ?? [];
    const resolvedIds = new Set<string>();
    for (const message of messages) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (block.type === 'tool-result') resolvedIds.add(block.toolUseId);
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (typeof message.content === 'string') continue;
      for (let j = message.content.length - 1; j >= 0; j--) {
        const block = message.content[j];
        if (block.type === 'tool-use' && block.name === activeTool && !resolvedIds.has(block.id)) {
          return describeToolCall(block);
        }
      }
    }
    return '';
  }

  // ── Banners / composer ──────────────────────────────────────────────────────

  private renderBanners() {
    const chatState = this.chatState;
    if (!chatState) return null;
    // "Try again" / "Continue" re-run the loop on the existing history (no new user message). Only
    // when the turn is settled and there is something to resume.
    const canResume = chatState.status !== 'running' && chatState.messages.length > 0;

    return html`
      ${chatState.errorMessage
        ? html`<div class="agent-banner is-error">
            <span class="agent-banner-text">${chatState.errorMessage}</span>
            ${chatState.errorKind === 'missing-key'
              ? html`<button
                  type="button"
                  class="agent-banner-action"
                  @click=${() => this.openModelPickerForKey()}
                >
                  Set key
                </button>`
              : canResume
                ? html`<button
                    type="button"
                    class="agent-banner-action"
                    title="Re-run the last turn on the same conversation"
                    @click=${() => void this.chat.resume()}
                  >
                    <span class="agent-btn-icon"
                      >${this.icons.getIcon('refresh-cw', IconSize.SMALL)}</span
                    >
                    Try again
                  </button>`
                : null}
          </div>`
        : null}
      ${chatState.notice
        ? html`<div class="agent-banner is-notice">
            <span class="agent-banner-text">${chatState.notice}</span>
            ${canResume
              ? html`<button
                  type="button"
                  class="agent-banner-action"
                  title="Keep going from where the agent stopped"
                  @click=${() => void this.chat.resume()}
                >
                  <span class="agent-btn-icon">${this.icons.getIcon('play', IconSize.SMALL)}</span>
                  Continue
                </button>`
              : null}
          </div>`
        : null}
    `;
  }

  private renderComposer() {
    const running = this.chatState?.status === 'running';
    const canSend = Boolean(this.draft.trim()) || this.attachments.length > 0;

    return html`
      <div
        class="agent-composer ${this.dragActive ? 'is-drag' : ''}"
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      >
        ${this.dragActive
          ? html`<div class="agent-drop-hint">Drop images or text files to attach</div>`
          : null}
        ${this.renderContextMeter()} ${this.renderAttachments()}
        <div class="agent-input-box">
          <textarea
            class="agent-input"
            aria-label="Message the agent"
            rows="3"
            .value=${this.draft}
            placeholder="Ask the agent… (Enter to send, Shift+Enter for a newline, ↑ for last prompt)"
            ?disabled=${running}
            @input=${(e: Event) => {
              this.draft = (e.target as HTMLTextAreaElement).value;
              this.historyIndex = -1;
            }}
            @keydown=${this.handleComposerKeydown}
            @paste=${this.handlePaste}
          ></textarea>
          <div class="agent-input-actions">
            <input
              type="file"
              multiple
              hidden
              ${ref(this.fileInputRef)}
              @change=${this.handleFileInput}
            />
            <button
              type="button"
              class="agent-attach agent-icon-btn"
              title="Attach an image or text file"
              aria-label="Attach a file"
              @click=${() => this.fileInputRef.value?.click()}
            >
              ${this.icons.getIcon('paperclip', IconSize.SMALL)}
            </button>
            <span class="agent-input-spacer"></span>
            ${this.renderReasoningPickerButton()} ${this.renderModelPickerButton()}
            ${running
              ? html`<button type="button" class="agent-stop" @click=${() => this.chat.stop()}>
                  <span class="agent-btn-icon">${this.icons.getIcon('stop', IconSize.SMALL)}</span>
                  Stop
                </button>`
              : html`<button
                  type="button"
                  class="agent-send"
                  ?disabled=${!canSend}
                  @click=${() => void this.sendDraft()}
                >
                  <span class="agent-btn-icon">${this.icons.getIcon('send', IconSize.SMALL)}</span>
                  Send
                </button>`}
          </div>
        </div>
        ${this.modelPickerOpen ? this.renderModelPicker() : null}
        ${this.reasoningPickerOpen ? this.renderReasoningPicker() : null}
        ${this.debugMode
          ? html`<div class="agent-debug-row">
              <button
                type="button"
                class="agent-debug-btn ${this.debugView === 'raw' ? 'is-active' : ''}"
                title="View the raw wire-format conversation log"
                @click=${() => this.toggleDebugView('raw')}
              >
                Raw
              </button>
              <button
                type="button"
                class="agent-debug-btn ${this.debugView === 'system' ? 'is-active' : ''}"
                title="View the resolved system prompt"
                @click=${() => void this.toggleDebugView('system')}
              >
                Sys
              </button>
            </div>`
          : null}
      </div>
    `;
  }

  /**
   * Context-fill indicator: a full-width progress bar showing how full the selected model's context
   * window is, based on the token count sent on the last turn. Shows the percentage prominently
   * plus "used / limit" when the window size is known; falls back to a bare token count (no bar)
   * for models that don't report a window (local / custom endpoints). Renders nothing until the
   * first turn reports usage. Cumulative session tokens ride in the tooltip.
   */
  private renderContextMeter() {
    const chatState = this.chatState;
    if (!chatState) return null;
    const metric = latestContextMetric(chatState.turnMetrics);
    if (metric?.inputTokens === undefined) return null;
    const used = metric.inputTokens;
    const cached = Math.min(metric.cacheReadTokens ?? 0, used);

    const contextWindow = this.modelCatalog.getModel(this.providerId, this.modelId)?.capabilities
      .contextWindow;
    const usage = chatState.totalUsage;
    const sessionTip =
      usage.inputTokens || usage.outputTokens
        ? ` · session ${usage.inputTokens ?? 0}↑ ${usage.outputTokens ?? 0}↓`
        : '';
    // Cache detail folded into the meter tooltip: what the provider served from cache this turn,
    // plus the local prediction of the unchanged (cacheable) prefix.
    const cacheTip = cached
      ? `\n${cached.toLocaleString()} tok served from cache this turn`
      : metric.predictedCacheTokens
        ? `\n~${metric.predictedCacheTokens.toLocaleString()} tok of leading prefix unchanged (cacheable)`
        : '';

    if (!contextWindow) {
      return html`<div
        class="agent-context is-unbounded"
        title="Context used on the last request: ${used.toLocaleString()} tokens${sessionTip}${cacheTip}"
      >
        <span class="agent-context-label">Context</span>
        <span class="agent-context-value">${formatTokenCount(used)} tokens</span>
      </div>`;
    }

    const ratio = Math.min(1, used / contextWindow);
    const pct = Math.round(ratio * 100);
    const cachedPct = Math.round(Math.min(1, cached / contextWindow) * 100);
    const level = ratio >= 0.9 ? 'is-high' : ratio >= 0.7 ? 'is-mid' : '';
    return html`
      <div
        class="agent-context ${level}"
        title="Context: ${used.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct}%)${sessionTip}${cacheTip}"
      >
        <span class="agent-context-label">Context</span>
        <span
          class="agent-context-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow=${pct}
          aria-label="Context window usage"
        >
          <span class="agent-context-fill" style=${`width: ${pct}%`}></span>
          ${cachedPct > 0
            ? html`<span class="agent-context-cache" style=${`width: ${cachedPct}%`}></span>`
            : null}
        </span>
        <span class="agent-context-value"
          >${pct}% · ${formatTokenCount(used)} / ${formatTokenCount(contextWindow)}</span
        >
      </div>
    `;
  }

  private renderAttachments() {
    if (this.attachments.length === 0 && !this.attachWarning) {
      return null;
    }
    return html`
      <div class="agent-attachments">
        ${this.attachments.map(
          att => html`
            <span class="agent-attachment" title=${att.name}>
              ${att.kind === 'image'
                ? html`<img
                    class="agent-attachment-thumb"
                    alt=${att.name}
                    src=${`data:${att.mimeType};base64,${att.base64}`}
                  />`
                : html`<span class="agent-attachment-icon"
                    >${this.icons.getIcon('file-text', IconSize.SMALL)}</span
                  >`}
              <span class="agent-attachment-name">${att.name}</span>
              <button
                type="button"
                class="agent-attachment-remove agent-icon-btn"
                title="Remove"
                aria-label="Remove attachment"
                @click=${() => this.removeAttachment(att.id)}
              >
                ${this.icons.getIcon('x', IconSize.SMALL)}
              </button>
            </span>
          `
        )}
        ${this.attachWarning
          ? html`<span class="agent-attachment-warning">${this.attachWarning}</span>`
          : null}
      </div>
    `;
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private handleMessagesScroll = (): void => {
    const container = this.messagesRef.value;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    this.shouldStickToBottom = distanceFromBottom < 32;
  };

  private handleComposerKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.sendDraft();
      return;
    }
    // Shell-style prompt recall: ArrowUp from an empty input (or while already navigating) walks
    // back through prior prompts; ArrowDown walks forward. Typing exits navigation (see @input).
    if (e.key === 'ArrowUp' && !e.isComposing && (this.draft === '' || this.historyIndex !== -1)) {
      const prompts = extractUserPrompts(this.chatState?.messages ?? []);
      if (prompts.length === 0) return;
      e.preventDefault();
      this.historyIndex =
        this.historyIndex === -1 ? prompts.length - 1 : Math.max(0, this.historyIndex - 1);
      this.setDraftFromHistory(prompts[this.historyIndex] ?? '');
    } else if (e.key === 'ArrowDown' && this.historyIndex !== -1) {
      const prompts = extractUserPrompts(this.chatState?.messages ?? []);
      e.preventDefault();
      if (this.historyIndex >= prompts.length - 1) {
        this.historyIndex = -1;
        this.setDraftFromHistory('');
      } else {
        this.historyIndex += 1;
        this.setDraftFromHistory(prompts[this.historyIndex] ?? '');
      }
    }
  };

  /** Set the draft to a recalled prompt and move the caret to the end after the DOM updates. */
  private setDraftFromHistory(text: string): void {
    this.draft = text;
    void this.updateComplete.then(() => {
      const ta = this.querySelector<HTMLTextAreaElement>('.agent-input');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }

  /**
   * Drop a prefilled prompt (e.g. from a "Fix with Agent" button) into the composer and focus it so
   * the user can review/edit before sending — the service has already opened a fresh conversation.
   */
  private applyComposePrefill(text: string): void {
    this.draft = text;
    this.attachments = [];
    this.attachWarning = '';
    this.historyIndex = -1;
    this.historyOpen = false;
    this.shouldStickToBottom = true;
    void this.updateComplete.then(() => {
      const ta = this.querySelector<HTMLTextAreaElement>('.agent-input');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }

  private async sendDraft(): Promise<void> {
    const text = this.draft.trim();
    if ((!text && this.attachments.length === 0) || this.chat.isRunning()) {
      return;
    }
    const images: LlmImageBlock[] = this.attachments
      .filter((a): a is Extract<ComposerAttachment, { kind: 'image' }> => a.kind === 'image')
      .map(a => ({ type: 'image', mimeType: a.mimeType, data: a.base64 }));
    const texts = this.attachments
      .filter((a): a is Extract<ComposerAttachment, { kind: 'text' }> => a.kind === 'text')
      .map(a => ({ name: a.name, content: a.content }));

    this.draft = '';
    this.attachments = [];
    this.attachWarning = '';
    this.historyIndex = -1;
    this.shouldStickToBottom = true;
    await this.chat.send(text, { images, texts });
  }

  // ── Attachments (paste / drop / file picker) ─────────────────────────────────

  private handlePaste = (e: ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return; // Plain text paste falls through to the textarea.
    e.preventDefault();
    void this.addFiles(files);
  };

  private handleFileInput = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void this.addFiles(input.files);
    }
    input.value = '';
  };

  private handleDragOver = (e: DragEvent): void => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault();
      this.dragActive = true;
    }
  };

  private handleDragLeave = (): void => {
    this.dragActive = false;
  };

  private handleDrop = (e: DragEvent): void => {
    this.dragActive = false;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void this.addFiles(files);
    }
  };

  private async addFiles(files: FileList | File[]): Promise<void> {
    this.attachWarning = '';
    const added: ComposerAttachment[] = [];
    for (const file of Array.from(files)) {
      const attachment = await this.fileToAttachment(file);
      if (attachment) added.push(attachment);
    }
    if (added.length > 0) {
      this.attachments = [...this.attachments, ...added];
    }
  }

  private async fileToAttachment(file: File): Promise<ComposerAttachment | null> {
    const id = `att-${this.attachmentSeq++}`;
    if (file.type.startsWith('image/')) {
      if (!this.imagesSupported) {
        this.attachWarning = 'The selected model does not accept images — pick a vision model.';
        return null;
      }
      try {
        const base64 = await blobToBase64(file);
        return {
          id,
          kind: 'image',
          name: file.name || 'pasted-image.png',
          mimeType: file.type,
          base64,
        };
      } catch {
        this.attachWarning = `Could not read ${file.name}.`;
        return null;
      }
    }
    if (isTextualFile(file)) {
      try {
        return { id, kind: 'text', name: file.name || 'file.txt', content: await file.text() };
      } catch {
        this.attachWarning = `Could not read ${file.name}.`;
        return null;
      }
    }
    this.attachWarning = `Unsupported file type: ${file.name}`;
    return null;
  }

  private removeAttachment(id: string): void {
    this.attachments = this.attachments.filter(a => a.id !== id);
  }

  /** True when the active model accepts images (unknown/custom models are optimistically allowed). */
  private get imagesSupported(): boolean {
    const model = this.modelCatalog.getModel(this.providerId, this.modelId);
    return model ? model.capabilities.supportsImages : true;
  }

  private async toggleDebugView(view: 'raw' | 'system'): Promise<void> {
    if (this.debugView === view) {
      this.debugView = 'none';
      return;
    }
    this.debugView = view;
    if (view === 'system') {
      try {
        this.systemPromptText = await this.chat.previewSystemPrompt();
      } catch (error) {
        this.systemPromptText = `Failed to build system prompt: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }

  private handleBaseUrlChange = (e: Event): void => {
    this.settings.updatePreferences({ customBaseUrl: (e.target as HTMLInputElement).value.trim() });
  };

  private handleNewConversation = (): void => {
    this.historyOpen = false;
    this.draft = '';
    this.attachments = [];
    this.attachWarning = '';
    this.historyIndex = -1;
    void this.chat.newConversation();
  };

  private toggleHistory = (): void => {
    this.historyOpen = !this.historyOpen;
  };

  private handleSwitchConversation(id: string): void {
    this.historyOpen = false;
    this.draft = '';
    this.historyIndex = -1;
    void this.chat.switchConversation(id);
  }

  private handleDeleteConversation(id: string, event: Event): void {
    event.stopPropagation();
    void this.chat.deleteConversation(id);
  }

  private renderHistoryPopover() {
    const conversations = this.chatState?.conversations ?? [];
    const activeId = this.chatState?.activeConversationId ?? null;
    return html`
      <div class="agent-history-popover">
        <div class="agent-history-head">Conversations</div>
        ${conversations.length === 0
          ? html`<div class="agent-history-empty">No past conversations yet.</div>`
          : html`<ul class="agent-history-list">
              ${conversations.map(
                conversation => html`
                  <li
                    class="agent-history-item ${conversation.id === activeId ? 'is-active' : ''}"
                    @click=${() => this.handleSwitchConversation(conversation.id)}
                  >
                    <div class="agent-history-item-main">
                      <span class="agent-history-item-title">${conversation.title}</span>
                      <span class="agent-history-item-meta">
                        ${formatRelativeTime(conversation.updatedAt)} · ${conversation.messageCount}
                        msg
                      </span>
                    </div>
                    <button
                      type="button"
                      class="agent-history-delete agent-icon-btn"
                      title="Delete this conversation"
                      aria-label="Delete conversation"
                      @click=${(event: Event) =>
                        this.handleDeleteConversation(conversation.id, event)}
                    >
                      ${this.icons.getIcon('trash-2', IconSize.SMALL)}
                    </button>
                  </li>
                `
              )}
            </ul>`}
      </div>
    `;
  }

  private async refreshKeyConfigured(): Promise<void> {
    const providerId = this.providerId;
    const configured = providerId ? await this.settings.hasApiKey(providerId) : false;
    // Guard against a provider switch racing the async check.
    if (providerId === this.providerId) {
      this.keyConfigured = configured;
    }
  }

  private async saveKeyFor(providerId: string): Promise<void> {
    const key = this.keyDraft.trim();
    if (!key) {
      this.keyEditorProviderId = null;
      return;
    }
    await this.settings.setApiKey(providerId, key);
    this.keyDraft = '';
    this.keyEditorProviderId = null;
    await this.refreshProviderKeys();
    await this.refreshKeyConfigured();
  }

  private async clearKeyFor(providerId: string): Promise<void> {
    await this.settings.clearApiKey(providerId);
    this.keyDraft = '';
    await this.refreshProviderKeys();
    await this.refreshKeyConfigured();
  }

  // ── Model picker open/close + selection ──────────────────────────────────────

  private toggleModelPicker(): void {
    if (this.modelPickerOpen) {
      this.closeModelPicker();
    } else {
      this.openModelPicker();
    }
  }

  private openModelPicker(): void {
    if (this.modelPickerOpen) return;
    this.modelPickerOpen = true;
    this.modelPickerQuery = '';
    this.keyEditorProviderId = null;
    this.keyDraft = '';
    void this.refreshProviderKeys();
    document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
    document.addEventListener('keydown', this.handleModelPickerKeydown, true);
  }

  private closeModelPicker(): void {
    if (!this.modelPickerOpen) return;
    this.modelPickerOpen = false;
    this.keyEditorProviderId = null;
    this.keyDraft = '';
    document.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
    document.removeEventListener('keydown', this.handleModelPickerKeydown, true);
  }

  /** Open the picker straight into the current provider's key editor (missing-key banner action). */
  private openModelPickerForKey(): void {
    this.openModelPicker();
    this.keyEditorProviderId = this.providerId;
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.modelPickerOpen) return;
    const path = event.composedPath();
    const popover = this.querySelector('.agent-model-picker-popover');
    const trigger = this.querySelector('.agent-model-picker');
    // Clicks inside the popover or on the trigger button handle themselves.
    if (popover && path.includes(popover)) return;
    if (trigger && path.includes(trigger)) return;
    this.closeModelPicker();
  };

  private readonly handleModelPickerKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.modelPickerOpen) {
      event.preventDefault();
      this.closeModelPicker();
    }
  };

  private selectModel(providerId: string, modelId: string): void {
    this.settings.updatePreferences({
      selectedProviderId: providerId,
      modelByProvider: { [providerId]: modelId },
    });
    this.closeModelPicker();
  }

  // ── Reasoning-level picker open/close + selection ────────────────────────────

  private toggleReasoningPicker(): void {
    if (this.reasoningPickerOpen) {
      this.closeReasoningPicker();
    } else {
      this.openReasoningPicker();
    }
  }

  private openReasoningPicker(): void {
    if (this.reasoningPickerOpen) return;
    this.reasoningPickerOpen = true;
    document.addEventListener('pointerdown', this.handleReasoningPointerDown, true);
    document.addEventListener('keydown', this.handleReasoningKeydown, true);
  }

  private closeReasoningPicker(): void {
    if (!this.reasoningPickerOpen) return;
    this.reasoningPickerOpen = false;
    document.removeEventListener('pointerdown', this.handleReasoningPointerDown, true);
    document.removeEventListener('keydown', this.handleReasoningKeydown, true);
  }

  private readonly handleReasoningPointerDown = (event: PointerEvent): void => {
    if (!this.reasoningPickerOpen) return;
    const path = event.composedPath();
    const popover = this.querySelector('.agent-reasoning-popover');
    const trigger = this.querySelector('.agent-reasoning-picker');
    if (popover && path.includes(popover)) return;
    if (trigger && path.includes(trigger)) return;
    this.closeReasoningPicker();
  };

  private readonly handleReasoningKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.reasoningPickerOpen) {
      event.preventDefault();
      this.closeReasoningPicker();
    }
  };

  private selectReasoning(effort: ReasoningEffort | undefined): void {
    this.settings.setReasoningEffort(this.providerId, this.modelId, effort);
    this.closeReasoningPicker();
  }

  /** Free-text model id for a base-URL provider: selects that provider and its typed model. */
  private handleCustomModelEntry(providerId: string, event: Event): void {
    const modelId = (event.target as HTMLInputElement).value.trim();
    if (!modelId) return;
    this.settings.updatePreferences({
      selectedProviderId: providerId,
      modelByProvider: { [providerId]: modelId },
    });
    this.closeModelPicker();
  }

  private async refreshProviderKeys(): Promise<void> {
    const entries = await Promise.all(
      this.providers
        .list()
        .filter(provider => !provider.hidden)
        .map(async provider => {
          const has = await this.settings.hasApiKey(provider.id);
          return [provider.id, has] as const;
        })
    );
    this.providerKeys = Object.fromEntries(entries);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-agent-chat-panel': AgentChatPanel;
  }
}
