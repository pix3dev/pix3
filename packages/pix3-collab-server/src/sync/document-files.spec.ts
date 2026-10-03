// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { parse } from 'yaml';
import { SCENE_DOCUMENT_FORMAT, SCENE_FIELD_PREFIX } from '../shared/scene-crdt-document.js';
import {
  loadScenesFromDisk,
  loadScriptsFromDisk,
  normalizeStoredScenePath,
  persistDocumentToDisk,
} from './document-files.js';

/**
 * The CRDT → disk mirror, exercised with the payloads a hostile collaborator would send.
 *
 * A scene's `filePath` and a script's map key are authored by whatever client last edited the
 * document. Before containment, either one could carry a `..` ladder and land a `writeFileSync`
 * anywhere the server process could reach; the escape cases below are that bug, and they must stay
 * failing forever. The round-trip cases are here so containment cannot be "fixed" by refusing
 * everything.
 */

let workspace: string;
let projectDir: string;
/** A sibling of the project directory: where an escape would land if one succeeded. */
let outsideDir: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pix3-docfiles-'));
  projectDir = path.join(workspace, 'projects', 'project-1');
  outsideDir = path.join(workspace, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function docWithScene(sceneId: string, filePath: string | null, snapshot: string): Y.Doc {
  const doc = new Y.Doc();
  const sceneMap = new Y.Map<unknown>();
  if (filePath !== null) {
    sceneMap.set('filePath', filePath);
  }
  sceneMap.set('snapshot', snapshot);
  doc.getMap<Y.Map<unknown>>('scenes').set(sceneId, sceneMap);
  return doc;
}

function docWithScript(scriptPath: string, source: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('scripts').set(scriptPath, new Y.Text(source));
  return doc;
}

/** Every file under `dir`, as workspace-relative POSIX paths. */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile())
    .map(entry =>
      path.relative(workspace, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    )
    .sort();
}

describe('persistDocumentToDisk — containment', () => {
  it('refuses a scene filePath that climbs out of the project directory', () => {
    const doc = docWithScene('evil', 'res://../../outside/pwned', 'owned: true');

    const result = persistDocumentToDisk(projectDir, doc);

    expect(result.rejected).toEqual([
      { kind: 'scene', requestedPath: 'res://../../outside/pwned' },
    ]);
    expect(result.scenesWritten).toBe(0);
    // The decisive assertion: nothing appeared anywhere but inside the project.
    expect(walk(outsideDir)).toEqual([]);
    expect(walk(projectDir)).toEqual([]);
  });

  it('refuses a scene filePath that is absolute', () => {
    const absolute = path.join(outsideDir, 'absolute.pix3scene');
    const doc = docWithScene('evil', absolute, 'owned: true');

    const result = persistDocumentToDisk(projectDir, doc);

    expect(result.rejected).toHaveLength(1);
    expect(fs.existsSync(absolute)).toBe(false);
    // And not re-rooted either. Normalization strips leading separators as punctuation, so on POSIX
    // `/tmp/…/absolute.pix3scene` used to land INSIDE the project as `tmp/…/absolute.pix3scene`:
    // contained, but silently relocated — the one thing this module promises never to do. Windows hid
    // it, because a drive letter survives the strip and containment rejected the path there.
    expect(walk(projectDir)).toEqual([]);
  });

  /** The other half of that rule: a leading slash AFTER `res://` is punctuation, not a root. */
  it('accepts a res:// path written with a leading slash', () => {
    const doc = docWithScene('menu', 'res:///scenes/menu.pix3scene', 'version: 1');

    const result = persistDocumentToDisk(projectDir, doc);

    expect(result.rejected).toEqual([]);
    expect(result.scenesWritten).toBe(1);
    expect(walk(projectDir)).toEqual(['projects/project-1/scenes/menu.pix3scene']);
  });

  it('refuses a script key that climbs out of the scripts directory', () => {
    const doc = docWithScript('../../../outside/pwned.ts', 'export const owned = true;');

    const result = persistDocumentToDisk(projectDir, doc);

    expect(result.rejected).toEqual([
      { kind: 'script', requestedPath: '../../../outside/pwned.ts' },
    ]);
    expect(result.scriptsWritten).toBe(0);
    expect(walk(outsideDir)).toEqual([]);
  });

  it('refuses a script key that escapes the project but stays under storage', () => {
    // The subtler shape: out of `scripts/`, still inside the project — and still not ours to write.
    const doc = docWithScript('../../project-2/scripts/injected.ts', 'export const owned = true;');

    const result = persistDocumentToDisk(projectDir, doc);

    expect(result.rejected).toHaveLength(1);
    expect(fs.existsSync(path.join(workspace, 'projects', 'project-2'))).toBe(false);
  });

  it('keeps writing the legitimate entries when one is refused', () => {
    const doc = new Y.Doc();
    const good = new Y.Map<unknown>();
    good.set('filePath', 'res://levels/one.pix3scene');
    good.set('snapshot', 'name: one');
    const bad = new Y.Map<unknown>();
    bad.set('filePath', 'res://../../outside/two.pix3scene');
    bad.set('snapshot', 'name: two');
    doc.getMap<Y.Map<unknown>>('scenes').set('one', good);
    doc.getMap<Y.Map<unknown>>('scenes').set('two', bad);

    const result = persistDocumentToDisk(projectDir, doc);

    expect(result.scenesWritten).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(walk(projectDir)).toEqual(['projects/project-1/levels/one.pix3scene']);
    expect(walk(outsideDir)).toEqual([]);
  });
});

