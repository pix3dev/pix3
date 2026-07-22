import { ComponentBase, customElement, html, inject, state, css, unsafeCSS } from '@/fw';
import { LoggingService, type LogLevel, type LogEntry } from '@/services/core/LoggingService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { LayoutManagerService } from '@/core/LayoutManager';
import styles from './logs-panel.ts.css?raw';

@customElement('pix3-logs-panel')
export class LogsPanel extends ComponentBase {
  static useShadowDom = true;

  static styles = css`
    ${unsafeCSS(styles)}
  `;

  @inject(LoggingService)
  private readonly loggingService!: LoggingService;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @state()
  private logs: LogEntry[] = [];

  @state()
  private enabledLevels: Set<LogLevel> = new Set(['info', 'warn', 'error']);

  @state()
  private expandedLogs: Set<string> = new Set();

  /** '' = editor logs, 'all' = everything, otherwise a remote source label. */
  @state()
  private sourceFilter = 'all';

  private disposeListen?: () => void;
  private contentElement?: HTMLElement;

  connectedCallback() {
    super.connectedCallback();

    // Get initial logs
    this.logs = this.loggingService.getLogs();
    this.enabledLevels = new Set(this.loggingService.getEnabledLevels());

    // Subscribe to new logs
    this.disposeListen = this.loggingService.subscribe(() => {
      this.logs = [...this.loggingService.getLogs()];
      this.requestUpdate();
      // Scroll to bottom when new log arrives
      this.scrollToBottom();
    });
  }

  disconnectedCallback() {
    this.disposeListen?.();
    this.disposeListen = undefined;
    super.disconnectedCallback();
  }

  protected updated() {
    // Scroll to bottom after render
    this.scrollToBottom();
  }

  private scrollToBottom() {
    if (!this.contentElement) {
      this.contentElement = this.renderRoot.querySelector('.logs-content') || undefined;
    }
    if (this.contentElement) {
      this.contentElement.scrollTop = this.contentElement.scrollHeight;
    }
  }

  private handleLevelToggle(level: LogLevel) {
    this.loggingService.toggleLevel(level);
    this.enabledLevels = new Set(this.loggingService.getEnabledLevels());
    this.requestUpdate();
  }

  private handleClear() {
    this.loggingService.clearLogs();
    this.logs = [];
    this.expandedLogs = new Set();
    this.requestUpdate();
  }

  private handleSourceFilterChange(event: Event) {
    this.sourceFilter = (event.currentTarget as HTMLSelectElement).value;
  }

  /** Open a fresh agent chat prefilled with this log entry so the agent can fix the cause. */
  private handleFixWithAgent(log: LogEntry, event: Event) {
    event.stopPropagation();
    const details = this.formatErrorDetails(log.data);
    const prompt = [
      'Fix this error reported in the editor logs. Investigate the root cause and fix it.',
      '',
      `[${log.level.toUpperCase()}] ${log.message}`,
      ...(details ? ['', details] : []),
      '',
      'Use read_errors and read_logs for more context, inspect the relevant node/script, fix the cause, then verify your fix.',
    ].join('\n');
    this.layoutManager.revealAgentPanel();
    void this.agentChat.composeFix(prompt);
  }

  /** Distinct remote source labels present in the current log buffer. */
  private getRemoteSources(): string[] {
    const sources = new Set<string>();
    for (const log of this.logs) {
      if (log.source) {
        sources.add(log.source);
      }
    }
    return [...sources].sort((left, right) => left.localeCompare(right));
  }

  private toggleLogExpansion(id: string) {
    const newExpanded = new Set(this.expandedLogs);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    this.expandedLogs = newExpanded;
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  }

