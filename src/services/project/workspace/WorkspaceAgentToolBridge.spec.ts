import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import {
  GENERATE_SESSION_LIMIT,
  PERMISSION_TIMEOUT_MS,
  RUNTIME_START_TIMEOUT_MS,
  WORKSPACE_AGENT_TOOLS,
  WorkspaceAgentToolBridge,
  type WorkspaceAgentHost,
} from '@/services/project/workspace/WorkspaceAgentToolBridge';
import type { WorkspaceCallContext } from '@/services/project/workspace/WorkspaceSessionService';
import type {
  WorkspaceCallFrame,
  WorkspaceCallResult,
} from '@/services/project/workspace/workspace-protocol';

/** The agent-channel bridge against a fake host: allowlist, results, barrier, permission, stale. */

interface FakeHost extends WorkspaceAgentHost {
  playing: boolean;
  /** Epoch ms at which the runtime reports running; `null` = with play (immediately). */
  runningAt: number | null;
  /** Epoch ms at which each executed tool ran. */
  readonly executedAt: number[];
  readonly executed: Array<{ name: string; args: Record<string, unknown> }>;
  readonly releases: number[];
  results: Record<string, unknown>;
  loaded: Record<string, string>;
  problems: Array<{ file: string | null; message: string }>;
  /** Play-mode failure the host reports while waiting (null = none). */
  failure: string | null;
  build: { file: string | null; line?: number; message: string } | null;
}

const makeHost = (): FakeHost => {
  const host: FakeHost = {
    playing: false,
    runningAt: null,
    executedAt: [],
    executed: [],
    releases: [],
    results: {},
    loaded: { 'scenes/main.pix3scene': 'a'.repeat(64) },
    problems: [],
    failure: null,
    build: null,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      host.executed.push({ name, args });
      host.executedAt.push(Date.now());
      if (name === 'play_start') host.playing = true;
      return host.results[name] ?? { ok: true };
    }),
    toolSpecs: vi.fn(async (names: ReadonlySet<string>) =>
      [...names].map(name => ({ name, description: name, inputSchema: { type: 'object' } }))
    ),
    isPlaying: () => host.playing,
    stopPlay: vi.fn(async () => {
      host.playing = false;
    }),
    isRuntimeRunning: vi.fn(
      () => host.playing && (host.runningAt === null || Date.now() >= host.runningAt)
    ),
    holdAutosave: vi.fn(() => {
      const index = host.releases.length;
      host.releases.push(0);
      return () => {
        host.releases[index] += 1;
      };
    }),
    startFailure: vi.fn(() => host.failure),
    syncLoaded: vi.fn(async () => ({ loaded: host.loaded, problems: host.problems })),
    buildError: vi.fn(async () => host.build),
    mergeLogTail: vi.fn(async () => []),
  };
  return host;
};

let nextId = 0;
const frame = (
  name: string,
  input: Record<string, unknown> = {},
  agentSession = 'mcp-1'
): WorkspaceCallFrame => ({
  type: 'call',
  id: `c${++nextId}`,
  name,
  input,
  agent: { name: 'claude-code', session: agentSession, verified: false },
});

const context: WorkspaceCallContext = { serverSession: 's1', leaseId: 'L1', root: '/work/game' };

const body = (result: WorkspaceCallResult): Record<string, unknown> => {
  const first = result.content[0];
  return JSON.parse(first.type === 'text' ? first.text : '{}') as Record<string, unknown>;
};

let bridge: WorkspaceAgentToolBridge;
let host: FakeHost;

beforeEach(() => {
  resetAppState();
  bridge = new WorkspaceAgentToolBridge();
  host = makeHost();
  bridge.setHost(host);
});

afterEach(() => {
  bridge.dispose();
  vi.useRealTimers();
});

