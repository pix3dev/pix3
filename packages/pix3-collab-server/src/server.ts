import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { initDb } from './core/db.js';
import { authRouter } from './core/auth/auth-router.js';
import { projectsRouter } from './core/projects/projects-router.js';
import { storageRouter } from './core/storage/storage-router.js';
import { libraryRouter } from './core/library/library-router.js';
import { storeRouter } from './core/library/store-router.js';
import { adminRouter } from './core/admin/admin-router.js';
import { previewRouter } from './core/preview/preview-router.js';
import { roomsRouter } from './core/rooms/rooms-router.js';
import { createHocuspocusServer } from './sync/hocuspocus.js';
import { createPreviewRelayServer } from './sync/preview-relay.js';
import {
  clearCollaborationServer,
  registerCollaborationServer,
} from './core/observability/connection-stats.js';
import { resolveReleaseInfo } from './core/observability/release-info.js';

function isCollaborationUpgrade(request: IncomingMessage): boolean {
  const requestUrl = request.url ?? '';
  return (
    requestUrl === config.COLLABORATION_PATH ||
    requestUrl.startsWith(`${config.COLLABORATION_PATH}?`)
  );
}

function isPreviewUpgrade(request: IncomingMessage): boolean {
  const requestUrl = request.url ?? '';
  return requestUrl === config.PREVIEW_PATH || requestUrl.startsWith(`${config.PREVIEW_PATH}?`);
}

function closeUpgradeSocket(socket: Socket): void {
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startServer(): Promise<void> {
  // Initialize database
  initDb();
  console.log('[pix3-collab] Database initialized');

  // Ensure storage directories exist
  fs.mkdirSync(path.resolve(config.PROJECTS_STORAGE_DIR), { recursive: true });
  fs.mkdirSync(path.resolve(config.LIBRARY_STORAGE_DIR), { recursive: true });

  const app = express();
  app.use(cookieParser());
  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );
  app.use(express.json());

  // Routes
  app.use('/api/auth', authRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', storageRouter);
  // Mounted before the private library router so '/api/library/store/...' is never swallowed
  // by its '/items/:id' patterns.
  app.use('/api/library/store', storeRouter);
  app.use('/api/library', libraryRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/preview', previewRouter);
  app.use('/api/rooms', roomsRouter);

  // Admin UI. Both pages are plain HTML files, served from src/ in development and from the copy the
  // deploy places next to dist/ in production.
  const sendAdminPage = (fileName: string, res: express.Response): void => {
    for (const candidate of [`src/admin/${fileName}`, `dist/admin/${fileName}`]) {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) {
        res.sendFile(resolved);
        return;
      }
    }

    res.status(404).send('Admin panel not found');
  };

  app.get('/admin', (_req, res) => {
    sendAdminPage('index.html', res);
  });

  // The panel has always redirected here on 401 — and until now nothing answered, so signing out of
  // the panel (or arriving with an expired cookie) was a dead end. It authenticates against the same
  // /api/auth endpoints the editor uses; there is no second auth scheme.
  app.get('/login', (_req, res) => {
    sendAdminPage('login.html', res);
  });

  // Health check. Version and commit are additive: an unauthenticated caller learns nothing exploitable
  // from them, and having them here means "which build is live?" can be answered without an admin login.
  const release = await resolveReleaseInfo();
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      port: config.PORT,
      version: release.version,
      commit: release.commit,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  const hocuspocus = createHocuspocusServer();
  const previewRelay = createPreviewRelayServer();

  // The dashboard counts collaboration sockets, and this instance is otherwise local to this function.
  registerCollaborationServer(hocuspocus.instance);

  const server = createServer(app);

  server.on('upgrade', async (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const requestUrl = request.url ?? '';
    console.log(`[pix3-collab] Upgrade request: ${requestUrl}`);

    if (isPreviewUpgrade(request)) {
      try {
        previewRelay.handleUpgrade(request, socket, head);
      } catch (error) {
        console.error(`[pix3-collab] Failed to upgrade ${requestUrl}`, error);
        socket.destroy();
      }
      return;
    }

    if (!isCollaborationUpgrade(request)) {
      console.log(`[pix3-collab] Rejected upgrade for ${requestUrl}`);
      closeUpgradeSocket(socket);
      return;
    }

    try {
      await hocuspocus.handleUpgrade(request, socket, head);
    } catch (error) {
      console.error(`[pix3-collab] Failed to upgrade ${requestUrl}`, error);
      socket.destroy();
    }
  });

  console.log(`[pix3-collab] Collaboration WS attached on ${config.COLLABORATION_PATH}`);
  console.log(`[pix3-collab] Preview relay WS attached on ${config.PREVIEW_PATH}`);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.PORT, () => {
      server.off('error', reject);
      console.log(`[pix3-collab] HTTP server listening on port ${config.PORT}`);
      resolve();
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[pix3-collab] Received ${signal}, starting graceful shutdown`);

    try {
      await closeHttpServer(server);
      console.log('[pix3-collab] HTTP server closed');
      await previewRelay.destroy();
      console.log('[pix3-collab] Preview relay closed');
      clearCollaborationServer();
      await hocuspocus.destroy();
      console.log('[pix3-collab] Collaboration server closed');
      process.exit(0);
    } catch (error) {
      console.error('[pix3-collab] Graceful shutdown failed', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}
