import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorkspaceEventsClient,
  sessionLeaseStore,
  type StoredWorkspaceLease,
  type WorkspaceEventsHandlers,
  type WorkspaceLeaseStore,
  type WorkspaceSocketLike,
} from '@/services/project/workspace/WorkspaceEventsClient';
import type { WorkspaceHelloFrame } from '@/services/project/workspace/workspace-protocol';

class FakeSocket implements WorkspaceSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // --- server side ---
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }

  drop(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const hello = (overrides: Partial<WorkspaceHelloFrame> = {}): Record<string, unknown> => ({
  type: 'hello',
  workspaceId: 'ws-1',
  serverSession: 'session-1',
  protocol: 1,
  cliVersion: '1.6.0',
  revision: 'rev-1',
  seq: 0,
  root: '/srv/game',
  projectId: null,
  projectName: 'Game',
  lease: 'free',
  ...overrides,
});

describe('WorkspaceEventsClient', () => {
  let sockets: FakeSocket[];
  let client: WorkspaceEventsClient;

  const makeClient = (leaseStore?: WorkspaceLeaseStore): WorkspaceEventsClient =>
    new WorkspaceEventsClient({
      createSocket: url => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      backoffMs: [100, 200],
      ...(leaseStore ? { leaseStore } : {}),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    sockets = [];
    client = makeClient();
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  const connect = (handlers: WorkspaceEventsHandlers = {}): FakeSocket => {
    client.connect('http://localhost:8490', 'p3ws_secret', handlers);
    const socket = sockets[sockets.length - 1];
    socket.open();
    return socket;
  };

  it('connects to /ws/events without the token in the URL and sends auth first', () => {
    const socket = connect();

    expect(socket.url).toBe('ws://localhost:8490/ws/events');
    expect(socket.url).not.toContain('p3ws_secret');
    expect(socket.sent[0]).toEqual({ type: 'auth', token: 'p3ws_secret' });
  });

  it('reports hello, then asks for the lease', () => {
    const onHello = vi.fn();
    const socket = connect({ onHello });

    socket.receive(hello());

    expect(onHello).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1' }), {
      reconnected: false,
    });
    expect(socket.sent[1]).toEqual({ type: 'lease', action: 'acquire' });
  });

  it('dispatches change batches and answers pings', () => {
    const onChange = vi.fn();
    const socket = connect({ onChange });
    socket.receive(hello());

    const frame = {
      type: 'change',
      seq: 3,
      revision: 'rev-2',
      events: [{ op: 'modify', path: 'scenes/main.pix3scene', kind: 'file', sha256: 'abc' }],
    };
    socket.receive(frame);
    socket.receive({ type: 'ping' });

    expect(onChange).toHaveBeenCalledWith(frame);
    expect(socket.sent.at(-1)).toEqual({ type: 'pong' });
    expect(client.getLastRevision()).toBe('rev-2');
  });

  it('reconnects with backoff, resumes the lease and asks for a re-scan', () => {
    const onRescanNeeded = vi.fn();
    const onConnectionState = vi.fn();
    const first = connect({ onRescanNeeded, onConnectionState });
    first.receive(hello());
    first.receive({ type: 'lease', state: 'granted', leaseId: 'lease-7', resumed: false });

    first.drop(1006);
    expect(onConnectionState).toHaveBeenLastCalledWith('reconnecting');
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    const second = sockets[1];
    second.open();
    expect(second.sent[0]).toEqual({ type: 'auth', token: 'p3ws_secret' });

    second.receive(hello({ revision: 'rev-9' }));

    expect(onRescanNeeded).toHaveBeenCalledTimes(1);
    expect(second.sent[1]).toEqual({ type: 'lease', action: 'acquire', leaseId: 'lease-7' });
  });

  it('reports a busy lease and sends takeover on request', () => {
    const onLease = vi.fn();
    const socket = connect({ onLease });
    socket.receive(hello());
    socket.receive({ type: 'lease', state: 'busy', inGrace: true });

    expect(onLease).toHaveBeenCalledWith({ type: 'lease', state: 'busy', inGrace: true });

    client.takeOverLease();
    expect(socket.sent.at(-1)).toEqual({ type: 'lease', action: 'takeover' });
  });

  it('does not reconnect after an auth failure (4401)', () => {
    const onConnectionState = vi.fn();
    const socket = connect({ onConnectionState });

    socket.drop(4401, 'unauthorized');
    vi.advanceTimersByTime(10_000);

    expect(sockets).toHaveLength(1);
    expect(onConnectionState).toHaveBeenLastCalledWith(
      'closed',
      expect.objectContaining({ code: 'unauthorized' })
    );
  });

  it('answers MCP calls with an isError "not implemented" result', () => {
    const socket = connect();
    socket.receive(hello());
    socket.receive({ type: 'call', id: 'c1', name: 'get_scene', input: {} });

    expect(socket.sent.at(-1)).toMatchObject({
      type: 'call-result',
      id: 'c1',
      result: { isError: true },
    });
  });

  it('releases the lease when closed on purpose and stays closed', () => {
    const socket = connect();
    socket.receive(hello());
    socket.receive({ type: 'lease', state: 'granted', leaseId: 'l', resumed: false });

    client.close();
    vi.advanceTimersByTime(10_000);

    expect(socket.sent.at(-1)).toEqual({ type: 'lease', action: 'release' });
    expect(socket.closed).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  describe('lease across a tab reload', () => {
    const memoryStore = (): WorkspaceLeaseStore & { map: Map<string, StoredWorkspaceLease> } => {
      const map = new Map<string, StoredWorkspaceLease>();
      return {
        map,
        get: id => map.get(id) ?? null,
        set: (id, lease) => void map.set(id, lease),
        clear: id => void map.delete(id),
      };
    };

    it('persists the granted leaseId per workspace in sessionStorage and sends it after a reload', () => {
      const socket = connect();
      socket.receive(hello());
      socket.receive({ type: 'lease', state: 'granted', leaseId: 'lease-7', resumed: false });
      expect(sessionLeaseStore.get('ws-1')).toEqual({
        leaseId: 'lease-7',
        serverSession: 'session-1',
      });

      // F5: the page (and this client) is gone without a close(); a new one starts from scratch.
      const reloaded = makeClient();
      reloaded.connect('http://localhost:8490', 'p3ws_secret', {});
      const next = sockets.at(-1)!;
      next.open();
      next.receive(hello());
      expect(next.sent[1]).toEqual({ type: 'lease', action: 'acquire', leaseId: 'lease-7' });
      next.receive({ type: 'lease', state: 'granted', leaseId: 'lease-7', resumed: true });
      expect(reloaded.getLeaseId()).toBe('lease-7');
      reloaded.close();
    });

    it('ignores a stored lease of another server run, and of another workspace', () => {
      const store = memoryStore();
      store.set('ws-1', { leaseId: 'old', serverSession: 'session-0' });
      store.set('ws-2', { leaseId: 'other-ws', serverSession: 'session-1' });
      client = makeClient(store);
      const socket = connect();
      socket.receive(hello());
      expect(socket.sent[1]).toEqual({ type: 'lease', action: 'acquire' });
      expect(store.map.has('ws-1')).toBe(false);
      expect(store.map.get('ws-2')?.leaseId).toBe('other-ws');
    });

    it('forgets the stored lease on lost, released and a deliberate close', () => {
      const store = memoryStore();
      client = makeClient(store);
      const socket = connect();
      socket.receive(hello());
      socket.receive({ type: 'lease', state: 'granted', leaseId: 'a', resumed: false });
      socket.receive({ type: 'lease', state: 'lost', reason: 'taken_over', leaseId: 'a' });
      expect(store.map.has('ws-1')).toBe(false);
      socket.receive({ type: 'lease', state: 'granted', leaseId: 'b', resumed: false });
      socket.receive({ type: 'lease', state: 'released' });
      expect(store.map.has('ws-1')).toBe(false);
      socket.receive({ type: 'lease', state: 'granted', leaseId: 'c', resumed: false });
      expect(store.map.get('ws-1')?.leaseId).toBe('c');
      client.close();
      expect(store.map.has('ws-1')).toBe(false);
    });

    it('retries acquire after busy-in-grace (grace from hello) until granted', () => {
      const onLease = vi.fn();
      const socket = connect({ onLease });
      socket.receive(hello({ leaseGraceMs: 10_000 }));
      socket.receive({ type: 'lease', state: 'busy', inGrace: true });
      const acquires = (): number =>
        socket.sent.filter(frame => frame.type === 'lease' && frame.action === 'acquire').length;
      expect(acquires()).toBe(1);

      vi.advanceTimersByTime(10_499);
      expect(acquires()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(acquires()).toBe(2);

      // Still in grace (timing): ask again after another grace.
      socket.receive({ type: 'lease', state: 'busy', inGrace: true });
      vi.advanceTimersByTime(10_500);
      expect(acquires()).toBe(3);

      socket.receive({ type: 'lease', state: 'granted', leaseId: 'fresh', resumed: false });
      vi.advanceTimersByTime(60_000);
      expect(acquires()).toBe(3);
      expect(client.getLeaseId()).toBe('fresh');
      expect(onLease).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'granted' }));
    });

    it('falls back to 11 s without leaseGraceMs, and stops at a non-grace busy', () => {
      const socket = connect();
      socket.receive(hello());
      socket.receive({ type: 'lease', state: 'busy', inGrace: true });
      const acquires = (): number =>
        socket.sent.filter(frame => frame.type === 'lease' && frame.action === 'acquire').length;
      vi.advanceTimersByTime(10_999);
      expect(acquires()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(acquires()).toBe(2);

      // Another window connected and took it: that is final until the user takes over.
      socket.receive({ type: 'lease', state: 'busy', inGrace: false });
      vi.advanceTimersByTime(60_000);
      expect(acquires()).toBe(2);
    });
  });
});
