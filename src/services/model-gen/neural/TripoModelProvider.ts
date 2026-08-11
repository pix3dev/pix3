import { inject, injectable } from '@/fw/di';
import { SecretStorageService } from '@/services/core/SecretStorageService';
import { base64ToBlob } from '@/services/image-gen/image-ops';
import type {
  Neural3DInput,
  Neural3DOptions,
  Neural3DProvider,
  Neural3DResult,
} from './Neural3DProvider';

/** SecretStorage id under which the Tripo3D API key is persisted. */
export const TRIPO_SECRET_ID = 'tripo';

/**
 * Tripo3D v2 openapi base. Routed through the `/tripo-proxy` Vite dev proxy (see vite.config.ts)
 * because a Bearer-key server API sends no CORS headers and cannot be called from the browser
 * cross-origin. The Authorization header rides along through the proxy unchanged.
 *
 * NOTE: production needs a hosted proxy (or the pix3-agent-bridge credential-injecting proxy) —
 * the raw `/tripo-proxy` path only exists in dev. (backlog)
 */
const TRIPO_API_BASE = '/tripo-proxy/v2/openapi';

const POLL_INTERVAL_MS = 2000;
// Tripo's image→model with PBR texturing can run several minutes under load; keep the ceiling
// generous so a slow-but-successful job isn't killed prematurely.
const MAX_POLL_MS = 12 * 60 * 1000;

/** The three coarse outcomes a raw Tripo task `status` string maps to. */
export type TripoStatusClass = 'done' | 'failed' | 'in-progress';

/** The image file-type Tripo expects in a create-task payload / upload filename. */
export type TripoFileType = 'png' | 'jpg' | 'jpeg' | 'webp';

/**
 * Tripo's lane shares the neural-lane contract; these aliases keep the historical names working for
 * existing call sites while `NeuralModelGenService` talks to the backend-agnostic
 * {@link Neural3DProvider}.
 */
export type TripoGenerateInput = Neural3DInput;
export type TripoGenerateOptions = Neural3DOptions;
export type TripoGenerateResult = Neural3DResult;

/**
 * Low-level Tripo3D image→model API client. Mirrors the metered-provider pattern: the API key lives
 * in {@link SecretStorageService} (never in app state), and every request carries it as a Bearer
 * header. Response parsing is deliberately defensive — the openapi docs disagree across versions on
 * the exact field names — so it is factored into pure, unit-tested helpers.
 */
@injectable()
export class TripoModelProvider implements Neural3DProvider {
  readonly id = 'tripo';
  readonly label = 'Tripo3D';

  @inject(SecretStorageService)
  private readonly secrets!: SecretStorageService;

  async hasKey(): Promise<boolean> {
    return Boolean(await this.getKey());
  }

  async getKey(): Promise<string | null> {
    const value = await this.secrets.getSecret(TRIPO_SECRET_ID);
    return value && value.trim() ? value : null;
  }

  async setKey(value: string): Promise<void> {
    await this.secrets.setSecret(TRIPO_SECRET_ID, value.trim());
  }

  /** Remove the stored key. Uses the SecretStorage delete when available; empty string otherwise. */
  async clearKey(): Promise<void> {
    if (typeof this.secrets.deleteSecret === 'function') {
      await this.secrets.deleteSecret(TRIPO_SECRET_ID);
      return;
    }
    await this.secrets.setSecret(TRIPO_SECRET_ID, '');
  }

  /**
   * Full image→GLB flow: upload the image → create an `image_to_model` task → poll to completion →
   * download the resulting GLB. Emits progress via `opts.onProgress`. Throws a descriptive Error on
   * every failure mode (missing key, non-zero API code, failed/timed-out task, missing output URL,
   * download/CORS failure); cancellation propagates as an AbortError.
   */
  async generateGlb(
    input: TripoGenerateInput,
    opts: TripoGenerateOptions
  ): Promise<TripoGenerateResult> {
    const apiKey = await this.getKey();
    if (!apiKey) {
      throw new Error('No Tripo3D API key is configured.');
    }
    const { signal, onProgress } = opts;
    throwIfAborted(signal);

    onProgress?.(0, 'uploading');
    const token = await this.uploadImage(apiKey, input, signal);

    const taskId = await this.createTask(apiKey, token, input.mimeType, signal);

    const modelUrl = await this.pollTask(apiKey, taskId, signal, onProgress);

    onProgress?.(100, 'downloading');
    const glb = await this.downloadGlb(modelUrl, signal);
    return { glb, taskId };
  }

