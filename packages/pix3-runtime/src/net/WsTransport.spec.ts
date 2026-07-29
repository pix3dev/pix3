/**
 * `WsTransport` behaviour, driven entirely through a fake socket and fake timers — no real network,
 * no real waiting. The transport is protocol-agnostic, so nothing here builds a protocol frame: the
 * payloads are arbitrary bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WS_CLOSE_PROTOCOL_VIOLATION,
  WsTransport,
  type WsLikeSocket,
  type WsTransportCloseInfo,
  type WsTransportOptions,
  type WsTransportState,
} from './WsTransport';

class FakeSocket implements WsLikeSocket {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  // ── Test drivers ───────────────────────────────────────────────────────────

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  serverBinary(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as MessageEvent);
  }

  serverText(text: string): void {
    this.onmessage?.({ data: text } as MessageEvent);
  }

  serverClose(code = 1006, reason = '', wasClean = false): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }
}

function createTransport(overrides: Partial<WsTransportOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const states: WsTransportState[] = [];
  const closes: (WsTransportCloseInfo | null)[] = [];
  const frames: Uint8Array[] = [];

  const transport = new WsTransport({
    url: 'wss://rooms.example/room',
    socketFactory: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    // Deterministic backoff: no jitter, tiny delays.
    backoff: { initialDelayMs: 100, factor: 2, jitterRatio: 0, maxAttempts: 3 },
    random: () => 0.5,
    ...overrides,
  });

  transport.onFrame = frame => frames.push(frame.slice());
  transport.onStateChange = (state, info) => {
    states.push(state);
    closes.push(info);
  };

  const last = (): FakeSocket => {
    const socket = sockets[sockets.length - 1];
    if (!socket) {
      throw new Error('no socket was created');
    }
    return socket;
  };

  return { transport, sockets, states, closes, frames, last };
}

describe('WsTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a socket in arraybuffer mode and reports its states', () => {
    const h = createTransport();
    expect(h.transport.state).toBe('idle');

    h.transport.connect();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().binaryType).toBe('arraybuffer');
    expect(h.transport.state).toBe('connecting');

    h.last().serverOpen();
    expect(h.transport.state).toBe('open');
    expect(h.transport.isOpen).toBe(true);
    expect(h.states).toEqual(['connecting', 'open']);
  });

  it('never queues while not open: send returns false and counts the drop', () => {
    const h = createTransport();
    const payload = new Uint8Array([1, 2, 3]);

    expect(h.transport.send(payload)).toBe(false);

    h.transport.connect();
    expect(h.transport.send(payload)).toBe(false);
    expect(h.last().sent).toHaveLength(0);

    h.last().serverOpen();
    expect(h.transport.send(payload)).toBe(true);
    expect(h.last().sent).toEqual([payload]);

    h.last().serverClose();
    expect(h.transport.send(payload)).toBe(false);

    const stats = h.transport.stats;
    expect(stats.framesSent).toBe(1);
    expect(stats.framesDropped).toBe(3);
    // Nothing was buffered while closed: the one frame the socket saw is the one sent while open.
    expect(h.sockets[0].sent).toHaveLength(1);
  });

  it('delivers inbound binary frames and counts the bytes', () => {
    const h = createTransport();
    h.transport.connect();
    h.last().serverOpen();

    h.last().serverBinary(new Uint8Array([2, 7, 7]));

    expect(h.frames).toEqual([new Uint8Array([2, 7, 7])]);
    expect(h.transport.stats.framesReceived).toBe(1);
    expect(h.transport.stats.bytesReceived).toBe(3);
  });

  it('treats a text frame as a protocol violation: counted, closed, never reconnected', () => {
    const h = createTransport();
    h.transport.connect();
    h.last().serverOpen();

    h.last().serverText('{"hello":"world"}');

    expect(h.transport.stats.textFramesReceived).toBe(1);
    expect(h.last().closeCalls).toEqual([
      { code: WS_CLOSE_PROTOCOL_VIOLATION, reason: 'text frame' },
    ]);
    expect(h.transport.state).toBe('closed');
    expect(h.transport.closeInfo?.reason).toBe('protocol-violation');
    expect(h.frames).toHaveLength(0);

    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('surfaces the close code and reason so the session can map 4002 to a real message', () => {
    const h = createTransport({ shouldReconnect: () => false });
    h.transport.connect();
    h.last().serverOpen();

    h.last().serverClose(4002, 'token expired', true);

    expect(h.transport.state).toBe('closed');
    expect(h.transport.closeInfo).toEqual({
      reason: 'server',
      code: 4002,
      message: 'token expired',
      wasClean: true,
    });
  });

  it('reconnects with exponential backoff and gives up at the attempt cap', () => {
    const h = createTransport();
    h.transport.connect();
    h.last().serverOpen();
    h.last().serverClose();

    expect(h.transport.state).toBe('reconnecting');

    // Attempt 1 after 100 ms, attempt 2 after 200 ms, attempt 3 after 400 ms (factor 2, no jitter).
    vi.advanceTimersByTime(99);
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(2);

    h.last().serverClose();
    vi.advanceTimersByTime(199);
    expect(h.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(3);

    h.last().serverClose();
    vi.advanceTimersByTime(400);
    expect(h.sockets).toHaveLength(4);

    // The cap is 3 retries; the fourth failure is terminal.
    h.last().serverClose(4004, 'rate limited');
    expect(h.transport.state).toBe('closed');
    expect(h.transport.closeInfo?.reason).toBe('attempts-exhausted');
    expect(h.transport.closeInfo?.code).toBe(4004);

    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(4);
  });

  it('applies jitter around the computed delay', () => {
    // random() = 1 puts the sample at the top of the ±25 % spread: 100 × 1.25.
    const h = createTransport({
      backoff: { initialDelayMs: 100, factor: 2, jitterRatio: 0.25, maxAttempts: 3 },
      random: () => 1,
    });
    h.transport.connect();
    h.last().serverOpen();
    h.last().serverClose();

    vi.advanceTimersByTime(124);
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(2);
  });

  it('resets the attempt counter after a successful open', () => {
    const h = createTransport();
    h.transport.connect();
    h.last().serverOpen();
    h.last().serverClose();
    vi.advanceTimersByTime(100);
    expect(h.transport.attemptCount).toBe(1);

    h.last().serverOpen();
    expect(h.transport.attemptCount).toBe(0);
    expect(h.transport.state).toBe('open');
  });

  it('honours a reconnect policy that refuses a permanent failure', () => {
    const refused: WsTransportCloseInfo[] = [];
    const h = createTransport({
      shouldReconnect: info => {
        refused.push(info);
        return false;
      },
    });
    h.transport.connect();
    h.last().serverOpen();
    h.last().serverClose(4001, 'protocol version');

    expect(refused).toHaveLength(1);
    expect(h.transport.state).toBe('closed');
    expect(h.transport.closeInfo?.reason).toBe('server');
    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('close() is terminal and deliberate', () => {
    const h = createTransport();
    h.transport.connect();
    h.last().serverOpen();

    h.transport.close(1000, 'bye');

    expect(h.last().closeCalls).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(h.transport.state).toBe('closed');
    expect(h.transport.closeInfo?.reason).toBe('client');
    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('dispose() stops everything and never reconnects afterwards', () => {
    const h = createTransport();
    h.transport.connect();
    h.last().serverOpen();
    const socket = h.last();

    h.transport.dispose();

    expect(socket.closeCalls).toHaveLength(1);
    expect(h.transport.state).toBe('closed');
    expect(h.transport.send(new Uint8Array([1]))).toBe(false);

    // A late close event from the socket must not resurrect anything.
    socket.serverClose();
    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(1);

    h.transport.connect();
    expect(h.sockets).toHaveLength(1);
  });

  it('reports a socket that cannot even be constructed as a terminal error', () => {
    const transport = new WsTransport({
      url: 'wss://rooms.example/room',
      socketFactory: () => {
        throw new Error('no WebSocket here');
      },
    });
    const states: WsTransportState[] = [];
    transport.onStateChange = state => states.push(state);

    transport.connect();

    expect(states).toEqual(['connecting', 'closed']);
    expect(transport.closeInfo?.reason).toBe('error');
    expect(transport.closeInfo?.message).toBe('no WebSocket here');
  });

  it('ignores an inbound payload that is neither text nor bytes', () => {
    const h = createTransport();
    h.transport.connect();
    h.last().serverOpen();

    h.last().onmessage?.({ data: { not: 'bytes' } } as MessageEvent);

    expect(h.frames).toHaveLength(0);
    expect(h.transport.stats.unusableFramesReceived).toBe(1);
    expect(h.transport.state).toBe('open');
  });
});