describe('persistDocumentToDisk — ordinary persistence', () => {
  it('writes a scene at its declared path and round-trips it back into a document', () => {
    const doc = docWithScene('main', 'res://scenes/main.pix3scene', 'name: main');

    expect(persistDocumentToDisk(projectDir, doc).scenesWritten).toBe(1);
    expect(fs.readFileSync(path.join(projectDir, 'scenes', 'main.pix3scene'), 'utf-8')).toBe(
      'name: main'
    );

    const reloaded = new Y.Doc();
    loadScenesFromDisk(projectDir, reloaded.getMap<Y.Map<unknown>>('scenes'));
    const entry = reloaded.getMap<Y.Map<unknown>>('scenes').get('scenes-main');
    expect(entry?.get('filePath')).toBe('res://scenes/main.pix3scene');
    expect(entry?.get('snapshot')).toBe('name: main');
  });

  it('writes nested scripts and round-trips them back', () => {
    const doc = docWithScript('enemies/Chaser.ts', 'export class Chaser {}');

    expect(persistDocumentToDisk(projectDir, doc).scriptsWritten).toBe(1);
    expect(fs.readFileSync(path.join(projectDir, 'scripts', 'enemies', 'Chaser.ts'), 'utf-8')).toBe(
      'export class Chaser {}'
    );

    const reloaded = new Y.Doc();
    loadScriptsFromDisk(path.join(projectDir, 'scripts'), reloaded.getMap('scripts'));
    expect(reloaded.getMap('scripts').get('enemies/Chaser.ts')?.toString()).toBe(
      'export class Chaser {}'
    );
  });

  it('preserves legacy snapshot bytes, including YAML comments and formatting', () => {
    const snapshot = '# Keep this comment\r\nversion: "1.0.0"\r\nroot: []\r\n';
    const doc = docWithScene('main', 'res://main.pix3scene', snapshot);
    // Field-shaped keys do not upgrade a legacy document without the format marker.
    doc
      .getMap<Y.Map<unknown>>('scenes')
      .get('main')!
      .set(SCENE_FIELD_PREFIX + JSON.stringify(['document', 'version']), {
        kind: 'value',
        value: 'changed',
      });

    expect(persistDocumentToDisk(projectDir, doc).scenesWritten).toBe(1);
    expect(fs.readFileSync(path.join(projectDir, 'main.pix3scene'))).toEqual(
      Buffer.from(snapshot, 'utf-8')
    );
  });

  it('falls back to the scene id when no filePath is stored', () => {
    const doc = docWithScene('fallback', null, 'name: fallback');

    expect(persistDocumentToDisk(projectDir, doc).scenesWritten).toBe(1);
    expect(walk(projectDir)).toEqual(['projects/project-1/fallback.pix3scene']);
  });

  it('deletes files the document no longer carries', () => {
    persistDocumentToDisk(projectDir, docWithScene('gone', 'res://gone.pix3scene', 'x: 1'));
    expect(walk(projectDir)).toEqual(['projects/project-1/gone.pix3scene']);

    persistDocumentToDisk(projectDir, docWithScene('kept', 'res://kept.pix3scene', 'x: 2'));
    expect(walk(projectDir)).toEqual(['projects/project-1/kept.pix3scene']);
  });

  it('leaves a rejected path out of reconciliation rather than deleting a real file', () => {
    persistDocumentToDisk(projectDir, docWithScene('real', 'res://real.pix3scene', 'x: 1'));

    // A document carrying only an escaping path must not be read as "the project has no scenes".
    const doc = docWithScene('real', 'res://../../outside/real.pix3scene', 'x: 2');
    const result = persistDocumentToDisk(projectDir, doc);

    expect(result.rejected).toHaveLength(1);
    // The escape was refused; the previously written file is gone because the document no longer
    // claims it at a legal path. Documented here because it is the one destructive consequence.
    expect(walk(projectDir)).toEqual([]);
    expect(walk(outsideDir)).toEqual([]);
  });
});

