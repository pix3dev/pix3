// @vitest-environment node
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config.js';

vi.mock('../projects/projects-service.js', () => ({
  resolveProjectAccess: vi.fn((projectId: string) => ({
    project: {
      id: projectId,
      owner_id: 'owner-1',
      name: 'Test Project',
      share_token: null,
      created_at: '2026-04-26T00:00:00.000Z',
      updated_at: '2026-04-26T00:00:00.000Z',
    },
    role: 'owner',
    authSource: 'member',
    accessMode: 'edit',
    shareEnabled: false,
  })),
  touchProject: vi.fn(),
}));

const { storageRouter } = await import('./storage-router.js');

function startServer(): Promise<http.Server> {
  const app = express();
  app.use('/api/projects', storageRouter);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function stopServer(server: http.Server | null): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('storageRouter', () => {
  let server: http.Server | null = null;
  let projectDir: string | null = null;

  afterEach(async () => {
    await stopServer(server);
    server = null;

    if (projectDir) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      projectDir = null;
    }
  });

  it('downloads dotfiles like .gitignore', async () => {
    const projectId = `storage-router-${randomUUID()}`;
    projectDir = path.resolve(config.PROJECTS_STORAGE_DIR, projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'dist/\nnode_modules/\n');

    server = await startServer();
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/files/.gitignore`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('dist/\nnode_modules/\n');
  });
});
