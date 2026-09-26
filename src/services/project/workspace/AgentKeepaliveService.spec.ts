import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { isEditorKeepAlive } from '@/services/core/page-activity';
import {
  AgentKeepaliveService,
  PRESENCE_STALE_MS,
  RECENT_CALL_MS,
  RECONNECT_KEEPALIVE_MS,
} from '@/services/project/workspace/AgentKeepaliveService';

let service: AgentKeepaliveService;
let now: number;

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  resetAppState();
  now = 1_000_000;
  service = new AgentKeepaliveService();
  service.now = () => now;
  service.initialize();
});

afterEach(() => {
  service.dispose();
  vi.useRealTimers();
  resetAppState();
});

const attach = (attached: boolean, status: 'connected' | 'reconnecting' = 'connected'): void => {
  appState.project.workspace.status = status;
  appState.project.workspace.agentAttached = attached;
  appState.project.workspace.agentName = attached ? 'claude-code' : null;
  service.recompute();
};

describe('AgentKeepaliveService', () => {
  it('is off with no agent involved', () => {
    expect(service.isKeepAlive()).toBe(false);
    expect(appState.project.coauthoring.agentKeepalive).toBe(false);
    expect(isEditorKeepAlive()).toBe(false);
  });

  it('truth table: presence OR call in flight/recent OR agent-started play, gated by the setting', () => {
    type Row = {
      presence: boolean;
      call: 'none' | 'inflight' | 'recent' | 'old';
      play: boolean;
      setting: boolean;
      expected: boolean;
    };
    const rows: Row[] = [
      { presence: false, call: 'none', play: false, setting: true, expected: false },
      { presence: true, call: 'none', play: false, setting: true, expected: true },
      { presence: false, call: 'inflight', play: false, setting: true, expected: true },
      { presence: false, call: 'recent', play: false, setting: true, expected: true },
      { presence: false, call: 'old', play: false, setting: true, expected: false },
      { presence: false, call: 'old', play: true, setting: true, expected: true },
      { presence: true, call: 'inflight', play: true, setting: false, expected: false },
    ];
    for (const [index, row] of rows.entries()) {
      service.dispose();
      resetAppState();
      now = 1_000_000;
      service = new AgentKeepaliveService();
      service.now = () => now;
      service.initialize();
      appState.ui.keepEditorRunningForAgent = row.setting;
      attach(row.presence);
      if (row.call !== 'none') {
        service.noteCallStarted(`c${index}`);
        if (row.call !== 'inflight') {
          service.noteCallFinished(`c${index}`);
          now += row.call === 'recent' ? RECENT_CALL_MS - 1_000 : RECENT_CALL_MS + 1_000;
        }
      }
      if (row.play) {
        appState.ui.isPlaying = true;
        service.notePlayStartedByAgent();
      }
      service.recompute();
      expect(service.isKeepAlive(), JSON.stringify(row)).toBe(row.expected);
      expect(appState.project.coauthoring.agentKeepalive).toBe(row.expected);
      expect(isEditorKeepAlive()).toBe(row.expected);
    }
  });

  it('agent-started play keeps it on until play stops', async () => {
    appState.ui.isPlaying = true;
    service.notePlayStartedByAgent();
    expect(service.isKeepAlive()).toBe(true);
    appState.ui.isPlaying = false;
    await flush();
    expect(service.isKeepAlive()).toBe(false);
    // A human-started game does not count.
    appState.ui.isPlaying = true;
    await flush();
    expect(service.isKeepAlive()).toBe(false);
  });

  it('presence survives a dropped socket for a while, then expires', () => {
    attach(true);
    expect(service.isKeepAlive()).toBe(true);
    attach(true, 'reconnecting');
    expect(service.isKeepAlive()).toBe(true);
    now += PRESENCE_STALE_MS + 1;
    service.recompute();
    expect(service.isKeepAlive()).toBe(false);
    // Back and still attached (a fresh hello): on again.
    attach(true, 'connected');
    expect(service.isKeepAlive()).toBe(true);
    attach(false);
    expect(service.isKeepAlive()).toBe(false);
  });

  it('a reconnect that started under keepalive keeps it past the recent-call window', () => {
    appState.project.workspace.status = 'connected';
    service.noteCallStarted('a');
    service.noteCallFinished('a');
    now += RECENT_CALL_MS - 60_000;
    service.recompute();
    expect(service.isKeepAlive()).toBe(true);
    // `pix3 serve` restarts: the socket drops, presence cannot be learned until it is back.
    appState.project.workspace.status = 'reconnecting';
    service.recompute();
    now += 2 * 60_000; // the call window ran out meanwhile
    service.recompute();
    expect(service.reasons()).toMatchObject({ calls: false, reconnect: true });
    expect(service.isKeepAlive()).toBe(true);
    // Bounded: a server that never comes back does not keep the editor awake forever.
    now += RECONNECT_KEEPALIVE_MS;
    service.recompute();
    expect(service.isKeepAlive()).toBe(false);
    // Back (no agent): the normal rules.
    appState.project.workspace.status = 'connected';
    service.recompute();
    expect(service.isKeepAlive()).toBe(false);
  });

  it('a reconnect with keepalive off stays off (the idle editor is unchanged)', () => {
    appState.project.workspace.status = 'connected';
    service.recompute();
    appState.project.workspace.status = 'reconnecting';
    service.recompute();
    expect(service.reasons().reconnect).toBe(false);
    expect(service.isKeepAlive()).toBe(false);
  });

  it('turns off by itself once the recent-call window runs out', () => {
    vi.useFakeTimers();
    service.dispose();
    service = new AgentKeepaliveService();
    service.initialize();
    service.noteCallStarted('a');
    service.noteCallFinished('a');
    expect(service.isKeepAlive()).toBe(true);
    vi.advanceTimersByTime(RECENT_CALL_MS + 10);
    expect(service.isKeepAlive()).toBe(false);
  });
});