  // -- flow steps ------------------------------------------------------------

  private async uploadImage(
    apiKey: string,
    input: TripoGenerateInput,
    signal?: AbortSignal
  ): Promise<string> {
    const blob = base64ToBlob(input.base64, input.mimeType);
    const fileType = fileTypeFromMime(input.mimeType);
    const form = new FormData();
    // Field name MUST be `file` (multipart/form-data).
    form.append('file', blob, `reference.${fileType}`);

    const json = await this.request(apiKey, '/upload', { method: 'POST', body: form, signal });
    const token = readUploadToken(json);
    if (!token) {
      throw new Error('Tripo3D upload did not return an image token.');
    }
    return token;
  }

  private async createTask(
    apiKey: string,
    fileToken: string,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<string> {
    const body = JSON.stringify({
      type: 'image_to_model',
      file: { type: fileTypeFromMime(mimeType), file_token: fileToken },
      texture: true,
      pbr: true,
    });
    const json = await this.request(apiKey, '/task', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
    const taskId = readTaskId(json);
    if (!taskId) {
      throw new Error('Tripo3D task creation did not return a task id.');
    }
    return taskId;
  }

  /**
   * Poll `GET /task/{id}` every ~2s, capped at ~5 min, until the task reaches a terminal state.
   * Returns the finished model URL on success; throws on a failed status or timeout. Respects the
   * abort signal both between and during requests.
   */
  private async pollTask(
    apiKey: string,
    taskId: string,
    signal: AbortSignal | undefined,
    onProgress: TripoGenerateOptions['onProgress']
  ): Promise<string> {
    const deadline = Date.now() + MAX_POLL_MS;
    let polls = 0;
    let lastStatus: unknown;
    let lastProgress = 0;
    for (;;) {
      throwIfAborted(signal);
      const json = await this.request(apiKey, `/task/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        signal,
      });
      const data = getData(json) ?? {};
      polls += 1;
      lastStatus = data.status;
      lastProgress = readProgress(data.progress);
      // First poll dumps the raw `data` node so an unexpected envelope shape (e.g. `status` under a
      // different key) is visible in devtools; subsequent polls log the compact status/progress.
      if (polls === 1) {
        console.info('[Tripo] first task payload', JSON.stringify(data));
      }
      console.info(
        `[Tripo] poll #${polls}: status=${String(data.status)} progress=${lastProgress}`
      );
      const statusClass = classifyStatus(data.status);

      if (statusClass === 'done') {
        const url = readModelUrl(data);
        if (!url) {
          throw new Error('Tripo3D reported success but returned no model URL.');
        }
        return url;
      }
      if (statusClass === 'failed') {
        throw new Error(`Tripo3D task failed (status: ${String(data.status ?? 'unknown')}).`);
      }

      onProgress?.(lastProgress, stageFromStatus(data.status));

      if (Date.now() >= deadline) {
        throw new Error(
          `Tripo3D generation timed out after ${Math.round(MAX_POLL_MS / 60000)} minutes ` +
            `(last status: ${String(lastStatus)}, progress: ${lastProgress}%). If the status is ` +
            `unexpected/undefined the response shape differs from what we parse — check the ` +
            `"[Tripo] first task payload" console line.`
        );
      }
      await delay(POLL_INTERVAL_MS, signal);
    }
  }

  private async downloadGlb(url: string, signal?: AbortSignal): Promise<Blob> {
    // Tripo's model URL is a presigned CDN link that sends no CORS headers, so it can't be fetched
    // cross-origin from the browser. Route it through the same-origin `/tripo-download` dev proxy
    // (see vite.config.ts); production routes downloads through the pix3-agent-bridge. (backlog)
    const proxied = `/tripo-download?url=${encodeURIComponent(url)}`;
    let response: Response;
    try {
      response = await fetch(proxied, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new Error(
        `Failed to download the generated GLB via the /tripo-download proxy. ${describeError(error)}`
      );
    }
    if (!response.ok) {
      throw new Error(`Failed to download the generated GLB (HTTP ${response.status}).`);
    }
    const buffer = await response.arrayBuffer();
    return new Blob([buffer], { type: 'model/gltf-binary' });
  }

  /**
   * Fetch a Tripo endpoint through the proxy with the Bearer header attached, parse the JSON
   * envelope, and reject a non-zero `code`. Cancellation propagates; every other failure becomes a
   * descriptive Error.
   */
  private async request(
    apiKey: string,
    path: string,
    init: {
      method: string;
      body?: BodyInit;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${TRIPO_API_BASE}${path}`, {
        method: init.method,
        body: init.body,
        signal: init.signal,
        headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new Error(`Tripo3D request to ${path} failed: ${describeError(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Tripo3D request to ${path} failed with HTTP ${response.status}.`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error(`Tripo3D returned a non-JSON response for ${path}.`);
    }
    const code = readCode(json);
    if (code !== 0) {
      throw new Error(
        `Tripo3D request to ${path} returned error code ${code}${readMessage(json)}.`
      );
    }
    return json;
  }
}

// -- pure, unit-testable helpers ---------------------------------------------

/** Narrow an unknown to a plain record, else null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Read the `data` envelope of a `{ code, data }` response, or null. */
function getData(json: unknown): Record<string, unknown> | null {
  const record = asRecord(json);
  return record ? asRecord(record.data) : null;
}

/** Read the numeric `code` of a response envelope; a missing/non-number code is treated as 0 (ok). */
export function readCode(json: unknown): number {
  const record = asRecord(json);
  return typeof record?.code === 'number' ? (record.code as number) : 0;
}

/** A " (message)" suffix from a response envelope, or empty. */
function readMessage(json: unknown): string {
  const record = asRecord(json);
  const message = record?.message;
  return typeof message === 'string' && message ? ` (${message})` : '';
}

/**
 * Read the upload token from an `/upload` response. Docs disagree across versions, so accept any of
 * `data.image_token` / `data.file_token` / `data.token`.
 */
export function readUploadToken(json: unknown): string | null {
  const data = getData(json);
  if (!data) {
    return null;
  }
  for (const key of ['image_token', 'file_token', 'token'] as const) {
    const value = data[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return null;
}

/** Read `data.task_id` from a create-task response. */
export function readTaskId(json: unknown): string | null {
  const data = getData(json);
  const id = data?.task_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Read the finished GLB URL from a task's `data` node. Accepts (in order) `output.pbr_model`,
 * `output.model`, `output.model_url`, `result.pbr_model`, `result.model` — returning the first
 * present absolute http(s) URL.
 */
export function readModelUrl(data: unknown): string | null {
  const record = asRecord(data);
  if (!record) {
    return null;
  }
  const output = asRecord(record.output);
  const result = asRecord(record.result);
  const candidates = [
    output?.pbr_model,
    output?.model,
    output?.model_url,
    result?.pbr_model,
    result?.model,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Bucket a raw task `status` string. `success`/`succeeded` → done; `failed`/`banned`/`cancelled`/
 * `expired`/`unknown` → failed; everything else (queued/running/pending/processing/…) → in-progress.
 */
export function classifyStatus(status: unknown): TripoStatusClass {
  const value = typeof status === 'string' ? status.toLowerCase() : '';
  if (value === 'success' || value === 'succeeded') {
    return 'done';
  }
  if (
    value === 'failed' ||
    value === 'banned' ||
    value === 'cancelled' ||
    value === 'expired' ||
    value === 'unknown'
  ) {
    return 'failed';
  }
  return 'in-progress';
}

/** Map a MIME type to the file-type token Tripo expects. Defaults to `png`. */
export function fileTypeFromMime(mimeType: string): TripoFileType {
  const value = mimeType.toLowerCase();
  if (value.includes('png')) {
    return 'png';
  }
  if (value.includes('webp')) {
    return 'webp';
  }
  if (value.includes('jpeg')) {
    return 'jpeg';
  }
  if (value.includes('jpg')) {
    return 'jpg';
  }
  return 'png';
}

/** The onProgress `stage` for an in-progress status: `queued` for queued/pending, else `running`. */
function stageFromStatus(status: unknown): string {
  const value = typeof status === 'string' ? status.toLowerCase() : '';
  return value === 'queued' || value === 'pending' ? 'queued' : 'running';
}

/** Clamp a raw `progress` (0–100) to a finite number, defaulting to 0. */
function readProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Tripo3D generation aborted.', 'AbortError');
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve after `ms`, or reject with an AbortError if the signal fires first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Tripo3D generation aborted.', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Tripo3D generation aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
