import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '@/state';
import {
  AgentChatService,
  LLM_REQUEST_TIMEOUT_MS,
  type ComposeContextRequest,
} from './AgentChatService';
import {
  LlmError,
  type ChatParams,
  type LlmMessage,
  type LlmResult,
} from '@/services/llm/LlmTypes';

const textResult = (text: string): LlmResult => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
});

const toolCallResult = (name: string, id: string, input: unknown = {}): LlmResult => ({
  content: [{ type: 'tool-use', id, name, input }],
  stopReason: 'tool_use',
});

interface Fakes {
  chat: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  maxToolIterations?: number;
  debugMode?: boolean;
  /** Optional project file reader (AGENTS.md lookup). Defaults to "no such file". */
  readTextFile?: (path: string) => Promise<string>;
  /** Optional directory lister (script-inventory scan). Defaults to "no such directory". */
  listDirectory?: (
    path: string
  ) => Promise<Array<{ name: string; kind: 'file' | 'directory'; path: string }>>;
  /** When set, the model catalog reports this vision capability for the active model. */
  supportsImages?: boolean;
  /** When set, the model catalog reports this context window (drives the context watermarks). */
  contextWindow?: number;
  /** When true, the advisor service resolves (the ask_advisor rule joins the system prompt). */
  advisorAvailable?: boolean;
  /** Secret id of the fake provider — set it to the bridge token to exercise `viaBridge`. */
  apiKeySecretId?: string;
  /** Conversation-list reader; override to control WHEN a history load resolves. */
  historyList?: () => Promise<unknown[]>;
  /** Soul preferences shaping the system-prompt persona. Defaults to the Brobot preset. */
  soulId?: string;
  customSoulName?: string;
  customSoulPrompt?: string;
  /** Fake for `BridgeConnectionService.resetSessions()`. Defaults to a no-op success. */
  resetSessions?: ReturnType<typeof vi.fn>;
  /** Fake for `AgentToolRegistry.recordDecision()` — the auto-filed `ask_user` answer. */
  recordDecision?: ReturnType<typeof vi.fn>;
}

