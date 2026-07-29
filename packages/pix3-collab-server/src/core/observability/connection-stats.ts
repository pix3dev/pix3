import type { Hocuspocus } from '@hocuspocus/server';
import { previewSessionService } from '../preview/preview-service.js';

/**
 * Live connection counts for the two WebSocket surfaces this process serves.
 *
 * The collaboration server is created inside `startServer()` and deliberately not exported from
 * there, so the dashboard cannot reach it by import. Rather than widen that seam, the composition
 * step registers the instance here — one setter, read-only afterwards, and absent in tests (where
 * the counts report as "no server attached" instead of throwing).
 */

/** One open document and how many editors are inside it. */
export interface CollaborationDocumentStats {
  /** Yjs document name, e.g. `project:<id>`. */
  readonly name: string;
  /** The project id, when the name follows the `project:<id>` convention. */
  readonly projectId: string | null;
  readonly connections: number;
}

/** Hocuspocus counters, or `attached: false` when no collaboration server is running. */
export interface CollaborationStats {
  readonly attached: boolean;
  readonly connections: number;
  readonly documents: number;
  readonly items: readonly CollaborationDocumentStats[];
}

/** Preview-relay counters: anonymous play sessions and the peers inside them. */
export interface PreviewStats {
  readonly sessions: number;
  /** Sessions with an editor attached — the half that can serve a running game. */
  readonly hosts: number;
  /** Player/agent sockets attached across all sessions. */
  readonly players: number;
  /** Age of the oldest live session, in seconds. */
  readonly oldestSessionAgeSeconds: number | null;
}

/** Both surfaces, as the dashboard reports them. */
export interface ConnectionStats {
  readonly collaboration: CollaborationStats;
  readonly preview: PreviewStats;
}

let collaboration: Hocuspocus | null = null;

/** Called once by the composition step, so the dashboard can count collaboration sockets. */
export function registerCollaborationServer(instance: Hocuspocus): void {
  collaboration = instance;
}

/** Drops the registration. Used by tests and by graceful shutdown. */
export function clearCollaborationServer(): void {
  collaboration = null;
}

function snapshotCollaboration(): CollaborationStats {
  if (!collaboration) {
    return { attached: false, connections: 0, documents: 0, items: [] };
  }

  const items: CollaborationDocumentStats[] = [];
  for (const document of collaboration.documents.values()) {
    const projectId = document.name.startsWith('project:')
      ? document.name.slice('project:'.length)
      : null;
    items.push({
      name: document.name,
      projectId,
      connections: document.getConnectionsCount(),
    });
  }

  // Busiest first: a dashboard row limit should drop the quiet documents, not the loud ones.
  items.sort((left, right) => right.connections - left.connections);

  return {
    attached: true,
    // Counts unique sockets, so one editor with several open documents is one connection.
    connections: collaboration.getConnectionsCount(),
    documents: collaboration.getDocumentsCount(),
    items,
  };
}

/** Snapshot of both WebSocket surfaces. Cheap: two map walks, no I/O. */
export function snapshotConnectionStats(): ConnectionStats {
  return {
    collaboration: snapshotCollaboration(),
    preview: previewSessionService.snapshotStats(),
  };
}
