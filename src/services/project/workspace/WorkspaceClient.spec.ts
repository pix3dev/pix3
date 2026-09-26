import { describe, expect, it, vi } from 'vitest';

import { WorkspaceClient } from '@/services/project/workspace/WorkspaceClient';
import {
  WorkspaceConflictError,
  WorkspaceError,
  normalizeWorkspaceEndpoint,
} from '@/services/project/workspace/workspace-protocol';

const ENDPOINT = 'http://localhost:8490';
const TOKEN = 'p3ws_test-token';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit | null | undefined;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

function createClient(responder: Responder) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: input,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: init?.body,
    };
    requests.push(request);
    return responder(request);
  });
  const client = new WorkspaceClient(fetchImpl);
  client.configure({ endpoint: ENDPOINT, token: TOKEN });
  return { client, requests, fetchImpl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const file = (body: string, sha: string): Response =>
  new Response(body, { status: 200, headers: { ETag: `"${sha}"` } });

describe('WorkspaceClient', () => {
  it('sends the bearer token and percent-encodes the path once', async () => {
    const { client, requests } = createClient(() => file('hello', 'h1'));

    await expect(client.readText('res://scenes/my level.pix3scene')).resolves.toBe('hello');

    expect(requests[0].url).toBe(`${ENDPOINT}/ws/file?path=scenes%2Fmy%20level.pix3scene`);
    expect(requests[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].headers['If-None-Match']).toBeUndefined();
  });

  it('revalidates a cached body with If-None-Match and reuses it on 304', async () => {
    let call = 0;
    const { client, requests } = createClient(() => {
      call += 1;
      return call === 1
        ? file('scene v1', 'sha-1')
        : new Response(null, { status: 304, headers: { ETag: '"sha-1"' } });
    });

    await expect(client.readText('scenes/main.pix3scene')).resolves.toBe('scene v1');
    await expect(client.readText('scenes/main.pix3scene')).resolves.toBe('scene v1');

    expect(requests[1].headers['If-None-Match']).toBe('"sha-1"');
    expect(client.getKnownHash('scenes/main.pix3scene')).toBe('sha-1');
  });

  it('takes the new bytes and hash when the file changed (200 after If-None-Match)', async () => {
    let call = 0;
    const { client } = createClient(() => {
      call += 1;
      return call === 1 ? file('v1', 'sha-1') : file('v2', 'sha-2');
    });

    await client.readText('a.txt');
    await expect(client.readText('a.txt')).resolves.toBe('v2');
    expect(client.getKnownHash('a.txt')).toBe('sha-2');
  });

  it('writes with If-Match = the hash last read, plus a mutation id', async () => {
    const { client, requests } = createClient(request => {
      if (request.method === 'GET') {
        return file('old', 'base-hash');
      }
      return json(200, { path: 'a.txt', sha256: 'new-hash', size: 3, mtime: 1, seq: 4 });
    });

    await client.readText('a.txt');
    await client.writeFile('a.txt', 'new');

    const put = requests[1];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(`${ENDPOINT}/ws/file?path=a.txt`);
    expect(put.headers['If-Match']).toBe('"base-hash"');
    expect(put.headers['X-Mutation-Id']).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(client.getKnownHash('a.txt')).toBe('new-hash');
  });

  it('writes a never-read path without If-Match', async () => {
    const { client, requests } = createClient(() =>
      json(200, { path: 'new.txt', sha256: 'h', size: 1, mtime: 1, seq: 1 })
    );

    await client.writeFile('new.txt', 'x');

    expect(requests[0].headers['If-Match']).toBeUndefined();
    expect(requests[0].headers['X-Mutation-Id']).toBeTruthy();
  });

  it('turns 409 base_mismatch into a typed conflict error and keeps the old base', async () => {
    const { client } = createClient(request =>
      request.method === 'GET'
        ? file('old', 'base-hash')
        : json(409, { error: 'base_mismatch', message: 'changed', currentHash: 'agent-hash' })
    );

    await client.readText('scenes/main.pix3scene');
    const error = await client.writeFile('scenes/main.pix3scene', 'mine').catch(e => e);

    expect(error).toBeInstanceOf(WorkspaceConflictError);
    expect(error).toMatchObject({
      code: 'base_mismatch',
      path: 'scenes/main.pix3scene',
      baseHash: 'base-hash',
      currentHash: 'agent-hash',
    });
    expect(client.getKnownHash('scenes/main.pix3scene')).toBe('base-hash');
  });

  it('retries a mutation whose response was lost with the SAME mutation id', async () => {
    let attempts = 0;
    const { client, requests } = createClient(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('Failed to fetch');
      }
      return json(200, { path: 'd', created: true, seq: 2 });
    });

    await client.mkdir('d');

    expect(requests).toHaveLength(2);
    expect(requests[1].headers['X-Mutation-Id']).toBe(requests[0].headers['X-Mutation-Id']);
  });

  it('maps 401 to an unauthorized error that asks for a new token', async () => {
    const { client } = createClient(() => json(401, { error: 'unauthorized' }));

    const error = await client.status().catch(e => e);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.code).toBe('unauthorized');
    expect(error.message).toMatch(/token/);
  });

  it('reports an unreachable server as connection_failed', async () => {
    const { client } = createClient(() => {
      throw new TypeError('Failed to fetch');
    });

    const error = await client.status().catch(e => e);

    expect(error.code).toBe('connection_failed');
    expect(error.message).toContain(ENDPOINT);
  });

  it('keeps the manifest in step with its own writes, moves and deletes', async () => {
    const { client } = createClient(request => {
      if (request.url.endsWith('/ws/manifest')) {
        return json(200, {
          workspaceId: 'w',
          serverSession: 's',
          revision: 'r',
          seq: 0,
          files: [{ path: 'scenes', kind: 'dir', size: 0, mtime: 1 }],
        });
      }
      if (request.url.includes('/ws/move')) {
        return json(200, {
          from: 'scenes/a.pix3scene',
          to: 'levels/a.pix3scene',
          kind: 'file',
          seq: 3,
        });
      }
      if (request.url.includes('/ws/delete')) {
        return json(200, { path: 'levels', kind: 'dir', seq: 4 });
      }
      return json(200, { path: 'scenes/a.pix3scene', sha256: 'h', size: 5, mtime: 7, seq: 2 });
    });

    await client.getManifest();
    await client.writeFile('scenes/a.pix3scene', 'hello');
    expect(client.getManifestEntry('scenes/a.pix3scene')).toMatchObject({ size: 5, mtime: 7 });

    await client.move('scenes/a.pix3scene', 'levels/a.pix3scene');
    expect(client.getManifestEntry('scenes/a.pix3scene')).toBeNull();
    expect(client.getManifestEntry('levels/a.pix3scene')?.kind).toBe('file');
    expect(client.getManifestEntry('levels')?.kind).toBe('dir');
    expect(client.getKnownHash('levels/a.pix3scene')).toBe('h');

    await client.delete('levels', { recursive: true });
    expect(client.getManifestEntry('levels/a.pix3scene')).toBeNull();
    expect(client.getKnownHash('levels/a.pix3scene')).toBeNull();
  });
});

describe('normalizeWorkspaceEndpoint', () => {
  it('accepts what a user types', () => {
    expect(normalizeWorkspaceEndpoint(' localhost:8490 ')).toBe('http://localhost:8490');
    expect(normalizeWorkspaceEndpoint('http://127.0.0.1:8491/')).toBe('http://127.0.0.1:8491');
  });

  it('refuses non-http schemes', () => {
    expect(() => normalizeWorkspaceEndpoint('ftp://localhost')).toThrow(WorkspaceError);
  });
});
