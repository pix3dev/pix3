/**
 * pix3-claude-bridge — a LOCAL, personal-use bridge that lets the pix3 in-editor agent run on a
 * Claude Code (Pro/MAX subscription) login via the Claude Agent SDK.
 *
 * It exposes an Anthropic Messages-shaped endpoint (`POST /v1/messages`) on 127.0.0.1 that pix3's
 * existing Anthropic provider can talk to; every request is served by a real Claude Code harness
 * session (see `sessions.ts`), never by forwarding subscription credentials to the raw API.
 *
 * Usage:
 *   cd tools/claude-bridge && npm install   (once)
 *   npm start                               (requires a `claude login`-ed Claude Code)
 *   Options: --port <n> (default 8484), --origin <url> (repeatable, extra allowed origins)
 *
 * Security model (defense in depth for a localhost service):
 *   - binds to 127.0.0.1 only;
 *   - pairing token (generated once, stored in ~/.pix3/claude-bridge.json, printed on start) must
 *     accompany every API request as `x-api-key` — blocks other local processes and web pages;
 *   - browser `Origin` allowlist (editor.pix3.dev + the local dev server) — anything else is 403;
 *   - `Host` header must be localhost — blocks DNS-rebinding;
 *   - the Claude session runs with zero built-in tools (see sessions.ts) — the model can only call
 *     pix3 editor tools, never this machine's shell or filesystem.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionManager } from './sessions.ts';
import { HttpError, parseMessagesRequest } from './wire.ts';

const DEFAULT_PORT = 8484;
const DEFAULT_ORIGINS = [
  'https://editor.pix3.dev',
  'http://localhost:8123',
  'http://127.0.0.1:8123',
];
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Static catalog served to pix3's `listModels` — subscription models, zero marginal cost. */
const MODELS = [
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5 (MAX)',
    description: 'Most capable — via Claude Code subscription.',
    capabilities: {
      supportsTools: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      maxOutputTokens: 32000,
      contextWindow: 1_000_000,
    },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8 (MAX)',
    description: 'Highly capable — via Claude Code subscription.',
    capabilities: {
      supportsTools: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      maxOutputTokens: 32000,
      contextWindow: 1_000_000,
    },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5 (MAX)',
    description: 'Balanced speed and quality — via Claude Code subscription.',
    capabilities: {
      supportsTools: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      maxOutputTokens: 32000,
      contextWindow: 1_000_000,
    },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5 (MAX)',
    description: 'Fastest — via Claude Code subscription.',
    capabilities: {
      supportsTools: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      maxOutputTokens: 16000,
      contextWindow: 200_000,
    },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  },
];

interface BridgeConfig {
  token: string;
  port: number;
  origins: string[];
}

const log = (line: string): void => {
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
};

const loadConfig = (): BridgeConfig => {
  const configDir = path.join(os.homedir(), '.pix3');
  const configPath = path.join(configDir, 'claude-bridge.json');
  let stored: Partial<BridgeConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<BridgeConfig>;
  } catch {
    /* first run */
  }
  if (typeof stored.token !== 'string' || stored.token.length < 16) {
    stored.token = randomBytes(24).toString('base64url');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({ token: stored.token }, null, 2)}\n`, 'utf8');
    log(`created ${configPath}`);
  }

  const config: BridgeConfig = {
    token: stored.token,
    port: typeof stored.port === 'number' ? stored.port : DEFAULT_PORT,
    origins: [
      ...DEFAULT_ORIGINS,
      ...(Array.isArray(stored.origins) ? stored.origins.filter(o => typeof o === 'string') : []),
    ],
  };

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port' && args[i + 1]) config.port = Number(args[i + 1]);
    if (args[i] === '--origin' && args[i + 1]) config.origins.push(args[i + 1]);
  }
  return config;
};

const hostAllowed = (req: IncomingMessage): boolean => {
  const host = (req.headers.host ?? '').toLowerCase();
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:') ||
    host === 'localhost' || host === '127.0.0.1';
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const main = (): void => {
  const config = loadConfig();
  const manager = new SessionManager(log);

  const sendJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
    corsOrigin: string | null
  ): void => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (corsOrigin) {
      headers['Access-Control-Allow-Origin'] = corsOrigin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  const sendError = (
    res: ServerResponse,
    status: number,
    message: string,
    corsOrigin: string | null
  ): void => {
    sendJson(res, status, { type: 'error', error: { type: 'invalid_request_error', message } }, corsOrigin);
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;

    if (!hostAllowed(req)) {
      sendError(res, 403, 'Forbidden host.', null);
      return;
    }
    if (origin && !config.origins.includes(origin)) {
      log(`403 rejected origin ${origin}`);
      sendError(res, 403, 'Origin not allowed.', null);
      return;
    }

    // CORS preflight (no auth — browsers strip credentials from preflights).
    if (req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          (req.headers['access-control-request-headers'] as string | undefined) ??
          'content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
        'Access-Control-Max-Age': '86400',
      };
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
      }
      // Chrome Private Network Access / Local Network Access preflight opt-in.
      if (req.headers['access-control-request-private-network'] === 'true') {
        headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      sendJson(
        res,
        200,
        {
          ok: true,
          name: 'pix3-claude-bridge',
          hint: 'Paste the pairing token from the bridge console into pix3 (provider "Claude Code (local bridge)", API key field).',
        },
        origin
      );
      return;
    }

    // Everything below requires the pairing token.
    const auth = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (auth !== config.token) {
      sendError(res, 401, 'Invalid or missing bridge pairing token.', origin);
      return;
    }

    if (req.method === 'GET' && url === '/v1/models') {
      sendJson(res, 200, { models: MODELS }, origin);
      return;
    }

    if (req.method === 'POST' && url === '/v1/messages') {
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      try {
        const body = await readBody(req);
        const request = parseMessagesRequest(JSON.parse(body));
        const response = await manager.handle(request, abort.signal);
        sendJson(res, response.status, response.body, origin);
      } catch (error) {
        if (res.writableEnded || abort.signal.aborted) return;
        if (error instanceof HttpError) {
          sendError(res, error.status === 499 ? 400 : error.status, error.message, origin);
        } else if (error instanceof SyntaxError) {
          sendError(res, 400, 'Request body is not valid JSON.', origin);
        } else {
          log(`500: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          sendError(
            res,
            500,
            error instanceof Error ? error.message : 'Internal bridge error.',
            origin
          );
        }
      }
      return;
    }

    sendError(res, 404, `No route: ${req.method} ${url}`, origin);
  });

  // Long model turns must not be killed by Node's default 5-minute request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  server.listen(config.port, '127.0.0.1', () => {
    console.log('');
    console.log(`  pix3-claude-bridge listening on http://127.0.0.1:${config.port}`);
    console.log(`  Pairing token:   ${config.token}`);
    console.log(`  Allowed origins: ${config.origins.join(', ')}`);
    console.log('');
    console.log('  In pix3: Settings -> AI Agent -> provider "Claude Code (local bridge)",');
    console.log('  paste the pairing token into the API key field.');
    console.log('');
    console.log('  Model auth comes from your Claude Code login (`claude login`, Pro/MAX).');
    console.log('');
  });

  const shutdown = (): void => {
    log('shutting down');
    manager.closeAll('bridge shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main();
