import { subscribe } from 'valtio/vanilla';
import { injectable } from '@/fw/di';
import { appState } from '@/state';
import { setEditorKeepAlive } from '@/services/core/page-activity';

/**
 * **Agent keepalive**: decides when the editor must not pause in the background.
 *
 * The editor pauses its play loop, viewport loop and file polling while the tab is hidden or
 * unfocused, to save a laptop's battery. In the external-agent pipeline the tab is in the
 * background almost all the time while the agent works (`pix3 mcp --workspace` → `pix3 serve` →
 * this window), and the agent must never wait for such a pause. So while an agent is involved the
 * pauses are off:
 *
 *   keepalive = setting on AND (
 *       presence attached               — the server's `agent-presence` (MCP heartbeats), also
 *                                         {@link PRESENCE_STALE_MS} after the socket dropped
 *    OR a call is in flight, or the last one finished < {@link RECENT_CALL_MS} ago
 *    OR play was started through the agent channel and is still running )
 *
 * The result goes to `appState.project.coauthoring.agentKeepalive` (status-bar pill) and to
 * `page-activity`'s {@link setEditorKeepAlive}, which every battery gate reads
 * (`isEditorActive`, `BackgroundTicker`, `keepaliveTimer`). With no agent involved it stays false
 * and the editor behaves exactly as before. The setting is "Keep the editor running while an agent
 * is connected" (Settings → General, `appState.ui.keepEditorRunningForAgent`, default on).
 */

/** A finished call keeps the editor alive this long (the agent is likely to call again). */
export const RECENT_CALL_MS = 5 * 60_000;
/** Presence last seen on a socket that dropped still counts this long (server restart). */
export const PRESENCE_STALE_MS = 5 * 60_000;

export interface AgentKeepaliveReasons {
  readonly presence: boolean;
  readonly calls: boolean;
  readonly play: boolean;
}

@injectable()
export class AgentKeepaliveService {
  private readonly inflight = new Set<string>();
  private lastCallEndedAt: number | null = null;
  private agentPlay = false;
  /** When the socket went down while presence said attached (null = connected / not attached). */
  private presenceLostAt: number | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: Array<() => void> = [];
  private current = false;
  private readonly listeners = new Set<() => void>();
  /** Tests replace the clock. */
  now: () => number = () => Date.now();

  initialize(): void {
    if (this.disposers.length > 0) return;
    this.disposers.push(subscribe(appState.project.workspace, () => this.recompute()));
    this.disposers.push(
      subscribe(appState.ui, () => {
        if (!appState.ui.isPlaying) this.agentPlay = false;
        this.recompute();
      })
    );
    this.recompute();
  }

  /** The bridge got a call (tool calls, barrier, manifest — any agent activity). */
  noteCallStarted(id: string): void {
    this.inflight.add(id);
    this.recompute();
  }

  noteCallFinished(id: string): void {
    if (!this.inflight.delete(id)) return;
    this.lastCallEndedAt = this.now();
    this.recompute();
  }

  /** `play_start` / `play_restart` / `game_run` started the game for the agent. */
  notePlayStartedByAgent(): void {
    if (!appState.ui.isPlaying) return;
    this.agentPlay = true;
    this.recompute();
  }

  isKeepAlive(): boolean {
    return this.current;
  }

  reasons(): AgentKeepaliveReasons {
    const now = this.now();
    const workspace = appState.project.workspace;
    const presence =
      workspace.agentAttached &&
      (workspace.status === 'connected' ||
        (this.presenceLostAt !== null && now - this.presenceLostAt < PRESENCE_STALE_MS));
    const calls =
      this.inflight.size > 0 ||
      (this.lastCallEndedAt !== null && now - this.lastCallEndedAt < RECENT_CALL_MS);
    const play = this.agentPlay && appState.ui.isPlaying;
    return { presence, calls, play };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.clearExpiry();
    this.inflight.clear();
    this.listeners.clear();
    this.apply(false);
  }

  /** Visible for tests: re-evaluate now (timers call it when a window runs out). */
  recompute(): void {
    const workspace = appState.project.workspace;
    if (workspace.status === 'connected' || !workspace.agentAttached) {
      this.presenceLostAt = null;
    } else if (this.presenceLostAt === null) {
      this.presenceLostAt = this.now();
    }
    const reasons = this.reasons();
    const enabled = appState.ui.keepEditorRunningForAgent;
    this.apply(enabled && (reasons.presence || reasons.calls || reasons.play));
    this.scheduleExpiry();
  }

  private apply(value: boolean): void {
    if (appState.project.coauthoring.agentKeepalive !== value) {
      appState.project.coauthoring.agentKeepalive = value;
    }
    setEditorKeepAlive(value);
    if (value === this.current) return;
    this.current = value;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** Wake up when the recent-call or stale-presence window runs out. */
  private scheduleExpiry(): void {
    this.clearExpiry();
    const now = this.now();
    const deadlines: number[] = [];
    if (this.inflight.size === 0 && this.lastCallEndedAt !== null) {
      deadlines.push(this.lastCallEndedAt + RECENT_CALL_MS);
    }
    if (this.presenceLostAt !== null) deadlines.push(this.presenceLostAt + PRESENCE_STALE_MS);
    const next = deadlines.filter(at => at > now).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    // A late wake-up (throttled background timer) only turns keepalive off late: harmless.
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null;
        this.recompute();
      },
      next - now + 1
    );
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
