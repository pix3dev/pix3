import { Hocuspocus } from '@hocuspocus/server';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { config } from '../config.js';
import { verifyToken } from '../core/auth/auth-middleware.js';
import { getProjectByShareToken, getUserRole } from '../core/projects/projects-service.js';
import { resolveContainedPath } from '../core/storage/contained-path.js';
import {
  loadScenesFromDisk,
  loadScriptsFromDisk,
  persistDocumentToDisk,
} from './document-files.js';

const CRDT_DOCUMENTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS documents (
    name TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export interface CollaborationServer {
  instance: Hocuspocus;
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void>;
  destroy(): Promise<void>;
}

export function createHocuspocusServer(): CollaborationServer {
  const crdtDb = openCrdtDb();

  const hocuspocus = new Hocuspocus({
    async onAuthenticate({ token, connectionConfig, documentName }) {
      // Document name format: project:{projectId}
      const projectId = documentName.replace(/^project:/, '');

      // Try JWT auth first
      if (token) {
        try {
          const payload = verifyToken(token);
          const role = getUserRole(projectId, payload.userId);
          if (role) {
            connectionConfig.readOnly = role === 'viewer';
            return { userId: payload.userId, role };
          }
        } catch {
          // JWT invalid — fall through to share token check
        }

        // Try as share token
        const project = getProjectByShareToken(token);
        if (project && project.id === projectId) {
          connectionConfig.readOnly = true;
          return { userId: 'guest', role: 'viewer' };
        }
      }

      throw new Error('Unauthorized');
    },

    async onLoadDocument({ document, documentName }) {
      loadStoredDocumentState(crdtDb, documentName, document);

      const projectDir = resolveProjectDir(documentName);
      const scriptsMap = document.getMap('scripts');

      // If the CRDT document already has data, skip loading from files.
      const scenesMap = document.getMap<Y.Map<unknown>>('scenes');
      if (projectDir === null || scenesMap.size > 0 || scriptsMap.size > 0) {
        return;
      }

      loadScenesFromDisk(projectDir, scenesMap);
      loadScriptsFromDisk(path.resolve(projectDir, 'scripts'), scriptsMap);
    },

    async onStoreDocument({ documentName, document }) {
      const projectDir = resolveProjectDir(documentName);
      if (projectDir === null) {
        // `onAuthenticate` requires a project row for this id, so this is unreachable through a
        // normal connection — it is the backstop for the day something else opens a document.
        console.error(
          `[pix3-collab] Refusing to persist ${documentName}: it does not name a project directory`
        );
        return;
      }

      // Scene `filePath`s and script map keys are authored by whoever last edited the document, so
      // the write path contains them rather than trusting them; see `document-files.ts`.
      const { rejected } = persistDocumentToDisk(projectDir, document);
      for (const entry of rejected) {
        console.warn(
          `[pix3-collab] Refused ${entry.kind} path escaping ${documentName}: ${entry.requestedPath}`
        );
      }

      storeStoredDocumentState(crdtDb, documentName, document);

      console.log(`[pix3-collab] Persisted snapshot for ${documentName}`);
    },

    async onConnect({ documentName }) {
      console.log(`[pix3-collab] Client connected to ${documentName}`);
    },

    async onDisconnect({ documentName }) {
      console.log(`[pix3-collab] Client disconnected from ${documentName}`);
    },
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  webSocketServer.on('connection', (incoming, request) => {
    incoming.on('error', error => {
      console.error('[pix3-collab] WebSocket connection error', error);
    });

    hocuspocus.handleConnection(incoming, request);
  });

  return {
    instance: hocuspocus,
    async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
      await hocuspocus.hooks('onUpgrade', {
        request,
        socket,
        head,
        instance: hocuspocus,
      });

      await new Promise<void>((resolve, reject) => {
        webSocketServer.handleUpgrade(request, socket, head, ws => {
          webSocketServer.emit('connection', ws, request);
          resolve();
        });

        socket.once('error', reject);
      });
    },
    async destroy(): Promise<void> {
      hocuspocus.closeConnections();

      await new Promise<void>(resolve => {
        webSocketServer.close(() => {
          resolve();
        });
      });

      const documents = Array.from(hocuspocus.documents.values());
      await Promise.all(documents.map(document => hocuspocus.unloadDocument(document)));
      try {
        await hocuspocus.hooks('onDestroy', { instance: hocuspocus });
      } finally {
        crdtDb.close();
      }
    },
  };
}

/**
 * The storage directory a document name addresses, or `null` when it does not address one.
 *
 * `onAuthenticate` already requires a `project_members` row for the derived id, so a traversing name
 * cannot reach here through a connection. This is the second lock on the same door: the id is a path
 * segment, and a path segment that came off the wire gets contained like any other.
 */
function resolveProjectDir(documentName: string): string | null {
  const projectId = documentName.replace(/^project:/, '');
  return resolveContainedPath(path.resolve(config.PROJECTS_STORAGE_DIR), projectId);
}

function openCrdtDb(): Database.Database {
  const dbPath = path.resolve(config.HOCUSPOCUS_DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(CRDT_DOCUMENTS_SCHEMA_SQL);
  return db;
}

function loadStoredDocumentState(
  db: Database.Database,
  documentName: string,
  document: Y.Doc
): void {
  const row = db.prepare('SELECT data FROM documents WHERE name = ?').get(documentName) as
    | { data: Buffer }
    | undefined;

  if (row) {
    Y.applyUpdate(document, row.data);
  }
}

function storeStoredDocumentState(
  db: Database.Database,
  documentName: string,
  document: Y.Doc
): void {
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  db.prepare(
    `
      INSERT INTO documents (name, data, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `
  ).run(documentName, state);
}
