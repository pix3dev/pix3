import { appState } from '@/state';

/**
 * Resolution of the two Phase-2/3 render toggles — pre-launch texture atlasing
 * and 2D quad batching. Each resolves, in priority order:
 *
 *   1. URL query param (`?pix3Atlas2D=off` / `?pix3Batch2D=off`, in search or
 *      the hash route) — for MCP-driven A/B without a rebuild.
 *   2. `window.__PIX3_RENDER2D__` global override (settable from the console).
 *   3. Project manifest `rendering2D` block.
 *   4. Default (`'auto'` = on).
 *
 * `'off'` makes the corresponding feature byte-identical to the pre-feature path.
 */
export type Rendering2DFlag = 'auto' | 'off';

interface Rendering2DOverride {
  atlas?: Rendering2DFlag;
  batching?: Rendering2DFlag;
}

interface Rendering2DManifest {
  textureAtlas?: Rendering2DFlag;
  batching?: Rendering2DFlag;
}

declare global {
  interface Window {
    __PIX3_RENDER2D__?: Rendering2DOverride;
  }
}

function readQueryParam(name: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const search = new URLSearchParams(window.location.search);
  const direct = search.get(name);
  if (direct !== null) {
    return direct;
  }
  // Hash route (`#editor?local=…&pix3Atlas2D=off`) carries its own query string.
  const hash = window.location.hash;
  const queryStart = hash.indexOf('?');
  if (queryStart >= 0) {
    return new URLSearchParams(hash.slice(queryStart + 1)).get(name);
  }
  return null;
}

function normalize(value: string | null | undefined): Rendering2DFlag | null {
  if (value === 'off' || value === 'false' || value === '0') {
    return 'off';
  }
  if (value === 'auto' || value === 'on' || value === 'true' || value === '1') {
    return 'auto';
  }
  return null;
}

function resolveManifestFlag(): Rendering2DManifest {
  const manifest = appState.project.manifest as { rendering2D?: Rendering2DManifest } | undefined;
  return manifest?.rendering2D ?? {};
}

function resolve(paramName: string, overrideKey: keyof Rendering2DOverride, manifestKey: keyof Rendering2DManifest): boolean {
  const fromQuery = normalize(readQueryParam(paramName));
  if (fromQuery) {
    return fromQuery === 'auto';
  }
  const fromGlobal = typeof window !== 'undefined' ? normalize(window.__PIX3_RENDER2D__?.[overrideKey]) : null;
  if (fromGlobal) {
    return fromGlobal === 'auto';
  }
  const fromManifest = normalize(resolveManifestFlag()[manifestKey]);
  if (fromManifest) {
    return fromManifest === 'auto';
  }
  return true; // default: on
}

/** Whether pre-launch texture atlasing (Phase 2) should run for this session. */
export function isAtlas2DEnabled(): boolean {
  return resolve('pix3Atlas2D', 'atlas', 'textureAtlas');
}

/** Whether the 2D quad batcher (Phase 3) should run for this session. */
export function isBatch2DEnabled(): boolean {
  return resolve('pix3Batch2D', 'batching', 'batching');
}
