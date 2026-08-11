import { describe, expect, it, vi } from 'vitest';
import {
  StropheImageProvider,
  buildParameters,
  matchEnumValue,
  toImageGenError,
} from './StropheImageProvider';
import { ImageGenError } from './ImageGenTypes';
import { StropheError, type StropheFamilyDetail } from '@/services/strophe/StropheTypes';

const BASE = 'https://strophe.test/api/v1';

/**
 * A `fetch` stub that still exposes `.mock`. The handler signature we want to write (url as a plain
 * string) is narrower than the real `fetch` overloads, so the cast lives here once instead of at
 * every call site.
 */
type FetchMock = ReturnType<typeof vi.fn> & typeof fetch;

const mockFetch = (handler?: (url: string, init?: RequestInit) => Promise<Response>): FetchMock =>
  (handler ? vi.fn(handler) : vi.fn()) as unknown as FetchMock;

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Real shape of `GET /families/gpt-image-2` (trimmed), so the mapping is tested against the truth. */
const GPT_IMAGE_2: StropheFamilyDetail = {
  id: 'gpt-image-2',
  name: 'GPT Image 2',
  outputType: 'image',
  available: true,
  generationTime: 44,
  maxInputs: { images: 4 },
  price: { credits: 4, unit: 'generation' },
  parameters: [
    { name: 'prompt', type: 'string' },
    { name: 'quality', type: 'enum', values: ['low', 'medium', 'high'], default: 'low' },
    {
      name: 'aspectRatio',
      type: 'enum',
      values: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'],
      default: '1:1',
    },
  ],
};

/** Seedream spells sizes `2K`/`3K` and has no `quality` — the case that catches naive mapping. */
const SEEDREAM: StropheFamilyDetail = {
  id: 'seedream-v5',
  name: 'Seedream 5.0',
  outputType: 'image',
  available: true,
  parameters: [
    { name: 'prompt', type: 'string' },
    { name: 'resolution', type: 'enum', values: ['2K', '3K'], default: '2K' },
    { name: 'aspectRatio', type: 'enum', values: ['1:1', '16:9'], default: '1:1' },
  ],
};

describe('matchEnumValue', () => {
  it("returns the family's own spelling, matched case-insensitively", () => {
    const resolution = SEEDREAM.parameters!.find(p => p.name === 'resolution');
    expect(matchEnumValue(resolution, '2k')).toBe('2K');
    expect(matchEnumValue(resolution, '2K')).toBe('2K');
    expect(matchEnumValue(resolution, ' 3k ')).toBe('3K');
  });

  it('returns null for unsupported values and for parameters the family does not declare', () => {
    const resolution = SEEDREAM.parameters!.find(p => p.name === 'resolution');
    expect(matchEnumValue(resolution, '4K')).toBeNull();
    expect(matchEnumValue(undefined, '2K')).toBeNull();
    expect(matchEnumValue({ name: 'x', type: 'string', values: null }, 'v')).toBeNull();
  });
});

describe('buildParameters', () => {
  it('sends only what the family declares — Strophe rejects unknown keys outright', () => {
    const params = buildParameters(GPT_IMAGE_2, {
      prompt: 'crate',
      aspectRatio: '16:9',
      quality: 'high',
      // gpt-image-2 has no `resolution` knob, so this must not be forwarded.
      imageSize: '2K',
    });
    expect(params).toEqual({ aspectRatio: '16:9', quality: 'high' });
    expect(params).not.toHaveProperty('resolution');
  });

  it("omits aspectRatio for 'Auto' so the model decides", () => {
    expect(buildParameters(GPT_IMAGE_2, { prompt: 'x', aspectRatio: 'Auto' })).toEqual({});
  });

  it('normalizes size casing per family and drops sizes a family cannot do', () => {
    expect(buildParameters(SEEDREAM, { prompt: 'x', imageSize: '2k' })).toEqual({
      resolution: '2K',
    });
    // The shared default of '1K' is meaningless for Seedream (2K/3K) — fall back to its own default.
    expect(buildParameters(SEEDREAM, { prompt: 'x', imageSize: '1K' })).toEqual({});
  });

  it('drops a quality tier for families with no quality knob', () => {
    expect(buildParameters(SEEDREAM, { prompt: 'x', quality: 'high' })).toEqual({});
  });

  it('handles a family that declares no parameters at all', () => {
    const utility: StropheFamilyDetail = {
      id: 'bria-bg-remove',
      name: 'Bria Background Remove',
      outputType: 'image',
      available: true,
      parameters: [],
    };
    expect(buildParameters(utility, { prompt: 'x', aspectRatio: '1:1', quality: 'high' })).toEqual(
      {}
    );
  });
});

