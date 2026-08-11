import { describe, expect, it, vi } from 'vitest';
import {
  StropheApiClient,
  clampPollSeconds,
  extForMime,
  failureToError,
  isTerminal,
  parseErrorEnvelope,
  progressFromElapsed,
} from './StropheApiClient';
import { StropheError, type StropheGeneration } from './StropheTypes';

const BASE = 'https://strophe.test/api/v1';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const errJson = (status: number, error: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const client = (fetchImpl: typeof fetch, token = 'str_test') =>
  new StropheApiClient({ auth: { getToken: () => token }, baseUrl: BASE, fetchImpl });

const READY: StropheGeneration = {
  generationId: 'gen_1',
  state: 'ready',
  familyId: 'flux',
  modelId: 'flux-schnell',
  outputType: 'image',
  createdAt: '2026-08-11T14:43:44Z',
  completedAt: '2026-08-11T14:43:48Z',
  creditsReserved: 1,
  creditsCharged: 1,
  result: {
    url: 'https://strophe.test/f/abc',
    expiresInSeconds: 86400,
    mimeType: 'image/jpeg',
    width: 1024,
    height: 1024,
    reusableAs: ['imageIds'],
  },
};

describe('progressFromElapsed', () => {
  it('approaches but never reaches 100 so only a terminal state can complete the bar', () => {
    expect(progressFromElapsed(0, 60)).toBe(0);
    expect(progressFromElapsed(60_000, 60)).toBeGreaterThan(50);
    expect(progressFromElapsed(60_000, 60)).toBeLessThan(70);
    // Far past the estimate it still creeps rather than sticking or overflowing.
    expect(progressFromElapsed(600_000, 60)).toBe(95);
  });

  it('is monotonic and falls back to a default estimate when the catalog has none', () => {
    const a = progressFromElapsed(5_000, undefined);
    const b = progressFromElapsed(20_000, undefined);
    expect(b).toBeGreaterThan(a);
  });
});

describe('clampPollSeconds', () => {
  it('keeps the server hint inside a sane window and defaults when absent', () => {
    expect(clampPollSeconds(2)).toBe(2);
    expect(clampPollSeconds(undefined)).toBe(3);
    expect(clampPollSeconds(0)).toBe(1);
    expect(clampPollSeconds(600)).toBe(10);
    expect(clampPollSeconds(Number.NaN)).toBe(3);
  });
});

describe('isTerminal', () => {
  it('treats only ready/failed/cancelled as terminal', () => {
    expect(isTerminal('ready')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    // `finalizing` is still in flight — polling must not stop there or the result is missed.
    expect(isTerminal('finalizing')).toBe(false);
  });
});

describe('parseErrorEnvelope', () => {
  it('preserves the machine-readable code and classifies billing blocks', () => {
    const error = parseErrorEnvelope(
      { error: { code: 'insufficient_credits', message: 'Out of credits.', retryable: false } },
      { status: 402 }
    );
    expect(error.code).toBe('insufficient_credits');
    expect(error.isBillingBlock).toBe(true);
    expect(error.isAuthProblem).toBe(false);
    expect(error.retryable).toBe(false);
  });

  it('classifies auth problems including the team-plan gate', () => {
    for (const code of ['invalid_token', 'insufficient_scope', 'team_required'] as const) {
      const error = parseErrorEnvelope({ error: { code, message: 'no' } }, { status: 403 });
      expect(error.isAuthProblem).toBe(true);
    }
  });

  it('synthesizes a code and a retryable flag when the body is not their envelope', () => {
    const error = parseErrorEnvelope({ rawText: '<html>502</html>' }, { status: 502 });
    expect(error.code).toBe('service_unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('502');
  });

  it('carries Retry-After and the request id for support', () => {
    const error = parseErrorEnvelope(
      { error: { code: 'rate_limited', message: 'slow down', retryable: true } },
      { status: 429, retryAfterSeconds: 7, requestId: 'req_9' }
    );
    expect(error.options.retryAfterSeconds).toBe(7);
    expect(error.options.requestId).toBe('req_9');
  });
});

describe('failureToError', () => {
  it('keeps the failure class in details so callers can single out moderation', () => {
    const error = failureToError({
      ...READY,
      state: 'failed',
      result: undefined,
      error: {
        code: 'content_policy',
        reason: 'nsfw',
        message: 'Blocked by the safety filter.',
        retryable: false,
        hint: 'Rephrase the prompt.',
      },
    });
    expect(error.code).toBe('generation_failed');
    expect(error.options.details?.failureCode).toBe('content_policy');
    expect(error.message).toContain('Rephrase the prompt.');
  });

  it('still produces a message when a failed generation carries no error object', () => {
    const error = failureToError({ ...READY, state: 'failed', result: undefined });
    expect(error.message).toContain('without a reported reason');
  });
});

describe('extForMime', () => {
  it('maps the types we upload', () => {
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('model/gltf-binary')).toBe('glb');
    expect(extForMime('')).toBe('bin');
  });
});

describe('StropheApiClient.request', () => {
  it('sends the bearer token and refuses to call without one', async () => {
    const fetchImpl = vi.fn(async () => okJson({ availableCredits: 10 }));
    await client(fetchImpl as unknown as typeof fetch).getAccount();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/account`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer str_test');

    const empty = new StropheApiClient({ auth: { getToken: () => '' }, baseUrl: BASE });
    await expect(empty.getAccount()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('retries once when onUnauthorized reports a refreshed credential', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errJson(401, { code: 'invalid_token', message: 'expired' }))
      .mockResolvedValueOnce(okJson({ availableCredits: 5 }));
    const onUnauthorized = vi.fn(async () => true);

    const withRefresh = new StropheApiClient({
      auth: { getToken: () => 'tok', onUnauthorized },
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(withRefresh.getAccount()).resolves.toMatchObject({ availableCredits: 5 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces the 401 when the credential cannot be refreshed, without a second attempt', async () => {
    const fetchImpl = vi.fn(async () =>
      errJson(401, { code: 'invalid_token', message: 'revoked' })
    );
    const withRefresh = new StropheApiClient({
      auth: { getToken: () => 'tok', onUnauthorized: async () => false },
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(withRefresh.getAccount()).rejects.toMatchObject({ code: 'invalid_token' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('unwraps the families envelope', async () => {
    const fetchImpl = vi.fn(async () => okJson({ data: [{ id: 'flux', available: true }] }));
    const families = await client(fetchImpl as unknown as typeof fetch).listFamilies({
      outputType: '3d',
    });
    expect(families).toHaveLength(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      `${BASE}/families?outputType=3d`
    );
  });
});

describe('StropheApiClient.runGeneration', () => {
  it('always sends an Idempotency-Key so a retried create cannot double-charge', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('/generations/')
        ? okJson(READY)
        : okJson({ generationId: 'gen_1', state: 'queued', creditsReserved: 1, replayed: false })
    );

    await client(fetchImpl as unknown as typeof fetch).runGeneration({ familyId: 'flux' });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('polls through non-terminal states and reports interpolated progress', async () => {
    const states = ['queued', 'running', 'finalizing'];
    let poll = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (!String(url).includes('/generations/')) {
        return okJson({
          generationId: 'gen_1',
          state: 'queued',
          creditsReserved: 1,
          replayed: false,
        });
      }
      const state = states[poll++];
      // `pollAfterSeconds: 0` is clamped to 1 s; the fake timers below keep the test instant.
      return state
        ? okJson({ ...READY, state, result: undefined, pollAfterSeconds: 0 })
        : okJson(READY);
    });

    vi.useFakeTimers();
    try {
      const onProgress = vi.fn();
      const promise = client(fetchImpl as unknown as typeof fetch).runGeneration(
        { familyId: 'flux' },
        { onProgress, etaSeconds: 7 }
      );
      await vi.runAllTimersAsync();
      const generation = await promise;

      expect(generation.state).toBe('ready');
      expect(generation.creditsCharged).toBe(1);
      // One call per non-terminal poll, plus the initial 0 and the final 100.
      expect(onProgress.mock.calls[0]).toEqual([0, 'queued']);
      expect(onProgress.mock.calls.at(-1)).toEqual([100, 'ready']);
      expect(onProgress.mock.calls.some(([, state]) => state === 'finalizing')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a typed error for a failed generation and never returns a resultless success', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('/generations/')
        ? okJson({
            ...READY,
            state: 'failed',
            result: undefined,
            error: {
              code: 'content_policy',
              reason: 'nsfw',
              message: 'Blocked.',
              retryable: false,
              hint: '',
            },
          })
        : okJson({ generationId: 'gen_1', state: 'queued', creditsReserved: 1, replayed: false })
    );

    await expect(
      client(fetchImpl as unknown as typeof fetch).runGeneration({ familyId: 'flux' })
    ).rejects.toBeInstanceOf(StropheError);
  });

  it('cancels server-side when the caller aborts, so nothing keeps burning credits', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/cancel')) {
        return okJson({ cancelled: true, creditsCharged: 0 });
      }
      if (String(url).includes('/generations/')) {
        controller.abort();
        return okJson({ ...READY, state: 'running', result: undefined, pollAfterSeconds: 1 });
      }
      return okJson({
        generationId: 'gen_1',
        state: 'queued',
        creditsReserved: 1,
        replayed: false,
      });
    });

    await expect(
      client(fetchImpl as unknown as typeof fetch).runGeneration(
        { familyId: 'flux' },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true);
  });
});

describe('StropheApiClient.downloadResult', () => {
  it('fetches the delivery URL directly, with no Authorization header', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const blob = await client(fetchImpl as unknown as typeof fetch).downloadResult(READY.result!);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe('https://strophe.test/f/abc');
    expect(init?.headers).toBeUndefined();
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(3);
  });

  it('reports a download failure as a network-class error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).downloadResult(READY.result!)
    ).rejects.toMatchObject({ code: 'network', name: 'StropheError' });
  });
});
