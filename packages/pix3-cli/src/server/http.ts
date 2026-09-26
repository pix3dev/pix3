import type { IncomingMessage, ServerResponse } from 'node:http';

import { ALLOWED_ORIGINS } from '../protocol.ts';

/**
 * HTTP primitives shared by the two loopback servers of the CLI: the FSA link server of
 * `pix3 mcp` (`link-server.ts`) and the workspace server of `pix3 serve` (`serve/`).
 *
 * Errors are always `{ error: <code>, message, ...extra }` JSON — both servers speak the same
 * error shape, so the editor has one parser for them.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

export const readBody = (
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'too_large', 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

export const readJson = async (
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES
): Promise<Record<string, unknown>> => {
  const raw = await readBody(req, maxBytes);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'bad_json', 'Body must be a JSON object.');
};

/**
 * DNS rebinding guard: only literal loopback names are served, with ANY port (or none).
 *
 * The port is deliberately not compared with the one bound: VS Code Remote SSH (and `ssh -L`)
 * may forward the server's port to a different local port, and the browser then sends ITS port
 * in `Host`. The name is what matters — a page on an attacker's domain that resolves to
 * 127.0.0.1 still sends its own name.
 */
export const isLoopbackHost = (hostHeader: string | undefined): boolean => {
  const host = (hostHeader ?? '').trim().toLowerCase();
  if (!host) return false;
  let name: string;
  let port = '';
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return false;
    name = host.slice(0, close + 1);
    const rest = host.slice(close + 1);
    if (rest && !rest.startsWith(':')) return false;
    port = rest.slice(1);
  } else {
    const colon = host.indexOf(':');
    name = colon < 0 ? host : host.slice(0, colon);
    port = colon < 0 ? '' : host.slice(colon + 1);
    if (colon >= 0 && !port) return false;
  }
  if (port && !/^\d{1,5}$/.test(port)) return false;
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
};

/** `null` (no `Origin` — a local process) is allowed; a browser origin must be on the list. */
/**
 * Dev editors run on whatever local port Vite (or a VS Code port forward) picked, so any
 * `http://localhost:<port>` / `http://127.0.0.1:<port>` origin is a dev editor — pinning 8123 made
 * a forward to another local port fail as a bare 403 that looked exactly like "server not running".
 */
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

export const isAllowedOrigin = (origin: string | null): boolean =>
  origin === null || ALLOWED_ORIGINS.includes(origin) || DEV_ORIGIN.test(origin);

export const originOf = (req: IncomingMessage): string | null => {
  const header = req.headers.origin;
  return typeof header === 'string' ? header : null;
};

export const sendJson = (
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  origin: string | null,
  extraHeaders: Record<string, string> = {}
): void => {
  if (res.writableEnded || res.destroyed) return;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    // The editor's Service Worker must not cache these either (plan phase 0, "Транспорт LNA").
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
};
