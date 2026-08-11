import {
  STROPHE_TERMINAL_STATES,
  StropheError,
  type StropheAccount,
  type StropheErrorCode,
  type StropheEstimate,
  type StropheFamilyDetail,
  type StropheFamilySummary,
  type StropheFile,
  type StropheGeneration,
  type StropheGenerationRequest,
  type StropheGenerationStarted,
  type StropheGenerationResult,
  type StropheOutputType,
} from './StropheTypes';

/**
 * Default API host. Strophe sends `Access-Control-Allow-Origin: *` on every `/api/v1` endpoint AND
 * on the artifact delivery URLs, so the browser calls it DIRECTLY — no dev proxy, no hosted proxy,
 * unlike OpenAI (`/openai-proxy`) or Tripo (`/tripo-proxy` + `/tripo-download`). Verified against a
 * live account on 2026-08-11; if it ever regresses, that is a Strophe-side bug worth reporting
 * rather than something to work around here.
 */
const DEFAULT_BASE_URL =
  (import.meta.env.VITE_STROPHE_API_URL as string | undefined) ?? 'https://strophe.app/api/v1';

/** Bounds for the server-suggested poll delay, so a bad value can't stall or hammer us. */
const MIN_POLL_SECONDS = 1;
const MAX_POLL_SECONDS = 10;
const DEFAULT_POLL_SECONDS = 3;

/**
 * How long a single poll may block server-side (`?wait=`). Their docs warn that a held request
 * occupies one of the account's 32 concurrency slots for its whole duration, so this stays modest:
 * long enough that a fast image lands in the first round trip, short enough that a fan-out of
 * several generations doesn't starve the account.
 */
const DEFAULT_WAIT_SECONDS = 15;

/** Ceiling for a whole generation. 3D families advertise ~80 s but can queue far longer under load. */
const DEFAULT_MAX_WAIT_MS = 12 * 60 * 1000;

/**
 * Where the bearer token comes from, and what to do when it is rejected.
 *
 * This indirection is the OAuth seam: today {@link StropheAccountService} implements it by reading a
 * long-lived API key out of encrypted storage. When Strophe ships a connect flow (device-code /
 * PKCE — see `.plans/strophe-integration-feedback.md`), the access token arrives in the SAME
 * `Authorization: Bearer` header, so only this interface gains a refresh implementation and nothing
 * else in the client or the providers changes.
 */
export interface StropheAuth {
  /** Resolve the current bearer token. Throw or return '' when nothing is configured. */
  getToken(): Promise<string> | string;
  /**
   * Invoked once when a request comes back 401. Return true after refreshing the credential to have
   * the request retried; false (the default) to surface the error.
   */
  onUnauthorized?(): Promise<boolean>;
}

export interface StropheClientOptions {
  readonly auth: StropheAuth;
  readonly baseUrl?: string;
  /** Injected fetch, for tests. */
  readonly fetchImpl?: typeof fetch;
}

export interface StropheRunOptions {
  readonly signal?: AbortSignal;
  /**
   * Progress callback. Strophe exposes no numeric progress, so `progress` is INTERPOLATED from the
   * family's advertised `generationTime` (see {@link progressFromElapsed}) — it is an honest
   * "time elapsed against the estimate", not a report from the model.
   */
  readonly onProgress?: (progress: number, state: StropheGeneration['state']) => void;
  /** Wall-clock estimate in seconds, from the catalog, used to shape the progress curve. */
  readonly etaSeconds?: number;
  /** Hard ceiling on the whole run. */
  readonly maxWaitMs?: number;
  /** Seconds a single poll may block server-side. 0 disables `?wait=` (pure polling). */
  readonly waitSeconds?: number;
  /** Reuse a caller-supplied idempotency key (e.g. to make a retry safe). */
  readonly idempotencyKey?: string;
}

export interface StropheUploadInput {
  readonly blob: Blob;
  readonly fileName?: string;
}

/**
 * Low-level client for the Strophe generation API. Stateless apart from its {@link StropheAuth}, so
 * both the image provider (which gets a key per request from the shared provider registry) and the
 * 3D provider (which reads it from encrypted storage) can each own an instance.
 *
 * Everything network-facing funnels through {@link request}, which normalizes their
 * `{ error: { code, message, retryable, details } }` envelope into a {@link StropheError} carrying
 * the machine-readable code — callers branch on that (top up credits, re-enter the key, retry after
 * `Retry-After`) rather than on prose.
 */
