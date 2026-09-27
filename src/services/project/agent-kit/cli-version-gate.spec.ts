import { describe, expect, it, vi } from 'vitest';

import {
  NPM_REGISTRY_CLI_URL,
  pinnedCliVersion,
  resolvePublishedCliVersion,
} from './cli-version-gate';

const packument = (versions: string[], latest?: string): Response =>
  new Response(
    JSON.stringify({
      name: '@pix3/cli',
      'dist-tags': latest ? { latest } : {},
      versions: Object.fromEntries(versions.map(v => [v, { version: v }])),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

const fetchReturning = (response: Response | Error) =>
  vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (response instanceof Error) throw response;
    return response;
  });

describe('resolvePublishedCliVersion (the .mcp.json publish gate)', () => {
  it('pins the editor lockstep version when it is published', async () => {
    const fetchImpl = fetchReturning(packument(['1.5.0', '1.6.0'], '1.6.0'));
    const result = await resolvePublishedCliVersion({ editorVersion: '1.6.0', fetchImpl });
    expect(result).toEqual({ kind: 'lockstep', version: '1.6.0' });
    expect(pinnedCliVersion(result)).toBe('1.6.0');
    expect(fetchImpl).toHaveBeenCalledWith(NPM_REGISTRY_CLI_URL, expect.anything());
  });

  it('falls back to the latest published version when the lockstep one is not on npm', async () => {
    const result = await resolvePublishedCliVersion({
      editorVersion: '1.7.0',
      fetchImpl: fetchReturning(packument(['1.5.0', '1.6.0'], '1.6.0')),
    });
    expect(result).toEqual({ kind: 'latest', version: '1.6.0' });
    expect(pinnedCliVersion(result)).toBe('1.6.0');
  });

  it('pins nothing when the package is not published (404)', async () => {
    const result = await resolvePublishedCliVersion({
      editorVersion: '1.6.0',
      confirmedVersion: '1.5.0',
      fetchImpl: fetchReturning(new Response('{}', { status: 404 })),
    });
    expect(result).toEqual({ kind: 'unavailable', reason: 'not-published' });
    expect(pinnedCliVersion(result)).toBeNull();
  });

  it('pins nothing when the registry cannot be reached and the build confirmed nothing', async () => {
    // A browser sees npm's CORS-less 404 as exactly this: a network error.
    const result = await resolvePublishedCliVersion({
      editorVersion: '1.6.0',
      fetchImpl: fetchReturning(new TypeError('Failed to fetch')),
    });
    expect(result).toEqual({ kind: 'unavailable', reason: 'unreachable' });
    expect(pinnedCliVersion(result)).toBeNull();
  });

  it("uses the build's last confirmed version when the registry is unreachable", async () => {
    const result = await resolvePublishedCliVersion({
      editorVersion: '1.6.0',
      confirmedVersion: '1.5.2',
      fetchImpl: fetchReturning(new TypeError('Failed to fetch')),
    });
    expect(result).toEqual({ kind: 'confirmed', version: '1.5.2' });
  });

  it('pins nothing when neither the lockstep nor a latest tag exists', async () => {
    const result = await resolvePublishedCliVersion({
      editorVersion: '1.6.0',
      fetchImpl: fetchReturning(packument([])),
    });
    expect(result).toEqual({ kind: 'unavailable', reason: 'not-published' });
  });
});
