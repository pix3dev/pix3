import { dismissOnBackdropClick } from '@/ui/shared/backdrop-dismiss';
import { subscribe } from 'valtio/vanilla';
import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { appState } from '@/state';
import { IconService, IconSize } from '@/services/editor/IconService';
import { AgentKitService } from '@/services/project/agent-kit/AgentKitService';
import type { AgentHandoff } from '@/services/project/agent-kit/agent-handoff';
import './pix3-agent-handoff-dialog.ts.css';

const COPIED_RESET_MS = 1600;

/**
 * "Continue in your agent" (plan §1.1 step 3): shown after the editor wrote the agent kit into a
 * new or open project. Copyable commands to start Claude Code / Codex in the folder, the first
 * prompt, and what the live channel needs — said honestly for a local folder, where the agent
 * does not find the editor by itself yet (it needs `pix3 serve` + Connect to Workspace).
 */
@customElement('pix3-agent-handoff-dialog')
export class Pix3AgentHandoffDialog extends ComponentBase {
  @inject(AgentKitService)
  private readonly agentKitService!: AgentKitService;

  @inject(IconService)
  private readonly icons!: IconService;

  @property({ attribute: false })
  public handoff: AgentHandoff | null = null;

  @state() private copiedKey: string | null = null;
  @state() private agentAttached = false;

