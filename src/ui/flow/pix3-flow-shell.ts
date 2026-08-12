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

/** Chat/stage split: the chat needs room to read, the stage room to play. */
const MIN_CHAT_WIDTH = 300;
const MIN_STAGE_WIDTH = 360;
const DEFAULT_CHAT_WIDTH = 420;
const CHAT_WIDTH_KEY = 'pix3.flow.chatWidth:v1';

const loadChatWidth = (): number => {
  try {
    const raw = Number.parseInt(localStorage.getItem(CHAT_WIDTH_KEY) ?? '', 10);
    return Number.isFinite(raw) && raw >= MIN_CHAT_WIDTH ? raw : DEFAULT_CHAT_WIDTH;
  } catch {
    return DEFAULT_CHAT_WIDTH;
  }
};

const persistChatWidth = (width: number): void => {
  try {
    localStorage.setItem(CHAT_WIDTH_KEY, String(width));
  } catch {
    // A split that forgets itself is a small loss; never break the shell over storage.
  }
};

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

  private chatWidth = loadChatWidth();
  private stageHost?: HTMLElement;
  private stageFrame?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private disposeUi?: () => void;
  private disposeAgent?: () => void;
  private disposeProject?: () => void;
  /**
   * Project id whose stage was already auto-started. Not a boolean: a prompt builds a NEW project
   * while the previous one is still open, so a one-shot flag left the freshly generated game
   * sitting on a black stage.
   */
  private autoStartedProjectId: string | null = null;
  /** True while the last agent turn touched the game, so the stage is restarted when it settles. */
  private stageDirty = false;

  connectedCallback(): void {
    super.connectedCallback();

    this.disposeUi = subscribe(appState.ui, () => {
      this.isPlaying = appState.ui.isPlaying;
      this.stageError = appState.ui.playModeError?.message ?? null;
      this.fitStage();
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.disposeUi?.();
    this.disposeUi = undefined;
    this.disposeAgent?.();
    this.disposeAgent = undefined;
    this.disposeProject?.();
    this.disposeProject = undefined;
  }

  protected firstUpdated(): void {
    this.stageHost = this.querySelector<HTMLElement>('.flow-stage__host') ?? undefined;
    this.stageFrame = this.querySelector<HTMLElement>('.flow-stage__frame') ?? undefined;
    if (this.stageHost) {
      this.playSession.registerTabHost(this.stageHost, window);
    }
    if (this.stageFrame) {
      this.resizeObserver = new ResizeObserver(() => this.fitStage());
      this.resizeObserver.observe(this.stageFrame);
    }
    this.setChatWidth(this.chatWidth);
    this.fitStage();
    void this.onProjectChanged();
  }

  /**
   * Letterbox the stage to the game's own aspect ratio instead of stretching it to the panel.
   * A playable authored at 1080×1920 that is shown at 16:9 is not the game the user is making —
   * and the aspect the runtime renders at is what the exported HTML will use.
   */
  private fitStage(): void {
    const host = this.stageHost;
    const frame = this.stageFrame;
    if (!host || !frame) {
      return;
    }
    const styles = getComputedStyle(frame);
    const rect = frame.getBoundingClientRect();
    const available = {
      width: Math.max(
        0,
        rect.width -
          Number.parseFloat(styles.paddingLeft || '0') -
          Number.parseFloat(styles.paddingRight || '0')
      ),
      height: Math.max(
        0,
        rect.height -
          Number.parseFloat(styles.paddingTop || '0') -
          Number.parseFloat(styles.paddingBottom || '0')
      ),
    };
    if (available.width <= 0 || available.height <= 0) {
      return;
    }

    const target = this.resolveStageAspect();
    let width = available.width;
    let height = width / target;
    if (height > available.height) {
      height = available.height;
      width = height * target;
    }
    host.style.width = `${Math.floor(width)}px`;
    host.style.height = `${Math.floor(height)}px`;
  }

  /**
   * The aspect to fit: the project's own authored viewport, always.
   *
   * Deliberately NOT `appState.ui.gameAspectRatio` — that is a Studio affordance (the Game tab's
   * aspect picker) with no control anywhere in Flow, so a stale "16:9 landscape" left over from
   * some earlier session silently rendered a 1080×1920 game into a wide box: the field floated in
   * the middle and the anchored HUD flew off to the edges of a viewport the game was never
   * designed for. In Flow what you see is the shape the exported HTML will have.
   */
  private resolveStageAspect(): number {
    const base = appState.project.manifest?.viewportBaseSize;
    if (base && base.width > 0 && base.height > 0) {
      return base.width / base.height;
    }
    return 16 / 9;
  }

  private async onProjectChanged(): Promise<void> {
    if (appState.project.status !== 'ready') {
      return;
    }
    const projectId = appState.project.id;
    await this.refreshPlan();
    this.fitStage();
    if (projectId && this.autoStartedProjectId !== projectId) {
      this.autoStartedProjectId = projectId;
      // The stage is alive from the first frame the user sees — they poke their game while the
      // agent is still working on the first increment (design §3.2). Starting also loads the
      // project's main scene, which in Flow nothing else does (there are no tabs to open it).
      if (appState.ui.isPlaying) {
        await this.restartStage();
      } else {
        await this.startStage();
      }
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

  /** Drag the chat/stage divider. Width is persisted so the split survives a reload. */
  private readonly onSplitterDown = (event: PointerEvent): void => {
    const body = this.querySelector<HTMLElement>('.flow-body');
    if (!body) return;
    event.preventDefault();
    const bodyLeft = body.getBoundingClientRect().left;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => this.setChatWidth(move.clientX - bodyLeft);
    const onUp = (): void => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      persistChatWidth(this.chatWidth);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };

  private readonly onSplitterKey = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') {
      this.setChatWidth(this.chatWidth - step);
    } else if (event.key === 'ArrowRight') {
      this.setChatWidth(this.chatWidth + step);
    } else {
      return;
    }
    event.preventDefault();
    persistChatWidth(this.chatWidth);
  };

  private setChatWidth(width: number): void {
    const body = this.querySelector<HTMLElement>('.flow-body');
    const max = body ? body.getBoundingClientRect().width - MIN_STAGE_WIDTH : MIN_CHAT_WIDTH;
    this.chatWidth = Math.round(Math.min(Math.max(width, MIN_CHAT_WIDTH), Math.max(max, MIN_CHAT_WIDTH)));
    body?.style.setProperty('--flow-chat-width', `${this.chatWidth}px`);
    this.fitStage();
  }

  protected render() {
    return html`
      <div class="flow-shell">
        ${this.renderHeader()}
        <div class="flow-body">
          <aside class="flow-chat" aria-label="Flow chat">
            <pix3-agent-chat-panel></pix3-agent-chat-panel>
          </aside>
          <div
            class="flow-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat"
            tabindex="0"
            @pointerdown=${this.onSplitterDown}
            @keydown=${this.onSplitterKey}
          ></div>
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
