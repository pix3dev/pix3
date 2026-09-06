import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  UIKIT_FORGE_HASH,
  UIKIT_FORGE_URL,
  isToolRouteHash,
  isUiKitForgeHash,
} from './tool-routes';

const repoRoot = resolve(__dirname, '../..');

/**
 * Standalone tool routes have three pieces of wiring that live in three different files and only
 * break together, so they are pinned here rather than left to a manual click-through.
 */
describe('tool routes', () => {
  it('matches its own hash and a hash carrying a query, but not a longer name', () => {
    expect(isUiKitForgeHash(UIKIT_FORGE_HASH)).toBe(true);
    expect(isUiKitForgeHash(`${UIKIT_FORGE_HASH}?preset=fantasy`)).toBe(true);
    expect(isToolRouteHash(UIKIT_FORGE_HASH)).toBe(true);

    // The prefix test must not swallow a future `#uikit-something` route, nor the editor's own.
    expect(isUiKitForgeHash('#uikit-legacy')).toBe(false);
    expect(isUiKitForgeHash('#editor')).toBe(false);
    expect(isToolRouteHash('#editor?project=abc')).toBe(false);
    expect(isToolRouteHash('#welcome')).toBe(false);
  });

  it('points at a page that is actually a build entry', () => {
    // The tool page is a second Vite entry at the repo root rather than a `public/` file, so the
    // URL and the entry path have to agree: `/tools/uikit-forge.html` → `tools/uikit-forge.html`.
    const entryPath = UIKIT_FORGE_URL.replace(/^\//, '');
    const page = readFileSync(resolve(repoRoot, entryPath), 'utf8');
    expect(page).toContain('<!DOCTYPE html>');
    expect(page).toContain('/src/tools/uikit-forge/main.ts');

    const viteConfig = readFileSync(resolve(repoRoot, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain(`resolve(__dirname, '${entryPath}')`);
  });

  it('is excluded from the PWA navigation fallback', () => {
    // Workbox's NavigationRoute answers EVERY navigation with the editor shell unless the path is
    // denylisted — without this entry, opening the tool's own URL on a build with the service
    // worker installed silently lands on the editor instead.
    const viteConfig = readFileSync(resolve(repoRoot, 'vite.config.ts'), 'utf8');
    const denylist = /navigateFallbackDenylist:\s*\[(.*?)\]/s.exec(viteConfig)?.[1] ?? '';
    expect(denylist).toContain(String.raw`/^\/tools\//`);
  });
});
