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
import { adminRouter } from './core/admin/admin-router.js';
import { previewRouter } from './core/preview/preview-router.js';
import { createHocuspocusServer } from './sync/hocuspocus.js';
import { createPreviewRelayServer } from './sync/preview-relay.js';

function isCollaborationUpgrade(request: IncomingMessage): boolean {
  const requestUrl = request.url ?? '';
  return requestUrl === config.COLLABORATION_PATH
    || requestUrl.startsWith(`${config.COLLABORATION_PATH}?`);
}

function isPreviewUpgrade(request: IncomingMessage): boolean {
  const requestUrl = request.url ?? '';
  return requestUrl === config.PREVIEW_PATH
    || requestUrl.startsWith(`${config.PREVIEW_PATH}?`);
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

  // Ensure projects storage directory exists
  fs.mkdirSync(path.resolve(config.PROJECTS_STORAGE_DIR), { recursive: true });

  const app = express();
  app.use(cookieParser());
  app.use(cors({
    origin: true,
    credentials: true,
  }));
  app.use(express.json());

  // Routes
  app.use('/api/auth', authRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', storageRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/preview', previewRouter);

  // Admin UI
  const adminPath = path.resolve('src/admin/index.html');
  app.get('/admin', (_req, res) => {
    if (fs.existsSync(adminPath)) {
      res.sendFile(adminPath);
    } else {
      // Fallback for production/dist
      const distAdminPath = path.resolve('dist/admin/index.html');
      if (fs.existsSync(distAdminPath)) {
        res.sendFile(distAdminPath);
      } else {
        res.status(404).send('Admin panel not found');
      }
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', port: config.PORT });
  });

  const hocuspocus = createHocuspocusServer();
  const previewRelay = createPreviewRelayServer();
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