describe('toImageGenError', () => {
  it('maps out-of-credits to the billing kind, not http — the fix is topping up, not retrying', () => {
    const mapped = toImageGenError(
      new StropheError('insufficient_credits', 'Out of credits.', { status: 402 })
    );
    expect(mapped.kind).toBe('billing');
    expect(mapped.status).toBe(402);
  });

  it('maps spend-limit and cost-ceiling refusals to billing as well', () => {
    expect(toImageGenError(new StropheError('spend_limit_exceeded', 'daily cap')).kind).toBe(
      'billing'
    );
    expect(toImageGenError(new StropheError('cost_above_limit', 'too expensive')).kind).toBe(
      'billing'
    );
  });

  it('maps key/scope/plan problems to missing-key so the UI points at Settings', () => {
    for (const code of ['invalid_token', 'insufficient_scope', 'team_required'] as const) {
      expect(toImageGenError(new StropheError(code, 'nope')).kind).toBe('missing-key');
    }
  });

  it('maps a content-policy generation failure to blocked, other failures to http', () => {
    const blocked = toImageGenError(
      new StropheError('generation_failed', 'Blocked.', {
        details: { failureCode: 'content_policy' },
      })
    );
    expect(blocked.kind).toBe('blocked');

    const upstream = toImageGenError(
      new StropheError('generation_failed', 'Upstream died.', {
        details: { failureCode: 'provider_error' },
      })
    );
    expect(upstream.kind).toBe('http');
  });

  it('maps cancellation and network failures, and passes our own errors through', () => {
    expect(toImageGenError(new DOMException('x', 'AbortError')).kind).toBe('aborted');
    expect(toImageGenError(new StropheError('aborted', 'cancelled')).kind).toBe('aborted');
    expect(toImageGenError(new StropheError('network', 'offline')).kind).toBe('network');
    const own = new ImageGenError('empty', 'nothing came back');
    expect(toImageGenError(own)).toBe(own);
    expect(toImageGenError('a bare string').kind).toBe('unknown');
  });
});

