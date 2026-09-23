import { describe, expect, it, vi } from 'vitest';

import type { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import { CodexImageProvider } from './CodexImageProvider';

const bridge = () =>
  ({
    hasToken: vi.fn(async () => true),
    getToken: vi.fn(async () => 'paired-token'),
    getBridgeUrl: vi.fn(() => 'http://127.0.0.1:8484'),
    getEntries: vi.fn(() => [
      {
        id: 'codex',
        kind: 'agent-cli',
        status: { available: true, auth: 'ok', imageGeneration: true },
      },
    ]),
  }) as unknown as BridgeConnectionService;

describe('CodexImageProvider', () => {
  it('requires a paired, signed-in Codex bridge lane', async () => {
    const connected = bridge();
    const provider = new CodexImageProvider(() => connected);
    expect(provider.requiresApiKey).toBe(false);
    expect(await provider.isAvailable()).toBe(true);
    vi.spyOn(connected, 'getEntries').mockReturnValue([]);
    expect(await provider.isAvailable()).toBe(false);
  });

  it('passes prompt and image options to the local bridge and returns raster data', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
            revisedPrompt: 'a red square',
          }),
          { status: 200 }
        )
    );
    const provider = new CodexImageProvider(bridge);
    const result = await provider.generate(
      {
        prompt: ' red square ',
        aspectRatio: '1:1',
        background: 'transparent',
        references: [{ mimeType: 'image/png', data: 'abc' }],
      },
      { apiKey: '', modelId: 'default', fetchImpl }
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8484/agents/codex/v1/images');
    expect((init.headers as Record<string, string>)['x-pix3-bridge-token']).toBe('paired-token');
    expect(JSON.parse(init.body as string)).toMatchObject({
      prompt: 'red square',
      aspectRatio: '1:1',
      transparent: true,
      references: [{ mimeType: 'image/png', data: 'abc' }],
    });
    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
  });

  it('surfaces the Codex usage limit', async () => {
    const provider = new CodexImageProvider(bridge);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'Codex image generation limit reached.' },
          }),
          { status: 429 }
        )
    );
    await expect(
      provider.generate(
        { prompt: 'test' },
        {
          apiKey: '',
          modelId: 'default',
          fetchImpl,
        }
      )
    ).rejects.toMatchObject({ kind: 'billing', status: 429 });
  });
});
