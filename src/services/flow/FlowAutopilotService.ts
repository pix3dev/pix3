import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import type { FlowAutopilotState } from '@/state/AppState';
import {
  AgentChatService,
  type AgentChatState,
  type AgentChatStatus,
} from '@/services/agent/AgentChatService';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  FlowPlanService,
  FLOW_BRIEF_PATH,
  FLOW_PROGRESS_PATH,
} from '@/services/flow/FlowPlanService';
import { FlowStageService } from '@/services/flow/FlowStageService';
import { DECISIONS_PATH, extractDecisionEntries } from '@/services/flow/decision-log';
import { routeQuestion } from '@/services/flow/autopilot-router';
import {
  renderAutopilotTurnMessage,
  selectNextStepFromProgress,
} from '@/services/flow/autopilot-queue';

/** Recipe contract, read alongside the brief as the project's own words (mirrors AgentChatService). */
const RECIPE_MD_PATH = 'design/recipe.md';

/**
 * How long typing keeps the countdown paused after the last keystroke.
 *
 * A pause that only lifted on an explicit signal would strand the run whenever the user typed a
 * word and walked away; two seconds is short enough that a user who is actually composing keeps
 * resetting it with every other keystroke.
 */
export const ACTIVITY_GRACE_MS = 2_000;

/**
 * Prompt tokens the provider actually re-processed for this conversation so far. `inputTokens` is
 * cache-inclusive by contract (see `LlmUsage`), so the cached share is taken back out; a provider
 * that reports no cache figure counts in full, which errs towards stopping early — the honest side.
 */
const uncachedPromptTokens = (state: AgentChatState): number =>
  Math.max(0, (state.totalUsage.inputTokens ?? 0) - (state.totalUsage.cacheReadTokens ?? 0));

/**
 * The autopilot's director (plan §2.2): the code that decides WHICH increment happens next, starts
 * it, watches the budget and stops the run — while the agent loop it drives stays untouched.
 *
 * The one design decision worth restating here is that none of this is a prompt. The queue comes
 * from `design/progress.md`, the priority order is a table, the stop criteria are numbers, and the
 * model is only ever asked to execute one increment at a time. The measured failure this guards
 * against is the opposite arrangement: an agent asked to judge its own progress reports "Done!" on
 * a car that drives sideways (plan §7.2).
 *
 * State lives in `appState.ui.flowAutopilot` and is written here directly — session UI state, like
 * `flowSceneViewVisible`: not undoable, and a run the page load interrupted is over, so it must not
 * survive a reload either.
 */
@injectable()
export class FlowAutopilotService {
  @inject(AgentChatService)
  private readonly chat!: AgentChatService;

  @inject(AgentSettingsService)
  private readonly settings!: AgentSettingsService;

  @inject(FlowPlanService)
  private readonly planService!: FlowPlanService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(FlowStageService)
  private readonly flowStage!: FlowStageService;

  private unsubscribeChat: (() => void) | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  /** What is left of a paused countdown, in ms — the plan pauses it, never resets it (§3.2). */
  private remainingMs = 0;
  /** Which threshold the paused countdown was running on, so resuming restores the right one. */
  private countdownReason: 'increment' | 'question' = 'increment';
  private lastStatus: AgentChatStatus = 'idle';
  private lastActiveTool: string | null = null;
  /** The conversation's cumulative UNCACHED prompt tokens as last seen — see {@link accumulateTokens}. */
  private lastSeenInputTokens = 0;
  /** True between our own `send` and the turn settling: "this turn is the supervisor's". */
  private drivingTurn = false;

  /**
   * Arm the autopilot from the user's own click ("Continue autonomously").
   *
   * Only ever reached from that click. 15 s of silence is a fine threshold for a mode somebody
   * switched on; as a default it would start interrupting a user who is simply thinking, which is
   * the objection §7.1 makes to the idea it came from.
   */
  armFromUser(mode: 'armed' | 'autonomous' = 'armed'): void {
    if (!this.canArm()) {
      return;
    }
    this.patch({
      mode,
      phase: 'idle',
      countdownEndsAt: null,
      runId: `run-${Date.now().toString(36)}`,
      startedAt: Date.now(),
      increments: 0,
      toolIterations: 0,
      inputTokens: 0,
      stopReason: null,
    });
    this.lastSeenInputTokens = uncachedPromptTokens(this.chat.getState());
    this.lastStatus = this.chat.getState().status;
    this.subscribeToChat();
    if (!this.chat.isRunning()) {
      this.startCountdown('increment');
    }
  }

