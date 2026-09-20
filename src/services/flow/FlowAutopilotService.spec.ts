import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState } from '@/state';
import type { AgentChatState } from '@/services/agent/AgentChatService';
import { ACTIVITY_GRACE_MS, FlowAutopilotService } from './FlowAutopilotService';
import { AUTOPILOT_DEFAULTS } from '@/services/agent/AgentSettingsService';

const IDLE: AgentChatState = {
  status: 'idle',
  messages: [],
  errorMessage: null,
  errorKind: null,
  notice: null,
  activeTool: null,
  totalUsage: {},
  turnMetrics: {},
  conversations: [],
  activeConversationId: null,
  pendingQuestion: null,
  compactedAtIndices: [],
};

const PROGRESS = [
  '# Progress — Sky Defender',
  '',
  '- [x] drone flies',
  '- [ ] enemies spawn in waves',
  '',
].join('\n');

/** A stand-in chat: records what was sent and lets a test drive its published state by hand. */
class FakeChat {
  state: AgentChatState = IDLE;
  readonly sent: string[] = [];
  readonly answered: Array<{ choice: string; source: string }> = [];
  stopped = 0;
  private listener: ((state: AgentChatState) => void) | null = null;

  subscribe(listener: (state: AgentChatState) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  getState(): AgentChatState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  stop(): void {
    this.stopped += 1;
    this.emit({ status: 'idle' });
  }

  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.emit({ status: 'running' });
  }

  async answerPending(choice: string, source: string): Promise<void> {
    this.answered.push({ choice, source });
    this.emit({ status: 'running', pendingQuestion: null });
  }

  /** Publish a state change, exactly as the real service's `setState` would. */
  emit(patch: Partial<AgentChatState>): void {
    this.state = { ...this.state, ...patch };
    this.listener?.(this.state);
  }
}

interface Options {
  readonly files?: Record<string, string>;
  readonly preferences?: Partial<Record<keyof typeof AUTOPILOT_DEFAULTS, number>>;
}

