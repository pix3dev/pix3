import { describe, expect, it } from 'vitest';

import {
  parseEntries,
  readPairingTokenFromHash,
  stripPairingTokenFromHash,
} from '@/services/llm/BridgeConnectionService';
import { createBridgeProvider } from '@/services/llm/BridgeProviders';

/**
 * The pairing link (`<editor>/#bridge-token=…`) is how the bridge hands the editor its token without
 * a copy-paste. Two properties matter and are easy to break: the token must survive URL escaping
 * intact (it is base64url, so `-`/`_` and a possible `%3D` are all in play), and it must be removed
 * from the hash without taking any co-located routing (`#welcome`) with it.
 */
describe('bridge pairing link', () => {
  it('reads a token that shares the hash with a route', () => {
    expect(readPairingTokenFromHash('#bridge-token=abc123')).toBe('abc123');
    expect(readPairingTokenFromHash('#welcome&bridge-token=abc123')).toBe('abc123');
    expect(readPairingTokenFromHash('#bridge-token=abc123&welcome')).toBe('abc123');
  });

  it('decodes escaped characters and rejects an empty value', () => {
    expect(readPairingTokenFromHash('#bridge-token=a%2Bb%2Fc%3D')).toBe('a+b/c=');
    expect(readPairingTokenFromHash('#bridge-token=')).toBeNull();
    expect(readPairingTokenFromHash('#welcome')).toBeNull();
    expect(readPairingTokenFromHash('')).toBeNull();
  });

  it('keeps a base64url token (the bridge format) byte-for-byte', () => {
    const token = 'BHB3-_xyzABCDEFGHIJKLMNOPQRSTzWLe';
    expect(readPairingTokenFromHash(`#bridge-token=${encodeURIComponent(token)}`)).toBe(token);
  });

  it('strips only the pairing entry, preserving the rest of the hash', () => {
    expect(stripPairingTokenFromHash('#bridge-token=abc123')).toBe('');
    expect(stripPairingTokenFromHash('#welcome&bridge-token=abc123')).toBe('#welcome');
    expect(stripPairingTokenFromHash('#bridge-token=abc123&welcome')).toBe('#welcome');
    expect(stripPairingTokenFromHash('#welcome')).toBe('#welcome');
  });

  it('ignores a key that merely starts with the pairing key', () => {
    expect(readPairingTokenFromHash('#bridge-token-legacy=abc123')).toBeNull();
    expect(stripPairingTokenFromHash('#bridge-token-legacy=abc123')).toBe(
      '#bridge-token-legacy=abc123'
    );
  });
});

/**
 * Discovery parsing. The bridge grew a second kind of local lane (a CLI agent it runs as a
 * subprocess), and it lives in its own `agents` array precisely because the old parser coerced every
 * unrecognized `kind` to `'openai'` — which would have produced a provider pointed at
 * `/providers/agy`, an endpoint that does not exist.
 */
describe('bridge discovery parsing', () => {
  it('reads proxied providers and local CLI agents, agents last', () => {
    const entries = parseEntries({
      providers: [
        { id: 'openai', label: 'OpenAI', kind: 'openai' },
        { id: 'claude-bridge', label: 'Claude Code (MAX)', kind: 'agent-sdk' },
      ],
      agents: [{ id: 'agy', label: 'Antigravity (agy)', kind: 'agent-cli', available: true }],
    });
    // Order decides `LlmProviderRegistry.getPreferred()`, so a CLI agent must never jump the queue.
    expect(entries.map(entry => entry.id)).toEqual(['openai', 'claude-bridge', 'agy']);
    expect(entries[2].kind).toBe('agent-cli');
  });

  it('skips an entry whose kind this editor does not understand', () => {
    const entries = parseEntries({
      providers: [{ id: 'openai', label: 'OpenAI', kind: 'openai' }],
      agents: [
        { id: 'future-lane', label: 'Something new', kind: 'agent-quantum' },
        { id: 'agy', label: 'Antigravity (agy)', kind: 'agent-cli' },
      ],
    });
    expect(entries.map(entry => entry.id)).toEqual(['openai', 'agy']);
  });

  it('carries a CLI agent’s health through, so the picker can gate tools on it', () => {
    const [agent] = parseEntries({
      agents: [
        {
          id: 'agy',
          label: 'Antigravity (agy)',
          kind: 'agent-cli',
          available: true,
          version: '1.2.5',
          auth: 'ok',
          mcp: 'missing',
          tools: 'disabled',
          diagnostics: [{ reason: 'mcp-not-registered', severity: 'warning', message: 'no shim' }],
        },
      ],
    });
    expect(agent.status).toEqual({
      available: true,
      version: '1.2.5',
      auth: 'ok',
      mcp: 'missing',
      tools: 'disabled',
      diagnostics: [{ reason: 'mcp-not-registered', severity: 'warning', message: 'no shim' }],
    });
  });

  it('maps Codex discovery to its own endpoint and models', () => {
    const [entry] = parseEntries({
      agents: [
        {
          id: 'codex',
          label: 'Codex CLI',
          kind: 'agent-cli',
          available: true,
          auth: 'ok',
          mcp: 'missing',
          tools: 'disabled',
        },
      ],
    });
    const provider = createBridgeProvider(entry, 'http://127.0.0.1:8484');
    expect(provider.id).toBe('codex');
    expect(provider.defaultBaseUrl).toBe('http://127.0.0.1:8484/agents/codex/v1');
    expect(provider.models.map(model => model.id)).toContain('gpt-5.6-sol');
    expect(provider.models[0].capabilities.supportsTools).toBe(false);
  });

  it('still reads a bridge that predates the explicit provider kind', () => {
    const entries = parseEntries({ providers: [{ id: 'custom', label: 'Custom' }] });
    expect(entries).toEqual([{ id: 'custom', label: 'Custom', kind: 'openai' }]);
  });

  it('survives a payload that is not the shape it expects', () => {
    expect(parseEntries(null)).toEqual([]);
    expect(parseEntries({ providers: 'nope', agents: 7 })).toEqual([]);
    expect(parseEntries({ agents: [{ label: 'no id', kind: 'agent-cli' }] })).toEqual([]);
  });
});
