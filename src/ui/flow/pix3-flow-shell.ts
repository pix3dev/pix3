import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { AgentChatService, type AgentChatState } from '@/services/agent/AgentChatService';
import { FlowPlanService, type FlowPlan, type FlowPlanStep } from '@/services/flow/FlowPlanService';
import '@/ui/agent-chat/pix3-agent-chat-panel';
import './pix3-flow-shell.ts.css';

const EMPTY_PLAN: FlowPlan = { pitch: null, title: null, steps: [] };

/**
 * The Flow workspace: chat on the left, a live game stage on the right, one header of actions —
 * and nothing else. No docks, no tabs, no file tree (design §4).
 *
 * Two properties of this shell carry the product promise and are easy to break:
 *  - **The stage never goes dark.** The runtime is mounted through the ordinary
 *    `GamePlaySessionService.registerTabHost` host (the same one the Game tab uses, so no new
 *    infrastructure), play starts as soon as a project is ready, and an agent turn that changed the
 *    game restarts it in place — hundreds of milliseconds inside an already-loaded runtime, never a
 *    build.
 *  - **HTML is built only on demand.** Download HTML is the one affordance here that runs
 *    `PlayableHtmlBuildService`; every iteration before it plays in the loaded runtime (design §2).
 */
@customElement('pix3-flow-shell')
export class Pix3FlowShell extends ComponentBase {
  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  @inject(FlowPlanService)
  private readonly planService!: FlowPlanService;

  @state()
  private plan: FlowPlan = EMPTY_PLAN;

  @state()
  private isPlaying = appState.ui.isPlaying;

  @state()
  private isAgentRunning = false;

  @state()
  private activeTool: string | null = null;

  @state()
  private stageError: string | null = null;

  private stageHost?: HTMLElement;
  private disposeUi?: () => void;
  private disposeAgent?: () => void;
  private disposeProject?: () => void;
  private autoStarted = false;
  /** True while the last agent turn touched the game, so the stage is restarted when it settles. */
  private stageDirty = false;