const build = (options: Options = {}): { service: FlowAutopilotService; chat: FakeChat } => {
  const chat = new FakeChat();
  const files = options.files ?? { 'design/progress.md': PROGRESS };
  const service = new FlowAutopilotService();
  const overrides: Record<string, unknown> = {
    chat,
    settings: {
      getPreferences: () => ({ ...AUTOPILOT_DEFAULTS, ...options.preferences }),
    },
    planService: { load: async () => ({ title: 'Sky Defender', pitch: 'shoot', steps: [] }) },
    storage: {
      readTextFile: async (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error(`missing ${path}`);
        return text;
      },
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(service, key, { value, configurable: true });
  }
  return { service, chat };
};

/** Let the service's own async work settle without advancing any timer. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** End the turn on screen, exactly as the chat's own `runToSettled` would publish it. */
const settleTurn = async (chat: FakeChat): Promise<void> => {
  chat.emit({ status: 'idle' });
  await flush();
};

describe('FlowAutopilotService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    appState.ui.workspaceMode = 'flow';
    Object.assign(appState.ui.flowAutopilot, {
      mode: 'off',
      phase: 'idle',
      countdownEndsAt: null,
      runId: null,
      startedAt: 0,
      increments: 0,
      toolIterations: 0,
      inputTokens: 0,
      stopReason: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    appState.ui.workspaceMode = 'studio';
  });

  it('arms into a countdown and sends the next increment when it elapses', async () => {
    const { service, chat } = build();
    service.armFromUser();

    expect(appState.ui.flowAutopilot.phase).toBe('countdown');
    expect(appState.ui.flowAutopilot.runId).not.toBeNull();
    expect(chat.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);

    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]).toContain('enemies spawn in waves');
    expect(appState.ui.flowAutopilot.phase).toBe('running');
    expect(appState.ui.flowAutopilot.increments).toBe(1);
    service.dispose();
  });

  it('does nothing at all outside Flow', () => {
    appState.ui.workspaceMode = 'studio';
    const { service } = build();
    service.armFromUser();
    expect(appState.ui.flowAutopilot.mode).toBe('off');
    service.dispose();
  });

  /**
   * The flag that tells `AgentChatService` whether anybody is at the keyboard. A turn the user
   * typed has to leave the supervisor at `idle`, or the chat loop would start answering the user's
   * own questions for them.
   */
  it('stays idle while the USER drives a turn, and counts as running only its own', async () => {
    const { service, chat } = build();
    service.armFromUser();

    chat.emit({ status: 'running' });
    expect(appState.ui.flowAutopilot.phase).toBe('idle');

    await settleTurn(chat);
    expect(appState.ui.flowAutopilot.phase).toBe('countdown');
    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);
    expect(appState.ui.flowAutopilot.phase).toBe('running');
    service.dispose();
  });

  it('pauses the countdown while the user types and resumes from the remainder', async () => {
    const { service, chat } = build();
    service.armFromUser();

    await vi.advanceTimersByTimeAsync(10_000);
    service.noteUserActivity();
    expect(appState.ui.flowAutopilot.countdownEndsAt).toBeNull();

    // Well past the original deadline: a paused countdown must not fire on its own.
    await vi.advanceTimersByTimeAsync(60_000 - ACTIVITY_GRACE_MS);
    // It resumed with the 5 s that were left, not with a fresh 15.
    expect(chat.sent).toHaveLength(1);
    service.dispose();
  });

  it('drops the scheduled turn when the user sends a message instead', async () => {
    const { service, chat } = build();
    service.armFromUser();
    service.noteUserMessage();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(chat.sent).toHaveLength(0);
    expect(appState.ui.flowAutopilot.mode).toBe('armed');
    service.dispose();
  });

  it('pauses on a provider error rather than spending the budget on a retry', async () => {
    const { service, chat } = build();
    service.armFromUser();
    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);

    chat.emit({ status: 'error', errorMessage: 'rate limited' });
    await vi.runOnlyPendingTimersAsync();

    expect(appState.ui.flowAutopilot.phase).toBe('paused');
    expect(appState.ui.flowAutopilot.stopReason).toContain('rate limited');
    service.dispose();
  });

  it('stops with the budget it hit, naming it', async () => {
    const { service, chat } = build({ preferences: { autopilotMaxIncrements: 1 } });
    service.armFromUser();
    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);
    expect(chat.sent).toHaveLength(1);

    await settleTurn(chat);

    expect(appState.ui.flowAutopilot.phase).toBe('paused');
    expect(appState.ui.flowAutopilot.stopReason).toBe('Budget reached: 1 agent turn this run.');
    service.dispose();
  });

  it('counts tool calls across the run for the hop budget', async () => {
    const { service, chat } = build({ preferences: { autopilotMaxToolIterations: 2 } });
    service.armFromUser();
    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);

    chat.emit({ activeTool: 'fs_read' });
    chat.emit({ activeTool: null });
    chat.emit({ activeTool: 'fs_read' });
    expect(appState.ui.flowAutopilot.toolIterations).toBe(2);

    await settleTurn(chat);
    expect(appState.ui.flowAutopilot.stopReason).toBe('Budget reached: 2 tool calls this run.');
    service.dispose();
  });

  /**
   * A fresh conversation between increments resets the chat's cumulative usage (the Flow handoff),
   * so a run measured by that counter alone would look cheaper the longer it ran.
   */
  it('sums prompt tokens across the conversations one run spans', async () => {
    const { service, chat } = build({ preferences: { autopilotMaxIncrements: 99 } });
    service.armFromUser();
    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);
    chat.emit({ status: 'idle', totalUsage: { inputTokens: 40_000 } });
    await vi.runOnlyPendingTimersAsync();
    // Second increment, in a brand-new conversation whose counter starts over.
    chat.emit({ status: 'idle', totalUsage: { inputTokens: 25_000 } });
    await vi.runOnlyPendingTimersAsync();

    expect(appState.ui.flowAutopilot.inputTokens).toBe(65_000);
    service.dispose();
  });

  it('calls the run done when every item on the checklist is ticked', async () => {
    const { service } = build({
      files: { 'design/progress.md': '# Progress\n\n- [x] drone flies\n' },
    });
    service.armFromUser();
    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);

    expect(appState.ui.flowAutopilot.phase).toBe('done');
    expect(appState.ui.flowAutopilot.stopReason).toContain('ticked');
    service.dispose();
  });

  it('take the wheel stops the turn and switches the supervisor off', async () => {
    const { service, chat } = build();
    service.armFromUser();
    await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);

    service.takeWheel();

    expect(chat.stopped).toBe(1);
    expect(appState.ui.flowAutopilot.mode).toBe('off');
    expect(appState.ui.flowAutopilot.phase).toBe('idle');
    // No further turns, whatever the chat does next.
    chat.emit({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(chat.sent).toHaveLength(1);
  });

  describe('an open question in Assisted mode', () => {
    const ask = async (chat: FakeChat, options: readonly string[]): Promise<void> => {
      chat.emit({
        status: 'idle',
        pendingQuestion: { question: 'Win by score or by timer?', options, allowFreeform: true },
      });
      await flush();
    };

    it('waits the longer question threshold, then answers from the brief', async () => {
      const { service, chat } = build({
        files: {
          'design/progress.md': PROGRESS,
          'design/brief.md': 'A one-minute arcade run. The player wins by score.',
        },
      });
      service.armFromUser();
      await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);
      await ask(chat, ['by score', 'by timer']);

      // Still open at the increment threshold — a fork gets the longer wait (plan §3.3).
      await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);
      expect(chat.answered).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(
        (AUTOPILOT_DEFAULTS.autopilotQuestionSeconds - AUTOPILOT_DEFAULTS.autopilotIdleSeconds) *
          1000
      );
      expect(chat.answered).toEqual([{ choice: 'by score', source: 'auto-brief' }]);
      service.dispose();
    });

    it('files nothing when it is replaying a fork the log already settled', async () => {
      const { service, chat } = build({
        files: {
          'design/progress.md': PROGRESS,
          'design/decisions.md': '- **Win by score or by timer?** → by timer. — 2026-09-19',
        },
      });
      service.armFromUser();
      await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);
      await ask(chat, ['by score', 'by timer']);
      await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotQuestionSeconds * 1000);

      expect(chat.answered).toEqual([{ choice: 'by timer', source: 'none' }]);
      service.dispose();
    });

    it('hands a fork it cannot answer back to the user instead of guessing', async () => {
      const { service, chat } = build();
      service.armFromUser();
      await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotIdleSeconds * 1000);
      await ask(chat, ['by score', 'by timer']);
      await vi.advanceTimersByTimeAsync(AUTOPILOT_DEFAULTS.autopilotQuestionSeconds * 1000);

      expect(chat.answered).toHaveLength(0);
      expect(appState.ui.flowAutopilot.phase).toBe('paused');
      expect(appState.ui.flowAutopilot.stopReason).toContain('Win by score or by timer?');
      service.dispose();
    });
  });
});
