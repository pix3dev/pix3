import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { DialogService } from '@/services/editor/DialogService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { AgentChatService, type AgentChatState } from '@/services/agent/AgentChatService';
import { FlowPlanService, type FlowPlan } from '@/services/flow/FlowPlanService';
import { FlowStageService, type FlowStage } from '@/services/flow/FlowStageService';
import {
  PrototypeBootstrapService,
  type PrototypeBootstrapPhase,
} from '@/services/flow/PrototypeBootstrapService';
import '@/ui/agent-chat/pix3-agent-chat-panel';
import '@/ui/shared/pix3-mode-switch';
import './pix3-flow-side-panel';
import './pix3-idea-doc';
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
 * The one place in this shell that names the entry-scene play command.
 *
 * It exists as a constant so the guard in `pix3-flow-shell.spec.ts` can state the invariant
 * precisely: the stage's *automatic* launch is gameplay (`game.start`), and the entry scene is
 * reachable only through the explicitly-labelled secondary action a person clicks. A bare literal
 * would make "does this file mention `game.start-main`?" unable to tell those two apart.
 */
const ENTRY_SCENE_PLAY_COMMAND = 'game.start-main';

/** How many times a stage launch is attempted before the failure reaches the user. */
const STAGE_START_ATTEMPTS = 4;
/** Gap between those attempts — long enough for a project to finish settling, short enough to feel instant. */
const STAGE_START_RETRY_MS = 500;

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

  @inject(FlowStageService)
  private readonly stageService!: FlowStageService;

  @inject(PrototypeBootstrapService)
  private readonly bootstrap!: PrototypeBootstrapService;

  @inject(DialogService)
  private readonly dialogs!: DialogService;

  @state()
  private plan: FlowPlan = EMPTY_PLAN;

  /**
   * Which stage the open project is in. Re-read on every project change so reopening a project
   * lands back in the stage it was left in (design §2.6) — and so a transition, when it ships,
   * flips this shell without recreating it.
   */
  @state()
  private stage: FlowStage = 'prototype';

  @state()
  private isPlaying = appState.ui.isPlaying;

  @state()
  private isAgentRunning = false;

  @state()
  private activeTool: string | null = null;

  @state()
  private stageError: string | null = null;

  /**
   * Whether the project declares an entry scene, which is what makes "play from the entry scene" a
   * *different* run from the stage's normal one. Without one, `game.start-main` degrades to playing
   * the active scene — the same thing the Play button already does — so the secondary action is
   * hidden rather than offered as a button that silently does nothing new.
   */
  @state()
  private hasEntryScene = false;

  /**
   * Which half of the prototype stage is on screen (design §2.5). The game is the default: the
   * document is where the project came from, the game is what the user is now iterating on.
   */
  @state()
  private stageView: StageView = 'game';

  /** Phase of a transition this shell started, mirrored from the bootstrap status stream. */
  @state()
  private transitionPhase: PrototypeBootstrapPhase | null = null;

  @state()
  private transitionError: string | null = null;

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
  /**
   * A game that was already running when this shell was created — i.e. the user switched over from
   * Studio mid-play. The session is handed to this stage live (the canvas is re-parented, see
   * `GamePlaySessionService.handOffLiveGame`), so the auto-start below must adopt it instead of
   * restarting: a restart here threw away the score, the level and the wave the user was watching.
   */
  private readonly adoptedRunningSession = appState.ui.isPlaying;
  /** True while the last agent turn touched the game, so the stage is restarted when it settles. */
  private stageDirty = false;
  private disposeBootstrap?: () => void;
  /**
   * The document is mounted lazily and then kept mounted for the rest of the session: the first
   * switch to Idea pays for the file read and the blob URLs, every switch after it is free — and
   * an unmount/remount cycle would throw away the scroll position and a half-typed source edit.
   */
  private ideaDocMounted = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.stage = this.stageService.getStage();

    this.disposeUi = subscribe(appState.ui, () => {
      this.isPlaying = appState.ui.isPlaying;
      this.stageError = appState.ui.playModeError?.message ?? null;
      this.fitStage();
    });

    this.disposeProject = subscribe(appState.project, () => {
      void this.onProjectChanged();
    });

    this.disposeAgent = this.agentChat.subscribe(state => this.onAgentState(state));

    // Narrating the transition is the whole reason this shell reads the status stream: the pipeline
    // it kicks off takes ~10 s, and principle 6 forbids spending them behind a modal.
    this.disposeBootstrap = this.bootstrap.subscribe(status => {
      if (this.transitionPhase === null) {
        // Not our run: a status left over from the welcome screen's own bootstrap must not paint a
        // banner over a project that is already open.
        return;
      }
      this.transitionPhase = status.phase;
      if (status.phase === 'error') {
        this.transitionError = status.error ?? status.message;
      }
    });

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
    this.disposeBootstrap?.();
    this.disposeBootstrap = undefined;
  }

  protected firstUpdated(): void {
    this.syncStageHost();
    this.setChatWidth(this.chatWidth);
    this.fitStage();
    void this.onProjectChanged();
  }

  protected updated(): void {
    // The stage exists in the DOM only at the prototype stage, and the stage can flip under this
    // shell (reopening a project, and later the transition), so the runtime host is attached and
    // detached from here rather than once in firstUpdated.
    this.syncStageHost();
  }

  /**
   * Mount the runtime into the stage host when there is one, and let go of it when there is not.
   *
   * At the idea stage `registerTabHost` is never called at all: the runtime is not mounted, no
   * scene is loaded and nothing ticks (design §3.2). That is the point of the stage — the tokens
   * and the seconds go into text and pictures, not into an engine nobody is looking at.
   */
  private syncStageHost(): void {
    const host = this.querySelector<HTMLElement>('.flow-stage__host') ?? undefined;
    if (host !== this.stageHost) {
      if (this.stageHost) {
        this.playSession.unregisterTabHost(this.stageHost);
      }
      this.stageHost = host;
      if (host) {
        this.playSession.registerTabHost(host, window);
      }
    }

    const frame = this.querySelector<HTMLElement>('.flow-stage__frame') ?? undefined;
    if (frame === this.stageFrame) {
      return;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.stageFrame = frame;
    if (frame) {
      this.resizeObserver = new ResizeObserver(() => this.fitStage());
      this.resizeObserver.observe(frame);
    }
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
      // The previous project's answer must not outlive it: the entry-scene action is offered per
      // project, and a stale `true` would offer it for one that has none.
      this.hasEntryScene = false;
      return;
    }
    const projectId = appState.project.id;
    // Read on every project change, not once: a project closed at the idea stage has to reopen
    // into it (design §2.6), and the manifest is what remembers that.
    this.stage = this.stageService.getStage();
    this.hasEntryScene = (appState.project.manifest?.defaultExportScenePath?.trim() ?? '') !== '';
    await this.refreshPlan();
    this.fitStage();
    if (this.stage === 'idea') {
      // No stage to start, and nothing to auto-start it for. Deliberately not marking the project
      // as auto-started either — the transition to the prototype has to be free to start it.
      return;
    }
    if (projectId && this.autoStartedProjectId !== projectId) {
      const isFirstObservation = this.autoStartedProjectId === null;
      this.autoStartedProjectId = projectId;
      if (isFirstObservation && this.adoptedRunningSession && appState.ui.isPlaying) {
        // The stage is already alive: it came over from Studio with the mode switch.
        return;
      }
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
      // At the idea stage the agent's writes are documents; the doc component re-reads them itself,
      // and there is no game to restart.
      if (this.stageDirty && this.stage !== 'idea') {
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

  /**
   * Launch the stage, retrying a few times before showing the user a failure.
   *
   * `game.start` (the active scene), never `game.start-main` (the project's entry scene). On every
   * recipe project the entry scene is the MENU, and a Flow project has no active scene when the
   * stage first launches — so dispatching the entry-scene command here used to make the menu both
   * what the user watched and, because `appState.scenes.activeSceneId` is the editing surface, what
   * every subsequent agent edit landed in. `game.start` opens `scenes/main.pix3scene` itself when
   * nothing is active (see `resolveGameplayScenePath`), so the stage boots on gameplay.
   *
   * The first launch races project bootstrap: scripts are still compiling, the manifest is still
   * landing, and the project can briefly leave `ready` — any of which makes the scene load blocked
   * (a blocked command is a `false` return, not a throw) and hands the user a red error where their
   * game should be. The race is transient by nature, so a bounded retry is the honest fix; what is
   * NOT acceptable is the silent version, where play mode flips on with no scene and the stage stays
   * black for the rest of the session.
   */
  private async startStage(attempt = 0): Promise<void> {
    let failure: string | null = null;
    try {
      if (await this.commandDispatcher.executeById('game.start')) {
        return;
      }
      failure = 'The game could not be started.';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    if (attempt + 1 < STAGE_START_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, STAGE_START_RETRY_MS));
      await this.startStage(attempt + 1);
      return;
    }
    // Someone else won the race and the game is up (the agent's own `play_start`, a restart after a
    // turn): there is nothing to report, and a banner over a running game is worse than silence.
    if (appState.ui.isPlaying && !appState.ui.playModeError) {
      return;
    }
    this.stageError = failure;
  }

  /**
   * The full run: start at the project's entry scene (its menu) instead of the gameplay scene.
   *
   * Deliberately a **person-initiated** action and nothing else. The menu→game transition is a real
   * thing to check inside Vibe, but it costs the editor's active scene — `game.start-main` moves it,
   * and the active scene is simultaneously what plays, what the viewport shows and what the agent
   * edits. That is a fine price for a click, and not one to pay behind the user's back on every
   * stage launch (see `startStage`).
   */
  private async startFromEntryScene(): Promise<void> {
    this.stageError = null;
    try {
      // The stage auto-starts on mount, so this button is almost always clicked while a game
      // is already running — and the play commands refuse to start a second one. Stopping
      // first is what the click means: "run it again, from the top."
      if (appState.ui.isPlaying) {
        await this.commandDispatcher.executeById('game.stop');
      }
      if (!(await this.commandDispatcher.executeById(ENTRY_SCENE_PLAY_COMMAND))) {
        this.stageError = 'The entry scene could not be started.';
      }
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
    // The sidebar sits in the same row, so its width is not available to the chat/stage split —
    // measured rather than assumed, since it is a rail when collapsed and a panel when open.
    const planWidth =
      this.querySelector<HTMLElement>('pix3-flow-side-panel')?.getBoundingClientRect().width ?? 0;
    const max = body
      ? body.getBoundingClientRect().width - MIN_STAGE_WIDTH - planWidth
      : MIN_CHAT_WIDTH;
    this.chatWidth = Math.round(
      Math.min(Math.max(width, MIN_CHAT_WIDTH), Math.max(max, MIN_CHAT_WIDTH))
    );
    body?.style.setProperty('--flow-chat-width', `${this.chatWidth}px`);
    this.fitStage();
  }

  protected render() {
    const isIdea = this.stage === 'idea';
    return html`
      <div class="flow-shell">
        ${this.renderHeader()} ${this.renderTransitionBanner()}
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
          ${isIdea ? this.renderIdeaDoc() : this.renderPrototypeView()} ${this.renderSidePanel()}
        </div>
      </div>
    `;
  }

  /**
   * The prototype stage: the game and the design document in the same column, with a segmented
   * switch over them (design §2.5).
   *
   * **The stage is hidden, never unmounted.** `.flow-stage__host` is the element the runtime is
   * registered against, so taking it out of the DOM would make `syncStageHost` unregister the host
   * and kill the session — the user would come back from the Idea tab to a fresh game with their
   * score gone. Hiding it costs a game that keeps ticking into an invisible canvas, which is the
   * cheaper wrong thing by far: it is what makes coming back show the SAME session.
   */
  private renderPrototypeView() {
    const showDoc = this.stageView === 'idea';
    return html`
      <div class="flow-view">
        ${this.renderViewSwitch()} ${this.renderStage(showDoc)}
        ${this.ideaDocMounted ? this.renderIdeaDoc(!showDoc) : null}
      </div>
    `;
  }

  private renderViewSwitch() {
    return html`
      <div class="flow-view__switch" role="group" aria-label="Prototype view">
        ${this.renderViewOption('game', 'Game', 'gamepad', 'the live game')}
        <span class="flow-view__divider" aria-hidden="true"></span>
        ${this.renderViewOption('idea', 'Idea', 'file-text', 'the design document')}
      </div>
    `;
  }

  private renderViewOption(view: StageView, label: string, icon: string, hint: string) {
    const isCurrent = this.stageView === view;
    return html`
      <button
        class="flow-view__option"
        type="button"
        data-view=${view}
        data-current=${isCurrent ? 'true' : 'false'}
        aria-pressed=${isCurrent}
        title=${isCurrent ? `Showing ${hint}` : `Show ${hint}`}
        @click=${() => this.selectView(view)}
      >
        ${this.icons.getIcon(icon, IconSize.SMALL)}<span class="flow-view__label">${label}</span>
      </button>
    `;
  }

  private selectView(view: StageView): void {
    if (this.stageView === view) {
      return;
    }
    if (view === 'idea') {
      this.ideaDocMounted = true;
    }
    this.stageView = view;
    // Coming back to the game re-shows an element that was `display: none`, so its frame has to be
    // re-measured — the letterbox was computed against a collapsed box while it was hidden.
    void this.updateComplete.then(() => this.fitStage());
  }

  private renderStage(hidden = false) {
    return html`
      <main class="flow-stage" aria-label="Game stage" ?hidden=${hidden}>
        <div class="flow-stage__frame">
          <div class="flow-stage__host"></div>
          ${this.renderStageOverlay()}
        </div>
        ${this.renderStageBar()}
      </main>
    `;
  }

  /**
   * The design document. At the idea stage it stands in for the game stage — no Play/Restart bar,
   * because there is nothing to play, and the sidebar beside it shows only its Files tab, since
   * `design/progress.md` is written by the recipe expander and a greyed-out Plan tab would
   * advertise an affordance with no meaning yet.
   *
   * After the transition the SAME element is what the Idea half of the switch shows: the brief does
   * not die when the recipe is expanded, it becomes the tab that is always there (design §2.5).
   */
  private renderIdeaDoc(hidden = false) {
    return html`
      <main class="flow-doc" aria-label="Design document" ?hidden=${hidden}>
        <pix3-idea-doc doc-path="design/gdd.md"></pix3-idea-doc>
      </main>
    `;
  }

  private renderHeader() {
    const title = this.plan.title ?? appState.project.projectName ?? 'Untitled game';
    return html`
      <header class="flow-header">
        <div class="flow-header__lead">
          <button
            class="flow-logo"
            type="button"
            title="Close project and return to the welcome screen"
            aria-label="Close project"
            @click=${() => void this.commandDispatcher.executeById('project.close')}
          >
            <img src="/menu-logo.png" alt="Pix3" class="flow-logo__img" />
          </button>
        </div>
        <div class="flow-header__identity">
          <span class="flow-header__title" title=${title}>${title}</span>
          <pix3-mode-switch></pix3-mode-switch>
        </div>
        <div class="flow-header__actions">${this.renderHeaderActions()}</div>
      </header>
    `;
  }

  /**
   * Device and Download HTML are prototype-stage actions: at the idea stage there is no build to
   * put on a phone or into a file, and offering either would be offering an empty canvas as a game.
   * What replaces them is the one action that stage has — the way out of it.
   */
  private renderHeaderActions() {
    if (this.stage === 'idea') {
      const busy = this.transitionPhase !== null;
      return html`
        <button
          class="flow-action flow-action--cta"
          type="button"
          ?disabled=${busy}
          title="Expand a genre recipe into this project and start playing it"
          @click=${() => void this.onStartPrototype()}
        >
          ${busy
            ? html`<span class="flow-plan__spinner" aria-hidden="true"></span>`
            : this.icons.getIcon('arrow-right', IconSize.SMALL)}<span
            >${busy ? 'Starting…' : 'Start prototype'}</span
          >
        </button>
      `;
    }
    return html`
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
    `;
  }

  /**
   * The right sidebar: the increment checklist and the project's file list, in one tabbed column.
   *
   * Rendered at BOTH stages, which is the change V3 makes: the idea stage used to have no sidebar
   * at all because a plan does not exist there, but the file list does — references are most of what
   * that stage produces. The panel itself hides the Plan tab when the stage has no plan.
   */
  private renderSidePanel() {
    return html`
      <pix3-flow-side-panel
        .stage=${this.stage}
        .plan=${this.plan}
        .agentRunning=${this.isAgentRunning}
        .activeTool=${this.activeTool}
        @panel-resize=${this.onPanelResize}
      ></pix3-flow-side-panel>
    `;
  }

  /**
   * The transition's one line of narration, above the document the user is reading.
   *
   * It sits in the shell rather than inside the document column on purpose: the pipeline replaces
   * what is IN that column (the document gives way to a game stage), and a banner that dies with
   * its host is a banner that vanishes mid-sentence.
   */
  private renderTransitionBanner() {
    if (this.transitionError) {
      return html`
        <div class="flow-transition flow-transition--error" role="alert">
          ${this.icons.getIcon('alert-triangle', IconSize.SMALL)}
          <span class="flow-transition__text">${this.transitionError}</span>
          <button class="flow-action" type="button" @click=${() => void this.runTransition()}>
            Try again
          </button>
          <button
            class="flow-action flow-action--ghost"
            type="button"
            @click=${this.dismissTransitionError}
          >
            Dismiss
          </button>
        </div>
      `;
    }
    if (this.transitionPhase === null) {
      return null;
    }
    return html`
      <div class="flow-transition" role="status">
        <span class="flow-plan__spinner" aria-hidden="true"></span>
        <span class="flow-transition__text">${TRANSITION_LABELS[this.transitionPhase]}</span>
      </div>
    `;
  }

  private readonly dismissTransitionError = (): void => {
    this.transitionError = null;
    // The service keeps its `error` status until someone clears it, and a stale error there would
    // re-paint this banner the next time the stream fires.
    this.bootstrap.reset();
  };

  /**
   * The one forward step of the idea stage. Confirmed first because it is structurally one-way:
   * the recipe cannot be folded back up (design §2.5), so the user is told what survives it.
   */
  private async onStartPrototype(): Promise<void> {
    if (this.transitionPhase !== null) {
      return;
    }
    const confirmed = await this.dialogs.showConfirmation({
      title: 'Start the prototype?',
      message:
        'A genre recipe will be expanded into this project — scenes, scripts and a playable build. ' +
        'Your brief and references stay exactly where they are and remain available on the Idea tab.',
      confirmLabel: 'Start prototype',
      cancelLabel: 'Keep working on the idea',
    });
    if (!confirmed) {
      return;
    }
    await this.runTransition();
  }

  /**
   * Run the transition without asking again — the CTA asks once, and the retry after a failure is
   * the same answer being acted on a second time.
   */
  private async runTransition(): Promise<void> {
    if (this.transitionPhase !== null) {
      return;
    }
    this.transitionError = null;
    // Set before the call, not from the stream: this doubles as the "the run is ours" flag the
    // status listener checks, and the first status can land before the await resumes.
    this.transitionPhase = 'planning';
    try {
      await this.bootstrap.startPrototype();
      this.transitionPhase = null;
      // The stage is read back from the manifest rather than assumed: if the transition stopped
      // short of writing it, this shell stays on the idea stage instead of showing an empty game.
      this.stageView = 'game';
      await this.onProjectChanged();
    } catch (error) {
      this.transitionPhase = null;
      this.transitionError = error instanceof Error ? error.message : String(error);
    }
  }

  /** The sidebar collapsed or expanded: the stage column changed width, so re-letterbox the game. */
  private readonly onPanelResize = (): void => {
    this.setChatWidth(this.chatWidth);
    this.fitStage();
  };

  private renderStageBar() {
    const toolLabel = this.activeTool ? this.activeTool.replace(/_/g, ' ') : null;
    return html`
      <div class="flow-stage__bar">
        <button
          class="flow-stage__button"
          type="button"
          title=${this.isPlaying ? 'Stop' : 'Play'}
          @click=${() =>
            void this.commandDispatcher.executeById(this.isPlaying ? 'game.stop' : 'game.start')}
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
        ${this.hasEntryScene
          ? html`<button
              class="flow-stage__button flow-stage__button--secondary"
              type="button"
              title="Play from entry scene — the full run, starting at the menu"
              aria-label="Play from entry scene"
              @click=${() => void this.startFromEntryScene()}
            >
              ${this.icons.getIcon('skip-back', IconSize.SMALL)}
            </button>`
          : null}
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

/** Which half of the prototype stage the column shows (design §2.5). */
type StageView = 'game' | 'idea';

/**
 * What the user reads while the transition runs. Phase names are pipeline vocabulary; these are
 * what the two ~5 s waits actually mean to the person watching them.
 */
const TRANSITION_LABELS: Readonly<Record<PrototypeBootstrapPhase, string>> = {
  idle: 'Starting the prototype…',
  planning: 'Planning the recipe…',
  expanding: 'Building your project…',
  ready: 'Your prototype is live.',
  error: 'Could not build the prototype.',
};

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
