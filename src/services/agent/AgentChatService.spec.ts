import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '@/state';
import { AgentChatService } from './AgentChatService';
import { LlmError, type LlmMessage, type LlmResult } from '@/services/llm/LlmTypes';

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
  /** When true, the advisor service resolves (the ask_advisor rule joins the system prompt). */
  advisorAvailable?: boolean;
  /** Soul preferences shaping the system-prompt persona. Defaults to the Brobot preset. */
  soulId?: string;
  customSoulName?: string;
  customSoulPrompt?: string;
}

/** Build a service with fake dependencies injected in place of the DI-resolved ones. */
const buildService = (fakes: Fakes): AgentChatService => {
  const service = new AgentChatService();
  const provider = { id: 'fake', chat: fakes.chat };
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
        fakes.supportsImages === undefined
          ? undefined
          : { capabilities: { supportsImages: fakes.supportsImages } },
    },
    toolRegistry: { specs: () => [], execute: fakes.execute },
    advisorService: {
      resolveAdvisor: async () =>
        fakes.advisorAvailable ? { modelId: 'adv-model', apiKey: 'k' } : null,
    },
    historyStore: {
      list: async () => [],
      get: async () => undefined,
      put: fakes.put,
      delete: async () => undefined,
    },
    sceneManager: { getActiveSceneGraph: () => null },
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
    expect(chat).toHaveBeenCalledTimes(3);
    expect(state.notice).toMatch(/3 tool iterations/);
    expect(state.errorMessage).toBeNull();
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