/** Build a service with fake dependencies injected in place of the DI-resolved ones. */
const buildService = (fakes: Fakes): AgentChatService => {
  const service = new AgentChatService();
  const provider = {
    id: 'fake',
    label: 'Fake Provider',
    // Not the bridge token — turns stamped from this provider read as a direct browser call.
    apiKeySecretId: fakes.apiKeySecretId ?? 'ai-provider:fake:api-key',
    chat: fakes.chat,
  };
  const overrides: Record<string, unknown> = {
    settings: {
      getSelectedProvider: () => provider,
      getSelectedModelId: () => 'fake-model',
      getApiKey: async () => 'fake-key',
      getBaseUrl: () => undefined,
      getReasoningEffort: () => undefined,
      getPreferences: () => ({
        selectedProviderId: 'fake',
        modelByProvider: {},
        customBaseUrl: '',
        maxToolIterations: fakes.maxToolIterations ?? 5,
        debugMode: fakes.debugMode ?? false,
        soulId: fakes.soulId ?? 'brobot',
        customSoulName: fakes.customSoulName ?? '',
        customSoulPrompt: fakes.customSoulPrompt ?? '',
      }),
    },
    modelCatalog: {
      getModel: () =>
        fakes.supportsImages === undefined && fakes.contextWindow === undefined
          ? undefined
          : {
              capabilities: {
                ...(fakes.supportsImages === undefined
                  ? {}
                  : { supportsImages: fakes.supportsImages }),
                ...(fakes.contextWindow === undefined
                  ? {}
                  : { contextWindow: fakes.contextWindow }),
              },
            },
    },
    toolRegistry: {
      specs: () => [],
      execute: fakes.execute,
      recordDecision: fakes.recordDecision ?? vi.fn(async () => ({ ok: true })),
    },
    advisorService: {
      resolveAdvisor: async () =>
        fakes.advisorAvailable ? { modelId: 'adv-model', apiKey: 'k' } : null,
    },
    historyStore: {
      list: fakes.historyList ?? (async () => []),
      get: async () => undefined,
      put: fakes.put,
      delete: async () => undefined,
    },
    sceneManager: { getActiveSceneGraph: () => null },
    bridgeConnection: {
      resetSessions: fakes.resetSessions ?? vi.fn(async () => true),
    },
    storage: {
      readTextFile:
        fakes.readTextFile ??
        (async () => {
          throw new Error('not found');
        }),
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(service, key, { value, configurable: true });
  }
  return service;
};

describe('AgentChatService', () => {
  beforeEach(() => {
    appState.project.id = 'proj-1';
  });

  it('does not let a slow history load wipe a turn that started meanwhile', async () => {
    // Flow's first turn: the chat panel mounts for the brand-new project (ensureLoaded) at the same
    // moment the bootstrap sends the first message. The load resolving second must not clobber it.
    let releaseList: () => void = () => {};
    const listed = new Promise<void>(resolve => {
      releaseList = resolve;
    });
    const service = buildService({
      chat: vi.fn(async () => textResult('on it')),
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
      historyList: async () => {
        await listed;
        return [];
      },
    });

    appState.project.id = 'proj-fresh';
    const loading = service.ensureLoaded();
    await service.send('build me a tapper');
    releaseList();
    await loading;

    expect(service.getState().messages).toHaveLength(2);
  });

  it('appends the user message and the assistant text reply', async () => {
    const chat = vi.fn(async () => textResult('hello!'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');

    const state = service.getState();
    expect(state.status).toBe('idle');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(state.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello!' }],
    });
    expect(state.totalUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('stamps each assistant turn with the provider that produced it', async () => {
    // The chat shows this per reply. Recorded at send time rather than read from settings later,
    // because the selection can change mid-conversation and a reply must keep its own attribution.
    const chat = vi.fn(async () => textResult('hello!'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');

    expect(service.getState().turnMetrics[1]?.origin).toEqual({
      providerId: 'fake',
      providerLabel: 'Fake Provider',
      modelId: 'fake-model',
      viaBridge: false,
    });
  });

  it('marks a turn as bridge-served when the provider authenticates with the pairing token', async () => {
    const chat = vi.fn(async () => textResult('hello!'));
    const service = buildService({
      chat,
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
      apiKeySecretId: 'ai-provider:pix3-bridge:token',
    });

    await service.send('hi');

    expect(service.getState().turnMetrics[1]?.origin?.viaBridge).toBe(true);
  });

  it('persists turn metrics so a reopened conversation keeps its attribution', async () => {
    const put = vi.fn(async (_record: { turnMetrics?: Record<number, unknown> }) => undefined);
    const chat = vi.fn(async () => textResult('hello!'));
    const service = buildService({ chat, execute: vi.fn(), put });

    await service.send('hi');

    expect(put.mock.calls.at(-1)?.[0].turnMetrics?.[1]).toBeDefined();
  });

  it('executes tool calls, feeds results (with toolName) back, and continues to the final reply', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('scene_tree', 'call-1', { maxDepth: 2 }))
      .mockResolvedValueOnce(textResult('done'));
    const execute = vi.fn(async () => ({ nodes: 3 }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('inspect the scene');

    expect(execute).toHaveBeenCalledWith('scene_tree', { maxDepth: 2 });

    const state = service.getState();
    expect(state.status).toBe('idle');
    // user, assistant(tool-use), user(tool-result), assistant(text)
    expect(state.messages).toHaveLength(4);
    expect(state.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolUseId: 'call-1',
          toolName: 'scene_tree',
          content: JSON.stringify({ nodes: 3 }),
        },
      ],
    });

    // The follow-up request must carry the full history.
    const secondCallMessages = (chat.mock.calls[1][0] as { messages: LlmMessage[] }).messages;
    expect(secondCallMessages).toHaveLength(3);
  });

  it('turns a tool handler failure into an isError result and keeps looping', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('fs_read', 'call-1', { path: 'nope.ts' }))
      .mockResolvedValueOnce(textResult('recovered'));
    const execute = vi.fn(async () => {
      throw new Error('File not found: nope.ts');
    });
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('read it');

    const state = service.getState();
    expect(state.status).toBe('idle');
    expect(state.messages[2].content).toEqual([
      {
        type: 'tool-result',
        toolUseId: 'call-1',
        toolName: 'fs_read',
        content: 'File not found: nope.ts',
        isError: true,
      },
    ]);
    expect(state.messages[3]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    });
  });

  it('nudges the model to continue when a reply is cut off by max_tokens with no tool call', async () => {
    const truncated: LlmResult = {
      content: [{ type: 'text', text: 'Now RaceManager —' }],
      stopReason: 'max_tokens',
    };
    const chat = vi.fn().mockResolvedValueOnce(truncated).mockResolvedValueOnce(textResult('done'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('build it');

    expect(chat).toHaveBeenCalledTimes(2);
    const state = service.getState();
    expect(state.status).toBe('idle');
    // user, assistant(truncated), user(nudge), assistant(done)
    expect(state.messages).toHaveLength(4);
    const nudge = state.messages[2];
    expect(nudge.role).toBe('user');
    expect(JSON.stringify(nudge.content)).toMatch(/cut off/);
  });

  it('does not nudge past the iteration cap on repeated max_tokens replies', async () => {
    const truncated: LlmResult = {
      content: [{ type: 'text', text: '…' }],
      stopReason: 'max_tokens',
    };
    const chat = vi.fn(async () => truncated);
    const service = buildService({
      chat,
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
      maxToolIterations: 3,
    });

    await service.send('build it');

    expect(chat).toHaveBeenCalledTimes(3);
    expect(service.getState().status).toBe('idle');
  });

  it('warns the model to wrap up when 2 or fewer tool iterations remain', async () => {
    let n = 0;
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('scene_tree', `c${n++}`))
      .mockResolvedValueOnce(toolCallResult('scene_tree', `c${n++}`))
      .mockResolvedValueOnce(textResult('done'));
    const execute = vi.fn(async () => ({}));
    const service = buildService({
      chat,
      execute,
      put: vi.fn(async () => undefined),
      maxToolIterations: 3,
    });

    await service.send('go');

    const state = service.getState();
    // Tool-result message after iteration 0 (2 remaining) carries the wrap-up warning…
    expect(JSON.stringify(state.messages[2].content)).toMatch(/force-stopped/);
    // …which also reminds the model to persist its progress file for the next turn.
    expect(JSON.stringify(state.messages[2].content)).toMatch(/progress\.md/);
    // …and so does the one after iteration 1 (1 remaining).
    expect(JSON.stringify(state.messages[4].content)).toMatch(/force-stopped/);
  });

  it('nudges once for a summary when a turn ends with no tool call and no text', async () => {
    const empty: LlmResult = { content: [], stopReason: 'end_turn' };
    const chat = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(textResult('all done'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('fix it');

    expect(chat).toHaveBeenCalledTimes(2);
    const state = service.getState();
    expect(state.status).toBe('idle');
    // user, assistant(empty), user(nudge), assistant(text)
    expect(state.messages).toHaveLength(4);
    expect(JSON.stringify(state.messages[2].content)).toMatch(/empty reply/);
  });

  it('does not loop when the model keeps returning empty replies', async () => {
    const empty: LlmResult = { content: [], stopReason: 'end_turn' };
    const chat = vi.fn(async () => empty);
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('fix it');

    // One real request + exactly one nudge-retry, then it gives up (no infinite loop).
    expect(chat).toHaveBeenCalledTimes(2);
    expect(service.getState().status).toBe('idle');
  });

  it('flags a repeated identical tool call that returns the identical result', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c1', { id: 'nope' }))
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c2', { id: 'nope' }))
      .mockResolvedValueOnce(textResult('ok, moving on'));
    const execute = vi.fn(async () => ({ ok: false, error: 'unknown skill' }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('go');

    const state = service.getState();
    // First result message carries no warning; the repeat does.
    expect(JSON.stringify(state.messages[2].content)).not.toMatch(/repeated an identical/);
    expect(JSON.stringify(state.messages[4].content)).toMatch(/repeated an identical read_skill/);
  });

  it('does not call a repeat a loop when a state-changing tool ran in between', async () => {
    // Measured: edit → compile → play_start(reload) → edit → compile → play_start(reload) is the
    // documented fix loop, but play_start returns the same payload every time, so the breaker
    // scolded a legitimate restart and escalated to the stuck directive on the third one.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('play_start', 'c1', { scene: 'scenes/main.pix3scene', reload: true })
      )
      .mockResolvedValueOnce(
        toolCallResult('str_replace', 'c2', { path: 'scripts/Car.ts', old_string: 'a' })
      )
      .mockResolvedValueOnce(
        toolCallResult('play_start', 'c3', { scene: 'scenes/main.pix3scene', reload: true })
      )
      .mockResolvedValueOnce(toolCallResult('game_input', 'c4', { steps: [] }))
      .mockResolvedValueOnce(textResult('done'));
    const execute = vi.fn(async (name: string) =>
      name === 'play_start' ? { ok: true, scene: 'scenes/main.pix3scene' } : { ok: true }
    );
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('fix it');

    const state = service.getState();
    expect(JSON.stringify(state.messages)).not.toMatch(/repeated an identical/);
  });

  it('still flags a repeat when nothing changed between the two identical calls', async () => {
    // The guard above must not blind the breaker: read-only calls in between change nothing.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('play_start', 'c1', { scene: 'scenes/main.pix3scene', reload: true })
      )
      .mockResolvedValueOnce(toolCallResult('play_status', 'c2', {}))
      .mockResolvedValueOnce(
        toolCallResult('play_start', 'c3', { scene: 'scenes/main.pix3scene', reload: true })
      )
      .mockResolvedValueOnce(textResult('done'));
    const execute = vi.fn(async () => ({ ok: true, scene: 'scenes/main.pix3scene' }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('fix it');

    expect(JSON.stringify(service.getState().messages)).toMatch(/repeated an identical play_start/);
  });

  it('refuses a screenshot while a gameplay change is unproven (Flow only), and runs it with a visualReason', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('str_replace', 'c1', { path: 'scripts/Score.ts', old_string: 'a' })
      )
      .mockResolvedValueOnce(toolCallResult('viewport_screenshot', 'c2', {}))
      .mockResolvedValueOnce(
        toolCallResult('viewport_screenshot', 'c3', { visualReason: 'checking the HUD layout' })
      )
      .mockResolvedValueOnce(toolCallResult('game_input', 'c4', { steps: [] }))
      .mockResolvedValueOnce(textResult('score goes up'));
    const execute = vi.fn(async () => ({ ok: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });
    appState.ui.workspaceMode = 'flow';

    try {
      await service.send('make tapping score');
    } finally {
      appState.ui.workspaceMode = 'studio';
    }

    const executedTools = execute.mock.calls.map(call => (call as unknown[])[0]);
    expect(executedTools.filter(name => name === 'viewport_screenshot')).toHaveLength(1);
    const refusal = JSON.stringify(service.getState().messages).includes(
      'is unavailable right now'
    );
    expect(refusal).toBe(true);
  });

  it('starts a fat Flow increment in a fresh conversation, carrying a handoff', async () => {
    // Measured across three increments: one conversation ran 44K -> 144K input tokens because only
    // the bootstrap's first turn got a clean start, and per-hop latency tracks context size.
    const chat = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'increment done: the snake grows' }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 90_000, outputTokens: 5 },
    }));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });
    appState.ui.workspaceMode = 'flow';

    try {
      await service.send('build the movement');
      const afterFirst = service.getState().messages.length;
      await service.send('now add walls');

      const state = service.getState();
      // Fresh conversation: the new turn does not carry the previous exchange.
      expect(state.messages.length).toBeLessThan(afterFirst + 2);
      const sent = JSON.stringify(state.messages[0]);
      expect(sent).toContain('now add walls');
      expect(sent).toContain('increment done: the snake grows');
    } finally {
      appState.ui.workspaceMode = 'studio';
    }
  });

  it('keeps a small Flow conversation going instead of resetting it', async () => {
    const chat = vi.fn(async () => textResult('done'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });
    appState.ui.workspaceMode = 'flow';

    try {
      await service.send('build the movement');
      await service.send('one more thing');
      expect(service.getState().messages).toHaveLength(4);
    } finally {
      appState.ui.workspaceMode = 'studio';
    }
  });

  it('calls out retuning one property over and over, even though no two calls are identical', async () => {
    // Measured: an increment set the same component property eight times with a different value
    // each time, so the byte-equality repeat check never fired and the turn burned its whole cap.
    const tweak = (id: string, value: number) =>
      toolCallResult('set_component_property', id, {
        nodeId: 'player',
        componentId: 'snake-controller',
        propertyName: 'moveInterval',
        value,
      });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(tweak('c1', 0.15))
      .mockResolvedValueOnce(tweak('c2', 0.3))
      .mockResolvedValueOnce(tweak('c3', 0.6))
      .mockResolvedValueOnce(tweak('c4', 1.5))
      .mockResolvedValueOnce(textResult('stopping to think'));
    const service = buildService({
      chat,
      execute: vi.fn(async () => ({ ok: true })),
      put: vi.fn(async () => undefined),
      maxToolIterations: 8,
    });

    await service.send('make it faster');

    const nudged = JSON.stringify(service.getState().messages).includes(
      'the value is not what is wrong'
    );
    expect(nudged).toBe(true);
  });

  it('gates the turn on a str_replace script edit, not just fs_write', async () => {
    // The skills tell the agent to prefer str_replace for edits, so the gate must watch it too.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('str_replace', 'c1', { path: 'scripts/Car.ts', old_string: 'a' })
      )
      .mockResolvedValueOnce(textResult('Fixed the steering.'))
      .mockResolvedValueOnce(toolCallResult('game_input', 'c2', { steps: [] }))
      .mockResolvedValueOnce(textResult('Verified: it drives forward.'));
    const execute = vi.fn(async () => ({ ok: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('fix the car direction');

    const gate = service
      .getState()
      .messages.find(
        m => m.role === 'user' && JSON.stringify(m.content).includes('changed game logic')
      );
    expect(gate).toBeDefined();
  });

  it('gates the turn: nudges once when game logic changed but the game was never run', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'scripts/Car.ts', content: 'x' })
      )
      .mockResolvedValueOnce(textResult('Fixed the steering.')) // tries to end without running it
      .mockResolvedValueOnce(toolCallResult('game_input', 'c2', { steps: [] }))
      .mockResolvedValueOnce(textResult('Verified: it drives forward.'));
    const execute = vi.fn(async () => ({ ok: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('fix the car direction');

    expect(chat).toHaveBeenCalledTimes(4);
    const state = service.getState();
    expect(state.status).toBe('idle');
    const gate = state.messages.find(
      m => m.role === 'user' && JSON.stringify(m.content).includes('changed game logic')
    );
    expect(gate).toBeDefined();
  });

  it('does not gate when the change was verified with game_input in the same turn', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'scripts/Car.ts', content: 'x' })
      )
      .mockResolvedValueOnce(toolCallResult('game_input', 'c2', { steps: [] }))
      .mockResolvedValueOnce(textResult('done and verified'));
    const execute = vi.fn(async () => ({ ok: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('fix it');

    expect(chat).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(service.getState().messages)).not.toMatch(/changed game logic/);
  });

  it('does not gate when the change was proven with game_run (the strongest proof clears the debt)', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'scripts/Car.ts', content: 'x' })
      )
      .mockResolvedValueOnce(
        toolCallResult('game_run', 'c2', {
          until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
        })
      )
      .mockResolvedValueOnce(textResult('score rose on frame 47'));
    const execute = vi.fn(async (name: string) =>
      name === 'game_run'
        ? { ok: true, verdict: 'PASS until[0] score +1 (frame 47)', outcome: { kind: 'until' } }
        : { ok: true }
    );
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('make scoring work');

    expect(chat).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(service.getState().messages)).not.toMatch(/changed game logic/);
  });

  it('a game_run that was already true at frame 0 proves nothing, so the gate still fires', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'scripts/Car.ts', content: 'x' })
      )
      .mockResolvedValueOnce(
        toolCallResult('game_run', 'c2', {
          until: [{ kind: 'gameState', path: 'score', op: 'gte', value: 0 }],
        })
      )
      .mockResolvedValueOnce(textResult('done'))
      .mockResolvedValueOnce(textResult('still done'));
    const execute = vi.fn(async (name: string) =>
      name === 'game_run'
        ? {
            ok: true,
            verdict: 'PRECONDITION ALREADY MET: until[0] is ALREADY TRUE at frame 0',
            outcome: { kind: 'precondition-already-met' },
          }
        : { ok: true }
    );
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('make scoring work');

    const gate = service
      .getState()
      .messages.find(
        m => m.role === 'user' && JSON.stringify(m.content).includes('changed game logic')
      );
    expect(gate).toBeDefined();
  });

  it('game_controls does not clear the verify debt: listing what is interactive proves nothing', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'scripts/Car.ts', content: 'x' })
      )
      .mockResolvedValueOnce(toolCallResult('game_controls', 'c2', {}))
      .mockResolvedValueOnce(textResult('the button is there, done'))
      .mockResolvedValueOnce(textResult('still done'));
    const execute = vi.fn(async () => ({ ok: true, controls: [{ name: 'PlayButton' }] }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('wire the button');

    const gate = service
      .getState()
      .messages.find(
        m => m.role === 'user' && JSON.stringify(m.content).includes('changed game logic')
      );
    expect(gate).toBeDefined();
  });

  it('does not gate a documentation write (design/progress.md is not game logic)', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'design/progress.md', content: '- [x] done' })
      )
      .mockResolvedValueOnce(textResult('progress updated'));
    const execute = vi.fn(async () => ({ ok: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('update the checklist');

    expect(chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(service.getState().messages)).not.toMatch(/changed game logic/);
  });

  it('gate fires at most once, so an unverified change cannot loop forever', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'scripts/Car.ts', content: 'x' })
      )
      .mockResolvedValueOnce(textResult('done')) // gate nudge fires here
      .mockResolvedValueOnce(textResult('still done, not running it')); // ignores nudge → ends
    const execute = vi.fn(async () => ({ ok: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('fix it');

    expect(chat).toHaveBeenCalledTimes(3);
    expect(service.getState().status).toBe('idle');
  });

  it('ends the turn on ask_user and exposes the question with its options', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('ask_user', 'c1', {
          question: 'Win by score or by timer?',
          options: ['by score', 'by timer'],
        })
      )
      // Must never be reached — the turn stops as soon as ask_user executes.
      .mockResolvedValueOnce(textResult('should not be sent'));
    const execute = vi.fn(async () => ({ ok: true, asked: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('build me a tapper');

    expect(chat).toHaveBeenCalledTimes(1);
    const state = service.getState();
    expect(state.status).toBe('idle');
    // user, assistant(tool-use), user(tool-result) — and then it stops.
    expect(state.messages).toHaveLength(3);
    expect(state.pendingQuestion).toEqual({
      question: 'Win by score or by timer?',
      options: ['by score', 'by timer'],
      allowFreeform: true,
    });
  });

  it('ask_user clears the verify debt, so the gate does not chase a turn that ends in a question', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResult('fs_write', 'c1', { path: 'scripts/Car.ts', content: 'x' })
      )
      .mockResolvedValueOnce(toolCallResult('ask_user', 'c2', { question: 'Waves or endless?' }))
      .mockResolvedValueOnce(textResult('never reached'));
    const execute = vi.fn(async () => ({ ok: true }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('add enemies');

    expect(chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(service.getState().messages)).not.toMatch(/changed game logic/);
    expect(service.getState().pendingQuestion?.question).toBe('Waves or endless?');
  });

  it('clears the pending question on the next send', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('ask_user', 'c1', { question: 'A or B?' }))
      .mockResolvedValueOnce(textResult('going with A'));
    const service = buildService({
      chat,
      execute: vi.fn(async () => ({ ok: true })),
      put: vi.fn(async () => undefined),
    });

    await service.send('go');
    expect(service.getState().pendingQuestion).not.toBeNull();

    await service.send('A');
    expect(service.getState().pendingQuestion).toBeNull();
  });

  describe('answers to ask_user are filed in the decision log by code', () => {
    /** Run one ask → answer exchange and report what the auto-record was handed. */
    const answerAQuestion = async (
      answer: string,
      recordDecision: ReturnType<typeof vi.fn>
    ): Promise<AgentChatService> => {
      const chat = vi
        .fn()
        .mockResolvedValueOnce(
          toolCallResult('ask_user', 'c1', {
            question: 'Coop: local or online?',
            options: ['local', 'online'],
          })
        )
        .mockResolvedValueOnce(textResult('noted'));
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({ ok: true, asked: true })),
        put: vi.fn(async () => undefined),
        recordDecision,
      });
      await service.send('make me a coop game');
      await service.send(answer);
      return service;
    };

    beforeEach(() => {
      appState.ui.workspaceMode = 'flow';
    });

    afterEach(() => {
      appState.ui.workspaceMode = 'studio';
    });

    it('records the question and the answer without the model spending a tool call', async () => {
      const recordDecision = vi.fn(async () => ({ ok: true }));
      await answerAQuestion('local', recordDecision);

      expect(recordDecision).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledWith({
        question: 'Coop: local or online?',
        choice: 'local',
      });
    });

    /**
     * Order is the point: the request carrying the answer must already run against a log holding
     * it, because after a compaction the file is the only place the fork survives.
     */
    it('files the decision BEFORE the turn that carries the answer starts', async () => {
      const order: string[] = [];
      const recordDecision = vi.fn(async () => {
        order.push('record');
        return { ok: true };
      });
      const chat = vi
        .fn()
        .mockResolvedValueOnce(toolCallResult('ask_user', 'c1', { question: 'A or B?' }))
        .mockImplementationOnce(async () => {
          order.push('chat');
          return textResult('noted');
        });
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({ ok: true, asked: true })),
        put: vi.fn(async () => undefined),
        recordDecision,
      });
      await service.send('go');
      await service.send('A');

      expect(order).toEqual(['record', 'chat']);
    });

    it('does not touch the log outside Flow — no design/ folder there to own', async () => {
      appState.ui.workspaceMode = 'studio';
      const recordDecision = vi.fn(async () => ({ ok: true }));
      await answerAQuestion('local', recordDecision);

      expect(recordDecision).not.toHaveBeenCalled();
    });

    it('costs the user nothing when the log cannot be written', async () => {
      const recordDecision = vi.fn(async () => {
        throw new Error('storage is gone');
      });
      const service = await answerAQuestion('local', recordDecision);

      // The turn still ran and the fork is still resolved.
      expect(service.getState().status).toBe('idle');
      expect(service.getState().pendingQuestion).toBeNull();
    });
  });

  it('escalates to ask_advisor when the same call repeats twice with the identical result', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c1', { id: 'nope' }))
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c2', { id: 'nope' }))
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c3', { id: 'nope' }))
      .mockResolvedValueOnce(textResult('ok, asking the advisor next time'));
    const execute = vi.fn(async () => ({ ok: false, error: 'unknown skill' }));
    const service = buildService({
      chat,
      execute,
      put: vi.fn(async () => undefined),
      advisorAvailable: true,
      maxToolIterations: 6,
    });

    await service.send('go');

    const state = service.getState();
    // First repeat (message 4) only gets the advisory nudge…
    expect(JSON.stringify(state.messages[4].content)).not.toMatch(/ask_advisor NOW/);
    // …the second repeat gets the directive.
    expect(JSON.stringify(state.messages[6].content)).toMatch(/ask_advisor NOW/);
  });

  it('escalation tells the model to change approach when no advisor is configured', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c1', { id: 'nope' }))
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c2', { id: 'nope' }))
      .mockResolvedValueOnce(toolCallResult('read_skill', 'c3', { id: 'nope' }))
      .mockResolvedValueOnce(textResult('fine'));
    const service = buildService({
      chat,
      execute: vi.fn(async () => ({ ok: false, error: 'unknown skill' })),
      put: vi.fn(async () => undefined),
      maxToolIterations: 6,
    });

    await service.send('go');

    const escalation = JSON.stringify(service.getState().messages[6].content);
    expect(escalation).toMatch(/You are stuck/);
    expect(escalation).toMatch(/Change approach/);
    expect(escalation).not.toMatch(/ask_advisor/);
  });

  it('escalates after three consecutive iterations of nothing but tool errors', async () => {
    let n = 0;
    // Distinct args each time, so this is the error-streak trigger, not the repeat trigger.
    const chat = vi.fn(async () =>
      n < 3
        ? toolCallResult('fs_read', `c${n}`, { path: `missing-${n++}.ts` })
        : textResult('giving up cleanly')
    );
    const execute = vi.fn(async () => {
      throw new Error('File not found');
    });
    const service = buildService({
      chat,
      execute,
      put: vi.fn(async () => undefined),
      maxToolIterations: 6,
    });

    await service.send('read them');

    // Third all-error iteration → message index 6 carries the escalation.
    expect(JSON.stringify(service.getState().messages[6].content)).toMatch(/You are stuck/);
  });

  it('stops at the tool-iteration cap with a notice (not an error)', async () => {
    let n = 0;
    const chat = vi.fn(async () => toolCallResult('scene_tree', `call-${n++}`));
    const execute = vi.fn(async () => ({}));
    const service = buildService({
      chat,
      execute,
      put: vi.fn(async () => undefined),
      maxToolIterations: 3,
    });

    await service.send('loop forever');

    const state = service.getState();
    expect(state.status).toBe('idle');
    // 3 tool iterations + the forced, tools-disabled closing summary: a capped turn must still
    // tell the user what happened instead of stopping mid-work in silence.
    expect(chat).toHaveBeenCalledTimes(4);
    expect((chat.mock.calls[3] as unknown as [ChatParams])[0].tools).toBeUndefined();
    expect(state.notice).toMatch(/3 tool iterations/);
    expect(state.errorMessage).toBeNull();
  });

  it('closes a capped turn with a written summary even when the model kept calling tools', async () => {
    let n = 0;
    const chat = vi.fn(async (params: { tools?: unknown }) =>
      params.tools === undefined
        ? textResult('Here is where the game stands…')
        : toolCallResult('scene_tree', `call-${n++}`)
    );
    const service = buildService({
      chat,
      execute: vi.fn(async () => ({})),
      put: vi.fn(async () => undefined),
      maxToolIterations: 2,
    });

    await service.send('build the thing');

    const last = service.getState().messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(JSON.stringify(last?.content)).toContain('Here is where the game stands');
  });

  it('treats an abort as a clean stop, keeping the partial history', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('scene_tree', 'call-1'))
      .mockRejectedValueOnce(new LlmError('aborted', 'The request was cancelled.'));
    const execute = vi.fn(async () => ({}));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('do something');

    const state = service.getState();
    expect(state.status).toBe('idle');
    expect(state.errorMessage).toBeNull();
    expect(state.messages.length).toBeGreaterThan(0);
  });

  it('surfaces provider errors with their kind (e.g. missing-key)', async () => {
    const chat = vi.fn(async () => {
      throw new LlmError('missing-key', 'No API key configured.');
    });
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');

    const state = service.getState();
    expect(state.status).toBe('error');
    expect(state.errorKind).toBe('missing-key');
    expect(state.errorMessage).toMatch(/No API key/);
  });

  it('retries once on a transient empty response, then recovers the turn', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('empty', 'empty response'))
      .mockResolvedValueOnce(textResult('recovered'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');

    expect(chat).toHaveBeenCalledTimes(2);
    const state = service.getState();
    expect(state.status).toBe('idle');
    expect(state.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    });
  });

  it('surfaces an "empty" error only after the single retry also comes back empty', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('empty', 'empty response'))
      .mockRejectedValueOnce(new LlmError('empty', 'still empty'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');

    expect(chat).toHaveBeenCalledTimes(2);
    const state = service.getState();
    expect(state.status).toBe('error');
    expect(state.errorKind).toBe('empty');
  });

  it('auto-retries a transient http gateway error (502 / upstream failed), then recovers', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('http', 'Upstream request failed', 502))
      .mockResolvedValueOnce(textResult('ok now'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');

    expect(chat).toHaveBeenCalledTimes(2);
    expect(service.getState().status).toBe('idle');
  });

  it('does NOT retry a client http error (404) — surfaces it immediately', async () => {
    const chat = vi.fn(async () => {
      throw new LlmError('http', 'not found', 404);
    });
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');

    expect(chat).toHaveBeenCalledTimes(1);
    const state = service.getState();
    expect(state.status).toBe('error');
    expect(state.errorKind).toBe('http');
  });

  it('resume re-runs the loop on the existing history without appending a user message', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('unknown', 'boom')) // send fails (not auto-retried)
      .mockResolvedValueOnce(textResult('recovered')); // resume succeeds
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hi');
    expect(service.getState().status).toBe('error');
    const afterSend = service.getState().messages.length; // user message only

    await service.resume();

    const state = service.getState();
    expect(state.status).toBe('idle');
    expect(chat).toHaveBeenCalledTimes(2);
    // resume adds ONLY the assistant reply — no extra user turn.
    expect(state.messages).toHaveLength(afterSend + 1);
    expect(state.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    });
  });

  it('lifts tool-emitted __images out of the JSON result into image blocks', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('viewport_screenshot', 'call-1'))
      .mockResolvedValueOnce(textResult('looks good'));
    const execute = vi.fn(async () => ({
      ok: true,
      width: 640,
      __images: [{ mimeType: 'image/jpeg', data: 'QUJD' }],
    }));
    const service = buildService({ chat, execute, put: vi.fn(async () => undefined) });

    await service.send('show me the viewport');

    const toolTurn = service.getState().messages[2];
    expect(toolTurn.role).toBe('user');
    if (typeof toolTurn.content === 'string') throw new Error('expected content blocks');
    const blocks = toolTurn.content;
    // tool-result first (without the base64 payload in its JSON), then the real image block
    expect(blocks[0]).toMatchObject({ type: 'tool-result', toolName: 'viewport_screenshot' });
    if (blocks[0].type !== 'tool-result') throw new Error('expected a tool-result block');
    expect(blocks[0].content).not.toContain('QUJD');
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: 'QUJD' });
  });

  it('keeps tool-emitted images in history but strips them (to a placeholder) for a text-only model', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('viewport_screenshot', 'call-1'))
      .mockResolvedValueOnce(textResult('ok'));
    const execute = vi.fn(async () => ({
      ok: true,
      __images: [{ mimeType: 'image/jpeg', data: 'QUJD' }],
    }));
    const service = buildService({
      chat,
      execute,
      put: vi.fn(async () => undefined),
      supportsImages: false,
    });

    await service.send('show me the viewport');

    // History keeps the real image (so the chat UI shows it to the user).
    const toolTurn = service.getState().messages[2];
    if (typeof toolTurn.content === 'string') throw new Error('expected content blocks');
    expect(toolTurn.content.some(b => b.type === 'image' && b.data === 'QUJD')).toBe(true);

    // The outbound request (2nd chat call) has the image swapped for an analyze_image placeholder.
    const sent = (chat.mock.calls[1][0] as { messages: LlmMessage[] }).messages;
    const sentToolTurn = sent[2];
    if (typeof sentToolTurn.content === 'string') throw new Error('expected content blocks');
    expect(sentToolTurn.content.some(b => b.type === 'image')).toBe(false);
    const placeholder = sentToolTurn.content.find(b => b.type === 'text');
    expect(placeholder && placeholder.type === 'text' ? placeholder.text : '').toMatch(
      /analyze_image/
    );
  });

  it('sends real images to a vision-capable model unchanged', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallResult('viewport_screenshot', 'call-1'))
      .mockResolvedValueOnce(textResult('ok'));
    const execute = vi.fn(async () => ({
      ok: true,
      __images: [{ mimeType: 'image/jpeg', data: 'QUJD' }],
    }));
    const service = buildService({
      chat,
      execute,
      put: vi.fn(async () => undefined),
      supportsImages: true,
    });

    await service.send('show me the viewport');

    const sent = (chat.mock.calls[1][0] as { messages: LlmMessage[] }).messages;
    const sentToolTurn = sent[2];
    if (typeof sentToolTurn.content === 'string') throw new Error('expected content blocks');
    expect(sentToolTurn.content.some(b => b.type === 'image' && b.data === 'QUJD')).toBe(true);
  });

  it('includes AGENTS.md from the project root in the system prompt', async () => {
    const chat = vi.fn().mockResolvedValue(textResult('ok'));
    const readTextFile = vi.fn(async (path: string) => {
      if (path === 'AGENTS.md') return 'Always answer like a pirate.';
      throw new Error('not found');
    });
    const service = buildService({
      chat,
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
      readTextFile,
    });

    await service.send('hi');

    const system = (chat.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain('AGENTS.md');
    expect(system).toContain('Always answer like a pirate.');
    // previewSystemPrompt resolves the same content for the debug viewer.
    expect(await service.previewSystemPrompt()).toContain('Always answer like a pirate.');
  });

  it('gives the agent the Brobot persona by default', async () => {
    const chat = vi.fn().mockResolvedValue(textResult('ok'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });
    await service.send('hi');
    const system = (chat.mock.calls[0][0] as { system: string }).system;
    expect(system.startsWith('You are Brobot')).toBe(true);
    expect(system).toContain('Personality:');
  });

  it("drops the persona block for the 'professional' soul (name Pix3 Agent)", async () => {
    const chat = vi.fn().mockResolvedValue(textResult('ok'));
    const service = buildService({
      chat,
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
      soulId: 'professional',
    });
    await service.send('hi');
    const system = (chat.mock.calls[0][0] as { system: string }).system;
    expect(system.startsWith('You are Pix3 Agent')).toBe(true);
    expect(system).not.toContain('Personality:');
  });

  it('injects a custom soul name and prompt into the system prompt', async () => {
    const chat = vi.fn().mockResolvedValue(textResult('ok'));
    const service = buildService({
      chat,
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
      soulId: 'custom',
      customSoulName: 'Kevin',
      customSoulPrompt: 'You are Kevin, a duck.',
    });
    await service.send('hi');
    const system = (chat.mock.calls[0][0] as { system: string }).system;
    expect(system.startsWith('You are Kevin')).toBe(true);
    expect(system).toContain('Personality:');
    expect(system).toContain('You are Kevin, a duck.');
  });

  it('mentions ask_advisor in the system prompt only when an advisor is configured', async () => {
    const withAdvisor = vi.fn().mockResolvedValue(textResult('ok'));
    await buildService({
      chat: withAdvisor,
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
      advisorAvailable: true,
    }).send('hi');
    expect((withAdvisor.mock.calls[0][0] as { system: string }).system).toContain('ask_advisor');

    const withoutAdvisor = vi.fn().mockResolvedValue(textResult('ok'));
    await buildService({
      chat: withoutAdvisor,
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
    }).send('hi');
    expect((withoutAdvisor.mock.calls[0][0] as { system: string }).system).not.toContain(
      'ask_advisor'
    );
  });

  it('sends pasted/dropped image and text-file attachments in the user turn', async () => {
    const chat = vi.fn(async () => textResult('done'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('look at this', {
      images: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }],
      texts: [{ name: 'notes.txt', content: 'hello world' }],
    });

    const userTurn = service.getState().messages[0];
    expect(userTurn.role).toBe('user');
    if (typeof userTurn.content === 'string') throw new Error('expected content blocks');
    const blocks = userTurn.content;
    expect(blocks[0].type).toBe('text');
    if (blocks[0].type !== 'text') throw new Error('expected a text block');
    expect(blocks[0].text).toContain('look at this');
    expect(blocks[0].text).toContain('notes.txt');
    expect(blocks[0].text).toContain('hello world');
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'QUJD' });
  });

  it('records a per-turn timing/token metric keyed by the assistant message index', async () => {
    const chat = vi.fn(async () => textResult('hi'));
    const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

    await service.send('hello');

    // user is index 0, assistant reply is index 1.
    const metric = service.getState().turnMetrics[1];
    expect(metric).toBeDefined();
    expect(metric.inputTokens).toBe(10);
    expect(metric.outputTokens).toBe(5);
    expect(typeof metric.elapsedMs).toBe('number');
  });

  it('persists the conversation after a turn', async () => {
    const put = vi.fn(async () => undefined);
    const service = buildService({
      chat: vi.fn(async () => textResult('ok')),
      execute: vi.fn(),
      put,
    });

    await service.send('hi');

    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', messages: expect.any(Array) })
    );
  });

  describe('context management', () => {
    /** A tool-call turn that reports a nearly-full context window. */
    const fullContextToolCall = (id: string): LlmResult => ({
      ...toolCallResult('scene_tree', id),
      usage: { inputTokens: 800, outputTokens: 10 },
    });

    it('nudges once at the 60% watermark without touching the history', async () => {
      const chat = vi
        .fn()
        .mockResolvedValueOnce({
          ...toolCallResult('scene_tree', 'c1'),
          usage: { inputTokens: 650, outputTokens: 5 },
        })
        .mockResolvedValueOnce(textResult('done'));
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({})),
        put: vi.fn(async () => undefined),
        contextWindow: 1000,
      });

      await service.send('go');

      const state = service.getState();
      expect(JSON.stringify(state.messages[2].content)).toMatch(/Context is filling/);
      expect(JSON.stringify(state.messages[2].content)).toMatch(/progress\.md/);
      expect(state.compactedAtIndices).toEqual([]);
    });

    it('compacts at 75%: keeps the original request, drops the middle, carries the docs over', async () => {
      const chat = vi
        .fn()
        .mockResolvedValueOnce(fullContextToolCall('c1'))
        .mockResolvedValueOnce(fullContextToolCall('c2'))
        .mockResolvedValueOnce(fullContextToolCall('c3'))
        .mockResolvedValueOnce(fullContextToolCall('c4'))
        // The extra tool-free round-trip that produces the handoff.
        .mockResolvedValueOnce(textResult('DONE: spawner wired. NEXT: score HUD.'))
        .mockResolvedValueOnce(textResult('carrying on'));
      const readTextFile = vi.fn(async (path: string) => {
        if (path === 'design/brief.md') return 'A tapper about coins.';
        throw new Error('not found');
      });
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({ scannedEverything: 'x'.repeat(200) })),
        put: vi.fn(async () => undefined),
        contextWindow: 1000,
        maxToolIterations: 6,
        readTextFile,
      });

      await service.send('build a coin tapper');

      const state = service.getState();
      // The handoff request itself must go out WITHOUT tools (it is a summary, not a work turn).
      expect(chat.mock.calls[4][0].tools).toBeUndefined();
      // History is now: original request, handoff, and the reply that followed it.
      expect(state.messages).toHaveLength(3);
      expect(JSON.stringify(state.messages[0].content)).toContain('build a coin tapper');
      const handoff = JSON.stringify(state.messages[1].content);
      expect(handoff).toContain('DONE: spawner wired');
      expect(handoff).toContain('A tapper about coins.');
      // The bulky middle (tool results) is gone.
      expect(JSON.stringify(state.messages)).not.toContain('scannedEverything');
      expect(state.compactedAtIndices).toEqual([1]);
    });

    it('does not compact a short history, however full the context is', async () => {
      const chat = vi
        .fn()
        .mockResolvedValueOnce(fullContextToolCall('c1'))
        .mockResolvedValueOnce(textResult('done'));
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({})),
        put: vi.fn(async () => undefined),
        contextWindow: 1000,
      });

      await service.send('go');

      // 4 messages < the 8-message floor → the request is still verbatim in the history.
      expect(chat).toHaveBeenCalledTimes(2);
      expect(service.getState().compactedAtIndices).toEqual([]);
      expect(JSON.stringify(service.getState().messages[0].content)).toContain('go');
    });

    it('keeps the full history when the handoff round-trip fails', async () => {
      const chat = vi
        .fn()
        .mockResolvedValueOnce(fullContextToolCall('c1'))
        .mockResolvedValueOnce(fullContextToolCall('c2'))
        .mockResolvedValueOnce(fullContextToolCall('c3'))
        .mockResolvedValueOnce(fullContextToolCall('c4'))
        .mockRejectedValueOnce(new LlmError('unknown', 'handoff failed'))
        .mockResolvedValueOnce(textResult('carrying on with everything'));
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({})),
        put: vi.fn(async () => undefined),
        contextWindow: 1000,
        maxToolIterations: 6,
      });

      await service.send('build a coin tapper');

      const state = service.getState();
      expect(state.status).toBe('idle');
      expect(state.compactedAtIndices).toEqual([]);
      expect(state.messages.length).toBeGreaterThan(8);
    });

    it('emergency-trims old tool results at 90% (in the stored history, not just the wire)', async () => {
      const emergency = (id: string): LlmResult => ({
        ...toolCallResult('scene_tree', id),
        usage: { inputTokens: 950, outputTokens: 5 },
      });
      const chat = vi
        .fn()
        .mockResolvedValueOnce(emergency('c1'))
        .mockResolvedValueOnce(emergency('c2'))
        .mockResolvedValueOnce(emergency('c3'))
        .mockResolvedValueOnce(emergency('c4'))
        // Handoff request fails, so only the trim is observable.
        .mockRejectedValueOnce(new LlmError('unknown', 'no handoff'))
        .mockResolvedValueOnce(textResult('ok'));
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({ hugePayload: 'y'.repeat(300) })),
        put: vi.fn(async () => undefined),
        contextWindow: 1000,
        maxToolIterations: 6,
      });

      await service.send('go');

      const serialized = JSON.stringify(service.getState().messages);
      expect(serialized).toContain('[trimmed]');
      // The most recent results stay readable; only the old ones are dropped.
      expect(serialized.match(/hugePayload/g)?.length ?? 0).toBeLessThan(4);
    });

    it('does nothing at all when the model reports no context window', async () => {
      const chat = vi
        .fn()
        .mockResolvedValueOnce({
          ...toolCallResult('scene_tree', 'c1'),
          usage: { inputTokens: 999_999, outputTokens: 5 },
        })
        .mockResolvedValueOnce(textResult('done'));
      const service = buildService({
        chat,
        execute: vi.fn(async () => ({})),
        put: vi.fn(async () => undefined),
      });

      await service.send('go');

      expect(JSON.stringify(service.getState().messages)).not.toMatch(/Context is filling/);
      expect(service.getState().compactedAtIndices).toEqual([]);
    });
  });

  it('times out a hung provider request, retries once, then surfaces it as a turn error', async () => {
    vi.useFakeTimers();
    try {
      // A request that never settles — the failure mode the timeout exists for.
      const chat = vi.fn((_params: ChatParams) => new Promise<LlmResult>(() => {}));
      const service = buildService({ chat, execute: vi.fn(), put: vi.fn(async () => undefined) });

      const turn = service.send('hi');
      await vi.advanceTimersByTimeAsync(LLM_REQUEST_TIMEOUT_MS); // first attempt times out
      await vi.advanceTimersByTimeAsync(600); // retry backoff
      await vi.advanceTimersByTimeAsync(LLM_REQUEST_TIMEOUT_MS); // retry times out too
      await turn;

      expect(chat).toHaveBeenCalledTimes(2);
      const state = service.getState();
      expect(state.status).toBe('error');
      expect(state.errorMessage).toMatch(/timed out/);
      // The attempt is aborted so the socket is freed…
      expect(chat.mock.calls[0][0].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('wedged-session recovery', () => {
    /** Exactly what {@link AgentChatService.chatWithTimeout} throws when the deadline fires. */
    const timeoutError = (): LlmError =>
      new LlmError('http', 'The model did not respond within 180s — the request timed out.', 408);

    it('recovers automatically after two consecutive timeouts: resets the bridge session and resends once', async () => {
      const resetSessions = vi.fn(async () => true);
      // 2 rejections per whole-turn attempt (the internal chatWithRetry single retry): turn 1 (send),
      // turn 2 (resume — the observed "Try again"), then the auto-recovery's resend succeeds.
      const chat = vi
        .fn()
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce(textResult('recovered after handoff'));
      const service = buildService({
        chat,
        execute: vi.fn(),
        put: vi.fn(async () => undefined),
        apiKeySecretId: 'ai-provider:pix3-bridge:token',
        resetSessions,
      });

      await service.send('hi');
      expect(service.getState().status).toBe('error'); // 1st timeout: plain "Try again", no recovery yet

      await service.resume(); // the manual "Try again" from the observed bug

      expect(chat).toHaveBeenCalledTimes(5);
      expect(resetSessions).toHaveBeenCalledTimes(1);
      const state = service.getState();
      expect(state.status).toBe('idle');
      // Fresh conversation: a plain-language notice, the resent message (+ handoff), then the reply.
      expect(state.messages).toHaveLength(3);
      expect(state.messages[0].role).toBe('assistant');
      expect(JSON.stringify(state.messages[0])).toMatch(/fresh conversation/);
      expect(JSON.stringify(state.messages[1])).toContain('hi');
      expect(state.messages[2]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered after handoff' }],
      });
    });

    it('proceeds with the fresh-conversation handoff even when the bridge reset call fails (old/unreachable bridge)', async () => {
      const resetSessions = vi.fn(async () => {
        throw new Error('404 Not Found');
      });
      const chat = vi
        .fn()
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce(textResult('recovered anyway'));
      const service = buildService({
        chat,
        execute: vi.fn(),
        put: vi.fn(async () => undefined),
        apiKeySecretId: 'ai-provider:pix3-bridge:token',
        resetSessions,
      });

      await service.send('hi');
      await service.resume();

      expect(resetSessions).toHaveBeenCalledTimes(1);
      const state = service.getState();
      expect(state.status).toBe('idle');
      expect(state.messages).toHaveLength(3);
      expect(state.messages[2]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered anyway' }],
      });
    });

    it('a success between two timeouts resets the counter, so the next timeout does not trigger recovery', async () => {
      const resetSessions = vi.fn(async () => true);
      const chat = vi
        .fn()
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce(textResult('all good'))
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError());
      const service = buildService({
        chat,
        execute: vi.fn(),
        put: vi.fn(async () => undefined),
        apiKeySecretId: 'ai-provider:pix3-bridge:token',
        resetSessions,
      });

      await service.send('hi'); // timeout #1
      expect(service.getState().status).toBe('error');

      await service.resume(); // succeeds — resets the streak
      expect(service.getState().status).toBe('idle');

      await service.resume(); // timeout again, but the streak is back to 1 — no recovery
      const state = service.getState();
      expect(state.status).toBe('error');
      expect(state.errorMessage).toMatch(/timed out/);
      expect(resetSessions).not.toHaveBeenCalled();
    });

    it('a timeout in the recovered conversation surfaces the honest failure instead of looping', async () => {
      const resetSessions = vi.fn(async () => true);
      // Every attempt times out — including the auto-recovery's own resend.
      const chat = vi.fn(async () => {
        throw timeoutError();
      });
      const service = buildService({
        chat,
        execute: vi.fn(),
        put: vi.fn(async () => undefined),
        apiKeySecretId: 'ai-provider:pix3-bridge:token',
        resetSessions,
      });

      await service.send('hi'); // 2 calls, timeout #1
      await service.resume(); // 2 calls, timeout #2 -> triggers recovery -> resend also times out (2 calls)

      const state = service.getState();
      expect(state.status).toBe('error');
      expect(state.errorMessage).toMatch(/timed out/);
      expect(chat).toHaveBeenCalledTimes(6);
      // Recovery was attempted exactly once, never a second time on the recovered conversation's own timeout.
      expect(resetSessions).toHaveBeenCalledTimes(1);
    });

    it('does not attempt a bridge reset for a non-bridge provider, but still recovers with a fresh conversation', async () => {
      const resetSessions = vi.fn(async () => true);
      const chat = vi
        .fn()
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValueOnce(textResult('recovered'));
      const service = buildService({
        chat,
        execute: vi.fn(),
        put: vi.fn(async () => undefined),
        // Default apiKeySecretId — not the bridge token (e.g. a direct Gemini call).
        resetSessions,
      });

      await service.send('hi');
      await service.resume();

      expect(resetSessions).not.toHaveBeenCalled();
      const state = service.getState();
      expect(state.status).toBe('idle');
      expect(state.messages).toHaveLength(3);
    });
  });

  it('composeFix starts a fresh conversation and prefills subscribed composers', async () => {
    const service = buildService({
      chat: vi.fn(async () => textResult('ok')),
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
    });
    // Seed a conversation, then a fix request must clear it and hand the prompt to the composer.
    await service.send('hi');
    expect(service.getState().messages.length).toBeGreaterThan(0);

    const received: string[] = [];
    service.subscribeCompose(text => received.push(text));
    await service.composeFix('Fix this runtime error: boom');

    expect(service.getState().messages).toHaveLength(0);
    expect(service.getState().activeConversationId).toBeNull();
    expect(received).toEqual(['Fix this runtime error: boom']);
  });

  it('composeContext stages a keyed chip without touching the conversation', async () => {
    const service = buildService({
      chat: vi.fn(async () => textResult('ok')),
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
    });
    await service.send('hi');
    const before = service.getState().messages.length;
    expect(before).toBeGreaterThan(0);

    // Raised before anyone subscribed — must survive until the panel mounts, and the second chip of
    // the same slot must evict the first one there too (only the latest selection is context).
    service.composeContext({
      attachment: { name: 'design/gdd.md:3-3', content: 'first' },
      replaceKey: 'idea-doc:design/gdd.md',
    });
    service.composeContext({
      attachment: { name: 'design/gdd.md:5-7', content: 'second' },
      replaceKey: 'idea-doc:design/gdd.md',
    });

    const received: ComposeContextRequest[] = [];
    service.subscribeComposeContext(request => received.push(request));
    service.composeContext({ attachment: { name: 'notes.md:1-2', content: 'other' } });

    expect(received.map(r => r.attachment?.name)).toEqual(['design/gdd.md:5-7', 'notes.md:1-2']);
    // The chip joins the ongoing discussion — unlike composeFix, nothing was reset.
    expect(service.getState().messages).toHaveLength(before);

    // The context it stood for is gone — the slot is retracted, the unkeyed chip is untouched.
    service.clearComposeContext('idea-doc:design/gdd.md');
    expect(received[2]).toEqual({ attachment: null, replaceKey: 'idea-doc:design/gdd.md' });
  });

  it('clearComposeContext drops a chip still queued instead of delivering it', async () => {
    const service = buildService({
      chat: vi.fn(async () => textResult('ok')),
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
    });
    service.composeContext({
      attachment: { name: 'design/gdd.md:3-3', content: 'slice' },
      replaceKey: 'idea-doc:design/gdd.md',
    });
    service.clearComposeContext('idea-doc:design/gdd.md');

    const received: ComposeContextRequest[] = [];
    service.subscribeComposeContext(request => received.push(request));
    // Nothing to undo on mount: the queued chip left with the selection.
    expect(received).toEqual([]);
  });

  it('composeFix queues the prompt when no composer is subscribed yet', async () => {
    const service = buildService({
      chat: vi.fn(async () => textResult('ok')),
      execute: vi.fn(),
      put: vi.fn(async () => undefined),
    });
    await service.composeFix('deferred prompt');

    const received: string[] = [];
    service.subscribeCompose(text => received.push(text));
    expect(received).toEqual(['deferred prompt']);
  });
});
