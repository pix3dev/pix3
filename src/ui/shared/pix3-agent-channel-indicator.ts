import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { IconService, IconSize } from '@/services/editor/IconService';
import {
  GENERATE_SESSION_LIMIT,
  WorkspaceAgentToolBridge,
  type AgentChannelState,
} from '@/services/project/workspace/WorkspaceAgentToolBridge';
import './pix3-agent-channel-indicator.ts.css';

/**
 * Status-bar pill of the live agent channel (`pix3 mcp --workspace` → `pix3 serve` → this window):
 * "Agent: idle / syncing / running game_run / off", a revoke button while generation is allowed,
 * and the non-blocking "allow generation for this session" prompt (plan §1.2 "Граница доверия").
 * Shown only for a workspace project once an agent call has arrived in this server session.
 */
@customElement('pix3-agent-channel-indicator')
export class AgentChannelIndicator extends ComponentBase {
  @inject(WorkspaceAgentToolBridge)
  private readonly bridge!: WorkspaceAgentToolBridge;

  @inject(IconService)
  private readonly icons!: IconService;

  @state() private channel: AgentChannelState | null = null;
  @state() private isWorkspace = false;

  private disposeBridge?: () => void;
  private disposeProject?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.channel = this.bridge.getState();
    this.disposeBridge = this.bridge.subscribe(() => {
      this.channel = this.bridge.getState();
    });
    this.isWorkspace = this.computeIsWorkspace();
    this.disposeProject = subscribe(appState.project, () => {
      this.isWorkspace = this.computeIsWorkspace();
    });
  }

  disconnectedCallback(): void {
    this.disposeBridge?.();
    this.disposeBridge = undefined;
    this.disposeProject?.();
    this.disposeProject = undefined;
    super.disconnectedCallback();
  }

  private computeIsWorkspace(): boolean {
    return appState.project.backend === 'workspace' && appState.project.status === 'ready';
  }

  protected render() {
    const channel = this.channel;
    if (!channel || !this.isWorkspace || !channel.seen) {
      return html``;
    }
    const who = channel.agentName
      ? `${channel.agentName} (self-declared, not verified)`
      : 'an agent';
    let tone = 'is-ok';
    let icon = 'terminal';
    let label = 'Agent: idle';
    let title = `pix3 mcp for ${who} is connected through pix3 serve.\nClick to disconnect it.`;
    if (!channel.enabled) {
      tone = 'is-off';
      icon = 'slash';
      label = 'Agent: off';
      title = `You disconnected the agent channel; ${who} gets errors.\nClick to connect it again.`;
    } else if (channel.activity === 'syncing') {
      tone = 'is-busy';
      icon = 'refresh-cw';
      label = 'Agent: syncing';
      title = `${who} is syncing the editor with the disk before a run.\nClick to disconnect.`;
    } else if (channel.activity === 'running') {
      tone = 'is-pending';
      label = `Agent: ${channel.activeTool ?? 'running'}`;
      title = `${who} is running ${channel.activeTool ?? 'a tool'}.\nClick to disconnect.`;
    }
    return html`
      <button
        type="button"
        class="status-indicator status-sync status-agent-channel ${tone}"
        title=${title}
        aria-label=${label}
        @click=${this.onToggle}
      >
        ${this.icons.getIcon(icon, IconSize.SMALL)}
        <span class="status-sync-label">${label}</span>
      </button>
      ${channel.permission === 'allowed'
        ? html`<button
            type="button"
            class="status-indicator status-sync agent-channel-revoke"
            title=${`Asset generation allowed for this agent session (${channel.generationsUsed}/${GENERATE_SESSION_LIMIT}). Click to revoke.`}
            aria-label="Revoke asset generation permission"
            @click=${this.onRevoke}
          >
            ${this.icons.getIcon('key', IconSize.SMALL)}
            <span class="status-sync-label"
              >${channel.generationsUsed}/${GENERATE_SESSION_LIMIT}</span
            >
          </button>`
        : html``}
      ${channel.prompt ? this.renderPrompt(channel) : html``}
    `;
  }

  private renderPrompt(channel: AgentChannelState) {
    const prompt = channel.prompt;
    if (!prompt) return html``;
    const root = prompt.root ?? appState.project.projectName ?? 'this project';
    const who = prompt.agentName
      ? html`(calls itself: <strong>${prompt.agentName}</strong>, not verified)`
      : html`(did not say who it is)`;
    return html`
      <div class="agent-permission" role="alertdialog" aria-labelledby="agent-permission-text">
        <span class="agent-permission__icon">${this.icons.getIcon('key', IconSize.MEDIUM)}</span>
        <p class="agent-permission__text" id="agent-permission-text">
          Process <code>pix3 mcp</code> ${who} in <code>${root}</code> wants to generate assets with
          your editor keys (<code>${prompt.tool}</code>). Up to ${GENERATE_SESSION_LIMIT}
          generations, then it asks again.
        </p>
        <div class="agent-permission__actions">
          <button
            type="button"
            class="agent-permission__btn agent-permission__btn--primary"
            @click=${this.onAllow}
          >
            ${this.icons.getIcon('check', IconSize.SMALL)}<span>Allow for this session</span>
          </button>
          <button type="button" class="agent-permission__btn" @click=${this.onDeny}>
            ${this.icons.getIcon('x', IconSize.SMALL)}<span>Deny</span>
          </button>
        </div>
      </div>
    `;
  }

  private onToggle = (): void => {
    this.bridge.setEnabled(!this.bridge.getState().enabled);
  };

  private onRevoke = (): void => {
    this.bridge.revokeGeneration();
  };

  private onAllow = (): void => {
    this.bridge.decide('allow');
  };

  private onDeny = (): void => {
    this.bridge.decide('deny');
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-agent-channel-indicator': AgentChannelIndicator;
  }
}
