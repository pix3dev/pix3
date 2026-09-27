import { AGENT_PRESENCE_TTL_MS } from '../protocol.ts';

/**
 * Which `pix3 mcp --workspace` processes are alive right now, as announced over the agent lane
 * (`POST /ws/agent/presence`). The editor uses the resulting `agent-presence` frame to keep its
 * play/viewport loops, file polling and reconnects running while the tab is in the background —
 * an agent's work must never wait for a battery-saving pause.
 *
 * One entry per MCP session (a random id per process). An entry expires {@link AGENT_PRESENCE_TTL_MS}
 * after its last heartbeat; a clean shutdown removes it at once (`leaving: true`). The name is the
 * MCP client's own, self-declared — `verified` is always false.
 */

export interface AgentPresenceSnapshot {
  readonly attached: boolean;
  readonly agent: { readonly name: string | null; readonly verified: false } | null;
}

interface Entry {
  name: string | null;
  lastSeen: number;
  timer: NodeJS.Timeout;
}

export class AgentPresence {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly onChange: (snapshot: AgentPresenceSnapshot) => void;
  private last: string;

  constructor(onChange: (snapshot: AgentPresenceSnapshot) => void, ttlMs = AGENT_PRESENCE_TTL_MS) {
    this.onChange = onChange;
    this.ttlMs = ttlMs;
    this.last = JSON.stringify(this.snapshot());
  }

  /** Heartbeat (or first announcement) of one MCP session. */
  touch(session: string, name: string | null): void {
    const existing = this.entries.get(session);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.drop(session), this.ttlMs);
    timer.unref();
    this.entries.set(session, {
      name: name ?? existing?.name ?? null,
      lastSeen: Date.now(),
      timer,
    });
    this.emitIfChanged();
  }

  /** The MCP process is shutting down. */
  leave(session: string): void {
    this.drop(session);
  }

  snapshot(): AgentPresenceSnapshot {
    let latest: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (!latest || entry.lastSeen >= latest.lastSeen) latest = entry;
    }
    return latest
      ? { attached: true, agent: { name: latest.name, verified: false } }
      : { attached: false, agent: null };
  }

  close(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private drop(session: string): void {
    const entry = this.entries.get(session);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(session);
    this.emitIfChanged();
  }

  private emitIfChanged(): void {
    const snapshot = this.snapshot();
    const text = JSON.stringify(snapshot);
    if (text === this.last) return;
    this.last = text;
    this.onChange(snapshot);
  }
}
