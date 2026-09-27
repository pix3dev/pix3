/**
 * The agent kit, as the CLI generates it (`packages/pix3-cli/kit/` — `kit.json` + `files/**`),
 * bundled into the editor so "Work with your own agent" writes byte-for-byte what `pix3 kit` /
 * `pix3 new` write.
 *
 * The folder is generated and gitignored: `scripts/ensure-agent-kit.mjs` (re)builds it when
 * `vite.config.ts` / `vitest.config.ts` load, and `bundled-kit.spec.ts` fails when what is bundled
 * here differs from a fresh generation. `exhaustive` is what lets the glob see `.claude/skills/**`
 * (import-glob skips dot-directories otherwise).
 *
 * Eager inside this module, lazy from the outside: only `AgentKitService` imports it, dynamically,
 * so the ~240 KB of markdown is one chunk loaded when a kit is actually written.
 */

import type { BundledAgentKit } from './agent-kit-install';

const KIT_MANIFEST_MODULES = import.meta.glob('../../../../packages/pix3-cli/kit/kit.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const KIT_FILE_MODULES = import.meta.glob('../../../../packages/pix3-cli/kit/files/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
  exhaustive: true,
}) as Record<string, string>;

const FILES_MARKER = '/pix3-cli/kit/files/';

interface KitManifestJson {
  readonly version?: unknown;
  readonly files?: unknown;
}

const readManifest = (): { version: string; files: string[] } => {
  const raw = Object.values(KIT_MANIFEST_MODULES)[0];
  if (!raw) {
    throw new Error(
      'The agent kit is missing from this build (packages/pix3-cli/kit/kit.json). Run `npm run build-kit -w packages/pix3-cli` and rebuild.'
    );
  }
  const parsed = JSON.parse(raw) as KitManifestJson;
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((file): file is string => typeof file === 'string')
    : [];
  return { version: typeof parsed.version === 'string' ? parsed.version : '0.0.0', files };
};

/** The bundled kit: its version and project path → contents, in the manifest's order. */
export const loadBundledAgentKit = (): BundledAgentKit => {
  const manifest = readManifest();
  const byPath = new Map<string, string>();
  for (const [modulePath, contents] of Object.entries(KIT_FILE_MODULES)) {
    const index = modulePath.indexOf(FILES_MARKER);
    if (index >= 0) byPath.set(modulePath.slice(index + FILES_MARKER.length), contents);
  }
  const files = new Map<string, string>();
  for (const path of manifest.files) {
    const contents = byPath.get(path);
    if (contents === undefined) {
      throw new Error(`The bundled agent kit lists ${path} but does not carry it.`);
    }
    files.set(path, contents);
  }
  return { version: manifest.version, files };
};
