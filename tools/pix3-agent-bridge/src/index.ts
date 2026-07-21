#!/usr/bin/env node
/**
 * Pix3AgentBridge — a LOCAL, personal bridge between the pix3 editor's in-editor agent and the LLM
 * providers that a browser cannot reach directly.
 *
 * It does two jobs, both on 127.0.0.1:
 *
 *   1. Agent-SDK lane (`POST /v1/messages`, `GET /v1/models`): serves the Anthropic Messages wire
 *      shape from a real Claude Agent SDK (Claude Code / Pro/MAX subscription) session — no API key,
 *      usage draws from the subscription. This is the original bridge behaviour (see sessions.ts).
 *
 *   2. Provider proxy lane (`ALL /providers/:id/*`, `GET /v1/providers`): a credential-injecting
 *      reverse proxy for metered providers (OpenAI, Anthropic API, OpenCode Zen, custom
 *      OpenAI-compatible endpoints). The editor sends requests with only the pairing token; the
 *      bridge injects the provider key it stores in `~/.pix3/agent-bridge.json` and forwards to the
 *      fixed upstream. Keys never enter the browser. Providers are managed with the CLI:
 *
 *        pix3-agent-bridge provider add openai --key sk-...
 *        pix3-agent-bridge provider list
 *
 * Usage:
 *   npx pix3-agent-bridge                        (requires a `claude login`-ed Claude Code for lane 1)
 *   npx pix3-agent-bridge provider add openai --key sk-...
 *   Options: --port <n> (default 8484), --origin <url> (repeatable, extra allowed origins)
 *
 * Security model (defense in depth for a localhost service):
 *   - binds to 127.0.0.1 only;
 *   - pairing token (generated once, stored in ~/.pix3/agent-bridge.json, printed on start) must
 *     accompany every API request (x-api-key / Authorization) — blocks other local processes/pages;
 *   - browser `Origin` allowlist (editor.pix3.dev / cloud.pix3.dev + local dev) — anything else 403;
 *   - `Host` header must be localhost — blocks DNS-rebinding;
 *   - the proxy lane never takes the upstream host from the client (fixed per provider) → no SSRF,
 *     and forwards only content-type + the injected key → the pairing token never leaks upstream;
 *   - the Agent-SDK session runs with zero built-in tools — the model can only call pix3 editor
 *     tools, never this machine's shell or filesystem.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SessionManager } from './sessions.ts';
import { HttpError, parseMessagesRequest } from './wire.ts';
import { loadConfig, type BridgeConfig } from './config.ts';
import { runProviderCommand, usage } from './cli.ts';
import { forwardToProvider } from './proxy.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Discovery entry for the intrinsic Agent-SDK (subscription) lane — not part of the provider table. */
const AGENT_SDK_PROVIDER = {
  id: 'claude-bridge',
  label: 'Claude Code (MAX)',
  kind: 'agent-sdk' as const,
};

function modelEntry(
  id: string,
  label: string,
  description: string,
  maxOutputTokens: number,
  contextWindow: number
) {
  return {
    id,
    label,
    description,
    capabilities: {
      supportsTools: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      maxOutputTokens,
      contextWindow,
    },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  };
}

/** Static catalog served to the Agent-SDK lane's `GET /v1/models` — subscription models, $0 marginal cost. */
const AGENT_SDK_MODELS = [
  modelEntry('claude-fable-5', 'Claude Fable 5 (MAX)', 'Most capable — via Claude Code subscription.', 32000, 1_000_000),
  modelEntry('claude-opus-4-8', 'Claude Opus 4.8 (MAX)', 'Highly capable — via Claude Code subscription.', 32000, 1_000_000),
  modelEntry('claude-sonnet-5', 'Claude Sonnet 5 (MAX)', 'Balanced speed and quality — via Claude Code subscription.', 32000, 1_000_000),
  modelEntry('claude-haiku-4-5', 'Claude Haiku 4.5 (MAX)', 'Fastest — via Claude Code subscription.', 16000, 200_000),
];

const log = (line: string): void => {
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
};

