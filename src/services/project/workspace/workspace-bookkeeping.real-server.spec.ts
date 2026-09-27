// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appState, resetAppState } from '@/state';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  PROTECTED_SET_FILE,
  RECOVERY_DIRECTORY,
} from '@/services/project/coauthoring/coauthoring-paths';
import { WorkspaceClient } from '@/services/project/workspace/WorkspaceClient';
import { ensureIdentity } from '../../../../packages/pix3-cli/src/serve/state-file.ts';
import { WorkspaceServer } from '../../../../packages/pix3-cli/src/serve/workspace-server.ts';

/**
 * The editor's co-authoring bookkeeping under `.pix3/` against a REAL `pix3 serve`: what the
 * protected set, the merge log and the recovery journal do through `ProjectStorageService` on a
 * workspace — and, above all, that a reloaded tab (a fresh client with empty caches) finds them
 * again. Before the server let `.pix3/**` through, `P` lived only in memory and a reload lost it.
 */

let root: string;
let token: string;
let server: WorkspaceServer | null = null;
const storages: ProjectStorageService[] = [];

/** A fresh editor page: new HTTP client (empty caches), new storage service over it. */
const openTab = (endpoint: string): ProjectStorageService => {
  const client = new WorkspaceClient((input, init) => fetch(input, init));
  client.configure({ endpoint, token });
  const storage = new ProjectStorageService();
  Object.defineProperty(storage, 'workspace', { value: client });
  storages.push(storage);
  return storage;
};

beforeEach(async () => {
  resetAppState();
  appState.project.backend = 'workspace';
  appState.project.workspace.lease = 'held';
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-editor-serve-')));
  writeFileSync(join(root, 'pix3project.yaml'), 'version: 1.0.0\nmetadata:\n  projectName: T\n');
  mkdirSync(join(root, 'scenes'));
  writeFileSync(join(root, 'scenes', 'main.pix3scene'), 'root: []\n');
  token = ensureIdentity(root, { rotateToken: false }).issuedToken ?? '';
  server = new WorkspaceServer({ root, ports: [0], debounceMs: 30 });
  await server.start();
});

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.dispose();
  await server?.close();
  server = null;
  rmSync(root, { recursive: true, force: true });
  resetAppState();
});

describe('workspace .pix3/ bookkeeping through a real pix3 serve', () => {
  it('protected.json and merge-log.jsonl survive a tab reload', async () => {
    const endpoint = `http://127.0.0.1:${server!.port}`;
    const before = openTab(endpoint);
    await before.writeTextFile(PROTECTED_SET_FILE, '{"format":1,"scenes":{}}\n', {
      unconditional: true,
    });
    await before.writeTextFile('.pix3/merge-log.jsonl', '{"a":1}\n', { unconditional: true });
    const revision = server!.revision();

    const after = openTab(endpoint);
    expect(await after.fileExists(PROTECTED_SET_FILE)).toBe(true);
    expect(await after.readTextFile(PROTECTED_SET_FILE)).toBe('{"format":1,"scenes":{}}\n');
    expect(await after.fileExists('.pix3/merge-log.jsonl')).toBe(true);
    // Bookkeeping is not project content: the revision did not move.
    expect(server!.revision()).toBe(revision);
    // Server-private files stay invisible to the editor.
    expect(await after.fileExists('.pix3/workspace.json')).toBe(false);
  });

  it('lists .pix3/recovery/ (the journal prunes by listing) and deletes from it', async () => {
    const endpoint = `http://127.0.0.1:${server!.port}`;
    const tab = openTab(endpoint);
    const sceneDir = `${RECOVERY_DIRECTORY}/${encodeURIComponent('scenes/main.pix3scene')}`;
    await tab.writeTextFile(`${sceneDir}/1000-aaaaaaaa.pix3scene`, 'v1');
    await tab.writeTextFile(`${sceneDir}/2000-bbbbbbbb.pix3scene`, 'v2');

    const reloaded = openTab(endpoint);
    const sceneDirs = await reloaded.listDirectory(RECOVERY_DIRECTORY);
    expect(sceneDirs.map(entry => [entry.name, entry.kind])).toEqual([
      [encodeURIComponent('scenes/main.pix3scene'), 'directory'],
    ]);
    const files = await reloaded.listDirectory(sceneDir);
    expect(files.map(entry => entry.name)).toEqual([
      '1000-aaaaaaaa.pix3scene',
      '2000-bbbbbbbb.pix3scene',
    ]);

    await reloaded.deleteEntry(`${sceneDir}/1000-aaaaaaaa.pix3scene`);
    expect((await reloaded.listDirectory(sceneDir)).map(entry => entry.name)).toEqual([
      '2000-bbbbbbbb.pix3scene',
    ]);
    // And what a third page sees after a full manifest.
    expect((await openTab(endpoint).listDirectory(sceneDir)).map(entry => entry.name)).toEqual([
      '2000-bbbbbbbb.pix3scene',
    ]);
  });
});
