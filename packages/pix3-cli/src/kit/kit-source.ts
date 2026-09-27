import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { cliPackageRoot } from '../package-root.ts';
import { repoRuntimePackage, runtimeSourceStamp } from '../types/runtime-types.ts';
import { CLI_VERSION } from '../version.ts';
import { BARRIER_ERROR_CODES, buildToolList } from '../workspace-agent/tools.ts';
import {
  KIT_FILES_DIR,
  KIT_FORMAT,
  KIT_MANIFEST,
  type CoreComponentInfo,
  type KitManifestFile,
} from './kit-format.ts';

/**
 * Where `pix3 kit` reads the generated kit from: `<package>/kit/` — built at `prepack` by
 * `scripts/build-kit.mjs` for the published package; in a repo checkout regenerated automatically
 * whenever its inputs (the templates in `kit-src/`, every file they include, the generator, the
 * MCP tool list and the runtime sources the `core:` table is read from) changed since the last
 * build. The generator itself (and the runtime bundle it needs) is imported only then.
 */

const packageRoot = (): string => cliPackageRoot();

export const kitDir = (): string => join(packageRoot(), 'kit');
export const kitSrcDir = (): string => join(packageRoot(), 'kit-src');
export const repoRootOfCheckout = (): string => join(packageRoot(), '..', '..');

/** A repo checkout that can (re)generate the kit. */
export const isKitCheckout = (): boolean =>
  existsSync(kitSrcDir()) &&
  existsSync(join(repoRootOfCheckout(), 'docs', 'pix3-specification.md')) &&
  repoRuntimePackage() !== null;

export interface KitSource {
  readonly dir: string;
  readonly filesDir: string;
  readonly manifest: KitManifestFile;
}

const INCLUDE = /\{\{include:([^#@|}]+)/g;

const walk = (root: string, dir = root): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort();
};

/** The MCP tools as the kit lists them: name + the first sentence of the fallback description. */
export const kitMcpTools = (): { name: string; summary: string }[] =>
  buildToolList(null).map(tool => ({
    name: tool.name,
    summary: tool.description.split(/(?<=\.)\s/)[0] ?? tool.description,
  }));

export const kitMcpErrorCodes = (): string[] => [...BARRIER_ERROR_CODES];

/** Staleness stamp of everything the generated kit depends on. */
export const kitInputsStamp = (): string => {
  const hash = createHash('sha256');
  hash.update(`${KIT_FORMAT}:${CLI_VERSION}\n`);
  const src = kitSrcDir();
  const repo = repoRootOfCheckout();
  const includes = new Set<string>();
  for (const file of walk(src)) {
    const text = readFileSync(join(src, file), 'utf8');
    hash.update(`${file}\n`).update(text);
    for (const match of text.matchAll(INCLUDE)) includes.add(match[1].trim());
  }
  for (const include of [...includes].sort()) {
    hash.update(`${include}\n`);
    try {
      hash.update(readFileSync(join(repo, include)));
    } catch {
      hash.update('(missing)');
    }
  }
  // The generator's own sources (only a checkout gets here: `kit-src/` is not published).
  const here = join(packageRoot(), 'src', 'kit');
  for (const file of ['generate.ts', 'kit-format.ts', 'core-components.ts', 'kit-source.ts']) {
    hash.update(readFileSync(join(here, file)));
  }
  hash.update(readFileSync(join(here, '..', 'workspace-agent', 'tools.ts')));
  const runtime = repoRuntimePackage();
  if (runtime) hash.update(runtimeSourceStamp(runtime));
  return hash.digest('hex');
};

const readManifest = (dir: string): KitManifestFile | null => {
  try {
    return JSON.parse(readFileSync(join(dir, KIT_MANIFEST), 'utf8')) as KitManifestFile;
  } catch {
    return null;
  }
};

/** Generate the kit from the repo into `outDir` (default `<package>/kit`). */
export const buildKitFromCheckout = async (
  options: {
    readonly outDir?: string;
    readonly coreComponents?: readonly CoreComponentInfo[];
    readonly stamp?: string;
  } = {}
): Promise<KitManifestFile> => {
  const { generateKit } = await import('./generate.ts');
  const coreComponents =
    options.coreComponents ??
    (await (await import('./core-components.ts')).loadCoreComponentsFromSource());
  return generateKit({
    repoRoot: repoRootOfCheckout(),
    kitSrcDir: kitSrcDir(),
    outDir: options.outDir ?? kitDir(),
    version: CLI_VERSION,
    coreComponents,
    mcpTools: kitMcpTools(),
    mcpErrorCodes: kitMcpErrorCodes(),
    inputsStamp: options.stamp ?? kitInputsStamp(),
  });
};

/** The generated kit, current for this CLI (regenerated first in a checkout when stale). */
export const ensureKit = async (
  options: { readonly log?: (line: string) => void } = {}
): Promise<KitSource> => {
  const dir = kitDir();
  const current = readManifest(dir);
  if (isKitCheckout()) {
    const stamp = kitInputsStamp();
    if (current && current.format === KIT_FORMAT && current.inputsStamp === stamp) {
      return { dir, filesDir: join(dir, KIT_FILES_DIR), manifest: current };
    }
    options.log?.('Generating the agent kit from the repo sources…');
    const manifest = await buildKitFromCheckout({ stamp });
    return { dir, filesDir: join(dir, KIT_FILES_DIR), manifest };
  }
  if (!current) {
    throw new Error(`${dir} is missing: this @pix3/cli package was published without its kit.`);
  }
  return { dir, filesDir: join(dir, KIT_FILES_DIR), manifest: current };
};
