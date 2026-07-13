import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { createRef, ref } from 'lit/directives/ref.js';
import { AgentChatService, type AgentChatState } from '@/services/agent/AgentChatService';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import {
  formatPricingHint,
  type LlmContentBlock,
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

/** One rendered chat entry, derived from the wire history (tool calls paired with their results). */
type DisplayItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string }
  | { kind: 'image'; role: 'user' | 'assistant'; mimeType: string; data: string }
  | { kind: 'tool'; call: LlmToolUseBlock; result: LlmToolResultBlock | null };

/** Pair every tool-use block with its result and flatten the history into renderable items. */
const toDisplayItems = (messages: readonly LlmMessage[]): DisplayItem[] => {
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
  for (const message of messages) {
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
  }
  return items;
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

  private disposeChatSubscription?: () => void;
  private disposeSettingsSubscription?: () => void;
  private disposeCatalogSubscription?: () => void;
  private readonly messagesRef = createRef<HTMLDivElement>();
  private shouldStickToBottom = true;

  connectedCallback(): void {
    super.connectedCallback();

    this.disposeChatSubscription = this.chat.subscribe(chatState => {
      this.chatState = chatState;
    });
    this.disposeSettingsSubscription = this.settings.subscribe(prefs => {
      this.providerId = prefs.selectedProviderId;
      this.modelId = this.settings.getSelectedModelId(prefs.selectedProviderId) ?? '';
      this.customBaseUrl = prefs.customBaseUrl;
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
    const items = chatState ? toDisplayItems(chatState.messages) : [];
    const running = chatState?.status === 'running';

    return html`
      <div class="agent-chat">
        <div class="agent-messages" ${ref(this.messagesRef)} @scroll=${this.handleMessagesScroll}>
          ${items.length === 0 ? this.renderEmptyState() : items.map(item => this.renderItem(item))}
          ${running ? this.renderRunningIndicator() : null}
        </div>
        ${this.renderBanners()} ${this.renderComposer()}
      </div>
    `;
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
          ${this.keyConfigured ? '🔑 Key set' : '🔑 Set key'}
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

    const { call, result } = item;
    const statusIcon = result ? (result.isError ? '✗' : '✓') : '…';
    return html`
      <details class="agent-tool-call ${result?.isError ? 'is-error' : ''}">
        <summary>
          <span class="agent-tool-status">${statusIcon}</span>
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

    return html`
      <div class="agent-composer">
        <textarea
          class="agent-input"
          aria-label="Message the agent"
          rows="3"
          .value=${this.draft}
          placeholder="Ask the agent… (Enter to send, Shift+Enter for a newline)"
          ?disabled=${running}
          @input=${(e: Event) => {
            this.draft = (e.target as HTMLTextAreaElement).value;
          }}
          @keydown=${this.handleComposerKeydown}
        ></textarea>
        <div class="agent-composer-toolbar">
          ${this.renderComposerControls()}
          <span class="agent-toolbar-spacer"></span>
          ${usageText
            ? html`<span class="agent-usage" title="Token usage this conversation"
                >${usageText}</span
              >`
            : null}
          <button
            type="button"
            class="agent-new-chat"
            title="Start a new conversation (clears history for this project)"
            @click=${this.handleNewConversation}
          >
            New chat
          </button>
          ${running
            ? html`<button type="button" class="agent-stop" @click=${() => this.chat.stop()}>
                Stop
              </button>`
            : html`<button
                type="button"
                class="agent-send"
                ?disabled=${!this.draft.trim()}
                @click=${() => void this.sendDraft()}
              >
                Send
              </button>`}
        </div>
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
    }
  };

  private async sendDraft(): Promise<void> {
    const text = this.draft.trim();
    if (!text || this.chat.isRunning()) {
      return;
    }
    this.draft = '';
    this.shouldStickToBottom = true;
    await this.chat.send(text);
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
    void this.chat.newConversation();
  };

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
