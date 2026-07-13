import { describe, expect, it, vi } from 'vitest';
import { AgentAdvisorService } from './AgentAdvisorService';
import type { LlmResult } from '@/services/llm/LlmTypes';

interface Fakes {
  advisorProviderId?: string;
  advisorModelId?: string;
  apiKey?: string | null;
  chat?: ReturnType<typeof vi.fn>;
}

/** Build a service with fake dependencies injected in place of the DI-resolved ones. */
const buildService = (
  fakes: Fakes = {}
): { service: AgentAdvisorService; chat: ReturnType<typeof vi.fn> } => {
  const chat =
    fakes.chat ??
    vi.fn(
      async (): Promise<LlmResult> => ({
        content: [{ type: 'text', text: 'advice' }],
        stopReason: 'end_turn',
      })
    );
  const provider = { id: 'cerebras', label: 'Cerebras', chat };
  const service = new AgentAdvisorService();
  const overrides: Record<string, unknown> = {
    settings: {
      getPreferences: () => ({
        advisorProviderId: fakes.advisorProviderId ?? '',
        advisorModelId: fakes.advisorModelId ?? '',
      }),
      getSelectedModelId: () => 'selected-model',
      getApiKey: async () => fakes.apiKey ?? null,
      getBaseUrl: () => undefined,
    },
    registry: { get: (id: string) => (id === 'cerebras' ? provider : undefined) },
    catalog: { getModel: () => ({ label: 'GLM 4.7' }) },
  };
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(service, key, { value, configurable: true });
  }
  return { service, chat };
};

describe('AgentAdvisorService', () => {
  it('is off by default (no provider configured resolves to null)', async () => {
    const { service } = buildService({ apiKey: 'k' });
    expect(await service.resolveAdvisor()).toBeNull();
    expect(await service.describeAdvisor()).toBeNull();
  });

  it('resolves null when the configured provider has no API key', async () => {
    const { service } = buildService({ advisorProviderId: 'cerebras', apiKey: null });
    expect(await service.resolveAdvisor()).toBeNull();
  });

  it('falls back to the provider-selected model when no advisor model is set', async () => {
    const { service } = buildService({ advisorProviderId: 'cerebras', apiKey: 'k' });
    const advisor = await service.resolveAdvisor();
    expect(advisor?.modelId).toBe('selected-model');
  });

  it('consult sends question + context to the configured model and returns the text', async () => {
    const { service, chat } = buildService({
      advisorProviderId: 'cerebras',
      advisorModelId: 'zai-glm-4.7',
      apiKey: 'k',
    });

    const answer = await service.consult('Why does the car not move?', 'CarController.ts: ...');

    expect(answer).toBe('advice');
    const [request, options] = chat.mock.calls[0] as [
      { messages: Array<{ content: Array<{ type: string; text: string }> }>; system: string },
      { modelId: string; apiKey: string },
    ];
    expect(options.modelId).toBe('zai-glm-4.7');
    expect(options.apiKey).toBe('k');
    const body = request.messages[0].content[0].text;
    expect(body).toContain('Why does the car not move?');
    expect(body).toContain('CarController.ts');
    expect(request.system).toMatch(/advisor/i);
  });

  it('consult throws a friendly error when no advisor is configured', async () => {
    const { service } = buildService();
    await expect(service.consult('q', 'ctx')).rejects.toThrow(/No advisor model is configured/);
  });
});
