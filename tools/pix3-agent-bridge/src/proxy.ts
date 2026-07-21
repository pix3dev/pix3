/**
 * Credential-injecting reverse proxy for the metered LLM providers. The editor talks to the bridge
 * with the pairing token only; this module strips that token, builds a fresh upstream request with
 * the provider's stored key, and forwards it to the fixed upstream base for that provider.
 *
 * Security properties:
 *   - the upstream host is NEVER taken from the client request — it comes from the provider's stored
 *     `baseUrl`, so this cannot be turned into an open relay / SSRF against arbitrary hosts;
 *   - the outbound request carries ONLY `content-type` + the injected auth header — the pairing
 *     token, cookies, Origin/Host and any other inbound headers are dropped, so the bridge token
 *     never leaks upstream;
 *   - the wire body is passed through verbatim, so the bridge stays agnostic to each provider's
 *     request/response format (OpenAI Chat Completions vs Anthropic Messages).
 */

import type { ProviderConfig } from './config.ts';

const ANTHROPIC_VERSION = '2023-06-01';

export interface ProxyRequest {
  readonly method: string;
  /** Path AFTER `/providers/:id`, e.g. `/chat/completions`, `/messages`, `/models`. */
  readonly restPath: string;
  /** Raw query string including the leading `?`, or `''`. */
  readonly query: string;
  /** Request body bytes (POST), or null (GET). */
  readonly body: Buffer | null;
}

export interface ProxyResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const buildUpstreamHeaders = (provider: ProviderConfig): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.kind === 'anthropic') {
    headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  } else {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }
  return headers;
};

/** Forward one editor request to its provider's upstream, injecting the stored key. */
export const forwardToProvider = async (
  provider: ProviderConfig,
  request: ProxyRequest
): Promise<ProxyResult> => {
  const url = `${provider.baseUrl}${request.restPath}${request.query}`;
  const init: RequestInit = {
    method: request.method,
    headers: buildUpstreamHeaders(provider),
  };
  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const response = await fetch(url, init);
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'application/json',
    body,
  };
};