const hostAllowed = (req: IncomingMessage): boolean => {
  const host = (req.headers.host ?? '').toLowerCase();
  return (
    host.startsWith('localhost:') ||
    host.startsWith('127.0.0.1:') ||
    host === 'localhost' ||
    host === '127.0.0.1'
  );
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const startServer = (config: BridgeConfig): void => {
  const manager = new SessionManager(log);

  const withCors = (
    corsOrigin: string | null,
    extra: Record<string, string> = {}
  ): Record<string, string> => {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...extra };
    if (corsOrigin) {
      headers['Access-Control-Allow-Origin'] = corsOrigin;
      headers['Vary'] = 'Origin';
    }
    return headers;
  };

  const sendJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
    corsOrigin: string | null
  ): void => {
    res.writeHead(status, withCors(corsOrigin, { 'Content-Type': 'application/json; charset=utf-8' }));
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
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const query = qIndex >= 0 ? rawUrl.slice(qIndex) : '';
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
          'content-type, x-api-key, authorization, x-pix3-bridge-token, anthropic-version, anthropic-dangerous-direct-browser-access',
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

    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      sendJson(
        res,
        200,
        {
          ok: true,
          name: 'pix3-agent-bridge',
          hint: 'Paste the pairing token from the bridge console into pix3 (Settings → AI Agent).',
        },
        origin
      );
      return;
    }

    // Everything below requires the pairing token (dedicated header, x-api-key, or Authorization).
    const auth =
      (req.headers['x-pix3-bridge-token'] as string | undefined) ??
      (req.headers['x-api-key'] as string | undefined) ??
      req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (auth !== config.token) {
      sendError(res, 401, 'Invalid or missing bridge pairing token.', origin);
      return;
    }

    // Discovery: which providers this bridge can serve right now (enabled + keyed) + the SDK lane.
    if (req.method === 'GET' && pathname === '/v1/providers') {
      const providers = Object.entries(config.providers)
        .filter(([, p]) => p.enabled && p.apiKey)
        .map(([id, p]) => ({ id, label: p.label, kind: p.kind, enabled: true }));
      sendJson(res, 200, { providers: [...providers, AGENT_SDK_PROVIDER] }, origin);
      return;
    }

    // Provider proxy lane: /providers/:id/<rest>  →  {provider.baseUrl}/<rest>
    if (pathname.startsWith('/providers/')) {
      const rest = pathname.slice('/providers/'.length);
      const slash = rest.indexOf('/');
      const providerId = slash >= 0 ? rest.slice(0, slash) : rest;
      const restPath = slash >= 0 ? rest.slice(slash) : '/';
      const provider = config.providers[providerId];
      if (!provider || !provider.enabled) {
        sendError(res, 404, `Provider "${providerId}" is not configured or is disabled.`, origin);
        return;
      }
      if (!provider.apiKey) {
        sendError(
          res,
          400,
          `Provider "${providerId}" has no API key. Run: pix3-agent-bridge provider set-key ${providerId} <key>`,
          origin
        );
        return;
      }
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
        const result = await forwardToProvider(provider, {
          method: req.method ?? 'GET',
          restPath,
          query,
          body,
        });
        res.writeHead(result.status, withCors(origin, { 'Content-Type': result.contentType }));
        res.end(result.body);
      } catch (error) {
        if (error instanceof HttpError) {
          sendError(res, error.status, error.message, origin);
        } else {
          log(`proxy error (${providerId}): ${error instanceof Error ? error.message : String(error)}`);
          sendError(res, 502, `Upstream request to "${providerId}" failed.`, origin);
        }
      }
      return;
    }

    // Agent-SDK lane.
    if (req.method === 'GET' && pathname === '/v1/models') {
      sendJson(res, 200, { models: AGENT_SDK_MODELS }, origin);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/messages') {
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      try {
        const body = (await readBody(req)).toString('utf8');
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
          sendError(res, 500, error instanceof Error ? error.message : 'Internal bridge error.', origin);
        }
      }
      return;
    }

    sendError(res, 404, `No route: ${req.method} ${pathname}`, origin);
  });

  // Long model turns must not be killed by Node's default 5-minute request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  server.listen(config.port, '127.0.0.1', () => {
    const enabled = Object.entries(config.providers)
      .filter(([, p]) => p.enabled && p.apiKey)
      .map(([id]) => id);
    console.log('');
    console.log(`  Pix3AgentBridge listening on http://127.0.0.1:${config.port}`);
    console.log(`  Pairing token:   ${config.token}`);
    console.log(`  Allowed origins: ${config.origins.join(', ')}`);
    console.log(
      `  Proxy providers: ${enabled.length > 0 ? enabled.join(', ') : '(none — add one: pix3-agent-bridge provider add openai --key sk-...)'}`
    );
    console.log('');
    console.log('  In pix3: Settings → AI Agent → paste the pairing token; advanced providers appear when enabled here.');
    console.log('  Agent-SDK (MAX) lane auth comes from your Claude Code login (`claude login`).');
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

const main = (): void => {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === 'provider') {
    runProviderCommand(argv.slice(1));
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const config = loadConfig();
  // Serve-time flag overrides (not persisted): --port, --origin (repeatable).
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) config.port = Number(argv[i + 1]);
    if (argv[i] === '--origin' && argv[i + 1]) config.origins.push(argv[i + 1]);
  }
  startServer(config);
};

main();