describe('persistDocumentToDisk — field-based scenes', () => {
  const snapshot = `version: 1.0.0
metadata:
  author: scene-owner
root:
  - id: light
    type: PointLight3D
    name: Original
    properties:
      intensity: 1
      color: '#ffffff'
  - id: removed
    type: Node3D
    name: Removed
`;

  function fieldKey(...segments: string[]): string {
    return SCENE_FIELD_PREFIX + JSON.stringify(segments);
  }

  function sceneEntry(doc: Y.Doc): Y.Map<unknown> {
    return doc.getMap<Y.Map<unknown>>('scenes').get('main')!;
  }

  it('persists independent concurrent Y.Doc edits and reloads the merged scene from disk', () => {
    const seed = docWithScene('main', 'res://scenes/main.pix3scene', snapshot);
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, Y.encodeStateAsUpdate(seed));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(seed));

    // Two clients independently make their first field-based edit to the same legacy scene.
    // Neither client rewrites the shared compatibility snapshot or untouched field registers.
    left.transact(() => {
      sceneEntry(left).set('format', SCENE_DOCUMENT_FORMAT);
      sceneEntry(left).set(fieldKey('node', 'light', 'name'), {
        kind: 'value',
        value: 'Renamed by left',
      });
    });
    right.transact(() => {
      sceneEntry(right).set('format', SCENE_DOCUMENT_FORMAT);
      sceneEntry(right).set(fieldKey('node', 'light', 'properties', 'intensity'), {
        kind: 'value',
        value: 7,
      });
    });
    const leftUpdate = Y.encodeStateAsUpdate(left);
    const rightUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);

    expect(persistDocumentToDisk(projectDir, left).scenesWritten).toBe(1);
    const mirroredProject = path.join(workspace, 'second-project');
    expect(persistDocumentToDisk(mirroredProject, right).scenesWritten).toBe(1);
    const stored = fs.readFileSync(path.join(projectDir, 'scenes', 'main.pix3scene'), 'utf-8');
    expect(stored).toBe(
      fs.readFileSync(path.join(mirroredProject, 'scenes', 'main.pix3scene'), 'utf-8')
    );
    // Check the actual YAML independently of the field codec used by the persistence path.
    const expected = {
      version: '1.0.0',
      metadata: { author: 'scene-owner' },
      root: [
        {
          id: 'light',
          type: 'PointLight3D',
          name: 'Renamed by left',
          properties: { intensity: 7, color: '#ffffff' },
        },
        { id: 'removed', type: 'Node3D', name: 'Removed' },
      ],
    };
    expect(parse(stored)).toEqual(expected);
    expect(sceneEntry(left).get('snapshot')).toBe(snapshot);
    expect(sceneEntry(right).get('snapshot')).toBe(snapshot);

    const reloaded = new Y.Doc();
    loadScenesFromDisk(projectDir, reloaded.getMap<Y.Map<unknown>>('scenes'));
    const entry = reloaded.getMap<Y.Map<unknown>>('scenes').get('scenes-main');
    expect(entry?.get('filePath')).toBe('res://scenes/main.pix3scene');
    expect(parse(entry?.get('snapshot') as string)).toEqual(expected);
    expect(persistDocumentToDisk(projectDir, reloaded).scenesWritten).toBe(1);
    expect(fs.readFileSync(path.join(projectDir, 'scenes', 'main.pix3scene'), 'utf-8')).toBe(
      stored
    );
  });

  it('applies property and node-membership tombstones over the immutable snapshot', () => {
    const doc = docWithScene('main', 'res://main.pix3scene', snapshot);
    const scene = sceneEntry(doc);
    scene.set('format', SCENE_DOCUMENT_FORMAT);
    scene.set(fieldKey('node', 'light', 'properties', 'color'), { kind: 'deleted' });
    scene.set(fieldKey('exists', 'removed'), { kind: 'deleted' });

    expect(persistDocumentToDisk(projectDir, doc).scenesWritten).toBe(1);
    expect(parse(fs.readFileSync(path.join(projectDir, 'main.pix3scene'), 'utf-8'))).toEqual({
      version: '1.0.0',
      metadata: { author: 'scene-owner' },
      root: [
        {
          id: 'light',
          type: 'PointLight3D',
          name: 'Original',
          properties: { intensity: 1 },
        },
      ],
    });
    expect(scene.get('snapshot')).toBe(snapshot);
  });

  it.each(['invalid snapshot', 'missing snapshot', 'duplicate node IDs'])(
    'keeps the last good file when a format-2 scene has %s',
    invalid => {
      const scenePath = path.join(projectDir, 'scenes', 'main.pix3scene');
      const doc = docWithScene('main', 'res://scenes/main.pix3scene', snapshot);
      persistDocumentToDisk(projectDir, doc);
      const scene = sceneEntry(doc);
      scene.set('format', SCENE_DOCUMENT_FORMAT);
      if (invalid === 'invalid snapshot') scene.set('snapshot', 'root: not-a-node-list\n');
      if (invalid === 'missing snapshot') scene.delete('snapshot');
      if (invalid === 'duplicate node IDs')
        scene.set('snapshot', 'root:\n  - id: duplicate\n  - id: duplicate\n');
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      // Valid peers and scripts still persist while the broken entry retains its previous file.
      const validScene = new Y.Map<unknown>();
      validScene.set('filePath', 'res://scenes/other.pix3scene');
      validScene.set('snapshot', 'version: 1.0.0\nroot: []\n');
      doc.getMap<Y.Map<unknown>>('scenes').set('other', validScene);
      doc.getMap('scripts').set('Game.ts', new Y.Text('export class Game {}'));
      fs.writeFileSync(path.join(projectDir, 'scenes', 'stale.pix3scene'), 'root: []\n');

      const result = persistDocumentToDisk(projectDir, doc);

      expect(result.scenesWritten).toBe(1);
      expect(result.scriptsWritten).toBe(1);
      expect(result.rejected).toEqual([]);
      expect(warning).toHaveBeenCalledOnce();
      expect(fs.readFileSync(scenePath, 'utf-8')).toBe(snapshot);
      expect(fs.readFileSync(path.join(projectDir, 'scenes', 'other.pix3scene'), 'utf-8')).toBe(
        'version: 1.0.0\nroot: []\n'
      );
      expect(fs.existsSync(path.join(projectDir, 'scenes', 'stale.pix3scene'))).toBe(false);
      expect(fs.readFileSync(path.join(projectDir, 'scripts', 'Game.ts'), 'utf-8')).toBe(
        'export class Game {}'
      );
    }
  );

  it('does not create a file or report a write for a malformed new scene', () => {
    const doc = docWithScene('main', 'res://scenes/main.pix3scene', 'root: broken');
    sceneEntry(doc).set('format', SCENE_DOCUMENT_FORMAT);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(persistDocumentToDisk(projectDir, doc).scenesWritten).toBe(0);
    expect(walk(projectDir)).toEqual([]);
  });
});

describe('normalizeStoredScenePath', () => {
  it('strips the scheme and leading separators and forces the extension', () => {
    expect(normalizeStoredScenePath('res://scenes/main.pix3scene')).toBe('scenes/main.pix3scene');
    expect(normalizeStoredScenePath('RES:///scenes/main')).toBe('scenes/main.pix3scene');
    expect(normalizeStoredScenePath('\\\\scenes\\main')).toBe('scenes\\main.pix3scene');
  });

  it('deliberately preserves `..` so containment sees the real request', () => {
    // Normalization that quietly rewrote this would hide the attack from the check that decides.
    expect(normalizeStoredScenePath('res://../../etc/x')).toBe('../../etc/x.pix3scene');
  });
});