  connectedCallback(): void {
    super.connectedCallback();

    this.disposeUi = subscribe(appState.ui, () => {
      this.isPlaying = appState.ui.isPlaying;
      this.stageError = appState.ui.playModeError?.message ?? null;
    });

    this.disposeProject = subscribe(appState.project, () => {
      void this.onProjectChanged();
    });

    this.disposeAgent = this.agentChat.subscribe(state => this.onAgentState(state));

    void this.refreshPlan();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.stageHost) {
      this.playSession.unregisterTabHost(this.stageHost);
      this.stageHost = undefined;
    }
    this.disposeUi?.();
    this.disposeUi = undefined;
    this.disposeAgent?.();
    this.disposeAgent = undefined;
    this.disposeProject?.();
    this.disposeProject = undefined;
  }

  protected firstUpdated(): void {
    this.stageHost = this.querySelector<HTMLElement>('.flow-stage__host') ?? undefined;
    if (this.stageHost) {
      this.playSession.registerTabHost(this.stageHost, window);
    }
    void this.onProjectChanged();
  }

  private async onProjectChanged(): Promise<void> {
    if (appState.project.status !== 'ready') {
      this.autoStarted = false;
      return;
    }
    await this.refreshPlan();
    if (!this.autoStarted && !appState.ui.isPlaying) {
      this.autoStarted = true;
      // The stage is alive from the first frame the user sees — they poke their game while the
      // agent is still working on the first increment (design §3.2).
      await this.startStage();
    }
  }

  private onAgentState(state: AgentChatState): void {
    const wasRunning = this.isAgentRunning;
    this.isAgentRunning = state.status === 'running';
    this.activeTool = state.activeTool;
    if (state.activeTool && GAME_TOUCHING_TOOLS.has(state.activeTool)) {
      this.stageDirty = true;
    }
    if (wasRunning && !this.isAgentRunning) {
      // A finished increment lands on the stage without the user asking: re-read the checklist and
      // restart the running game so what they poke is what the agent just built.
      void this.refreshPlan();
      if (this.stageDirty) {
        this.stageDirty = false;
        void this.restartStage();
      }
    }
  }

  private async refreshPlan(): Promise<void> {
    if (appState.project.status !== 'ready') {
      this.plan = EMPTY_PLAN;
      return;
    }
    this.plan = await this.planService.load();
  }

  private async startStage(): Promise<void> {
    try {
      await this.commandDispatcher.executeById('game.start-main');
    } catch (error) {
      this.stageError = error instanceof Error ? error.message : String(error);
    }
  }

  private async restartStage(): Promise<void> {
    if (!appState.ui.isPlaying) {
      await this.startStage();
      return;
    }
    try {
      await this.commandDispatcher.executeById('game.restart');
    } catch (error) {
      this.stageError = error instanceof Error ? error.message : String(error);
    }
  }

  protected render() {
    return html`
      <div class="flow-shell">
        ${this.renderHeader()}
        <div class="flow-body">
          <aside class="flow-chat" aria-label="Flow chat">
            <pix3-agent-chat-panel></pix3-agent-chat-panel>
          </aside>
          <main class="flow-stage" aria-label="Game stage">
            <div class="flow-stage__frame">
              <div class="flow-stage__host"></div>
              ${this.renderStageOverlay()}
            </div>
            ${this.renderStageBar()}
          </main>
        </div>
      </div>
    `;
  }

  private renderHeader() {
    const title = this.plan.title ?? appState.project.projectName ?? 'Untitled game';
    return html`
      <header class="flow-header">
        <div class="flow-header__identity">
          <span class="flow-header__title" title=${title}>${title}</span>
          ${this.plan.pitch
            ? html`<span class="flow-header__pitch" title=${this.plan.pitch}
                >${this.plan.pitch}</span
              >`
            : null}
        </div>
        ${this.renderPlanTracker()}
        <div class="flow-header__actions">
          <button
            class="flow-action"
            type="button"
            title="Play this build on a phone over the local network"
            @click=${() => void this.commandDispatcher.executeById('project.start-remote-preview')}
          >
            ${this.icons.getIcon('smartphone', IconSize.SMALL)}<span>Device</span>
          </button>
          <button
            class="flow-action"
            type="button"
            title="Build a single self-contained HTML file of the game"
            @click=${() => void this.commandDispatcher.executeById('project.export-playable-html')}
          >
            ${this.icons.getIcon('download', IconSize.SMALL)}<span>Download HTML</span>
          </button>
          <button
            class="flow-action flow-action--ghost"
            type="button"
            title="Open the same project in the full editor"
            @click=${() => void this.commandDispatcher.executeById('editor.switch-workspace-mode')}
          >
            ${this.icons.getIcon('sliders', IconSize.SMALL)}<span>Open in Studio</span>
          </button>
        </div>
      </header>
    `;
  }

  private renderPlanTracker() {
    if (this.plan.steps.length === 0) {
      return html`<div class="flow-plan flow-plan--empty">
        ${this.isAgentRunning
          ? html`<span class="flow-plan__spinner"></span><span>Working…</span>`
          : null}
      </div>`;
    }
    return html`
      <div class="flow-plan" role="list" aria-label="Plan">
        ${this.plan.steps.map(step => this.renderPlanStep(step))}
      </div>
    `;
  }

  private renderPlanStep(step: FlowPlanStep) {
    const icon =
      step.status === 'done' ? 'check-circle' : step.status === 'active' ? 'loader' : 'circle';
    return html`
      <span
        class="flow-plan__step flow-plan__step--${step.status}"
        role="listitem"
        title=${step.note ?? step.title}
      >
        ${this.icons.getIcon(icon, IconSize.SMALL)}<span class="flow-plan__label">${step.title}</span>
      </span>
    `;
  }

  private renderStageBar() {
    const toolLabel = this.activeTool ? this.activeTool.replace(/_/g, ' ') : null;
    return html`
      <div class="flow-stage__bar">
        <button
          class="flow-stage__button"
          type="button"
          title=${this.isPlaying ? 'Stop' : 'Play'}
          @click=${() =>
            void this.commandDispatcher.executeById(this.isPlaying ? 'game.stop' : 'game.start-main')}
        >
          ${this.icons.getIcon(this.isPlaying ? 'square' : 'play', IconSize.SMALL)}
        </button>
        <button
          class="flow-stage__button"
          type="button"
          title="Restart"
          @click=${() => void this.restartStage()}
        >
          ${this.icons.getIcon('rotate-ccw', IconSize.SMALL)}
        </button>
        <span class="flow-stage__status">
          ${this.isAgentRunning && toolLabel
            ? html`<span class="flow-plan__spinner"></span><span>${toolLabel}</span>`
            : this.isPlaying
              ? html`<span>Live</span>`
              : html`<span>Stopped</span>`}
        </span>
      </div>
    `;
  }

  private renderStageOverlay() {
    if (this.stageError) {
      return html`
        <div class="flow-stage__overlay flow-stage__overlay--error" role="alert">
          <span>${this.stageError}</span>
          <button class="flow-action" type="button" @click=${() => void this.restartStage()}>
            Restart
          </button>
        </div>
      `;
    }
    if (appState.project.status !== 'ready') {
      return html`<div class="flow-stage__overlay"><span>Preparing your project…</span></div>`;
    }
    return null;
  }
}

/**
 * Tool names whose success means the running game is out of date. Restarting after every turn
 * would fight the user mid-play, and never restarting leaves them poking a stale build — so the
 * stage refreshes only when the turn actually touched the game.
 */
const GAME_TOUCHING_TOOLS = new Set([
  'fs_write',
  'str_replace',
  'create_node',
  'set_property',
  'add_component',
  'set_component_property',
  'remove_component',
  'move_node',
  'convert_node_type',
  'compile_scripts',
  'queue_asset',
]);

declare global {
  interface HTMLElementTagNameMap {
    'pix3-flow-shell': Pix3FlowShell;
  }
}
