import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { FileWatchService } from '@/services/project/FileWatchService';
import { WorkspaceClient } from '@/services/project/workspace/WorkspaceClient';
import {
  WorkspaceEventsClient,
  type WorkspaceSocketLike,
} from '@/services/project/workspace/WorkspaceEventsClient';
import { WorkspaceSessionService } from '@/services/project/workspace/WorkspaceSessionService';

class FakeSocket implements WorkspaceSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    const frame = this.sent.at(-1);
    // Minimal server: hello after auth, the configured lease answer after acquire.
    if (frame?.type === 'auth') {
      queueMicrotask(() => this.receive(HELLO));
    } else if (frame?.type === 'lease' && frame.action === 'acquire') {
      queueMicrotask(() => this.receive(leaseAnswer));
    } else if (frame?.type === 'lease' && frame.action === 'takeover') {
      queueMicrotask(() =>
        this.receive({ type: 'lease', state: 'granted', leaseId: 'l2', resumed: false })
      );
    }
  }

  close(): void {
    this.readyState = 3;
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
}

const HELLO = {
  type: 'hello',
  workspaceId: 'ws-1',
  serverSession: 'session-1',
  protocol: 1,
  cliVersion: '1.6.0',
  revision: 'rev-1',
  seq: 0,
  root: '/srv/game',
  projectId: 'p-1',
  projectName: 'Game',
  lease: 'free',
};

let leaseAnswer: Record<string, unknown> = {
  type: 'lease',
  state: 'granted',
  leaseId: 'l1',
  resumed: false,
};

