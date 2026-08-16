import fs from 'fs';
import path from 'path';
import * as Y from 'yjs';
import { resolveContainedPath } from '../core/storage/contained-path.js';

/**
 * The disk side of a collaboration document: scenes and scripts mirrored into the project directory
 * so the HTTP storage API, the exporter and a `git`-side operator all see plain files.
 *
 * Extracted from the Hocuspocus hooks for one reason: **every path here comes off the wire**. A
 * scene's `filePath` and a script's map key are both authored by whatever client last edited the
 * document, so this is where a `..` ladder used to turn into `writeFileSync` anywhere the process
 * could reach. Keeping the logic in a hook body meant it could only be tested by booting a
 * Hocuspocus server, which is why it never was.
 *
 * A path that escapes its root is **skipped and logged**, never rewritten. Silently relocating a
 * user's scene into the project root would look like data loss with no error to explain it, and
 * clamping the path would still let a caller collide with an existing file of the same name.
 */

/** A path rejected by containment, reported so an operator can see it happening. */
export interface RejectedDocumentPath {
  readonly kind: 'scene' | 'script';
  /** The key or `filePath` exactly as the document carried it. */
  readonly requestedPath: string;
}

export interface PersistDocumentResult {
  readonly scenesWritten: number;
  readonly scriptsWritten: number;
  readonly rejected: readonly RejectedDocumentPath[];
}

/**
 * Strips the scheme and any leading separators off a stored scene path and forces the extension.
 *
 * This is normalization, not safety: `..` deliberately survives it so containment — the thing that
 * actually decides — sees the path the document really asked for.
 */
export function normalizeStoredScenePath(filePath: string): string {
  const normalized = filePath.replace(/^res:\/\//i, '').replace(/^[/\\]+/, '');
  return normalized.endsWith('.pix3scene') ? normalized : `${normalized}.pix3scene`;
}

export function deriveSceneId(resourcePath: string): string {
  const withoutExtension = resourcePath.replace(/\.[^./]+$/i, '');
  const normalized = withoutExtension
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'scene';
}

export function listFilesRecursive(rootDir: string, extension: string): string[] {
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

/** Loads the project's `.pix3scene` files into the document's `scenes` map. */
export function loadScenesFromDisk(projectDir: string, scenesMap: Y.Map<Y.Map<unknown>>): void {
  for (const scenePath of listFilesRecursive(projectDir, '.pix3scene')) {
    const relativePath = path.relative(projectDir, scenePath).split(path.sep).join('/');
    const sceneMap = new Y.Map<unknown>();
    const content = fs.readFileSync(scenePath, 'utf-8');
    sceneMap.set('filePath', `res://${relativePath}`);
    sceneMap.set('snapshot', content);
    scenesMap.set(deriveSceneId(relativePath), sceneMap);
  }
}

/** Loads the project's `scripts/**\/*.ts` into the document's `scripts` map. */
export function loadScriptsFromDisk(scriptsDir: string, scriptsMap: Y.Map<unknown>): void {
  if (!fs.existsSync(scriptsDir)) {
    return;
  }

  for (const fullPath of listFilesRecursive(scriptsDir, '.ts')) {
    const relativePath = path.relative(scriptsDir, fullPath).split(path.sep).join('/');
    scriptsMap.set(relativePath, new Y.Text(fs.readFileSync(fullPath, 'utf-8')));
  }
}

/**
 * Mirrors the document's scenes and scripts into `projectDir`, deleting files the document no
 * longer carries. Returns what was written and what was refused.
 */
export function persistDocumentToDisk(projectDir: string, document: Y.Doc): PersistDocumentResult {
  const rejected: RejectedDocumentPath[] = [];
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

    const requestedPath =
      typeof filePathValue === 'string' && filePathValue.trim()
        ? filePathValue
        : `${sceneId}.pix3scene`;
    const fullPath = resolveContainedPath(projectDir, normalizeStoredScenePath(requestedPath));
    if (fullPath === null) {
      rejected.push({ kind: 'scene', requestedPath });
      continue;
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, snapshotValue, 'utf-8');
    sceneFilePaths.add(fullPath);
  }
  reconcileFiles(projectDir, sceneFilePaths, '.pix3scene');

  const scriptsMap = document.getMap('scripts');
  const scriptsDir = path.resolve(projectDir, 'scripts');
  const scriptFilePaths = new Set<string>();
  for (const [scriptPath, value] of scriptsMap.entries()) {
    if (!(value instanceof Y.Text)) {
      continue;
    }

    const fullPath = resolveContainedPath(scriptsDir, scriptPath);
    if (fullPath === null) {
      rejected.push({ kind: 'script', requestedPath: scriptPath });
      continue;
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, value.toString(), 'utf-8');
    scriptFilePaths.add(fullPath);
  }
  reconcileFiles(scriptsDir, scriptFilePaths, '.ts');

  return {
    scenesWritten: sceneFilePaths.size,
    scriptsWritten: scriptFilePaths.size,
    rejected,
  };
}