  private formatErrorDetails(data: unknown): string {
    if (!data) {
      return '';
    }

    if (typeof data !== 'object') {
      return String(data);
    }

    const errorData = data as Record<string, unknown>;
    const parts: string[] = [];

    if (errorData.file) {
      parts.push(`File: ${String(errorData.file)}`);
    }
    if (errorData.attemptedPath) {
      parts.push(`Attempted Path: ${String(errorData.attemptedPath)}`);
    }
    if (errorData.requestedImport) {
      parts.push(`Requested Import: ${String(errorData.requestedImport)}`);
    }
    if (errorData.importer) {
      parts.push(`Declared In: ${String(errorData.importer)}`);
    }
    if (errorData.namespace) {
      parts.push(`Namespace: ${String(errorData.namespace)}`);
    }
    if (errorData.status !== undefined && errorData.status !== null) {
      parts.push(`Status: ${String(errorData.status)}`);
    }
    if (errorData.line !== undefined) {
      parts.push(`Line: ${String(errorData.line)}`);
    }
    if (errorData.column !== undefined) {
      parts.push(`Column: ${String(errorData.column)}`);
    }

    if (errorData.details && typeof errorData.details === 'object') {
      const details = errorData.details as Record<string, unknown>;
      if (details.message) {
        parts.push(`Message: ${String(details.message)}`);
      }
      if (details.text) {
        parts.push(`Error: ${String(details.text)}`);
      }
      if (details.stack) {
        parts.push(`Stack: ${String(details.stack)}`);
      }
    } else if (errorData.message && typeof errorData.message === 'string') {
      parts.push(`Message: ${errorData.message}`);
    } else if (errorData.stack && typeof errorData.stack === 'string') {
      parts.push(`Stack: ${errorData.stack}`);
    }

    if (parts.length === 0) {
      try {
        return JSON.stringify(data, null, 2);
      } catch {
        return String(data);
      }
    }

    return parts.join('\n');
  }

  private renderLevelToggle(level: LogLevel) {
    const isEnabled = this.enabledLevels.has(level);
    return html`
      <div class="level-toggle ${level}">
        <input
          type="checkbox"
          id="level-${level}"
          .checked=${isEnabled}
          @change=${() => {
            this.handleLevelToggle(level);
          }}
          aria-label="Toggle ${level} logs"
        />
        <label for="level-${level}">${level.toUpperCase()}</label>
      </div>
    `;
  }

  protected render() {
    const remoteSources = this.getRemoteSources();
    const sourceFilter =
      this.sourceFilter !== 'all' &&
      this.sourceFilter !== '' &&
      !remoteSources.includes(this.sourceFilter)
        ? 'all'
        : this.sourceFilter;
    const visibleLogs = this.logs.filter(
      log =>
        this.enabledLevels.has(log.level) &&
        (sourceFilter === 'all' || (log.source ?? '') === sourceFilter)
    );

    return html`
      <div class="logs-container">
        <div class="logs-header">
          <div class="logs-controls">
            ${this.renderLevelToggle('debug')} ${this.renderLevelToggle('info')}
            ${this.renderLevelToggle('warn')} ${this.renderLevelToggle('error')}
          </div>
          ${remoteSources.length > 0
            ? html`
                <select
                  class="source-filter"
                  .value=${sourceFilter}
                  @change=${this.handleSourceFilterChange}
                  aria-label="Filter logs by source"
                >
                  <option value="all">All sources</option>
                  <option value="">Editor</option>
                  ${remoteSources.map(source => html`<option value=${source}>${source}</option>`)}
                </select>
              `
            : null}
          <button class="clear-btn" @click=${() => this.handleClear()} aria-label="Clear all logs">
            Clear
          </button>
        </div>
        <div class="logs-content">
          ${visibleLogs.length === 0
            ? html`<div class="logs-empty">No logs to display</div>`
            : html`
                <ul class="logs-list">
                  ${visibleLogs.map(log => {
                    const isExpanded = this.expandedLogs.has(log.id);
                    const hasDetails = !!log.data;
                    return html`
                      <li
                        class="log-entry ${log.level} ${hasDetails ? 'expandable' : ''} ${isExpanded
                          ? 'expanded'
                          : ''}"
                        @click=${hasDetails ? () => this.toggleLogExpansion(log.id) : undefined}
                      >
                        <div class="log-main">
                          <span class="log-chevron">
                            ${hasDetails
                              ? this.iconService.getIcon(
                                  isExpanded ? 'chevron-down' : 'chevron-right',
                                  IconSize.SMALL
                                )
                              : ''}
                          </span>
                          <span class="log-level">${log.level.toUpperCase()}</span>
                          ${log.source
                            ? html`<span class="log-source" title=${log.source}
                                >${log.source}</span
                              >`
                            : ''}
                          <span class="log-message">${log.message}</span>
                          <span class="log-timestamp">${this.formatTime(log.timestamp)}</span>
                          ${log.level === 'error'
                            ? html`<button
                                class="log-fix-btn"
                                title="Fix with Agent"
                                aria-label="Fix with Agent"
                                @click=${(event: Event) => this.handleFixWithAgent(log, event)}
                              >
                                ${this.iconService.getIcon('tool', IconSize.SMALL)}
                              </button>`
                            : ''}
                        </div>
                        ${hasDetails && isExpanded
                          ? html`<pre class="log-details">
${this.formatErrorDetails(log.data)}</pre
                            >`
                          : ''}
                      </li>
                    `;
                  })}
                </ul>
              `}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-logs-panel': LogsPanel;
  }
}