export class StropheApiClient {
  private readonly auth: StropheAuth;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StropheClientOptions) {
    this.auth = options.auth;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // -- account & catalog -----------------------------------------------------

  /** Account status: plan, credits (null on team pools), and the calling key's scopes + limits. */
  async getAccount(signal?: AbortSignal): Promise<StropheAccount> {
    return this.request<StropheAccount>('GET', '/account', { signal });
  }

  /** Full family catalog, optionally narrowed to one output modality. */
  async listFamilies(
    opts: { outputType?: StropheOutputType; signal?: AbortSignal } = {}
  ): Promise<StropheFamilySummary[]> {
    const query = opts.outputType ? `?outputType=${encodeURIComponent(opts.outputType)}` : '';
    const payload = await this.request<{ data?: StropheFamilySummary[] }>(
      'GET',
      `/families${query}`,
      { signal: opts.signal }
    );
    return payload.data ?? [];
  }

  /** One family with its axes, variants and parameter schema. */
  async getFamily(familyId: string, signal?: AbortSignal): Promise<StropheFamilyDetail> {
    return this.request<StropheFamilyDetail>('GET', `/families/${encodeURIComponent(familyId)}`, {
      signal,
    });
  }

  // -- files -----------------------------------------------------------------

  /**
   * Upload one input file and return its id. Sent as `multipart/form-data` (not the JSON+base64
   * variant) because the JSON request-body cap is 256 KiB while the file cap is 25 MB, and base64
   * would inflate a reference image past the smaller limit.
   *
   * Strophe has no content-hash dedup, so callers that re-send the same reference repeatedly should
   * cache the returned id themselves.
   */
  async uploadFile(input: StropheUploadInput, signal?: AbortSignal): Promise<StropheFile> {
    const form = new FormData();
    form.append('file', input.blob, input.fileName ?? `upload.${extForMime(input.blob.type)}`);
    return this.request<StropheFile>('POST', '/files', { body: form, signal });
  }

  // -- generations -----------------------------------------------------------

  /** Price a request without side effects or charges. */
  async estimate(
    request: StropheGenerationRequest,
    signal?: AbortSignal
  ): Promise<StropheEstimate> {
    return this.request<StropheEstimate>('POST', '/generations/estimate', {
      json: request,
      signal,
    });
  }

  /**
   * Start a generation. Always sends an `Idempotency-Key`: a retried POST then returns the SAME
   * generation with `replayed: true` instead of charging twice.
   */
  async createGeneration(
    request: StropheGenerationRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<StropheGenerationStarted> {
    return this.request<StropheGenerationStarted>('POST', '/generations', {
      json: request,
      idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
      signal: opts.signal,
    });
  }

  /**
   * Read one generation. With `waitSeconds` the server holds the response until the generation
   * finishes or the wait elapses — cheaper than tight polling, but it occupies a concurrency slot.
   */
  async getGeneration(
    generationId: string,
    opts: { waitSeconds?: number; signal?: AbortSignal } = {}
  ): Promise<StropheGeneration> {
    const wait =
      opts.waitSeconds && opts.waitSeconds > 0 ? `?wait=${Math.floor(opts.waitSeconds)}` : '';
    return this.request<StropheGeneration>(
      'GET',
      `/generations/${encodeURIComponent(generationId)}${wait}`,
      { signal: opts.signal }
    );
  }

  /**
   * Cancel a generation. Nothing is charged if it had not started; work already done is charged in
   * part, and the returned `creditsCharged` reflects the truth.
   */
  async cancelGeneration(
    generationId: string,
    signal?: AbortSignal
  ): Promise<{ cancelled: boolean; creditsCharged?: number }> {
    return this.request<{ cancelled: boolean; creditsCharged?: number }>(
      'POST',
      `/generations/${encodeURIComponent(generationId)}/cancel`,
      { signal }
    );
  }

  /**
   * Create a generation and poll it to a terminal state, reporting interpolated progress.
   *
   * Resolves with the finished generation only when it reached `ready`; `failed` and `cancelled`
   * both throw (a `failed` generation carries their structured {@link StropheGenerationFailure},
   * which is mapped onto the `generation_failed` code with the class in `details`). On abort the
   * in-flight generation is cancelled server-side on a best-effort basis so the user is not charged
   * for work they walked away from.
   */
  async runGeneration(
    request: StropheGenerationRequest,
    opts: StropheRunOptions = {}
  ): Promise<StropheGeneration> {
    const { signal, onProgress } = opts;
    throwIfAborted(signal);

    const started = await this.createGeneration(request, {
      idempotencyKey: opts.idempotencyKey,
      signal,
    });
    onProgress?.(0, 'queued');

    const startedAt = Date.now();
    const deadline = startedAt + (opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    const waitSeconds = opts.waitSeconds ?? DEFAULT_WAIT_SECONDS;
    let generation: StropheGeneration | null = null;

    try {
      for (;;) {
        throwIfAborted(signal);
        generation = await this.getGeneration(started.generationId, { waitSeconds, signal });

        if (isTerminal(generation.state)) {
          break;
        }
        onProgress?.(
          progressFromElapsed(Date.now() - startedAt, opts.etaSeconds),
          generation.state
        );

        if (Date.now() >= deadline) {
          throw new StropheError(
            'generation_failed',
            `Strophe generation ${started.generationId} did not finish within ` +
              `${Math.round((opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS) / 60000)} minutes ` +
              `(last state: ${generation.state}).`,
            { retryable: true, details: { generationId: started.generationId } }
          );
        }
        await delay(clampPollSeconds(generation.pollAfterSeconds) * 1000, signal);
      }
    } catch (error) {
      // A cancelled run must not keep burning credits: fire-and-forget the server-side cancel.
      if (isAbortError(error)) {
        void this.cancelGeneration(started.generationId).catch(() => undefined);
      }
      throw error;
    }

    if (generation.state === 'cancelled') {
      throw new StropheError('aborted', 'The Strophe generation was cancelled.');
    }
    if (generation.state === 'failed') {
      throw failureToError(generation);
    }
    onProgress?.(100, 'ready');
    return generation;
  }

  /**
   * Download a finished artifact. Their delivery URLs are capability links on their own origin with
   * `Access-Control-Allow-Origin: *`, so this is a plain cross-origin `fetch` with no auth header
   * and no proxy. The link lives ~24 h and is NOT re-signed on re-read, so callers should persist
   * the bytes rather than the URL.
   */
  async downloadResult(result: StropheGenerationResult, signal?: AbortSignal): Promise<Blob> {
    let response: Response;
    try {
      response = await this.fetchImpl(result.url, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new StropheError('network', 'Failed to download the generated file from Strophe.', {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new StropheError(
        'network',
        `Failed to download the generated file from Strophe (HTTP ${response.status}).`,
        { status: response.status }
      );
    }
    const buffer = await response.arrayBuffer();
    return new Blob([buffer], {
      type: result.mimeType || response.headers.get('content-type') || '',
    });
  }

  // -- transport -------------------------------------------------------------

  /**
   * One authenticated request, with the error envelope normalized. Retries exactly once when the
   * first attempt is 401 and {@link StropheAuth.onUnauthorized} reports that the credential was
   * refreshed — the hook a future OAuth flow plugs into.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    init: {
      json?: unknown;
      body?: BodyInit;
      idempotencyKey?: string;
      signal?: AbortSignal;
    } = {},
    isRetry = false
  ): Promise<T> {
    const token = (await this.auth.getToken()) || '';
    if (!token) {
      throw new StropheError('unauthorized', 'No Strophe API key is configured.');
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (init.idempotencyKey) {
      headers['Idempotency-Key'] = init.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
        signal: init.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new StropheError('network', `Network error contacting the Strophe API (${path}).`, {
        cause: error,
      });
    }

    const payload = await readJsonSafely(response);

    if (response.status === 401 && !isRetry && this.auth.onUnauthorized) {
      if (await this.auth.onUnauthorized()) {
        return this.request<T>(method, path, init, true);
      }
    }

    if (!response.ok) {
      throw parseErrorEnvelope(payload, {
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
        retryAfterSeconds: readRetryAfter(response.headers.get('retry-after')),
        path,
      });
    }
    return payload as T;
  }
}

// -- pure, unit-testable helpers ---------------------------------------------

/** Whether a generation state is terminal (polling should stop). */
export function isTerminal(state: StropheGeneration['state']): boolean {
  return STROPHE_TERMINAL_STATES.includes(state);
}

/**
 * Interpolate a 0–95 progress value from elapsed time against the family's advertised estimate.
 *
 * Strophe reports no numeric progress, so this is the honest substitute: it approaches but never
 * reaches 100 (only a terminal `ready` sets 100), and it decays past the estimate instead of
 * sticking at a lie — an overdue generation keeps creeping rather than sitting at 95 %.
 */
export function progressFromElapsed(elapsedMs: number, etaSeconds?: number): number {
  const eta = etaSeconds && etaSeconds > 0 ? etaSeconds * 1000 : 45_000;
  const ratio = Math.max(0, elapsedMs) / eta;
  // 1 - e^-x approaches 1 asymptotically: ~63 % at the estimate, ~86 % at 2x, never 100 %.
  const eased = 1 - Math.exp(-ratio);
  return Math.min(95, Math.round(eased * 95));
}

/** Clamp the server-suggested poll delay into a sane window. */
export function clampPollSeconds(pollAfterSeconds: number | undefined): number {
  if (typeof pollAfterSeconds !== 'number' || !Number.isFinite(pollAfterSeconds)) {
    return DEFAULT_POLL_SECONDS;
  }
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(pollAfterSeconds)));
}

/**
 * Normalize a Strophe error body into a {@link StropheError}. Falls back to a synthetic code when
 * the body is not their envelope (proxy HTML, empty 502, …) so callers always get something typed.
 */
export function parseErrorEnvelope(
  payload: unknown,
  context: {
    status: number;
    requestId?: string;
    retryAfterSeconds?: number;
    path?: string;
  }
): StropheError {
  const envelope = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const code = typeof envelope?.code === 'string' ? (envelope.code as StropheErrorCode) : null;
  const message =
    (typeof envelope?.message === 'string' && envelope.message) ||
    describeStatus(context.status, context.path);
  const retryable =
    typeof envelope?.retryable === 'boolean'
      ? envelope.retryable
      : context.status >= 500 || context.status === 429;

  return new StropheError(code ?? fallbackCode(context.status), message, {
    status: context.status,
    retryable,
    retryAfterSeconds: context.retryAfterSeconds,
    requestId: context.requestId,
    details: isRecord(envelope?.details) ? envelope.details : undefined,
  });
}

/** Turn a `failed` generation into a typed error, preserving their failure class and hint. */
export function failureToError(generation: StropheGeneration): StropheError {
  const failure = generation.error;
  const message = failure
    ? [failure.message || failure.reason, failure.hint].filter(Boolean).join(' ')
    : 'The Strophe generation failed without a reported reason.';
  return new StropheError('generation_failed', message, {
    retryable: failure?.retryable ?? false,
    details: {
      failureCode: failure?.code ?? 'unknown',
      reason: failure?.reason ?? '',
      generationId: generation.generationId,
      ...(failure?.details ?? {}),
    },
  });
}

/** A fresh idempotency key. Every credit-spending POST carries one. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pix3-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Map a MIME type to a file extension for upload filenames. */
export function extForMime(mimeType: string): string {
  const value = (mimeType || '').toLowerCase();
  if (value.includes('png')) {
    return 'png';
  }
  if (value.includes('webp')) {
    return 'webp';
  }
  if (value.includes('jpeg') || value.includes('jpg')) {
    return 'jpg';
  }
  if (value.includes('gltf-binary') || value.includes('glb')) {
    return 'glb';
  }
  return 'bin';
}

function fallbackCode(status: number): StropheErrorCode | 'network' {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403) {
    return 'access_denied';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'service_unavailable';
  }
  return 'invalid_request';
}

function describeStatus(status: number, path?: string): string {
  const where = path ? ` (${path})` : '';
  switch (status) {
    case 401:
      return `Your Strophe API key was rejected${where}. Re-enter it in Settings → Strophe.`;
    case 403:
      return `Strophe refused this request${where} — the key may lack a scope, or the account may need a team plan.`;
    case 402:
      return 'Not enough Strophe credits for this generation.';
    case 429:
      return 'Strophe rate limit reached. Retry shortly.';
    default:
      return `Strophe API error (HTTP ${status})${where}.`;
  }
}

function readRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { rawText: text };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Strophe generation aborted.', 'AbortError');
  }
}

/** Resolve after `ms`, or reject with an AbortError if the signal fires first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Strophe generation aborted.', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Strophe generation aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