const STATUS = {
  workspaceId: 'ws-1',
  serverSession: 'session-1',
  protocol: 1,
  cliVersion: '1.6.0',
  root: '/srv/game',
  pid: 1,
  port: 8490,
  revision: 'rev-1',
  seq: 0,
  leased: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('WorkspaceSessionService', () => {
  let session: WorkspaceSessionService;
  let client: WorkspaceClient;
  let fileWatch: FileWatchService;
  let sockets: FakeSocket[];
  let manifestFiles: Array<Record<string, unknown>>;
  let statusBody: Record<string, unknown>;

  beforeEach(() => {
    resetAppState();
    leaseAnswer = { type: 'lease', state: 'granted', leaseId: 'l1', resumed: false };
    statusBody = { ...STATUS };
    manifestFiles = [
      { path: 'scenes', kind: 'dir', size: 0, mtime: 1 },
      { path: 'scenes/main.pix3scene', kind: 'file', size: 4, mtime: 1, sha256: 'sha-main' },
    ];
    sockets = [];
    client = new WorkspaceClient(async (input: string) => {
      if (input.endsWith('/ws/status')) return json(statusBody);
      if (input.endsWith('/ws/manifest')) {
        return json({
          workspaceId: 'ws-1',
          serverSession: 'session-1',
          revision: 'rev-1',
          seq: 0,
          files: manifestFiles,
        });
      }
      if (input.includes('/ws/file')) {
        return new Response('scene', { status: 200, headers: { ETag: '"sha-main"' } });
      }
      return json({}, 404);
    });
    fileWatch = new FileWatchService();
    session = new WorkspaceSessionService();
    Object.defineProperty(session, 'client', { value: client });
    Object.defineProperty(session, 'fileWatch', { value: fileWatch });
    session.setEventsClientFactory(
      () =>
        new WorkspaceEventsClient({
          createSocket: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            queueMicrotask(() => {
              socket.readyState = 1;
              socket.onopen?.(new Event('open'));
            });
            return socket;
          },
        })
    );
  });

  afterEach(() => {
    session.dispose();
    fileWatch.dispose();
    resetAppState();
  });

  it('connects: status → socket hello → lease, and turns push mode on', async () => {
    const connection = await session.connect('localhost:8490', ' p3ws_token ');

    expect(connection.endpoint).toBe('http://localhost:8490');
    expect(connection.hello.projectName).toBe('Game');
    expect(sockets[0].sent[0]).toEqual({ type: 'auth', token: 'p3ws_token' });
    expect(appState.project.workspace).toMatchObject({
      status: 'connected',
      lease: 'held',
      workspaceId: 'ws-1',
      root: '/srv/game',
    });
    expect(fileWatch.isPushMode()).toBe(true);
  });

  it('refuses a server speaking another protocol version', async () => {
    statusBody = { ...STATUS, protocol: 2 };

    await expect(session.connect('http://localhost:8490', 't')).rejects.toMatchObject({
      code: 'protocol_mismatch',
    });
    expect(appState.project.workspace.status).toBe('disconnected');
    expect(fileWatch.isPushMode()).toBe(false);
  });

  it('refuses when the address now serves a different workspace', async () => {
    await expect(
      session.connect('http://localhost:8490', 't', { expectedWorkspaceId: 'other' })
    ).rejects.toMatchObject({ code: 'workspace_mismatch' });
  });

  it('marks the window read-only when the lease is busy, and takes it over on request', async () => {
    leaseAnswer = { type: 'lease', state: 'busy', inGrace: false };
    await session.connect('http://localhost:8490', 't');

    expect(appState.project.workspace.lease).toBe('busy');
    expect(session.canWrite()).toBe(false);

    session.takeOverLease();
    await vi.waitFor(() => expect(appState.project.workspace.lease).toBe('held'));
    expect(sockets[0].sent.at(-1)).toEqual({ type: 'lease', action: 'takeover' });
    expect(session.canWrite()).toBe(true);
  });

  it('pushes external changes to watchers and ignores the hash this editor already has', async () => {
    await session.connect('http://localhost:8490', 't');
    await client.readText('scenes/main.pix3scene'); // known hash: sha-main
    const onChange = vi.fn();
    fileWatch.watch('res://scenes/main.pix3scene', null, null, onChange);
    const signalBefore = appState.project.fileRefreshSignal;

    // Echo of what we already have → not an external change.
    await session.handleChangeFrame({
      type: 'change',
      seq: 1,
      revision: 'r2',
      events: [{ op: 'modify', path: 'scenes/main.pix3scene', kind: 'file', sha256: 'sha-main' }],
    });
    expect(onChange).not.toHaveBeenCalled();

    await session.handleChangeFrame({
      type: 'change',
      seq: 2,
      revision: 'r3',
      events: [
        { op: 'modify', path: 'scenes/main.pix3scene', kind: 'file', sha256: 'sha-agent' },
        { op: 'create', path: 'scenes/level2.pix3scene', kind: 'file', sha256: 'sha-l2' },
      ],
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(appState.project.fileRefreshSignal).toBeGreaterThan(signalBefore);
    expect(appState.project.lastModifiedDirectoryPath).toBe('scenes');
    expect(client.getManifestEntry('scenes/level2.pix3scene')?.sha256).toBe('sha-l2');
  });

  it('re-scans after a reconnect and reports what changed while the socket was down', async () => {
    await session.connect('http://localhost:8490', 't');
    const onChange = vi.fn();
    fileWatch.watch('res://scenes/main.pix3scene', null, null, onChange);

    manifestFiles = [
      { path: 'scenes', kind: 'dir', size: 0, mtime: 1 },
      { path: 'scenes/main.pix3scene', kind: 'file', size: 9, mtime: 2, sha256: 'sha-new' },
    ];
    await session.rescan();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(client.getManifestEntry('scenes/main.pix3scene')?.sha256).toBe('sha-new');
  });

  it('drops the connection when another project replaces the workspace one', async () => {
    await session.connect('http://localhost:8490', 't');
    appState.project.backend = 'workspace';
    appState.project.id = 'ws-1';
    session.attachToProject('ws-1');

    appState.project.backend = 'local';
    appState.project.id = 'folder-1';
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    expect(appState.project.workspace.status).toBe('disconnected');
  });
});