  private disposeWorkspace?: () => void;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.agentAttached = appState.project.workspace.agentAttached;
    this.disposeWorkspace = subscribe(appState.project.workspace, () => {
      this.agentAttached = appState.project.workspace.agentAttached;
    });
  }

  disconnectedCallback(): void {
    this.disposeWorkspace?.();
    this.disposeWorkspace = undefined;
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.querySelector<HTMLButtonElement>('.agent-handoff-btn--primary')?.focus();
  }

  protected render() {
    const handoff = this.handoff;
    if (!handoff) return null;
    return html`
      <div class="agent-handoff-backdrop" @click=${dismissOnBackdropClick(this.onClose)}>
        <div
          class="agent-handoff-content"
          role="dialog"
          aria-modal="true"
          aria-labelledby="agentHandoffTitle"
          @click=${(event: Event) => event.stopPropagation()}
          @keydown=${this.onKeyDown}
        >
          <h2 class="agent-handoff-title" id="agentHandoffTitle">
            <span class="agent-handoff-title__icon" aria-hidden="true"
              >${this.icons.getIcon('terminal', IconSize.MEDIUM)}</span
            >
            Continue in your agent
          </h2>
          ${this.renderKitSummary(handoff)}

          <section class="agent-handoff-section" aria-labelledby="agentHandoffStart">
            <h3 class="agent-handoff-section__title" id="agentHandoffStart">
              1. Start your agent in the project folder
            </h3>
            ${handoff.startCommands.map(command =>
              this.renderCommand(`start-${command.label}`, command.label, command.command)
            )}
          </section>

          <section class="agent-handoff-section" aria-labelledby="agentHandoffPrompt">
            <h3 class="agent-handoff-section__title" id="agentHandoffPrompt">
              2. Give it the first prompt
            </h3>
            ${this.renderCommand('prompt', null, handoff.firstPrompt, true)}
            <p class="agent-handoff-hint">${handoff.firstPromptSource}</p>
          </section>

          ${this.renderLiveChannel(handoff)}

          <div class="agent-handoff-actions">
            <button
              type="button"
              class="agent-handoff-btn agent-handoff-btn--primary"
              @click=${this.onClose}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderKitSummary(handoff: AgentHandoff) {
    const changed = handoff.kit.files.filter(
      file => file.action === 'written' || file.action === 'updated'
    ).length;
    const skipped = handoff.kit.files.filter(file => file.action === 'skipped-edited');
    const outdated = handoff.kit.files.filter(file => file.action === 'outdated');
    return html`
      <p class="agent-handoff-copy">
        Agent kit ${handoff.kit.version} is in <code>${handoff.folderName}</code>:
        ${changed === 0 ? 'already current' : `${changed} file${changed === 1 ? '' : 's'} written`}
        (AGENTS.md, CLAUDE.md,
        .claude/skills/pix3-*${handoff.kit.mcpCliVersion ? ', .mcp.json' : ''}).
        ${skipped.length > 0
          ? html`Left as you edited them: ${skipped.map(file => file.path).join(', ')}.`
          : null}
        ${outdated.length > 0
          ? html`From another kit version, unchanged: ${outdated.map(file => file.path).join(', ')}.`
          : null}
      </p>
      ${handoff.kit.instructions.map(
        line =>
          html`<div class="agent-handoff-notice" role="note">
            <span class="agent-handoff-notice__icon" aria-hidden="true"
              >${this.icons.getIcon('info', IconSize.SMALL)}</span
            >
            <span>${line}</span>
          </div>`
      )}
    `;
  }

  private renderLiveChannel(handoff: AgentHandoff) {
    const pinned = handoff.kit.mcpCliVersion;
    return html`
      <section class="agent-handoff-section" aria-labelledby="agentHandoffLive">
        <h3 class="agent-handoff-section__title" id="agentHandoffLive">Live channel</h3>
        <p class="agent-handoff-copy">
          The editor stays open. When the agent starts, it launches the pinned
          <code>pix3 mcp</code> server from the project's MCP config, and this editor shows
          <strong>Agent connected</strong>.
        </p>
        ${handoff.backend === 'workspace'
          ? html`<div
              class="agent-handoff-status ${this.agentAttached
                ? 'agent-handoff-status--connected'
                : ''}"
              role="status"
            >
              <span class="agent-handoff-status__icon" aria-hidden="true"
                >${this.icons.getIcon(this.agentAttached ? 'check' : 'radio', IconSize.SMALL)}</span
              >
              ${this.agentAttached ? 'Agent connected' : 'Waiting for the agent to start…'}
            </div>`
          : html`
              <p class="agent-handoff-copy">
                This project is a local folder, and the agent does not find a folder the editor
                opened directly yet. For the live channel, run this in the folder, then connect with
                File → Connect to Workspace… (address and token are printed):
              </p>
              ${handoff.serveCommand
                ? this.renderCommand('serve', null, handoff.serveCommand)
                : null}
              <p class="agent-handoff-hint">
                Without it the agent still works: it edits the files, and the editor picks them up.
              </p>
            `}
        ${pinned
          ? html`<p class="agent-handoff-hint">
              .mcp.json pins <code>@pix3/cli@${pinned}</code>${handoff.cli.kind === 'latest'
                ? ` (the latest published; this editor is ${handoff.editorVersion})`
                : ''}.
              Claude Code asks once to approve the pix3 server.
            </p>`
          : html`<div class="agent-handoff-notice agent-handoff-notice--warning" role="note">
              <span class="agent-handoff-notice__icon" aria-hidden="true"
                >${this.icons.getIcon('alert-triangle', IconSize.SMALL)}</span
              >
              <span>${handoff.mcpMissingReason}</span>
            </div>`}
        ${handoff.setupCommands.map(command =>
          this.renderCommand(`setup-${command.label}`, command.label, command.command)
        )}
      </section>
    `;
  }

  private renderCommand(key: string, label: string | null, text: string, multiline = false) {
    const copied = this.copiedKey === key;
    return html`
      <div class="agent-handoff-command">
        ${label ? html`<span class="agent-handoff-command__label">${label}</span>` : null}
        <div class="agent-handoff-command__row">
          <code
            class="agent-handoff-command__text ${multiline
              ? 'agent-handoff-command__text--multiline'
              : ''}"
            >${text}</code
          >
          <button
            type="button"
            class="agent-handoff-copy-btn ${copied ? 'agent-handoff-copy-btn--copied' : ''}"
            title=${copied ? 'Copied' : 'Copy to clipboard'}
            aria-label=${copied ? 'Copied' : `Copy ${label ?? 'text'}`}
            @click=${() => void this.copy(key, text)}
          >
            ${this.icons.getIcon(copied ? 'check' : 'copy', IconSize.SMALL)}
            <span>${copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
    `;
  }

  private async copy(key: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.warn('[AgentHandoff] Clipboard write failed:', error);
      return;
    }
    this.copiedKey = key;
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.copiedKey = null;
      this.copiedTimer = null;
    }, COPIED_RESET_MS);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.onClose();
    }
  };

  private onClose = (): void => {
    this.agentKitService.close();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-agent-handoff-dialog': Pix3AgentHandoffDialog;
  }
}
