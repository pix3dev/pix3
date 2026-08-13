/**
 * Manager-level tests for wedged-session recovery: the watchdog, `reset()` (what
 * `POST /v1/sessions/reset` calls) and eviction. The real {@link BridgeSession} spawns a Claude Code
 * CLI, so these drive the manager through its {@link ManagedSession} seam with a faked clock.
 *
 * Run: npm test   (node --test)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HARD_MAX_SESSIONS, MAX_SESSIONS, SessionManager } from './sessions.ts';
import type { BridgeResponse, ManagedSession } from './sessions.ts';
import type { WireMessagesRequest } from './wire.ts';

const START = 1_700_000_000_000;
/** Shortest threshold the config normalizer allows (it floors at 60 s). */
const STALL_MS = 60_000;

const RESPONSE: BridgeResponse = { status: 200, body: { ok: true } };

let seq = 0;

class FakeSession implements ManagedSession {
  readonly id = `s${(seq += 1)}`;
  model: string;
  transcriptLen = 0;
  lastActivity: number;
  lastProgress: number;
  closed = false;
  busy = false;
  wedged = false;
  /** Tool-use ids this session is parked on. */
  pendingToolUseIds = new Set<string>();
  closeReasons: string[] = [];
  forceCloses = 0;
  requests = 0;
  replays = 0;
  throwOnClose = false;

  constructor(model: string, at: number) {
    this.model = model;
    this.lastActivity = at;
    this.lastProgress = at;
  }

  hasPendingToolUse(toolUseId: string): boolean {
    return this.pendingToolUseIds.has(toolUseId);
  }

  toolsMatch(): boolean {
    return true;
  }

  effortMatches(): boolean {
    return true;
  }

  handleRequest(request: WireMessagesRequest): Promise<BridgeResponse> {
    this.requests += 1;
    this.transcriptLen = request.messages.length + 1;
    return Promise.resolve(RESPONSE);
  }

  handleTranscriptReplay(request: WireMessagesRequest): Promise<BridgeResponse> {
    this.replays += 1;
    this.transcriptLen = request.messages.length + 1;
    return Promise.resolve(RESPONSE);
  }

  close(reason: string): void {
    if (this.throwOnClose) throw new Error('close raced an in-flight abort');
    this.closed = true;
    this.closeReasons.push(reason);
  }

  forceClose(reason: string): void {
    this.forceCloses += 1;
    this.close(reason);
  }
}

interface Harness {
  readonly manager: SessionManager;
  readonly created: FakeSession[];
  readonly logs: string[];
  advance(ms: number): void;
  send(messageCount: number, model?: string): Promise<BridgeResponse>;
}

const harness = (): Harness => {
  let now = START;
  const created: FakeSession[] = [];
  const logs: string[] = [];
  const manager = new SessionManager(line => logs.push(line), {
    stallTimeoutMs: STALL_MS,
    autoSweep: false,
    now: () => now,
    createSession: request => {
      const session = new FakeSession(request.model, now);
      created.push(session);
      return session;
    },
  });
  return {
    manager,
    created,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    send: (messageCount: number, model = 'claude-sonnet-5') => {
      const messages = Array.from({ length: messageCount }, (_unused, index) => ({
        role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `m${index}`,
      }));
      return manager.handle({ model, messages }, new AbortController().signal);
    },
  };
};

describe('SessionManager.reset', () => {
  it('is a success when there is nothing to close', () => {
    const { manager } = harness();
    const result = manager.reset();
    assert.deepEqual(
      { closed: result.closed, remaining: result.remaining, stalled: result.stalled },
      { closed: 0, remaining: 0, stalled: 0 }
    );
    assert.equal(result.scope, 'stalled');
  });

  it('closes only the wedged sessions by default', async () => {
    const h = harness();
    await h.send(1);
    await h.send(1);
    const [wedged, healthy] = h.created;
    wedged.wedged = true;

    const result = h.manager.reset();
    assert.equal(result.closed, 1);
    assert.equal(result.remaining, 1);
    assert.equal(result.stalled, 0);
    assert.equal(wedged.closed, true);
    assert.equal(wedged.forceCloses, 1, 'a wedged session is interrupted before being closed');
    assert.equal(healthy.closed, false);
  });

  it('counts a busy session with no progress past the threshold as wedged', async () => {
    const h = harness();
    await h.send(1);
    const [session] = h.created;
    session.busy = true;
    h.advance(STALL_MS + 1_000);

    assert.equal(h.manager.stats().stalled, 1);
    assert.equal(h.manager.reset().closed, 1);
    assert.equal(session.closed, true);
  });

  it('leaves a busy session that is still producing output alone', async () => {
    const h = harness();
    await h.send(1);
    const [session] = h.created;
    session.busy = true;
    h.advance(STALL_MS - 1_000);
    session.lastProgress = START + STALL_MS - 1_000;

    assert.equal(h.manager.stats().stalled, 0);
    assert.equal(h.manager.reset().closed, 0);
    assert.equal(session.closed, false);
  });

  it('closes every session with all: true', async () => {
    const h = harness();
    await h.send(1);
    await h.send(1);
    h.created[1].busy = true;

    const result = h.manager.reset({ all: true });
    assert.equal(result.closed, 2);
    assert.equal(result.remaining, 0);
    assert.equal(result.scope, 'all');
    assert.ok(h.created.every(session => session.closed));
  });

  it('closes one session by key and reports an unknown key without failing', async () => {
    const h = harness();
    await h.send(1);
    await h.send(1);
    const [first, second] = h.created;

    const hit = h.manager.reset({ sessionKey: first.id });
    assert.equal(hit.closed, 1);
    assert.equal(hit.scope, 'session');
    assert.equal(hit.note, undefined);
    assert.equal(first.closed, true);
    assert.equal(second.closed, false);

    const miss = h.manager.reset({ sessionKey: 'does-not-exist' });
    assert.equal(miss.closed, 0);
    assert.equal(miss.remaining, 1);
    assert.match(miss.note ?? '', /does-not-exist/);
  });

  it('is idempotent and survives a close that throws mid-abort', async () => {
    const h = harness();
    await h.send(1);
    const [session] = h.created;
    session.wedged = true;
    session.throwOnClose = true;

    const first = h.manager.reset();
    assert.equal(first.closed, 1);
    assert.equal(first.remaining, 0, 'a session that refused to close is still dropped from the pool');
    const second = h.manager.reset();
    assert.deepEqual({ closed: second.closed, remaining: second.remaining }, { closed: 0, remaining: 0 });
  });
});

