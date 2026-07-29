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
import { createCsrfGuard } from './core/auth/csrf-guard.js';
import { originTrust } from './core/auth/origin-trust.js';
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

/**
 * Route prefixes that are public by design and authorize with their own per-session tokens: a published
 * game creating a room, a shared player link driving a preview. They keep `Allow-Credentials`, because
 * clients already in the wild send `credentials: 'include'` there and would break without it — and they
 * can afford to, since `/api/rooms` only honours a cookie identity from a trusted origin (see
 * `rooms-router`), so there is nothing cookie-derived for a stranger to read.
 */
const TOKEN_AUTHENTICATED_PREFIXES = ['/api/rooms', '/api/preview'] as const;

/**
 * Per-origin CORS.
 *
 * The origin is always reflected — the public API (store listings, room status, the player relay) must
 * work from anywhere. What is *not* handed out freely is `Access-Control-Allow-Credentials`: without it a
 * browser refuses to expose a credentialed response to the page, so an untrusted site can no longer read
 * the signed-in user's projects, library or admin data even though the cookie is `SameSite=None` and
 * still reaches us.
 *
 * This is the read-side twin of the CSRF guard, off the same trust list, and it is why the two must be
 * changed together.
 */
function resolveCorsOptions(
  req: IncomingMessage,
  callback: (error: Error | null, options: cors.CorsOptions) => void
): void {
  const origin = req.headers.origin ?? null;
  const requestPath = (req.url ?? '').split('?')[0];
  const isPublicTokenPath = TOKEN_AUTHENTICATED_PREFIXES.some(prefix =>
    requestPath.startsWith(prefix)
  );

  callback(null, {
    origin: true,
    credentials: originTrust.isTrusted(origin) || isPublicTokenPath,
  });
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
  app.use(cors(resolveCorsOptions));
  app.use(express.json());

  // CSRF provenance check, mounted BEFORE the routers it protects so it runs on every write into them.
  //
  // The scope is exactly the surface where the session cookie grants privileges: projects (and their
  // file storage), the library and the store, and the admin API. `/api/rooms` and `/api/preview` are
  // left out on purpose — they are reached from arbitrary origins by design (a published game, a shared
  // player link) and authorize with their own per-session tokens, so a provenance check there would
  // break the feature while protecting nothing. `/api/auth` is out too: login and register do not act
  // on an existing session.
  app.use(['/api/projects', '/api/library', '/api/admin'], createCsrfGuard());

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