describe('StropheImageProvider', () => {
  const provider = new StropheImageProvider();

  it('declares no proxy requirement and no native transparency', () => {
    // CORS on both the API and the delivery URLs is why this provider needs no proxy at all.
    for (const model of provider.models) {
      expect(model.capabilities.requiresProxy).toBe(false);
      // Strophe exposes no transparency flag, so cutouts must route through local bg-removal.
      expect(model.capabilities.supportsTransparency).toBe(false);
    }
    expect(provider.getModel('gpt-image-2')).toBeDefined();
    expect(provider.getModel('nope')).toBeUndefined();
  });

  it('rejects a missing key before touching the network', async () => {
    const fetchImpl = mockFetch();
    await expect(
      provider.generate({ prompt: 'x' }, { apiKey: '', modelId: 'flux', fetchImpl })
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the full flow: family schema → generation → download → base64', async () => {
    const fetchImpl = mockFetch(async url => {
      const href = String(url);
      if (href.includes('/families/')) {
        return okJson(GPT_IMAGE_2);
      }
      if (href.endsWith('/generations')) {
        return okJson({
          generationId: 'gen_1',
          state: 'queued',
          creditsReserved: 4,
          replayed: false,
        });
      }
      if (href.includes('/generations/')) {
        return okJson({
          generationId: 'gen_1',
          state: 'ready',
          familyId: 'gpt-image-2',
          outputType: 'image',
          createdAt: 'now',
          creditsReserved: 4,
          creditsCharged: 4,
          result: {
            url: 'https://strophe.test/f/abc',
            expiresInSeconds: 86400,
            mimeType: 'image/png',
            reusableAs: ['imageIds'],
          },
        });
      }
      return new Response(new Uint8Array([104, 105]), { status: 200 });
    });

    const result = await provider.generate(
      { prompt: 'isometric crate', aspectRatio: '16:9', quality: 'high' },
      { apiKey: 'str_k', modelId: 'gpt-image-2', baseUrl: BASE, fetchImpl }
    );

    const createCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith('/generations')
    ) as unknown as [string, RequestInit];
    const body = JSON.parse(createCall[1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      familyId: 'gpt-image-2',
      prompt: 'isometric crate',
      parameters: { aspectRatio: '16:9', quality: 'high' },
    });
    // No reference images were passed, so no imageIds key at all (their schema is strict).
    expect(body).not.toHaveProperty('imageIds');

    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe('image/png');
    expect(result.images[0].data).toBe('aGk='); // "hi"
  });

  it('fans out one generation per requested image, since Strophe has no count parameter', async () => {
    let creates = 0;
    const idempotencyKeys: string[] = [];
    const fetchImpl = mockFetch(async (url, init) => {
      const href = String(url);
      if (href.includes('/families/')) {
        return okJson({ ...GPT_IMAGE_2, id: 'flux', parameters: [] });
      }
      if (href.endsWith('/generations')) {
        creates += 1;
        const key = (init?.headers as Record<string, string>)['Idempotency-Key'];
        idempotencyKeys.push(key);
        return okJson({
          generationId: `gen_${creates}`,
          state: 'queued',
          creditsReserved: 1,
          replayed: false,
        });
      }
      if (href.includes('/generations/')) {
        return okJson({
          generationId: 'gen_x',
          state: 'ready',
          familyId: 'flux',
          outputType: 'image',
          createdAt: 'now',
          creditsReserved: 1,
          creditsCharged: 1,
          result: {
            url: 'https://strophe.test/f/x',
            expiresInSeconds: 1000,
            mimeType: 'image/jpeg',
            reusableAs: [],
          },
        });
      }
      return new Response(new Uint8Array([104, 105]), { status: 200 });
    });

    const result = await provider.generate(
      { prompt: 'x', count: 3 },
      { apiKey: 'str_k', modelId: 'flux', baseUrl: BASE, fetchImpl }
    );

    expect(creates).toBe(3);
    expect(result.images).toHaveLength(3);
    // Distinct keys, or a network retry of one request would replay a sibling instead of itself.
    expect(new Set(idempotencyKeys).size).toBe(3);
  });

  it('uploads reference images and passes their ids in order', async () => {
    let uploads = 0;
    const fetchImpl = mockFetch(async url => {
      const href = String(url);
      if (href.includes('/families/')) {
        return okJson(GPT_IMAGE_2);
      }
      if (href.endsWith('/files')) {
        uploads += 1;
        return okJson({
          fileId: `file_${uploads}`,
          fileName: 'r.png',
          mimeType: 'image/png',
          size: 2,
          state: 'ready',
        });
      }
      if (href.endsWith('/generations')) {
        return okJson({
          generationId: 'gen_1',
          state: 'queued',
          creditsReserved: 6,
          replayed: false,
        });
      }
      if (href.includes('/generations/')) {
        return okJson({
          generationId: 'gen_1',
          state: 'ready',
          familyId: 'gpt-image-2',
          outputType: 'image',
          createdAt: 'now',
          creditsReserved: 6,
          creditsCharged: 6,
          result: {
            url: 'https://strophe.test/f/abc',
            expiresInSeconds: 100,
            mimeType: 'image/png',
            reusableAs: [],
          },
        });
      }
      return new Response(new Uint8Array([104, 105]), { status: 200 });
    });

    await provider.generate(
      {
        prompt: 'edit this',
        references: [
          { mimeType: 'image/png', data: 'aGk=' },
          { mimeType: 'image/png', data: 'aGk=' },
        ],
      },
      { apiKey: 'str_k', modelId: 'gpt-image-2', baseUrl: BASE, fetchImpl }
    );

    expect(uploads).toBe(2);
    const createCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith('/generations')
    ) as unknown as [string, RequestInit];
    const body = JSON.parse(createCall[1].body as string) as { imageIds: string[] };
    expect(body.imageIds).toEqual(['file_1', 'file_2']);
  });

  it('refuses an unavailable family with its lock reason instead of spending a request', async () => {
    const fetchImpl = mockFetch(async () =>
      okJson({ ...GPT_IMAGE_2, available: false, lockReason: 'Upgrade required' })
    );

    await expect(
      provider.generate(
        { prompt: 'x' },
        { apiKey: 'str_k', modelId: 'seedream-v5', baseUrl: BASE, fetchImpl }
      )
    ).rejects.toMatchObject({ kind: 'http' });
    // Only the family lookup happened — no generation was created.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
