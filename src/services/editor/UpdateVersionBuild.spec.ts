import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface VersionManifest {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

interface UpdateVersionArtifactsOptions {
  publishedAt?: string;
  paths?: {
    packageJsonPath?: string;
    publicVersionPath?: string;
    sourceVersionPath?: string;
  };
}

// @ts-expect-error Plain .mjs script module is exercised directly in this spec.
import * as updateVersionModule from '../../../scripts/update-version.mjs';

const { buildVersionManifest, buildVersionModule, readJsonFile, updateVersionArtifacts } =
  updateVersionModule as {
    buildVersionManifest: (version: string, build: number, publishedAt?: string) => VersionManifest;
    buildVersionModule: (manifest: VersionManifest) => string;
    readJsonFile: <T>(path: string, fallback: T) => Promise<T>;
    updateVersionArtifacts: (options?: UpdateVersionArtifactsOptions) => Promise<VersionManifest>;
  };

describe('update-version helpers', () => {
  it('builds a manifest with semver, build and displayVersion', () => {
    const manifest = buildVersionManifest('0.0.1', 4, '2026-04-07T10:00:00.000Z');

    expect(manifest.version).toBe('0.0.1');
    expect(manifest.build).toBe(4);
    expect(manifest.displayVersion).toBe('v0.0.1 (build 4)');
    expect(manifest.publishedAt).toBe('2026-04-07T10:00:00.000Z');
  });

  it('builds a TS module with version constants', () => {
    const source = buildVersionModule({
      version: '1.2.3',
      build: 9,
      displayVersion: 'v1.2.3 (build 9)',
      publishedAt: '2026-04-07T10:00:00.000Z',
    });

    expect(source).toContain('version: "1.2.3"');
    expect(source).toContain('build: 9');
    expect(source).toContain('displayVersion');
    expect(source).toContain('publishedAt');
  });

  it('writes incremented build metadata and generated source module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pix3-version-'));
    const pkgPath = join(dir, 'package.json');
    const manifestPath = join(dir, 'version.json');
    const sourcePath = join(dir, 'version.ts');

    await writeFile(pkgPath, JSON.stringify({ version: '0.2.0' }, null, 2), 'utf8');
    await writeFile(
      manifestPath,
      JSON.stringify({ version: '0.1.9', build: 4, displayVersion: 'v0.1.9 (build 4)' }, null, 2),
      'utf8'
    );

    const manifest = await updateVersionArtifacts({
      publishedAt: '2026-04-07T10:00:00.000Z',
      paths: {
        packageJsonPath: pkgPath,
        publicVersionPath: manifestPath,
        sourceVersionPath: sourcePath,
      },
    });

    const persistedManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version: string;
      build: number;
      displayVersion: string;
      publishedAt?: string;
    };
    const persistedSource = await readFile(sourcePath, 'utf8');

    expect(manifest.version).toBe('0.2.0');
    expect(manifest.build).toBe(5);
    expect(persistedManifest.displayVersion).toBe('v0.2.0 (build 5)');
    expect(persistedManifest.publishedAt).toBe('2026-04-07T10:00:00.000Z');
    expect(persistedSource).toContain('export const CURRENT_EDITOR_VERSION');
    expect(persistedSource).toContain('build: 5');
  });

  it('returns fallback when version manifest does not exist yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pix3-version-'));

    const fallback = { version: '0.0.1', build: -1 };
    const manifest = await readJsonFile(join(dir, 'missing.json'), fallback);

    expect(manifest).toEqual(fallback);
  });
});
