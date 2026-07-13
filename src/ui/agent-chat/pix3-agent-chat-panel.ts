import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { createRef, ref } from 'lit/directives/ref.js';
import {
  AgentChatService,
  type AgentChatState,
  type AgentTurnMetric,
} from '@/services/agent/AgentChatService';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { IconService, IconSize } from '@/services/IconService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
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
} from '@/services/llm/LlmTypes';
import { renderMarkdownLite } from './markdown-lite';
import './pix3-agent-chat-panel.ts.css';

/** Sentinel `<option>` value that switches the model picker into free-text (custom id) mode. */
const CUSTOM_MODEL_VALUE = '__custom__';

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
  return parts.join(' · ');
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

/**
 * The in-editor agent chat (opened as an editor tab, like the Asset Generator). Renders the
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

  @inject(IconService)
  private readonly icons!: IconService;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private chatState: AgentChatState | null = null;
  @state() private providerId = '';
  @state() private modelId = '';
  /** True when the model is typed by hand (custom/local id not in the provider's list). */
  @state() private modelCustomMode = false;
  @state() private customBaseUrl = '';
  @state() private keyConfigured = false;
  @state() private keyPopoverOpen = false;
  @state() private keyDraft = '';
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

  private disposeChatSubscription?: () => void;
  private disposeSettingsSubscription?: () => void;
  private disposeComposeSubscription?: () => void;
  private disposeCatalogSubscription?: () => void;
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
      this.customBaseUrl = prefs.customBaseUrl;
      this.debugMode = prefs.debugMode;
      if (!prefs.debugMode) {
        this.debugView = 'none';
      }
      this.syncModelCustomMode();
      void this.refreshKeyConfigured();
    });

    // Re-render (and re-derive custom-mode) when a live model catalog lands in the background.
    this.disposeCatalogSubscription = this.modelCatalog.subscribe(() => {
      this.syncModelCustomMode();
      this.requestUpdate();
    });

    void this.chat.ensureLoaded();
  }

  /** A stored model that isn't in the provider's (live or static) list is a hand-typed custom id. */
  private syncModelCustomMode(): void {
    const models = this.modelCatalog.getModels(this.providerId);
    this.modelCustomMode = this.modelId !== '' && !models.some(m => m.id === this.modelId);
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
    const running = chatState?.status === 'running';

    return html`
      <div class="agent-chat">
        <div class="agent-messages" ${ref(this.messagesRef)} @scroll=${this.handleMessagesScroll}>
          ${items.length === 0 ? this.renderEmptyState() : items.map(item => this.renderItem(item))}
          ${running ? this.renderRunningIndicator() : null}
        </div>
        ${this.debugView !== 'none' ? this.renderDebugDrawer() : null} ${this.renderBanners()}
        ${this.renderComposer()}
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

  // ── Composer toolbar (provider / model / key) ───────────────────────────────

  /**
   * Model picker: a real `<select>` of the provider's known models (a datalist
   * filters by the current value, so a preselected model collapses to a lone entry that reads like
   * a tooltip). Providers that accept arbitrary ids (OpenAI-compatible / local) also get a
   * "Custom…" entry that reveals a free-text input.
   */
  private renderModelSelector(provider: LlmProvider | undefined, models: readonly LlmModel[]) {
    const allowsCustom = provider?.requiresBaseUrl ?? false;
    const selectValue = this.modelCustomMode ? CUSTOM_MODEL_VALUE : this.modelId;

    return html`
      <select
        class="agent-model-select"
        aria-label="Model"
        .value=${selectValue}
        @change=${this.handleModelSelectChange}
      >
        ${models.map(m => {
          const hint = formatPricingHint(m.pricing);
          return html`<option
            value=${m.id}
            ?selected=${!this.modelCustomMode && m.id === this.modelId}
          >
            ${m.label}${hint ? ` · ${hint}` : ''}
          </option>`;
        })}
        ${allowsCustom
          ? html`<option value=${CUSTOM_MODEL_VALUE} ?selected=${this.modelCustomMode}>
              Custom…
            </option>`
          : null}
      </select>
      ${this.modelCustomMode
        ? html`<input
            class="agent-model-input"
            aria-label="Custom model id"
            .value=${this.modelId}
            @change=${this.handleModelChange}
            placeholder="custom model id"
          />`
        : null}
    `;
  }

  /** Provider / model / base-URL / key controls, shown in the composer footer (below the input). */
  private renderComposerControls() {
    const provider = this.providers.get(this.providerId);
    const models = provider ? this.modelCatalog.getModels(provider.id) : [];

    return html`
      <select
        class="agent-provider-select"
        aria-label="LLM provider"
        .value=${this.providerId}
        @change=${this.handleProviderChange}
      >
        ${this.providers
          .list()
          .map(
            p =>
              html`<option value=${p.id} ?selected=${p.id === this.providerId}>${p.label}</option>`
          )}
      </select>

      ${this.renderModelSelector(provider, models)}
      ${provider?.requiresBaseUrl
        ? html`<input
            class="agent-baseurl-input"
            aria-label="API base URL"
            .value=${this.customBaseUrl}
            @change=${this.handleBaseUrlChange}
            placeholder=${provider.defaultBaseUrl ?? 'https://…'}
          />`
        : null}

      <div class="agent-key-wrap">
        <button
          type="button"
          class="agent-key-button ${this.keyConfigured ? 'is-configured' : 'is-missing'}"
          @click=${() => {
            this.keyPopoverOpen = !this.keyPopoverOpen;
            this.keyDraft = '';
          }}
          title=${this.keyConfigured ? 'API key configured' : 'Set your API key'}
        >
          <span class="agent-btn-icon">${this.icons.getIcon('key', IconSize.SMALL)}</span>
          ${this.keyConfigured ? 'Key set' : 'Set key'}
        </button>
        ${this.keyPopoverOpen ? this.renderKeyPopover() : null}
      </div>
    `;
  }

  private renderKeyPopover() {
    const provider = this.providers.get(this.providerId);
    return html`
      <div class="agent-key-popover">
        <label class="agent-key-label">
          ${provider?.label ?? 'Provider'} API key
          <input
            type="password"
            class="agent-key-input"
            .value=${this.keyDraft}
            placeholder=${this.keyConfigured ? '•••••••• (stored)' : 'paste key'}
            @input=${(e: Event) => {
              this.keyDraft = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') void this.saveKey();
            }}
          />
        </label>
        <div class="agent-key-actions">
          <button type="button" class="agent-key-save" @click=${() => void this.saveKey()}>
            Save
          </button>
          ${this.keyConfigured
            ? html`<button
                type="button"
                class="agent-key-clear"
                @click=${() => void this.clearKey()}
              >
                Clear
              </button>`
            : null}
          ${provider?.apiKeyHelpUrl
            ? html`<a
                class="agent-key-help"
                href=${provider.apiKeyHelpUrl}
                target="_blank"
                rel="noreferrer"
                >Get a key</a
              >`
            : null}
        </div>
        <p class="agent-key-note">
          Stored encrypted in this browser; requests go directly to the provider.
        </p>
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
              Set your API key first — pick a provider above and press <strong>Set key</strong>.
            </p>`}
      </div>
    `;
  }

  private renderItem(item: DisplayItem) {
    if (item.kind === 'text') {
      return html`
        <div class="agent-message ${item.role === 'user' ? 'is-user' : 'is-assistant'}">
          ${item.role === 'assistant'
            ? html`<div class="agent-message-md">${renderMarkdownLite(item.text)}</div>`
            : html`<div class="agent-message-text">${item.text}</div>`}
        </div>
      `;
    }

    if (item.kind === 'image') {
      return html`
        <img
          class="agent-image"
          alt="Tool-captured image"
          src=${`data:${item.mimeType};base64,${item.data}`}
        />
      `;
    }

    if (item.kind === 'metrics') {
      return html`<div class="agent-metrics">${formatMetric(item.metric)}</div>`;
    }

    const { call, result } = item;
    const status = result ? (result.isError ? 'error' : 'ok') : 'pending';
    return html`
      <details class="agent-tool-call ${result?.isError ? 'is-error' : ''}">
        <summary>
          <span class="agent-tool-status is-${status}">
            ${status === 'ok'
              ? this.icons.getIcon('check', IconSize.SMALL)
              : status === 'error'
                ? this.icons.getIcon('x', IconSize.SMALL)
                : html`<span class="agent-inline-spinner"></span>`}
          </span>
          <code>${call.name}</code>
        </summary>
        <div class="agent-tool-detail">
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

  private renderRunningIndicator() {
    const activeTool = this.chatState?.activeTool;
    return html`
      <div class="agent-running">
        <span class="agent-running-spinner"></span>
        ${activeTool ? html`Running <code>${activeTool}</code>…` : 'Thinking…'}
      </div>
    `;
  }

  // ── Banners / composer ──────────────────────────────────────────────────────

  private renderBanners() {
    const chatState = this.chatState;
    if (!chatState) return null;

    return html`
      ${chatState.errorMessage
        ? html`<div class="agent-banner is-error">
            ${chatState.errorMessage}
            ${chatState.errorKind === 'missing-key'
              ? html`<button
                  type="button"
                  class="agent-banner-action"
                  @click=${() => {
                    this.keyPopoverOpen = true;
                  }}
                >
                  Set key
                </button>`
              : null}
          </div>`
        : null}
      ${chatState.notice
        ? html`<div class="agent-banner is-notice">${chatState.notice}</div>`
        : null}
    `;
  }

  private renderComposer() {
    const running = this.chatState?.status === 'running';
    const usage = this.chatState?.totalUsage;
    const usageText =
      usage && (usage.inputTokens || usage.outputTokens)
        ? `${usage.inputTokens ?? 0}↑ ${usage.outputTokens ?? 0}↓ tokens`
        : '';
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
        ${this.renderAttachments()}
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
        <div class="agent-composer-toolbar">
          ${this.renderComposerControls()}
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
          <span class="agent-toolbar-spacer"></span>
          ${this.debugMode
            ? html`<button
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
                </button>`
            : null}
          ${usageText
            ? html`<span class="agent-usage" title="Token usage this conversation"
                >${usageText}</span
              >`
            : null}
          <div class="agent-history-wrap">
            <button
              type="button"
              class="agent-history-btn ${this.historyOpen ? 'is-active' : ''}"
              title="Past conversations"
              aria-label="Past conversations"
              aria-expanded=${String(this.historyOpen)}
              @click=${this.toggleHistory}
            >
              <span class="agent-btn-icon">${this.icons.getIcon('clock', IconSize.SMALL)}</span>
              History
            </button>
            ${this.historyOpen ? this.renderHistoryPopover() : null}
          </div>
          <button
            type="button"
            class="agent-new-chat"
            title="Start a new conversation (keeps the old ones in History)"
            @click=${this.handleNewConversation}
          >
            <span class="agent-btn-icon">${this.icons.getIcon('plus', IconSize.SMALL)}</span>
            New chat
          </button>
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

  private handleProviderChange = (e: Event): void => {
    const providerId = (e.target as HTMLSelectElement).value;
    this.settings.updatePreferences({ selectedProviderId: providerId });
  };

  private handleModelSelectChange = (e: Event): void => {
    const value = (e.target as HTMLSelectElement).value;
    if (value === CUSTOM_MODEL_VALUE) {
      // Switch to a free-text field; keep the stored id until the user types a new one.
      this.modelCustomMode = true;
      return;
    }
    this.modelCustomMode = false;
    this.settings.updatePreferences({ modelByProvider: { [this.providerId]: value } });
  };

  private handleModelChange = (e: Event): void => {
    const modelId = (e.target as HTMLInputElement).value.trim();
    if (modelId) {
      this.settings.updatePreferences({ modelByProvider: { [this.providerId]: modelId } });
    }
  };

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
                        ${formatRelativeTime(conversation.updatedAt)} ·
                        ${conversation.messageCount} msg
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

  private async saveKey(): Promise<void> {
    const key = this.keyDraft.trim();
    if (!key) {
      this.keyPopoverOpen = false;
      return;
    }
    await this.settings.setApiKey(this.providerId, key);
    this.keyDraft = '';
    this.keyPopoverOpen = false;
    await this.refreshKeyConfigured();
  }

  private async clearKey(): Promise<void> {
    await this.settings.clearApiKey(this.providerId);
    this.keyDraft = '';
    await this.refreshKeyConfigured();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-agent-chat-panel': AgentChatPanel;
  }
}