  /**
   * The user takes over mid-run: stop the turn on screen and switch the supervisor off.
   *
   * `chat.stop()` aborts the request; the temporary debug values the turn may have set are put
   * back by the chat's own `finally`, which is the reason interrupting a turn is safe at all.
   */
  takeWheel(): void {
    this.clearTimers();
    this.drivingTurn = false;
    // Switched off and unsubscribed BEFORE the stop: aborting publishes a `running → idle` edge,
    // and an automaton still listening would read it as "the turn settled" and arm a countdown for
    // the run the user just ended.
    this.unsubscribeChat?.();
    this.unsubscribeChat = null;
    this.patch({ mode: 'off', phase: 'idle', countdownEndsAt: null, stopReason: null });
    this.chat.stop();
  }

  /**
   * The user is typing: hold the countdown where it is (plan §3.2 — paused, not reset) and let it
   * resume from the remainder once the typing stops.
   */
  noteUserActivity(): void {
    const state = appState.ui.flowAutopilot;
    if (state.mode === 'off') {
      return;
    }
    if (this.countdownTimer) {
      this.remainingMs = Math.max(0, (state.countdownEndsAt ?? 0) - Date.now());
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
      this.patch({ countdownEndsAt: null });
    }
    if (state.phase !== 'countdown') {
      return;
    }
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
    }
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (appState.ui.flowAutopilot.phase === 'countdown') {
        this.startCountdown(this.countdownReason, this.remainingMs);
      }
    }, ACTIVITY_GRACE_MS);
  }

  /**
   * The user sent a message: their turn wins outright (priority 1 of §2.3), so the scheduled turn
   * is dropped rather than paused. The run stays armed — the countdown comes back when this turn
   * settles, which is the whole point of a mode you switch on once.
   */
  noteUserMessage(): void {
    if (appState.ui.flowAutopilot.mode === 'off') {
      return;
    }
    this.clearTimers();
    this.drivingTurn = false;
    this.patch({ phase: 'idle', countdownEndsAt: null, stopReason: null });
  }

  /** Carry on after a pause (or after "done"): the user read the reason and wants more. */
  resumeRun(): void {
    if (appState.ui.flowAutopilot.mode === 'off') {
      return;
    }
    this.patch({
      phase: 'idle',
      stopReason: null,
      startedAt: Date.now(),
      increments: 0,
      toolIterations: 0,
      inputTokens: 0,
    });
    this.subscribeToChat();
    if (!this.chat.isRunning()) {
      this.startCountdown('increment');
    }
  }

  /**
   * Whether there is anything for the autopilot to drive: Flow, and past the idea stage.
   *
   * At the idea stage there is no `design/progress.md` and no runtime — the queue would be empty
   * and the first countdown would end in "nothing to work from". The UI reads this to hide the
   * offer rather than show a button that can only apologise.
   */
  canArm(): boolean {
    return appState.ui.workspaceMode === 'flow' && !this.flowStage.isIdeaStage();
  }

  dispose(): void {
    this.clearTimers();
    this.unsubscribeChat?.();
    this.unsubscribeChat = null;
  }

  // ── The automaton ───────────────────────────────────────────────────────────

  private subscribeToChat(): void {
    this.unsubscribeChat ??= this.chat.subscribe(state => this.handleChatState(state));
  }

  /**
   * `off → armed → countdown → running → (countdown | paused | done)`.
   *
   * The countdown starts on the chat's `running → idle` edge rather than on a question appearing:
   * the same moment covers a turn that ended with a question and a turn that ended with a report,
   * and the second is the one the mode exists for (plan §3.2).
   */
  private handleChatState(state: AgentChatState): void {
    const autopilot = appState.ui.flowAutopilot;
    if (autopilot.mode === 'off') {
      this.lastStatus = state.status;
      return;
    }
    // Hop accounting. The chat publishes each tool as it starts, so counting the transitions is
    // counting the round trips — which is what the budget in §5 is really about (autonomy
    // multiplies a lane's inefficiencies; a run of repeated `find_nodes` costs the same as work).
    if (state.activeTool && state.activeTool !== this.lastActiveTool) {
      this.patch({ toolIterations: autopilot.toolIterations + 1 });
    }
    this.lastActiveTool = state.activeTool;

    if (state.status === 'running') {
      this.clearTimers();
      // A turn the USER sent leaves the autopilot at `idle`: that flag is what tells the chat loop
      // there is somebody to answer an `ask_user` question.
      this.patch({ phase: this.drivingTurn ? 'running' : 'idle', countdownEndsAt: null });
      this.lastStatus = state.status;
      return;
    }

    const settled = this.lastStatus === 'running';
    this.lastStatus = state.status;
    if (!settled) {
      return;
    }
    this.drivingTurn = false;
    this.accumulateTokens(state);

    if (state.status === 'error') {
      // A provider error is not a reason to keep spending the budget: whatever failed will fail
      // again in fifteen seconds, and the user is the only one who can fix a key or a quota.
      this.pause(`The provider stopped the run: ${state.errorMessage ?? 'unknown error'}`);
      return;
    }

    const exceeded = this.exceededBudget();
    if (exceeded) {
      this.pause(exceeded);
      return;
    }
    this.startCountdown(state.pendingQuestion ? 'question' : 'increment');
  }

  /**
   * Fold this conversation's cumulative usage into the run's total.
   *
   * UNCACHED prompt tokens, not `inputTokens`: that counter is cache-inclusive and summed per hop,
   * so one increment of ~40 hops over a 73K context reads as 3M tokens — measured live, where it
   * tripped a 600K budget after a single turn. What the run actually spends is the part the
   * provider re-processed, and that is what the budget is denominated in.
   *
   * A delta rather than the raw number because Flow starts a FRESH conversation between increments
   * once the context grows fat (`flowIncrementHandoff`), which resets `totalUsage` — a run measured
   * by the latest conversation's counter would look cheaper the longer it went on.
   */
  private accumulateTokens(state: AgentChatState): void {
    const current = uncachedPromptTokens(state);
    const delta =
      current >= this.lastSeenInputTokens ? current - this.lastSeenInputTokens : current;
    this.lastSeenInputTokens = current;
    if (delta > 0) {
      this.patch({ inputTokens: appState.ui.flowAutopilot.inputTokens + delta });
    }
  }

  /** The first budget this run has spent, as a sentence for the user, or null while it is fine. */
  private exceededBudget(): string | null {
    const state = appState.ui.flowAutopilot;
    const prefs = this.settings.getPreferences();
    const minutes = state.startedAt > 0 ? (Date.now() - state.startedAt) / 60_000 : 0;
    if (state.increments >= prefs.autopilotMaxIncrements) {
      // "Turns", not "increments": the counter also covers a turn spent answering a question the
      // agent raised, and calling those increments would overstate what the run actually built.
      return `Budget reached: ${state.increments} agent turn${state.increments === 1 ? '' : 's'} this run.`;
    }
    if (state.toolIterations >= prefs.autopilotMaxToolIterations) {
      return `Budget reached: ${state.toolIterations} tool calls this run.`;
    }
    if (minutes >= prefs.autopilotMaxMinutes) {
      return `Budget reached: ${Math.round(minutes)} minutes of autonomous work.`;
    }
    if (state.inputTokens >= prefs.autopilotMaxInputTokens) {
      return `Budget reached: ${Math.round(state.inputTokens / 1000)}K uncached prompt tokens this run.`;
    }
    return null;
  }

  // ── Countdown ───────────────────────────────────────────────────────────────

  private startCountdown(reason: 'increment' | 'question', overrideMs?: number): void {
    this.clearTimers();
    this.countdownReason = reason;
    const prefs = this.settings.getPreferences();
    const seconds =
      reason === 'question' ? prefs.autopilotQuestionSeconds : prefs.autopilotIdleSeconds;
    // Autonomous has nobody to wait for: its questions are answered inside the turn, so the only
    // thing a countdown would add is dead time between increments (§3.3).
    const baseMs =
      appState.ui.flowAutopilot.mode === 'autonomous' ? 0 : Math.max(0, seconds) * 1000;
    const delay = overrideMs ?? baseMs;
    this.remainingMs = delay;
    this.patch({ phase: 'countdown', countdownEndsAt: Date.now() + delay });
    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      void this.onCountdownElapsed();
    }, delay);
  }

  private clearTimers(): void {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private async onCountdownElapsed(): Promise<void> {
    if (appState.ui.flowAutopilot.mode === 'off' || this.chat.isRunning()) {
      return;
    }
    this.patch({ countdownEndsAt: null });
    if (this.countdownReason === 'question' && this.chat.getState().pendingQuestion) {
      await this.answerOpenQuestion();
      return;
    }
    await this.takeNextStep();
  }

  /**
   * Answer the question the turn ended on, or hand it back to the user.
   *
   * The honest failure matters more than the automation here: a fork the brief does not settle is
   * exactly the "guessing wrong means rebuilding" case the `ask_user` contract is for, so the run
   * stops and says which question it could not answer rather than picking an option.
   */
  private async answerOpenQuestion(): Promise<void> {
    const pending = this.chat.getState().pendingQuestion;
    if (!pending) {
      await this.takeNextStep();
      return;
    }
    const routed = await this.routeAnswer(pending.question, pending.options);
    if (!routed) {
      this.pause(`I could not answer "${pending.question}" from the brief — that one is yours.`);
      return;
    }
    this.drivingTurn = true;
    this.patch({ phase: 'running', increments: appState.ui.flowAutopilot.increments + 1 });
    // A replay of a fork the log already holds files nothing: rewriting the line would drop the
    // reason recorded with the original (see AgentChatService.answerPending).
    await this.chat.answerPending(
      routed.choice,
      routed.via === 'decision-log' ? 'none' : routed.source
    );
  }

  private async routeAnswer(question: string, options: readonly string[]) {
    const [decisions, brief, recipe] = await Promise.all([
      this.readOptional(DECISIONS_PATH),
      this.readOptional(FLOW_BRIEF_PATH),
      this.readOptional(RECIPE_MD_PATH),
    ]);
    return routeQuestion({
      question,
      options,
      decisions: extractDecisionEntries(decisions),
      briefText: `${brief}\n${recipe}`,
    });
  }

  /**
   * Take the next increment off `design/progress.md` and send the turn that does it.
   *
   * "Done" is decided here, by the queue and the file — never by the agent saying so (plan §5).
   */
  private async takeNextStep(): Promise<void> {
    const progress = await this.readOptional(FLOW_PROGRESS_PATH);
    if (!progress.trim()) {
      this.pause('There is no `design/progress.md` to work from — tell me what to build next.');
      return;
    }
    const { step, done } = selectNextStepFromProgress(progress);
    if (done || !step) {
      this.finish('Every item in `design/progress.md` is ticked. Tell me what to add next.');
      return;
    }
    const plan = await this.planService.load().catch(() => ({
      title: null,
      pitch: null,
      steps: [],
    }));
    this.drivingTurn = true;
    this.patch({ phase: 'running', increments: appState.ui.flowAutopilot.increments + 1 });
    await this.chat.send(renderAutopilotTurnMessage(step, plan));
  }

  private async readOptional(path: string): Promise<string> {
    try {
      return await this.storage.readTextFile(path);
    } catch {
      return '';
    }
  }

  // ── State ───────────────────────────────────────────────────────────────────

  private pause(reason: string): void {
    this.clearTimers();
    this.drivingTurn = false;
    this.patch({ phase: 'paused', countdownEndsAt: null, stopReason: reason });
  }

  private finish(reason: string): void {
    this.clearTimers();
    this.drivingTurn = false;
    this.patch({ phase: 'done', countdownEndsAt: null, stopReason: reason });
  }

  private patch(next: Partial<FlowAutopilotState>): void {
    Object.assign(appState.ui.flowAutopilot, next);
  }
}
