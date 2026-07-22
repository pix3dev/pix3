import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_EDITOR_VERSION } from '@/version';

import { UpdateCheckService, compareEditorVersions } from '@/services/editor/UpdateCheckService';

describe('compareEditorVersions', () => {
  it('prefers semver before build number', () => {
    expect(
      compareEditorVersions({ version: '0.0.2', build: 0 }, { version: '0.0.1', build: 99 })
    ).toBe(1);
    expect(
      compareEditorVersions({ version: '0.0.1', build: 99 }, { version: '0.0.2', build: 0 })
    ).toBe(-1);
  });

  it('compares build numbers when semver matches', () => {
    expect(
      compareEditorVersions({ version: '0.0.1', build: 5 }, { version: '0.0.1', build: 4 })
    ).toBe(1);
    expect(
      compareEditorVersions({ version: '0.0.1', build: 4 }, { version: '0.0.1', build: 4 })
    ).toBe(0);
  });
});

describe('UpdateCheckService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports update-available when remote build is newer for same semver', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: CURRENT_EDITOR_VERSION.version,
        build: CURRENT_EDITOR_VERSION.build + 1,
        displayVersion: `v${CURRENT_EDITOR_VERSION.version} (build ${CURRENT_EDITOR_VERSION.build + 1})`,
      }),
    }) as typeof fetch;

    const service = new UpdateCheckService();
    const state = await service.checkForUpdates();

    expect(state.status).toBe('update-available');
    expect(state.latestVersion?.build).toBe(CURRENT_EDITOR_VERSION.build + 1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/version.json?ts='),
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        }),
      })
    );
  });

  it('reports update-available when remote semver is newer', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: '0.0.2',
        build: 0,
        displayVersion: 'v0.0.2 (build 0)',
      }),
    }) as typeof fetch;

    const service = new UpdateCheckService();
    const state = await service.checkForUpdates();

    expect(state.status).toBe('update-available');
    expect(state.latestVersion?.version).toBe('0.0.2');
  });

  it('reports up-to-date when remote version matches local', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => CURRENT_EDITOR_VERSION,
    }) as typeof fetch;

    const service = new UpdateCheckService();
    const state = await service.checkForUpdates();

    expect(state.status).toBe('up-to-date');
    expect(state.latestVersion).toEqual(CURRENT_EDITOR_VERSION);
  });

  it('reports error when manifest fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as typeof fetch;

    const service = new UpdateCheckService();
    const state = await service.checkForUpdates();

    expect(state.status).toBe('error');
    expect(state.latestVersion).toBeNull();
  });
});
