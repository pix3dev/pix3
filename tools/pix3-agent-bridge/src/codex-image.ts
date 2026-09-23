/** One isolated Codex app-server turn that returns the native image-generation item. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpError, isRecord } from './wire.ts';

const TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 32 * 1024 * 1024;

export interface CodexImageRequest {
  prompt: string;
  transparent?: boolean;
  aspectRatio?: string;
  references?: Array<{ mimeType: string; data: string }>;
}

export interface CodexImageResult {
  mimeType: string;
  data: string;
  revisedPrompt?: string;
}

/** Decode only known raster formats; never expose a CLI-supplied filesystem path to the browser. */
export const decodeCodexImage = (value: string): Pick<CodexImageResult, 'mimeType' | 'data'> => {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(value);
  const data = match ? match[2] : value;
  if (data.length > MAX_RESULT_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new HttpError(502, 'Codex returned an invalid image.');
  }
  const bytes = Buffer.from(data, 'base64');
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : null;
  if (!mimeType || (match && match[1] !== mimeType)) {
    throw new HttpError(502, 'Codex returned an unsupported image format.');
  }
  return { mimeType, data: bytes.toString('base64') };
};

export const generateCodexImage = (
  binary: string,
  request: CodexImageRequest,
  signal: AbortSignal,
  spawner: typeof spawn = spawn
): Promise<CodexImageResult> => {
  const prompt = request.prompt?.trim();
  if (!prompt) return Promise.reject(new HttpError(400, 'An image prompt is required.'));
  if (
    request.references &&
    (request.references.length > 3 ||
      request.references.some(
        ref =>
          !/^image\/(?:png|jpeg|webp)$/.test(ref.mimeType) ||
          !ref.data ||
          ref.data.length > 16 * 1024 * 1024
      ))
  )
    return Promise.reject(new HttpError(400, 'Invalid image reference.'));

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pix3-codex-image-'));
  const child = spawner(
    binary,
    ['app-server', '-c', 'features.shell_tool=false', '-c', 'tools.web_search=false'],
    {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  ) as ChildProcessWithoutNullStreams;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let image: CodexImageResult | null = null;
    let threadId = '';
    let turnId = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      child.kill();
      if (error) reject(error);
      else if (image) resolve(image);
      else reject(new HttpError(502, 'Codex finished without an image.'));
    };
    const abort = (): void => finish(new HttpError(499, 'Image generation cancelled.'));
    const timer = setTimeout(
      () => finish(new HttpError(504, 'Codex image generation timed out.')),
      TIMEOUT_MS
    );
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const onMessage = (message: unknown): void => {
      if (!isRecord(message)) return;
      if (isRecord(message.error) && typeof message.id === 'number') {
        const detail =
          typeof message.error.message === 'string'
            ? message.error.message
            : 'Codex request failed.';
        finish(new HttpError(502, detail));
        return;
      }
      if (
        message.id === 1 &&
        isRecord(message.result) &&
        isRecord(message.result.thread) &&
        typeof message.result.thread.id === 'string'
      ) {
        threadId = message.result.thread.id;
        const instruction = [
          'Use the built-in image generation tool exactly once. Return the generated image.',
          'Do not use shell, file editing, browser, plugins, or other tools.',
          request.transparent ? 'Generate with a transparent background.' : '',
          request.aspectRatio && request.aspectRatio !== 'Auto'
            ? `Target aspect ratio: ${request.aspectRatio}.`
            : '',
          prompt,
        ]
          .filter(Boolean)
          .join('\n');
        send({
          method: 'turn/start',
          id: 2,
          params: {
            threadId,
            input: [
              { type: 'text', text: instruction, text_elements: [] },
              ...(request.references ?? []).map(ref => ({
                type: 'image',
                url: `data:${ref.mimeType};base64,${ref.data}`,
              })),
            ],
          },
        });
      } else if (
        message.id === 2 &&
        isRecord(message.result) &&
        isRecord(message.result.turn) &&
        typeof message.result.turn.id === 'string'
      ) {
        turnId = message.result.turn.id;
      } else if (
        message.method === 'item/completed' &&
        isRecord(message.params) &&
        message.params.threadId === threadId &&
        isRecord(message.params.item) &&
        message.params.item.type === 'imageGeneration'
      ) {
        const item = message.params.item;
        if (isRecord(item.failure)) {
          finish(
            new HttpError(
              429,
              'Codex image generation limit reached. Try again after the limit resets.'
            )
          );
        } else if (typeof item.result === 'string' && item.result) {
          try {
            image = {
              ...decodeCodexImage(item.result),
              ...(typeof item.revisedPrompt === 'string'
                ? { revisedPrompt: item.revisedPrompt }
                : {}),
            };
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      } else if (
        message.method === 'turn/completed' &&
        isRecord(message.params) &&
        message.params.threadId === threadId &&
        isRecord(message.params.turn) &&
        (!turnId || message.params.turn.id === turnId)
      ) {
        const turn = message.params.turn;
        finish(
          turn.status === 'completed'
            ? undefined
            : new HttpError(
                502,
                isRecord(turn.error) && typeof turn.error.message === 'string'
                  ? turn.error.message
                  : 'Codex image generation failed.'
              )
        );
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let end = stdout.indexOf('\n');
      while (end >= 0) {
        const line = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        try {
          onMessage(JSON.parse(line));
        } catch (error) {
          if (error instanceof SyntaxError)
            finish(new HttpError(502, 'Codex sent malformed JSON.'));
          else finish(error instanceof Error ? error : new Error(String(error)));
        }
        end = stdout.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-1000);
    });
    child.on('error', error =>
      finish(new HttpError(503, `Could not start Codex: ${error.message}`))
    );
    child.on('exit', code => {
      if (!settled) finish(new HttpError(502, `Codex app-server exited (${code}): ${stderr}`));
    });
    child.on('close', () => {
      // Wait for the child to release its Windows file handles before removing this exact scratch.
      fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }, () => {});
    });
    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'pix3-agent-bridge', version: '0.5.0' }, capabilities: null },
    });
    send({ method: 'initialized', params: {} });
    send({
      method: 'thread/start',
      id: 1,
      params: {
        cwd: workspace,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        baseInstructions:
          'You are an image generation worker. Use only the built-in image generation tool.',
      },
    });
  });
};