describe('WorkspaceAgentToolBridge', () => {
  it('serves only the allowlist (+ internal tools) and executes through the tool host', async () => {
    const refused = await bridge.handleCall(
      frame('fs_write', { path: 'a', content: 'b' }),
      context
    );
    expect(refused.isError).toBe(true);
    expect(body(refused).error).toBe('unknown_tool');
    expect(host.executed).toEqual([]);

    const selection = await bridge.handleCall(frame('get_selection'), context);
    expect(selection.isError).toBeUndefined();
    expect(host.executed).toEqual([{ name: 'get_selection', args: {} }]);

    const manifest = await bridge.handleCall(frame('tools_manifest'), context);
    const names = (body(manifest).tools as Array<{ name: string }>).map(tool => tool.name);
    expect(names.sort()).toEqual([...WORKSPACE_AGENT_TOOLS].sort());
  });

  it('lifts __images into image blocks and flags ok:false as an error', async () => {
    host.results.viewport_screenshot = {
      ok: true,
      view: 'editor',
      __images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    };
    const shot = await bridge.handleCall(frame('viewport_screenshot'), context);
    expect(shot.content).toEqual([
      { type: 'text', text: JSON.stringify({ ok: true, view: 'editor' }) },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]);

    host.results.play_stop = { ok: false };
    expect((await bridge.handleCall(frame('play_stop'), context)).isError).toBe(true);
  });

  it('answers a re-delivered call id once', async () => {
    const call = frame('read_errors');
    const [a, b] = await Promise.all([
      bridge.handleCall(call, context),
      bridge.handleCall(call, context),
    ]);
    expect(a).toBe(b);
    await bridge.handleCall(call, context);
    expect(host.executed.filter(e => e.name === 'read_errors')).toHaveLength(1);
  });

  it('sync_barrier holds autosave, stops play, reports loaded hashes and errors; release lets go', async () => {
    host.playing = true;
    host.build = { file: 'scripts/a.ts', line: 4, message: 'Unexpected token' };
    appState.project.coauthoring.unreadablePaths = ['scenes/broken.pix3scene'];
    const barrier = body(await bridge.handleCall(frame('sync_barrier'), context));
    expect(host.holdAutosave).toHaveBeenCalledTimes(1);
    expect(host.stopPlay).toHaveBeenCalledTimes(1);
    expect(host.playing).toBe(false);
    expect(barrier.loaded).toEqual(host.loaded);
    expect(barrier.errors).toEqual([
      { file: 'scripts/a.ts', line: 4, message: 'Unexpected token', kind: 'compile' },
      expect.objectContaining({ file: 'scenes/broken.pix3scene', kind: 'pending' }),
    ]);
    expect(host.releases).toEqual([0]);

    const released = body(
      await bridge.handleCall(frame('sync_release', { holdId: barrier.holdId }), context)
    );
    expect(released.released).toBe(true);
    expect(host.releases).toEqual([1]);
    const again = body(
      await bridge.handleCall(frame('sync_release', { holdId: barrier.holdId }), context)
    );
    expect(again.released).toBe(false);
    expect(host.releases).toEqual([1]);
  });

  it('game_run after the barrier starts play first and records the verified revision', async () => {
    await bridge.handleCall(frame('sync_barrier'), context);
    host.results.game_run = { verdict: 'PASS' };
    const run = await bridge.handleCall(frame('game_run', { until: [] }), context);
    expect(body(run)).toEqual({ verdict: 'PASS' });
    expect(host.executed.map(e => e.name)).toEqual(['play_start', 'game_run']);
    expect(host.isRuntimeRunning).toHaveBeenCalled();
    expect(appState.project.coauthoring.playRevision).toEqual(host.loaded);

    // play_restart of a stopped game is a start.
    host.playing = false;
    await bridge.handleCall(frame('play_restart'), context);
    expect(host.executed.at(-1)?.name).toBe('play_start');
  });

  it('game_run waits until the started runtime is actually running before it runs', async () => {
    await bridge.handleCall(frame('sync_barrier'), context);
    // play_start returns while the scene is still loading: the runner exists but is not running.
    const loadMs = 160;
    host.executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      host.executed.push({ name, args });
      host.executedAt.push(Date.now());
      if (name === 'play_start') {
        host.playing = true;
        host.runningAt = Date.now() + loadMs;
      }
      if (name === 'game_run' && Date.now() < (host.runningAt ?? 0)) {
        return {
          ok: false,
          error: 'the runner stopped at frame 0 (the scene is no longer running)',
        };
      }
      return { verdict: 'PASS' };
    });
    const run = await bridge.handleCall(frame('game_run', { until: [] }), context);
    expect(run.isError).toBeUndefined();
    expect(body(run)).toEqual({ verdict: 'PASS' });
    expect(host.executed.map(e => e.name)).toEqual(['play_start', 'game_run']);
    expect(host.executedAt[1]).toBeGreaterThanOrEqual(host.runningAt ?? Infinity);

    // Already playing but mid-restart (a new runner still loading): wait as well.
    host.runningAt = Date.now() + loadMs;
    const again = await bridge.handleCall(frame('game_run', { until: [] }), context);
    expect(again.isError).toBeUndefined();
    expect(host.executed.map(e => e.name)).toEqual(['play_start', 'game_run', 'game_run']);
    expect(host.executedAt[2]).toBeGreaterThanOrEqual(host.runningAt ?? Infinity);
  });

  it('a play_restart substituted by play_start answers only once the runtime is running', async () => {
    host.executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      host.executed.push({ name, args });
      if (name === 'play_start') {
        host.playing = true;
        host.runningAt = Date.now() + 120;
      }
      return { ok: true };
    });
    const restart = await bridge.handleCall(frame('play_restart'), context);
    expect(restart.isError).toBeUndefined();
    expect(host.executed.map(e => e.name)).toEqual(['play_start']);
    expect(Date.now()).toBeGreaterThanOrEqual(host.runningAt ?? Infinity);
  });

  it('game_run reports load_failed when the runtime never starts running', async () => {
    vi.useFakeTimers();
    try {
      host.runningAt = Number.MAX_SAFE_INTEGER;
      const pending = bridge.handleCall(frame('game_run', { until: [] }), context);
      await vi.advanceTimersByTimeAsync(RUNTIME_START_TIMEOUT_MS + 1_000);
      const run = await pending;
      expect(run.isError).toBe(true);
      expect(body(run).error).toBe('load_failed');
      expect(host.executed.map(e => e.name)).toEqual(['play_start']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports every input of a consumer game (paths outside scenes/ and scripts/) in loaded', async () => {
    host.loaded = {
      'src/assets/scenes/x.pix3scene': '1'.repeat(64),
      'src/scripts/Runner.ts': '2'.repeat(64),
      'src/world/Chunk.ts': '3'.repeat(64),
      'src/generated/resource-catalog.ts': '4'.repeat(64),
      'pix3project.yaml': '5'.repeat(64),
    };
    const barrier = body(await bridge.handleCall(frame('sync_barrier'), context));
    expect(barrier.loaded).toEqual(host.loaded);
    expect(barrier.errors).toEqual([]);
  });

  it('reports an open scene the editor cannot vouch for as a load error', async () => {
    host.problems = [{ file: 'src/assets/scenes/x.pix3scene', message: 'no verified version' }];
    const barrier = body(await bridge.handleCall(frame('sync_barrier'), context));
    expect(barrier.errors).toEqual([
      { file: 'src/assets/scenes/x.pix3scene', message: 'no verified version', kind: 'load' },
    ]);
  });

  it('a heavy start: play_start answers once the game runs (8 s), with startupMs', async () => {
    vi.useFakeTimers();
    host.executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      host.executed.push({ name, args });
      if (name === 'play_start') {
        host.playing = true;
        host.runningAt = Date.now() + 8_000;
      }
      return { ok: true };
    });
    const pending = bridge.handleCall(frame('play_start'), context);
    await vi.advanceTimersByTimeAsync(7_000);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    const start = await pending;
    expect(start.isError).toBeUndefined();
    const startupMs = (start._meta?.pix3 as { startupMs?: number } | undefined)?.startupMs ?? -1;
    expect(startupMs).toBeGreaterThanOrEqual(8_000);
    expect(startupMs).toBeLessThan(8_200);
  });

  it('a start that never runs: load_failed after 30 s, not before', async () => {
    vi.useFakeTimers();
    host.executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      host.executed.push({ name, args });
      if (name === 'play_start') {
        host.playing = true;
        host.runningAt = Number.MAX_SAFE_INTEGER;
      }
      return { ok: true };
    });
    let settled = false;
    const pending = bridge.handleCall(frame('play_start'), context).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(RUNTIME_START_TIMEOUT_MS - 1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    const start = await pending;
    expect(start.isError).toBe(true);
    const failed = body(start);
    expect(failed.error).toBe('load_failed');
    expect(failed.errors).toEqual([{ file: null, message: 'runtime not running', kind: 'load' }]);
    expect(failed.startupMs).toBeGreaterThanOrEqual(RUNTIME_START_TIMEOUT_MS);
  });

  it('fails fast when play mode stops during the start, with the play-mode error', async () => {
    vi.useFakeTimers();
    host.executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      host.executed.push({ name, args });
      if (name === 'play_start') {
        host.playing = true;
        host.runningAt = Number.MAX_SAFE_INTEGER;
        setTimeout(() => {
          host.playing = false;
          host.failure = 'Failed to start the scene: chunk mesher threw';
        }, 2_000);
      }
      return { ok: true };
    });
    const pending = bridge.handleCall(frame('play_restart'), context);
    await vi.advanceTimersByTimeAsync(3_000);
    const start = await pending;
    expect(start.isError).toBe(true);
    const failed = body(start);
    expect(failed.error).toBe('load_failed');
    expect(String(failed.message)).toContain('chunk mesher threw');
    expect(failed.startupMs).toBeLessThan(3_000);
  });

  it('observing tools report the started revision and the stale flag', async () => {
    await bridge.handleCall(frame('sync_barrier'), context);
    await bridge.handleCall(frame('play_start'), context);
    const fresh = await bridge.handleCall(frame('play_status'), context);
    expect(fresh._meta).toEqual({ pix3: { playRevision: host.loaded, stale: false } });

    appState.project.coauthoring.stale = true;
    const stale = await bridge.handleCall(frame('game_observe', { nodes: ['Player'] }), context);
    expect(stale._meta).toEqual({ pix3: { playRevision: host.loaded, stale: true } });

    host.playing = false;
    const stopped = await bridge.handleCall(frame('play_status'), context);
    expect(stopped._meta).toEqual({ pix3: { playRevision: null, stale: false } });
  });

  it('asks before the first generation, allows up to the limit, then asks again', async () => {
    const first = bridge.handleCall(
      frame('generate_asset', { prompt: 'coin', name: 'c' }),
      context
    );
    await Promise.resolve();
    await Promise.resolve();
    const prompt = bridge.getState().prompt;
    expect(prompt).toMatchObject({
      agentName: 'claude-code',
      root: '/work/game',
      tool: 'generate_asset',
    });
    expect(host.executed).toEqual([]);
    bridge.decide('allow');
    expect((await first).isError).toBeUndefined();
    expect(bridge.getState()).toMatchObject({ permission: 'allowed', generationsUsed: 1 });

    for (let i = 1; i < GENERATE_SESSION_LIMIT; i++) {
      await bridge.handleCall(frame('generate_sfx', { prompt: 'tick' }), context);
    }
    expect(bridge.getState().prompt).toBeNull();
    expect(bridge.getState().generationsUsed).toBe(GENERATE_SESSION_LIMIT);

    const over = bridge.handleCall(frame('generate_sfx', { prompt: 'tick' }), context);
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.getState().prompt).not.toBeNull();
    bridge.decide('deny');
    const denied = await over;
    expect(body(denied).error).toBe('permission_denied');
    // Denied for the rest of this connection, without asking again.
    const again = await bridge.handleCall(frame('generate_sfx', { prompt: 'x' }), context);
    expect(body(again).error).toBe('permission_denied');
    expect(bridge.getState().prompt).toBeNull();
    expect(host.executed.filter(e => e.name.startsWith('generate_'))).toHaveLength(
      GENERATE_SESSION_LIMIT
    );
  });

  it('resets the permission on a new server session, lease or MCP process, and on revoke', async () => {
    const allowOnce = async (ctx: WorkspaceCallContext, session = 'mcp-1'): Promise<boolean> => {
      const pending = bridge.handleCall(frame('generate_sfx', { prompt: 'x' }, session), ctx);
      await Promise.resolve();
      await Promise.resolve();
      const asked = bridge.getState().prompt !== null;
      if (asked) bridge.decide('allow');
      await pending;
      return asked;
    };
    expect(await allowOnce(context)).toBe(true);
    expect(await allowOnce(context)).toBe(false);
    expect(await allowOnce({ ...context, serverSession: 's2' })).toBe(true);
    expect(await allowOnce({ ...context, serverSession: 's2', leaseId: 'L2' })).toBe(true);
    expect(await allowOnce({ ...context, serverSession: 's2', leaseId: 'L2' }, 'mcp-2')).toBe(true);
    bridge.revokeGeneration();
    expect(await allowOnce({ ...context, serverSession: 's2', leaseId: 'L2' }, 'mcp-2')).toBe(true);
  });

  it('denies a generation nobody answers within the timeout', async () => {
    vi.useFakeTimers();
    const pending = bridge.handleCall(frame('generate_asset', { prompt: 'p', name: 'n' }), context);
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS + 10);
    const result = await pending;
    expect(body(result).error).toBe('permission_denied');
    expect(bridge.getState().prompt).toBeNull();
    // A timeout is not a "deny": the next generation asks again.
    const next = bridge.handleCall(frame('generate_asset', { prompt: 'p', name: 'n' }), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.getState().prompt).not.toBeNull();
    bridge.decide('allow');
    expect((await next).isError).toBeUndefined();
  });

  it('refuses every call while the human switched the channel off', async () => {
    bridge.setEnabled(false);
    const refused = await bridge.handleCall(frame('play_status'), context);
    expect(body(refused).error).toBe('agent_disabled');
    expect(host.executed).toEqual([]);
    bridge.setEnabled(true);
    expect((await bridge.handleCall(frame('play_status'), context)).isError).toBeUndefined();
  });
});
