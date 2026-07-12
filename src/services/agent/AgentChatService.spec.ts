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
      getPreferences: () => ({
        selectedProviderId: 'fake',
        modelByProvider: {},
        customBaseUrl: '',
        maxToolIterations: fakes.maxToolIterations ?? 5,
      }),
    },
    toolRegistry: { specs: () => [], execute: fakes.execute },
    historyStore: { get: async () => undefined, put: fakes.put, delete: async () => undefined },
    sceneManager: { getActiveSceneGraph: () => null },
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

  it('persists the conversation after a turn', async () => {
    const put = vi.fn(async () => undefined);
    const service = buildService({
      chat: vi.fn(async () => textResult('ok')),
      execute: vi.fn(),
      put,
    });

    await service.send('hi');

    expect(put).toHaveBeenCalledWith('proj-1', expect.any(Array));
  });
});