describe('wedge watchdog', () => {
  it('force-closes a busy session that has produced nothing past the threshold', async () => {
    const h = harness();
    await h.send(1);
    const [session] = h.created;
    session.busy = true;

    h.advance(STALL_MS - 1);
    h.manager.sweep();
    assert.equal(session.closed, false, 'must not fire before the threshold');

    h.advance(2);
    h.manager.sweep();
    assert.equal(session.closed, true);
    assert.equal(session.forceCloses, 1);
    assert.match(session.closeReasons[0], /busy with no model output/);
    assert.equal(h.manager.stats().total, 0, 'the slot is freed');
    assert.ok(h.logs.some(line => line.includes('watchdog')));
  });

  it('reaps a session flagged wedged by a failed turn even while it is idle', async () => {
    const h = harness();
    await h.send(1);
    const [session] = h.created;
    session.wedged = true;

    h.manager.sweep();
    assert.equal(session.closed, true);
    assert.match(session.closeReasons[0], /no model output at all/);
  });

  it('keeps a busy session that keeps streaming', async () => {
    const h = harness();
    await h.send(1);
    const [session] = h.created;
    session.busy = true;

    for (let tick = 0; tick < 10; tick += 1) {
      h.advance(STALL_MS / 2);
      session.lastProgress = START + (STALL_MS / 2) * (tick + 1);
      h.manager.sweep();
    }
    assert.equal(session.closed, false);
  });
});

describe('routing around a wedged session', () => {
  it('starts a fresh session instead of re-entering the wedged one', async () => {
    const h = harness();
    await h.send(1);
    const [first] = h.created;
    assert.equal(first.transcriptLen, 2);

    // Continuing this chat would normally route straight back to `first`.
    first.wedged = true;
    await h.send(3);

    assert.equal(h.created.length, 2, 'a replay session was created');
    assert.equal(first.requests, 1, 'the wedged session got no further requests');
    assert.equal(h.created[1].replays, 1);
  });

  it('does not hand tool results to a wedged session', async () => {
    const h = harness();
    await h.send(1);
    const [first] = h.created;
    first.pendingToolUseIds.add('toolu_1');
    first.wedged = true;

    await h.manager.handle(
      {
        model: 'claude-sonnet-5',
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
        ],
      },
      new AbortController().signal
    );

    assert.equal(first.requests, 1);
    assert.equal(h.created.length, 2);
  });
});

describe('eviction', () => {
  it('prefers the wedged session as the victim over a live idle one', async () => {
    const h = harness();
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await h.send(1);
      h.advance(1_000);
    }
    // The oldest session would be the victim under a pure LRU rule; the wedged one must go first.
    const oldest = h.created[0];
    const wedged = h.created[MAX_SESSIONS - 1];
    wedged.wedged = true;

    await h.send(1);
    assert.equal(wedged.closed, true);
    assert.equal(oldest.closed, false);
    assert.equal(h.manager.stats().total, MAX_SESSIONS);
  });

  it('overshoots the soft cap rather than killing sessions that are producing output', async () => {
    const h = harness();
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await h.send(1);
    }
    for (const session of h.created) session.busy = true;
    h.advance(5_000);
    for (const session of h.created) session.lastProgress = START + 5_000;

    await h.send(1);
    assert.ok(h.created.every((session, index) => index === MAX_SESSIONS || !session.closed));
    assert.equal(h.manager.stats().total, MAX_SESSIONS + 1);
    assert.ok(h.logs.some(line => line.includes('all sessions are producing output')));
  });

  it('evicts the stalest busy session once the hard ceiling is reached', async () => {
    const h = harness();
    let now = START;
    // Fill past the soft cap: every session is busy and recently streaming, so each request
    // overshoots instead of evicting — until the hard ceiling forces a choice.
    for (let i = 0; i <= HARD_MAX_SESSIONS; i += 1) {
      await h.send(1);
      now += 100;
      h.advance(100);
      // All within PRODUCING_WINDOW_MS, so none is "quiet"; index 0 is the stalest.
      h.created.forEach((session, index) => {
        session.busy = true;
        session.lastProgress = now - (h.created.length - index) * 10;
      });
    }
    assert.equal(h.manager.stats().total, HARD_MAX_SESSIONS, 'the hard ceiling holds');
    assert.equal(h.created.length, HARD_MAX_SESSIONS + 1);
    assert.match(h.created[0].closeReasons[0] ?? '', /hard session limit/);
    assert.ok(h.created.slice(1).every(session => !session.closed));
  });
});
