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

      const projectId = documentName.replace(/^project:/, '');
      const projectDir = path.resolve(config.PROJECTS_STORAGE_DIR, projectId);
      const scriptsMap = document.getMap('scripts');

      // If the CRDT document already has data, skip loading from files.
      const scenesMap = document.getMap<Y.Map<unknown>>('scenes');
      if (scenesMap.size > 0 || scriptsMap.size > 0) {
        return;
      }

      for (const scenePath of listFilesRecursive(projectDir, '.pix3scene')) {
        const relativePath = path.relative(projectDir, scenePath).split(path.sep).join('/');
        const sceneId = deriveSceneId(relativePath);
        const sceneMap = new Y.Map<unknown>();
        const content = fs.readFileSync(scenePath, 'utf-8');
        sceneMap.set('filePath', `res://${relativePath}`);
        sceneMap.set('snapshot', content);
        scenesMap.set(sceneId, sceneMap);
      }

      // Load scripts
      const scriptsDir = path.join(projectDir, 'scripts');
      if (fs.existsSync(scriptsDir)) {
        loadScriptsRecursive(scriptsDir, scriptsDir, scriptsMap);
      }
    },

    async onStoreDocument({ documentName, document }) {
      const projectId = documentName.replace(/^project:/, '');
      const projectDir = path.resolve(config.PROJECTS_STORAGE_DIR, projectId);
      fs.mkdirSync(projectDir, { recursive: true });

      const sceneFilePaths = new Set<string>();
      const scenesMap = document.getMap<Y.Map<unknown>>('scenes');
      for (const [sceneId, value] of scenesMap.entries()) {
        if (!(value instanceof Y.Map)) {
          continue;
        }

        const filePathValue = value.get('filePath');
        const snapshotValue = value.get('snapshot');
        if (typeof snapshotValue !== 'string') {
          continue;
        }

        const relativePath = normalizeStoredScenePath(
          typeof filePathValue === 'string' && filePathValue.trim()
            ? filePathValue
            : `${sceneId}.pix3scene`
        );
        const fullPath = path.resolve(projectDir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, snapshotValue, 'utf-8');
        sceneFilePaths.add(fullPath);
      }
      reconcileFiles(projectDir, sceneFilePaths, '.pix3scene');

      // Save scripts
      const scriptsMap = document.getMap('scripts');
      const scriptsDir = path.join(projectDir, 'scripts');
      const scriptFilePaths = new Set<string>();
      for (const [scriptPath, value] of scriptsMap.entries()) {
        if (value instanceof Y.Text) {
          const fullPath = path.join(scriptsDir, scriptPath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, value.toString(), 'utf-8');
          scriptFilePaths.add(fullPath);
        }
      }
      reconcileFiles(scriptsDir, scriptFilePaths, '.ts');

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

function loadScriptsRecursive(
  rootDir: string,
  currentDir: string,
  scriptsMap: Y.Map<unknown>
): void {
  const items = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(currentDir, item.name);
    if (item.isDirectory()) {
      loadScriptsRecursive(rootDir, fullPath, scriptsMap);
    } else if (item.isFile() && item.name.endsWith('.ts')) {
      const relativePath = path.relative(rootDir, fullPath).split(path.sep).join('/');
      const content = fs.readFileSync(fullPath, 'utf-8');
      const yText = new Y.Text(content);
      scriptsMap.set(relativePath, yText);
    }
  }
}

function normalizeStoredScenePath(filePath: string): string {
  const normalized = filePath.replace(/^res:\/\//i, '').replace(/^\/+/, '');
  return normalized.endsWith('.pix3scene') ? normalized : `${normalized}.pix3scene`;
}

function deriveSceneId(resourcePath: string): string {
  const withoutExtension = resourcePath.replace(/\.[^./]+$/i, '');
  const normalized = withoutExtension
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'scene';
}

function listFilesRecursive(rootDir: string, extension: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const result: string[] = [];
  const visit = (currentDir: string): void => {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(currentDir, item.name);
      if (item.isDirectory()) {
        visit(fullPath);
      } else if (item.isFile() && item.name.endsWith(extension)) {
        result.push(fullPath);
      }
    }
  };

  visit(rootDir);
  return result;
}

function reconcileFiles(rootDir: string, desiredPaths: Set<string>, extension: string): void {
  for (const existingPath of listFilesRecursive(rootDir, extension)) {
    if (!desiredPaths.has(existingPath)) {
      fs.rmSync(existingPath, { force: true });
      pruneEmptyDirectories(path.dirname(existingPath), rootDir);
    }
  }
}

function pruneEmptyDirectories(startDir: string, stopDir: string): void {
  let currentDir = startDir;
  while (currentDir.startsWith(stopDir) && currentDir !== stopDir) {
    const contents = fs.readdirSync(currentDir);
    if (contents.length > 0) {
      return;
    }
    fs.rmdirSync(currentDir);
    currentDir = path.dirname(currentDir);
  }
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
